import { TiktokPublisher } from "./tiktok-publisher.js";
import { createIosFarmClient } from "../ios-farm-client.js";

export class TiktokPublishManager extends EventTarget {
  constructor({ bitBrowserApi, persistence = null, iosFarm = null } = {}) {
    super();
    this.bitBrowserApi = bitBrowserApi;
    this.persistence = persistence;
    this.iosFarm = iosFarm; // IosFarmClient 实例，如不为空则优先用 iOS Farm 发布
    this.timer = null;
    this.runningJobIds = new Set();
    // iOS Farm 执行轮询：executionId → { jobId, intervalId }
    this.iosFarmPollers = new Map();
  }

  startScheduler(intervalMs = 30000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkAndExecutePendingJobs().catch((err) => {
        console.error("[TiktokPublishManager] 轮询执行定时发布任务失败:", err);
      });
    }, intervalMs);
    // 立即触发一次检测
    this.checkAndExecutePendingJobs().catch(() => {});
  }

  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAndExecutePendingJobs() {
    if (!this.persistence) return;
    const nowIso = new Date().toISOString();
    const pendingJobs = this.persistence.listTkPublishJobs({ status: "pending", limit: 20 });
    
    // 发布并发限制：同时只执行一个发布任务
    if (this.runningJobIds.size > 0) return;
    
    for (const job of pendingJobs) {
      if (job.scheduledAt <= nowIso && !this.runningJobIds.has(job.id)) {
        this.executeJob(job.id).catch((err) => {
          console.error(`[TiktokPublishManager] 任务 ${job.id} 执行失败:`, err);
        });
        break; // 只取第一个到时间的任务，等它完成后再取下一个
      }
    }
  }

  async executeJob(jobId) {
    if (this.runningJobIds.has(jobId)) throw new Error("该任务正在执行中");
    if (this.runningJobIds.size > 0) throw new Error("已有发布任务正在执行，请等待完成");
    const job = this.persistence?.getTkPublishJob(jobId);
    if (!job) throw new Error("未找到指定的发布任务");
    if (job.status === "success") throw new Error("该任务已发布成功，无需重复发布");
    if (job.status === "running") throw new Error("该任务正在执行中");

    this.runningJobIds.add(jobId);
    this.persistence?.updateTkPublishJobStatus(jobId, { status: "running", executedAt: new Date().toISOString() });
    this._log(jobId, "info", `发布任务开始: profile=${job.profileId}, title=${job.materialTitle?.substring(0, 50) || "—"}`);
    this.dispatchEvent(new CustomEvent("change"));

    // ===== iOS Farm 发布模式 =====
    // 如果 job.profileId 以 "ios_" 开头，使用 iOS Farm 发布
    if (job.profileId && job.profileId.startsWith("ios_")) {
      const udid = job.profileId.replace(/^ios_/, "");
      return await this._executeViaIosFarm(jobId, udid, job);
    }

    let publisher = null;
    try {
      // 1. 打开对应的比特浏览器 Profile
      this._log(jobId, "info", `正在打开比特浏览器实例 [${job.profileId}]…`);
      const conn = await this.bitBrowserApi.openProfile(job.profileId);
      if (!conn || !conn.wsUrl) throw new Error(`比特浏览器窗口 [${job.profileId}] 打开失败或缺失 WebSocket 地址`);
      this._log(jobId, "info", `比特浏览器已连接: ${conn.wsUrl.substring(0, 60)}…`);

      // 2. 连接 CDP 发布驱动引擎
      publisher = new TiktokPublisher();
      await publisher.connect(conn.wsUrl);
      this._log(jobId, "info", `CDP 发布引擎已连接`);

      // 3. 执行全自动发布
      // 标题处理：去掉 "AI混剪 · " 前缀和 " → N个矩阵" 后缀，再从 "创作的 " 后面取内容
      let publishTitle = job.materialTitle || '';
      publishTitle = publishTitle.replace(/^AI混剪\s*·\s*/, '').replace(/\s*→\s*\d+个矩阵$/, '');
      const creativeMatch = publishTitle.match(/创作的\s*(.+)$/);
      if (creativeMatch) publishTitle = creativeMatch[1].trim();
      
      this._log(jobId, "info", `开始上传视频: ${job.materialFilePath?.substring(0, 80) || "—"} | 标题: ${publishTitle.substring(0, 60)}`);
      const result = await publisher.uploadVideo({
        filePath: job.materialFilePath,
        title: publishTitle,
        hashtags: job.materialHashtags,
        privacyLevel: job.materialPrivacy
      });

      // 获取用户名（用于发布后记录播放量）— 死代码已删除
      // （recordAnalytics 内部自行获取当前登录账号用户名）

      if (result.ok) {
        this.persistence?.updateTkPublishJobStatus(jobId, {
          status: "success",
          publishedVideoId: result.publishedVideoId || null,
          publishedVideoUrl: result.publishedVideoUrl || null
        });
        this._log(jobId, "info", `发布成功! videoId=${result.publishedVideoId || "—"}, url=${result.publishedVideoUrl || "—"}`);

        // 发布成功后，去我们自己的账号主页记录播放量（只记录本次发布的视频）
        try {
          if (!result.publishedVideoId) {
            this._log(jobId, "warning", `未获取到发布视频ID，跳过播放量记录`);
          } else {
            this._log(jobId, "info", `正在访问发布账号主页记录播放量…`);
            const analyticsResult = await publisher.recordAnalytics(result.publishedVideoId);
            this._log(jobId, "info", `播放量记录完成: ${analyticsResult.videoCount} 个视频`);

            // 存入 tk_video_analytics 表
            if (analyticsResult.videos?.length && this.persistence) {
              const nowIso = new Date().toISOString();
              const insertStmt = this.persistence.db.prepare(
                `INSERT INTO tk_video_analytics (publish_job_id, views_count, likes_count, comments_count, shares_count, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
              );
              for (const v of analyticsResult.videos) {
                const views = this._parseCount(v.views);
                const likes = this._parseCount(v.likes);
                const comments = this._parseCount(v.comments);
                const shares = this._parseCount(v.shares);
                insertStmt.run(jobId, views, likes, comments, shares, nowIso);
              }
            }
          }
        } catch (analyticsErr) {
          this._log(jobId, "warning", `播放量记录失败(不影响发布结果): ${analyticsErr.message}`);
        }
      } else {
        throw new Error(result.message || "视频自动发布未成功完成");
      }
    } catch (error) {
      this.persistence?.updateTkPublishJobStatus(jobId, {
        status: "failed",
        errorMessage: error.message
      });
      this._log(jobId, "error", `发布失败: ${error.message}`);
      throw error;
    } finally {
      this.runningJobIds.delete(jobId);
      if (publisher) {
        await publisher.close().catch(() => {});
      }
      this.dispatchEvent(new CustomEvent("change"));
    }
  }

  /**
   * 通过 iOS Farm 发布视频
   * 流程：上传视频 → 创建 post 任务 → 轮询执行状态 → 更新 job 状态
   * @private
   */
  async _executeViaIosFarm(jobId, udid, job) {
    if (!this.iosFarm) {
      throw new Error("iOS Farm 客户端未配置，无法执行 iOS 发布任务");
    }
    try {
      // 1. 上传视频到 Mac
      this._log(jobId, "info", `iOS Farm: 正在上传视频到 Mac (${udid})…`);
      const fileName = job.materialFilePath?.split("/").pop() || `video_${jobId}.mp4`;
      const asset = await this.iosFarm.uploadAsset(job.materialFilePath, fileName);
      this._log(jobId, "info", `iOS Farm: 视频上传成功, assetId=${asset.id || asset.assetId}, size=${asset.size || "—"}`);

      // 2. 标题处理（和 Playwright 模式一致）
      let publishTitle = job.materialTitle || '';
      publishTitle = publishTitle.replace(/^AI混剪\s*·\s*/, '').replace(/\s*→\s*\d+个矩阵$/, '');
      const creativeMatch = publishTitle.match(/创作的\s*(.+)$/);
      if (creativeMatch) publishTitle = creativeMatch[1].trim();

      // 3. 从 matrix_accounts 查真实 TikTok 账号名（job.accountId 存的是 profileId 不是账号名）
      let tiktokAccount = "";
      if (this.persistence?.db) {
        try {
          const matrixProfile = this.persistence.db
            .prepare("SELECT matrix_id FROM matrix_profiles WHERE profile_id = ?")
            .get(job.profileId);
          if (matrixProfile) {
            const account = this.persistence.db
              .prepare("SELECT account_name FROM matrix_accounts WHERE matrix_id = ? AND platform = 'tiktok'")
              .get(matrixProfile.matrix_id);
            if (account) tiktokAccount = account.account_name;
          }
        } catch {}
      }

      // 4. 创建 TikTok post 任务
      this._log(jobId, "info", `iOS Farm: 创建发布任务, udid=${udid}, account=${tiktokAccount || "默认"}, 标题=${publishTitle.substring(0, 50)}`);
      const schedule = await this.iosFarm.createPostSchedule({
        deviceUdid: udid,
        media: [{
          assetId: asset.id || asset.assetId,
          name: asset.originalName || fileName,
          mimeType: asset.mimeType || "video/mp4",
        }],
        account: tiktokAccount,
        caption: publishTitle,
        destination: "publish",
        timing: { kind: "now" },
      });

      const scheduleId = schedule?.id || schedule?.scheduleId;
      this._log(jobId, "info", `iOS Farm: 任务已创建, scheduleId=${scheduleId}`);

      // 4. 轮询执行状态
      // prod-FARM-IOS-Core 的 schedule 创建后会立即 materialize 成 execution
      // 等待 execution 出现，然后轮询其状态
      let executionId = null;
      let attempts = 0;
      const maxWaitAttempts = 30; // 等待最多 60 秒
      while (attempts < maxWaitAttempts && !executionId) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        const executions = await this.iosFarm.listExecutions(udid, 10);
        // 优先用 scheduleId 精确匹配，避免误匹配其他任务
        let found = null;
        if (scheduleId) {
          found = executions.find(e => e.scheduleId === scheduleId);
        }
        // 如果没找到精确匹配，再找最近的 queued/running 任务
        if (!found) {
          found = executions.find(e => e.status === "queued" || e.status === "running");
        }
        if (found) executionId = found.id;
      }

      if (!executionId) {
        throw new Error("iOS Farm: 任务创建后未找到执行记录，可能设备离线或 worker 未运行");
      }

      this._log(jobId, "info", `iOS Farm: 执行开始, executionId=${executionId}`);

      // 轮询执行状态（最多等 10 分钟）
      const maxPollAttempts = 300; // 300 * 2s = 600s = 10min
      let pollAttempts = 0;
      let finalStatus = null;

      while (pollAttempts < maxPollAttempts) {
        await new Promise(r => setTimeout(r, 2000));
        pollAttempts++;
        const execution = await this.iosFarm.getExecution(executionId);
        finalStatus = execution;

        if (execution.status === "completed" || execution.status === "success") {
          // 发布成功
          this.persistence?.updateTkPublishJobStatus(jobId, {
            status: "success",
            publishedVideoId: execution.publishedVideoId || null,
            publishedVideoUrl: execution.publishedVideoUrl || null,
          });
          this._log(jobId, "info", `iOS Farm: 发布成功! executionId=${executionId}`);
          break;
        } else if (execution.status === "failed" || execution.status === "stopped") {
          throw new Error(`iOS Farm 任务${execution.status === "stopped" ? "被停止" : "失败"}: ${execution.error || "未知错误"}`);
        } else if (execution.status === "window-expired") {
          throw new Error("iOS Farm: 任务执行超时（窗口过期）");
        }
        // queued 或 running 继续等
        if (pollAttempts % 15 === 0) {
          this._log(jobId, "info", `iOS Farm: 等待中… (${pollAttempts * 2}s) 状态=${execution.status}`);
        }
      }

      if (!finalStatus || (finalStatus.status !== "completed" && finalStatus.status !== "success")) {
        // 超时后停止远端任务，防止 iPhone 继续执行但本地已判失败
        if (executionId) {
          try { await this.iosFarm.stopExecution(executionId); } catch {}
        }
        throw new Error("iOS Farm: 任务执行超时（等待超过 10 分钟）");
      }

      // iOS Farm 模式不抓播放量（iPhone 上的 TikTok App 无法像网页那样抓 DOM）
      this._log(jobId, "info", `iOS Farm: 发布完成（播放量需手动在 TikTok App 查看）`);

    } catch (error) {
      this.persistence?.updateTkPublishJobStatus(jobId, {
        status: "failed",
        errorMessage: error.message,
      });
      this._log(jobId, "error", `iOS Farm 发布失败: ${error.message}`);
      throw error;
    } finally {
      this.runningJobIds.delete(jobId);
      this.dispatchEvent(new CustomEvent("change"));
    }
  }

  _log(jobId, level, message) {
    if (this.persistence?.logCdpEvent) {
      this.persistence.logCdpEvent(null, level, `[发布任务:${jobId}] ${message}`, null, jobId);
    }
    if (level === "error") {
      console.error(`[TiktokPublishManager] [${jobId}] ${message}`);
    } else {
      console.log(`[TiktokPublishManager] [${jobId}] ${message}`);
    }
  }

  /**
   * 解析播放量文本为数字（如 "1.2K" → 1200, "3.5M" → 3500000）
   */
  _parseCount(text) {
    if (!text) return 0;
    const s = String(text).trim().replace(/[^\d.KMBkmb]/g, "");
    const match = s.match(/^([\d.]+)\s*([KMBkmb])?$/);
    if (!match) return parseInt(s) || 0;
    const num = parseFloat(match[1]);
    const suffix = (match[2] || "").toUpperCase();
    if (suffix === "K") return Math.round(num * 1000);
    if (suffix === "M") return Math.round(num * 1000000);
    if (suffix === "B") return Math.round(num * 1000000000);
    return Math.round(num);
  }
}
