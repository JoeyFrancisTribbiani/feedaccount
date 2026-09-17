import { TiktokPublisher } from "./tiktok-publisher.js";

export class TiktokPublishManager extends EventTarget {
  constructor({ bitBrowserApi, persistence = null } = {}) {
    super();
    this.bitBrowserApi = bitBrowserApi;
    this.persistence = persistence;
    this.timer = null;
    this.runningJobIds = new Set();
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
    
    for (const job of pendingJobs) {
      if (job.scheduledAt <= nowIso && !this.runningJobIds.has(job.id)) {
        this.executeJob(job.id).catch((err) => {
          console.error(`[TiktokPublishManager] 任务 ${job.id} 执行失败:`, err);
        });
      }
    }
  }

  async executeJob(jobId) {
    if (this.runningJobIds.has(jobId)) throw new Error("该任务正在执行中");
    const job = this.persistence?.getTkPublishJob(jobId);
    if (!job) throw new Error("未找到指定的发布任务");

    this.runningJobIds.add(jobId);
    this.persistence?.updateTkPublishJobStatus(jobId, { status: "running", executedAt: new Date().toISOString() });
    this._log(jobId, "info", `发布任务开始: profile=${job.profileId}, title=${job.materialTitle?.substring(0, 50) || "—"}`);
    this.dispatchEvent(new CustomEvent("change"));

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
      this._log(jobId, "info", `开始上传视频: ${job.materialFilePath?.substring(0, 80) || "—"}`);
      const result = await publisher.uploadVideo({
        filePath: job.materialFilePath,
        title: job.materialTitle,
        hashtags: job.materialHashtags,
        privacyLevel: job.materialPrivacy
      });

      // 获取用户名（用于发布后记录播放量）
      let username = null;
      if (this.persistence) {
        // 通过 publish_job_id 找 pipeline → creator → creator name
        const pipeline = this.persistence.db.prepare("SELECT creator_id FROM auto_remix_publish_pipeline WHERE publish_job_id = ?").get(jobId);
        if (pipeline) {
          const creator = this.persistence.db.prepare("SELECT name FROM remix_creators WHERE id = ?").get(pipeline.creator_id);
          if (creator) {
            username = creator.name.replace(/^@/, "");
          }
        }
      }

      if (result.ok || (result.message && result.message.includes("已提交发布"))) {
        this.persistence?.updateTkPublishJobStatus(jobId, {
          status: "success",
          publishedVideoId: result.publishedVideoId || null,
          publishedVideoUrl: result.publishedVideoUrl || null
        });
        this._log(jobId, "info", `发布成功! videoId=${result.publishedVideoId || "—"}, url=${result.publishedVideoUrl || "—"}`);

        // 发布成功后，去账号主页记录播放量
        try {
          this._log(jobId, "info", `正在访问账号主页记录播放量…`);
          const analyticsResult = await publisher.recordAnalytics(username);
          this._log(jobId, "info", `播放量记录完成: ${analyticsResult.videoCount} 个视频`);

          // 存入 tk_video_analytics 表
          if (analyticsResult.videos?.length && this.persistence) {
            const nowIso = new Date().toISOString();
            const insertStmt = this.persistence.db.prepare(
              `INSERT INTO tk_video_analytics (publish_job_id, views_count, likes_count, comments_count, shares_count, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            );
            // 记录当前发布的视频的数据
            for (const v of analyticsResult.videos) {
              const views = this._parseCount(v.views);
              const likes = this._parseCount(v.likes);
              insertStmt.run(jobId, views, likes, 0, 0, nowIso);
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
