import { randomInteger, TARGET_URL } from "./config.js";

const REDDIT_HOSTS = ["reddit.com", "www.reddit.com"];

export const REDDIT_SELECTORS = Object.freeze({
  post: {
    primary: 'main shreddit-post, main shreddit-ad-post',
    fallback: [
      'shreddit-post',
      'shreddit-ad-post',
      'article[data-post-id]',
      '[data-testid="post-container"]',
    ],
    allInOne:
      'main shreddit-post, main shreddit-ad-post, shreddit-post, shreddit-ad-post, article[data-post-id], [data-testid="post-container"]',
    normalize: 'shreddit-post, shreddit-ad-post',
    detail:
      'main shreddit-post[view-context*="comment" i], main shreddit-post, main article[data-post-id]',
    probe: 'main shreddit-post, shreddit-post',
  },
  comment: {
    candidates:
      'shreddit-comment[thingid^="t1_"], shreddit-comment[id^="t1_"], article[data-comment-id], [data-testid="comment"]',
    root: 'shreddit-comment-tree, #comment-tree, [data-testid="comment-tree"]',
    owner: 'shreddit-comment, article[data-comment-id], [data-testid="comment"]',
  },
  title: {
    container: '[slot="title"], h1, h2, h3',
    link: 'a[href*="/comments/"]',
    titleSlot: 'a[slot="title"][href*="/comments/"]',
  },
  promoted: {
    self: 'shreddit-ad-post, [promoted], [is-promoted], [data-promoted="true"]',
    descendants:
      '[data-testid*="promoted" i], [slot*="promoted" i], [aria-label*="promoted" i], [data-adclicklocation], a[href*="alb.reddit.com"], a[href*="/ads/"]',
    creditBar: '[slot="credit-bar"], [data-testid*="credit" i]',
    typePattern: '(?:^|[-_])(promoted|sponsored|advertisement|ad)(?:$|[-_])',
    labelPattern: '^(promoted|sponsored|advertisement|ad|推广|广告|赞助)$',
  },
  header: {
    candidates: 'reddit-header-large, header, [role="banner"], nav[aria-label*="primary" i]',
  },
  blocker: {
    emptyComments:
      '[data-testid="no-comments"], [data-testid="comments-empty"], shreddit-comment-tree[comment-count="0"]',
    login:
      '[data-testid="login-modal"], [data-testid="captcha"], [aria-label*="captcha" i], [role="dialog"] [data-testid*="login" i]',
  },
  interaction: {
    candidates:
      'button, a[href], textarea, input, [contenteditable="true"], [role="button"], [role="textbox"], shreddit-composer, faceplate-tracker',
    buttonLike: 'button, [role="button"]',
  },
  composer: {
    comment: 'shreddit-composer, [data-testid*="comment-composer"], [data-testid*="comment-submission"]',
    post: 'r-post-composer-form, [data-testid*="post-composer"], form[data-testid*="post-submit"]',
    submitButton: 'r-post-form-submit-button#submit-post-button, [data-testid="post-submit-button"]',
  },
});

const PROMOTED_TYPE_RE = new RegExp(REDDIT_SELECTORS.promoted.typePattern, "i");
const PROMOTED_LABEL_RE = new RegExp(REDDIT_SELECTORS.promoted.labelPattern, "i");

export function redditPostToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, "https://reddit.com");
    const match = parsed.pathname.match(/\/comments\/([^/]+)/i);
    if (match) return match[1].toLowerCase();
  } catch {}
  return raw.replace(/^t3_/i, "").toLowerCase();
}

export function redditCommentToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^t1_[a-z0-9]+$/i.test(raw)) return raw.replace(/^t1_/i, "").toLowerCase();
  try {
    const parsed = new URL(raw, "https://reddit.com");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex(
      (segment) => segment.toLowerCase() === "comments",
    );
    if (commentsIndex >= 0 && segments.length - commentsIndex - 1 >= 3) {
      return segments.at(-1).replace(/^t1_/i, "").toLowerCase();
    }
  } catch {}
  return raw.replace(/^t1_/i, "").toLowerCase();
}

export function postIdentityAliases(post) {
  return [
    ...new Set(
      [
        post?.postId,
        ...(Array.isArray(post?.postIdAliases) ? post.postIdAliases : []),
        post?.permalink,
      ]
        .filter(Boolean)
        .map((value) => String(value)),
    ),
  ];
}

export function canonicalPostIdentity(post) {
  const explicit = redditPostToken(post?.canonicalPostId);
  if (explicit) return explicit;
  return postIdentityAliases(post).map(redditPostToken).find(Boolean) || "";
}

export function postMatchesIdentifier(post, value) {
  const raw = String(value || "");
  if (!raw || !post) return false;
  const aliases = postIdentityAliases(post);
  if (aliases.includes(raw)) return true;
  const expected = redditPostToken(raw);
  return Boolean(expected) && aliases.some((alias) => redditPostToken(alias) === expected);
}

export function commentIdentityAliases(comment) {
  const aliases = [
    comment?.commentId,
    ...(Array.isArray(comment?.commentIdAliases) ? comment.commentIdAliases : []),
  ]
    .filter(Boolean)
    .map((value) => String(value));
  for (const alias of [...aliases]) {
    const token = redditCommentToken(alias);
    if (token) aliases.push(token, `t1_${token}`);
  }
  return [...new Set(aliases)];
}

export function canonicalCommentIdentity(comment) {
  const explicit = redditCommentToken(comment?.canonicalCommentId);
  if (explicit) return explicit;
  return commentIdentityAliases(comment).map(redditCommentToken).find(Boolean) || "";
}

export function commentMatchesIdentifier(comment, value) {
  const raw = String(value || "").trim();
  if (!raw || !comment) return false;
  const aliases = commentIdentityAliases(comment);
  if (aliases.includes(raw)) return true;
  const expected = redditCommentToken(raw);
  return Boolean(expected) && aliases.some((alias) => redditCommentToken(alias) === expected);
}

function closestDeep(start, selector) {
  let current = start;
  while (current) {
    if (current.matches?.(selector)) return current;
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      const currentRoot = current.getRootNode?.();
      current = currentRoot && currentRoot.host ? currentRoot.host : null;
    }
  }
  return null;
}

function classifyPromoted(element) {
  if (!element) return { isPromoted: false, signals: [], postType: "post" };
  const signals = [];
  if (element.matches?.(REDDIT_SELECTORS.promoted.self)) {
    signals.push("attribute");
  }
  const postType = element.getAttribute("post-type") || "post";
  if (PROMOTED_TYPE_RE.test(postType)) {
    signals.push("post-type");
  }
  if (element.querySelector?.(REDDIT_SELECTORS.promoted.descendants)) {
    signals.push("descendant");
  }
  const creditText = (
    element.querySelector?.(REDDIT_SELECTORS.promoted.creditBar)?.textContent || ""
  ).trim();
  if (PROMOTED_LABEL_RE.test(creditText)) {
    signals.push("label");
  }
  return { isPromoted: signals.length > 0, signals, postType };
}

function extractTitleLink(element) {
  const titleContainer = element.querySelector?.(REDDIT_SELECTORS.title.container);
  return (
    (titleContainer?.matches?.(REDDIT_SELECTORS.title.link) ? titleContainer : null) ||
    titleContainer?.querySelector?.(REDDIT_SELECTORS.title.link) ||
    element.querySelector?.(
      REDDIT_SELECTORS.title.titleSlot + ", " + REDDIT_SELECTORS.title.link,
    )
  );
}

function extractPostId(element, permalink, isPromoted) {
  return (
    element.id ||
    element.getAttribute("data-post-id") ||
    element.getAttribute("thingid") ||
    element.getAttribute("data-ad-id") ||
    permalink ||
    (isPromoted
      ? "promoted:" +
        (element.getAttribute("feedindex") ||
          Math.round((element.getBoundingClientRect().top || 0) + scrollY))
      : "")
  );
}

function isSafeRedditUrl(href) {
  try {
    const parsed = new URL(href, location.href);
    return (
      REDDIT_HOSTS.includes(parsed.hostname) &&
      parsed.pathname.includes("/comments/")
    );
  } catch {
    return false;
  }
}

export function buildSharedHelpers() {
  return `
    const REDDIT_SELECTORS = ${JSON.stringify(REDDIT_SELECTORS)};
    const REDDIT_HOSTS = ${JSON.stringify(REDDIT_HOSTS)};
    const PROMOTED_TYPE_RE = new RegExp(REDDIT_SELECTORS.promoted.typePattern, 'i');
    const PROMOTED_LABEL_RE = new RegExp(REDDIT_SELECTORS.promoted.labelPattern, 'i');
    ${redditPostToken}
    ${redditCommentToken}
    ${closestDeep}
    ${classifyPromoted}
    ${extractTitleLink}
    ${extractPostId}
    ${isSafeRedditUrl}
  `.trim();
}

export function buildFeedDomExpression() {
  return `(() => {
    /* reddit-flow:feed-dom */
    ${buildSharedHelpers()}
    const primary = [...document.querySelectorAll(REDDIT_SELECTORS.post.primary)];
    const candidates = primary.length
      ? primary
      : REDDIT_SELECTORS.post.fallback.flatMap((s) => [...document.querySelectorAll(s)]);
    const seen = new Set();
    const posts = [];
    for (const rawElement of candidates) {
      const element = rawElement.closest?.(REDDIT_SELECTORS.post.normalize) || rawElement;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const { isPromoted, signals: promotionSignals, postType } = classifyPromoted(element);
      if (
        rect.height < 80 ||
        rect.width < Math.min(220, innerWidth * 0.55) ||
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        continue;
      }
      const titleLink = extractTitleLink(element);
      const permalink = titleLink?.href || element.querySelector?.(REDDIT_SELECTORS.title.link)?.href || "";
      const safePermalink = isSafeRedditUrl(permalink);
      const postId = extractPostId(element, permalink, isPromoted);
      const postIdAliases = [...new Set([
        element.getAttribute("thingid"),
        element.getAttribute("data-post-id"),
        element.id,
        permalink,
      ].filter(Boolean).map((value) => String(value)))];
      const canonicalPostId =
        postIdAliases.map(redditPostToken).find(Boolean) ||
        redditPostToken(postId);
      if (!postId || seen.has(postId)) continue;
      seen.add(postId);
      const rawFeedIndex = Number(element.getAttribute("feedindex"));
      const clickEligible = !isPromoted && safePermalink && Boolean(titleLink);
      const titleContainer = element.querySelector?.(REDDIT_SELECTORS.title.container);
      posts.push({
        postId,
        canonicalPostId,
        postIdAliases,
        title: (element.getAttribute("post-title") || titleContainer?.textContent || "").trim(),
        postType,
        feedIndex: Number.isFinite(rawFeedIndex) && rawFeedIndex > 0
          ? rawFeedIndex
          : posts.length + 1,
        permalink,
        isPromoted,
        promotionSignals,
        clickEligible,
        ineligibleReason: isPromoted ? "promoted" : clickEligible ? null : "unsafe-or-missing-title-link",
        textLength: (element.innerText || element.textContent || "").trim().length,
        absoluteTop: Math.round(rect.top + scrollY),
        height: Math.round(rect.height),
      });
    }
    posts.sort((left, right) => left.absoluteTop - right.absoluteTop);

    const headerCandidates = [...document.querySelectorAll(REDDIT_SELECTORS.header.candidates)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const isRedditHeader = element.matches("reddit-header-large");
        return (
          !element.closest("main") &&
          (style.position === "fixed" || style.position === "sticky") &&
          rect.top <= 4 &&
          rect.bottom > 0 &&
          rect.height > 0 &&
          rect.height < 180 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width >= innerWidth * (isRedditHeader ? 0.5 : 0.7)
        );
      });
    const rawHeaderBottom = Math.max(
      0,
      ...headerCandidates.map((element) => Math.round(element.getBoundingClientRect().bottom)),
    );
    const headerBottom = Math.min(rawHeaderBottom, Math.round(innerHeight * 0.4));

    const bottomCandidates = [...document.querySelectorAll("body *")]
      .filter((element) => {
        if (element.closest("main") || headerCandidates.includes(element)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          (style.position === "fixed" || style.position === "sticky") &&
          rect.bottom >= innerHeight - 4 &&
          rect.top > headerBottom &&
          rect.top < innerHeight &&
          rect.height > 0 &&
          rect.height <= Math.min(320, innerHeight * 0.4) &&
          rect.width >= innerWidth * 0.65 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0.01
        );
      });
    const obstructionTop = bottomCandidates.length
      ? Math.min(...bottomCandidates.map((element) => element.getBoundingClientRect().top))
      : innerHeight;
    const bottomPadding = Math.max(
      12,
      Math.min(
        Math.round(innerHeight * 0.4),
        Math.ceil(innerHeight - obstructionTop) + (obstructionTop < innerHeight ? 8 : 0),
      ),
    );
    const safeBottom = Math.max(headerBottom + 9, Math.round(innerHeight - bottomPadding));

    const root = document.scrollingElement || document.documentElement;
    const mainRect = document.querySelector("main")?.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const inputRect = mainRect && mainRect.width > 100 ? mainRect : rootRect;
    const preferredInputY = Math.max(
      headerBottom + 8,
      Math.min(safeBottom - 1, Math.round((headerBottom + 8 + safeBottom) / 2)),
    );
    const candidateXs = [
      inputRect.left + inputRect.width / 2,
      inputRect.left + 16,
      inputRect.right - 16,
      innerWidth / 2,
    ].map((value) => Math.max(8, Math.min(innerWidth - 8, Math.round(value))));
    const deepestElementFromPoint = (scope, x, y) => {
      let element = scope?.elementFromPoint?.(x, y) || null;
      const visited = new Set();
      while (element?.shadowRoot?.elementFromPoint && !visited.has(element)) {
        visited.add(element);
        const nested = element.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === element) break;
        element = nested;
      }
      return element;
    };
    const composedParent = (element) => {
      if (element?.parentElement) return element.parentElement;
      const scope = element?.getRootNode?.();
      return scope?.host || null;
    };
    const isRootScrollPoint = (x, y) => {
      let element = deepestElementFromPoint(document, x, y);
      if (!element || element.matches("iframe, object, embed")) return false;
      while (element && element !== root && element !== document.body && element !== document.documentElement) {
        const style = getComputedStyle(element);
        const scrollable =
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2;
        if (scrollable) return false;
        element = composedParent(element);
      }
      return element === root || element === document.body || element === document.documentElement;
    };
    const inputSpan = Math.max(0, safeBottom - 1 - (headerBottom + 8));
    const candidateYs = [
      preferredInputY,
      headerBottom + 8 + inputSpan / 3,
      headerBottom + 8 + (inputSpan * 2) / 3,
    ].map((value) => Math.max(headerBottom + 8, Math.min(safeBottom - 1, Math.round(value))));
    const inputPoints = [];
    const inputPointKeys = new Set();
    for (const y of [...new Set(candidateYs)]) {
      for (const x of [...new Set(candidateXs)]) {
        const key = x + ":" + y;
        if (!inputPointKeys.has(key) && isRootScrollPoint(x, y)) {
          inputPointKeys.add(key);
          inputPoints.push({ x, y });
        }
      }
    }
    const inputX = inputPoints[0]?.x ?? null;
    const inputY = inputPoints[0]?.y ?? null;
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    );
    return {
      title: document.title,
      url: location.href,
      ready: document.readyState,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      scrollY: Math.round(scrollY),
      maxY: Math.max(0, Math.round(documentHeight - innerHeight)),
      documentHeight: Math.round(documentHeight),
      viewportWidth: Math.round(innerWidth),
      viewportHeight: Math.round(innerHeight),
      headerBottom,
      bottomPadding,
      safeBottom,
      inputX,
      inputY,
      inputPoints,
      inputPointVerified: inputPoints.length > 0,
      feedBottom: posts.length
        ? Math.max(...posts.map((post) => post.absoluteTop + post.height))
        : 0,
      posts,
    };
  })()`;
}

export function buildDetailDomExpression() {
  return `(() => {
    /* reddit-flow:detail-dom */
    ${buildSharedHelpers()}
    const headerCandidates = [...document.querySelectorAll(REDDIT_SELECTORS.header.candidates)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          !element.closest("main") &&
          (style.position === "fixed" || style.position === "sticky") &&
          rect.top <= 4 && rect.bottom > 0 && rect.height > 0 && rect.height < 180 &&
          rect.width >= innerWidth * 0.5 && style.display !== "none" && style.visibility !== "hidden"
        );
      });
    const headerBottom = Math.min(
      Math.round(innerHeight * 0.4),
      Math.max(0, ...headerCandidates.map((element) => Math.round(element.getBoundingClientRect().bottom))),
    );
    const safeTop = Math.min(innerHeight - 1, headerBottom + 8);
    const safeBottom = Math.max(safeTop + 1, innerHeight - 12);
    const root = document.scrollingElement || document.documentElement;
    const mainPost = document.querySelector(REDDIT_SELECTORS.post.detail);
    const commentRoot = document.querySelector(REDDIT_SELECTORS.comment.root);
    const commentCandidates = [...document.querySelectorAll(REDDIT_SELECTORS.comment.candidates)];

    const visibleUpvoteCentersByComment = (() => {
      const controls = [];
      const visit = (scope) => {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
        let candidate = walker.nextNode();
        while (candidate) {
          if (candidate.shadowRoot) visit(candidate.shadowRoot);
          if (candidate.matches?.(REDDIT_SELECTORS.interaction.buttonLike)) controls.push(candidate);
          candidate = walker.nextNode();
        }
      };
      visit(document);
      const result = new Map();
      for (const control of controls) {
        const ownerComment = closestDeep(control, REDDIT_SELECTORS.comment.owner);
        if (!ownerComment) continue;
        const signature = [
          control.id,
          control.getAttribute('aria-label'),
          control.getAttribute('data-testid'),
          control.getAttribute('action'),
          control.getAttribute('noun'),
          control.getAttribute('name'),
          control.getAttribute('slot'),
          control.textContent,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!signature.includes('upvote') || signature.includes('downvote')) continue;
        const rect = control.getBoundingClientRect();
        const centerX = Math.round(rect.left + rect.width / 2);
        const centerY = Math.round(rect.top + rect.height / 2);
        if (
          rect.width <= 0 || rect.height <= 0 ||
          centerX < 0 || centerX >= innerWidth ||
          centerY < safeTop || centerY >= safeBottom
        ) {
          continue;
        }
        let visible = true;
        let current = control;
        while (current) {
          const currentStyle = getComputedStyle(current);
          if (
            current.hidden || current.getAttribute?.('aria-hidden') === 'true' ||
            currentStyle.display === 'none' || currentStyle.visibility === 'hidden' ||
            Number.parseFloat(currentStyle.opacity || '1') <= 0.01
          ) {
            visible = false;
            break;
          }
          if (current.parentElement) {
            current = current.parentElement;
          } else {
            const currentRoot = current.getRootNode?.();
            current = currentRoot && currentRoot.host ? currentRoot.host : null;
          }
        }
        if (!visible) continue;
        const controlRoot = control.getRootNode?.();
        const hit = controlRoot?.elementFromPoint?.(centerX, centerY) || document.elementFromPoint(centerX, centerY);
        if (hit && hit !== control && !control.contains(hit)) continue;
        if (!result.has(ownerComment)) result.set(ownerComment, []);
        result.get(ownerComment).push(centerY);
      }
      return result;
    })();

    const seen = new Set();
    const comments = [];
    for (const element of commentCandidates) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const thingId = element.getAttribute("thingid");
      const dataCommentId = element.getAttribute("data-comment-id");
      const stableDomId = /^t1_[a-z0-9]+$/i.test(element.id || "") ? element.id : null;
      const baseAliases = [thingId, dataCommentId, stableDomId].filter(Boolean).map((value) => String(value));
      const canonicalCommentId = baseAliases.map(redditCommentToken).find(Boolean) || null;
      const commentIdAliases = [...new Set([
        ...baseAliases,
        canonicalCommentId,
        canonicalCommentId ? 't1_' + canonicalCommentId : null,
      ].filter(Boolean))];
      const commentId = commentIdAliases[0] || null;
      if (!commentId || !canonicalCommentId || seen.has(canonicalCommentId) || rect.height < 20 || style.display === "none" || style.visibility === "hidden") {
        continue;
      }
      seen.add(canonicalCommentId);
      const upvoteCenters = [...(visibleUpvoteCentersByComment.get(element) || [])];
      const safeCenterY = (safeTop + safeBottom) / 2;
      const upvoteCenterY = upvoteCenters.sort(
        (left, right) => Math.abs(left - safeCenterY) - Math.abs(right - safeCenterY)
      )[0] ?? null;
      comments.push({
        commentId,
        canonicalCommentId,
        commentIdAliases,
        absoluteTop: Math.round(rect.top + scrollY),
        height: Math.round(rect.height),
        hasVisibleUpvote: Number.isFinite(upvoteCenterY),
        upvoteCenterY,
      });
    }
    comments.sort((left, right) => left.absoluteTop - right.absoluteTop);
    const rootRect = commentRoot?.getBoundingClientRect() || null;
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    );
    const explicitEmpty = Boolean(document.querySelector(REDDIT_SELECTORS.blocker.emptyComments));
    const blocker = document.querySelector(REDDIT_SELECTORS.blocker.login);

    const preferredInputY = Math.max(safeTop, Math.min(safeBottom - 1, Math.round((safeTop + safeBottom) / 2)));
    const mainRect = document.querySelector("main")?.getBoundingClientRect();
    const inputRect = mainRect && mainRect.width > 100 ? mainRect : root.getBoundingClientRect();
    const candidateXs = [
      inputRect.left + inputRect.width / 2,
      inputRect.left + 16,
      inputRect.right - 16,
      innerWidth / 2,
    ].map((value) => Math.max(8, Math.min(innerWidth - 8, Math.round(value))));
    const deepestElementFromPoint = (scope, x, y) => {
      let element = scope?.elementFromPoint?.(x, y) || null;
      const visited = new Set();
      while (element?.shadowRoot?.elementFromPoint && !visited.has(element)) {
        visited.add(element);
        const nested = element.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === element) break;
        element = nested;
      }
      return element;
    };
    const composedParent = (element) => {
      if (element?.parentElement) return element.parentElement;
      const scope = element?.getRootNode?.();
      return scope?.host || null;
    };
    const isRootScrollPoint = (x, y) => {
      let element = deepestElementFromPoint(document, x, y);
      if (!element || element.matches("iframe, object, embed")) return false;
      while (element && element !== root && element !== document.body && element !== document.documentElement) {
        const style = getComputedStyle(element);
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2
        ) {
          return false;
        }
        element = composedParent(element);
      }
      return element === root || element === document.body || element === document.documentElement;
    };
    const inputSpan = Math.max(0, safeBottom - 1 - safeTop);
    const candidateYs = [
      preferredInputY,
      safeTop + inputSpan / 3,
      safeTop + (inputSpan * 2) / 3,
    ].map((value) => Math.max(safeTop, Math.min(safeBottom - 1, Math.round(value))));
    const inputPoints = [];
    const inputPointKeys = new Set();
    for (const y of [...new Set(candidateYs)]) {
      for (const x of [...new Set(candidateXs)]) {
        const key = x + ":" + y;
        if (!inputPointKeys.has(key) && isRootScrollPoint(x, y)) {
          inputPointKeys.add(key);
          inputPoints.push({ x, y });
        }
      }
    }
    const inputX = inputPoints[0]?.x ?? null;
    const inputY = inputPoints[0]?.y ?? null;
    return {
      title: document.title,
      url: location.href,
      ready: document.readyState,
      scrollY: Math.round(scrollY),
      maxY: Math.max(0, Math.round(documentHeight - innerHeight)),
      viewportWidth: Math.round(innerWidth),
      viewportHeight: Math.round(innerHeight),
      headerBottom,
      safeTop,
      safeBottom,
      inputX,
      inputY,
      inputPoints,
      inputPointVerified: inputPoints.length > 0,
      mainPostPresent: Boolean(mainPost),
      commentRoot: rootRect ? {
        absoluteTop: Math.round(rootRect.top + scrollY),
        height: Math.round(rootRect.height),
      } : null,
      comments,
      explicitEmpty,
      blocked: Boolean(blocker),
    };
  })()`;
}

export function buildFeedClickTargetExpression(expectedPostId, safeTop, safeBottom) {
  const expected = JSON.stringify(String(expectedPostId || ""));
  const top = Math.max(0, Math.round(Number(safeTop) || 0));
  const bottom = Math.max(top + 1, Math.round(Number(safeBottom) || top + 1));
  return `(() => {
    /* reddit-flow:feed-open-target */
    ${buildSharedHelpers()}
    const expectedPostId = ${expected};
    const candidates = [...document.querySelectorAll(REDDIT_SELECTORS.post.allInOne)];
    const seen = new Set();
    for (const rawElement of candidates) {
      const element = rawElement.closest?.(REDDIT_SELECTORS.post.normalize) || rawElement;
      if (seen.has(element)) continue;
      seen.add(element);
      const { isPromoted, signals: promotionSignals } = classifyPromoted(element);
      const titleLink = extractTitleLink(element);
      const permalink = titleLink?.href || element.querySelector?.(REDDIT_SELECTORS.title.link)?.href || '';
      const rect = element.getBoundingClientRect();
      const postId = extractPostId(element, permalink, promotionSignals.length > 0);
      if (postId !== expectedPostId) continue;
      if (promotionSignals.length) {
        return { ok: false, reason: 'promoted', postId, isPromoted: true, promotionSignals };
      }
      if (!titleLink) return { ok: false, reason: 'missing-title-link', postId, isPromoted: false };
      let parsed;
      try {
        parsed = new URL(titleLink.href, location.href);
      } catch {
        return { ok: false, reason: 'unsafe-title-link', postId, isPromoted: false };
      }
      if (!isSafeRedditUrl(titleLink.href)) {
        return { ok: false, reason: 'unsafe-title-link', postId, isPromoted: false };
      }
      const linkRect = titleLink.getBoundingClientRect();
      const x = Math.round(linkRect.left + linkRect.width / 2);
      const y = Math.round(linkRect.top + linkRect.height / 2);
      if (
        linkRect.width < 4 || linkRect.height < 4 ||
        linkRect.top < ${top} - 2 || linkRect.bottom > ${bottom} + 2 ||
        x < 1 || x >= innerWidth || y < 1 || y >= innerHeight
      ) {
        return { ok: false, reason: 'title-outside-safe-viewport', postId, isPromoted: false };
      }
      const hit = document.elementFromPoint(x, y);
      const hitAnchor = hit?.closest?.('a[href]') || null;
      let samePostOverlay = false;
      if (
        hitAnchor &&
        element.contains(hitAnchor) &&
        hitAnchor.getAttribute('slot') === 'full-post-link'
      ) {
        try {
          const hitUrl = new URL(hitAnchor.href, location.href);
          samePostOverlay =
            hitUrl.hostname === parsed.hostname &&
            hitUrl.pathname === parsed.pathname &&
            hitUrl.search === parsed.search;
        } catch {}
      }
      if (
        !hit ||
        !(
          hit === titleLink ||
          titleLink.contains(hit) ||
          hitAnchor === titleLink ||
          samePostOverlay
        )
      ) {
        return { ok: false, reason: 'title-obscured', postId, isPromoted: false };
      }
      return {
        ok: true,
        reason: null,
        postId,
        isPromoted: false,
        href: parsed.href,
        x,
        y,
        rect: {
          x: Math.round(linkRect.left),
          y: Math.round(linkRect.top),
          width: Math.round(linkRect.width),
          height: Math.round(linkRect.height),
        },
        hitTarget: samePostOverlay ? 'full-post-link-overlay' : 'title-link',
      };
    }
    return { ok: false, reason: 'post-not-found', postId: expectedPostId };
  })()`;
}

export function buildTargetProbeExpression() {
  return `(() => ({
    url: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    postCount: document.querySelectorAll(${JSON.stringify(REDDIT_SELECTORS.post.probe)}).length,
    scrollY: Math.round(scrollY),
  }))()`;
}
