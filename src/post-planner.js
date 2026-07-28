const TOP_MARGIN_PX = 8;
const BOTTOM_MARGIN_PX = 12;
const TALL_POST_OVERLAP_PX = 80;
const VISIBILITY_TOLERANCE_PX = 6;

function orderedPosts(posts) {
  return [...posts]
    .filter(
      (post) =>
        post &&
        post.postId &&
        Number.isFinite(post.absoluteTop) &&
        Number.isFinite(post.height) &&
        post.height > 0,
    )
    .sort((left, right) => left.absoluteTop - right.absoluteTop);
}

export function readingGeometry({
  viewportHeight,
  headerBottom = 0,
  bottomPadding = BOTTOM_MARGIN_PX,
  safeBottom: measuredSafeBottom,
}) {
  const viewportBottom = Math.max(1, Math.round(viewportHeight));
  const safeTop = Math.min(
    viewportBottom - 1,
    Math.max(0, Math.round(headerBottom)) + TOP_MARGIN_PX,
  );
  const paddedBottom =
    viewportBottom - Math.max(BOTTOM_MARGIN_PX, Math.max(0, Math.round(bottomPadding)));
  const detectedBottom = Number.isFinite(measuredSafeBottom)
    ? Math.round(measuredSafeBottom)
    : paddedBottom;
  const safeBottom = Math.max(
    safeTop + 1,
    Math.min(viewportBottom, paddedBottom, detectedBottom),
  );
  return {
    safeTop,
    safeBottom,
    availableHeight: Math.max(1, safeBottom - safeTop),
  };
}

export function postViewportState(post, feed) {
  const geometry = readingGeometry(feed);
  const top = post.absoluteTop - feed.scrollY;
  const bottom = top + post.height;
  const visiblePixels = Math.max(
    0,
    Math.min(bottom, geometry.safeBottom) - Math.max(top, geometry.safeTop),
  );
  const visibleRatio = Math.max(0, Math.min(1, visiblePixels / post.height));
  // Measurement values are rounded to whole CSS pixels. A post taller than
  // the available area is physically impossible to show in full, regardless
  // of positioning tolerance.
  const fitPossible = post.height <= geometry.availableHeight;
  const fullyVisible =
    fitPossible &&
    top >= geometry.safeTop - VISIBILITY_TOLERANCE_PX &&
    bottom <= geometry.safeBottom + VISIBILITY_TOLERANCE_PX;
  // Even a post that is only a few pixels taller than the safe viewport cannot
  // truthfully be called fully visible. Treat every such post as segmented.
  const oversized = !fitPossible;

  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    visiblePixels: Math.round(visiblePixels),
    visibleRatio,
    fitPossible,
    fullyVisible,
    oversized,
    ...geometry,
  };
}

export function selectCurrentPost(feed) {
  const posts = orderedPosts(feed.posts);
  let best = null;
  for (const post of posts) {
    const viewport = postViewportState(post, feed);
    if (!best || viewport.visibleRatio > best.viewport.visibleRatio) {
      best = { post, viewport };
    }
  }
  return best && best.viewport.visibleRatio >= 0.5 ? best : null;
}

export function alignPost(post, feed) {
  const viewport = postViewportState(post, feed);
  const desiredTop = viewport.fitPossible
    ? viewport.safeTop + Math.max(0, Math.round((viewport.availableHeight - post.height) / 2))
    : viewport.safeTop;
  const desiredScrollY = Math.min(
    Math.max(0, Math.round(post.absoluteTop - desiredTop)),
    Math.max(0, Math.round(feed.maxY || 0)),
  );
  return {
    desiredTop,
    desiredScrollY,
    // Signed distance is intentional: a real gesture can overshoot, and an
    // already-open page may start with the current post clipped above the
    // fixed header. A bounded upward correction is required in both cases.
    distance: desiredScrollY - Math.round(feed.scrollY),
    viewport,
  };
}

export function planNextPost(feed, lastPostId = null) {
  const posts = orderedPosts(feed.posts);
  const current = selectCurrentPost({ ...feed, posts });
  let anchorIndex = lastPostId ? posts.findIndex((post) => post.postId === lastPostId) : -1;

  if (anchorIndex >= 0) {
    const anchor = posts[anchorIndex];
    const viewport = postViewportState(anchor, feed);
    if (!viewport.fitPossible && viewport.bottom > viewport.safeBottom + VISIBILITY_TOLERANCE_PX) {
      const remaining = viewport.bottom - viewport.safeBottom;
      const distance = Math.max(
        1,
        Math.min(
          Math.max(1, viewport.availableHeight - TALL_POST_OVERLAP_PX),
          Math.ceil(remaining),
        ),
      );
      const currentReadOffset = Math.max(0, viewport.safeTop - viewport.top);
      const desiredReadOffset = currentReadOffset + distance;
      return {
        kind: "continue-post",
        post: anchor,
        newPost: false,
        distance,
        desiredReadOffset,
        desiredTop: viewport.safeTop - desiredReadOffset,
        targetSegmentFinal: remaining - distance <= VISIBILITY_TOLERANCE_PX,
        postComplete: remaining - distance <= VISIBILITY_TOLERANCE_PX,
        viewport,
      };
    }

    // Layout can change after media/lazy content resolves. Do not advance
    // from a normal post until it is again completely inside the safe area.
    if (viewport.fitPossible && !viewport.fullyVisible) {
      const alignment = alignPost(anchor, feed);
      return {
        kind: "realign-post",
        post: anchor,
        newPost: false,
        distance: alignment.distance,
        desiredTop: alignment.desiredTop,
        postComplete: false,
        viewport,
      };
    }
  }

  let target;
  if (anchorIndex >= 0) {
    target = posts[anchorIndex + 1];
  } else if (current) {
    // The first operation owns the currently visible post. It aligns and
    // counts that post instead of silently jumping over it. This also recovers
    // safely when virtualization removes the previous anchor from the DOM.
    target = current.post;
  } else {
    const geometry = readingGeometry(feed);
    // When the page starts between posts, a thin strip of the preceding post
    // must not pull the reader backwards. Prefer the first post whose top is
    // still ahead in the reading direction; only fall back to an intersecting
    // post when no forward candidate is currently rendered (typically the
    // end of the loaded feed).
    target = posts.find(
      (post) => post.absoluteTop - feed.scrollY >= geometry.safeTop - VISIBILITY_TOLERANCE_PX,
    );
    target ||= posts.find(
      (post) => post.absoluteTop + post.height - feed.scrollY > geometry.safeTop,
    );
  }

  if (!target) {
    const atBottom = feed.scrollY >= Math.max(0, feed.maxY - VISIBILITY_TOLERANCE_PX);
    return {
      kind: atBottom ? "end" : "loading",
      post: current?.post || (anchorIndex >= 0 ? posts[anchorIndex] : null),
      newPost: false,
      distance: 0,
      postComplete: true,
      atBottom,
      retryable: !atBottom,
    };
  }

  const alignment = alignPost(target, feed);
  const predictedBottom = target.absoluteTop - (feed.scrollY + alignment.distance) + target.height;
  const postComplete =
    alignment.viewport.fitPossible ||
    predictedBottom <= alignment.viewport.safeBottom + VISIBILITY_TOLERANCE_PX;
  return {
    kind: lastPostId && anchorIndex >= 0 ? "next-post" : "current-post",
    post: target,
    newPost: true,
    distance: alignment.distance,
    desiredTop: alignment.desiredTop,
    postComplete,
    viewport: alignment.viewport,
  };
}
