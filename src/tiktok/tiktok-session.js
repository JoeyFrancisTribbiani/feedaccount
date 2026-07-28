import { CdpClient } from "../cdp-client.js";
import { buildTiktokFeedDomExpression, tiktokVideoIdentity, isTiktokForyou } from "./tiktok-selectors.js";

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
    if (!tk) throw new Error("未找到 TikTok 标签页");
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
    const container = before.container;
    if (!container) throw new Error("未找到 TikTok 视频流容器");
    await this.client.call(
      "Runtime.evaluate",
      {
        expression: `(() => { const c = document.querySelector('[class*="DivColumnListContainer"]'); if (c) c.scrollTop += c.clientHeight; return c ? c.scrollTop : -1; })()`,
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
    await this.client.call("Page.navigate", { url: this.targetUrl }, this.sessionId, 30000);
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
    if (!info || info.ready !== true) throw new Error("返回 For You 失败");
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
