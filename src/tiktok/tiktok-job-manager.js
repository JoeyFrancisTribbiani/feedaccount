import { BitBrowserApi } from "../bitbrowser-api.js";
import { TiktokSession } from "./tiktok-session.js";
import { tiktokVideoIdentity } from "./tiktok-selectors.js";

export const TIKTOK_DEFAULT_OPTIONS = Object.freeze({
  watchMinSec: 8,
  watchMaxSec: 25,
  maxVideos: 0,
  autoStopAtEnd: false,
  likeEnabled: false,
  likeProbability: 0,
  commentWatchEnabled: false,
  commentWatchProbability: 0,
  commentEnabled: false,
  commentProbability: 0,
  commentTexts: [],
});

function nowIso() {
  return new Date().toISOString();
}

function randomInteger(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error("随机数范围无效");
  }
  const { randomInt } = globalThis?.crypto ?? {};
  if (typeof randomInt === "function") return randomInt(min, max + 1);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class TiktokJobManager extends EventTarget {
  constructor({ bitBrowserApi, persistence = null } = {}) {
    super();
    this.bitBrowserApi = bitBrowserApi;
    this.persistence = persistence;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map((j) => this.#publicJob(j));
  }

  #publicJob(job) {
    return {
      profileId: job.profileId,
      profileName: job.profileName,
      status: job.status,
      statusText: job.statusText,
      videoCount: job.videoCount,
      likeCount: job.likeCount,
      commentCount: job.commentCount,
      currentVideo: job.currentVideo,
      options: { ...job.options },
      startedAt: job.startedAt,
      error: job.error,
      logs: [...job.events].slice(-50),
    };
  }

  #log(job, message, level = "info", eventType = "activity", data = {}) {
    job.events.push({ at: nowIso(), level, eventType, message, data });
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    this.persistence?.logTiktokEvent(job.runId, job.profileId, { at: nowIso(), level, eventType, message, data });
  }

  #setStatus(job, status, statusText) {
    job.status = status;
    job.statusText = statusText;
    this.persistence?.updateTiktokRun(job);
  }

  #emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.list() }));
  }

  async start(profileId, profileName, options = {}) {
    if (this.jobs.has(profileId)) throw new Error("该实例已有运行中的 TikTok 任务");
    const job = {
      profileId,
      profileName,
      options: { ...TIKTOK_DEFAULT_OPTIONS, ...options },
      runId: null,
      status: "connecting",
      statusText: "正在连接 TikTok",
      videoCount: 0,
      likeCount: 0,
      commentCount: 0,
      currentVideo: null,
      startedAt: nowIso(),
      events: [],
      cancelled: false,
      pauseRequested: false,
      session: null,
      error: null,
    };
    this.jobs.set(profileId, job);
    job.runId = this.persistence?.createTiktokRun({ id: profileId, name: profileName }, job.options, "https://www.tiktok.com/foryou") ?? null;
    this.#emit();
    this.#run(job).catch((e) => this.#fail(job, e));
    return this.#publicJob(job);
  }

  async #connectWithRetry(job) {
    while (!job.cancelled) {
      try {
        const conn = await this.bitBrowserApi.openProfile(job.profileId);
        if (job.cancelled) return null;
        job.session = new TiktokSession();
        const feed = await job.session.connect(conn.wsUrl);
        if (job.cancelled) { await job.session.close().catch(() => {}); job.session = null; return null; }
        return feed;
      } catch (e) {
        this.#log(job, `连接失败：${e.message}，10秒后重试`, "warning", "lifecycle");
        if (job.session) { await job.session.close().catch(() => {}); job.session = null; }
        this.#setStatus(job, "running", `连接重试中（${e.message}）`);
        this.#emit();
        await this.#sleep(job, 10000);
      }
    }
    return null;
  }

  async #run(job) {
    let feed = await this.#connectWithRetry(job);
    if (job.cancelled) {
      this.#setStatus(job, "stopped", "已停止");
      this.persistence?.finishTiktokRun(job.runId, "stopped", "已停止");
      this.#emit();
      return;
    }
    job.currentVideo = this.#videoSummary(feed);
    this.#setStatus(job, "running", "正在浏览 TikTok");
    this.#log(job, `已连接 TikTok，当前视频：${job.currentVideo.author}`, "info", "lifecycle");
    this.#emit();

    while (!job.cancelled) {
      if (job.pauseRequested) {
        this.#setStatus(job, "paused", "已暂停");
        this.#emit();
        while (job.pauseRequested && !job.cancelled) {
          await new Promise((r) => setTimeout(r, 400));
        }
        if (job.cancelled) break;
        this.#setStatus(job, "running", "正在浏览 TikTok");
        this.#emit();
      }

      try {
        const watchMs = randomInteger(job.options.watchMinSec, job.options.watchMaxSec) * 1000;
        this.#log(job, `停留 ${(watchMs / 1000).toFixed(1)} 秒`, "info", "watch", { watchMs });
        await this.#sleep(job, watchMs);
        if (job.cancelled) break;

        if (job.options.likeEnabled) {
          await this.#tryLike(job);
          if (job.cancelled) break;
        }

        if (job.options.commentWatchEnabled) {
          await this.#tryCommentWatch(job);
          if (job.cancelled) break;
        }

        if (job.options.commentEnabled && Array.isArray(job.options.commentTexts) && job.options.commentTexts.length) {
          await this.#tryPostComment(job);
          if (job.cancelled) break;
        }

        if (job.options.maxVideos > 0 && job.videoCount >= job.options.maxVideos) {
          this.#log(job, `已达到设定的视频数 ${job.options.maxVideos}`, "info", "lifecycle");
          break;
        }

        try {
          const adv = await job.session.advanceVideo();
          if (job.cancelled) break;
          if (adv.switched) {
            job.videoCount += 1;
            job.currentVideo = this.#videoSummary(adv.feed);
            this.#log(job, `切换到下一个视频：${job.currentVideo.author}（第 ${job.videoCount + 1} 个）`, "info", "advance", { identity: adv.after });
            this.#emit();
          } else {
            this.#log(job, "未能切换到下一个视频，稍后重试", "warning", "advance");
            await this.#sleep(job, 1500);
          }
        } catch (e) {
          this.#log(job, `切换视频失败：${e.message}，5秒后重试`, "warning", "advance_error");
          await this.#sleep(job, 5000);
        }
      } catch (e) {
        this.#log(job, `操作异常：${e.message}，10秒后重试`, "warning", "lifecycle");
        this.#emit();
        await this.#sleep(job, 10000);
        if (job.cancelled) break;

        try {
          if (job.session) await job.session.readFeed();
        } catch {
          this.#log(job, "会话可能已断开，尝试重新连接", "warning", "lifecycle");
          if (job.session) { await job.session.close().catch(() => {}); job.session = null; }
          const reFeed = await this.#connectWithRetry(job);
          if (job.cancelled) break;
          if (reFeed) {
            job.currentVideo = this.#videoSummary(reFeed);
            this.#setStatus(job, "running", "正在浏览 TikTok");
            this.#log(job, `重新连接成功，当前视频：${job.currentVideo.author}`, "info", "lifecycle");
            this.#emit();
          }
        }
      }
    }

    if (job.cancelled) {
      this.#setStatus(job, "stopped", "已停止");
      this.persistence?.finishTiktokRun(job.runId, "stopped", "已停止");
    } else {
      this.#setStatus(job, "completed", "任务已完成");
      this.persistence?.finishTiktokRun(job.runId, "completed", "任务已完成");
    }
    if (job.session) { await job.session.close().catch(() => {}); job.session = null; }
    this.#emit();
  }

  async #tryLike(job) {
    const id = tiktokVideoIdentity(job.currentVideo ? { current: job.currentVideo } : null);
    if (!id) return;
    const roll = randomInteger(0, 99);
    if (roll >= job.options.likeProbability) {
      this.#log(job, `点赞概率未命中（${roll + 1}% >= ${job.options.likeProbability}%）`, "info", "like_skipped", { roll: roll + 1, threshold: job.options.likeProbability });
      return;
    }
    this.#log(job, `点赞概率命中（${roll + 1}% < ${job.options.likeProbability}%），准备点赞`, "info", "like_attempt", { roll: roll + 1, threshold: job.options.likeProbability });
    try {
      const result = await job.session.likeCurrentVideo();
      if (result.ok) {
        job.likeCount += 1;
        this.#log(job, result.alreadyLiked ? "当前视频已是点赞状态" : "已点赞当前视频", "info", "like", { id: result.id });
      } else {
        this.#log(job, "点赞未成功", "warning", "like_failed", { id: result.id });
      }
    } catch (e) {
      this.#log(job, `点赞出错：${e.message}`, "warning", "like_error", { error: e.message });
    }
  }

  async #tryCommentWatch(job) {
    const roll = randomInteger(0, 99);
    if (roll >= job.options.commentWatchProbability) {
      this.#log(job, `看评论概率未命中（${roll + 1}% >= ${job.options.commentWatchProbability}%）`, "info", "comment_watch_skipped", { roll: roll + 1, threshold: job.options.commentWatchProbability });
      return;
    }
    this.#log(job, `看评论概率命中（${roll + 1}% < ${job.options.commentWatchProbability}%），打开评论区`, "info", "comment_watch_attempt", { roll: roll + 1, threshold: job.options.commentWatchProbability });
    try {
      await job.session.openComments();
      const steps = randomInteger(2, 5);
      await job.session.scrollComments(steps);
      this.#log(job, `浏览了 ${steps} 屏评论`, "info", "comment_watch", { steps });
      await job.session.closeComments();
      this.#log(job, "已关闭评论区，返回 For You", "info", "comment_watch_close");
    } catch (e) {
      this.#log(job, `看评论出错：${e.message}`, "warning", "comment_watch_error", { error: e.message });
      try { await job.session.closeComments(); } catch {}
    }
  }

  async #tryPostComment(job) {
    const roll = randomInteger(0, 99);
    if (roll >= job.options.commentProbability) {
      this.#log(job, `发评论概率未命中（${roll + 1}% >= ${job.options.commentProbability}%）`, "info", "comment_skipped", { roll: roll + 1, threshold: job.options.commentProbability });
      return;
    }
    const text = job.options.commentTexts[randomInteger(0, job.options.commentTexts.length - 1)];
    this.#log(job, `发评论概率命中，准备发表评论`, "info", "comment_attempt", { roll: roll + 1, threshold: job.options.commentProbability });
    try {
      await job.session.openComments();
      const result = await job.session.postComment(text);
      if (result.ok) {
        job.commentCount += 1;
        this.#log(job, "已发表评论", "info", "comment", { text });
      }
      await job.session.closeComments();
    } catch (e) {
      this.#log(job, `发评论出错：${e.message}`, "warning", "comment_error", { error: e.message });
      try { await job.session.closeComments(); } catch {}
    }
  }

  #videoSummary(feed) {
    if (!feed?.current) return null;
    return {
      author: feed.current.author,
      desc: feed.current.desc,
      likeCount: feed.current.likeCount,
      liked: feed.current.liked,
    };
  }

  async #sleep(job, ms) {
    const step = 300;
    let remaining = ms;
    while (remaining > 0 && !job.cancelled) {
      const w = Math.min(step, remaining);
      await new Promise((r) => setTimeout(r, w));
      remaining -= w;
    }
  }

  async #fail(job, error) {
    job.error = error.message;
    this.#setStatus(job, "error", `任务出错：${error.message}`);
    this.persistence?.finishTiktokRun(job.runId, "error", `任务出错：${error.message}`);
    this.#log(job, `任务出错：${error.message}`, "error", "lifecycle", { error: error.message });
    if (job.session) { await job.session.close().catch(() => {}); job.session = null; }
    this.#emit();
  }

  pause(profileId) {
    const job = this.jobs.get(profileId);
    if (!job) throw new Error("未找到该实例的 TikTok 任务");
    if (job.status !== "running") throw new Error("只有运行中的任务可以暂停");
    job.pauseRequested = true;
    this.#log(job, "已请求暂停", "info", "control");
    return this.#publicJob(job);
  }

  resume(profileId) {
    const job = this.jobs.get(profileId);
    if (!job) throw new Error("未找到该实例的 TikTok 任务");
    if (job.status !== "paused") throw new Error("只有暂停中的任务可以继续");
    job.pauseRequested = false;
    this.#log(job, "已继续", "info", "control");
    return this.#publicJob(job);
  }

  async stop(profileId, reason = "已由用户停止") {
    const job = this.jobs.get(profileId);
    if (!job) throw new Error("未找到该实例的 TikTok 任务");
    job.cancelled = true;
    job.pauseRequested = false;
    this.#log(job, reason, "info", "control");
    if (job.session) { await job.session.close().catch(() => {}); }
    return this.#publicJob(job);
  }

  async stopAll() {
    for (const id of this.jobs.keys()) {
      await this.stop(id).catch(() => {});
    }
  }
}
