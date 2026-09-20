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
 *   - matrix_auto_publish_config  — 矩阵自动发布配置
 *   - matrix_profiles              — 矩阵绑定的指纹浏览器 profile
 *   - creator_video_monitor        — 达人视频监控记录
 *   - auto_remix_publish_pipeline  — 自动混剪发布流水线
 *
 * 通过 EventTarget 派发 "change" 事件，前端 SSE 可感知状态变化。
 */

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 分钟（主循环）
const PUBLISH_INTERVAL_MIN_MS = 30 * 60 * 1000; // 发布间隔至少 30 分钟
const MAX_RETRY_COUNT = 3;
const DEFAULT_MONITOR_INTERVAL_HOURS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

/** 返回东八区（北京时间）今天的 YYYY-MM-DD */
function todayBeijingStr() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 10);
}

/** 判断 ISO 时间字符串是否属于北京时间今天 */
function isBeijingToday(isoStr) {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const beijing = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 10) === todayBeijingStr();
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
    this.lastRemixAt = 0; // 上次触发混剪的时间
    this.lastRemixCreatorId = null; // 上次混剪的达人，用于轮换

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
      await this.monitorMatrixVideos();
      await this._createPipelineForExistingVideos();
      await this.triggerRemixTasks();
      await this.checkRemixComplete();
      await this.schedulePublishJobs();
      await this.checkPublishResults();
      await this.retryFailedTasks();
    } finally {
      this.running = false;
    }
  }

  // ─── 1. 监控矩阵新视频 ───

  async monitorMatrixVideos() {
    const configs = this._listEnabledMatrixConfigs();
    if (!configs.length) return;

    const now = Date.now();
    let changed = false;

    for (const cfg of configs) {
      // 检查是否到达监控间隔
      const intervalHours = cfg.monitorIntervalHours || DEFAULT_MONITOR_INTERVAL_HOURS;
      const intervalMs = intervalHours * 60 * 60 * 1000;
      const lastMonitorAt = cfg.lastMonitorAt ? new Date(cfg.lastMonitorAt).getTime() : 0;
      if (now - lastMonitorAt < intervalMs) continue;

      try {
        await this._checkMatrixNewVideos(cfg);
        // 更新 last_monitor_at
        this.store.db
          .prepare("UPDATE matrix_auto_publish_config SET last_monitor_at = ?, updated_at = ? WHERE matrix_id = ?")
          .run(nowIso(), nowIso(), cfg.matrixId);
        changed = true;
      } catch (err) {
        console.error(`[AutoPublishScheduler] 监控矩阵 ${cfg.matrixId} 失败:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-监控矩阵失败: ${err.message}`);
      }
    }

    if (changed) this._emitChange();
  }

  // 手动触发单个矩阵监控（不受间隔限制）
  async monitorSingleMatrix(matrixId) {
    const cfg = this._getMatrixConfig(matrixId);
    if (!cfg) throw new Error(`未找到矩阵 ${matrixId} 的配置`);
    if (!cfg.enabled) throw new Error(`矩阵 ${matrixId} 未启用自动发布`);
    await this._checkMatrixNewVideos(cfg);
    this.store.db
      .prepare("UPDATE matrix_auto_publish_config SET last_monitor_at = ?, updated_at = ? WHERE matrix_id = ?")
      .run(nowIso(), nowIso(), cfg.matrixId);
    this._emitChange();
  }

  async _checkMatrixNewVideos(cfg) {
    // 1. 查矩阵绑定的实例（1:1）
    const mp = this.store.db
      .prepare("SELECT profile_id FROM matrix_profiles WHERE matrix_id = ? LIMIT 1")
      .get(cfg.matrixId);
    if (!mp?.profile_id) {
      console.warn(`[AutoPublishScheduler] 矩阵 ${cfg.matrixId} 未绑定实例，跳过`);
      return;
    }
    const profileId = mp.profile_id;

    // 2. 查该矩阵所有平台账号选的达人（通过 matrix_account_creators）
    const creators = this.store.db.prepare(`
      SELECT DISTINCT c.id AS creator_id, c.name, c.platform
      FROM matrix_account_creators mac
      JOIN matrix_accounts ma ON ma.id = mac.matrix_account_id
      JOIN remix_creators c ON c.id = mac.creator_id
      WHERE ma.matrix_id = ?
    `).all(cfg.matrixId);

    if (!creators.length) {
      console.warn(`[AutoPublishScheduler] 矩阵 ${cfg.matrixId} 无关联达人，跳过`);
      return;
    }

    // 3. 对每个达人查新视频
    for (const creator of creators) {
      try {
        await this._checkCreatorNewVideosForMatrix(cfg, creator, profileId);
      } catch (err) {
        console.error(`[AutoPublishScheduler] 矩阵 ${cfg.matrixId} 达人 ${creator.name} 监控失败:`, err.message);
      }
    }
  }

  async _checkCreatorNewVideosForMatrix(cfg, creator, profileId) {
    const creatorObj = this.store.getRemixCreator(creator.creator_id);
    if (!creatorObj) return;

    let username = this._extractUsername(creatorObj);
    if (!username) {
      console.warn(`[AutoPublishScheduler] 达人 ${creatorObj.name} 无 TikTok 用户名，跳过`);
      return;
    }

    // 获取该达人已知的最新 createTime，用于增量解析（只获取比这个时间新的视频）
    const maxRow = this.store.db.prepare(
      "SELECT MAX(create_time) AS max_ct FROM remix_videos WHERE creator_id = ? AND create_time IS NOT NULL AND create_time != ''"
    ).get(creator.creator_id);
    const maxCreateTime = maxRow?.max_ct || null;

    console.log(`[AutoPublishScheduler] 监控达人 ${creatorObj.name}，最新已知 createTime=${maxCreateTime || '无'}`);

    // 调用 server 自带的 /api/tiktok/parse-profile 接口（传 maxCreateTime 做增量解析）
    const parseRes = await fetch(`${this.serverUrl}/api/tiktok/parse-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://www.tiktok.com/@${username}`, maxCreateTime }),
      signal: AbortSignal.timeout(180000),
    });
    if (!parseRes.ok) {
      const errBody = await parseRes.text().catch(() => "");
      throw new Error(`parse-profile HTTP ${parseRes.status}: ${errBody.slice(0, 200)}`);
    }
    const parseData = await parseRes.json();
    if (parseData.error) throw new Error(parseData.error);
    const feed = parseData.videos || [];
    if (!Array.isArray(feed) || !feed.length) return;

    // 检查 creator_video_monitor 表，发现新视频
    const newVideos = [];
    for (const v of feed) {
      const tiktokUrl = v.url || `https://www.tiktok.com/@${username}/video/${v.video_id}`;
      const monitored = this._getMonitoredVideo(creator.creator_id, tiktokUrl);
      if (monitored) continue;

      // 从 URL 提取 videoId
      const idMatch = tiktokUrl.match(/\/video\/(\d+)/);
      const videoId = idMatch ? idMatch[1] : (v.video_id || String(Date.now()));

      newVideos.push({
        videoId,
        url: tiktokUrl,
        title: (v.title || "").substring(0, 200),
        cover: v.cover || null,
        duration: v.duration || null,
        playUrl: v.play || null,
        author: username,
      });
    }

    if (!newVideos.length) return;

    console.log(`[AutoPublishScheduler] 矩阵 ${cfg.matrixId} 达人 ${creatorObj.name} 发现 ${newVideos.length} 个新视频`);

    for (const v of newVideos) {
      this._recordMonitoredVideo({
        creatorId: creator.creator_id,
        videoId: v.videoId,
        tiktokUrl: v.url,
      });
    }

    // 下载新视频并创建 pipeline 任务
    for (const v of newVideos) {
      try {
        await this._downloadAndCreatePipelineForMatrix(cfg, creator.creator_id, profileId, v);
      } catch (err) {
        console.error(`[AutoPublishScheduler] 下载视频 ${v.url} 失败:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-下载视频失败: ${v.url} → ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async _downloadAndCreatePipelineForMatrix(cfg, creatorId, profileId, videoInfo) {
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
    this._updateMonitoredVideo(creatorId, videoInfo.url, {
      remixVideoId: downloadData.videoId || null,
    });

    // 创建 pipeline 任务（一个矩阵一个实例，一条 pipeline）
    const pipelineId = genId("ap");
    this.store.db
      .prepare(
        `INSERT INTO auto_remix_publish_pipeline
         (id, creator_id, source_video_id, remix_task_id, profile_id, publish_job_id, status, fail_reason, attempt_count, source_url, matrix_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, NULL, 'pending', NULL, 0, ?, ?, ?, ?)`,
      )
      .run(
        pipelineId,
        creatorId,
        downloadData.videoId || "pending_download",
        profileId,                    // ← 从 matrix_profiles 查
        videoInfo.url,
        cfg.matrixId,                  // ← 矩阵ID
        nowIso(),
        nowIso(),
      );

    this.store.logCdpEvent(
      null,
      "info",
      `自动发布-Pipeline创建: ${pipelineId} (矩阵=${cfg.matrixId}, 达人=${creatorId}, profile=${profileId})`,
    );
  }

  // ─── 1.5 为矩阵绑定的达人的所有视频补建 pipeline ───
  // 不管视频是否已下载，都创建 pipeline（未下载的在混剪时自动下载）

  async _createPipelineForExistingVideos() {
    const configs = this._listEnabledMatrixConfigs();
    if (!configs.length) return;

    let changed = false;
    for (const cfg of configs) {
      const mp = this.store.db
        .prepare("SELECT profile_id FROM matrix_profiles WHERE matrix_id = ? LIMIT 1")
        .get(cfg.matrixId);
      if (!mp?.profile_id) continue;
      const profileId = mp.profile_id;

      // 查矩阵关联的所有达人
      const creators = this.store.db.prepare(`
        SELECT DISTINCT c.id AS creator_id, c.name AS creator_name FROM matrix_account_creators mac
        JOIN matrix_accounts ma ON ma.id = mac.matrix_account_id
        JOIN remix_creators c ON c.id = mac.creator_id
        WHERE ma.matrix_id = ?
        ORDER BY c.name
      `).all(cfg.matrixId);

      for (const creator of creators) {
        // 查该达人所有有 source_url 的视频（不管是否已下载）
        const videos = this.store.db
          .prepare("SELECT id, source_url, create_time, created_at FROM remix_videos WHERE creator_id = ? AND source_url IS NOT NULL AND source_url != '' ORDER BY COALESCE(create_time, '9999999999') ASC, created_at ASC")
          .all(creator.creator_id);

        for (const video of videos) {
          // 去重检查
          const existing = this.store.db
            .prepare("SELECT id FROM auto_remix_publish_pipeline WHERE source_video_id = ? AND profile_id = ?")
            .get(video.id, profileId);
          if (existing) continue;

          const pipelineId = genId("ap");
          this.store.db.prepare(`
            INSERT INTO auto_remix_publish_pipeline
            (id, creator_id, source_video_id, remix_task_id, profile_id,
             publish_job_id, status, fail_reason, attempt_count,
             source_url, matrix_id, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, NULL, 'pending', NULL, 0, ?, ?, ?, ?)
          `).run(
            pipelineId, creator.creator_id, video.id, profileId,
            video.source_url || null, cfg.matrixId, nowIso(), nowIso(),
          );

          // 记录到 monitor 表
          if (video.source_url) {
            this._recordMonitoredVideo({
              creatorId: creator.creator_id,
              videoId: video.id,
              tiktokUrl: video.source_url,
            });
          }

          this.store.logCdpEvent(null, "info",
            `自动发布-Pipeline补建: ${pipelineId} (矩阵=${cfg.matrixId}, 达人=${creator.creator_name}, 视频=${video.id})`);
          changed = true;
        }
      }
    }
    if (changed) this._emitChange();
  }

  // ─── 2. 自动触发混剪（24小时均匀分布，避免 AI 频率超限） ───

  /**
   * 混剪调度算法（24小时均匀分布）：
   *
   * 1. 统计所有启用矩阵的 dailyLimit 总和 = 每天需要的混剪总数
   *    例如: 矩阵A(dailyLimit=2) + 矩阵B(dailyLimit=2) = 4次/天
   *
   * 2. 计算混剪间隔 = 24小时 / 每天混剪总数
   *    例如: 24h / 4 = 6小时一次
   *
   * 3. 今天的混剪次数 = 今天(北京时间0点起)已完成的混剪(remixed+published+scheduled+remixing)
   *    如果今天混剪次数 < 每天混剪总数 → 需要混剪
   *
   * 4. 判断是否到了下一次混剪时间：
   *    - 上次混剪时间 + 混剪间隔 <= 现在 → 可以混剪
   *    - 如果今天还没混剪过 → 立即混剪
   *
   * 5. 选择要混剪的矩阵：轮换选择，优先选库存最低的矩阵
   *    库存 = 该矩阵的 scheduled + remixed + remixing
   *
   * 6. 在该矩阵的 pending pipeline 中取最旧的一个混剪
   */
  async triggerRemixTasks() {
    // 混剪并发1：有正在混剪的任务就等
    const remixingCount = this._listPipelinesByStatus("remixing").length;
    if (remixingCount > 0) return;

    // 获取所有启用的矩阵配置
    const configs = this._listEnabledMatrixConfigs();
    if (!configs.length) return;

    // 1. 计算每天需要的混剪总数（所有矩阵的 dailyLimit 之和）
    let totalDailyRemix = 0;
    const matrixStocks = []; // {cfg, profileId, stock}
    for (const cfg of configs) {
      const dailyLimit = cfg.dailyLimit ?? 3;
      totalDailyRemix += dailyLimit;

      const mp = this.store.db.prepare("SELECT profile_id FROM matrix_profiles WHERE matrix_id = ?").get(cfg.matrixId);
      const profileId = mp?.profile_id || null;

      // 该矩阵的库存 = scheduled + remixed + remixing
      const stockCount = this.store.db.prepare(
        `SELECT COUNT(*) as cnt FROM auto_remix_publish_pipeline p
         WHERE (p.matrix_id = ? ${profileId ? "OR (p.matrix_id IS NULL AND p.profile_id = ?)" : ""})
         AND p.status IN ('scheduled', 'remixed', 'remixing')`
      ).get(...(profileId ? [cfg.matrixId, profileId] : [cfg.matrixId])).cnt;

      matrixStocks.push({ cfg, profileId, stock: stockCount, dailyLimit });
    }

    if (totalDailyRemix === 0) return;

    // 2. 计算混剪间隔（毫秒）
    const remixIntervalMs = Math.floor(DAY_MS / totalDailyRemix);

    // 3. 统计今天（北京时间）已完成/进行中的混剪总数
    const todayRemixCount = this.store.db.prepare(
      `SELECT COUNT(*) as cnt FROM auto_remix_publish_pipeline
       WHERE status IN ('remixed', 'remixing', 'scheduled', 'published')
       AND updated_at >= ?`
    ).get(this._todayBeijingStartIso()).cnt;

    // 今天混剪次数已达上限，不再混剪
    if (todayRemixCount >= totalDailyRemix) return;

    // 4. 判断是否到了下一次混剪时间
    const now = Date.now();
    if (this.lastRemixAt > 0 && now - this.lastRemixAt < remixIntervalMs) return;

    // 5. 选择要混剪的矩阵：优先选库存最低的（库存/dailyLimit 比例最小）
    matrixStocks.sort((a, b) => {
      const ratioA = a.dailyLimit > 0 ? a.stock / a.dailyLimit : 999;
      const ratioB = b.dailyLimit > 0 ? b.stock / b.dailyLimit : 999;
      return ratioA - ratioB; // 比例小的优先
    });

    // 找有 pending pipeline 的矩阵
    const allPending = this._listPipelinesByStatus("pending");
    if (!allPending.length) return;

    let pipeline = null;
    let pipelineCfg = null;
    for (const ms of matrixStocks) {
      const candidates = allPending.filter(p => {
        if (p.matrix_id && p.matrix_id === ms.cfg.matrixId) return true;
        if (!p.matrix_id && p.profile_id && ms.profileId === p.profile_id) return true;
        if (!p.matrix_id && p.profile_id) {
          const mp = this.store.db.prepare("SELECT matrix_id FROM matrix_profiles WHERE profile_id = ?").get(p.profile_id);
          return mp && mp.matrix_id === ms.cfg.matrixId;
        }
        return false;
      });
      if (candidates.length) {
        candidates.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
        pipeline = candidates[0];
        pipelineCfg = ms.cfg;
        break;
      }
    }

    if (!pipeline) return;

    await this._doRemix(pipeline, pipelineCfg);
  }

  /** 返回北京时间今天的0点 ISO 时间（用于统计今天混剪次数） */
  _todayBeijingStartIso() {
    const now = new Date();
    const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const beijingToday0 = new Date(beijingNow.toISOString().slice(0, 10) + "T00:00:00.000Z");
    // 转回 UTC（减去8小时）
    return new Date(beijingToday0.getTime() - 8 * 60 * 60 * 1000).toISOString();
  }

  async _doRemix(pipeline, effectiveCfg) {
    const now = Date.now();

    if (!pipeline.source_video_id) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "Pipeline 缺少 source_video_id",
      });
      this._emitChange();
      return;
    }

    // 视频存在性检查 + 下载状态检查
    const video = this.store.getRemixVideo(pipeline.source_video_id);
    if (!video) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: `视频 ${pipeline.source_video_id} 不存在`,
      });
      this._emitChange();
      return;
    }
    if (!video.downloaded) {
      // 视频未下载，自动下载后再混剪
      if (!video.sourceUrl) {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: `视频 ${pipeline.source_video_id} 未下载且无 source_url`,
        });
        this._emitChange();
        return;
      }
      this.store.logCdpEvent(null, "info", `自动发布-自动下载视频: ${video.sourceUrl}`);
      try {
        const dlRes = await fetch(`${this.serverUrl}/api/tiktok/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: video.sourceUrl }),
          signal: AbortSignal.timeout(180000),
        });
        if (!dlRes.ok) throw new Error(`下载API HTTP ${dlRes.status}`);
        this.store.logCdpEvent(null, "info", `自动发布-视频下载完成: ${video.sourceUrl}`);
        // 重新查视频记录，确认已下载
        const updatedVideo = this.store.getRemixVideo(pipeline.source_video_id);
        if (!updatedVideo?.downloaded) {
          this.store.logCdpEvent(null, "warning", `自动发布-下载后仍标记为未下载: ${pipeline.source_video_id}`);
          return; // 跳过本次，下次再试
        }
      } catch (dlErr) {
        this.store.logCdpEvent(null, "error", `自动发布-自动下载失败: ${video.sourceUrl} - ${dlErr.message}`);
        return; // 下载失败不标记pipeline失败，下次窗口再试
      }
    }

    // 先补全 matrix_id（旧数据可能为 null），再查 cdpInstanceId
    if (!pipeline.matrix_id) {
      const mac = this.store.db
        .prepare(`SELECT ma.matrix_id FROM matrix_account_creators mac
                  JOIN matrix_accounts ma ON ma.id = mac.matrix_account_id
                  WHERE mac.creator_id = ? LIMIT 1`)
        .get(pipeline.creator_id);
      if (mac?.matrix_id) {
        this.store.db.prepare("UPDATE auto_remix_publish_pipeline SET matrix_id = ? WHERE id = ?")
          .run(mac.matrix_id, pipeline.id);
        pipeline.matrix_id = mac.matrix_id;
      }
    }

    const effectiveMatrixId = pipeline.matrix_id;
    let cdpInstanceId = effectiveCfg?.cdpInstanceId || null;
    if (!cdpInstanceId && effectiveMatrixId) {
      const mp = this.store.db
        .prepare("SELECT profile_id FROM matrix_profiles WHERE matrix_id = ? LIMIT 1")
        .get(effectiveMatrixId);
      cdpInstanceId = mp?.profile_id || null;
    }
    const presetId = effectiveCfg?.presetId || null;
    const ratio = effectiveCfg?.ratio || "9:16";

    if (!cdpInstanceId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 CDP 实例（请绑定 matrix_profiles 或在矩阵自动发布配置中设置 cdp_instance_id）",
      });
      this._emitChange();
      return;
    }

    // ─── 自动检查并启动 CDP daemon ───
    try {
      const daemonHealthRes = await fetch(`http://127.0.0.1:9223/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!daemonHealthRes.ok) throw new Error(`health check HTTP ${daemonHealthRes.status}`);
      const health = await daemonHealthRes.json();
      if (!health.ok || !health.cdpConnected) {
        throw new Error("CDP daemon 未连接 Chrome");
      }
    } catch (daemonErr) {
      // daemon 没在线，自动启动
      this.store.logCdpEvent(null, "info", `自动发布-CDP daemon 未在线(${daemonErr.message}), 自动启动中…`);
      try {
        const startRes = await fetch(`${this.serverUrl}/api/cdp/instances/${encodeURIComponent(cdpInstanceId)}/daemon-start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(30000),
        });
        if (!startRes.ok) throw new Error(`daemon-start HTTP ${startRes.status}`);
        // 等待 daemon 就绪
        await new Promise(r => setTimeout(r, 3000));
        // 再次检查
        const recheck = await fetch(`http://127.0.0.1:9223/health`, { signal: AbortSignal.timeout(5000) });
        const recheckData = await recheck.json();
        if (!recheckData.ok || !recheckData.cdpConnected) {
          throw new Error("daemon 启动后仍无法连接 Chrome");
        }
        this.store.logCdpEvent(null, "info", `自动发布-CDP daemon 已自动启动`);
      } catch (startErr) {
        this.store.logCdpEvent(null, "error", `自动发布-CDP daemon 自动启动失败: ${startErr.message}`);
        // daemon 启动失败，跳过本次混剪
        return;
      }
    }

    try {
      const remixRes = await fetch(`${this.serverUrl}/api/remix/ai-remix-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixIds: [pipeline.matrix_id],
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
      this.lastRemixAt = now;
      this.lastRemixCreatorId = pipeline.creator_id;

      this.store.logCdpEvent(
        null,
        "info",
        `自动发布-触发混剪(配额): pipeline=${pipeline.id}, remixTask=${remixTaskId}, matrix=${pipeline.matrix_id}`,
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

  // ─── 4. 自动排期发布（按北京时间判断"今天"，每天排 dailyLimit 个，多余的留到明天） ───

  async schedulePublishJobs() {
    const remixedPipelines = this._listPipelinesByStatus("remixed");
    if (!remixedPipelines.length) return;

    let changed = false;
    // 用北京时间（东八区）判断"今天"
    const todayStr = todayBeijingStr();

    // 缓存每个 profile 的今日排期计数
    const todayCountCache = new Map();

    for (const pipeline of remixedPipelines) {
      try {
        const profileId = pipeline.profile_id;
        if (!profileId) continue;

        // 查矩阵配置获取 dailyLimit
        let matrixId = pipeline.matrix_id;
        if (!matrixId && profileId) {
          const mp = this.store.db.prepare("SELECT matrix_id FROM matrix_profiles WHERE profile_id = ?").get(profileId);
          matrixId = mp?.matrix_id;
        }
        const cfg = matrixId ? this._getMatrixConfig(matrixId) : null;
        const dailyLimit = cfg?.dailyLimit ?? 3;

        // 获取或初始化今日计数（按北京时间）
        if (!todayCountCache.has(profileId)) {
          const pipelines = this.store.db.prepare(
            `SELECT p.status, j.scheduled_at, j.executed_at
             FROM auto_remix_publish_pipeline p
             JOIN tk_publish_jobs j ON j.id = p.publish_job_id
             WHERE p.profile_id = ? AND p.status IN ('scheduled', 'published')`
          ).all(profileId);
          const count = pipelines.filter(p =>
            isBeijingToday(p.scheduled_at) || isBeijingToday(p.executed_at)
          ).length;
          todayCountCache.set(profileId, count);
        }

        const todayCount = todayCountCache.get(profileId);
        if (todayCount >= dailyLimit) {
          continue; // 今天排满了，跳过（留到明天）
        }

        // 排期这个 pipeline
        if (await this._scheduleOnePipeline(pipeline)) {
          todayCountCache.set(profileId, todayCount + 1);
          changed = true;
        }
      } catch (err) {
        console.error(`[AutoPublishScheduler] 排期失败 pipeline=${pipeline.id}:`, err.message);
        this.store.logCdpEvent(null, "error", `自动发布-排期失败: ${err.message}`);
      }
    }
    if (changed) this._emitChange();
  }

  async _scheduleOnePipeline(pipeline) {
    // 配置从矩阵查（pipeline.matrix_id）
    const cfg = pipeline.matrix_id ? this._getMatrixConfig(pipeline.matrix_id) : null;
    const profileId = pipeline.profile_id;

    if (!profileId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "缺少 profile_id，无法发布",
      });
      return true;
    }

    if (!cfg) {
      // 尝试从旧表补全 matrix_id（7.3 风险处理）
      if (!pipeline.matrix_id) {
        const mac = this.store.db
          .prepare(`SELECT ma.matrix_id FROM matrix_account_creators mac
                    JOIN matrix_accounts ma ON ma.id = mac.matrix_account_id
                    WHERE mac.creator_id = ? LIMIT 1`)
          .get(pipeline.creator_id);
        if (mac?.matrix_id) {
          this.store.db.prepare("UPDATE auto_remix_publish_pipeline SET matrix_id = ? WHERE id = ?")
            .run(mac.matrix_id, pipeline.id);
          pipeline.matrix_id = mac.matrix_id;
        }
      }
      const cfg2 = pipeline.matrix_id ? this._getMatrixConfig(pipeline.matrix_id) : null;
      if (!cfg2) {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: "缺少 matrix_auto_publish_config 配置",
        });
        this._emitChange();
        return true;
      }
    }

    const effectiveCfg = cfg || this._getMatrixConfig(pipeline.matrix_id);

    // daily_limit 从矩阵配置查（不再查 creator_profile_bindings）
    const dailyLimit = effectiveCfg?.dailyLimit ?? 3;
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
    const scheduledAt = this._calcNextPublishTime(profileId, effectiveCfg);

    // 创建 tk_video_material（发布需要 material_id）
    const hashtags = effectiveCfg?.hashtagsJson
      ? (typeof effectiveCfg.hashtagsJson === "string" ? JSON.parse(effectiveCfg.hashtagsJson) : effectiveCfg.hashtagsJson)
      : [];
    const material = this.store.createTkMaterial({
      filePath: remixTask.outputUrl,
      title: remixTask.title || "自动发布视频",
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      privacyLevel: effectiveCfg?.privacyLevel || "public",
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

  _calcNextPublishTime(profileId, cfg = null) {
    const now = new Date();

    // 如果配置了发布时间段，使用时间段逻辑
    let slots = null;
    if (cfg?.publishTimeSlots) {
      try {
        const raw = typeof cfg.publishTimeSlots === "string" ? JSON.parse(cfg.publishTimeSlots) : cfg.publishTimeSlots;
        if (Array.isArray(raw) && raw.length) slots = raw;
      } catch { /* 解析失败，回退到默认逻辑 */ }
    }

    if (slots) {
      return this._calcNextPublishTimeWithSlots(slots, profileId, now);
    }

    // 回退：原逻辑（lastTime + 10分钟 + 随机0-30分钟）
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

  /**
   * 根据发布时间段计算下次发布时间
   * @param {string[]} slots — 如 ["09:00-12:00","14:00-17:00","19:00-22:00"]
   * @param {string} profileId
   * @param {Date} now
   */
  _calcNextPublishTimeWithSlots(slots, profileId, now) {
    // 解析时间段和精确时间点
    // 时间段格式: "09:00-12:00" → { startMin, endMin, type: 'range' }
    // 精确时间格式: "09:00" → { startMin, endMin: startMin, type: 'exact' }
    const parsedSlots = slots.map((s) => {
      // 先尝试匹配时间段 HH:MM-HH:MM
      const rangeMatch = s.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (rangeMatch) {
        return { startMin: parseInt(rangeMatch[1], 10) * 60 + parseInt(rangeMatch[2], 10), endMin: parseInt(rangeMatch[3], 10) * 60 + parseInt(rangeMatch[4], 10), type: 'range', raw: s };
      }
      // 再尝试匹配精确时间 HH:MM
      const exactMatch = s.match(/(\d{1,2}):(\d{2})/);
      if (exactMatch) {
        const min = parseInt(exactMatch[1], 10) * 60 + parseInt(exactMatch[2], 10);
        return { startMin: min, endMin: min, type: 'exact', raw: s };
      }
      return null;
    }).filter(Boolean);

    if (!parsedSlots.length) {
      // 所有时间段都解析失败，回退到默认逻辑
      const jobs = this.store.listTkPublishJobs({ profileId, limit: 500 });
      let lastTime = 0;
      for (const j of jobs) {
        const t = new Date(j.scheduledAt).getTime();
        if (t > lastTime) lastTime = t;
      }
      const minNext = Math.max(now.getTime(), lastTime + PUBLISH_INTERVAL_MIN_MS);
      const randomExtra = Math.floor(Math.random() * 30 * 60 * 1000);
      return new Date(minNext + randomExtra).toISOString();
    }

    // 按 startMin 排序
    parsedSlots.sort((a, b) => a.startMin - b.startMin);

    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowMs = now.getTime();

    // 获取今天已排期的最后时间，确保间隔 >= PUBLISH_INTERVAL_MIN_MS
    const jobs = this.store.listTkPublishJobs({ profileId, limit: 500 });
    let lastScheduledMs = 0;
    for (const j of jobs) {
      const t = new Date(j.scheduledAt).getTime();
      if (t > lastScheduledMs) lastScheduledMs = t;
      if (j.executedAt) {
        const et = new Date(j.executedAt).getTime();
        if (et > lastScheduledMs) lastScheduledMs = et;
      }
    }

    // 尝试今天剩余的时间段，然后明天的
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const baseDate = new Date(now);
      baseDate.setDate(baseDate.getDate() + dayOffset);
      baseDate.setHours(0, 0, 0, 0);

      for (const slot of parsedSlots) {
        const slotStartMs = baseDate.getTime() + slot.startMin * 60 * 1000;
        const slotEndMs = baseDate.getTime() + slot.endMin * 60 * 1000;

        // 候选时间 = max(现在, 上次发布 + 最小间隔)
        let candidateMs = Math.max(nowMs, lastScheduledMs + PUBLISH_INTERVAL_MIN_MS);

        if (slot.type === 'exact') {
          // 精确时间点：如果已过或与上次排期间隔不足30分钟，跳到明天
          if (dayOffset === 0 && slotStartMs < candidateMs) continue;
          // 检查同一时间段是否已被排期（防止多个pipeline排到同一时间点）
          const sameSlotScheduled = this.store.listTkPublishJobs({ profileId, limit: 500 })
            .some(j => Math.abs(new Date(j.scheduledAt).getTime() - slotStartMs) < 60 * 1000);
          if (sameSlotScheduled) continue;
          return new Date(slotStartMs).toISOString();
        }

        // 时间段：在范围内随机
        // 第一天跳过已过的时间段，第二天不限
        if (dayOffset === 0 && candidateMs >= slotEndMs) continue;
        // 确保候选时间在时间段内
        if (candidateMs < slotStartMs) candidateMs = slotStartMs;
        if (candidateMs >= slotEndMs) continue;

        // 在 [candidateMs, slotEndMs - 5min] 范围内取随机时间
        const latestMs = Math.max(candidateMs, slotEndMs - 5 * 60 * 1000);
        const randomMs = candidateMs + Math.floor(Math.random() * Math.max(1, latestMs - candidateMs));
        return new Date(randomMs).toISOString();
      }
    }

    // 兜底：找不到合适时间段，用明天第一个时间段开始
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const firstSlot = parsedSlots[0];
    return new Date(tomorrow.getTime() + firstSlot.startMin * 60 * 1000).toISOString();
  }

  _countTodayPublishedByProfile(profileId) {
    const jobs = this.store.listTkPublishJobs({ profileId, limit: 500 });
    return jobs.filter((j) => {
      if (j.status !== "success") return false;
      const executedAt = j.executedAt || j.scheduledAt;
      return isBeijingToday(executedAt);
    }).length;
  }

  // ─── 5. 检测发布结果 + 超时重新排期 ───

  async checkPublishResults() {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2小时
    let changed = false;

    // 5a. 检查 scheduled 状态的 pipeline
    const scheduledPipelines = this._listPipelinesByStatus("scheduled");
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
          null, "info",
          `自动发布-发布成功: pipeline=${pipeline.id}, job=${job.id}`,
        );
        changed = true;
      } else {
        // job 是 pending 或 failed：检查排期时间是否超过2小时
        const scheduledMs = job.scheduledAt ? new Date(job.scheduledAt).getTime() : now;
        const elapsed = now - scheduledMs;
        if (elapsed >= STALE_THRESHOLD_MS) {
          // 超过2小时还没成功，回退到 remixed 重新排期
          this._updatePipeline(pipeline.id, {
            status: "remixed",
            publishJobId: null,
            failReason: `排期超过2小时未成功(${job.status})，重新排期: ${job.errorMessage || ""}`,
          });
          this.store.db.prepare("DELETE FROM tk_publish_jobs WHERE id = ?").run(job.id);
          this.store.logCdpEvent(
            null, "warning",
            `自动发布-超2h重新排期: pipeline=${pipeline.id}, job=${job.id}, jobStatus=${job.status}`,
          );
          changed = true;
        }
      }
    }

    // 5b. 检查 failed 状态的 pipeline（超2小时重新排期）
    const failedPipelines = this._listPipelinesByStatus("failed");
    for (const pipeline of failedPipelines) {
      // 用 pipeline 的 updated_at 判断失败时间
      const failedMs = pipeline.updated_at ? new Date(pipeline.updated_at).getTime() : now;
      const elapsed = now - failedMs;
      if (elapsed >= STALE_THRESHOLD_MS) {
        // 超过2小时，回退到 remixed 重新排期
        this._updatePipeline(pipeline.id, {
          status: "remixed",
          publishJobId: null,
          attemptCount: 0,
          failReason: `失败超过2小时，重新排期`,
        });
        // 删除关联的 job（如果有）
        if (pipeline.publish_job_id) {
          this.store.db.prepare("DELETE FROM tk_publish_jobs WHERE id = ?").run(pipeline.publish_job_id);
        }
        this.store.logCdpEvent(
          null, "warning",
          `自动发布-failed超2h重新排期: pipeline=${pipeline.id}`,
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
    // 配置从矩阵查
    const cfg = pipeline.matrix_id ? this._getMatrixConfig(pipeline.matrix_id) : null;

    if (!pipeline.source_video_id || !cfg) {
      // 尝试从旧表补全 matrix_id
      if (!pipeline.matrix_id) {
        const mac = this.store.db
          .prepare(`SELECT ma.matrix_id FROM matrix_account_creators mac
                    JOIN matrix_accounts ma ON ma.id = mac.matrix_account_id
                    WHERE mac.creator_id = ? LIMIT 1`)
          .get(pipeline.creator_id);
        if (mac?.matrix_id) {
          this.store.db.prepare("UPDATE auto_remix_publish_pipeline SET matrix_id = ? WHERE id = ?")
            .run(mac.matrix_id, pipeline.id);
          pipeline.matrix_id = mac.matrix_id;
        }
      }
      const cfg2 = pipeline.matrix_id ? this._getMatrixConfig(pipeline.matrix_id) : null;
      if (!pipeline.source_video_id || !cfg2) {
        this._updatePipeline(pipeline.id, {
          status: "failed",
          failReason: "重试失败: 缺少 source_video_id 或配置",
        });
        this._emitChange();
        return;
      }
    }

    const effectiveCfg = cfg || this._getMatrixConfig(pipeline.matrix_id);
    const video = this.store.getRemixVideo(pipeline.source_video_id);
    if (!video) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "重试失败: 视频不存在",
      });
      this._emitChange();
      return;
    }

    // matrix_id 直接从 pipeline 获取
    const effectiveMatrixId = pipeline.matrix_id;
    // cdp_instance_id 从 matrix_profiles 查 profile_id（混剪需要的 CDP 实例就是浏览器实例）
    let cdpInstanceId = effectiveCfg?.cdpInstanceId || null;
    if (!cdpInstanceId && effectiveMatrixId) {
      const mp = this.store.db
        .prepare("SELECT profile_id FROM matrix_profiles WHERE matrix_id = ? LIMIT 1")
        .get(effectiveMatrixId);
      cdpInstanceId = mp?.profile_id || null;
    }
    const ratio = effectiveCfg?.ratio || "9:16";
    const presetId = effectiveCfg?.presetId || null;

    // cdp_instance_id 仍需校验
    if (!cdpInstanceId) {
      this._updatePipeline(pipeline.id, {
        status: "failed",
        failReason: "重试失败: 缺少 CDP 实例（请绑定 matrix_profiles 或在矩阵自动发布配置中设置 cdp_instance_id）",
      });
      this._emitChange();
      return;
    }

    try {
      const remixRes = await fetch(`${this.serverUrl}/api/remix/ai-remix-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixIds: [effectiveMatrixId],
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
        `自动发布-重试混剪: pipeline=${pipeline.id}, newRemixTask=${newRemixTaskId}, attempt=${pipeline.attempt_count}, matrix=${effectiveMatrixId}`,
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
    // 1. platform 字段中提取 @username
    if (creator.platform && creator.platform.includes("@")) {
      const m = creator.platform.match(/@([^/\s]+)/);
      if (m) return m[1];
    }
    // 2. name 以 @ 开头
    if (creator.name && creator.name.startsWith("@")) {
      return creator.name.substring(1).split(/\s/)[0];
    }
    // 3. name 本身就是 TikTok 用户名（无 @ 前缀，无空格，无中文）
    if (creator.name && /^[a-zA-Z0-9._]+$/.test(creator.name)) {
      return creator.name;
    }
    return null;
  }

  // ─── 辅助：Schema 扩展 ───

  _ensureSchema() {
    // 迁移逻辑已在 database.js 的 #migrate() 中统一处理
    // 这里仅做最后保障：确保 pipeline 表有 source_url 和 matrix_id 列
    this._ensureColumn("auto_remix_publish_pipeline", "source_url", "TEXT");
    this._ensureColumn("auto_remix_publish_pipeline", "matrix_id", "TEXT");
    // 确保新表存在（database.js 也会建，这里做双重保障）
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS matrix_auto_publish_config (
        matrix_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        preset_id TEXT,
        daily_limit INTEGER DEFAULT 3,
        monitor_interval_hours INTEGER DEFAULT 6,
        last_monitor_at TEXT,
        publish_time_slots TEXT,
        ratio TEXT DEFAULT '9:16',
        hashtags_json TEXT,
        privacy_level TEXT DEFAULT 'public',
        cdp_instance_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (matrix_id) REFERENCES media_matrices(id) ON DELETE CASCADE
      );
    `);
  }

  _ensureColumn(table, column, definition) {
    const columns = this.store.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // ─── 辅助：Pipeline CRUD ───

  _listPipelinesByStatus(status) {
    const rows = this.store.db
      .prepare(`
        SELECT p.*, v.create_time AS video_create_time
        FROM auto_remix_publish_pipeline p
        LEFT JOIN remix_videos v ON v.id = p.source_video_id
        WHERE p.status = ?
        ORDER BY COALESCE(v.create_time, p.created_at) ASC
      `)
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

  _listEnabledMatrixConfigs() {
    return this.store.listEnabledMatrixConfigs();
  }

  _getMatrixConfig(matrixId) {
    return this.store.getMatrixAutoPublishConfig(matrixId);
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
