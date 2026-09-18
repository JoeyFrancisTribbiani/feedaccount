/**
 * TikTok 发布器 (Playwright 版)
 *
 * 通过 Playwright connectOverCDP 连接 BitBrowser 指纹浏览器实例，
 * 用 Playwright API 操作 TikTok Studio 上传页面。
 *
 * 替代原始 CDP WebSocket 方案，setInputFiles 更可靠，无需手动转路径。
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { getOutputDir } from '../video-remix.js';

// 发布按钮定位策略
const POST_BTN_SELECTORS = [
  '[data-e2e="post_video_button"]',
  '[data-e2e="post-button"]',
  'button[data-testid="post-submit"]',
];

function findPostBtn(page) {
  return page.locator('button').filter({ hasText: /^(Post|发布|Publish)$/ }).first();
}

export class TiktokPublisher {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  /**
   * 连接到 BitBrowser 实例的 CDP 端口
   * @param {string} wsUrl - browser-level ws url 或 http endpoint
   */
  async connect(wsUrl) {
    // wsUrl 可能是 ws://host:port/devtools/browser/xxx 格式
    // Playwright connectOverCDP 需要 http://host:port 格式
    const httpUrl = wsUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://')
      .replace(/\/devtools\/browser\/.*$/, '');

    this.browser = await chromium.connectOverCDP(httpUrl);

    // 获取已有 contexts 和 pages
    const contexts = this.browser.contexts();
    const ctx = contexts[0] || await this.browser.newContext();

    // 找已有的 TikTok Studio 上传页
    let page = ctx.pages().find(p => /tiktok\.com\/(tiktokstudio|upload)/.test(p.url()));
    if (!page) {
      page = ctx.pages().find(p => /tiktok\.com/.test(p.url()));
    }
    if (!page) {
      page = await ctx.newPage();
    }

    // 始终导航到上传页（刷新页面，清除草稿残留和弹窗状态）
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });

    this.page = page;
    this.context = ctx;

    // 创建 CDP session 用于大文件上传
    this.cdpSession = await this.context.newCDPSession(page);

    // 等待页面加载
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 等待弹窗出现（草稿弹窗是异步渲染的，最多等20秒）
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some(b =>
          ['Discard', 'Not now', 'Continue', 'Discard this post'].includes(b.innerText.trim())
        ),
        { timeout: 20000 }
      );
    } catch {
      // 没弹窗也继续
    }
    await page.waitForTimeout(1000);

    // 处理可能出现的弹窗（"A video you were editing wasn't saved. Continue editing?"）
    await this._dismissDialogs();

    return { connected: true };
  }

  /**
   * 关闭 TikTok Studio 的草稿提示和弹窗
   * 流程: 1.点内联Discard → 2.等弹窗出现 → 3.点弹窗里的Discard
   * 循环处理直到没有草稿提示
   */
  async _dismissDialogs() {
    const page = this.page;

    for (let i = 0; i < 8; i++) {
      // 1. 找弹窗里的 Discard（TUXButton，在 modal 里）优先点
      let clicked = await page.evaluate(() => {
        var btns = document.querySelectorAll('button');
        // 优先: 弹窗内的 Discard
        for (var b of btns) {
          var t = b.innerText.trim();
          if (t === 'Discard') {
            var inModal = b.closest('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="TUX"]');
            if (inModal) { b.click(); return 'modal Discard'; }
          }
        }
        // 其次: 弹窗内的 Not now
        for (var b of btns) {
          var t = b.innerText.trim();
          if (t === 'Not now' || t === 'Cancel') {
            var inModal = b.closest('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="TUX"]');
            if (inModal) { b.click(); return 'modal ' + t; }
          }
        }
        // 再次: 内联的 Discard（local-draft-card 里的）
        for (var b of btns) {
          var t = b.innerText.trim();
          if (t === 'Discard' && b.closest('.local-draft-card, [class*="local-draft"]')) {
            b.click();
            return 'inline Discard';
          }
        }
        // 最后: 其他确认弹窗
        for (var b of btns) {
          var t = b.innerText.trim();
          if (['Got it', 'OK', 'Continue', '确定', '继续', '我知道了'].includes(t)) {
            var inModal = b.closest('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="TUX"]');
            if (inModal) { b.click(); return 'modal ' + t; }
          }
        }
        return null;
      }).catch(() => null);

      if (clicked) {
        console.log(`[_dismissDialogs] round ${i}: clicked ${clicked}`);
        await page.waitForTimeout(2500);
        continue;
      }

      // 没找到弹窗按钮，检查是否还有草稿提示
      const bodyText = await page.innerText('body').catch(() => '');
      if (!bodyText.includes("wasn't saved") && !bodyText.includes('Discard this post') && !bodyText.includes('Not now')) {
        break;
      }
      // 还有文本但没找到按钮，等一下再试
      await page.waitForTimeout(2000);
    }
  }

  /**
   * 上传视频到 TikTok Studio
   */
  async uploadVideo({ filePath, title, hashtags = [], privacyLevel = 'public' }) {
    if (!filePath) throw new Error('缺失视频文件路径');
    const page = this.page;

    // 转换文件路径为本地绝对路径
    let localFilePath = filePath;
    if (/^\/data\//.test(filePath)) {
      localFilePath = path.join(path.dirname(getOutputDir()), filePath.replace(/^\/data\//, ''));
    }

    // 1. 等待并找到 file input，先确保所有弹窗关闭
    let fileInput = null;
    let alreadyUploaded = false;
    for (let i = 0; i < 15; i++) {
      // 每次都先尝试关闭弹窗
      await this._dismissDialogs();
      
      fileInput = await page.$('input[type="file"]');
      if (fileInput) break;  // file input 本身就是 display:none，不需要可见
      
      // 检查是否已经在上传/已上传状态（之前的上传残留）
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.includes('Uploaded') || bodyText.includes('已上传') || bodyText.includes('Replace') || bodyText.includes('替换')) {
        alreadyUploaded = true;
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!fileInput && !alreadyUploaded) {
      const url = page.url();
      const bodyText = await page.innerText('body').catch(() => '');
      const inputCount = await page.evaluate(() => document.querySelectorAll('input').length).catch(() => -1);
      throw new Error(`未找到 file input。URL=${url}, inputs=${inputCount}, body=${bodyText.substring(0, 150)}`);
    }

    // 2. 用 CDP DOM.setFileInputFiles 上传文件（无50MB限制）
    if (fileInput) {
      // 用 CDP session 直接传文件路径，绕过 Playwright 50MB 限制
      const doc = await this.cdpSession.send('DOM.getDocument', { depth: -1 });
      const node = await this.cdpSession.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      });
      if (!node || !node.nodeId) {
        throw new Error('CDP 查找 file input 失败');
      }
      await this.cdpSession.send('DOM.setFileInputFiles', {
        files: [localFilePath],
        nodeId: node.nodeId,
      });
      // 上传后可能弹出内容检查弹窗
      await page.waitForTimeout(3000);
      await this._dismissDialogs();
    }

    // 3. 等待视频上传并解析完成（编辑器就绪）
    let editorReady = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      const editor = await page.$('.public-DraftEditor-content, [contenteditable="true"], div[data-e2e="caption-input"], textarea');
      const postBtn = await this._findPostButton();
      if (editor && postBtn) {
        editorReady = true;
        break;
      }
    }

    if (!editorReady) {
      throw new Error('视频文件上传超时，元数据编辑器未在预期时间内就绪');
    }

    // 4. 填写 Title 与 #Hashtags
    const fullCaption = `${title || ''} ${hashtags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')}`.trim();
    if (fullCaption) {
      const editor = await page.$('.public-DraftEditor-content, [contenteditable="true"], div[data-e2e="caption-input"], textarea');
      if (editor) {
        await editor.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.type(fullCaption, { delay: 30 });
        await page.waitForTimeout(1000);
      }
    }

    // 5. 等待发布按钮可用
    let canPost = false;
    for (let i = 0; i < 90; i++) {
      const postBtn = await this._findPostButton();
      if (postBtn) {
        const disabled = await postBtn.evaluate(el =>
          el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')
        ).catch(() => true);
        if (!disabled) {
          canPost = true;
          break;
        }
      }
      await page.waitForTimeout(1500);
    }

    if (!canPost) {
      throw new Error('视频预处理超时，发布按钮未解锁');
    }

    // 6. 点击发布按钮
    const postBtn = await this._findPostButton();
    if (!postBtn) throw new Error('无法找到发布按钮');

    await postBtn.click({ force: true }).catch(async () => {
      // force click 失败，尝试 JS dispatch
      await postBtn.evaluate(el => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });
    const btnText = await postBtn.innerText().catch(() => 'clicked');

    // 7. 等待发布成功
    let success = false;
    let publishedVideoUrl = '';
    let publishedVideoId = '';

    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000);
      const bodyText = await page.innerText('body').catch(() => '');
      const url = page.url();

      const isDone =
        bodyText.includes('Your video is being uploaded to TikTok') ||
        bodyText.includes('Manage your posts') ||
        bodyText.includes('Upload another video') ||
        bodyText.includes('你的视频正在上传') ||
        bodyText.includes('管理你的作品') ||
        bodyText.includes('上传其他视频') ||
        bodyText.includes('Your video was posted') ||
        bodyText.includes('视频已发布') ||
        bodyText.includes('video is being processed') ||
        bodyText.includes('being processed') ||
        url.includes('/tiktokstudio/content');

      if (isDone) {
        success = true;
        const linkEl = await page.$('a[href*="/video/"]');
        if (linkEl) {
          publishedVideoUrl = await linkEl.getAttribute('href') || '';
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
      message: success ? '视频发布成功' : '视频已提交发布，最终状态请在账号发布历史中确认',
    };
  }

  /**
   * 上传图片（照片）到 TikTok
   */
  async uploadPhoto({ filePath, title, hashtags = [], privacyLevel = 'public' }) {
    if (!filePath) throw new Error('缺失图片文件路径');
    const page = this.page;

    let localFilePath = filePath;
    if (/^\/data\//.test(filePath)) {
      localFilePath = path.join(path.dirname(getOutputDir()), filePath.replace(/^\/data\//, ''));
    }

    let fileInput = null;
    for (let i = 0; i < 10; i++) {
      fileInput = await page.$('input[type="file"]');
      if (fileInput) break;
      await page.waitForTimeout(2000);
    }

    if (!fileInput) {
      throw new Error("未在 TikTok Studio 上传页面找到 <input type='file'> 元素（请确认已登录账号）");
    }

    // 用 CDP 上传（无50MB限制）
    const doc = await this.cdpSession.send('DOM.getDocument', { depth: -1 });
    const node = await this.cdpSession.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!node || !node.nodeId) {
      throw new Error('CDP 查找 file input 失败');
    }
    await this.cdpSession.send('DOM.setFileInputFiles', {
      files: [localFilePath],
      nodeId: node.nodeId,
    });

    let editorReady = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const editor = await page.$('.public-DraftEditor-content, [contenteditable="true"], div[data-e2e="caption-input"], textarea');
      const postBtn = await this._findPostButton();
      if (editor && postBtn) { editorReady = true; break; }
    }

    if (!editorReady) throw new Error('图片上传超时，元数据编辑器未在预期时间内就绪');

    const fullCaption = `${title || ''} ${hashtags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')}`.trim();
    if (fullCaption) {
      const editor = await page.$('.public-DraftEditor-content, [contenteditable="true"], textarea');
      if (editor) {
        await editor.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.type(fullCaption, { delay: 30 });
        await page.waitForTimeout(1000);
      }
    }

    let canPost = false;
    for (let i = 0; i < 30; i++) {
      const postBtn = await this._findPostButton();
      if (postBtn) {
        const disabled = await postBtn.evaluate(el =>
          el.disabled || el.getAttribute('aria-disabled') === 'true'
        ).catch(() => true);
        if (!disabled) { canPost = true; break; }
      }
      await page.waitForTimeout(1500);
    }

    if (!canPost) throw new Error('图片上传完成但发布按钮未解锁');

    const postBtn = await this._findPostButton();
    if (!postBtn) throw new Error('无法找到发布按钮');
    await postBtn.click({ force: true }).catch(async () => {
      // force click 失败，尝试 JS dispatch
      await postBtn.evaluate(el => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });

    let success = false;
    let publishedPhotoUrl = '';
    let publishedPhotoId = '';

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const bodyText = await page.innerText('body').catch(() => '');
      const url = page.url();
      const isDone =
        bodyText.includes('Your photo is being uploaded') ||
        bodyText.includes('Manage your posts') ||
        bodyText.includes('Upload another') ||
        bodyText.includes('你的图片正在上传') ||
        bodyText.includes('管理你的作品') ||
        url.includes('/tiktokstudio/content');
      if (isDone) {
        success = true;
        const linkEl = await page.$('a[href*="/photo/"], a[href*="/video/"]');
        if (linkEl) {
          publishedPhotoUrl = await linkEl.getAttribute('href') || '';
          const match = publishedPhotoUrl.match(/\/(photo|video)\/(\d+)/);
          if (match) publishedPhotoId = match[2];
        }
        break;
      }
    }

    return {
      ok: success,
      publishedVideoId: publishedPhotoId,
      publishedVideoUrl: publishedPhotoUrl,
      message: success ? '图片发布成功' : '图片已提交发布，最终状态请在账号发布历史中确认',
    };
  }

  /**
   * 查找发布按钮
   */
  async _findPostButton() {
    const page = this.page;
    // 1. data-e2e 选择器
    for (const sel of POST_BTN_SELECTORS) {
      const btn = await page.$(sel);
      if (btn) return btn;
    }
    // 2. 精确文本匹配
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = (await btn.innerText().catch(() => '')).trim();
      if ((text === 'Post' || text === '发布' || text === 'Publish') &&
          !text.includes('Schedule') && !text.includes('草稿') && !text.includes('Later') && !text.includes('Cancel')) {
        return btn;
      }
    }
    // 3. 模糊文本
    for (const btn of buttons) {
      const text = (await btn.innerText().catch(() => '')).trim();
      if ((text.includes('Post') || text.includes('发布')) &&
          !text.includes('Schedule') && !text.includes('草稿') && !text.includes('Later')) {
        return btn;
      }
    }
    return null;
  }

  /**
   * 访问当前登录账号的主页，抓取视频的播放量/点赞/评论/分享
   * @param {string} publishedVideoId — 发布成功后的视频ID，用于过滤只记录该视频
   * @returns {Array<{videoId, videoUrl, views, likes, comments, shares, title}>}
   */
  async recordAnalytics(publishedVideoId = null) {
    const page = this.page;

    // 先导航到 TikTok 主页获取当前登录账号的用户名
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const username = await page.evaluate(() => {
      try {
        var el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!el) return null;
        var data = JSON.parse(el.textContent);
        var scopes = data?.__DEFAULT_SCOPE__ || {};
        for (var k of Object.keys(scopes)) {
          var scope = scopes[k];
          if (scope?.userInfo?.user?.uniqueId) return scope.userInfo.user.uniqueId;
          if (scope?.user?.uniqueId) return scope.user.uniqueId;
        }
        return null;
      } catch(e) { return null; }
    }).catch(() => null);

    if (!username) {
      console.log('[recordAnalytics] 无法获取当前登录账号用户名');
      return { profileUrl: '', videoCount: 0, videos: [] };
    }

    console.log(`[recordAnalytics] 当前登录账号: ${username}`);

    // 导航到账号主页
    const profileUrl = `https://www.tiktok.com/@${username}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 滚动加载所有视频
    let prevCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      const count = await page.evaluate(() => document.querySelectorAll('[data-e2e="user-post-item"]').length).catch(() => 0);
      if (count === prevCount) break;
      prevCount = count;
    }

    // 抓取每个视频的数据
    const videos = await page.evaluate((targetVideoId) => {
      const items = [];
      const cards = document.querySelectorAll('[data-e2e="user-post-item"]');
      const seen = new Set();

      for (const card of cards) {
        // 从卡片内找视频链接
        const link = card.querySelector('a[href*="/video/"], a[href*="/photo/"]');
        if (!link) continue;
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/(video|photo)\/(\d+)/);
        if (!match || seen.has(match[2])) continue;
        seen.add(match[2]);

        // 如果指定了 publishedVideoId，只记录该视频
        if (targetVideoId && match[2] !== targetVideoId) continue;

        // 播放量在 <strong data-e2e="video-views">
        const viewsEl = card.querySelector('[data-e2e="video-views"]');
        const viewsText = viewsEl?.innerText || viewsEl?.textContent || '';

        // 点赞数 data-e2e="video-likes"
        const likesEl = card.querySelector('[data-e2e="video-likes"]');
        const likesText = likesEl?.innerText || likesEl?.textContent || '';

        // 评论数 data-e2e="video-comments"
        const commentsEl = card.querySelector('[data-e2e="video-comments"]');
        const commentsText = commentsEl?.innerText || commentsEl?.textContent || '';

        // 分享数 data-e2e="video-shares"
        const sharesEl = card.querySelector('[data-e2e="video-shares"]');
        const sharesText = sharesEl?.innerText || sharesEl?.textContent || '';

        // 视频标题在 img alt
        const imgEl = card.querySelector('img');
        const title = imgEl?.getAttribute('alt') || '';

        items.push({
          videoId: match[2],
          videoUrl: href,
          views: viewsText,
          likes: likesText,
          comments: commentsText,
          shares: sharesText,
          title: title.substring(0, 100),
        });
      }
      return items;
    }, publishedVideoId).catch(() => []);

    return { profileUrl, videoCount: videos.length, videos };
  }

  async close() {
    // connectOverCDP 不应该关闭浏览器，只断开连接
    if (this.browser) {
      try { this.browser.close(); } catch {}
    }
  }
}
