/**
 * 自动混剪发布调度器
 *
 * 负责：
 *   1. 定时监控达人新视频（TikWM API）
 *   2. 自动触发 AI 混剪任务
 *   3. 检测混剪完成状态
 *   4. 自动排期发布（创建 tk_publish_job）
 *   5. 检测发布结果
 *   6. 失败重试（重新混剪）
 *
 * 使用已有的数据库表：
 *   - creator_auto_publish_config  — 达人自动发布配置
 *   - creator_profile_bindings     — 达人绑定指纹浏览器 profile
 *   - creator_video_monitor        — 达人视频监控记录
 *   - auto_remix_publish_pipeline  — 自动混剪发布流水线
 *
 * 通过 EventTarget 派发 "change" 事件，前端 SSE 可感知状态变化。
 */

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 分钟
const PUBLISH_INTERVAL_MIN_MS = 10 * 60 * 1000; // 发布间隔至少 10 分钟
const MAX_RETRY_COUNT = 3;
const DEFAULT_MONITOR_INTERVAL_HOURS = 6;

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export class AutoPublishScheduler extends EventTarget {
  /**
   * @param {Object} opts
   * @param {import("./database.js").LocalDatabase} opts.persistence
   * @param {import("./bitbrowser-api.js").BitBrowserApi} opts.bitBrowserApi
   * @param {string} opts.serverUrl — 本地服务地址，如 http://localhost:39210
   */
  constructor({ persistence, bitBrowserApi, serverUrl }) {
    super();
    this.store = persistence;
    this.bitBrowserApi = bitBrowserApi;
    this.serverUrl = (serverUrl || "").replace(/\/$/, "");
    this.timer = null;
    this.running = false;

    this._ensureSchema();
  }

  // ─── 生命周期 ───

  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkAndProcess().catch((err) => {
        console.error("[AutoPublishScheduler] 主循环出错:", err);
      });
    }, intervalMs);
    this.checkAndProcess().catch(() => {});
    console.log(`[AutoPublishScheduler] 已启动，轮询间隔 ${intervalMs}ms`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[AutoPublishScheduler] 已停止");
  }

  // ─── 主循环 ───

  async checkAndProcess() {
    if (this.running) return;
    this.running = true;
    try {
      await this.monitorCreatorVideos();
      await this.triggerRemixTasks();
      await this.checkRemixComplete();
      await this.schedulePublishJobs();
      await this.checkPublishResults();
      await this.retryFailedTasks();
    } finally {
      this.running = false;
    }
  }

  // ─── 1. 监控达人新视频 ───

  async monitorCreatorVideos() {
    const configs = this._listEnabledConfigs();
    if (!configs.length) return;

    const now = Date.now();
    let changed = false;

    for (const cfg of configs) {
      // 检查是否到达监控间隔
      const intervalHours = cfg.monitor_interval_hours || DEFAULT_MONITOR_INTERVAL_HOURS;
      const intervalMs = intervalHours * 60 * 60 * 1000;
      const lastMonitorAt = cfg.last_monitor_at ? new Date(cfg.last_monitor_at).getTime() : 0;
      if (now - lastMonitorAt < intervalMs) continue;

      try {
        await this._checkCreatorNewVideos(cfg);
        // 更新 last_monitor_at
        this.store.db
          .prepare("UPDATE creator_auto_publish_config SET last_monitor_at = ?, updated_at = ? WHERE creator_id = ?")
          .run(nowIso(), nowIso(), cfg.creator_id);
        changed = true;
      } catch (err) {
        console.error(`[AutoPublishScheduler] 监控达人 ${cfg.creator_id} 失败:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-监控达人失败: ${err.message}`);
      }
    }

    if (changed) this._emitChange();
  }

  async _checkCreatorNewVideos(cfg) {
    const creator = this.store.getRemixCreator(cfg.creator_id);
    if (!creator) return;

    let username = cfg.tiktok_username || this._extractUsername(creator);
    if (!username) {
      console.warn(`[AutoPublishScheduler] 达人 ${creator.name} 无 TikTok 用户名，跳过`);
      return;
    }

    const apiUrl = `https://www.tikwm.com/api/user/posts?username=${encodeURIComponent(username)}&count=30`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`TikWM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg || "TikWM API 返回错误");

    const feed = data.data?.videos || data.data || [];
    if (!Array.isArray(feed) || !feed.length) return;

    // 检查 creator_video_monitor 表，发现新视频
    const newVideos = [];
    for (const v of feed) {
      const videoId = v.video_id || v.id;
      const tiktokUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;
      const monitored = this._getMonitoredVideo(cfg.creator_id, tiktokUrl);
      if (monitored) continue;

      newVideos.push({
        videoId: String(videoId),
        url: tiktokUrl,
        title: (v.title || "").substring(0, 200),
        cover: v.cover || v.origin_cover || null,
        duration: v.duration || null,
        playUrl: v.play || null,
        author: username,
      });
    }

    if (!newVideos.length) return;

    console.log(`[AutoPublishScheduler] 达人 ${creator.name} 发现 ${newVideos.length} 个新视频`);

    for (const v of newVideos) {
      this._recordMonitoredVideo({
        creatorId: cfg.creator_id,
        videoId: v.videoId,
        tiktokUrl: v.url,
      });
    }

    // 下载新视频并创建 pipeline 任务
    for (const v of newVideos) {
      try {
        await this._downloadAndCreatePipeline(cfg, v);
      } catch (err) {
        console.error(`[AutoPublishScheduler] 下载视频 ${v.url} 失败:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-下载视频失败: ${v.url} → ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async _downloadAndCreatePipeline(cfg, videoInfo) {
    const downloadRes = await fetch(`${this.serverUrl}/api/tiktok/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: videoInfo.url }),
      signal: AbortSignal.timeout(180000),
    });
    if (!downloadRes.ok) {
      const errBody = await downloadRes.text().catch(() => "");
      throw new Error(`下载 API HTTP ${downloadRes.status}: ${errBody.slice(0, 200)}`);
    }
    const downloadData = await downloadRes.json();
    if (!downloadData.ok) throw new Error(downloadData.error || "下载失败");

    // 更新监控记录
    this._updateMonitoredVideo(cfg.creator_id, videoInfo.url, {
      remixVideoId: downloadData.videoId || null,
    });

    // 为每个绑定的 profile 创建 pipeline 任务
    const bindings = this._listCreatorBindings(cfg.creator_id);
    if (!bindings.length) {
      console.warn(`[AutoPublishScheduler] 达人 ${cfg.creator_id} 无绑定的 profile，跳过 pipeline 创建`);
      return;
    }

    for (const binding of bindings) {
      const pipelineId = genId("ap");
      this.store.db
        .prepare(
          `INSERT INTO auto_remix_publish_pipeline
           (id, creator_id, source_video_id, remix_task_id, profile_id, publish_job_id, status, fail_reason, attempt_count, source_url, matrix_id, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, NULL, 'pending', NULL, 0, ?, ?, ?, ?)`,
        )
        .run(
          pipelineId,
          cfg.creator_id,
          downloadData.videoId || "pending_download",
          binding.profile_id,
          videoInfo.url,
          cfg.matrix_id || null,
          nowIso(),
          nowIso(),
        );

      this.store.logCdpEvent(
        null,
        "info",
        `自动发布-Pipeline创建: ${pipelineId} (达人=${cfg.creator_id}, profile=${binding.profile_id})`,
      );
    }
  }

  // ─── 2. 自动触发混剪 ───

  async triggerRemixTasks() {
    const pendingPipelines = this._listPipelinesByStatus("pending");
    if (!pendingPipelines.length) return;

    // 混剪并发1：有正在混剪的任务就等
    const remixingCount = this._listPipelinesByStatus("remixing").length;
    if (remixingCount > 0) return;

    const pipeline = pendingPipelines[0];
    const cfg = this._getConfig(pipeline.creator_id);

    if (!pipeline.source_video_id) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "Pipeline 缺少 source_video_id",
      });
      this._emitChange();
      return;
    }

    if (!cfg) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 creator_auto_publish_config 配置",
      });
      this._emitChange();
      return;
    }

    const video = this.store.getRemixVideo(pipeline.source_video_id);
    if (!video) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: `视频 ${pipeline.source_video_id} 不存在`,
      });
      this._emitChange();
      return;
    }

    // 需要配置
    const matrixId = pipeline.matrix_id || cfg.matrix_id;
    const cdpInstanceId = cfg.cdp_instance_id;
    const presetId = cfg.preset_id;
    const ratio = cfg.ratio || "9:16";

    if (!matrixId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 matrix_id 配置",
      });
      this._emitChange();
      return;
    }
    if (!cdpInstanceId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 cdp_instance_id 配置",
      });
      this._emitChange();
      return;
    }

    try {
      const remixRes = await fetch(`${this.serverUrl}/api/remix/ai-remix-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixIds: [matrixId],
          creatorId: pipeline.creator_id,
          videoIds: [pipeline.source_video_id],
          cdpInstanceId,
          ratio,
          presetId,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!remixRes.ok) {
        const errBody = await remixRes.text().catch(() => "");
        throw new Error(`AI混剪 API HTTP ${remixRes.status}: ${errBody.slice(0, 300)}`);
      }

      const remixData = await remixRes.json();
      if (!remixData.tasks?.length) throw new Error("AI混剪 API 未返回任务");

      const remixTaskId = remixData.tasks[0].id;
      this._updatePipeline(pipeline.id, {
        remixTaskId: remixTaskId,
        status: "remixing",
        failReason: null,
      });

      this.store.logCdpEvent(
        null,
        "info",
        `自动发布-触发混剪: pipeline=${pipeline.id}, remixTask=${remixTaskId}`,
      );
      this._emitChange();
    } catch (err) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: `触发混剪失败: ${err.message}`,
      });
      this.store.logCdpEvent(null, "error", `自动发布-触发混剪失败: ${err.message}`);
      this._emitChange();
    }
  }

  // ─── 3. 检测混剪完成 ───

  async checkRemixComplete() {
    const remixingPipelines = this._listPipelinesByStatus("remixing");
    if (!remixingPipelines.length) return;

    let changed = false;
    for (const pipeline of remixingPipelines) {
      if (!pipeline.remix_task_id) continue;

      const remixTask = this.store.getRemixTask(pipeline.remix_task_id);
      if (!remixTask) {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: `混剪任务 ${pipeline.remix_task_id} 不存在`,
        });
        changed = true;
        continue;
      }

      if (remixTask.status === "DONE") {
        this._updatePipeline(pipeline.id, {
          status: "remixed",
          failReason: null,
        });
        this.store.logCdpEvent(
          null,
          "info",
          `自动发布-混剪完成: pipeline=${pipeline.id}, output=${remixTask.outputUrl}`,
        );
        changed = true;
      } else if (remixTask.status === "FAILED") {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: `混剪失败: ${remixTask.errorMessage || "未知错误"}`,
        });
        this.store.logCdpEvent(
          null,
          "error",
          `自动发布-混剪失败: pipeline=${pipeline.id}, ${remixTask.errorMessage}`,
        );
        changed = true;
      }
    }

    if (changed) this._emitChange();
  }

  // ─── 4. 自动排期发布 ───

  async schedulePublishJobs() {
    const remixedPipelines = this._listPipelinesByStatus("remixed");
    if (!remixedPipelines.length) return;

    let changed = false;
    for (const pipeline of remixedPipelines) {
      try {
        if (await this._scheduleOnePipeline(pipeline)) changed = true;
      } catch (err) {
        console.error(`[AutoPublishScheduler] 排期失败 pipeline=${pipeline.id}:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-排期失败: ${err.message}`);
      }
    }
    if (changed) this._emitChange();
  }

  async _scheduleOnePipeline(pipeline) {
    const cfg = this._getConfig(pipeline.creator_id);
    const profileId = pipeline.profile_id;

    if (!profileId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 profile_id，无法发布",
      });
      return true;
    }

    // 检查今日已发布数量是否达到 daily_limit
    const binding = this._getCreatorBinding(pipeline.creator_id, profileId);
    const dailyLimit = binding?.daily_limit || cfg?.daily_limit_per_profile || 3;
    const todayPublished = this._countTodayPublishedByProfile(profileId);
    if (todayPublished >= dailyLimit) {
      return false; // 达到上限，跳过
    }

    if (!pipeline.remix_task_id) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 remix_task_id",
      });
      return true;
    }

    const remixTask = this.store.getRemixTask(pipeline.remix_task_id);
    if (!remixTask || !remixTask.outputUrl) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "混剪成品视频不存在",
      });
      return true;
    }

    // 计算发布时间
    const scheduledAt = this._calcNextPublishTime(profileId);

    // 创建 tk_video_material（发布需要 material_id）
    const hashtags = cfg?.hashtags_json
      ? (typeof cfg.hashtags_json === "string" ? JSON.parse(cfg.hashtags_json) : cfg.hashtags_json)
      : [];
    const material = this.store.createTkMaterial({
      filePath: remixTask.outputUrl,
      title: remixTask.title || "自动发布视频",
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      privacyLevel: cfg?.privacy_level || "public",
      category: "auto-publish",
    });

    // 创建 tk_publish_job
    const job = this.store.createTkPublishJob({
      accountId: profileId,
      profileId,
      materialId: material.id,
      scheduledAt,
      status: "pending",
    });

    this._updatePipeline(pipeline.id, {
      publishJobId: job.id,
      status: "scheduled",
    });

    this.store.logCdpEvent(
      null,
      "info",
      `自动发布-排期: pipeline=${pipeline.id}, job=${job.id}, scheduledAt=${scheduledAt}`,
    );
    return true;
  }

  _calcNextPublishTime(profileId) {
    const now = new Date();
    const jobs = this.store.listTkPublishJobs({ profileId, limit: 500 });

    let lastTime = 0;
    for (const j of jobs) {
      const t = new Date(j.scheduledAt).getTime();
      if (t > lastTime) lastTime = t;
      if (j.executedAt) {
        const et = new Date(j.executedAt).getTime();
        if (et > lastTime) lastTime = et;
      }
    }

    const minNext = Math.max(now.getTime(), lastTime + PUBLISH_INTERVAL_MIN_MS);
    const randomExtra = Math.floor(Math.random() * 30 * 60 * 1000);
    return new Date(minNext + randomExtra).toISOString();
  }

  _countTodayPublishedByProfile(profileId) {
    const jobs = this.store.listTkPublishJobs({ profileId, limit: 500 });
    const todayStr = new Date().toISOString().slice(0, 10);
    return jobs.filter((j) => {
      if (j.status !== "success") return false;
      const executedAt = j.executedAt || j.scheduledAt;
      return executedAt && executedAt.slice(0, 10) === todayStr;
    }).length;
  }

  // ─── 5. 检测发布结果 ───

  async checkPublishResults() {
    const scheduledPipelines = this._listPipelinesByStatus("scheduled");
    if (!scheduledPipelines.length) return;

    let changed = false;
    for (const pipeline of scheduledPipelines) {
      if (!pipeline.publish_job_id) continue;

      const job = this.store.getTkPublishJob(pipeline.publish_job_id);
      if (!job) {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: `发布任务 ${pipeline.publish_job_id} 不存在`,
        });
        changed = true;
        continue;
      }

      if (job.status === "success") {
        this._updatePipeline(pipeline.id, {
          status: "published",
          failReason: null,
        });
        this.store.logCdpEvent(
          null,
          "info",
          `自动发布-发布成功: pipeline=${pipeline.id}, job=${job.id}`,
        );
        changed = true;
      } else if (job.status === "failed") {
        const newAttempt = (pipeline.attempt_count || 0) + 1;
        if (newAttempt >= MAX_RETRY_COUNT) {
          this._updatePipeline(pipeline.id, {
            status: "failed",
            attemptCount: newAttempt,
            failReason: `发布失败已达 ${MAX_RETRY_COUNT} 次: ${job.errorMessage || "未知错误"}`,
          });
        } else {
          this._updatePipeline(pipeline.id, {
            status: "retry",
            attemptCount: newAttempt,
            failReason: `发布失败(第${newAttempt}次): ${job.errorMessage || "未知错误"}`,
          });
        }
        this.store.logCdpEvent(
          null,
          "warning",
          `自动发布-发布失败: pipeline=${pipeline.id}, attempt=${newAttempt}, ${job.errorMessage}`,
        );
        changed = true;
      }
    }

    if (changed) this._emitChange();
  }

  // ─── 6. 重试逻辑 ───

  async retryFailedTasks() {
    const retryPipelines = this._listPipelinesByStatus("retry");
    if (!retryPipelines.length) return;

    const remixingCount = this._listPipelinesByStatus("remixing").length;
    if (remixingCount > 0) return;

    const pipeline = retryPipelines[0];
    const cfg = this._getConfig(pipeline.creator_id);

    if (!pipeline.source_video_id || !cfg) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "重试失败: 缺少 source_video_id 或配置",
      });
      this._emitChange();
      return;
    }

    const video = this.store.getRemixVideo(pipeline.source_video_id);
    if (!video) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "重试失败: 视频不存在",
      });
      this._emitChange();
      return;
    }

    const matrixId = pipeline.matrix_id || cfg.matrix_id;
    const cdpInstanceId = cfg.cdp_instance_id;
    const ratio = cfg.ratio || "9:16";
    const presetId = cfg.preset_id;

    if (!matrixId || !cdpInstanceId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "重试失败: 缺少 matrix_id 或 cdp_instance_id",
      });
      this._emitChange();
      return;
    }

    try {
      const remixRes = await fetch(`${this.serverUrl}/api/remix/ai-remix-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixIds: [matrixId],
          creatorId: pipeline.creator_id,
          videoIds: [pipeline.source_video_id],
          cdpInstanceId,
          ratio,
          presetId,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!remixRes.ok) {
        const errBody = await remixRes.text().catch(() => "");
        throw new Error(`重试混剪 API HTTP ${remixRes.status}: ${errBody.slice(0, 300)}`);
      }

      const remixData = await remixRes.json();
      if (!remixData.tasks?.length) throw new Error("重试混剪 API 未返回任务");

      const newRemixTaskId = remixData.tasks[0].id;
      this._updatePipeline(pipeline.id, {
        remixTaskId: newRemixTaskId,
        publishJobId: null,
        status: "remixing",
        failReason: null,
      });

      this.store.logCdpEvent(
        null,
        "info",
        `自动发布-重试混剪: pipeline=${pipeline.id}, newRemixTask=${newRemixTaskId}, attempt=${pipeline.attempt_count}`,
      );
      this._emitChange();
    } catch (err) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: `重试混剪失败: ${err.message}`,
      });
      this.store.logCdpEvent(null, "error", `自动发布-重试失败: ${err.message}`);
      this._emitChange();
    }
  }

  // ─── 辅助：事件 ───

  _emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: { ts: Date.now() } }));
  }

  // ─── 辅助：从达人名称提取 TikTok 用户名 ───

  _extractUsername(creator) {
    if (creator.platform && creator.platform.includes("@")) {
      const m = creator.platform.match(/@([^/\s]+)/);
      if (m) return m[1];
    }
    if (creator.name && creator.name.startsWith("@")) {
      return creator.name.substring(1).split(/\s/)[0];
    }
    return null;
  }

  // ─── 辅助：Schema 扩展 ───

  _ensureSchema() {
    const db = this.store.db;

    // 为 creator_auto_publish_config 补充列（已有表只有基础列）
    this._ensureColumn("creator_auto_publish_config", "tiktok_username", "TEXT");
    this._ensureColumn("creator_auto_publish_config", "cdp_instance_id", "TEXT");
    this._ensureColumn("creator_auto_publish_config", "matrix_id", "TEXT");
    this._ensureColumn("creator_auto_publish_config", "ratio", "TEXT DEFAULT '9:16'");
    this._ensureColumn("creator_auto_publish_config", "hashtags_json", "TEXT");
    this._ensureColumn("creator_auto_publish_config", "privacy_level", "TEXT DEFAULT 'public'");

    // 为 creator_profile_bindings 补充列
    this._ensureColumn("creator_profile_bindings", "cdp_instance_id", "TEXT");

    // 为 auto_remix_publish_pipeline 补充列
    this._ensureColumn("auto_remix_publish_pipeline", "source_url", "TEXT");
    this._ensureColumn("auto_remix_publish_pipeline", "matrix_id", "TEXT");
  }

  _ensureColumn(table, column, definition) {
    const columns = this.store.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // ─── 辅助：Pipeline CRUD ───

  _listPipelinesByStatus(status) {
    const rows = this.store.db
      .prepare("SELECT * FROM auto_remix_publish_pipeline WHERE status = ? ORDER BY created_at ASC")
      .all(status);
    return rows.map((r) => this._mapPipeline(r));
  }

  _getPipeline(id) {
    const r = this.store.db
      .prepare("SELECT * FROM auto_remix_publish_pipeline WHERE id = ?")
      .get(id);
    return r ? this._mapPipeline(r) : null;
  }

  _listAllPipelines() {
    const rows = this.store.db
      .prepare("SELECT * FROM auto_remix_publish_pipeline ORDER BY created_at DESC")
      .all();
    return rows.map((r) => this._mapPipeline(r));
  }

  _updatePipeline(id, { status = null, remixTaskId = undefined, publishJobId = undefined, attemptCount = undefined, failReason = undefined }) {
    const ts = nowIso();
    const sets = ["updated_at = ?"];
    const params = [ts];

    if (status !== null) {
      sets.push("status = ?");
      params.push(status);
    }
    if (remixTaskId !== undefined) {
      sets.push("remix_task_id = ?");
      params.push(remixTaskId);
    }
    if (publishJobId !== undefined) {
      sets.push("publish_job_id = ?");
      params.push(publishJobId);
    }
    if (attemptCount !== undefined) {
      sets.push("attempt_count = ?");
      params.push(attemptCount);
    }
    if (failReason !== undefined) {
      sets.push("fail_reason = ?");
      params.push(failReason);
    }

    params.push(id);
    this.store.db
      .prepare(`UPDATE auto_remix_publish_pipeline SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this._getPipeline(id);
  }

  _mapPipeline(r) {
    return {
      id: r.id,
      creator_id: r.creator_id,
      source_video_id: r.source_video_id || null,
      remix_task_id: r.remix_task_id || null,
      profile_id: r.profile_id || null,
      publish_job_id: r.publish_job_id || null,
      status: r.status,
      fail_reason: r.fail_reason || null,
      attempt_count: Number(r.attempt_count || 0),
      source_url: r.source_url || null,
      matrix_id: r.matrix_id || null,
      created_at: r.created_at,
      updated_at: r.updated_at || null,
    };
  }

  // ─── 辅助：Config ───

  _listEnabledConfigs() {
    const rows = this.store.db
      .prepare("SELECT * FROM creator_auto_publish_config WHERE enabled = 1")
      .all();
    return rows.map((r) => this._mapConfig(r));
  }

  _getConfig(creatorId) {
    const row = this.store.db
      .prepare("SELECT * FROM creator_auto_publish_config WHERE creator_id = ?")
      .get(creatorId);
    return row ? this._mapConfig(row) : null;
  }

  _mapConfig(r) {
    return {
      creator_id: r.creator_id,
      tiktok_username: r.tiktok_username || null,
      enabled: r.enabled !== 0,
      preset_id: r.preset_id || null,
      daily_limit_per_profile: Number(r.daily_limit_per_profile || 3),
      monitor_interval_hours: Number(r.monitor_interval_hours || 6),
      last_monitor_at: r.last_monitor_at || null,
      cdp_instance_id: r.cdp_instance_id || null,
      matrix_id: r.matrix_id || null,
      ratio: r.ratio || "9:16",
      hashtags_json: r.hashtags_json || null,
      privacy_level: r.privacy_level || "public",
    };
  }

  // ─── 辅助：Creator Bindings ───

  _listCreatorBindings(creatorId) {
    const rows = this.store.db
      .prepare("SELECT * FROM creator_profile_bindings WHERE creator_id = ? AND enabled = 1 ORDER BY created_at ASC")
      .all(creatorId);
    return rows.map((r) => ({
      id: r.id,
      creator_id: r.creator_id,
      profile_id: r.profile_id,
      daily_limit: Number(r.daily_limit || 3),
      last_publish_at: r.last_publish_at || null,
      enabled: r.enabled !== 0,
      cdp_instance_id: r.cdp_instance_id || null,
    }));
  }

  _getCreatorBinding(creatorId, profileId) {
    const row = this.store.db
      .prepare("SELECT * FROM creator_profile_bindings WHERE creator_id = ? AND profile_id = ?")
      .get(creatorId, profileId);
    if (!row) return null;
    return {
      id: row.id,
      creator_id: row.creator_id,
      profile_id: row.profile_id,
      daily_limit: Number(row.daily_limit || 3),
      last_publish_at: row.last_publish_at || null,
      enabled: row.enabled !== 0,
      cdp_instance_id: row.cdp_instance_id || null,
    };
  }

  // ─── 辅助：Video Monitor ───

  _getMonitoredVideo(creatorId, tiktokUrl) {
    const row = this.store.db
      .prepare("SELECT * FROM creator_video_monitor WHERE creator_id = ? AND tiktok_url = ?")
      .get(creatorId, tiktokUrl);
    return row || null;
  }

  _recordMonitoredVideo({ creatorId, videoId, tiktokUrl }) {
    const id = genId("cvm");
    const ts = nowIso();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO creator_video_monitor (id, creator_id, tiktok_url, video_id, downloaded, remix_video_id, monitored_at)
         VALUES (?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(id, creatorId, tiktokUrl, videoId || null, ts);
  }

  _updateMonitoredVideo(creatorId, tiktokUrl, { remixVideoId }) {
    const ts = nowIso();
    this.store.db
      .prepare(
        `UPDATE creator_video_monitor
         SET remix_video_id = COALESCE(?, remix_video_id), downloaded = 1
         WHERE creator_id = ? AND tiktok_url = ?`,
      )
      .run(remixVideoId || null, creatorId, tiktokUrl);
  }
}
