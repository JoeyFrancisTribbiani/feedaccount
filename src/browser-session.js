import { CdpClient } from "./cdp-client.js";
import { randomInteger, TARGET_URL } from "./config.js";
import {
  planApproachDistance,
  planClickMotion,
  planGestureSpeed,
  planScrollPause,
  planWheelBurst,
} from "./natural-input.js";
import {
  alignPost,
  planNextPost,
  postViewportState,
  selectCurrentPost,
} from "./post-planner.js";
import {
  locateRedditCommentTargets,
  locateRedditInteractionTargets,
  locateRedditPostComposerTargets,
  locateRedditVoteTargets,
} from "./reddit-interaction-locator.js";
import {
  buildDetailDomExpression,
  buildFeedClickTargetExpression,
  buildFeedDomExpression,
  buildTargetProbeExpression,
  canonicalCommentIdentity,
  canonicalPostIdentity,
  commentIdentityAliases,
  commentMatchesIdentifier,
  postIdentityAliases,
  postMatchesIdentifier,
  redditCommentToken,
  redditPostToken,
} from "./reddit-selectors.js";

const PAGE_IDENTITY_EXPRESSION = `(() => ({
  /* reddit-flow:page-identity */
  title: document.title,
  url: location.href,
  ready: document.readyState,
}))()`;

const POSITION_TOLERANCE_PX = 8;
const MAX_ALIGNMENT_ATTEMPTS = 5;
const ALIGNMENT_TIMEOUT_MS = 4_000;
const NO_PROGRESS_TOLERANCE_PX = 2;
const STABILITY_MAX_SAMPLES = 4;
const STABILITY_REQUIRED_MATCHES = 2;
const LOADING_PROBE_RATIO = 0.35;
const COMMENT_OVERLAP_PX = 120;
const NAVIGATION_TIMEOUT_MS = 15_000;
const RESTORE_TIMEOUT_MS = 15_000;

function isRedditHome(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "reddit.com" || url.hostname === "www.reddit.com") &&
      url.pathname === "/" &&
      url.searchParams.get("feed") === "home"
    );
  } catch {
    return false;
  }
}

function resolveExpectedFeedPost(feed, expectedPostId) {
  const exact = feed.posts.filter((post) => postIdentityAliases(post).includes(expectedPostId));
  if (exact.length === 1) return { post: exact[0], ambiguous: false };
  if (exact.length > 1) return { post: null, ambiguous: true };
  const expectedToken = redditPostToken(expectedPostId);
  const canonical = expectedToken
    ? feed.posts.filter((post) => canonicalPostIdentity(post) === expectedToken)
    : [];
  return {
    post: canonical.length === 1 ? canonical[0] : null,
    ambiguous: canonical.length > 1,
  };
}

function targetOwnerCanonicalIdentity(target) {
  const explicit = redditPostToken(target?.ownerCanonicalId);
  if (explicit) return explicit;
  const aliases = [
    ...(Array.isArray(target?.ownerIdAliases) ? target.ownerIdAliases : []),
    target?.ownerId,
  ].filter(Boolean);
  return aliases.map(redditPostToken).find(Boolean) || "";
}

function targetBelongsToPost(target, post) {
  const postIdentity = canonicalPostIdentity(post);
  const ownerIdentity = targetOwnerCanonicalIdentity(target);
  return Boolean(postIdentity) && Boolean(ownerIdentity) && postIdentity === ownerIdentity;
}

function resolveExpectedDetailComment(detail, expectedCommentId) {
  const exact = detail.comments.filter((comment) =>
    commentIdentityAliases(comment).includes(expectedCommentId));
  if (exact.length === 1) return { comment: exact[0], ambiguous: false };
  if (exact.length > 1) return { comment: null, ambiguous: true };
  const expectedToken = redditCommentToken(expectedCommentId);
  const canonical = expectedToken
    ? detail.comments.filter((comment) => canonicalCommentIdentity(comment) === expectedToken)
    : [];
  return {
    comment: canonical.length === 1 ? canonical[0] : null,
    ambiguous: canonical.length > 1,
  };
}

function commentViewportState(comment, detail) {
  const safeTop = Number(detail?.safeTop) || 0;
  const safeBottom = Number(detail?.safeBottom) || Number(detail?.viewportHeight) || 0;
  const viewportTop = comment.absoluteTop - detail.scrollY;
  const viewportBottom = viewportTop + comment.height;
  const visibleTop = Math.max(viewportTop, safeTop);
  const visibleBottom = Math.min(viewportBottom, safeBottom);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleRatio = comment.height > 0 ? Math.min(1, visibleHeight / comment.height) : 0;
  const centerY = viewportTop + comment.height / 2;
  const safeCenterY = (safeTop + safeBottom) / 2;
  const hasVisibleUpvote = comment.hasVisibleUpvote === true && Number.isFinite(comment.upvoteCenterY);
  const interactionCenterDistance = hasVisibleUpvote
    ? Math.abs(comment.upvoteCenterY - safeCenterY)
    : Math.abs(centerY - safeCenterY);
  const readableThreshold = Math.min(comment.height, 72);
  return {
    viewportTop,
    viewportBottom,
    visibleHeight,
    visibleRatio,
    centerY,
    safeCenterY,
    centerDistance: Math.abs(centerY - safeCenterY),
    hasVisibleUpvote,
    upvoteCenterY: hasVisibleUpvote ? comment.upvoteCenterY : null,
    interactionCenterDistance,
    inViewport: visibleHeight > 0,
    anchorInSafeViewport: viewportTop >= safeTop && viewportTop < safeBottom,
    readable: visibleHeight >= readableThreshold,
    fullyVisible: viewportTop >= safeTop && viewportBottom <= safeBottom,
    safeTop,
    safeBottom,
  };
}

function selectCurrentComment(detail) {
  const candidates = (detail?.comments || [])
    .map((comment) => ({ comment, viewport: commentViewportState(comment, detail) }))
    .filter(({ comment, viewport }) =>
      Boolean(canonicalCommentIdentity(comment)) &&
      viewport.inViewport &&
      viewport.readable &&
      viewport.anchorInSafeViewport);
  candidates.sort((left, right) => {
    const upvoteDifference =
      Number(right.viewport.hasVisibleUpvote) - Number(left.viewport.hasVisibleUpvote);
    if (upvoteDifference) return upvoteDifference;
    if (left.viewport.hasVisibleUpvote && right.viewport.hasVisibleUpvote) {
      const distanceDifference =
        left.viewport.interactionCenterDistance - right.viewport.interactionCenterDistance;
      if (distanceDifference) return distanceDifference;
    }
    return (
      left.viewport.viewportTop - right.viewport.viewportTop ||
      right.viewport.visibleRatio - left.viewport.visibleRatio ||
      String(left.comment.commentId).localeCompare(String(right.comment.commentId))
    );
  });
  return candidates[0] || null;
}

function publicComment(comment, viewport) {
  if (!comment) return null;
  return {
    commentId: comment.commentId,
    canonicalCommentId: canonicalCommentIdentity(comment) || null,
    commentIdAliases: commentIdentityAliases(comment),
    height: comment.height,
    viewportTop: Math.round(viewport?.viewportTop ?? 0),
    viewportBottom: Math.round(viewport?.viewportBottom ?? 0),
    visibleHeight: Math.round(viewport?.visibleHeight ?? 0),
    visibleRatio: Number((viewport?.visibleRatio || 0).toFixed(3)),
    centerDistance: Math.round(viewport?.centerDistance ?? 0),
    hasVisibleUpvote: Boolean(viewport?.hasVisibleUpvote),
    upvoteCenterY: Number.isFinite(viewport?.upvoteCenterY)
      ? Math.round(viewport.upvoteCenterY)
      : null,
    inViewport: Boolean(viewport?.inViewport),
    anchorInSafeViewport: Boolean(viewport?.anchorInSafeViewport),
    readable: Boolean(viewport?.readable),
    fullyVisible: Boolean(viewport?.fullyVisible),
    safeTop: viewport?.safeTop ?? null,
    safeBottom: viewport?.safeBottom ?? null,
  };
}

function targetOwnerCommentIdentityAliases(target) {
  const aliases = [
    ...(Array.isArray(target?.ownerIdAliases) ? target.ownerIdAliases : []),
    target?.ownerId,
    target?.ownerCanonicalId,
  ].filter(Boolean);
  for (const alias of [...aliases]) {
    const token = redditCommentToken(alias);
    if (token) aliases.push(token, `t1_${token}`);
  }
  return [...new Set(aliases.map((value) => String(value)))];
}

function targetBelongsToComment(target, comment) {
  if (target?.context !== "comment") return false;
  const commentAliases = new Set(commentIdentityAliases(comment));
  return targetOwnerCommentIdentityAliases(target).some((alias) => commentAliases.has(alias));
}

function booleanVoteSignal(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

function manualVoteState(target) {
  const pressed = booleanVoteSignal(target?.ariaPressed);
  const selected = booleanVoteSignal(target?.selected);
  const signals = [pressed, selected].filter((value) => value !== null);
  const signalConflict = signals.includes(true) && signals.includes(false);
  const signalState = signals.includes(true)
    ? "upvoted"
    : signals.includes(false)
      ? "neutral"
      : "unknown";
  const rawState = String(target?.voteState || "").toLowerCase();
  const explicitState = ["upvoted", "neutral", "downvoted", "unknown", "conflict"].includes(rawState)
    ? rawState
    : null;
  const explicitConflict =
    explicitState === "conflict" ||
    (explicitState === "upvoted" && signalState === "neutral") ||
    (["neutral", "downvoted"].includes(explicitState) && signalState === "upvoted") ||
    (explicitState === "unknown" && signalState !== "unknown");
  const conflict = Boolean(target?.voteStateConflict) || signalConflict || explicitConflict;
  return {
    state: conflict ? "conflict" : explicitState || signalState,
    conflict,
  };
}

function selectManualPostUpvoteTarget(locator, post) {
  if (locator?.pageKind !== "feed") {
    return { target: null, reason: "not-feed" };
  }
  const owned = (locator.targets || []).filter(
    (target) => target.kind === "post_upvote" && targetBelongsToPost(target, post),
  );
  if (owned.length === 0) return { target: null, reason: "upvote-not-found" };
  const highConfidence = owned.filter((target) => target.confidence === "high");
  if (highConfidence.length === 0) {
    return { target: null, reason: "upvote-low-confidence" };
  }
  if (highConfidence.length > 1) {
    return { target: null, reason: "upvote-target-ambiguous" };
  }
  const [target] = highConfidence;
  if (target.blockedReason) {
    return {
      target: null,
      reason: target.blockedReason === "promoted" ? "promoted" : "upvote-blocked",
    };
  }
  if (target.visible !== true) return { target: null, reason: "upvote-not-visible" };
  if (target.inViewport !== true) return { target: null, reason: "upvote-outside-viewport" };
  if (target.disabled === true) return { target: null, reason: "upvote-disabled" };
  if (target.occluded !== false) return { target: null, reason: "upvote-occluded" };
  if (!Number.isFinite(target.center?.x) || !Number.isFinite(target.center?.y)) {
    return { target: null, reason: "upvote-invalid-coordinates" };
  }
  return { target, reason: null };
}

function selectManualCommentUpvoteTarget(locator, comment, detail) {
  if (locator?.pageKind !== "detail") {
    return { target: null, reason: "not-detail" };
  }
  const owned = (locator.targets || []).filter(
    (target) => target.kind === "comment_upvote" && targetBelongsToComment(target, comment),
  );
  if (owned.length === 0) return { target: null, reason: "comment-upvote-not-found" };
  const highConfidence = owned.filter((target) => target.confidence === "high");
  if (highConfidence.length === 0) {
    return { target: null, reason: "comment-upvote-low-confidence" };
  }
  if (highConfidence.length > 1) {
    return { target: null, reason: "comment-upvote-target-ambiguous" };
  }
  const [target] = highConfidence;
  if (target.context !== "comment") {
    return { target: null, reason: "comment-upvote-owner-mismatch" };
  }
  if (target.blockedReason) {
    return {
      target: null,
      reason: target.blockedReason === "promoted" ? "promoted" : "comment-upvote-blocked",
    };
  }
  if (target.visible !== true) return { target: null, reason: "comment-upvote-not-visible" };
  if (target.inViewport !== true) return { target: null, reason: "comment-upvote-outside-viewport" };
  if (target.disabled !== false) return { target: null, reason: "comment-upvote-disabled" };
  if (target.occluded !== false) return { target: null, reason: "comment-upvote-occluded" };
  if (!Number.isFinite(target.center?.x) || !Number.isFinite(target.center?.y)) {
    return { target: null, reason: "comment-upvote-invalid-coordinates" };
  }
  if (
    target.center.y < Number(detail?.safeTop || 0) ||
    target.center.y >= Number(detail?.safeBottom || detail?.viewportHeight || 0)
  ) {
    return { target: null, reason: "comment-upvote-outside-safe-viewport" };
  }
  return { target, reason: null };
}

function isRedditDetail(rawUrl, expectedPostId = null) {
  try {
    const url = new URL(rawUrl);
    if (!["reddit.com", "www.reddit.com"].includes(url.hostname)) return false;
    const match = url.pathname.match(/\/comments\/([^/]+)/i);
    if (!match) return false;
    if (!expectedPostId) return true;
    const expected = redditPostToken(expectedPostId);
    return Boolean(expected) && match[1].toLowerCase() === expected;
  } catch {
    return false;
  }
}

function isSafeRedditCommentsUrl(rawUrl) {
  return isRedditDetail(rawUrl);
}

function valueFromEvaluation(result) {
  if (result?.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description || "页面脚本执行失败";
    throw new Error(message);
  }
  return result?.result?.value;
}

function publicPost(post, viewport = null) {
  if (!post) return null;
  const isPromoted = Boolean(post.isPromoted);
  const clickEligible =
    post.clickEligible === undefined
      ? !isPromoted && isSafeRedditCommentsUrl(post.permalink)
      : Boolean(post.clickEligible);
  return {
    postId: post.postId,
    title: post.title,
    postType: post.postType,
    feedIndex: post.feedIndex,
    permalink: post.permalink,
    isPromoted,
    promotionSignals: Array.isArray(post.promotionSignals) ? [...post.promotionSignals] : [],
    clickEligible,
    ineligibleReason:
      post.ineligibleReason || (isPromoted ? "promoted" : clickEligible ? null : "unsafe-or-missing-title-link"),
    textLength: post.textLength,
    height: post.height,
    visibleRatio: viewport ? Number(viewport.visibleRatio.toFixed(3)) : 0,
    fullyVisible: Boolean(viewport?.fullyVisible),
    fitPossible: Boolean(viewport?.fitPossible),
    oversized: Boolean(viewport?.oversized),
    viewportTop: viewport?.top ?? null,
    viewportBottom: viewport?.bottom ?? null,
    safeTop: viewport?.safeTop ?? null,
    safeBottom: viewport?.safeBottom ?? null,
    availableHeight: viewport?.availableHeight ?? null,
  };
}

export class BrowserSession {
  constructor({
    client = new CdpClient(),
    targetUrl = TARGET_URL,
    settleMs = 100,
    navigationTimeoutMs = NAVIGATION_TIMEOUT_MS,
    restoreTimeoutMs = RESTORE_TIMEOUT_MS,
    inputRandomIntegerFn = randomInteger,
    inputDelayFn = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {}) {
    this.client = client;
    this.targetUrl = targetUrl;
    this.settleMs = settleMs;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.restoreTimeoutMs = restoreTimeoutMs;
    this.inputRandomInteger = inputRandomIntegerFn;
    this.inputDelay = inputDelayFn;
    this.sessionId = null;
    this.targetId = null;
    this.feedSessionId = null;
    this.feedTargetId = null;
    this.createdTarget = false;
    this.pageMode = "feed";
    this.navigationContext = null;
    this.lastPostId = null;
    this.endCandidateKey = null;
    this.reportedPostIds = new Set();
    this.manualUpvoteAttemptedPostIds = new Set();
    this.manualUpvoteAttemptedCommentIds = new Set();
    this.pendingAlignment = null;
    this.scrollInputPoints = new Map();
    this.pointerPositions = new Map();
  }

  async connect(wsUrl) {
    this.createdTarget = false;
    await this.client.connect(wsUrl);
    const targets = await this.client.call("Target.getTargets");
    const matchingTargets = (targets.targetInfos || []).filter(
      (item) => item.type === "page" && isRedditHome(item.url),
    );
    const target = await this.#selectTarget(matchingTargets);

    if (!target) {
      const created = await this.client.call("Target.createTarget", {
        url: "about:blank",
        background: true,
      });
      this.targetId = created.targetId;
      this.createdTarget = true;
    } else {
      this.targetId = target.targetId;
    }

    const attached = await this.client.call("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    this.feedSessionId = attached.sessionId;
    this.feedTargetId = this.targetId;
    this.pageMode = "feed";
    this.navigationContext = null;
    await this.client.call("Page.enable", {}, this.sessionId);

    if (this.createdTarget) {
      const domReady = this.client.waitForEvent("Page.domContentEventFired", {
        sessionId: this.sessionId,
        timeoutMs: 30000,
      });
      const navigation = await this.client.call(
        "Page.navigate",
        { url: this.targetUrl },
        this.sessionId,
        30000,
      );
      if (navigation.errorText) {
        throw new Error(`Reddit 页面打开失败：${navigation.errorText}`);
      }
      await domReady;
    }

    await this.client.call(
      "Runtime.evaluate",
      {
        expression:
          "new Promise(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve())",
        awaitPromise: true,
        returnByValue: true,
      },
      this.sessionId,
      35000,
    );

    const feed = await this.#readStableFeedDom();
    const current = selectCurrentPost(feed);
    // Keep the anchor empty until the first operation. That operation aligns
    // and counts the currently visible post instead of silently skipping it.
    this.lastPostId = null;
    this.endCandidateKey = null;
    this.reportedPostIds.clear();
    this.manualUpvoteAttemptedPostIds.clear();
    this.manualUpvoteAttemptedCommentIds.clear();
    this.pendingAlignment = null;
    this.scrollInputPoints.clear();
    this.pointerPositions.clear();
    return {
      title: feed.title,
      url: feed.url,
      y: feed.scrollY,
      max: feed.maxY,
      ready: feed.ready,
      postCount: feed.posts.length,
      currentPost: current ? publicPost(current.post, current.viewport) : null,
    };
  }

  async inspect() {
    const result = await this.client.call(
      "Runtime.evaluate",
      {
        expression:
          "({ title: document.title, url: location.href, y: Math.round(window.scrollY), max: Math.max(0, Math.round(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) - window.innerHeight)), ready: document.readyState })",
        returnByValue: true,
      },
      this.sessionId,
    );
    return valueFromEvaluation(result);
  }

  // These helpers only inspect layout and optionally add a temporary outline.
  // They deliberately do not click, type, vote, comment, or submit anything.
  async locateInteractionTargets(options = {}) {
    return locateRedditInteractionTargets({
      client: this.client,
      sessionId: this.sessionId,
      ...options,
    });
  }

  async locateVoteControls(options = {}) {
    return locateRedditVoteTargets({
      client: this.client,
      sessionId: this.sessionId,
      ...options,
    });
  }

  async manualUpvoteCurrentPost({ expectedPostId } = {}) {
    const expected = String(expectedPostId || "").trim();
    const base = {
      ok: false,
      changed: false,
      alreadyUpvoted: false,
      uncertain: false,
      postId: expected || this.lastPostId || null,
      beforeState: null,
      afterState: null,
    };
    const result = (overrides = {}) => ({ ...base, ...overrides });

    if (
      this.pageMode !== "feed" ||
      !this.feedSessionId ||
      !this.feedTargetId ||
      this.sessionId !== this.feedSessionId
    ) {
      return result({ reason: "not-feed" });
    }
    if (!expected) return result({ reason: "missing-post-id" });

    const readExpectedContext = async ({ stable = true } = {}) => {
      const feed = stable
        ? await this.#readStableFeedDom(expected)
        : await this.#readFeedDom();
      if (!isRedditHome(feed.url)) return { feed, reason: "not-feed" };
      const resolved = resolveExpectedFeedPost(feed, expected);
      if (resolved.ambiguous) return { feed, reason: "post-id-ambiguous" };
      if (!resolved.post) return { feed, reason: "post-not-found" };
      const post = resolved.post;
      const current = selectCurrentPost(feed)?.post || null;
      if (!current || canonicalPostIdentity(current) !== canonicalPostIdentity(post)) {
        return {
          feed,
          post,
          current,
          reason: "current-post-mismatch",
        };
      }
      if (!this.lastPostId || !postMatchesIdentifier(post, this.lastPostId)) {
        return {
          feed,
          post,
          current,
          reason: "last-post-mismatch",
        };
      }
      if (post.isPromoted) return { feed, post, current, reason: "promoted" };
      return { feed, post, current, reason: null };
    };

    const probeTarget = async (post) => {
      const locator = await locateRedditVoteTargets({
        client: this.client,
        sessionId: this.feedSessionId,
      });
      return selectManualPostUpvoteTarget(locator, post);
    };

    let context;
    try {
      context = await readExpectedContext();
    } catch {
      return result({ reason: "feed-read-failed" });
    }
    const resolvedPostId = context.post?.postId || expected;
    if (context.reason) {
      return result({ postId: resolvedPostId, reason: context.reason });
    }
    const attemptKey = canonicalPostIdentity(context.post);
    if (!attemptKey) {
      return result({ postId: resolvedPostId, reason: "post-id-unresolved" });
    }

    let firstProbe;
    try {
      firstProbe = await probeTarget(context.post);
    } catch (error) {
      return result({
        postId: resolvedPostId,
        reason: "upvote-probe-failed" + (error?.message ? ": " + error.message : ""),
      });
    }
    if (!firstProbe.target) {
      return result({ postId: resolvedPostId, reason: firstProbe.reason });
    }
    const firstVote = manualVoteState(firstProbe.target);
    if (firstVote.state === "upvoted" && !firstVote.conflict) {
      return result({
        ok: true,
        alreadyUpvoted: true,
        postId: resolvedPostId,
        beforeState: "upvoted",
        afterState: "upvoted",
      });
    }
    if (this.manualUpvoteAttemptedPostIds.has(attemptKey)) {
      return result({
        postId: resolvedPostId,
        beforeState: firstVote.state,
        afterState: firstVote.state,
        reason: "upvote-already-attempted",
      });
    }
    if (firstVote.state !== "neutral" || firstVote.conflict) {
      return result({
        postId: resolvedPostId,
        beforeState: firstVote.state,
        afterState: firstVote.state,
        reason: firstVote.conflict ? "upvote-state-conflict" : "upvote-state-not-neutral",
      });
    }

    // Re-read both the Feed identity and the target immediately before input.
    // This prevents a stale confirmation from acting after the Feed advanced.
    await this.#settle();
    try {
      context = await readExpectedContext();
    } catch {
      return result({
        postId: resolvedPostId,
        beforeState: "neutral",
        reason: "feed-recheck-failed",
      });
    }
    if (context.reason) {
      return result({
        postId: context.post?.postId || resolvedPostId,
        beforeState: "neutral",
        reason: context.reason,
      });
    }

    let secondProbe;
    try {
      secondProbe = await probeTarget(context.post);
    } catch {
      return result({
        postId: context.post.postId,
        beforeState: "neutral",
        reason: "upvote-recheck-failed",
      });
    }
    if (!secondProbe.target) {
      return result({
        postId: context.post.postId,
        beforeState: "neutral",
        reason: secondProbe.reason,
      });
    }
    const secondVote = manualVoteState(secondProbe.target);
    if (secondVote.state === "upvoted" && !secondVote.conflict) {
      return result({
        ok: true,
        alreadyUpvoted: true,
        postId: context.post.postId,
        beforeState: "upvoted",
        afterState: "upvoted",
      });
    }
    if (secondVote.state !== "neutral" || secondVote.conflict) {
      return result({
        postId: context.post.postId,
        beforeState: secondVote.state,
        afterState: secondVote.state,
        reason: secondVote.conflict ? "upvote-state-conflict" : "upvote-state-not-neutral",
      });
    }

    this.manualUpvoteAttemptedPostIds.add(attemptKey);
    let inputState = {
      moved: false,
      pressAttempted: false,
      pressed: false,
      releaseAttempted: false,
      released: false,
    };
    try {
      inputState = await this.#dispatchManualUpvoteClick(
        secondProbe.target.center.x,
        secondProbe.target.center.y,
        this.feedSessionId,
        secondProbe.target.rect,
        async (point) => {
          const latestContext = await readExpectedContext({ stable: false });
          if (latestContext.reason) {
            return { ok: false, reason: "upvote-target-changed-before-click" };
          }
          const latestProbe = await probeTarget(latestContext.post);
          const latestVote = manualVoteState(latestProbe.target);
          const samePoint =
            Math.abs(Number(latestProbe.target?.center?.x) - point.x) <= 1 &&
            Math.abs(Number(latestProbe.target?.center?.y) - point.y) <= 1;
          return latestProbe.target &&
            latestVote.state === "neutral" &&
            !latestVote.conflict &&
            samePoint
            ? { ok: true }
            : { ok: false, reason: "upvote-target-changed-before-click" };
        },
      );
    } catch (error) {
      inputState = error?.manualClickState || inputState;
      const inputMayHaveActed = Boolean(
        inputState.pressAttempted ||
        inputState.pressed ||
        inputState.releaseAttempted ||
        inputState.released,
      );
      if (!inputMayHaveActed) {
        this.manualUpvoteAttemptedPostIds.delete(attemptKey);
      }
      return result({
        postId: context.post.postId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: inputMayHaveActed,
        reason: error?.inputAbortReason || "upvote-input-failed",
      });
    }

    await this.#settle();
    let afterContext;
    try {
      afterContext = await readExpectedContext();
    } catch {
      return result({
        postId: context.post.postId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: "upvote-verification-failed",
      });
    }
    if (afterContext.reason) {
      return result({
        postId: afterContext.post?.postId || context.post.postId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: afterContext.reason,
      });
    }

    let afterProbe;
    try {
      afterProbe = await probeTarget(afterContext.post);
    } catch {
      return result({
        postId: afterContext.post.postId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: "upvote-verification-failed",
      });
    }
    if (!afterProbe.target) {
      return result({
        postId: afterContext.post.postId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: afterProbe.reason || "upvote-verification-failed",
      });
    }
    const afterVote = manualVoteState(afterProbe.target);
    if (afterVote.state !== "upvoted" || afterVote.conflict) {
      if (!afterVote.conflict && afterVote.state !== "downvoted") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          const retryContext = await readExpectedContext();
          if (!retryContext.reason) {
            const retryProbe = await probeTarget(retryContext.post);
            if (retryProbe.target) {
              const retryVote = manualVoteState(retryProbe.target);
              if (retryVote.state === "upvoted" && !retryVote.conflict) {
                return result({
                  ok: true,
                  changed: true,
                  postId: retryContext.post.postId,
                  beforeState: "neutral",
                  afterState: "upvoted",
                });
              }
            }
          }
        } catch {}
      }
      return result({
        postId: afterContext.post.postId,
        beforeState: "neutral",
        afterState: afterVote.state,
        uncertain: true,
        reason: afterVote.conflict ? "upvote-state-conflict" : "upvote-not-confirmed",
      });
    }
    return result({
      ok: true,
      changed: true,
      postId: afterContext.post.postId,
      beforeState: "neutral",
      afterState: "upvoted",
    });
  }

  async manualUpvoteCurrentComment({ expectedCommentId } = {}) {
    const expected = String(expectedCommentId || "").trim();
    const base = {
      ok: false,
      changed: false,
      alreadyUpvoted: false,
      uncertain: false,
      commentId: expected || null,
      beforeState: null,
      afterState: null,
      reason: null,
    };
    const result = (overrides = {}) => ({ ...base, ...overrides });

    if (
      this.pageMode !== "detail" ||
      !this.navigationContext ||
      !this.sessionId ||
      this.navigationContext.detailSessionId !== this.sessionId
    ) {
      return result({ reason: "not-detail" });
    }
    if (!expected) return result({ reason: "missing-comment-id" });

    const readExpectedContext = async ({ stable = true } = {}) => {
      const detail = stable
        ? await this.#readStableDetailDom()
        : await this.#readDetailDom();
      if (
        !isRedditDetail(detail.url, this.navigationContext?.expectedPostId) ||
        detail.blocked
      ) {
        return { detail, reason: detail.blocked ? "blocked" : "not-detail" };
      }
      const resolved = resolveExpectedDetailComment(detail, expected);
      if (resolved.ambiguous) return { detail, reason: "comment-id-ambiguous" };
      if (!resolved.comment) return { detail, reason: "comment-not-found" };
      const selected = selectCurrentComment(detail);
      if (!selected) {
        return { detail, comment: resolved.comment, reason: "current-comment-unavailable" };
      }
      if (!commentMatchesIdentifier(selected.comment, resolved.comment.commentId)) {
        return {
          detail,
          comment: resolved.comment,
          current: selected,
          reason: "current-comment-mismatch",
        };
      }
      if (!selected.viewport.readable) {
        return {
          detail,
          comment: resolved.comment,
          current: selected,
          reason: "current-comment-not-readable",
        };
      }
      return {
        detail,
        comment: resolved.comment,
        current: selected,
        reason: null,
      };
    };

    const probeTarget = async (comment, detail) => {
      const locator = await locateRedditVoteTargets({
        client: this.client,
        sessionId: this.sessionId,
      });
      return selectManualCommentUpvoteTarget(locator, comment, detail);
    };

    let context;
    try {
      context = await readExpectedContext();
    } catch {
      return result({ reason: "comment-read-failed" });
    }
    // Keep the API identity stable with the monitor's explicit confirmation.
    // The DOM owner may use an equivalent t1_ / unprefixed alias.
    const resolvedCommentId = expected;
    if (context.reason) {
      return result({ commentId: resolvedCommentId, reason: context.reason });
    }
    const attemptKey = canonicalCommentIdentity(context.comment);
    if (!attemptKey) {
      return result({ commentId: resolvedCommentId, reason: "comment-id-unresolved" });
    }

    let firstProbe;
    try {
      firstProbe = await probeTarget(context.comment, context.detail);
    } catch {
      return result({ commentId: resolvedCommentId, reason: "comment-upvote-probe-failed" });
    }
    if (!firstProbe.target) {
      return result({ commentId: resolvedCommentId, reason: firstProbe.reason });
    }
    const firstVote = manualVoteState(firstProbe.target);
    if (firstVote.state === "upvoted" && !firstVote.conflict) {
      return result({
        ok: true,
        alreadyUpvoted: true,
        commentId: resolvedCommentId,
        beforeState: "upvoted",
        afterState: "upvoted",
      });
    }
    if (this.manualUpvoteAttemptedCommentIds.has(attemptKey)) {
      return result({
        commentId: resolvedCommentId,
        beforeState: firstVote.state,
        afterState: firstVote.state,
        reason: "comment-upvote-already-attempted",
      });
    }
    if (firstVote.state !== "neutral" || firstVote.conflict) {
      return result({
        commentId: resolvedCommentId,
        beforeState: firstVote.state,
        afterState: firstVote.state,
        reason: firstVote.conflict
          ? "comment-upvote-state-conflict"
          : "comment-upvote-state-not-neutral",
      });
    }

    // The monitor confirmation can become stale while Reddit reflows or the
    // comment list advances. Re-read both the current comment and its exact
    // owner-scoped control immediately before sending one physical click.
    await this.#settle();
    try {
      context = await readExpectedContext();
    } catch {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        reason: "comment-recheck-failed",
      });
    }
    if (context.reason) {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        reason: context.reason,
      });
    }

    let secondProbe;
    try {
      secondProbe = await probeTarget(context.comment, context.detail);
    } catch {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        reason: "comment-upvote-recheck-failed",
      });
    }
    if (!secondProbe.target) {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        reason: secondProbe.reason,
      });
    }
    const secondVote = manualVoteState(secondProbe.target);
    if (secondVote.state === "upvoted" && !secondVote.conflict) {
      return result({
        ok: true,
        alreadyUpvoted: true,
        commentId: resolvedCommentId,
        beforeState: "upvoted",
        afterState: "upvoted",
      });
    }
    if (secondVote.state !== "neutral" || secondVote.conflict) {
      return result({
        commentId: resolvedCommentId,
        beforeState: secondVote.state,
        afterState: secondVote.state,
        reason: secondVote.conflict
          ? "comment-upvote-state-conflict"
          : "comment-upvote-state-not-neutral",
      });
    }
    if (this.manualUpvoteAttemptedCommentIds.has(attemptKey)) {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "neutral",
        reason: "comment-upvote-already-attempted",
      });
    }

    this.manualUpvoteAttemptedCommentIds.add(attemptKey);
    let inputState = {
      moved: false,
      pressAttempted: false,
      pressed: false,
      releaseAttempted: false,
      released: false,
    };
    try {
      inputState = await this.#dispatchManualUpvoteClick(
        secondProbe.target.center.x,
        secondProbe.target.center.y,
        this.sessionId,
        secondProbe.target.rect,
        async (point) => {
          const latestContext = await readExpectedContext({ stable: false });
          if (latestContext.reason) {
            return { ok: false, reason: "comment-upvote-target-changed-before-click" };
          }
          const latestProbe = await probeTarget(latestContext.comment, latestContext.detail);
          const latestVote = manualVoteState(latestProbe.target);
          const samePoint =
            Math.abs(Number(latestProbe.target?.center?.x) - point.x) <= 1 &&
            Math.abs(Number(latestProbe.target?.center?.y) - point.y) <= 1;
          return latestProbe.target &&
            latestVote.state === "neutral" &&
            !latestVote.conflict &&
            samePoint
            ? { ok: true }
            : { ok: false, reason: "comment-upvote-target-changed-before-click" };
        },
      );
    } catch (error) {
      inputState = error?.manualClickState || inputState;
      const inputMayHaveActed = Boolean(
        inputState.pressAttempted ||
        inputState.pressed ||
        inputState.releaseAttempted ||
        inputState.released,
      );
      if (!inputMayHaveActed) {
        this.manualUpvoteAttemptedCommentIds.delete(attemptKey);
      }
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: inputMayHaveActed,
        reason: error?.inputAbortReason || "comment-upvote-input-failed",
      });
    }

    await this.#settle();
    let afterContext;
    try {
      afterContext = await readExpectedContext();
    } catch {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: "comment-upvote-verification-failed",
      });
    }
    if (afterContext.reason) {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: afterContext.reason,
      });
    }

    let afterProbe;
    try {
      afterProbe = await probeTarget(afterContext.comment, afterContext.detail);
    } catch {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: "comment-upvote-verification-failed",
      });
    }
    if (!afterProbe.target) {
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: "unknown",
        uncertain: true,
        reason: afterProbe.reason || "comment-upvote-verification-failed",
      });
    }
    const afterVote = manualVoteState(afterProbe.target);
    if (afterVote.state !== "upvoted" || afterVote.conflict) {
      if (!afterVote.conflict && afterVote.state !== "downvoted") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          const retryContext = await readExpectedContext();
          if (!retryContext.reason) {
            const retryProbe = await probeTarget(retryContext.comment, retryContext.detail);
            if (retryProbe.target) {
              const retryVote = manualVoteState(retryProbe.target);
              if (retryVote.state === "upvoted" && !retryVote.conflict) {
                return result({
                  ok: true,
                  changed: true,
                  commentId: resolvedCommentId,
                  beforeState: "neutral",
                  afterState: "upvoted",
                });
              }
            }
          }
        } catch {}
      }
      return result({
        commentId: resolvedCommentId,
        beforeState: "neutral",
        afterState: afterVote.state,
        uncertain: true,
        reason: afterVote.conflict
          ? "comment-upvote-state-conflict"
          : "comment-upvote-not-confirmed",
      });
    }
    return result({
      ok: true,
      changed: true,
      commentId: resolvedCommentId,
      beforeState: "neutral",
      afterState: "upvoted",
    });
  }

  async locateCommentControls(options = {}) {
    return locateRedditCommentTargets({
      client: this.client,
      sessionId: this.sessionId,
      ...options,
    });
  }

  async locatePostComposerControls(options = {}) {
    return locateRedditPostComposerTargets({
      client: this.client,
      sessionId: this.sessionId,
      ...options,
    });
  }

  async openCurrentPost(input = null) {
    if (this.pageMode !== "feed" || !this.feedSessionId || !this.feedTargetId) {
      throw new Error("当前页面不处于 Reddit Feed，不能打开帖子详情");
    }
    const expectedPostId = String(
      typeof input === "string"
        ? input
        : input?.expectedPostId || input?.postId || this.lastPostId || "",
    );
    if (!expectedPostId) {
      return { opened: false, reason: "missing-post-id" };
    }

    let feed = await this.#readStableFeedDom(expectedPostId);
    let post = feed.posts.find((item) => item.postId === expectedPostId) || null;
    if (!post) return { opened: false, reason: "post-not-found", postId: expectedPostId };

    const currentPublicPost = publicPost(post, postViewportState(post, feed));
    if (currentPublicPost.isPromoted) {
      return {
        opened: false,
        reason: "promoted",
        postId: expectedPostId,
        currentPost: currentPublicPost,
      };
    }
    if (!currentPublicPost.clickEligible) {
      return {
        opened: false,
        reason: currentPublicPost.ineligibleReason || "unsafe-or-missing-title-link",
        postId: expectedPostId,
        currentPost: currentPublicPost,
      };
    }

    const originalViewport = postViewportState(post, feed);
    const historyEntryId = await this.#currentHistoryEntryId(this.feedSessionId);
    const snapshot = {
      url: feed.url,
      scrollY: feed.scrollY,
      anchorPostId: expectedPostId,
      anchorViewportTop: originalViewport.top,
      lastPostId: this.lastPostId,
      pendingAlignment: this.pendingAlignment ? { ...this.pendingAlignment } : null,
      historyEntryId,
    };

    let clickTarget = await this.#readFeedClickTarget(expectedPostId, feed);
    if (clickTarget?.reason === "title-outside-safe-viewport") {
      for (let attempt = 0; attempt < MAX_ALIGNMENT_ATTEMPTS; attempt += 1) {
        post = feed.posts.find((item) => item.postId === expectedPostId) || null;
        if (!post) break;
        const alignment = alignPost(post, feed);
        if (Math.abs(alignment.distance) <= POSITION_TOLERANCE_PX) break;
        await this.#scrollWithFocus(alignment.distance, feed);
        feed = await this.#readStableFeedDom(expectedPostId);
        clickTarget = await this.#readFeedClickTarget(expectedPostId, feed);
        if (clickTarget?.ok || clickTarget?.reason !== "title-outside-safe-viewport") break;
      }
    }

    if (!clickTarget?.ok) {
      return {
        opened: false,
        reason: clickTarget?.reason || "title-not-clickable",
        postId: expectedPostId,
        currentPost: publicPost(post, post ? postViewportState(post, feed) : null),
      };
    }
    if (!isRedditDetail(clickTarget.href, expectedPostId)) {
      return { opened: false, reason: "unsafe-title-link", postId: expectedPostId };
    }

    const targetsBefore = await this.client.call("Target.getTargets");
    const beforeTargetIds = new Set(
      (targetsBefore.targetInfos || []).map((target) => target.targetId),
    );
    try {
      await this.#dispatchSafeClick(
        clickTarget.x,
        clickTarget.y,
        this.feedSessionId,
        clickTarget.rect,
        async (point) => {
          const latestFeed = await this.#readFeedDom();
          const latestTarget = await this.#readFeedClickTarget(expectedPostId, latestFeed);
          const unchanged =
            isRedditHome(latestFeed.url) &&
            latestTarget?.ok &&
            latestTarget.href === clickTarget.href &&
            Math.abs(Number(latestTarget.x) - point.x) <= 1 &&
            Math.abs(Number(latestTarget.y) - point.y) <= 1;
          return unchanged
            ? { ok: true }
            : { ok: false, reason: "title-target-changed-before-click" };
        },
      );
    } catch (error) {
      if (error?.inputAbortReason) {
        return {
          opened: false,
          reason: error.inputAbortReason,
          postId: expectedPostId,
        };
      }
      throw error;
    }
    this.navigationContext = {
      snapshot,
      feedTargetId: this.feedTargetId,
      feedSessionId: this.feedSessionId,
      detailTargetId: this.feedTargetId,
      detailSessionId: this.feedSessionId,
      navigationMode: "same-target",
      expectedPostId,
    };

    const navigation = await this.#waitForDetailNavigation(expectedPostId, beforeTargetIds);
    if (!navigation.opened) {
      if (navigation.reason === "unsafe-navigation") {
        const recovery = await this.returnToFeed().catch(() => null);
        return {
          opened: false,
          reason: navigation.reason,
          postId: expectedPostId,
          recovered: Boolean(recovery?.returned),
        };
      }
      this.navigationContext = null;
      return { opened: false, reason: navigation.reason, postId: expectedPostId };
    }

    if (navigation.navigationMode === "new-target") {
      const attached = await this.client.call("Target.attachToTarget", {
        targetId: navigation.targetId,
        flatten: true,
      });
      await this.client.call("Page.enable", {}, attached.sessionId);
      this.targetId = navigation.targetId;
      this.sessionId = attached.sessionId;
      this.navigationContext.detailTargetId = navigation.targetId;
      this.navigationContext.detailSessionId = attached.sessionId;
      this.navigationContext.navigationMode = "new-target";
    } else {
      this.targetId = this.feedTargetId;
      this.sessionId = this.feedSessionId;
    }
    this.pageMode = "detail";
    const detail = await this.#waitForDetailReady();
    if (!detail) {
      const recovery = await this.returnToFeed().catch(() => null);
      return {
        opened: false,
        reason: "detail-not-ready",
        postId: expectedPostId,
        recovered: Boolean(recovery?.returned),
      };
    }
    return {
      opened: true,
      reason: null,
      postId: expectedPostId,
      detailUrl: detail.url || navigation.url,
      title: detail.title || "",
      navigationMode: navigation.navigationMode,
    };
  }

  async locateComments() {
    this.#assertDetailMode();
    const deadline = Date.now() + Math.max(1, this.navigationTimeoutMs);
    let before = await this.#readDetailDom();
    while (
      !before.blocked &&
      !before.explicitEmpty &&
      !before.commentRoot &&
      before.comments.length === 0 &&
      Date.now() <= deadline
    ) {
      await this.#navigationSettle();
      before = await this.#readDetailDom();
    }
    if (before.blocked) {
      return this.#commentLocationResult(before, before, 0, null, {
        found: false,
        blocked: true,
        reason: "blocked",
      });
    }
    const anchorTop = before.comments[0]?.absoluteTop ?? before.commentRoot?.absoluteTop;
    if (!Number.isFinite(anchorTop)) {
      return this.#commentLocationResult(before, before, 0, null, {
        found: false,
        noComments: Boolean(before.explicitEmpty),
        loading: !before.explicitEmpty,
        reason: before.explicitEmpty ? "no-comments" : "comments-not-ready",
      });
    }

    const desiredY = Math.max(0, Math.min(before.maxY, Math.round(anchorTop - before.safeTop)));
    const distance = desiredY - before.scrollY;
    let inputMethod = null;
    if (Math.abs(distance) > POSITION_TOLERANCE_PX) {
      inputMethod = await this.#scrollWithFocus(distance, before);
    }
    const after = await this.#readStableDetailDom();
    const updatedAnchorTop = after.comments[0]?.absoluteTop ?? after.commentRoot?.absoluteTop;
    const viewportTop = Number.isFinite(updatedAnchorTop)
      ? updatedAnchorTop - after.scrollY
      : null;
    const found =
      Number.isFinite(viewportTop) &&
      viewportTop < after.safeBottom &&
      viewportTop >= after.safeTop - POSITION_TOLERANCE_PX;
    return this.#commentLocationResult(before, after, Math.abs(after.scrollY - before.scrollY), inputMethod, {
      found,
      noComments: false,
      loading: !found,
      reason: found ? null : "comment-alignment-pending",
    });
  }

  async scrollCommentStep() {
    this.#assertDetailMode();
    const before = await this.#readStableDetailDom();
    if (before.blocked) {
      const selected = selectCurrentComment(before);
      return {
        advanced: false,
        moved: false,
        atEnd: false,
        atBottom: false,
        blocked: true,
        reason: "blocked",
        actualDistance: 0,
        currentY: before.scrollY,
        maxY: before.maxY,
        currentComment: selected ? publicComment(selected.comment, selected.viewport) : null,
      };
    }
    const remaining = Math.max(0, before.maxY - before.scrollY);
    if (remaining <= POSITION_TOLERANCE_PX) {
      const selected = selectCurrentComment(before);
      return {
        advanced: false,
        moved: false,
        atEnd: true,
        atBottom: true,
        reason: "comment-end",
        actualDistance: 0,
        currentY: before.scrollY,
        maxY: before.maxY,
        currentComment: selected ? publicComment(selected.comment, selected.viewport) : null,
      };
    }

    const availableHeight = Math.max(160, before.safeBottom - before.safeTop);
    const minimumAnchorAdvance = Math.max(120, Math.round(availableHeight * 0.45));
    const currentSafeTop = before.scrollY + before.safeTop;
    const nextComment = before.comments.find(
      (comment) => comment.absoluteTop > currentSafeTop + minimumAnchorAdvance,
    );
    const pageStep = Math.max(120, availableHeight - COMMENT_OVERLAP_PX);
    const requestedDistance = nextComment
      ? Math.max(1, Math.min(pageStep, nextComment.absoluteTop - currentSafeTop))
      : Math.min(remaining, pageStep);
    let inputMethod = await this.#scrollWithFocus(requestedDistance, before);
    let after = await this.#readStableDetailDom();
    let actualDistance = Math.max(0, after.scrollY - before.scrollY);
    if (actualDistance <= NO_PROGRESS_TOLERANCE_PX && remaining > POSITION_TOLERANCE_PX) {
      inputMethod = await this.#scrollWithFocus(requestedDistance, before, true);
      after = await this.#readStableDetailDom();
      actualDistance = Math.max(0, after.scrollY - before.scrollY);
    }
    const selected = selectCurrentComment(after);
    return {
      advanced: actualDistance > NO_PROGRESS_TOLERANCE_PX,
      moved: actualDistance > NO_PROGRESS_TOLERANCE_PX,
      atEnd: after.scrollY >= Math.max(0, after.maxY - POSITION_TOLERANCE_PX),
      atBottom: after.scrollY >= Math.max(0, after.maxY - POSITION_TOLERANCE_PX),
      blocked: Boolean(after.blocked),
      reason: actualDistance > NO_PROGRESS_TOLERANCE_PX ? null : "no-scroll-progress",
      actualDistance,
      beforeY: before.scrollY,
      currentY: after.scrollY,
      maxY: after.maxY,
      commentCount: after.comments.length,
      title: after.title,
      url: after.url,
      inputMethod,
      currentComment: selected ? publicComment(selected.comment, selected.viewport) : null,
    };
  }

  async scrollComments(stepCount = null) {
    if (stepCount === null || stepCount === undefined) {
      return this.scrollCommentStep();
    }
    const count = Number(stepCount);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error("评论滚动次数必须是 1 到 50 之间的整数");
    }
    const results = [];
    for (let index = 0; index < count; index += 1) {
      const result = await this.scrollCommentStep();
      results.push(result);
      if (!result.advanced || result.atEnd || result.blocked) break;
    }
    return {
      requestedSteps: count,
      completedSteps: results.filter((result) => result.advanced).length,
      atEnd: Boolean(results.at(-1)?.atEnd),
      currentComment: results.at(-1)?.currentComment || null,
      results,
    };
  }

  async returnToFeed() {
    const context = this.navigationContext;
    if (!context) {
      if (this.pageMode === "feed") {
        const feed = await this.#readStableFeedDom();
        const current = feed.posts.find((post) => post.postId === this.lastPostId) || null;
        return {
          returned: true,
          anchorRestored: true,
          currentY: feed.scrollY,
          maxY: feed.maxY,
          title: feed.title,
          url: feed.url,
          currentPost: publicPost(current, current ? postViewportState(current, feed) : null),
        };
      }
      return { returned: false, anchorRestored: false, reason: "missing-navigation-context" };
    }

    if (context.navigationMode === "new-target") {
      if (context.detailSessionId && context.detailSessionId !== context.feedSessionId) {
        await this.client
          .call("Target.detachFromTarget", { sessionId: context.detailSessionId }, null, 3000)
          .catch(() => {});
      }
      if (context.detailTargetId && context.detailTargetId !== context.feedTargetId) {
        await this.client
          .call("Target.closeTarget", { targetId: context.detailTargetId }, null, 5000)
          .catch(() => {});
      }
    } else {
      let returnedByHistory = false;
      if (context.snapshot.historyEntryId !== null) {
        try {
          await this.client.call(
            "Page.navigateToHistoryEntry",
            { entryId: context.snapshot.historyEntryId },
            context.feedSessionId,
            10000,
          );
          returnedByHistory = true;
        } catch {
          // History API fallback below also works for Reddit's SPA routes.
        }
      }
      if (!returnedByHistory) {
        await this.client.call(
          "Runtime.evaluate",
          {
            expression: "/* reddit-flow:return-feed */ history.back(); true",
            returnByValue: true,
          },
          context.feedSessionId,
          5000,
        );
      }
    }

    this.targetId = context.feedTargetId;
    this.sessionId = context.feedSessionId;
    this.feedTargetId = context.feedTargetId;
    this.feedSessionId = context.feedSessionId;
    const feed = await this.#waitForFeedReturn(context.feedSessionId);
    if (!feed) {
      return { returned: false, anchorRestored: false, reason: "feed-return-timeout" };
    }

    const restored = await this.#restoreFeedSnapshot(feed, context.snapshot);
    this.lastPostId = context.snapshot.lastPostId || context.snapshot.anchorPostId || null;
    this.pendingAlignment = context.snapshot.pendingAlignment
      ? { ...context.snapshot.pendingAlignment }
      : null;
    this.pageMode = "feed";
    this.navigationContext = null;
    const anchor = restored.feed.posts.find(
      (post) => post.postId === context.snapshot.anchorPostId,
    );
    return {
      returned: true,
      anchorRestored: restored.anchorRestored,
      reason: restored.anchorRestored ? null : "anchor-not-found",
      currentY: restored.feed.scrollY,
      maxY: restored.feed.maxY,
      title: restored.feed.title,
      url: restored.feed.url,
      currentPost: anchor
        ? publicPost(anchor, postViewportState(anchor, restored.feed))
        : null,
    };
  }

  async scroll() {
    if (this.pageMode !== "feed") {
      throw new Error("当前处于帖子详情页，不能执行 Feed 逐帖滚动");
    }
    const initial = await this.#readStableFeedDom();
    let before = initial;
    let plan = this.#resumePendingPlan(before) || this.#planFeed(before);
    let inputMethod = null;

    // Moving near the end of the rendered feed is sometimes required to fire
    // Reddit's IntersectionObserver and request the next virtualized batch.
    // This probe is never counted as a post.
    if (plan.kind === "loading") {
      const remaining = Math.max(0, before.maxY - before.scrollY);
      if (remaining > POSITION_TOLERANCE_PX) {
        const usableHeight = Math.max(
          120,
          before.viewportHeight - before.headerBottom - 20,
        );
        const probeDistance = Math.min(
          remaining,
          Math.max(120, Math.round(usableHeight * LOADING_PROBE_RATIO)),
        );
        inputMethod = await this.#scrollWithFocus(probeDistance, before);
        before = await this.#readStableFeedDom();
        plan = this.#resumePendingPlan(before) || this.#planFeed(before);
      }
    }

    if (plan.kind === "end") {
      const endKey = [
        this.lastPostId || "",
        before.scrollY,
        before.maxY,
        before.feedBottom,
        before.posts.length,
      ].join(":");
      if (this.endCandidateKey !== endKey) {
        // The first bottom observation is a loading candidate, not a final
        // conclusion. Reddit often appends the next batch just after this.
        this.endCandidateKey = endKey;
        const refreshed = await this.#readStableFeedDom();
        const refreshedPlan = this.#resumePendingPlan(refreshed) || this.#planFeed(refreshed);
        if (refreshedPlan.kind !== "end") {
          before = refreshed;
          plan = refreshedPlan;
          this.endCandidateKey = null;
        } else {
          return this.#unavailableResult(initial, refreshed, refreshedPlan, inputMethod, false);
        }
      } else {
        return this.#unavailableResult(initial, before, plan, inputMethod, true);
      }
    }

    if (plan.kind === "loading") {
      this.endCandidateKey = null;
      return this.#unavailableResult(initial, before, plan, inputMethod, false);
    }
    this.endCandidateKey = null;
    return this.#executeAlignment(initial, before, plan, inputMethod);
  }

  async #executeAlignment(initial, before, plan, previousInputMethod) {
    const targetId = plan.post?.postId;
    const plannedTarget = before.posts.find((post) => post.postId === targetId);
    if (!plannedTarget) {
      this.lastPostId = null;
      this.pendingAlignment = null;
      return this.#alignmentPendingResult({
        initial,
        current: before,
        target: null,
        viewport: null,
        inputMethod: previousInputMethod,
        attempts: 0,
        residual: null,
        reason: "target-lost",
      });
    }

    const initialViewport = postViewportState(plannedTarget, before);
    const goal = plan.alignmentGoal || (plan.kind === "continue-post"
      ? {
          type: "segment",
          desiredReadOffset: Number.isFinite(plan.desiredReadOffset)
            ? plan.desiredReadOffset
            : Math.max(0, initialViewport.safeTop - initialViewport.top) + plan.distance,
          plannedFinal: Boolean(plan.targetSegmentFinal ?? plan.postComplete),
        }
      : { type: "post" });

    let current = before;
    let target = plannedTarget;
    let measurement = this.#measureAlignment(goal, target, current);
    let attempts = 0;
    let inputMethod = previousInputMethod;
    let forceWheel = false;
    let sawNoProgress = false;
    const deadline = Date.now() + ALIGNMENT_TIMEOUT_MS;

    while (
      !measurement.verified &&
      attempts < MAX_ALIGNMENT_ATTEMPTS &&
      Date.now() < deadline
    ) {
      const distance = measurement.correctionDistance;
      if (!Number.isFinite(distance) || Math.abs(distance) <= 1) break;

      const previousY = current.scrollY;
      const previousResidual = Math.abs(measurement.residual);
      const splitFirstCorrection =
        attempts === 1 &&
        !forceWheel &&
        this.inputRandomInteger(0, 99, "scroll-correction-split") < 50;
      const phase = attempts === 0 && !forceWheel
        ? "approach"
        : splitFirstCorrection
          ? "approach"
          : "correction";
      const inputDistance = phase === "approach"
        ? planApproachDistance(distance, this.inputRandomInteger)
        : distance;
      inputMethod = await this.#scrollWithFocus(
        inputDistance,
        current,
        forceWheel,
        phase,
      );
      attempts += 1;

      const next = await this.#readStableFeedDom(targetId);
      const nextTarget = next.posts.find((post) => post.postId === targetId);
      if (!nextTarget) {
        this.lastPostId = null;
        this.pendingAlignment = null;
        return this.#alignmentPendingResult({
          initial,
          current: next,
          target: null,
          viewport: null,
          inputMethod,
          attempts,
          residual: null,
          reason: "target-lost",
        });
      }

      const nextMeasurement = this.#measureAlignment(goal, nextTarget, next);
      const scrollProgress = Math.abs(next.scrollY - previousY);
      const residualProgress = previousResidual - Math.abs(nextMeasurement.residual);
      if (
        scrollProgress <= NO_PROGRESS_TOLERANCE_PX ||
        residualProgress <= NO_PROGRESS_TOLERANCE_PX
      ) {
        // A synthetic gesture can be accepted by CDP yet be ignored by a
        // background renderer. Retry with a CDP wheel event on the same safe
        // page coordinate; this still never moves the operating-system mouse.
        forceWheel = true;
        sawNoProgress = true;
      } else {
        forceWheel = false;
      }
      current = next;
      target = nextTarget;
      measurement = nextMeasurement;
    }

    if (!measurement.verified) {
      // Retain an identifiable pending target so the next short retry cannot
      // skip it and accidentally count the following post.
      this.lastPostId = target.postId;
      this.pendingAlignment = {
        targetId: target.postId,
        kind: plan.kind,
        goal,
      };
      const timedOut = Date.now() >= deadline;
      const reason = timedOut
        ? "alignment-timeout"
        : attempts >= MAX_ALIGNMENT_ATTEMPTS
          ? sawNoProgress
            ? "no-scroll-progress"
            : "alignment-attempt-limit"
          : "scroll-boundary";
      return this.#alignmentPendingResult({
        initial,
        current,
        target,
        viewport: measurement.viewport,
        inputMethod,
        attempts,
        residual: measurement.residual,
        reason,
      });
    }

    this.lastPostId = target.postId;
    this.pendingAlignment = null;
    const canReportPost = plan.kind !== "continue-post";
    const newPost =
      canReportPost &&
      !this.reportedPostIds.has(target.postId);
    if (newPost) this.reportedPostIds.add(target.postId);
    const actualDistance = Math.abs(current.scrollY - initial.scrollY);
    return {
      movedToPost: newPost || actualDistance > 0,
      newPost,
      scrollKind: plan.kind,
      postComplete: measurement.postComplete,
      noPostAvailable: false,
      alignmentVerified: true,
      alignmentPending: false,
      segmentReady: measurement.segmentReady,
      alignmentReason: measurement.viewport.fitPossible
        ? "fully-visible"
        : "segment-positioned",
      alignmentResidualPx: Math.round(measurement.residual),
      alignmentAttempts: attempts,
      actualDistance,
      beforeY: initial.scrollY,
      currentY: current.scrollY,
      maxY: current.maxY,
      atBottom: false,
      title: current.title,
      url: current.url,
      currentPost: publicPost(target, measurement.viewport),
      inputMethod,
    };
  }

  #measureAlignment(goal, target, feed) {
    const viewport = postViewportState(target, feed);
    if (goal.type === "segment" && !viewport.fitPossible) {
      const currentReadOffset = Math.max(0, viewport.safeTop - viewport.top);
      const residual = goal.desiredReadOffset - currentReadOffset;
      const segmentReady = Math.abs(residual) <= POSITION_TOLERANCE_PX;
      return {
        viewport,
        residual,
        correctionDistance: residual,
        verified: segmentReady,
        segmentReady,
        // If late media increased the post height, reaching the originally
        // planned segment is valid but it is no longer the final segment.
        postComplete:
          segmentReady &&
          viewport.bottom <= viewport.safeBottom + POSITION_TOLERANCE_PX,
      };
    }

    const alignment = alignPost(target, feed);
    if (viewport.fitPossible) {
      const residual = viewport.top - alignment.desiredTop;
      const aligned = Math.abs(residual) <= POSITION_TOLERANCE_PX;
      const pinnedAtBoundary =
        (residual < 0 && feed.scrollY <= POSITION_TOLERANCE_PX) ||
        (
          residual > 0 &&
          feed.scrollY >= Math.max(0, feed.maxY - POSITION_TOLERANCE_PX)
        );
      const positioned = aligned || pinnedAtBoundary;
      return {
        viewport,
        residual,
        correctionDistance: alignment.distance,
        verified: viewport.fullyVisible && positioned,
        segmentReady: false,
        postComplete: viewport.fullyVisible && positioned,
      };
    }

    const residual = viewport.top - viewport.safeTop;
    const segmentReady = Math.abs(residual) <= POSITION_TOLERANCE_PX;
    return {
      viewport,
      residual,
      correctionDistance: alignment.distance,
      verified: segmentReady,
      segmentReady,
      postComplete:
        segmentReady &&
        viewport.bottom <= viewport.safeBottom + POSITION_TOLERANCE_PX,
    };
  }

  #planFeed(feed) {
    if (this.lastPostId && !this.reportedPostIds.has(this.lastPostId)) {
      const pending = feed.posts.find((post) => post.postId === this.lastPostId);
      if (pending) {
        const alignment = alignPost(pending, feed);
        return {
          kind: "realign-post",
          post: pending,
          newPost: true,
          distance: alignment.distance,
          desiredTop: alignment.desiredTop,
          postComplete: false,
          viewport: alignment.viewport,
        };
      }
    }
    return planNextPost(feed, this.lastPostId);
  }

  #resumePendingPlan(feed) {
    const pending = this.pendingAlignment;
    if (!pending) return null;
    const post = feed.posts.find((item) => item.postId === pending.targetId);
    if (!post) {
      this.pendingAlignment = null;
      return null;
    }
    const viewport = postViewportState(post, feed);
    let distance;
    if (pending.goal.type === "segment" && !viewport.fitPossible) {
      const currentReadOffset = Math.max(0, viewport.safeTop - viewport.top);
      distance = pending.goal.desiredReadOffset - currentReadOffset;
    } else {
      distance = alignPost(post, feed).distance;
    }
    return {
      kind: pending.kind,
      post,
      newPost: pending.kind !== "continue-post",
      distance,
      postComplete: false,
      viewport,
      alignmentGoal: pending.goal,
    };
  }

  #alignmentPendingResult({
    initial,
    current,
    target,
    viewport,
    inputMethod,
    attempts,
    residual,
    reason,
  }) {
    const visible = target && viewport
      ? { post: target, viewport }
      : selectCurrentPost(current);
    return {
      movedToPost: Math.abs(current.scrollY - initial.scrollY) > 0,
      newPost: false,
      scrollKind: "alignment-pending",
      postComplete: false,
      noPostAvailable: false,
      retryable: true,
      alignmentVerified: false,
      alignmentPending: true,
      segmentReady: false,
      alignmentReason: reason,
      alignmentResidualPx: Number.isFinite(residual) ? Math.round(residual) : null,
      alignmentAttempts: attempts,
      atBottom: false,
      actualDistance: Math.abs(current.scrollY - initial.scrollY),
      beforeY: initial.scrollY,
      currentY: current.scrollY,
      maxY: current.maxY,
      title: current.title,
      url: current.url,
      currentPost: visible ? publicPost(visible.post, visible.viewport) : null,
      inputMethod,
    };
  }

  #unavailableResult(initial, current, plan, inputMethod, atBottom) {
    const post = plan.post || null;
    const renderedPost = post
      ? current.posts.find((item) => item.postId === post.postId) || null
      : null;
    const visible = renderedPost
      ? { post: renderedPost, viewport: postViewportState(renderedPost, current) }
      : selectCurrentPost(current);
    const currentPost = visible ? publicPost(visible.post, visible.viewport) : null;
    return {
      movedToPost: Math.abs(current.scrollY - initial.scrollY) > 0,
      newPost: false,
      scrollKind: plan.kind,
      postComplete: Boolean(plan.postComplete),
      noPostAvailable: true,
      alignmentVerified: false,
      alignmentPending: false,
      segmentReady: false,
      alignmentReason: plan.kind,
      alignmentResidualPx: null,
      alignmentAttempts: 0,
      atBottom,
      actualDistance: Math.abs(current.scrollY - initial.scrollY),
      beforeY: initial.scrollY,
      currentY: current.scrollY,
      maxY: current.maxY,
      title: current.title,
      url: current.url,
      currentPost,
      inputMethod,
    };
  }

  async #readFeedClickTarget(expectedPostId, feed) {
    const result = await this.client.call(
      "Runtime.evaluate",
      {
        expression: buildFeedClickTargetExpression(
          expectedPostId,
          (feed.headerBottom || 0) + 8,
          feed.safeBottom || feed.viewportHeight || 1,
        ),
        returnByValue: true,
      },
      this.feedSessionId,
      5000,
    );
    return valueFromEvaluation(result);
  }

  async #currentHistoryEntryId(sessionId) {
    try {
      const history = await this.client.call("Page.getNavigationHistory", {}, sessionId, 5000);
      const entry = history.entries?.[history.currentIndex];
      return Number.isInteger(entry?.id) ? entry.id : null;
    } catch {
      return null;
    }
  }

  async #dispatchNaturalClick(
    x,
    y,
    sessionId,
    rect = null,
    validateBeforePress = null,
  ) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("点击坐标无效");
    }
    const plan = planClickMotion({
      x,
      y,
      rect,
      randomIntegerFn: this.inputRandomInteger,
    });
    const state = {
      moved: false,
      pressAttempted: false,
      pressed: false,
      releaseAttempted: false,
      releaseAttempts: 0,
      released: false,
    };
    const releasePointer = async () => {
      state.releaseAttempted = true;
      state.releaseAttempts += 1;
      await this.client.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          ...plan.target,
          button: "left",
          buttons: 0,
          clickCount: 1,
        },
        sessionId,
        5000,
      );
      state.released = true;
    };
    try {
      await this.client.call(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
        sessionId,
        5000,
      );
      for (const point of plan.points) {
        state.moved = true;
        await this.client.call(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
          sessionId,
          5000,
        );
        this.pointerPositions.set(sessionId, { x: point.x, y: point.y });
        await this.#delayInput(point.delayMs, "click-move");
      }
      await this.#delayInput(plan.hoverMs, "click-hover");
      if (typeof validateBeforePress === "function") {
        const validation = await validateBeforePress(plan.target);
        if (!(validation === true || validation?.ok === true)) {
          const aborted = new Error(validation?.reason || "点击目标在按下前已变化");
          aborted.inputAbortReason = validation?.reason || "target-changed-before-click";
          throw aborted;
        }
      }
      state.pressAttempted = true;
      await this.client.call(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          ...plan.target,
          button: "left",
          buttons: 1,
          clickCount: 1,
        },
        sessionId,
        5000,
      );
      state.pressed = true;
      try {
        await this.#delayInput(plan.holdMs, "click-hold");
      } finally {
        await releasePointer();
      }
      await this.#delayInput(plan.releaseMs, "click-release");
      return state;
    } catch (error) {
      let cleanupError = null;
      if (state.pressAttempted && !state.released) {
        try {
          await releasePointer();
        } catch (releaseError) {
          cleanupError = releaseError;
        }
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.manualClickState = { ...state };
      if (cleanupError) wrapped.pointerReleaseError = cleanupError;
      throw wrapped;
    } finally {
      await this.client
        .call(
          "Emulation.setFocusEmulationEnabled",
          { enabled: false },
          sessionId,
          3000,
        )
        .catch(() => {});
    }
  }

  async #dispatchManualUpvoteClick(
    x,
    y,
    sessionId,
    rect = null,
    validateBeforePress = null,
  ) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("人工点赞坐标无效");
    }
    return this.#dispatchNaturalClick(x, y, sessionId, rect, validateBeforePress);
  }

  async #dispatchSafeClick(x, y, sessionId, rect = null, validateBeforePress = null) {
    return this.#dispatchNaturalClick(x, y, sessionId, rect, validateBeforePress);
  }

  async #waitForDetailNavigation(expectedPostId, beforeTargetIds) {
    const deadline = Date.now() + Math.max(1, this.navigationTimeoutMs);
    while (Date.now() <= deadline) {
      let identity = null;
      try {
        identity = await this.#readPageIdentity(this.feedSessionId);
      } catch {
        // Execution contexts disappear briefly during full navigations.
      }
      if (identity?.url && isRedditDetail(identity.url, expectedPostId)) {
        return {
          opened: true,
          navigationMode: "same-target",
          targetId: this.feedTargetId,
          url: identity.url,
        };
      }

      let targets = [];
      try {
        const response = await this.client.call("Target.getTargets", {}, null, 5000);
        targets = response.targetInfos || [];
      } catch {
        // Keep polling the original target until the bounded timeout.
      }
      const sameTarget = targets.find(
        (target) =>
          target.targetId === this.feedTargetId &&
          target.type === "page" &&
          isRedditDetail(target.url, expectedPostId),
      );
      if (sameTarget) {
        return {
          opened: true,
          navigationMode: "same-target",
          targetId: this.feedTargetId,
          url: sameTarget.url,
        };
      }
      const newTarget = targets.find(
        (target) =>
          target.type === "page" &&
          !beforeTargetIds.has(target.targetId) &&
          target.targetId !== this.feedTargetId &&
          target.openerId === this.feedTargetId &&
          isRedditDetail(target.url, expectedPostId),
      );
      if (newTarget) {
        return {
          opened: true,
          navigationMode: "new-target",
          targetId: newTarget.targetId,
          url: newTarget.url,
        };
      }

      if (identity?.url && !isRedditHome(identity.url) && identity.url !== "about:blank") {
        return { opened: false, reason: "unsafe-navigation", url: identity.url };
      }
      await this.#navigationSettle();
    }
    return { opened: false, reason: "navigation-timeout" };
  }

  async #readPageIdentity(sessionId) {
    const result = await this.client.call(
      "Runtime.evaluate",
      { expression: PAGE_IDENTITY_EXPRESSION, returnByValue: true },
      sessionId,
      5000,
    );
    return valueFromEvaluation(result);
  }

  #assertDetailMode() {
    if (this.pageMode !== "detail" || !this.navigationContext || !this.sessionId) {
      throw new Error("当前页面不处于 Reddit 帖子详情页");
    }
  }

  async #readDetailDom() {
    const result = await this.client.call(
      "Runtime.evaluate",
      { expression: buildDetailDomExpression(), returnByValue: true },
      this.sessionId,
      10000,
    );
    const value = valueFromEvaluation(result);
    if (!value || !Array.isArray(value.comments) || !isRedditDetail(value.url)) {
      throw new Error("无法识别 Reddit 帖子详情或评论结构");
    }
    return value;
  }

  async #waitForDetailReady() {
    const deadline = Date.now() + Math.max(1, this.navigationTimeoutMs);
    while (Date.now() <= deadline) {
      try {
        const detail = await this.#readDetailDom();
        if (
          detail.mainPostPresent &&
          isRedditDetail(detail.url, this.navigationContext?.expectedPostId)
        ) {
          return detail;
        }
      } catch {
        // The new execution context or the main post can still be loading.
      }
      await this.#navigationSettle();
    }
    return null;
  }

  async #readStableDetailDom() {
    let previous = await this.#readDetailDom();
    for (let sample = 1; sample < STABILITY_MAX_SAMPLES; sample += 1) {
      await this.#settle();
      const current = await this.#readDetailDom();
      if (this.#detailMeasurementsMatch(previous, current)) return current;
      previous = current;
    }
    return previous;
  }

  #detailMeasurementsMatch(left, right) {
    const close = (a, b, tolerance = 3) =>
      Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
    if (
      !close(left.scrollY, right.scrollY) ||
      !close(left.maxY, right.maxY) ||
      !close(left.safeTop, right.safeTop) ||
      !close(left.safeBottom, right.safeBottom) ||
      left.comments.length !== right.comments.length
    ) {
      return false;
    }
    const rightById = new Map(right.comments.map((comment) => [comment.commentId, comment]));
    return left.comments.every((comment) => {
      const next = rightById.get(comment.commentId);
      return next && close(comment.absoluteTop, next.absoluteTop) && close(comment.height, next.height);
    });
  }

  #commentLocationResult(before, after, actualDistance, inputMethod, overrides) {
    const selected = selectCurrentComment(after);
    const result = {
      found: false,
      noComments: false,
      loading: false,
      blocked: Boolean(after.blocked),
      reason: null,
      actualDistance,
      beforeY: before.scrollY,
      currentY: after.scrollY,
      maxY: after.maxY,
      commentCount: after.comments.length,
      title: after.title,
      url: after.url,
      inputMethod,
      currentComment: selected ? publicComment(selected.comment, selected.viewport) : null,
      ...overrides,
    };
    return {
      ...result,
      available: result.found && !result.blocked && !result.noComments,
      atBottom: after.scrollY >= Math.max(0, after.maxY - POSITION_TOLERANCE_PX),
    };
  }

  async #waitForFeedReturn(sessionId) {
    const deadline = Date.now() + Math.max(1, this.restoreTimeoutMs);
    while (Date.now() <= deadline) {
      try {
        const identity = await this.#readPageIdentity(sessionId);
        if (isRedditHome(identity?.url)) {
          return await this.#readStableFeedDom();
        }
      } catch {
        // The old execution context can vanish during a full history restore.
      }
      await this.#navigationSettle();
    }
    return null;
  }

  async #restoreFeedSnapshot(initialFeed, snapshot) {
    let feed = initialFeed;
    let anchor = feed.posts.find((post) => post.postId === snapshot.anchorPostId) || null;
    if (!anchor) {
      const rawDistance = Math.max(0, Math.min(feed.maxY, snapshot.scrollY)) - feed.scrollY;
      if (Math.abs(rawDistance) > POSITION_TOLERANCE_PX) {
        await this.#scrollWithFocus(rawDistance, feed);
      }
      await this.#navigationSettle();
      feed = await this.#readStableFeedDom(snapshot.anchorPostId);
      anchor = feed.posts.find((post) => post.postId === snapshot.anchorPostId) || null;
    }

    if (!anchor) return { feed, anchorRestored: false };
    let residual = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < MAX_ALIGNMENT_ATTEMPTS; attempt += 1) {
      anchor = feed.posts.find((post) => post.postId === snapshot.anchorPostId) || null;
      if (!anchor) return { feed, anchorRestored: false };
      const desiredY = Math.max(
        0,
        Math.min(feed.maxY, Math.round(anchor.absoluteTop - snapshot.anchorViewportTop)),
      );
      residual = desiredY - feed.scrollY;
      if (Math.abs(residual) <= POSITION_TOLERANCE_PX) break;
      await this.#scrollWithFocus(residual, feed, attempt > 0);
      feed = await this.#readStableFeedDom(snapshot.anchorPostId);
    }
    return { feed, anchorRestored: Math.abs(residual) <= POSITION_TOLERANCE_PX };
  }

  async #navigationSettle() {
    const delayMs = Math.max(10, Math.min(100, this.settleMs || 50));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async #selectTarget(candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const scored = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const target = candidates[index];
      let probeSessionId = null;
      let probe = null;
      try {
        const attached = await this.client.call(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
          null,
          5000,
        );
        probeSessionId = attached.sessionId;
        const result = await this.client.call(
          "Runtime.evaluate",
          { expression: buildTargetProbeExpression(), returnByValue: true },
          probeSessionId,
          5000,
        );
        probe = valueFromEvaluation(result);
      } catch {
        // A target can disappear while the list is being inspected. Keep it
        // as a low-priority fallback and continue probing the others.
      } finally {
        if (probeSessionId) {
          await this.client
            .call(
              "Target.detachFromTarget",
              { sessionId: probeSessionId },
              null,
              3000,
            )
            .catch(() => {});
        }
      }

      const score =
        (probe?.hasFocus ? 10_000 : 0) +
        (probe?.visibilityState === "visible" ? 1_000 : 0) +
        (probe?.readyState === "complete" ? 100 : 0) +
        Math.min(50, Number(probe?.postCount) || 0) +
        (Number(probe?.scrollY) > 0 ? 1 : 0);
      scored.push({ target, score, index });
    }

    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored[0]?.target || candidates[0];
  }

  async #scrollWithFocus(distance, feed = null, forceWheel = false, phase = "normal") {
    if (!Number.isFinite(distance) || Math.abs(distance) <= 1) return null;
    await this.client.call(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
      this.sessionId,
      5000,
    );
    try {
      return await this.#sendScrollInput(Math.round(distance), feed, forceWheel, phase);
    } finally {
      await this.client
        .call(
          "Emulation.setFocusEmulationEnabled",
          { enabled: false },
          this.sessionId,
          3000,
        )
        .catch(() => {});
    }
  }

  async #readFeedDom() {
    const result = await this.client.call(
      "Runtime.evaluate",
      { expression: buildFeedDomExpression(), returnByValue: true },
      this.sessionId,
    );
    const value = valueFromEvaluation(result);
    if (!value || !Array.isArray(value.posts)) {
      throw new Error("无法识别 Reddit 帖子结构");
    }
    return value;
  }

  async #readStableFeedDom(targetPostId = null) {
    let previous = await this.#readFeedDom();
    let stableMatches = 0;
    for (let sample = 1; sample < STABILITY_MAX_SAMPLES; sample += 1) {
      await this.#settle();
      const current = await this.#readFeedDom();
      if (this.#feedMeasurementsMatch(previous, current, targetPostId)) {
        stableMatches += 1;
        if (stableMatches >= STABILITY_REQUIRED_MATCHES) return current;
      } else {
        stableMatches = 0;
      }
      previous = current;
    }
    // Returning the freshest measurement is safer than holding a stale layout;
    // the alignment loop will still verify it and retry rather than count it.
    return previous;
  }

  #feedMeasurementsMatch(left, right, targetPostId) {
    const close = (a, b, tolerance = 2) => {
      if (!Number.isFinite(a) && !Number.isFinite(b)) return true;
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
    };
    if (
      !close(left.scrollY, right.scrollY) ||
      !close(left.documentHeight, right.documentHeight, 3) ||
      !close(left.viewportHeight, right.viewportHeight) ||
      !close(left.headerBottom, right.headerBottom) ||
      !close(left.safeBottom, right.safeBottom) ||
      !close(left.feedBottom, right.feedBottom, 3) ||
      left.posts.length !== right.posts.length
    ) {
      return false;
    }

    if (!targetPostId) {
      const rightById = new Map(right.posts.map((post) => [post.postId, post]));
      return left.posts.every((post) => {
        const next = rightById.get(post.postId);
        return (
          next &&
          close(post.absoluteTop, next.absoluteTop) &&
          close(post.height, next.height)
        );
      });
    }
    const leftPost = left.posts.find((post) => post.postId === targetPostId);
    const rightPost = right.posts.find((post) => post.postId === targetPostId);
    if (!leftPost || !rightPost) return leftPost === rightPost;
    return (
      close(leftPost.absoluteTop, rightPost.absoluteTop) &&
      close(leftPost.height, rightPost.height)
    );
  }

  #selectScrollInputPoint(feed) {
    const candidates = (Array.isArray(feed?.inputPoints) ? feed.inputPoints : [])
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      .map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));
    if (
      feed?.inputPointVerified !== false &&
      Number.isFinite(feed?.inputX) &&
      Number.isFinite(feed?.inputY)
    ) {
      const fallback = { x: Math.round(feed.inputX), y: Math.round(feed.inputY) };
      if (!candidates.some((point) => point.x === fallback.x && point.y === fallback.y)) {
        candidates.push(fallback);
      }
    }
    if (!candidates.length) return null;

    const cached = this.scrollInputPoints.get(this.sessionId);
    const retained = cached && candidates.find(
      (point) => point.x === cached.x && point.y === cached.y,
    );
    if (retained) return retained;

    const selectedIndex = candidates.length === 1
      ? 0
      : this.inputRandomInteger(0, candidates.length - 1, "scroll-input-point");
    const boundedIndex = Number.isFinite(selectedIndex)
      ? Math.max(0, Math.min(candidates.length - 1, Math.round(selectedIndex)))
      : 0;
    const selected = candidates[boundedIndex];
    this.scrollInputPoints.set(this.sessionId, selected);
    return selected;
  }

  async #movePointerTo(point) {
    const previous = this.pointerPositions.get(this.sessionId);
    if (previous && previous.x === point.x && previous.y === point.y) return;
    await this.client.call(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
      this.sessionId,
      5000,
    );
    this.pointerPositions.set(this.sessionId, { ...point });
  }

  async #sendScrollInput(distance, feed = null, forceWheel = false, phase = "normal") {
    if (!Number.isFinite(distance) || Math.abs(distance) <= 1) return null;
    let point = this.#selectScrollInputPoint(feed);
    if (!point) {
      if (feed) {
        throw new Error("页面没有可验证的主滚动输入点");
      }
      const metrics = await this.client.call("Page.getLayoutMetrics", {}, this.sessionId);
      const viewport = metrics.cssVisualViewport || metrics.visualViewport;
      point = {
        x: Math.max(1, Math.round((viewport?.clientWidth || 1000) / 2)),
        y: Math.max(1, Math.round((viewport?.clientHeight || 700) / 2)),
      };
    }
    await this.#movePointerTo(point);
    await this.#delayInput(planScrollPause(this.inputRandomInteger, phase), "scroll-pause");

    const shouldUseWheel = forceWheel;
    if (!shouldUseWheel) {
      try {
        await this.client.call(
          "Input.synthesizeScrollGesture",
          {
            x: point.x,
            y: point.y,
            xDistance: 0,
            yDistance: -distance,
            speed: planGestureSpeed(distance, this.inputRandomInteger, phase),
            gestureSourceType: "mouse",
          },
          this.sessionId,
          10000,
        );
        return "mouse-gesture";
      } catch {
        // Some browser builds do not expose synthesizeScrollGesture. The CDP
        // wheel path below works without using the operating-system pointer.
      }
    }

    const wheel = planWheelBurst(distance, this.inputRandomInteger);
    for (let index = 0; index < wheel.pulses.length; index += 1) {
      await this.client.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: 0,
          deltaY: wheel.pulses[index],
        },
        this.sessionId,
        5000,
      );
      if (index < wheel.gapsMs.length) {
        await this.#delayInput(wheel.gapsMs[index], "wheel-pulse-gap");
      }
    }
    return "mouse-wheel";
  }

  async #delayInput(delayMs, purpose) {
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await this.inputDelay(delayMs, purpose);
    }
  }

  async #settle() {
    if (this.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    }
  }

  async joinSubreddit(subredditName) {
    const cleanName = String(subredditName).trim().replace(/^\/?r\//, "").replace(/\/.*$/, "");
    if (!cleanName) throw new Error("无效的群组名称");

    const subredditUrl = `https://www.reddit.com/r/${cleanName}/`;

    try {
      const domReady = this.client.waitForEvent("Page.domContentEventFired", {
        sessionId: this.feedSessionId,
        timeoutMs: 30000,
      });
      const navigation = await this.client.call(
        "Page.navigate",
        { url: subredditUrl },
        this.feedSessionId,
        30000,
      );
      if (navigation.errorText) {
        throw new Error(`打开 r/${cleanName} 失败：${navigation.errorText}`);
      }
      await domReady;
      await new Promise((r) => setTimeout(r, 2500));

      const loginBlocked = await this.#checkSubredditBlocked();
      if (loginBlocked) {
        throw new Error(`r/${cleanName} 页面被登录墙或验证码阻塞`);
      }

      const joinInfo = await this.#findJoinButton();
      if (!joinInfo.found) {
        throw new Error(`未找到 r/${cleanName} 的关注按钮`);
      }
      if (joinInfo.joined) {
        return { ok: true, alreadyJoined: true, subreddit: cleanName };
      }

      this.pageMode = "subreddit";
      await this.#dispatchSafeClick(
        joinInfo.center.x,
        joinInfo.center.y,
        this.feedSessionId,
        joinInfo.rect,
      );
      await new Promise((r) => setTimeout(r, 3000));

      const afterInfo = await this.#findJoinButton();
      const joined = afterInfo.found && (afterInfo.joined || afterInfo.text !== joinInfo.text);
      return { ok: joined, alreadyJoined: false, subreddit: cleanName };
    } finally {
      await this.#navigateBackToFeed();
    }
  }

  async readPostContext() {
    if (this.pageMode !== "detail") return null;
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    const expr = `(() => {
      const post = document.querySelector('shreddit-post') || document.querySelector('article[data-post-id]');
      const titleEl = document.querySelector('h1') || post?.querySelector('h1') || document.querySelector('[data-testid="post-title"]');
      const bodyEl = post?.querySelector('[slot="text-body"]') || document.querySelector('[data-testid="post-text"]') || post?.querySelector('.md, .RichTextJSON');
      const subMatch = location.pathname.match(/^\\/r\\/([^/]+)/i);
      const subFromPost = post?.getAttribute('subreddit-prefixed-name')?.replace(/^r\\//i, '');
      const subFromBreadcrumb = document.querySelector('a[href^="/r/"][data-testid="subreddit-name"]')?.getAttribute('href')?.match(/\\/r\\/([^/]+)/);
      return JSON.stringify({
        title: (titleEl?.textContent || '').trim().substring(0, 500),
        body: (bodyEl?.textContent || '').trim().substring(0, 2000),
        subreddit: subMatch?.[1] || subFromPost || subFromBreadcrumb?.[1] || '',
        url: location.href,
      });
    })()`;
    try {
      const result = await this.client.call(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true },
        sessionId,
        10000,
      );
      if (result?.exceptionDetails) {
        console.error("[browser-session] readPostContext error:", result.exceptionDetails.text);
        return null;
      }
      return JSON.parse(result?.result?.value || "null");
    } catch (e) {
      console.error("[browser-session] readPostContext failed:", e.message);
      return null;
    }
  }

  async postComment(text) {
    if (!text || !text.trim()) throw new Error("评论文本为空");
    if (this.pageMode !== "detail") throw new Error("当前不在帖子详情页，无法发评论");

    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("无活动 CDP 会话");

    // Try new Reddit composer first
    const newRedditResult = await this.#tryPostCommentNewReddit(text, sessionId);
    if (newRedditResult.ok || newRedditResult.tried) return newRedditResult;

    // Fallback: use old Reddit
    return this.#tryPostCommentOldReddit(text, sessionId);
  }

  async #tryPostCommentNewReddit(text, sessionId) {
    const findCommentTarget = `(() => {
      const editors = document.querySelectorAll(
        'shreddit-composer [contenteditable="true"],' +
        '[data-testid*="comment-composer"] [contenteditable="true"],' +
        'textarea[name="body"]'
      );
      for (const el of editors) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.y > 0) {
          return JSON.stringify({ found: true, type: 'editor', tag: el.tagName, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), width: Math.round(r.width), height: Math.round(r.height) });
        }
      }
      const rteSlot = document.querySelector('shreddit-composer div[slot="rte"]');
      if (rteSlot) {
        const r = rteSlot.getBoundingClientRect();
        if (r.height > 0) return JSON.stringify({ found: true, type: 'composer-slot', x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), width: Math.round(r.width), height: Math.round(r.height) });
      }
      const composer = document.querySelector('shreddit-composer');
      if (composer) {
        const r = composer.getBoundingClientRect();
        if (r.height > 0) return JSON.stringify({ found: true, type: 'composer', x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), width: Math.round(r.width), height: Math.round(r.height) });
      }
      return JSON.stringify({ found: false });
    })()`;

    const findResult = await this.client.call("Runtime.evaluate", { expression: findCommentTarget, returnByValue: true }, sessionId, 10000);
    const targetInfo = JSON.parse(findResult?.result?.value || '{"found":false}');

    if (!targetInfo.found) {
      return { ok: false, tried: false };
    }

    try {
      await this.#dispatchSafeClick(targetInfo.x, targetInfo.y, sessionId, { x: targetInfo.x - targetInfo.width / 2, y: targetInfo.y - targetInfo.height / 2, width: targetInfo.width, height: targetInfo.height });
    } catch (e) {
      return { ok: false, tried: true, error: `点击失败: ${e.message}` };
    }
    await new Promise((r) => setTimeout(r, 1500));

    if (targetInfo.type !== "editor") {
      const editorFindResult = await this.client.call("Runtime.evaluate", { expression: findCommentTarget, returnByValue: true }, sessionId, 10000);
      const editorInfo = JSON.parse(editorFindResult?.result?.value || '{"found":false}');
      if (editorInfo.found && (editorInfo.type === "editor" || editorInfo.type === "composer-slot")) {
        try {
          await this.#dispatchSafeClick(editorInfo.x, editorInfo.y, sessionId, { x: editorInfo.x - editorInfo.width / 2, y: editorInfo.y - editorInfo.height / 2, width: editorInfo.width, height: editorInfo.height });
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    // Insert text
    try {
      await this.client.call("Input.insertText", { text }, sessionId, 8000);
    } catch (e) {
      const fallbackExpr = `(() => {
        const el = document.querySelector('shreddit-composer [contenteditable="true"]') || document.querySelector('shreddit-composer div[slot="rte"]');
        if (!el) return 'no-editor';
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(text)});
        } else {
          el.innerText = ${JSON.stringify(text)};
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`;
      const fallbackResult = await this.client.call("Runtime.evaluate", { expression: fallbackExpr, returnByValue: true }, sessionId, 5000);
      if (fallbackResult?.result?.value === "no-editor") {
        return { ok: false, tried: true, error: "文本输入失败：未找到编辑器" };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));

    // Post-insert check — verify text was actually entered
    const postInsertCheckExpr = `(() => {
      const editor = document.querySelector('shreddit-composer [contenteditable="true"]') || document.querySelector('textarea[name="body"]');
      if (!editor) return JSON.stringify({ hasContent: false, reason: "editor-disappeared" });
      const content = editor.textContent || editor.value || '';
      return JSON.stringify({ hasContent: content.trim().length > 0 });
    })()`;
    const postInsertResult = await this.client.call("Runtime.evaluate", { expression: postInsertCheckExpr, returnByValue: true }, sessionId, 5000);
    const postInsertInfo = JSON.parse(postInsertResult?.result?.value || '{"hasContent":false}');
    if (!postInsertInfo.hasContent) {
      return { ok: false, tried: true, error: `文本未成功输入编辑器（${postInsertInfo.reason || "empty"}）` };
    }

    // Find submit button in composer scope
    const findSubmitExpr = `(() => {
      const composer = document.querySelector('shreddit-composer, [data-testid*="comment-composer"]');
      const scope = composer || document;
      const buttons = [...scope.querySelectorAll('button, [role="button"]')];
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text === 'comment' || text === 'reply' || text === '评论' || text === '回复' || aria === 'comment' || aria === 'reply') && !btn.disabled) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.y > 0) {
            return JSON.stringify({ found: true, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), width: Math.round(r.width), height: Math.round(r.height), text });
          }
        }
      }
      return JSON.stringify({ found: false });
    })()`;
    const submitResult = await this.client.call("Runtime.evaluate", { expression: findSubmitExpr, returnByValue: true }, sessionId, 10000);
    const submitInfo = JSON.parse(submitResult?.result?.value || '{"found":false}');

    if (!submitInfo.found) {
      return { ok: false, tried: true, error: "未找到评论提交按钮" };
    }

    await this.#dispatchSafeClick(submitInfo.x, submitInfo.y, sessionId, { x: submitInfo.x - submitInfo.width / 2, y: submitInfo.y - submitInfo.height / 2, width: submitInfo.width, height: submitInfo.height });
    await new Promise((r) => setTimeout(r, 3000));

    // Verify — editor cleared or disappeared both indicate likely success
    const verifyExpr = `(() => {
      const editor = document.querySelector('shreddit-composer [contenteditable="true"]') || document.querySelector('textarea[name="body"]');
      if (!editor) return JSON.stringify({ cleared: true, reason: "editor-disappeared-after-submit" });
      const content = editor.textContent || editor.value || '';
      return JSON.stringify({ cleared: content.trim().length === 0 });
    })()`;
    const verifyResult = await this.client.call("Runtime.evaluate", { expression: verifyExpr, returnByValue: true }, sessionId, 5000);
    const verifyInfo = JSON.parse(verifyResult?.result?.value || '{"cleared":false}');

    return { ok: verifyInfo.cleared, tried: true, text, submitText: submitInfo.text };
  }

  async #tryPostCommentOldReddit(text, sessionId) {
    // Save original URL to navigate back after posting
    const currentUrlResult = await this.client.call("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId, 5000);
    const originalUrl = String(currentUrlResult?.result?.value || "");
    const oldUrl = originalUrl.replace("://www.reddit.com", "://old.reddit.com").replace("://reddit.com", "://old.reddit.com");

    if (!oldUrl.includes("old.reddit.com")) {
      return { ok: false, tried: true, error: "无法转换为 old.reddit.com URL" };
    }

    const domReady = this.client.call("Runtime.evaluate", {
      expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
      awaitPromise: true, returnByValue: true,
    }, sessionId, 30000);
    await this.client.call("Page.navigate", { url: oldUrl }, sessionId, 30000);
    await domReady;
    await new Promise((r) => setTimeout(r, 4000));

    // Find the main comment textarea
    const findExpr = `(() => {
      const form = document.querySelector('form.usertext.cloneable') || document.querySelector('form[id^="form-t3_"]');
      if (!form) return JSON.stringify({ found: false });
      const ta = form.querySelector('textarea[name="text"]');
      if (!ta) return JSON.stringify({ found: false });
      const r = ta.getBoundingClientRect();
      const btn = form.querySelector('button.save, button[type="submit"], input[type="submit"]');
      const btnRect = btn?.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        textareaId: ta.id,
        formId: form.id,
        btnText: btn?.textContent?.trim() || btn?.value,
        btnFound: !!btn,
      });
    })()`;
    const findResult = await this.client.call("Runtime.evaluate", { expression: findExpr, returnByValue: true }, sessionId, 10000);
    const info = JSON.parse(findResult?.result?.value || '{"found":false}');

    if (!info.found) {
      await this.#navigateBackToNewReddit(originalUrl, sessionId);
      return { ok: false, tried: true, error: "old Reddit 未找到评论表单" };
    }

    // Set textarea value
    await this.client.call("Runtime.evaluate", {
      expression: `(() => {
        const form = document.getElementById('${info.formId}');
        const ta = form.querySelector('textarea[name="text"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set';
      })()`,
      returnByValue: true,
    }, sessionId, 5000);

    await new Promise((r) => setTimeout(r, 500));

    // Click save button
    const submitResult = await this.client.call("Runtime.evaluate", {
      expression: `(() => {
        const form = document.getElementById('${info.formId}');
        const btn = form.querySelector('button.save, button[type="submit"]');
        if (btn) { btn.click(); return 'clicked'; }
        form.submit();
        return 'form-submitted';
      })()`,
      returnByValue: true,
    }, sessionId, 8000);

    await new Promise((r) => setTimeout(r, 4000));

    // Check result
    const verifyResult = await this.client.call("Runtime.evaluate", {
      expression: `(() => {
        const error = document.querySelector('.error');
        const status = document.querySelector('.status');
        return JSON.stringify({
          error: error?.textContent?.trim()?.substring(0, 100) || '',
          status: status?.textContent?.trim()?.substring(0, 50) || '',
          url: location.href.substring(0, 60),
        });
      })()`,
      returnByValue: true,
    }, sessionId, 5000);
    const verify = JSON.parse(verifyResult?.result?.value || "{}");

    // Navigate back to new Reddit
    await this.#navigateBackToNewReddit(originalUrl, sessionId);

    return {
      ok: !verify.error,
      tried: true,
      text,
      error: verify.error || undefined,
      method: "old-reddit",
    };
  }

  async #navigateBackToNewReddit(originalUrl, sessionId) {
    try {
      const newUrl = originalUrl.replace("://old.reddit.com", "://www.reddit.com");
      const domReady = this.client.call("Runtime.evaluate", {
        expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
        awaitPromise: true, returnByValue: true,
      }, sessionId, 30000);
      await this.client.call("Page.navigate", { url: newUrl }, sessionId, 30000);
      await domReady;
      await new Promise((r) => setTimeout(r, 3000));
      // navigationContext CDP target IDs are stale after page navigation — reset to force reconnection
      this.navigationContext = null;
      // Keep pageMode = "detail" and lastPostId — the URL is still the detail page
    } catch {
      // Best effort — caller will handle reconnection if needed
    }
  }

  async #findJoinButton() {
    const expression = `(() => {
      const all = [];
      function search(root) {
        root.querySelectorAll('button, [role="button"]').forEach((btn) => {
          const text = (btn.textContent || '').trim().toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text === 'join' || text === 'joined' || text === 'leave' || aria.includes('join') || aria.includes('leave')) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              all.push({
                text, aria,
                top: Math.round(r.y),
                center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
              });
            }
          }
        });
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) search(el.shadowRoot);
        });
      }
      search(document);
      if (all.length === 0) return JSON.stringify({ found: false });
      all.sort((a, b) => a.top - b.top);
      const first = all[0];
      const joined = first.text === 'joined' || first.text === 'leave' || first.aria.includes('leave') || first.aria.includes('joined');
      return JSON.stringify({ found: true, joined, text: first.text, aria: first.aria, center: first.center, rect: first.rect });
    })()`;

    const res = await this.client.call(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      this.feedSessionId,
      15000,
    );
    try {
      return JSON.parse(res?.result?.value || '{"found":false}');
    } catch {
      return { found: false };
    }
  }

  async #checkSubredditBlocked() {
    const res = await this.client.call(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const login = document.querySelector('[data-e2e="login-container"], #login-dialog');
          if (login && login.getBoundingClientRect().height > 0) return 'blocked';
          const title = document.title || '';
          if (/not found|doesn't exist|已删除|不存在/i.test(title)) return 'notfound';
          return 'ok';
        })()`,
        returnByValue: true,
      },
      this.feedSessionId,
      10000,
    );
    const status = res?.result?.value || "ok";
    if (status === "notfound") {
      throw new Error("子版块不存在或已删除");
    }
    return status === "blocked";
  }

  async #navigateBackToFeed() {
    try {
      const domReady = this.client.waitForEvent("Page.domContentEventFired", {
        sessionId: this.feedSessionId,
        timeoutMs: 30000,
      });
      await this.client.call(
        "Page.navigate",
        { url: this.targetUrl },
        this.feedSessionId,
        30000,
      );
      await domReady;
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.pageMode = "feed";
    this.lastPostId = null;
    this.navigationContext = null;
  }

  async close() {
    const detailSessionId = this.navigationContext?.detailSessionId;
    const detailTargetId = this.navigationContext?.detailTargetId;
    const navigationMode = this.navigationContext?.navigationMode;
    const sessionIds = new Set(
      [detailSessionId, this.sessionId, this.feedSessionId].filter(Boolean),
    );
    for (const sessionId of sessionIds) {
      await this.client
        .call("Target.detachFromTarget", { sessionId }, null, 3000)
        .catch(() => {});
    }
    if (
      navigationMode === "new-target" &&
      detailTargetId &&
      detailTargetId !== this.feedTargetId
    ) {
      await this.client
        .call("Target.closeTarget", { targetId: detailTargetId }, null, 3000)
        .catch(() => {});
    }
    this.client.close();
    this.sessionId = null;
    this.targetId = null;
    this.feedSessionId = null;
    this.feedTargetId = null;
    this.pageMode = "feed";
    this.navigationContext = null;
    this.lastPostId = null;
    this.endCandidateKey = null;
    this.reportedPostIds.clear();
    this.manualUpvoteAttemptedPostIds.clear();
    this.manualUpvoteAttemptedCommentIds.clear();
    this.pendingAlignment = null;
    this.scrollInputPoints.clear();
    this.pointerPositions.clear();
  }
}
