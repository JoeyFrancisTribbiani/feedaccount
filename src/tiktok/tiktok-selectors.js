const TIKTOK_HOSTS = ["tiktok.com", "www.tiktok.com"];

export const TIKTOK_SELECTORS = Object.freeze({
  feed: {
    container: '[class*="DivColumnListContainer"]',
    videoCard: 'section[data-e2e="feed-video"]',
    video: "video",
  },
  action: {
    like: '[data-e2e="like-icon"]',
    likeCount: '[data-e2e="like-count"]',
    comment: '[data-e2e="comment-icon"]',
    commentCount: '[data-e2e="comment-count"]',
    favorite: '[data-e2e="favorite-icon"]',
    share: '[data-e2e="share-icon"]',
    follow: '[data-e2e="feed-follow"]',
    authorAvatar: '[data-e2e="video-author-avatar"]',
    moreMenu: '[data-e2e="more-menu-icon"]',
  },
  meta: {
    desc: '[data-e2e="video-desc"]',
    music: '[data-e2e="video-music"]',
    authorLink: 'a[href*="/@"]',
    tagLink: 'a[href*="/tag/"]',
  },
  blocker: {
    login: '[data-e2e="login-container"], [class*="login" i][role="dialog"]',
    captcha: '[id*="captcha" i], [class*="captcha" i]',
  },
});

function isTiktokHost(hostname) {
  return TIKTOK_HOSTS.includes(hostname);
}

export function isTiktokForyou(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!isTiktokHost(url.hostname)) return false;
    return url.pathname === "/foryou" || url.pathname.startsWith("/foryou");
  } catch {
    return false;
  }
}

export function isTiktokSearch(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!isTiktokHost(url.hostname)) return false;
    return url.pathname === "/search" || url.pathname.startsWith("/search");
  } catch {
    return false;
  }
}

export function buildSearchUrl(keyword) {
  return `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
}

export function buildTiktokFeedDomExpression() {
  return `(() => {
    const TIKTOK_SELECTORS = ${JSON.stringify(TIKTOK_SELECTORS)};
    const q = (s) => document.querySelector(s);
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        top: Math.round(r.top), left: Math.round(r.left),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
      };
    };
    const centerOf = (r) => (r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null);
    const visibleInViewport = (r) => {
      if (!r) return false;
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };

    const container = q(TIKTOK_SELECTORS.feed.container);
    const sections = [...document.querySelectorAll(TIKTOK_SELECTORS.feed.videoCard)];
    const section = sections.find((s) => {
      const r = s.getBoundingClientRect();
      return r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2;
    }) || sections[0] || null;
    const videos = [...document.querySelectorAll(TIKTOK_SELECTORS.feed.video)];
    const video = videos.find((v) => !v.paused) || videos.find((v) => visibleInViewport(rectOf(v))) || videos[0] || null;

    // On video detail pages (/@user/video/xxx) there are no feed-video sections,
    // but the action buttons (like-icon, comment-icon, etc.) exist at document level.
    // Fall back to using document as the search scope.
    const scope = section || document;

    if (!video) {
      return { ready: false, url: location.href, title: document.title, reason: "no-video" };
    }

    const descEl = scope.querySelector(TIKTOK_SELECTORS.meta.desc) || q(TIKTOK_SELECTORS.meta.desc);
    const desc = (descEl ? descEl.textContent || "" : "").trim();
    const authorLinks = [...scope.querySelectorAll(TIKTOK_SELECTORS.meta.authorLink)]
      .filter((a) => !/\\/tag\\//.test(a.pathname));
    const authorLink = authorLinks[0] || null;
    const author = authorLink ? (authorLink.textContent || "").trim() : "";
    const authorUrl = authorLink ? authorLink.href : "";

    const visibleEl = (sel) => {
      const els = [...document.querySelectorAll(sel)];
      if (els.length === 0) return null;
      return els.find((e) => visibleInViewport(rectOf(e))) ||
        els.slice().sort((a, b) =>
          Math.abs(rectOf(a).top - innerHeight / 2) - Math.abs(rectOf(b).top - innerHeight / 2))[0];
    };
    const likeEl = visibleEl(TIKTOK_SELECTORS.action.like);
    const likeAria = likeEl ? likeEl.getAttribute("aria-label") || "" : "";
    const likeCountEl = visibleEl(TIKTOK_SELECTORS.action.likeCount);
    const likeCount = likeCountEl ? (likeCountEl.textContent || "").trim() : "";
    const likeColor = likeEl ? getComputedStyle(likeEl).color : "";
    const liked = /\\u53d6\\u6d88|unlike/i.test(likeAria) ||
      (/\\u70b9\\u8d5e|like/i.test(likeAria) === false && /254,\\s*44,\\s*85|254,44,85/.test(likeColor));

    const actionRect = (sel) => {
      const el = visibleEl(sel);
      const r = rectOf(el);
      return { exists: !!el, visible: visibleInViewport(r), rect: r, center: centerOf(r) };
    };

    return {
      ready: true,
      url: location.href,
      title: document.title,
      isForyou: location.pathname.startsWith("/foryou"),
      blocked: !!q(TIKTOK_SELECTORS.blocker.login) || !!q(TIKTOK_SELECTORS.blocker.captcha),
      container: container
        ? {
            scrollTop: Math.round(container.scrollTop),
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
          }
        : null,
      video: {
        paused: video.paused,
        currentTime: Math.round(video.currentTime || 0),
        duration: Math.round(video.duration || 0),
        rect: rectOf(video),
      },
      current: {
        author,
        authorUrl,
        desc: desc.slice(0, 200),
        likeCount,
        liked,
        likeAria,
      },
      actions: {
        like: actionRect(TIKTOK_SELECTORS.action.like),
        comment: actionRect(TIKTOK_SELECTORS.action.comment),
        favorite: actionRect(TIKTOK_SELECTORS.action.favorite),
        share: actionRect(TIKTOK_SELECTORS.action.share),
      },
    };
  })()`;
}

export function tiktokVideoIdentity(info) {
  if (!info?.current) return "";
  const author = String(info.current.author || "").trim();
  const desc = String(info.current.desc || "").trim().slice(0, 80);
  return `${author}::${desc}`;
}
