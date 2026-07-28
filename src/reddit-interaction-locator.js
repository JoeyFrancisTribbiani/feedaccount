import { buildSharedHelpers, REDDIT_SELECTORS } from "./reddit-selectors.js";

const VOTE_TARGET_KINDS = new Set(["post_upvote", "post_downvote", "comment_upvote", "comment_downvote"]);
const COMMENT_TARGET_KINDS = new Set(["comment_entry", "comment_editor", "comment_submit"]);
const POST_COMPOSER_TARGET_KINDS = new Set([
  "create_post_entry",
  "post_title_editor",
  "post_body_editor",
  "post_submit",
]);

export const REDDIT_INTERACTION_TARGET_KINDS = Object.freeze([
  ...VOTE_TARGET_KINDS,
  ...COMMENT_TARGET_KINDS,
  ...POST_COMPOSER_TARGET_KINDS,
]);

export function isRedditSubmitPath(pathname) {
  let path = String(pathname || "");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const segments = path.split("/").filter(Boolean);
  return (
    (segments.length === 1 && segments[0] === "submit") ||
    (segments.length === 3 && segments[0] === "r" && segments[2] === "submit")
  );
}

function boundedHighlightMs(value) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return 3_000;
  return Math.max(250, Math.min(30_000, Math.round(candidate)));
}

export function buildRedditInteractionLocatorExpression({
  highlight = false,
  highlightMs = 3_000,
} = {}) {
  const shouldHighlight = highlight === true;
  const safeHighlightMs = boundedHighlightMs(highlightMs);
  return `(() => {
    /* reddit-flow:readonly-interaction-locator */
    ${buildSharedHelpers()}
    const highlight = ${shouldHighlight ? "true" : "false"};
    const highlightMs = ${safeHighlightMs};
    const redditHost = ['reddit.com', 'www.reddit.com'].includes(location.hostname);
    if (!redditHost) {
      return {
        readonly: true,
        highlighted: false,
        url: location.href,
        pageKind: 'other',
        reason: 'not-reddit',
        targets: [],
      };
    }
    const candidateSelector = REDDIT_SELECTORS.interaction.candidates;
    const entries = [];

    const elementHint = (element) => {
      const tag = element.tagName.toLowerCase();
      if (element.id) return tag + '#' + element.id;
      for (const name of ['data-testid', 'action', 'noun', 'name', 'slot', 'aria-label']) {
        const value = element.getAttribute(name);
        if (value) return tag + '[' + name + '="' + value.slice(0, 120) + '"]';
      }
      return tag;
    };

    const visitRoot = (root, shadowHosts = []) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let element = walker.nextNode();
      while (element) {
        if (element.matches?.(candidateSelector)) {
          entries.push({ element, shadowHosts });
        }
        if (element.shadowRoot) {
          visitRoot(element.shadowRoot, [...shadowHosts, elementHint(element)]);
        }
        element = walker.nextNode();
      }
    };
    visitRoot(document);

    const normalized = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const booleanAttribute = (element, name) => {
      if (!element.hasAttribute?.(name)) return null;
      const raw = normalized(element.getAttribute(name));
      if (raw === '' || raw === name || raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return null;
    };
    const signatureFor = (element) => normalized([
      element.tagName,
      element.id,
      element.getAttribute('aria-label'),
      element.getAttribute('data-testid'),
      element.getAttribute('action'),
      element.getAttribute('noun'),
      element.getAttribute('name'),
      element.getAttribute('slot'),
      element.getAttribute('placeholder'),
      element.getAttribute('type'),
      element.getAttribute('data-post-click-location'),
      element.getAttribute('data-comment-click-location'),
      element.tagName === 'BUTTON' || element.tagName === 'A' ? element.textContent : '',
    ].filter(Boolean).join(' '));
    const containsAny = (text, tokens) => tokens.some((token) => text.includes(token));
    const isEditor = (element) => {
      if (element.matches?.('textarea, [contenteditable="true"], [role="textbox"]')) return true;
      if (element.tagName !== 'INPUT') return false;
      const type = normalized(element.type || 'text');
      return ['text', 'search'].includes(type);
    };
    const isButtonLike = (element) => element.matches?.(REDDIT_SELECTORS.interaction.buttonLike);
    const trimTrailingSlashes = (path) => {
      let result = String(path || '');
      while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
      return result;
    };
    const isSubmitPath = (path) => {
      const segments = trimTrailingSlashes(path).split('/').filter(Boolean);
      return (
        (segments.length === 1 && segments[0] === 'submit') ||
        (segments.length === 3 && segments[0] === 'r' && segments[2] === 'submit')
      );
    };
    const safeUrl = (raw) => {
      try {
        const url = new URL(raw, location.href);
        return ['reddit.com', 'www.reddit.com'].includes(url.hostname) ? url : null;
      } catch {
        return null;
      }
    };

    const classify = (element) => {
      const signature = signatureFor(element);
      const ownerComment = closestDeep(
        element,
        REDDIT_SELECTORS.comment.owner,
      );
      const ownerPost = closestDeep(
        element,
        REDDIT_SELECTORS.post.fallback.join(', '),
      );
      const commentComposer = closestDeep(
        element,
        REDDIT_SELECTORS.composer.comment,
      );
      const postComposer = closestDeep(
        element,
        REDDIT_SELECTORS.composer.post,
      );
      const postSubmitControl = closestDeep(
        element,
        REDDIT_SELECTORS.composer.submitButton,
      );
      const inSubmitPage = isSubmitPath(location.pathname);
      const ownerPromoted = Boolean(
        classifyPromoted(ownerPost).isPromoted,
      );
      const upvote = containsAny(signature, ['upvote', 'up vote', '赞成票', '点赞', '顶']);
      const downvote = containsAny(signature, ['downvote', 'down vote', '反对票', '点踩', '踩']);
      if ((ownerComment || ownerPost) && isButtonLike(element) && upvote && !downvote) {
        return {
          kind: ownerComment ? 'comment_upvote' : 'post_upvote',
          ownerComment,
          ownerPost,
          confidence: 'high',
          blockedReason: ownerPromoted ? 'promoted' : null,
        };
      }
      if ((ownerComment || ownerPost) && isButtonLike(element) && downvote) {
        return {
          kind: ownerComment ? 'comment_downvote' : 'post_downvote',
          ownerComment,
          ownerPost,
          confidence: 'high',
          blockedReason: ownerPromoted ? 'promoted' : null,
        };
      }

      const href = safeUrl(element.href);
      const createPostSignal =
        element.id === 'create-post' ||
        containsAny(signature, ['create post', '创建帖子', '发帖']) ||
        element.getAttribute('data-testid') === 'create-post';
      if (
        element.tagName === 'A' &&
        isSubmitPath(href?.pathname) &&
        createPostSignal &&
        !href.searchParams.has('source_id')
      ) {
        return { kind: 'create_post_entry', ownerComment, ownerPost, confidence: 'high' };
      }

      if (isEditor(element)) {
        const titleSignal = containsAny(signature, ['title', '标题']);
        const bodySignal = containsAny(signature, ['body', 'content', 'selftext', 'markdown', '正文']);
        if (inSubmitPage && postComposer && titleSignal) {
          return { kind: 'post_title_editor', ownerComment, ownerPost, confidence: 'high' };
        }
        if (
          inSubmitPage &&
          postComposer &&
          commentComposer &&
          (bodySignal || normalized(commentComposer.getAttribute('name')) === 'body')
        ) {
          return { kind: 'post_body_editor', ownerComment, ownerPost, confidence: 'high' };
        }
        if (!inSubmitPage && commentComposer) {
          return { kind: 'comment_editor', ownerComment, ownerPost, confidence: 'high' };
        }
      }

      if (isButtonLike(element)) {
        const isSubmit = element.getAttribute('type') === 'submit';
        const commentSignal = containsAny(signature, [
          'reply',
          'join the conversation',
          'add a comment',
          'write a comment',
          'leave a comment',
          '评论',
          '回复',
        ]);
        if (inSubmitPage && postComposer && postSubmitControl && (isSubmit || element.tagName === 'BUTTON')) {
          return { kind: 'post_submit', ownerComment, ownerPost, confidence: 'high' };
        }
        if (!inSubmitPage && commentComposer && (isSubmit || commentSignal)) {
          return { kind: 'comment_submit', ownerComment, ownerPost, confidence: isSubmit ? 'high' : 'medium' };
        }
        if (!inSubmitPage && commentSignal) {
          return { kind: 'comment_entry', ownerComment, ownerPost, confidence: 'medium' };
        }
      }
      return null;
    };

    const describeOwner = (element, ownerType) => {
      if (!element) return { id: null, canonicalId: null, aliases: [], type: null };
      const permalink = element.querySelector?.(REDDIT_SELECTORS.title.link)?.href || null;
      let aliases;
      let canonicalId;
      if (ownerType === 'comment') {
        const stableDomId = /^t1_[a-z0-9]+$/i.test(element.id || '') ? element.id : null;
        const stableAliases = [
          element.getAttribute('thingid'),
          element.getAttribute('data-comment-id'),
          stableDomId,
        ].filter(Boolean).map((value) => String(value));
        canonicalId = stableAliases.map(redditCommentToken).find(Boolean) || null;
        aliases = [...new Set([
          ...stableAliases,
          canonicalId,
          canonicalId ? 't1_' + canonicalId : null,
        ].filter(Boolean))];
      } else {
        aliases = [...new Set([
          element.getAttribute('thingid'),
          element.getAttribute('data-post-id'),
          element.id,
          permalink,
        ].filter(Boolean).map((value) => String(value)))];
        canonicalId = aliases
          .filter((value) => !/^t1_/i.test(value))
          .map(redditPostToken)
          .find(Boolean) || null;
      }
      return {
        id: aliases[0] || null,
        canonicalId,
        aliases,
        type: ownerType,
      };
    };
    const colors = {
      post_upvote: '#16a34a',
      post_downvote: '#dc2626',
      comment_upvote: '#22c55e',
      comment_downvote: '#ef4444',
      comment_entry: '#0ea5e9',
      comment_editor: '#0284c7',
      comment_submit: '#0369a1',
      create_post_entry: '#a855f7',
      post_title_editor: '#9333ea',
      post_body_editor: '#7e22ce',
      post_submit: '#6b21a8',
    };
    const visibilityState = (element, rect) => {
      if (rect.width <= 0 || rect.height <= 0) return { visible: false, disabledByAncestor: false };
      let current = element;
      let disabledByAncestor = false;
      while (current) {
        const style = getComputedStyle(current);
        if (
          current.hidden ||
          current.getAttribute?.('aria-hidden') === 'true' ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.01
        ) {
          return { visible: false, disabledByAncestor };
        }
        if (current.inert || current.hasAttribute?.('inert')) disabledByAncestor = true;
        if (current.parentElement) {
          current = current.parentElement;
        } else {
          const root = current.getRootNode?.();
          current = root && root.host ? root.host : null;
        }
      }
      return { visible: true, disabledByAncestor };
    };
    const targets = [];
    const seen = new Set();
    for (const { element, shadowHosts } of entries) {
      const classification = classify(element);
      if (!classification) continue;
      const rect = element.getBoundingClientRect();
      const state = visibilityState(element, rect);
      const visible = state.visible;
      const centerX = Math.round(rect.left + rect.width / 2);
      const centerY = Math.round(rect.top + rect.height / 2);
      const inViewport =
        visible &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth;
      let occluded = null;
      if (inViewport && centerX >= 0 && centerY >= 0 && centerX < innerWidth && centerY < innerHeight) {
        const root = element.getRootNode?.();
        const hit = root?.elementFromPoint?.(centerX, centerY) || document.elementFromPoint(centerX, centerY);
        occluded = Boolean(hit && hit !== element && !element.contains(hit));
      }
      const owner = describeOwner(
        classification.ownerComment || classification.ownerPost,
        classification.ownerComment ? 'comment' : classification.ownerPost ? 'post' : null,
      );
      const ownerId = owner.id;
      const ariaPressed = booleanAttribute(element, 'aria-pressed');
      const selectedSignals = [
        booleanAttribute(element, 'aria-selected'),
        booleanAttribute(element, 'data-selected'),
        booleanAttribute(element, 'selected'),
      ].filter((value) => value !== null);
      const selected = selectedSignals.includes(true) && selectedSignals.includes(false)
        ? null
        : selectedSignals[0] ?? null;
      const voteSignals = [ariaPressed, ...selectedSignals].filter((value) => value !== null);
      const voteStateConflict = voteSignals.includes(true) && voteSignals.includes(false);
      const key = [classification.kind, ownerId || '', centerX, centerY, Math.round(rect.width), Math.round(rect.height)].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      if (highlight && visible) {
        const previousOutline = element.style.outline;
        const previousOutlineOffset = element.style.outlineOffset;
        element.style.outline = '3px solid ' + (colors[classification.kind] || '#0ea5e9');
        element.style.outlineOffset = '2px';
        setTimeout(() => {
          element.style.outline = previousOutline;
          element.style.outlineOffset = previousOutlineOffset;
        }, highlightMs);
      }
      targets.push({
        kind: classification.kind,
        context: classification.ownerComment ? 'comment' : classification.ownerPost ? 'post' : 'page',
        ownerId,
        ownerCanonicalId: owner.canonicalId,
        ownerIdAliases: owner.aliases,
        confidence: classification.confidence,
        selectorHint: elementHint(element),
        shadowHosts,
        tag: element.tagName.toLowerCase(),
        text: normalized(element.innerText || element.textContent).slice(0, 120),
        ariaLabel: element.getAttribute('aria-label'),
        ariaPressed,
        selected,
        voteStateConflict,
        blockedReason: classification.blockedReason || null,
        disabled: Boolean(
          element.disabled ||
          element.matches?.(':disabled') ||
          element.getAttribute('aria-disabled') === 'true' ||
          state.disabledByAncestor
        ),
        visible,
        inViewport,
        occluded,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        center: { x: centerX, y: centerY },
      });
    }
    for (const target of targets) {
      const active = target.ariaPressed === true || target.selected === true;
      const inactive = target.ariaPressed === false || target.selected === false;
      target.voteState = target.voteStateConflict
        ? 'conflict'
        : active
        ? target.kind.endsWith('upvote') ? 'upvoted' : 'downvoted'
        : inactive
          ? 'neutral'
          : 'unknown';
    }
    targets.sort((left, right) =>
      Number(right.inViewport) - Number(left.inViewport) ||
      left.rect.y - right.rect.y ||
      left.rect.x - right.rect.x
    );
    return {
      readonly: true,
      highlighted: highlight,
      url: location.href,
      pageKind:
        trimTrailingSlashes(location.pathname).endsWith('/submit')
          ? 'submit'
          : location.pathname.includes('/comments/')
            ? 'detail'
            : location.pathname === '/'
              ? 'feed'
              : 'other',
      targets,
    };
  })()`;
}

function valueFromEvaluation(result) {
  if (result?.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description || "Reddit 定位脚本执行失败";
    throw new Error(message);
  }
  return result?.result?.value;
}

export async function locateRedditInteractionTargets({
  client,
  sessionId,
  highlight = false,
  highlightMs = 3_000,
} = {}) {
  if (!client || typeof client.call !== "function") {
    throw new Error("缺少可用的 CDP 客户端");
  }
  if (!sessionId) throw new Error("缺少 Reddit 页面会话 ID");
  const result = await client.call(
    "Runtime.evaluate",
    {
      expression: buildRedditInteractionLocatorExpression({ highlight, highlightMs }),
      returnByValue: true,
    },
    sessionId,
    10_000,
  );
  const value = valueFromEvaluation(result);
  if (!value || !Array.isArray(value.targets) || value.readonly !== true) {
    throw new Error("无法读取 Reddit 互动控件位置");
  }
  return value;
}

async function locateKinds(options, kinds) {
  const result = await locateRedditInteractionTargets(options);
  return { ...result, targets: result.targets.filter((target) => kinds.has(target.kind)) };
}

export function locateRedditVoteTargets(options) {
  return locateKinds(options, VOTE_TARGET_KINDS);
}

export function locateRedditCommentTargets(options) {
  return locateKinds(options, COMMENT_TARGET_KINDS);
}

export function locateRedditPostComposerTargets(options) {
  return locateKinds(options, POST_COMPOSER_TARGET_KINDS);
}
