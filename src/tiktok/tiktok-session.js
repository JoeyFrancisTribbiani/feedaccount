import { CdpClient } from "../cdp-client.js";
import { buildTiktokFeedDomExpression, tiktokVideoIdentity, isTiktokForyou, isTiktokSearch, buildSearchUrl } from "./tiktok-selectors.js";

const SETTLE_SAMPLE_INTERVAL_MS = 300;
const SETTLE_MAX_SAMPLES = 12;
const SETTLE_STABLE_MS = 500;

function valueOf(result) {
  if (result?.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || "TikTok 页面脚本执行失败";
    throw new Error(msg);
  }
  return result?.result?.value;
}

export class TiktokSession {
  constructor({ client = new CdpClient(), targetUrl = "https://www.tiktok.com/foryou" } = {}) {
    this.client = client;
    this.targetUrl = targetUrl;
    this.currentPageUrl = targetUrl;
    this.sessionId = null;
    this.targetId = null;
    this.lastVideoIdentity = null;
    this.likedVideoIds = new Set();
  }

  async connect(wsUrl) {
    await this.client.connect(wsUrl);
    const targets = await this.client.call("Target.getTargets");
    const tk = (targets.targetInfos || []).find(
      (t) => t.type === "page" && /tiktok\.com/.test(t.url),
    );

    if (tk) {
      this.targetId = tk.targetId;
      const attached = await this.client.call("Target.attachToTarget", {
        targetId: this.targetId,
        flatten: true,
      });
      this.sessionId = attached.sessionId;
      await this.client.call("Page.enable", {}, this.sessionId);
      if (!isTiktokForyou(tk.url)) {
        await this.client.call("Page.navigate", { url: this.targetUrl }, this.sessionId, 30000);
        await this.#waitForReady();
      }
    } else {
      // No TikTok tab — create a new one
      const created = await this.client.call("Target.createTarget", { url: this.targetUrl });
      this.targetId = created.targetId;
      const attached = await this.client.call("Target.attachToTarget", {
        targetId: this.targetId,
        flatten: true,
      });
      this.sessionId = attached.sessionId;
      await this.client.call("Page.enable", {}, this.sessionId);
      await this.#waitForReady();
    }

    await this.#waitStable();
    let info = null;
    for (let i = 0; i < 24; i++) {
      const res = await this.client.call(
        "Runtime.evaluate",
        { expression: buildTiktokFeedDomExpression(), returnByValue: true },
        this.sessionId, 12000,
      );
      info = valueOf(res);
      if (info && info.ready && info.current?.author && info.actions?.like?.visible) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    if (!info || info.ready !== true) {
      throw new Error(info?.reason ? `TikTok 页面未就绪：${info.reason}` : "TikTok 页面未就绪");
    }
    if (info.blocked) throw new Error("TikTok 页面被登录墙或验证码阻塞");
    return info;
  }

  async search(keyword) {
    if (!keyword || !keyword.trim()) throw new Error("搜索关键词为空");
    const cleanKeyword = keyword.trim();
    const searchUrl = buildSearchUrl(cleanKeyword);

    this.lastVideoIdentity = null;
    this.currentPageUrl = searchUrl;

    // Step 1: Navigate to search page
    const domReady = this.client.call(
      "Runtime.evaluate",
      {
        expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
        awaitPromise: true,
        returnByValue: true,
      },
      this.sessionId,
      30000,
    );
    await this.client.call("Page.navigate", { url: searchUrl }, this.sessionId, 30000);
    await domReady;
    await new Promise((r) => setTimeout(r, 3000));

    // Step 2: Wait for search result video links to appear
    for (let attempt = 0; attempt < 20; attempt++) {
      const checkRes = await this.client.call(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const items = document.querySelectorAll('[data-e2e="search_top-item"]');
            const videoLinks = document.querySelectorAll('a[href*="/video/"]');
            return JSON.stringify({ items: items.length, videoLinks: videoLinks.length, hasLogin: !!document.querySelector('[data-e2e="login-container"]') });
          })()`,
          returnByValue: true,
        },
        this.sessionId,
        8000,
      );
      const info = JSON.parse(checkRes?.result?.value || "{}");
      if (info.hasLogin) throw new Error("搜索页被登录墙阻塞");
      if (info.items > 0 || info.videoLinks > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Step 3: Get the first video URL from search results and navigate to it
    const getVideoUrlExpr = `(() => {
      const link = document.querySelector('a[href*="/video/"]');
      if (!link) {
        const item = document.querySelector('[data-e2e="search_top-item"]');
        if (item) { item.click(); return JSON.stringify({ ok: true, method: 'click-item' }); }
        return JSON.stringify({ ok: false, reason: 'no-video-link' });
      }
      return JSON.stringify({ ok: true, method: 'navigate', url: link.href });
    })()`;
    const urlRes = await this.client.call(
      "Runtime.evaluate",
      { expression: getVideoUrlExpr, returnByValue: true },
      this.sessionId,
      8000,
    );
    const urlInfo = JSON.parse(urlRes?.result?.value || "{}");
    if (!urlInfo.ok) throw new Error("无法找到搜索结果视频");

    if (urlInfo.method === "navigate" && urlInfo.url) {
      const videoReady = this.client.call(
        "Runtime.evaluate",
        {
          expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
          awaitPromise: true,
          returnByValue: true,
        },
        this.sessionId,
        30000,
      );
      await this.client.call("Page.navigate", { url: urlInfo.url }, this.sessionId, 30000);
      await videoReady;
    }

    // Step 4: Wait for video detail page to be ready
    await new Promise((r) => setTimeout(r, 5000));
    for (let attempt = 0; attempt < 24; attempt++) {
      const res = await this.client.call(
        "Runtime.evaluate",
        { expression: buildTiktokFeedDomExpression(), returnByValue: true },
        this.sessionId,
        10000,
      );
      const info = valueOf(res);
      if (info?.ready && info.current?.author && info.actions?.like?.visible) {
        this.lastVideoIdentity = tiktokVideoIdentity(info);
        this.currentPageUrl = info.url || searchUrl;
        return info;
      }
      if (info?.blocked) throw new Error("全屏视频页被登录墙或验证码阻塞");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`搜索 "${cleanKeyword}" 后全屏视频页未就绪`);
  }

  async returnToForyou() {
    this.lastVideoIdentity = null;
    this.currentPageUrl = this.targetUrl;
    const domReady = this.client.call(
      "Runtime.evaluate",
      {
        expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
        awaitPromise: true,
        returnByValue: true,
      },
      this.sessionId,
      30000,
    );
    await this.client.call(
      "Page.navigate",
      { url: this.targetUrl },
      this.sessionId,
      30000,
    );
    await domReady;
    await new Promise((r) => setTimeout(r, 2500));

    for (let attempt = 0; attempt < 24; attempt++) {
      const res = await this.client.call(
        "Runtime.evaluate",
        { expression: buildTiktokFeedDomExpression(), returnByValue: true },
        this.sessionId,
        10000,
      );
      const info = valueOf(res);
      if (info?.ready && info.current?.author) {
        this.lastVideoIdentity = tiktokVideoIdentity(info);
        return info;
      }
      if (info?.blocked) throw new Error("返回 For You 页被阻塞");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("返回 For You 页超时");
  }

  async #waitForReady() {
    await this.client.call(
      "Runtime.evaluate",
      {
        expression: "new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, {once:true}) : r())",
        awaitPromise: true,
        returnByValue: true,
      },
      this.sessionId,
      30000,
    );
  }

  async #getScrollTop() {
    const res = await this.client.call(
      "Runtime.evaluate",
      { expression: "document.querySelector('[class*=\"DivColumnListContainer\"]')?.scrollTop || 0", returnByValue: true },
      this.sessionId,
      8000,
    );
    return Number(valueOf(res)) || 0;
  }

  async #waitStable() {
    let last = -1;
    for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
      const st = await this.#getScrollTop();
      if (Math.abs(st - last) < 1) break;
      last = st;
      await new Promise((r) => setTimeout(r, SETTLE_SAMPLE_INTERVAL_MS));
    }
    await new Promise((r) => setTimeout(r, SETTLE_STABLE_MS));
  }

  async readFeed() {
    const res = await this.client.call(
      "Runtime.evaluate",
      { expression: buildTiktokFeedDomExpression(), returnByValue: true },
      this.sessionId,
      15000,
    );
    const info = valueOf(res);
    if (!info || info.ready !== true) {
      throw new Error(info?.reason ? `TikTok 页面未就绪：${info.reason}` : "TikTok 页面未就绪");
    }
    if (info.blocked) throw new Error("TikTok 页面被登录墙或验证码阻塞");
    return info;
  }

  async advanceVideo() {
    const before = await this.readFeed();
    const beforeId = tiktokVideoIdentity(before);

    // Try multiple navigation strategies:
    // 1. feed-navigation-next button (video detail page)
    // 2. scrollIntoView on next section (For You page)
    // 3. fallback scrollTop
    await this.client.call(
      "Runtime.evaluate",
      {
        expression: `(() => {
          // Strategy 1: feed-navigation-next button (video detail page)
          const nextBtn = document.querySelector('[data-e2e="feed-navigation-next"]');
          if (nextBtn) {
            const r = nextBtn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              nextBtn.click();
              return 'nav-next-clicked';
            }
          }
          // Strategy 2: scrollIntoView on next feed-video section (For You page)
          const sections = [...document.querySelectorAll('section[data-e2e="feed-video"]')];
          const current = sections.find((s) => {
            const r = s.getBoundingClientRect();
            return r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2;
          }) || sections[0];
          if (current) {
            const idx = sections.indexOf(current);
            const next = sections[idx + 1];
            if (next) {
              next.scrollIntoView({ behavior: 'instant', block: 'start' });
              return 'scrolled-to-next';
            }
          }
          // Strategy 3: fallback scrollTop
          const c = document.querySelector('[class*="DivColumnListContainer"]');
          if (c) {
            c.scrollTop += c.clientHeight;
            return 'fallback-scrolltop';
          }
          return 'no-navigation';
        })()`,
        returnByValue: true,
      },
      this.sessionId,
      10000,
    );
    await this.#waitStable();
    const after = await this.readFeed();
    const afterId = tiktokVideoIdentity(after);
    return { switched: beforeId !== afterId, before: beforeId, after: afterId, feed: after };
  }

  async #clickPoint(x, y) {
    await this.client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sessionId);
    await new Promise((r) => setTimeout(r, 120));
    await this.client.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.sessionId);
    await new Promise((r) => setTimeout(r, 90));
    await this.client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, this.sessionId);
    await new Promise((r) => setTimeout(r, 400));
  }

  async likeCurrentVideo() {
    const feed = await this.readFeed();
    const id = tiktokVideoIdentity(feed);
    if (!id) throw new Error("无法识别当前视频");
    if (feed.current.liked) return { ok: true, alreadyLiked: true, id };
    if (this.likedVideoIds.has(id)) return { ok: true, alreadyLiked: true, id };
    const like = feed.actions.like;
    if (!like.exists) throw new Error("未找到点赞按钮");
    if (!like.visible || !like.center) throw new Error("点赞按钮不可见");
    await this.#clickPoint(like.center.x, like.center.y);
    await this.#waitStable();
    const after = await this.readFeed();
    const liked = after.current.liked || tiktokVideoIdentity(after) !== id || after.current.likeAria !== feed.current.likeAria;
    if (liked) this.likedVideoIds.add(id);
    return { ok: liked, alreadyLiked: false, id, liked };
  }

  async openComments() {
    const feed = await this.readFeed();
    const comment = feed.actions.comment;
    if (!comment.exists) throw new Error("未找到评论按钮");
    await this.client.call(
      "Runtime.evaluate",
      { expression: `(() => { const b = document.querySelector('[data-e2e="comment-icon"] button') || document.querySelector('[data-e2e="comment-icon"]'); if (b) b.click(); return b ? 'ok' : 'none'; })()`, returnByValue: true },
      this.sessionId, 10000,
    );
    await new Promise((r) => setTimeout(r, 3500));
    const res = await this.client.call(
      "Runtime.evaluate",
      { expression: `JSON.stringify({ hasList: !!document.querySelector('[class*="CommentListContainer"]'), hasInput: !!document.querySelector('[data-e2e="comment-input"]') })`, returnByValue: true },
      this.sessionId, 10000,
    );
    const state = JSON.parse(valueOf(res) || "{}");
    if (!state.hasList) throw new Error("评论弹窗未打开");
    return { ok: true };
  }

  async scrollComments(steps = 3) {
    for (let i = 0; i < steps; i++) {
      await this.client.call(
        "Runtime.evaluate",
        { expression: `(() => { const c = document.querySelector('[class*="CommentListContainer"]'); if (c) c.scrollTop += Math.min(400, Math.round(c.clientHeight * 0.7)); return c ? c.scrollTop : -1; })()`, returnByValue: true },
        this.sessionId, 10000,
      );
      await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
    }
    return { ok: true, steps };
  }

  async closeComments() {
    const returnUrl = this.currentPageUrl || this.targetUrl;
    await this.client.call("Page.navigate", { url: returnUrl }, this.sessionId, 30000);
    await this.#waitForReady();
    await this.#waitStable();
    let info = null;
    for (let i = 0; i < 24; i++) {
      const res = await this.client.call(
        "Runtime.evaluate",
        { expression: buildTiktokFeedDomExpression(), returnByValue: true },
        this.sessionId, 12000,
      );
      info = valueOf(res);
      if (info && info.ready && info.current?.author && info.actions?.like?.visible) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    if (!info || info.ready !== true) throw new Error("返回视频页面失败");
    this.lastVideoIdentity = tiktokVideoIdentity(info);
    return info;
  }

  async postComment(text) {
    if (!text) throw new Error("评论文本为空");
    const rectRes = await this.client.call(
      "Runtime.evaluate",
      { expression: `(() => { const el = document.querySelector('[data-e2e="comment-input"]') || document.querySelector('[data-e2e="comment-text"]'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }); })()`, returnByValue: true },
      this.sessionId, 10000,
    );
    const inputCenter = JSON.parse(valueOf(rectRes) || "null");
    if (!inputCenter) throw new Error("未找到评论输入框");
    await this.#clickPoint(inputCenter.x, inputCenter.y);
    await new Promise((r) => setTimeout(r, 600));
    await this.client.call("Input.insertText", { text }, this.sessionId);
    await new Promise((r) => setTimeout(r, 800));
    const postRes = await this.client.call(
      "Runtime.evaluate",
      { expression: `(() => { const b = document.querySelector('[data-e2e="comment-post"]'); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), disabled: b.getAttribute('aria-disabled') }); })()`, returnByValue: true },
      this.sessionId, 10000,
    );
    const postCenter = JSON.parse(valueOf(postRes) || "null");
    if (!postCenter) throw new Error("未找到评论发布按钮");
    if (postCenter.disabled === "true") throw new Error("评论发布按钮不可用");
    await this.#clickPoint(postCenter.x, postCenter.y);
    await new Promise((r) => setTimeout(r, 2000));
    return { ok: true, text };
  }

  async close() {
    try {
      await this.client.close();
    } catch {}
  }
}
