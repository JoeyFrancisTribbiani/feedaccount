import { CdpClient } from "../cdp-client.js";

function valueOf(result) {
  if (result?.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || "TikTok 页面脚本执行失败";
    throw new Error(msg);
  }
  return result?.result?.value;
}

// 发布按钮定位四级降级策略（注入到页面 evaluate 上下文）
// 优先级: data-e2e > data-testid > 精确文本(排除 Schedule/草稿) > 模糊文本过滤
const FIND_POST_BTN_EXPR = `
  (function findPostBtn() {
    return (
      document.querySelector('[data-e2e="post-button"]') ||
      document.querySelector('button[data-testid="post-submit"]') ||
      Array.from(document.querySelectorAll('button[type="button"],button[type="submit"],button')).find(b => {
        const t = b.innerText.trim();
        if (!t) return false;
        const isPublish = t === "Post" || t === "发布" || t === "Publish";
        const noSchedule = !t.includes("Schedule") && !t.includes("草稿") && !t.includes("Later") && !t.includes("Cancel");
        return isPublish && noSchedule;
      }) ||
      Array.from(document.querySelectorAll("button")).find(b => {
        const t = b.innerText.trim();
        return (t.includes("Post") || t.includes("发布")) &&
               !t.includes("Schedule") && !t.includes("草稿") && !t.includes("Later");
      })
    );
  })()
`;

export class TiktokPublisher {
  constructor({ client = new CdpClient() } = {}) {
    this.client = client;
    this.sessionId = null;
    this.targetId = null;
  }

  async connect(wsUrl) {
    await this.client.connect(wsUrl);
    const targets = await this.client.call("Target.getTargets");
    
    // 优先寻找已有 studio/upload 标签页或 tiktok.com 标签页
    let tk = (targets.targetInfos || []).find(
      (t) => t.type === "page" && /tiktok\.com\/(tiktokstudio|upload)/.test(t.url)
    ) || (targets.targetInfos || []).find(
      (t) => t.type === "page" && /tiktok\.com/.test(t.url)
    );

    if (!tk) {
      // 没找到则新建标签页导航至 tiktokstudio/upload
      const created = await this.client.call("Target.createTarget", { url: "https://www.tiktok.com/tiktokstudio/upload" });
      this.targetId = created.targetId;
    } else {
      this.targetId = tk.targetId;
    }

    const attached = await this.client.call("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.client.call("Page.enable", {}, this.sessionId);
    await this.client.call("DOM.enable", {}, this.sessionId);

    // 检查并导航至上传页面
    const evalUrl = await this.client.call(
      "Runtime.evaluate",
      { expression: "window.location.href", returnByValue: true },
      this.sessionId
    );
    const currentUrl = valueOf(evalUrl) || "";
    if (!/tiktokstudio\/upload|upload/.test(currentUrl)) {
      await this.client.call("Page.navigate", { url: "https://www.tiktok.com/tiktokstudio/upload" }, this.sessionId, 30000);
      await this.#waitForReady();
    }

    await new Promise((r) => setTimeout(r, 3000));
    return { connected: true, targetId: this.targetId };
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
      30000
    );
  }

  async uploadVideo({ filePath, title, hashtags = [], privacyLevel = "public" }) {
    if (!filePath) throw new Error("缺失视频文件路径");
    
    // 1. 查找页面中的 file input 节点
    const doc = await this.client.call("DOM.getDocument", { depth: -1 }, this.sessionId);
    const fileInput = await this.client.call("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]'
    }, this.sessionId).catch(() => null);

    if (!fileInput || !fileInput.nodeId) {
      throw new Error("未在 TikTok Studio 上传页面找到 <input type='file'> 元素（请确认已登录账号）");
    }

    // 2. 使用 CDP DOM.setFileInputFiles 命令直接全自动设置文件
    await this.client.call("DOM.setFileInputFiles", {
      files: [filePath],
      nodeId: fileInput.nodeId
    }, this.sessionId);

    // 3. 等待视频上传并解析完成（轮询检测编辑器是否就绪）
    let editorReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.client.call(
        "Runtime.evaluate",
        {
          expression: `(() => {
            // 编辑器：优先 Draft.js，回退 textarea
            const editor = document.querySelector('.public-DraftEditor-content')
              || document.querySelector('[contenteditable="true"]')
              || document.querySelector('div[data-e2e="caption-input"]')
              || document.querySelector('textarea');
            const postBtn = ${FIND_POST_BTN_EXPR};
            return JSON.stringify({
              hasEditor: !!editor,
              hasPostBtn: !!postBtn,
              postDisabled: postBtn ? (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') : true
            });
          })()`,
          returnByValue: true
        },
        this.sessionId
      );
      const status = JSON.parse(valueOf(res) || "{}");
      if (status.hasEditor && status.hasPostBtn) {
        editorReady = true;
        break;
      }
    }

    if (!editorReady) {
      throw new Error("视频文件上传超时，元数据编辑器未在预期时间内就绪");
    }

    // 4. 填写 Title 与 #Hashtags
    const fullCaption = `${title || ''} ${hashtags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')}`.trim();
    if (fullCaption) {
      // 聚焦编辑器并输入文案
      await this.client.call(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const editor = document.querySelector('.public-DraftEditor-content')
              || document.querySelector('[contenteditable="true"]')
              || document.querySelector('div[data-e2e="caption-input"]')
              || document.querySelector('textarea');
            if (editor) {
              editor.focus();
              return true;
            }
            return false;
          })()`,
          returnByValue: true
        },
        this.sessionId
      );
      await new Promise((r) => setTimeout(r, 500));
      await this.client.call("Input.insertText", { text: fullCaption }, this.sessionId);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 5. 等待"发布"按钮进入可用状态（上传进度可能正在转圈）
    let canPost = false;
    for (let i = 0; i < 60; i++) {
      const res = await this.client.call(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const postBtn = ${FIND_POST_BTN_EXPR};
            if (!postBtn) return false;
            return !(postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true' || postBtn.classList.contains('disabled'));
          })()`,
          returnByValue: true
        },
        this.sessionId
      );
      canPost = valueOf(res);
      if (canPost) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!canPost) {
      throw new Error("视频预处理超时，发布按钮未解锁");
    }

    // 6. 点击"Post / 发布"按钮
    // 同时派发 mousedown/mouseup/click 以触发 React 合成事件
    const clickRes = await this.client.call(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const postBtn = ${FIND_POST_BTN_EXPR};
          if (!postBtn) return false;
          postBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          postBtn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
          postBtn.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
          return postBtn.innerText.trim() || 'clicked';
        })()`,
        returnByValue: true
      },
      this.sessionId
    );

    if (!valueOf(clickRes)) throw new Error("无法触发发布按钮点击");

    // 7. 等待发布成功模态框或反馈
    let success = false;
    let publishedVideoUrl = "";
    let publishedVideoId = "";

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.client.call(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const bodyText = document.body.innerText || '';
            const isDone = bodyText.includes('Your video is being uploaded to TikTok') ||
                           bodyText.includes('Manage your posts') ||
                           bodyText.includes('Upload another video') ||
                           bodyText.includes('你的视频正在上传') ||
                           bodyText.includes('管理你的作品');
            const linkEl = document.querySelector('a[href*="/video/"]');
            return JSON.stringify({
              isDone,
              videoUrl: linkEl ? linkEl.href : ''
            });
          })()`,
          returnByValue: true
        },
        this.sessionId
      );
      const ret = JSON.parse(valueOf(res) || "{}");
      if (ret.isDone || ret.videoUrl) {
        success = true;
        publishedVideoUrl = ret.videoUrl;
        if (publishedVideoUrl) {
          const match = publishedVideoUrl.match(/\/video\/(\d+)/);
          if (match) publishedVideoId = match[1];
        }
        break;
      }
    }

    return {
      ok: success,
      publishedVideoId,
      publishedVideoUrl,
      message: success ? "视频发布成功" : "视频已提交发布，最终状态请在账号发布历史中确认"
    };
  }

  async close() {
    try {
      await this.client.close();
    } catch {}
  }
}
