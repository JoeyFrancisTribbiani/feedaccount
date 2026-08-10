import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

import { BrowserSession } from "./browser-session.js";
import { TARGET_URL, publicOptions, randomInteger } from "./config.js";
import { generateAiComment } from "./ai-comment-generator.js";
import { initCorpus, pickCommentFromCorpus } from "./comment-corpus.js";

export const ACTIVE_JOB_STATES = new Set([
  "connecting",
  "scrolling",
  "waiting",
  "pausing",
  "paused",
  "stopping",
]);

const MAX_LOG_ENTRIES = 80;
const ALIGNMENT_RETRY_MIN_MS = 200;
const ALIGNMENT_RETRY_MAX_MS = 500;
const MAX_CONSECUTIVE_ALIGNMENT_RETRIES = 12;
const MAX_COMMENT_NO_PROGRESS_RETRIES = 3;
const DEFAULT_COMMENT_STEP_WAIT_MIN_MS = 700;
const DEFAULT_COMMENT_STEP_WAIT_MAX_MS = 1_600;
const MANUAL_COMMENT_PHASES = new Set(["comment_scrolling", "return_wait"]);

function nowIso() {
  return new Date().toISOString();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function redditCommentToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    if (commentsIndex >= 0 && segments.length > commentsIndex + 3) {
      return segments.at(-1).replace(/^t1_/i, "").toLowerCase();
    }
  } catch {
    // Normal Reddit thing IDs are not URLs.
  }
  return raw.replace(/^t1_/i, "").toLowerCase();
}

function commentIdentity(comment) {
  if (!comment) return "";
  const candidates = [
    comment.canonicalCommentId,
    comment.commentId,
    ...(Array.isArray(comment.commentIdAliases) ? comment.commentIdAliases : []),
  ];
  return candidates.map(redditCommentToken).find(Boolean) || "";
}

function commentMatchesIdentifier(comment, value) {
  if (!comment || !value) return false;
  const raw = String(value);
  const aliases = [
    comment.commentId,
    comment.canonicalCommentId,
    ...(Array.isArray(comment.commentIdAliases) ? comment.commentIdAliases : []),
  ].filter(Boolean).map(String);
  if (aliases.includes(raw)) return true;
  const token = redditCommentToken(raw);
  return Boolean(token) && aliases.some((alias) => redditCommentToken(alias) === token);
}

export class JobManager extends EventEmitter {
  constructor({ bitBrowserApi, sessionFactory, randomIntegerFn, persistence } = {}) {
    super();
    this.bitBrowserApi = bitBrowserApi;
    this.sessionFactory = sessionFactory || (() => new BrowserSession());
    this.randomInteger = randomIntegerFn || randomInteger;
    this.persistence = persistence || null;
    this.jobs = new Map();
    this.corpusCount = initCorpus(
      path.resolve(THIS_DIR, "..", "data", "reddit-comment-corpus.json"),
    );
  }

  start(profile, options) {
    const existing = this.jobs.get(profile.id);
    if (existing && ACTIVE_JOB_STATES.has(existing.status)) {
      throw new Error(`实例 ${profile.seq ?? profile.id} 已在运行`);
    }

    const startedAt = nowIso();

    const account = this.persistence?.getRedditAccountByProfileId?.(profile.id);
    const effectiveOptions = { ...options };
    let accountActionTargets = null;

    if (account && Array.isArray(account.enabledActions) && account.enabledActions.length > 0) {
      const actions = new Set(account.enabledActions);
      const configs = account.actionConfigs || {};
      effectiveOptions.autoUpvoteEnabled = actions.has("w1_feed_upvote");
      effectiveOptions.autoCommentUpvoteEnabled = actions.has("w1_comment_upvote");
      effectiveOptions.autoJoinEnabled = actions.has("w1_join_subreddit");
      effectiveOptions.autoCommentEnabled = actions.has("w2_post_comment");
      if (configs.w2_post_comment?.texts) {
        effectiveOptions.autoCommentTexts = configs.w2_post_comment.texts.split("\n").map((t) => t.trim()).filter(Boolean);
      }
      if (configs.w2_post_comment?.useAI) {
        effectiveOptions._useAiComment = true;
        const aiConfig = this.persistence?.getAiCommentConfig?.();
        if (aiConfig && aiConfig.apiKey) {
          effectiveOptions._aiCommentConfig = aiConfig;
        } else {
          console.warn("[job-manager] AI 评论已启用但 API Key 未配置，将回退到语料库/文本库");
        }
      }
      if (configs.w2_multi_comment?.dailyMax != null) {
        const dm = Number(configs.w2_multi_comment.dailyMax);
        if (Number.isFinite(dm) && dm > 0) {
          effectiveOptions.autoCommentMaxPerRun = dm;
        }
      }
      if (configs.w2_check_post_age?.minHours) {
        effectiveOptions._autoCommentMinPostAgeHours = Number(configs.w2_check_post_age.minHours);
      }
      if (configs.w2_check_author?.minKarma) {
        effectiveOptions._autoCommentMinAuthorKarma = Number(configs.w2_check_author.minKarma);
      }
      if (configs.w1_join_subreddit?.targets) {
        accountActionTargets = configs.w1_join_subreddit.targets
          .split(/[\n\r,;\t]+/)
          .map((t) => t.trim().replace(/^\/?r\//i, "").replace(/\/.*$/, "").trim())
          .filter(Boolean)
          .map((name) => ({ name }));
      }
      if (configs.w3_narrative_post?.templates) {
        effectiveOptions._autoPostTemplates = configs.w3_narrative_post.templates.split("\n").map((t) => t.trim()).filter(Boolean);
      }
      if (configs.w3_image_post?.imageDir) {
        effectiveOptions._autoPostImageDir = configs.w3_image_post.imageDir;
      }
    }

    const detailLoopEnabled = effectiveOptions.detailLoopEnabled === true;
    const runId = this.persistence?.createRun(profile, effectiveOptions, TARGET_URL, startedAt) ?? null;
    const job = {
      runId,
      profileId: profile.id,
      seq: profile.seq,
      name: profile.name,
      status: "connecting",
      statusText: "正在连接",
      options: effectiveOptions,
      startedAt,
      updatedAt: startedAt,
      stoppedAt: null,
      nextActionAt: null,
      nextOperation: "feed-scroll",
      scheduledDeadlineMs: null,
      scheduledStatus: null,
      scheduledStatusText: null,
      pausedRemainingMs: null,
      postCount: 0,
      fullPostCount: 0,
      totalPixels: 0,
      lastScrollPixels: 0,
      currentY: 0,
      maxY: 0,
      currentPost: null,
      currentPostComplete: true,
      alignmentPending: false,
      alignmentRetryCount: 0,
      alignmentRetryPostId: null,
      alignmentReason: null,
      alignmentResidualPx: null,
      alignmentAttempts: 0,
      countedPostIds: new Set(),
      fullPostIds: new Set(),
      countedFeedUnitIds: new Set(),
      skippedPromotedIds: new Set(),
      pageTitle: "",
      pageUrl: "",
      workflowMode: detailLoopEnabled ? "feed_detail_readonly" : "feed_only",
      workflowPhase: "connecting",
      feedPostsSinceDetail: 0,
      feedPostsTarget: detailLoopEnabled ? this.#drawFeedTarget(effectiveOptions) : 0,
      detailVisitCount: 0,
      commentScrollCount: 0,
      commentScrollProgress: 0,
      commentScrollTarget: 0,
      commentNoProgressCount: 0,
      skippedPromotedCount: 0,
      currentDetailPost: null,
      currentComment: null,
      manualCommentActionPending: false,
      manualCommentUpvoteState: "unknown",
      manualCommentUpvoteBlockedReason: null,
      lastManualCommentUpvote: null,
      error: null,
      persistenceError: null,
      logs: [],
      timer: null,
      session: null,
      cancelled: false,
      pauseRequested: false,
      manualActionPending: false,
      currentPostUpvoted: null,
      manualUpvoteState: "unknown",
      manualUpvoteBlockedReason: null,
      lastManualUpvote: null,
      upvotedPostIds: new Set(),
      upvotedCommentIds: new Set(),
      autoUpvoteCount: 0,
      autoCommentUpvoteCount: 0,
      joinedSubredditIds: new Set(),
      autoJoinCount: 0,
      lastJoinAt: 0,
      nextJoinDelay: 0,
      joinTargets: [],
      joinTargetIndex: 0,
      autoCommentCount: 0,
      postedCommentPostIds: new Set(),
      lastCommentAt: 0,
      nextCommentDelay: 0,
    };

    this.jobs.set(profile.id, job);

    if (this.persistence?.getUpvotedIdsForProfile) {
      try {
        const previous = this.persistence.getUpvotedIdsForProfile(profile.id);
        if (previous?.postIds instanceof Set && previous.postIds.size > 0) {
          for (const id of previous.postIds) job.upvotedPostIds.add(id);
          this.#log(
            job,
            `从历史记录恢复了 ${job.upvotedPostIds.size} 个已点赞帖子的幂等记录`,
            "info",
            "upvote_restore",
          );
        }
        if (previous?.commentIds instanceof Set && previous.commentIds.size > 0) {
          for (const id of previous.commentIds) job.upvotedCommentIds.add(id);
          this.#log(
            job,
            `从历史记录恢复了 ${job.upvotedCommentIds.size} 个已点赞评论的幂等记录`,
            "info",
            "upvote_restore",
          );
        }
      } catch (restoreError) {
        this.#log(job, `恢复历史点赞记录失败：${restoreError.message}`, "warning", "upvote_restore");
      }
    }

    if (job.options.autoJoinEnabled) {
      try {
        if (accountActionTargets && accountActionTargets.length > 0) {
          job.joinTargets = accountActionTargets;
          this.#log(job, `已加载账号配置的 ${job.joinTargets.length} 个目标群组`, "info", "join_targets_loaded", { count: job.joinTargets.length, source: "account_config" });
        } else {
          job.joinTargets = this.persistence?.getJoinTargets?.() || [];
          if (job.joinTargets.length > 0) {
            this.#log(job, `已加载 ${job.joinTargets.length} 个预配置群组`, "info", "join_targets_loaded", { count: job.joinTargets.length, source: "global" });
          }
        }
      } catch (e) {
        this.#log(job, `加载群组列表失败：${e.message}`, "warning", "join_targets_load_error");
      }
      if (this.persistence?.getJoinedSubredditsForProfile) {
        try {
          const previouslyJoined = this.persistence.getJoinedSubredditsForProfile(profile.id);
          if (previouslyJoined.size > 0) {
            for (const name of previouslyJoined) job.joinedSubredditIds.add(name);
            this.#log(job, `从历史记录恢复了 ${job.joinedSubredditIds.size} 个已关注群组的幂等记录`, "info", "join_restore");
          }
        } catch (e) {
          this.#log(job, `恢复历史关注记录失败：${e.message}`, "warning", "join_restore");
        }
      }
    }

    this.#log(job, "正在连接指定的 BitBrowser 实例", "info", "lifecycle");
    if (account && Array.isArray(account.enabledActions) && account.enabledActions.length > 0) {
      const enabledList = account.enabledActions.join(", ");
      this.#log(job, `已加载养号操作项配置（${enabledList}），已覆盖任务参数开关`, "info", "nurture_actions_loaded", {
        enabledActions: account.enabledActions,
        effectiveUpvote: effectiveOptions.autoUpvoteEnabled,
        effectiveCommentUpvote: effectiveOptions.autoCommentUpvoteEnabled,
        effectiveJoin: effectiveOptions.autoJoinEnabled,
        effectiveComment: effectiveOptions.autoCommentEnabled,
      });
    }
    if (detailLoopEnabled) {
      this.#log(
        job,
        `本轮将在向下阅读 ${job.feedPostsTarget} 个 Feed 单元后查看普通帖子详情`,
        "info",
        "detail_cycle_planned",
        { feedPostsTarget: job.feedPostsTarget, readonly: true },
      );
    }
    void this.#run(job);
    return this.#publicJob(job);
  }

  async pause(profileId) {
    const job = this.#requiredJob(profileId);
    if (!ACTIVE_JOB_STATES.has(job.status) || job.status === "stopping") {
      throw new Error("该任务当前不能暂停");
    }
    if (job.status === "paused" || job.status === "pausing") return this.#publicJob(job);

    job.pauseRequested = true;
    if (job.timer) {
      job.pausedRemainingMs = Math.max(0, (job.scheduledDeadlineMs || Date.now()) - Date.now());
      clearTimeout(job.timer);
      job.timer = null;
      this.#log(job, "收到前端暂停请求", "info", "control");
      this.#enterPaused(job);
    } else {
      this.#log(job, "收到前端暂停请求", "info", "control");
      this.#setStatus(job, "pausing", "等待当前只读操作完成");
    }
    return this.#publicJob(job);
  }

  resume(profileId) {
    const job = this.#requiredJob(profileId);
    if (job.manualActionPending || job.manualCommentActionPending) {
      throw new Error("正在处理人工确认点赞，请稍候");
    }
    if (job.status !== "paused") throw new Error("该任务当前不处于暂停状态");

    job.pauseRequested = false;
    this.#log(job, "收到前端继续请求", "info", "control");
    if (job.pausedRemainingMs !== null) {
      const delayMs = job.pausedRemainingMs;
      job.pausedRemainingMs = null;
      this.#schedule(job, job.nextOperation, delayMs, {
        status: job.scheduledStatus || "waiting",
        statusText: job.scheduledStatusText || this.#waitingStatusText(job),
      });
    } else {
      void this.#dispatch(job);
    }
    return this.#publicJob(job);
  }

  triggerNow(profileId) {
    const job = this.#requiredJob(profileId);
    if (job.manualActionPending || job.manualCommentActionPending) {
      throw new Error("正在处理人工确认点赞，请稍候");
    }
    if (job.status !== "waiting") throw new Error("只有等待中的任务可以立即继续");

    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    job.pausedRemainingMs = null;
    job.scheduledDeadlineMs = null;
    job.nextActionAt = null;
    this.#log(job, "收到前端立即继续请求", "info", "control", {
      operation: job.nextOperation,
      workflowPhase: job.workflowPhase,
    });
    void this.#dispatch(job);
    return this.#publicJob(job);
  }

  async manualUpvote(profileId, expectedPostId) {
    const job = this.#requiredJob(profileId);
    const normalizedPostId = String(expectedPostId || "").trim();

    if (job.manualActionPending || job.manualCommentActionPending) {
      throw new Error("正在处理人工确认点赞，请勿重复提交");
    }
    if (job.status !== "waiting" || job.workflowPhase !== "feed_wait") {
      throw new Error("只能在 Feed 当前帖子阅读等待期间确认点赞");
    }
    if (!job.session || typeof job.session.manualUpvoteCurrentPost !== "function") {
      throw new Error("当前浏览器会话不支持手动点赞");
    }
    if (!normalizedPostId) throw new Error("缺少待确认的帖子 ID");
    if (!job.currentPost?.postId || String(job.currentPost.postId) !== normalizedPostId) {
      throw new Error("当前帖子已变化，请刷新监控页后重新确认");
    }
    if (this.#isPromoted(job.currentPost)) throw new Error("广告帖禁止点赞");
    if (job.currentPost.clickEligible === false) throw new Error("当前帖子不可安全操作");
    if (job.manualUpvoteState === "upvoted") throw new Error("当前帖子已是点赞状态");
    if (job.manualUpvoteState === "attempted-unknown") {
      throw new Error(job.manualUpvoteBlockedReason || "此前的点赞结果无法确认，为避免取消点赞已禁止重试");
    }
    if (!job.timer || !Number.isFinite(job.scheduledDeadlineMs)) {
      throw new Error("当前帖子等待计时已结束，请稍后重试");
    }

    const frozenSchedule = {
      operation: job.nextOperation,
      remainingMs: Math.max(0, job.scheduledDeadlineMs - Date.now()),
      status: job.scheduledStatus || "waiting",
      statusText: job.scheduledStatusText || this.#waitingStatusText(job),
    };
    clearTimeout(job.timer);
    job.timer = null;
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;
    job.manualActionPending = true;
    this.#setStatus(job, "waiting", "正在确认当前帖子点赞");
    this.#log(job, `已收到当前帖“${job.currentPost.title || normalizedPostId}”的确认点赞`, "info", "manual_upvote_requested", {
      postId: normalizedPostId,
      postTitle: job.currentPost.title || null,
      workflowPhase: job.workflowPhase,
      nextOperation: frozenSchedule.operation,
      remainingDelayMs: frozenSchedule.remainingMs,
      manual: true,
    });

    let result = null;
    let failure = null;
    try {
      result = await job.session.manualUpvoteCurrentPost({
        expectedPostId: normalizedPostId,
      });
      if (job.cancelled) throw new Error("任务已停止，手动点赞未完成");
      if (!result?.ok) throw new Error(result?.reason || "未能确认点赞结果");
      if (String(result.postId || "") !== normalizedPostId) {
        throw new Error("浏览器中的帖子已变化，未执行点赞");
      }

      job.currentPostUpvoted = Boolean(
        result.alreadyUpvoted || result.changed || result.afterState === "upvoted",
      );
      job.manualUpvoteState = job.currentPostUpvoted ? "upvoted" : "unknown";
      job.manualUpvoteBlockedReason = null;
      job.lastManualUpvote = {
        at: nowIso(),
        postId: normalizedPostId,
        changed: Boolean(result.changed),
        alreadyUpvoted: Boolean(result.alreadyUpvoted),
        beforeState: result.beforeState ?? null,
        afterState: result.afterState ?? null,
      };
      this.#log(
        job,
        result.alreadyUpvoted
          ? `当前帖“${job.currentPost.title || normalizedPostId}”已是点赞状态，未重复点击`
          : `已手动点赞当前帖“${job.currentPost.title || normalizedPostId}”`,
        "info",
        result.alreadyUpvoted ? "manual_upvote_skipped" : "manual_upvote_succeeded",
        { ...job.lastManualUpvote, manual: true },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (
        result?.uncertain === true ||
        ["already-attempted", "upvote-already-attempted"].includes(result?.reason)
      ) {
        job.manualUpvoteState = "attempted-unknown";
        job.manualUpvoteBlockedReason =
          "点赞点击可能已经生效，但页面未能确认；为避免再次点击取消点赞，本帖已锁定";
        job.lastManualUpvote = {
          at: nowIso(),
          postId: normalizedPostId,
          changed: false,
          alreadyUpvoted: false,
          beforeState: result?.beforeState ?? null,
          afterState: result?.afterState ?? null,
          uncertain: true,
          error: failure.message,
        };
      }
      if (!job.cancelled) {
        this.#log(
          job,
          `手动点赞未完成：${failure.message}`,
          "error",
          "manual_upvote_failed",
          {
            postId: normalizedPostId,
            postTitle: job.currentPost?.title || null,
            manual: true,
            reason: result?.reason || "session-error",
            beforeState: result?.beforeState ?? null,
            afterState: result?.afterState ?? null,
            uncertain: Boolean(result?.uncertain),
            error: failure.message,
          },
        );
      }
    } finally {
      job.manualActionPending = false;
      job.nextOperation = frozenSchedule.operation;
      job.scheduledStatus = frozenSchedule.status;
      job.scheduledStatusText = frozenSchedule.statusText;

      if (job.cancelled || !ACTIVE_JOB_STATES.has(job.status)) {
        this.#setStatus(job, job.status, job.statusText);
      } else if (job.pauseRequested) {
        job.pausedRemainingMs = frozenSchedule.remainingMs;
        this.#enterPaused(job);
      } else {
        job.pausedRemainingMs = null;
        this.#schedule(job, frozenSchedule.operation, frozenSchedule.remainingMs, {
          status: frozenSchedule.status,
          statusText: frozenSchedule.statusText,
        });
      }
    }

    if (failure) throw failure;
    return result;
  }

  async manualCommentUpvote(profileId, expectedCommentId) {
    const job = this.#requiredJob(profileId);
    const normalizedCommentId = String(expectedCommentId || "").trim();
    const startedPaused = job.status === "paused";
    const allowedState =
      MANUAL_COMMENT_PHASES.has(job.workflowPhase) &&
      (job.status === "waiting" || startedPaused);

    if (job.manualActionPending || job.manualCommentActionPending) {
      throw new Error("正在处理人工确认点赞，请勿重复提交");
    }
    if (!allowedState) {
      throw new Error("只能在评论阅读等待或评论区暂停期间确认点赞");
    }
    if (!job.session || typeof job.session.manualUpvoteCurrentComment !== "function") {
      throw new Error("当前浏览器会话不支持评论确认点赞");
    }
    if (!normalizedCommentId) throw new Error("缺少待确认的评论 ID");
    if (!job.currentComment?.commentId || !commentMatchesIdentifier(job.currentComment, normalizedCommentId)) {
      throw new Error("当前评论已变化，请等待监控页更新后重新确认");
    }
    if (job.manualCommentUpvoteState === "upvoted") {
      throw new Error("当前评论已是点赞状态");
    }
    if (job.manualCommentUpvoteState === "attempted-unknown") {
      throw new Error(
        job.manualCommentUpvoteBlockedReason ||
          "此前的评论点赞结果无法确认，为避免取消点赞已禁止重试",
      );
    }
    if (
      !startedPaused &&
      (!job.timer || !Number.isFinite(job.scheduledDeadlineMs))
    ) {
      throw new Error("当前评论等待计时已结束，请稍后重试");
    }

    const frozenSchedule = {
      operation: job.nextOperation,
      remainingMs: startedPaused
        ? job.pausedRemainingMs
        : Math.max(0, job.scheduledDeadlineMs - Date.now()),
      status: job.scheduledStatus || "waiting",
      statusText: job.scheduledStatusText || this.#waitingStatusText(job),
    };
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;
    job.manualCommentActionPending = true;
    this.#setStatus(
      job,
      startedPaused ? "paused" : "waiting",
      "正在确认当前评论点赞",
    );
    this.#log(job, "已收到当前可见评论的确认点赞", "info", "manual_comment_upvote_requested", {
      commentId: normalizedCommentId,
      workflowPhase: job.workflowPhase,
      nextOperation: frozenSchedule.operation,
      remainingDelayMs: frozenSchedule.remainingMs,
      startedPaused,
      manual: true,
    });

    let result = null;
    let failure = null;
    try {
      result = await job.session.manualUpvoteCurrentComment({
        expectedCommentId: normalizedCommentId,
      });
      if (job.cancelled) throw new Error("任务已停止，评论点赞未完成");
      if (!result?.ok) throw new Error(result?.reason || "未能确认评论点赞结果");
      if (!result?.commentId || !commentMatchesIdentifier(job.currentComment, result.commentId)) {
        throw new Error("浏览器中的当前评论已变化，未执行点赞");
      }
      result = { ...result, commentId: normalizedCommentId };

      const upvoted = Boolean(
        result.alreadyUpvoted || result.changed || result.afterState === "upvoted",
      );
      job.manualCommentUpvoteState = upvoted ? "upvoted" : "unknown";
      job.manualCommentUpvoteBlockedReason = null;
      job.lastManualCommentUpvote = {
        at: nowIso(),
        commentId: normalizedCommentId,
        changed: Boolean(result.changed),
        alreadyUpvoted: Boolean(result.alreadyUpvoted),
        beforeState: result.beforeState ?? null,
        afterState: result.afterState ?? null,
      };
      this.#log(
        job,
        result.alreadyUpvoted
          ? "当前评论已是点赞状态，未重复点击"
          : "已手动点赞当前评论",
        "info",
        result.alreadyUpvoted
          ? "manual_comment_upvote_skipped"
          : "manual_comment_upvote_succeeded",
        { ...job.lastManualCommentUpvote, manual: true },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (
        result?.uncertain === true ||
        String(result?.reason || "").includes("already-attempted")
      ) {
        job.manualCommentUpvoteState = "attempted-unknown";
        job.manualCommentUpvoteBlockedReason =
          "评论点赞点击可能已经生效，但页面未能确认；为避免再次点击取消点赞，本评论已锁定";
        job.lastManualCommentUpvote = {
          at: nowIso(),
          commentId: normalizedCommentId,
          changed: false,
          alreadyUpvoted: false,
          beforeState: result?.beforeState ?? null,
          afterState: result?.afterState ?? null,
          uncertain: true,
          error: failure.message,
        };
      }
      if (!job.cancelled) {
        this.#log(
          job,
          `评论确认点赞未完成：${failure.message}`,
          "error",
          "manual_comment_upvote_failed",
          {
            commentId: normalizedCommentId,
            manual: true,
            reason: result?.reason || "session-error",
            beforeState: result?.beforeState ?? null,
            afterState: result?.afterState ?? null,
            uncertain: Boolean(result?.uncertain),
            error: failure.message,
          },
        );
      }
    } finally {
      job.manualCommentActionPending = false;
      job.nextOperation = frozenSchedule.operation;
      job.scheduledStatus = frozenSchedule.status;
      job.scheduledStatusText = frozenSchedule.statusText;

      if (job.cancelled || !ACTIVE_JOB_STATES.has(job.status)) {
        this.#setStatus(job, job.status, job.statusText);
      } else if (startedPaused) {
        job.pausedRemainingMs = frozenSchedule.remainingMs;
        this.#setStatus(job, "paused", "已暂停");
      } else if (job.pauseRequested) {
        job.pausedRemainingMs = frozenSchedule.remainingMs;
        this.#enterPaused(job);
      } else {
        job.pausedRemainingMs = null;
        this.#schedule(job, frozenSchedule.operation, frozenSchedule.remainingMs, {
          status: frozenSchedule.status,
          statusText: frozenSchedule.statusText,
        });
      }
    }

    if (failure) throw failure;
    return result;
  }

  async stop(profileId, reason = "已由用户停止") {
    const job = this.#requiredJob(profileId);
    if (!ACTIVE_JOB_STATES.has(job.status)) return this.#publicJob(job);

    job.cancelled = true;
    job.pauseRequested = false;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    job.pausedRemainingMs = null;
    job.scheduledDeadlineMs = null;
    this.#setStatus(job, "stopping", "正在停止");
    this.#log(job, reason, "info", "control");
    await job.session?.close().catch(() => {});
    job.session = null;
    job.nextActionAt = null;
    job.stoppedAt = nowIso();
    this.#setStatus(job, "stopped", "已停止");
    return this.#publicJob(job);
  }

  async stopAll() {
    const active = [...this.jobs.values()].filter((job) => ACTIVE_JOB_STATES.has(job.status));
    return Promise.all(active.map((job) => this.stop(job.profileId)));
  }

  list() {
    return [...this.jobs.values()]
      .sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0))
      .map((job) => this.#publicJob(job));
  }

  get(profileId) {
    const job = this.jobs.get(profileId);
    return job ? this.#publicJob(job) : null;
  }

  #requiredJob(profileId) {
    const job = this.jobs.get(profileId);
    if (!job) throw new Error("未找到该实例的任务");
    return job;
  }

  async #run(job) {
    try {
      await this.#connectAndStart(job);
    } catch (error) {
      await this.#retryOrReconnect(job, error);
    }
  }

  async #connectAndStart(job) {
      const connection = await this.bitBrowserApi.openProfile(job.profileId);
      if (job.cancelled) return;

      job.session = this.sessionFactory(job);
      const page = await job.session.connect(connection.wsUrl);
      if (job.cancelled) {
        await job.session.close().catch(() => {});
        return;
      }

      job.pageTitle = page.title || "Reddit 首页";
      job.pageUrl = page.url || "";
      job.currentY = page.y || 0;
      job.maxY = page.max || 0;
      job.currentPost = page.currentPost || null;
      job.workflowPhase = "feed_align";
      job.nextOperation = "feed-scroll";
      this.#log(
        job,
        job.options.detailLoopEnabled
          ? "Reddit 首页已连接，开始自动只读浏览"
          : "Reddit 首页已连接，开始逐帖阅读",
        "info",
        "lifecycle",
      );
      if (job.pauseRequested) {
        this.#enterPaused(job);
        return;
      }
      await this.#dispatch(job);
  }

  async #retryOrReconnect(job, error) {
    if (job.cancelled) return;
    const msg = error instanceof Error ? error.message : String(error);
    this.#log(job, `操作异常：${msg}，10秒后重试`, "warning", "error", {
      workflowPhase: job.workflowPhase,
      nextOperation: job.nextOperation,
    });
    this.#setStatus(job, "waiting", `重试中（${msg}）`);
    this.#emitChange();

    await new Promise((r) => setTimeout(r, 10000));
    if (job.cancelled) return;

    if (job.session) {
      try {
        await job.session.scroll();
        this.#log(job, "会话仍可用，继续操作", "info", "lifecycle");
        job.nextOperation = "feed-scroll";
        job.workflowPhase = "feed_align";
        await this.#dispatch(job);
        return;
      } catch {}
    }

    this.#log(job, "会话已断开，正在重新连接", "warning", "lifecycle");
    if (job.session) { await job.session.close().catch(() => {}); job.session = null; }
    this.#emitChange();

    while (!job.cancelled) {
      try {
        await this.#connectAndStart(job);
        return;
      } catch (e) {
        this.#log(job, `重新连接失败：${e instanceof Error ? e.message : String(e)}，10秒后重试`, "warning", "lifecycle");
        this.#setStatus(job, "waiting", `重新连接中（${e instanceof Error ? e.message : String(e)}）`);
        this.#emitChange();
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  async #dispatch(job) {
    if (job.cancelled) return;
    if (job.pauseRequested) {
      this.#enterPaused(job);
      return;
    }
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;

    switch (job.nextOperation) {
      case "open-detail":
        await this.#openDetail(job);
        break;
      case "locate-comments":
        await this.#locateComments(job);
        break;
      case "comment-scroll":
        await this.#scrollComments(job);
        break;
      case "return-feed":
        await this.#returnToFeed(job);
        break;
      case "feed-scroll":
      default:
        await this.#stepFeed(job);
        break;
    }
  }

  async #stepFeed(job) {
    if (this.#maximumPostsReached(job)) {
      await this.#complete(job, "已达到设定的帖子数");
      return;
    }

    job.workflowPhase = "feed_align";
    job.nextOperation = "feed-scroll";
    this.#setStatus(job, "scrolling", "正在定位下一篇帖子");

    try {
      const result = await job.session.scroll();
      if (job.cancelled) return;
      this.#applyPageResult(job, result);

      if (this.#isAlignmentPending(job, result)) {
        this.#handleAlignmentPending(job, result);
        return;
      }

      job.alignmentPending = false;
      job.alignmentRetryCount = 0;
      job.alignmentRetryPostId = null;

      if (result.noPostAvailable) {
        if (result.atBottom && job.options.autoStopAtBottom) {
          await this.#complete(job, "没有下一篇帖子，任务已完成");
          return;
        }
        this.#log(
          job,
          result.atBottom ? "当前已到信息流末尾，等待新内容" : "正在等待 Reddit 加载下一篇帖子",
          "info",
          "feed",
          { atBottom: result.atBottom, retryable: !result.atBottom },
        );
      } else {
        this.#recordFeedUnit(job, result);
      }

      if (job.pauseRequested) {
        this.#enterPaused(job);
        return;
      }
      if (this.#maximumPostsReached(job)) {
        await this.#complete(job, "已达到设定的帖子数");
        return;
      }

      let waitMs = this.randomInteger(job.options.waitMinMs, job.options.waitMaxMs);
      job.workflowPhase = "feed_wait";

      if (
        !result.noPostAvailable &&
        job.currentPost?.postId &&
        !this.#isPromoted(job.currentPost)
      ) {
        await this.#tryAutoUpvotePost(job);
        if (job.cancelled) return;
      }

      if (job.options.autoJoinEnabled && job.joinTargets.length > 0) {
        await this.#tryAutoJoinSubreddit(job);
        if (job.cancelled) return;
      }

      const shouldOpen = this.#shouldOpenCurrentPost(job, result);
      if (shouldOpen) {
        job.nextOperation = "open-detail";
      } else {
        job.nextOperation = "feed-scroll";
      }

      this.#log(
        job,
        shouldOpen
          ? `${(waitMs / 1000).toFixed(1)} 秒后打开当前普通帖详情`
          : `${(waitMs / 1000).toFixed(1)} 秒后继续浏览 Feed`,
        "info",
        "schedule",
        { waitMs, nextOperation: job.nextOperation },
      );
      this.#schedule(job, job.nextOperation, waitMs, {
        status: "waiting",
        statusText: result.noPostAvailable ? "等待下一篇帖子" : "正在阅读当前帖子",
      });
    } catch (error) {
      await this.#failJob(job, error);
    }
  }

  #applyPageResult(job, result) {
    const actualDistance = Math.max(0, finiteNumber(result.actualDistance));
    job.lastScrollPixels = actualDistance;
    job.totalPixels += actualDistance;
    job.currentY = finiteNumber(result.currentY, job.currentY);
    job.maxY = finiteNumber(result.maxY, job.maxY);
    job.pageTitle = result.title || job.pageTitle;
    job.pageUrl = result.url || result.detailUrl || job.pageUrl;
    const previousPostId = job.currentPost?.postId || null;
    job.currentPost = result.currentPost || job.currentPost;
    if (job.currentPost?.postId && job.currentPost.postId !== previousPostId) {
      job.currentPostUpvoted = null;
      job.manualUpvoteState = "unknown";
      job.manualUpvoteBlockedReason = null;
    }
    if (Object.prototype.hasOwnProperty.call(result, "currentComment")) {
      const previousCommentId = commentIdentity(job.currentComment);
      job.currentComment = result.currentComment || null;
      if (commentIdentity(job.currentComment) !== previousCommentId) {
        job.manualCommentUpvoteState = "unknown";
        job.manualCommentUpvoteBlockedReason = null;
      }
    }
    if (result.postComplete !== undefined) job.currentPostComplete = Boolean(result.postComplete);
    job.alignmentReason = result.alignmentReason || null;
    job.alignmentResidualPx = Number.isFinite(result.alignmentResidualPx)
      ? result.alignmentResidualPx
      : null;
    job.alignmentAttempts = Number(result.alignmentAttempts || 0);
  }

  #handleAlignmentPending(job, result) {
    const retryPostId = result.currentPost?.postId || null;
    if (job.alignmentRetryPostId !== retryPostId) {
      job.alignmentRetryPostId = retryPostId;
      job.alignmentRetryCount = 0;
    }
    job.alignmentPending = true;
    job.alignmentRetryCount += 1;

    if (job.pauseRequested) {
      this.#enterPaused(job);
      return;
    }

    if (job.alignmentRetryCount >= MAX_CONSECUTIVE_ALIGNMENT_RETRIES) {
      const postTitle = result.currentPost?.title || "未识别帖子";
      const visiblePercent = Math.round(
        Math.max(0, Math.min(1, Number(result.currentPost?.visibleRatio || 0))) * 100,
      );
      throw new Error(
        `帖子“${postTitle}”连续 ${job.alignmentRetryCount} 次未能完整对齐` +
          `（当前可见 ${visiblePercent}%）。请检查页面弹窗、固定遮挡或网络加载状态后重试。`,
      );
    }

    const requestedRetryMs = Number(
      this.randomInteger(ALIGNMENT_RETRY_MIN_MS, ALIGNMENT_RETRY_MAX_MS),
    );
    const retryMs = Math.max(
      ALIGNMENT_RETRY_MIN_MS,
      Math.min(
        ALIGNMENT_RETRY_MAX_MS,
        Number.isFinite(requestedRetryMs) ? requestedRetryMs : ALIGNMENT_RETRY_MIN_MS,
      ),
    );
    job.workflowPhase = "feed_align";
    job.nextOperation = "feed-scroll";
    this.#schedule(job, "feed-scroll", retryMs, {
      status: "scrolling",
      statusText: `正在校正帖子位置（${job.alignmentRetryCount}/${MAX_CONSECUTIVE_ALIGNMENT_RETRIES}）`,
    });
    if (job.alignmentRetryCount === 1 || job.alignmentRetryCount % 4 === 0) {
      this.#log(
        job,
        `帖子尚未完整对齐，${retryMs} 毫秒后继续校正`,
        "info",
        "alignment_retry",
        {
          postId: result.currentPost?.postId,
          postTitle: result.currentPost?.title,
          visibleRatio: result.currentPost?.visibleRatio,
          fullyVisible: result.currentPost?.fullyVisible,
          oversized: result.currentPost?.oversized,
          scrollKind: result.scrollKind,
          alignmentReason: result.alignmentReason,
          alignmentResidualPx: result.alignmentResidualPx,
          alignmentAttempts: result.alignmentAttempts,
          retryCount: job.alignmentRetryCount,
          retryMs,
        },
      );
    }
  }

  #recordFeedUnit(job, result) {
    const post = result.currentPost;
    const postId = post?.postId || null;
    const promoted = this.#isPromoted(post);
    let countedNewPost = false;
    let countedFeedStep = false;

    if (result.newPost && postId && !promoted && !job.countedPostIds.has(postId)) {
      job.countedPostIds.add(postId);
      job.postCount += 1;
      countedNewPost = true;
    }
    if (
      postId &&
      !promoted &&
      post?.fullyVisible &&
      job.countedPostIds.has(postId) &&
      !job.fullPostIds.has(postId)
    ) {
      job.fullPostIds.add(postId);
      job.fullPostCount += 1;
    }
    if (
      job.options.detailLoopEnabled &&
      result.newPost &&
      postId &&
      finiteNumber(result.actualDistance) > 0 &&
      !job.countedFeedUnitIds.has(postId)
    ) {
      job.countedFeedUnitIds.add(postId);
      job.feedPostsSinceDetail += 1;
      countedFeedStep = true;
    }

    const postTitle = post?.title || (promoted ? "广告帖" : "未命名帖子");
    const message = promoted
      ? `已识别广告单元：${postTitle}`
      : countedNewPost
        ? `第 ${job.postCount} 篇：${postTitle}`
        : post?.oversized
          ? `继续阅读长帖：${postTitle}`
          : `重新定位当前帖子：${postTitle}`;
    this.#log(job, message, "info", "post_navigation", {
      postId,
      postTitle,
      postType: post?.postType,
      feedIndex: post?.feedIndex,
      permalink: post?.permalink,
      postHeight: post?.height,
      visibleRatio: post?.visibleRatio,
      fullyVisible: post?.fullyVisible,
      fitPossible: post?.fitPossible,
      oversized: post?.oversized,
      isPromoted: promoted,
      clickEligible: post?.clickEligible,
      postComplete: result.postComplete,
      scrollKind: result.scrollKind,
      actualDistance: result.actualDistance,
      currentY: result.currentY,
      maxY: result.maxY,
      inputMethod: result.inputMethod,
      alignmentReason: result.alignmentReason,
      alignmentResidualPx: result.alignmentResidualPx,
      alignmentAttempts: result.alignmentAttempts,
      countedFeedStep,
      feedPostsSinceDetail: job.feedPostsSinceDetail,
      feedPostsTarget: job.feedPostsTarget,
    });
  }

  #shouldOpenCurrentPost(job, result) {
    if (!job.options.detailLoopEnabled) return false;
    if (result.noPostAvailable || !result.currentPost || !result.postComplete) return false;
    if (job.feedPostsSinceDetail < job.feedPostsTarget) return false;

    const post = result.currentPost;
    if (this.#isPromoted(post) || post.clickEligible === false) {
      const postId = post.postId || `unknown-${post.feedIndex ?? ""}`;
      if (!job.skippedPromotedIds.has(postId)) {
        job.skippedPromotedIds.add(postId);
        if (this.#isPromoted(post)) job.skippedPromotedCount += 1;
        this.#log(
          job,
          this.#isPromoted(post) ? "达到本轮阈值，但当前是广告帖，继续向下浏览" : "当前帖子没有安全标题链接，继续向下浏览",
          "info",
          "detail_candidate_skipped",
          {
            postId: post.postId,
            postTitle: post.title,
            reason: this.#isPromoted(post) ? "promoted" : post.ineligibleReason || "not-clickable",
            feedPostsSinceDetail: job.feedPostsSinceDetail,
            feedPostsTarget: job.feedPostsTarget,
          },
        );
      }
      return false;
    }
    return true;
  }

  async #tryAutoUpvotePost(job) {
    if (!job.options.autoUpvoteEnabled) return;
    if (!job.currentPost?.postId) return;
    if (this.#isPromoted(job.currentPost)) return;
    if (!job.session || typeof job.session.manualUpvoteCurrentPost !== "function") return;

    const postId = String(job.currentPost.postId);
    if (job.upvotedPostIds.has(postId)) {
      job.manualUpvoteState = "upvoted";
      job.currentPostUpvoted = true;
      return;
    }

    const probability = Number(job.options.autoUpvoteProbability || 0);
    if (probability <= 0) return;
    const roll = this.randomInteger(0, 99);
    if (roll >= probability) {
      this.#log(
        job,
        `自动点赞概率未命中（${roll + 1}% >= ${probability}%），跳过当前帖`,
        "info",
        "auto_upvote_skipped",
        { postId, roll: roll + 1, threshold: probability },
      );
      return;
    }

    this.#setStatus(job, "scrolling", "正在自动点赞当前帖");
    this.#log(
      job,
      `自动点赞概率命中（${roll + 1}% < ${probability}%），准备点赞当前帖`,
      "info",
      "auto_upvote_attempt",
      { postId, postTitle: job.currentPost.title, roll: roll + 1, threshold: probability },
    );

    try {
      const result = await job.session.manualUpvoteCurrentPost({ expectedPostId: postId });
      if (job.cancelled) return;

      if (result.ok || result.uncertain) {
        job.upvotedPostIds.add(postId);
        job.autoUpvoteCount += 1;
        job.currentPostUpvoted = Boolean(
          result.alreadyUpvoted || result.changed || result.afterState === "upvoted",
        );
        job.manualUpvoteState = job.currentPostUpvoted ? "upvoted" : "unknown";
        job.lastManualUpvote = {
          at: nowIso(),
          source: "auto",
          changed: Boolean(result.changed),
          alreadyUpvoted: Boolean(result.alreadyUpvoted),
          uncertain: Boolean(result.uncertain),
          beforeState: result.beforeState,
          afterState: result.afterState,
          reason: result.reason || null,
        };
        this.#log(
          job,
          result.changed
            ? "自动点赞成功，已点赞当前帖"
            : result.alreadyUpvoted
              ? "当前帖已是点赞状态，自动确认"
              : result.uncertain
                ? `自动点赞结果不确定（${result.reason || "unknown"}），已锁定防止重复操作`
                : "自动点赞完成",
          result.uncertain ? "warning" : "info",
          "auto_upvote",
          { postId, result },
        );
        this.persistence?.updateRun(job);
      } else {
        this.#log(
          job,
          `自动点赞未执行：${result.reason || "unknown"}`,
          "info",
          "auto_upvote_skipped",
          { postId, reason: result.reason },
        );
      }
    } catch (error) {
      this.#log(
        job,
        `自动点赞出错：${error.message}`,
        "warning",
        "auto_upvote_error",
        { postId, error: error.message },
      );
    }
  }

  async #tryAutoJoinSubreddit(job) {
    if (!job.options.autoJoinEnabled) return;
    if (job.autoJoinCount >= job.options.autoJoinMaxPerRun) return;
    if (!job.session || typeof job.session.joinSubreddit !== "function") return;

    const now = Date.now();
    if (job.lastJoinAt > 0 && now - job.lastJoinAt < job.nextJoinDelay) return;

    let target = null;
    while (job.joinTargetIndex < job.joinTargets.length) {
      const candidate = job.joinTargets[job.joinTargetIndex];
      const name = String(candidate?.name || "").trim();
      if (!name) { job.joinTargetIndex += 1; continue; }
      if (job.joinedSubredditIds.has(name.toLowerCase())) { job.joinTargetIndex += 1; continue; }
      target = name;
      break;
    }
    if (!target) return;

    this.#setStatus(job, "scrolling", `正在关注 r/${target}`);
    this.#log(job, `正在前往 r/${target} 执行关注`, "info", "auto_join_attempt", { subreddit: target });

    try {
      const result = await job.session.joinSubreddit(target);
      if (job.cancelled) return;

      job.lastJoinAt = Date.now();
      job.nextJoinDelay = this.randomInteger(
        job.options.autoJoinIntervalMinMs,
        job.options.autoJoinIntervalMaxMs,
      );

      if (result.ok || result.alreadyJoined) {
        job.joinTargetIndex += 1;
        job.joinedSubredditIds.add(target.toLowerCase());
        job.autoJoinCount += 1;
        this.#log(
          job,
          result.alreadyJoined ? `r/${target} 已是关注状态` : `已关注 r/${target}`,
          "info",
          "auto_join",
          { subreddit: target, alreadyJoined: result.alreadyJoined },
        );
      } else {
        this.#log(job, `关注 r/${target} 未成功：${result.error || "未知原因"}`, "warning", "auto_join_failed", { subreddit: target });
      }
      this.persistence?.updateRun(job);
    } catch (error) {
      this.#log(
        job,
        `关注 r/${target} 出错：${error.message}`,
        "warning",
        "auto_join_error",
        { subreddit: target, error: error.message },
      );
      job.lastJoinAt = Date.now();
      job.nextJoinDelay = this.randomInteger(
        job.options.autoJoinIntervalMinMs,
        job.options.autoJoinIntervalMaxMs,
      );
    }
  }

  async #tryAutoUpvoteComment(job) {
    if (!job.options.autoCommentUpvoteEnabled) return;
    if (!job.currentComment?.commentId) return;
    if (job.currentComment.hasVisibleUpvote === false) return;
    if (job.currentComment.anchorInSafeViewport === false) return;
    if (job.currentComment.readable === false) return;
    if (!job.session || typeof job.session.manualUpvoteCurrentComment !== "function") return;

    const commentId = commentIdentity(job.currentComment);
    if (!commentId) return;
    if (job.upvotedCommentIds.has(commentId)) {
      job.manualCommentUpvoteState = "upvoted";
      return;
    }

    const probability = Number(job.options.autoCommentUpvoteProbability || 0);
    if (probability <= 0) return;
    const roll = this.randomInteger(0, 99);
    if (roll >= probability) {
      this.#log(
        job,
        `评论自动点赞概率未命中（${roll + 1}% >= ${probability}%），跳过`,
        "info",
        "auto_comment_upvote_skipped",
        { commentId, roll: roll + 1, threshold: probability },
      );
      return;
    }

    this.#setStatus(job, "scrolling", "正在自动点赞当前评论");
    this.#log(
      job,
      `评论自动点赞概率命中（${roll + 1}% < ${probability}%），准备点赞`,
      "info",
      "auto_comment_upvote_attempt",
      { commentId, roll: roll + 1, threshold: probability },
    );

    try {
      const result = await job.session.manualUpvoteCurrentComment({
        expectedCommentId: job.currentComment.commentId,
      });
      if (job.cancelled) return;

      if (result.ok || result.uncertain) {
        job.upvotedCommentIds.add(commentId);
        job.autoCommentUpvoteCount += 1;
        const upvoted = Boolean(
          result.alreadyUpvoted || result.changed || result.afterState === "upvoted",
        );
        job.manualCommentUpvoteState = upvoted ? "upvoted" : "unknown";
        job.lastManualCommentUpvote = {
          at: nowIso(),
          source: "auto",
          changed: Boolean(result.changed),
          alreadyUpvoted: Boolean(result.alreadyUpvoted),
          uncertain: Boolean(result.uncertain),
          beforeState: result.beforeState,
          afterState: result.afterState,
          reason: result.reason || null,
        };
        this.#log(
          job,
          result.changed
            ? "自动评论点赞成功"
            : result.alreadyUpvoted
              ? "当前评论已是点赞状态，自动确认"
              : result.uncertain
                ? `自动评论点赞结果不确定（${result.reason || "unknown"}），已锁定`
                : "自动评论点赞完成",
          result.uncertain ? "warning" : "info",
          "auto_comment_upvote",
          { commentId, result },
        );
        this.persistence?.updateRun(job);
      } else {
        this.#log(
          job,
          `自动评论点赞未执行：${result.reason || "unknown"}`,
          "info",
          "auto_comment_upvote_skipped",
          { commentId, reason: result.reason },
        );
      }
    } catch (error) {
      this.#log(
        job,
        `自动评论点赞出错：${error.message}`,
        "warning",
        "auto_comment_upvote_error",
        { commentId, error: error.message },
      );
    }
  }

  async #tryAutoPostComment(job) {
    if (!job.options.autoCommentEnabled) return;
    if (!job.session || typeof job.session.postComment !== "function") return;
    if (job.autoCommentCount >= Number(job.options.autoCommentMaxPerRun || 0)) return;
    if (!job.options.detailLoopEnabled) {
      this.#log(job, `自动评论已启用但"自动只读详情循环"未开启，评论需要进入帖子详情页才能执行`, "warning", "auto_comment_disabled_no_detail_loop");
      return;
    }

    const now = Date.now();
    if (job.lastCommentAt > 0 && now - job.lastCommentAt < job.nextCommentDelay) return;

    const postId = String(job.currentPost?.postId || "");
    if (!postId) return;
    if (job.postedCommentPostIds.has(postId)) return;

    if (job.options._autoCommentMinPostAgeHours) {
      const postAgeHours = job.currentPost?.postedAt
        ? (Date.now() - new Date(job.currentPost.postedAt).getTime()) / 3600000
        : null;
      if (postAgeHours !== null && postAgeHours < job.options._autoCommentMinPostAgeHours) {
        this.#log(job, `帖子发布仅 ${postAgeHours.toFixed(1)} 小时，未达到最小 ${job.options._autoCommentMinPostAgeHours} 小时要求，跳过评论`, "info", "auto_comment_post_too_new", { postId, postAgeHours: Math.round(postAgeHours * 10) / 10, minHours: job.options._autoCommentMinPostAgeHours });
        return;
      }
    }
    if (job.options._autoCommentMinAuthorKarma && job.currentPost?.authorKarma !== undefined) {
      if (Number(job.currentPost.authorKarma) < job.options._autoCommentMinAuthorKarma) {
        this.#log(job, `发帖人 Karma ${job.currentPost.authorKarma} 低于阈值 ${job.options._autoCommentMinAuthorKarma}，跳过评论`, "info", "auto_comment_low_author_karma", { postId, authorKarma: job.currentPost.authorKarma, minKarma: job.options._autoCommentMinAuthorKarma });
        return;
      }
    }

    const texts = Array.isArray(job.options.autoCommentTexts)
      ? job.options.autoCommentTexts.filter((t) => t && t.trim())
      : [];

    const probability = Number(job.options.autoCommentProbability || 0);
    if (probability <= 0) return;
    const roll = this.randomInteger(0, 99);
    if (roll >= probability) {
      this.#log(job, `自动评论概率未命中（${roll + 1}% >= ${probability}%），跳过`, "info", "auto_comment_skipped", { postId, roll: roll + 1, threshold: probability });
      return;
    }

    let commentText = null;
    let commentSource = "library";
    let postContext = null;

    // 1. 优先从语料库匹配评论
    job.workflowPhase = "comment_posting";
    try {
      postContext = await job.session.readPostContext();
      if (postContext && postContext.title) {
        const match = pickCommentFromCorpus(postContext, { randomFn: () => this.randomInteger(0, 999999) / 1000000 });
        if (match && match.text) {
          commentText = match.text;
          commentSource = "corpus";
          this.#log(
            job,
            `语料库匹配评论（相似度 ${match.similarity}，r/${match.subreddit}，原帖：${match.matchedPost}…，评论赞数 ${match.commentScore}）`,
            "info",
            "corpus_comment_matched",
            { postId, similarity: match.similarity, matchedPost: match.matchedPost, subreddit: match.subreddit, commentScore: match.commentScore, preview: match.text.substring(0, 100) },
          );
        }
      }
    } catch (e) {
      this.#log(job, `语料库匹配评论失败：${e.message}`, "warning", "corpus_comment_error", { postId, error: e.message });
    }

    // 2. 如果语料库未匹配，尝试 AI 生成
    if (!commentText && job.options._useAiComment && job.options._aiCommentConfig) {
      try {
        this.#setStatus(job, "scrolling", "正在用 AI 生成评论");
        if (!postContext) postContext = await job.session.readPostContext();
        if (postContext && postContext.title) {
          this.#log(job, `正在用 AI 分析帖子并生成评论（r/${postContext.subreddit}：${postContext.title.substring(0, 60)}）`, "info", "ai_comment_generating", { postId, title: postContext.title.substring(0, 80), subreddit: postContext.subreddit });
          commentText = await generateAiComment(job.options._aiCommentConfig, postContext);
          commentSource = "ai";
          this.#log(job, `AI 评论已生成（${commentText.length} 字）`, "info", "ai_comment_generated", { postId, preview: commentText.substring(0, 120) });
        }
      } catch (e) {
        this.#log(job, `AI 评论生成失败，回退到文本库：${e.message}`, "warning", "ai_comment_fallback", { postId, error: e.message });
      }
    }

    // 3. 回退到文本库
    if (!commentText) {
      if (texts.length === 0) {
        this.#log(job, `无评论文本可用（语料库和 AI 均未匹配，且文本库为空）`, "warning", "auto_comment_no_text", { postId });
        return;
      }
      commentText = texts[this.randomInteger(0, texts.length - 1)];
      commentSource = "library";
    }

    const sourceLabel = commentSource === "corpus" ? "语料库" : commentSource === "ai" ? "AI" : "文本库";
    this.#setStatus(job, "scrolling", `正在自动评论（${sourceLabel}）`);
    this.#log(job, `准备在帖子 ${postId} 上评论（${sourceLabel}）：${commentText.substring(0, 50)}${commentText.length > 50 ? "…" : ""}`, "info", "auto_comment_attempt", { postId, textPreview: commentText.substring(0, 80), source: commentSource });

    try {
      const result = await job.session.postComment(commentText);
      if (job.cancelled) return;

      if (result.ok) {
        job.postedCommentPostIds.add(postId);
        job.autoCommentCount += 1;
        job.lastCommentAt = Date.now();
        job.nextCommentDelay = this.randomInteger(
          job.options.autoCommentMinIntervalMs,
          job.options.autoCommentMaxIntervalMs,
        );
        this.#log(
          job,
          `自动评论成功（第 ${job.autoCommentCount}/${job.options.autoCommentMaxPerRun} 条），下次评论间隔 ${Math.round(job.nextCommentDelay / 1000)} 秒`,
          "info",
          "auto_comment",
          { postId, text: commentText.substring(0, 100) },
        );
        this.persistence?.updateRun(job);
      } else {
        this.#log(
          job,
          `自动评论未成功：${result.error || "未知原因"}`,
          "warning",
          "auto_comment_failed",
          { postId, error: result.error },
        );
        job.lastCommentAt = Date.now();
        job.nextCommentDelay = this.randomInteger(
          job.options.autoCommentMinIntervalMs,
          job.options.autoCommentMaxIntervalMs,
        );
      }
    } catch (error) {
      this.#log(
        job,
        `自动评论出错：${error.message}`,
        "warning",
        "auto_comment_error",
        { postId, error: error.message },
      );
      job.lastCommentAt = Date.now();
      job.nextCommentDelay = this.randomInteger(
        job.options.autoCommentMinIntervalMs,
        job.options.autoCommentMaxIntervalMs,
      );
    }
  }

  async #openDetail(job) {
    if (this.#maximumPostsReached(job)) {
      await this.#complete(job, "已达到设定的帖子数");
      return;
    }
    job.workflowPhase = "opening_detail";
    this.#setStatus(job, "scrolling", "正在打开普通帖子详情");

    try {
      const expectedPost = job.currentPost;
      const result = await job.session.openCurrentPost({
        expectedPostId: expectedPost?.postId,
      });
      if (job.cancelled) return;
      if (!result?.opened) {
        if (result?.reason === "promoted") {
          const postId = expectedPost?.postId || "unknown";
          if (!job.skippedPromotedIds.has(postId)) {
            job.skippedPromotedIds.add(postId);
            job.skippedPromotedCount += 1;
          }
        }
        this.#log(
          job,
          result?.reason === "promoted"
            ? "打开前再次确认是广告帖，已跳过"
            : "当前帖子无法安全打开，继续浏览 Feed",
          "info",
          "detail_candidate_skipped",
          {
            postId: expectedPost?.postId,
            postTitle: expectedPost?.title,
            reason: result?.reason || "open-failed",
          },
        );
        job.workflowPhase = "feed_align";
        job.nextOperation = "feed-scroll";
        this.#schedule(job, "feed-scroll", 0, {
          status: "scrolling",
          statusText: "继续定位下一篇普通帖子",
        });
        return;
      }

      job.pageUrl = result.detailUrl || result.url || job.pageUrl;
      job.pageTitle = result.title || job.pageTitle;
      job.currentDetailPost = {
        postId: result.postId || expectedPost?.postId || null,
        title: result.postTitle || expectedPost?.title || "未命名帖子",
        permalink: result.detailUrl || result.url || expectedPost?.permalink || null,
        openedAt: nowIso(),
      };
      job.currentComment = null;
      job.manualCommentUpvoteState = "unknown";
      job.manualCommentUpvoteBlockedReason = null;
      job.detailVisitCount += 1;
      this.#log(job, `已打开详情：${job.currentDetailPost.title}`, "info", "detail_open", {
        ...job.currentDetailPost,
        navigationMode: result.navigationMode || null,
        readonly: true,
      });

      const waitMs = this.#randomMs(job.options, "detailWait", 2_000, 15_000);
      job.workflowPhase = "detail_wait";
      job.nextOperation = "locate-comments";
      this.#log(
        job,
        `${(waitMs / 1000).toFixed(1)} 秒后开始查看评论区`,
        "info",
        "detail_wait_scheduled",
        { waitMs },
      );
      this.#schedule(job, "locate-comments", waitMs, {
        status: "waiting",
        statusText: "正在阅读帖子详情",
      });
    } catch (error) {
      await this.#failJob(job, error);
    }
  }

  async #locateComments(job) {
    job.workflowPhase = "locating_comments";
    job.nextOperation = "locate-comments";
    this.#setStatus(job, "scrolling", "正在定位评论区");
    try {
      const result = await job.session.locateComments();
      if (job.cancelled) return;
      this.#applyPageResult(job, result || {});
      job.commentScrollProgress = 0;
      job.commentNoProgressCount = 0;
      job.commentScrollTarget = this.randomInteger(
        job.options.commentScrollMin,
        job.options.commentScrollMax,
      );
      this.#log(job, "评论区定位完成", "info", "comments_located", {
        available: result?.available !== false,
        commentCount: result?.commentCount ?? null,
        actualDistance: result?.actualDistance ?? 0,
        atBottom: Boolean(result?.atBottom),
        commentScrollTarget: job.commentScrollTarget,
      });

      if (job.pauseRequested) {
        job.nextOperation = result?.available === false || result?.atBottom
          ? "return-feed"
          : "comment-scroll";
        this.#enterPaused(job);
        return;
      }
      if (result?.available === false || result?.commentsClosed || result?.atBottom) {
        this.#scheduleReturn(job);
        return;
      }
      if (job.options.autoCommentEnabled) {
        await this.#tryAutoPostComment(job);
        if (job.cancelled) return;
      }
      job.workflowPhase = "comment_scrolling";
      job.nextOperation = "comment-scroll";
      this.#schedule(job, "comment-scroll", 0, {
        status: "scrolling",
        statusText: "开始只读浏览评论",
      });
    } catch (error) {
      await this.#failJob(job, error);
    }
  }

  async #scrollComments(job) {
    if (job.commentScrollProgress >= job.commentScrollTarget) {
      this.#scheduleReturn(job);
      return;
    }
    job.workflowPhase = "comment_scrolling";
    job.nextOperation = "comment-scroll";
    this.#setStatus(
      job,
      "scrolling",
      `正在浏览评论（${job.commentScrollProgress + 1}/${job.commentScrollTarget}）`,
    );
    try {
      const scrollMethod = job.session.scrollComments || job.session.scrollCommentStep;
      if (typeof scrollMethod !== "function") {
        throw new Error("当前浏览器会话不支持评论区滚动");
      }
      const result = await scrollMethod.call(job.session);
      if (job.cancelled) return;
      this.#applyPageResult(job, result || {});
      const actualDistance = Math.max(0, finiteNumber(result?.actualDistance));
      const moved = result?.moved === true || actualDistance > 0;
      if (moved) {
        job.commentScrollProgress += 1;
        job.commentScrollCount += 1;
        job.commentNoProgressCount = 0;
        this.#log(
          job,
          `评论区第 ${job.commentScrollProgress}/${job.commentScrollTarget} 次向下移动`,
          "info",
          "comment_scroll",
          {
            actualDistance,
            currentY: result?.currentY,
            maxY: result?.maxY,
            atBottom: Boolean(result?.atBottom),
          },
        );
      } else {
        job.commentNoProgressCount += 1;
      }

      if (
        result?.atBottom ||
        job.commentScrollProgress >= job.commentScrollTarget ||
        job.commentNoProgressCount >= MAX_COMMENT_NO_PROGRESS_RETRIES
      ) {
        this.#scheduleReturn(job);
        return;
      }
      if (job.pauseRequested) {
        this.#enterPaused(job);
        return;
      }

      const commentStepMin = Number.isInteger(job.options.commentStepWaitMinMs)
        ? job.options.commentStepWaitMinMs
        : DEFAULT_COMMENT_STEP_WAIT_MIN_MS;
      const gapMs = this.randomInteger(
        commentStepMin,
        Number.isInteger(job.options.commentStepWaitMaxMs)
          ? job.options.commentStepWaitMaxMs
          : DEFAULT_COMMENT_STEP_WAIT_MAX_MS,
      );

      if (moved && job.currentComment?.commentId) {
        await this.#tryAutoUpvoteComment(job);
        if (job.cancelled) return;
      }

      this.#schedule(job, "comment-scroll", gapMs, {
        status: "waiting",
        statusText: `正在阅读评论（${job.commentScrollProgress}/${job.commentScrollTarget}）`,
      });
    } catch (error) {
      await this.#failJob(job, error);
    }
  }

  #scheduleReturn(job) {
    const waitMs = this.#randomMs(job.options, "returnWait", 2_000, 4_000);
    job.workflowPhase = "return_wait";
    job.nextOperation = "return-feed";
    this.#log(
      job,
      `${(waitMs / 1000).toFixed(1)} 秒后返回 Feed`,
      "info",
      "return_scheduled",
      {
        waitMs,
        commentScrollProgress: job.commentScrollProgress,
        commentScrollTarget: job.commentScrollTarget,
      },
    );
    this.#schedule(job, "return-feed", waitMs, {
      status: "waiting",
      statusText: "正在阅读当前评论位置",
    });
  }

  async #returnToFeed(job) {
    job.workflowPhase = "returning_feed";
    job.nextOperation = "return-feed";
    this.#setStatus(job, "scrolling", "正在返回 Feed");
    try {
      const result = await job.session.returnToFeed();
      if (job.cancelled) return;
      if (result?.returned === false) {
        throw new Error(result.reason || "无法返回原 Feed 页面");
      }
      job.workflowPhase = "feed_restore";
      this.#applyPageResult(job, result || {});
      job.currentComment = null;
      job.manualCommentUpvoteState = "unknown";
      job.manualCommentUpvoteBlockedReason = null;
      this.#log(job, "已返回并恢复 Feed 阅读位置", "info", "feed_restored", {
        anchorRestored: result?.anchorRestored !== false,
        currentY: result?.currentY ?? result?.y ?? job.currentY,
        postId: result?.currentPost?.postId || job.currentPost?.postId,
      });
      this.#log(job, "本轮只读详情浏览完成", "info", "detail_cycle_complete", {
        detailVisitCount: job.detailVisitCount,
        commentScrollProgress: job.commentScrollProgress,
        commentScrollTarget: job.commentScrollTarget,
      });

      job.feedPostsSinceDetail = 0;
      job.feedPostsTarget = this.#drawFeedTarget(job.options);
      job.commentScrollProgress = 0;
      job.commentScrollTarget = 0;
      job.commentNoProgressCount = 0;
      job.workflowPhase = "feed_align";
      job.nextOperation = "feed-scroll";
      this.#log(
        job,
        `新一轮将在向下阅读 ${job.feedPostsTarget} 个 Feed 单元后查看普通帖子详情`,
        "info",
        "detail_cycle_planned",
        { feedPostsTarget: job.feedPostsTarget, readonly: true },
      );
      if (job.pauseRequested) {
        this.#enterPaused(job);
        return;
      }
      this.#schedule(job, "feed-scroll", 0, {
        status: "scrolling",
        statusText: "继续浏览 Feed",
      });
    } catch (error) {
      await this.#failJob(job, error);
    }
  }

  #schedule(job, operation, delayMs, { status = "waiting", statusText = "等待继续" } = {}) {
    if (job.cancelled) return;
    if (job.timer) clearTimeout(job.timer);
    const safeDelayMs = Math.max(0, Math.round(finiteNumber(delayMs)));
    job.nextOperation = operation;
    job.scheduledDeadlineMs = Date.now() + safeDelayMs;
    job.scheduledStatus = status;
    job.scheduledStatusText = statusText;
    job.nextActionAt = new Date(job.scheduledDeadlineMs).toISOString();
    this.#setStatus(job, status, statusText);
    job.timer = setTimeout(() => {
      job.timer = null;
      job.nextActionAt = null;
      job.scheduledDeadlineMs = null;
      void this.#dispatch(job);
    }, safeDelayMs);
  }

  #enterPaused(job) {
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;
    this.#setStatus(job, "paused", "已暂停");
    this.#log(job, "任务已暂停，浏览器连接保持不变", "info", "lifecycle", {
      nextOperation: job.nextOperation,
      workflowPhase: job.workflowPhase,
      remainingDelayMs: job.pausedRemainingMs,
    });
  }

  #isAlignmentPending(job, result) {
    if (result.alignmentPending === true) return true;
    if (["alignment-pending", "target-lost"].includes(result.scrollKind)) return true;
    if (result.noPostAvailable) return false;
    if (result.alignmentVerified === true) return false;
    if (result.alignmentVerified === false) return true;

    const post = result.currentPost;
    if (!post) return true;
    if (post.fitPossible) return !post.fullyVisible;
    if (post.oversized) {
      if (result.newPost) return false;
      return !(
        job.countedPostIds.has(post.postId) &&
        result.scrollKind === "continue-post" &&
        Number(result.actualDistance) > 0
      );
    }
    return false;
  }

  #isPromoted(post) {
    return Boolean(
      post?.isPromoted === true ||
      post?.promoted === true ||
      post?.ineligibleReason === "promoted",
    );
  }

  #maximumPostsReached(job) {
    return Boolean(
      job.options.maxPosts > 0 &&
      job.postCount >= job.options.maxPosts &&
      job.currentPostComplete,
    );
  }

  #drawFeedTarget(options) {
    return this.randomInteger(options.detailAfterMinPosts, options.detailAfterMaxPosts);
  }

  #randomMs(options, prefix, fallbackMinMs, fallbackMaxMs) {
    const minMsKey = `${prefix}MinMs`;
    const maxMsKey = `${prefix}MaxMs`;
    const minSecKey = `${prefix}MinSec`;
    const maxSecKey = `${prefix}MaxSec`;
    const minMs = Number.isInteger(options[minMsKey])
      ? options[minMsKey]
      : Number.isInteger(options[minSecKey])
        ? options[minSecKey] * 1000
        : fallbackMinMs;
    const maxMs = Number.isInteger(options[maxMsKey])
      ? options[maxMsKey]
      : Number.isInteger(options[maxSecKey])
        ? options[maxSecKey] * 1000
        : fallbackMaxMs;
    return this.randomInteger(minMs, maxMs);
  }

  #waitingStatusText(job) {
    switch (job.workflowPhase) {
      case "detail_wait":
        return "正在阅读帖子详情";
      case "comment_scrolling":
        return "正在阅读评论";
      case "return_wait":
        return "正在阅读当前评论位置";
      case "feed_wait":
      default:
        return "正在阅读当前帖子";
    }
  }

  async #complete(job, message) {
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;
    job.stoppedAt = nowIso();
    this.#log(job, message, "info", "lifecycle");
    await job.session?.close().catch(() => {});
    job.session = null;
    this.#setStatus(job, "completed", "已完成");
  }

  async #failJob(job, error) {
    if (job.cancelled) return;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.nextActionAt = null;
    job.scheduledDeadlineMs = null;
    const msg = error instanceof Error ? error.message : String(error);
    this.#log(job, `操作出错：${msg}，10秒后重试`, "warning", "error", {
      workflowPhase: job.workflowPhase,
      nextOperation: job.nextOperation,
    });
    this.#setStatus(job, "waiting", `重试中（${msg}）`);
    this.#emitChange();

    job.timer = setTimeout(() => {
      job.timer = null;
      void this.#retryOrReconnect(job, error);
    }, 10000);
  }

  #setStatus(job, status, statusText) {
    job.status = status;
    job.statusText = statusText;
    job.updatedAt = nowIso();
    this.#persistRun(job);
    this.#emitChange();
  }

  #log(job, message, level = "info", eventType = "activity", data = null) {
    const time = nowIso();
    job.logs.push({ time, level, eventType, message });
    if (job.logs.length > MAX_LOG_ENTRIES) job.logs.shift();
    job.updatedAt = time;
    try {
      this.persistence?.addEvent({
        runId: job.runId,
        profileId: job.profileId,
        message,
        level,
        eventType,
        data,
      });
    } catch (error) {
      job.persistenceError = error instanceof Error ? error.message : String(error);
    }
    this.#persistRun(job);
    this.#emitChange();
  }

  #persistRun(job) {
    try {
      this.persistence?.updateRun(job);
    } catch (error) {
      job.persistenceError = error instanceof Error ? error.message : String(error);
    }
  }

  #emitChange() {
    this.emit("change", this.list());
  }

  #publicJob(job) {
    const manualUpvoteAvailable = Boolean(
      job.status === "waiting" &&
      job.workflowPhase === "feed_wait" &&
      Number.isFinite(job.scheduledDeadlineMs) &&
      job.currentPost?.postId &&
      !this.#isPromoted(job.currentPost) &&
      job.currentPost.clickEligible !== false &&
      job.manualUpvoteState === "unknown" &&
      !job.manualActionPending &&
      !job.manualCommentActionPending,
    );
    const manualCommentUpvoteAvailable = Boolean(
      MANUAL_COMMENT_PHASES.has(job.workflowPhase) &&
      (job.status === "paused" ||
        (job.status === "waiting" && Number.isFinite(job.scheduledDeadlineMs))) &&
      job.currentComment?.commentId &&
      job.currentComment.hasVisibleUpvote !== false &&
      job.currentComment.anchorInSafeViewport !== false &&
      job.currentComment.readable !== false &&
      job.manualCommentUpvoteState === "unknown" &&
      !job.manualActionPending &&
      !job.manualCommentActionPending,
    );
    return {
      runId: job.runId,
      profileId: job.profileId,
      seq: job.seq,
      name: job.name,
      status: job.status,
      statusText: job.statusText,
      options: publicOptions(job.options),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      stoppedAt: job.stoppedAt,
      nextActionAt: job.nextActionAt,
      nextOperation: job.nextOperation,
      postCount: job.postCount,
      fullPostCount: job.fullPostCount,
      scrollCount: job.postCount,
      totalPixels: job.totalPixels,
      lastScrollPixels: job.lastScrollPixels,
      currentY: job.currentY,
      maxY: job.maxY,
      currentPost: job.currentPost,
      currentPostComplete: job.currentPostComplete,
      alignmentPending: job.alignmentPending,
      alignmentRetryCount: job.alignmentRetryCount,
      alignmentReason: job.alignmentReason,
      alignmentResidualPx: job.alignmentResidualPx,
      alignmentAttempts: job.alignmentAttempts,
      workflowMode: job.workflowMode,
      workflowPhase: job.workflowPhase,
      feedPostsSinceDetail: job.feedPostsSinceDetail,
      feedPostsTarget: job.feedPostsTarget,
      detailVisitCount: job.detailVisitCount,
      commentScrollCount: job.commentScrollCount,
      commentScrollProgress: job.commentScrollProgress,
      commentScrollTarget: job.commentScrollTarget,
      skippedPromotedCount: job.skippedPromotedCount,
    autoUpvoteCount: job.autoUpvoteCount,
    autoCommentUpvoteCount: job.autoCommentUpvoteCount,
    autoCommentCount: job.autoCommentCount,
    autoJoinCount: job.autoJoinCount,
    joinedSubredditCount: job.joinedSubredditIds.size,
      upvotedPostCount: job.upvotedPostIds.size,
      upvotedCommentCount: job.upvotedCommentIds.size,
      currentDetailPost: job.currentDetailPost,
      currentComment: job.currentComment,
      manualActionPending: job.manualActionPending,
      manualUpvoteAvailable,
      currentPostUpvoted: job.currentPostUpvoted,
      manualUpvoteState: job.manualUpvoteState,
      manualUpvoteBlockedReason: job.manualUpvoteBlockedReason,
      lastManualUpvote: job.lastManualUpvote,
      manualCommentActionPending: job.manualCommentActionPending,
      manualCommentUpvoteAvailable,
      manualCommentUpvoteState: job.manualCommentUpvoteState,
      manualCommentUpvoteBlockedReason: job.manualCommentUpvoteBlockedReason,
      lastManualCommentUpvote: job.lastManualCommentUpvote,
      pageTitle: job.pageTitle,
      pageUrl: job.pageUrl,
      error: job.error,
      persistenceError: job.persistenceError,
      logs: [...job.logs],
    };
  }
}
