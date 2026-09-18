/**
 * TikTok 发布器 (Playwright 版)
 *
 * 通过 Playwright connectOverCDP 连接 BitBrowser 指纹浏览器实例，
 * 用 Playwright API 操作 TikTok Studio 上传页面。
 *
 * 替代原始 CDP WebSocket 方案，setInputFiles 更可靠，无需手动转路径。
 */

import { chromium } from 'playwright';

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

    // 等待页面加载
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 等待弹窗出现（草稿弹窗是异步渲染的，最多等10秒）
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some(b =>
          ['Discard', 'Not now', 'Continue', 'Discard this post'].includes(b.innerText.trim())
        ),
        { timeout: 10000 }
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
   * 关闭 TikTok Studio 可能出现的弹窗
   * 循环检测直到没有已知弹窗按钮
   */
  async _dismissDialogs() {
    const page = this.page;

    const dismiss = (texts) => page.evaluate((ts) => {
      const els = document.querySelectorAll('button, a, [role="button"], [data-e2e], div[data-e2e]');
      for (const el of els) {
        const t = el.innerText.trim();
        if (ts.includes(t)) { el.click(); return t; }
      }
      return null;
    }, texts).catch(() => null);

    // 最多循环8轮，每轮点掉一个弹窗
    for (let i = 0; i < 8; i++) {
      let clicked = null;

      // 优先级1: Discard（丢弃草稿/确认丢弃）
      clicked = await dismiss(['Discard', '放弃', '丢弃']);
      if (clicked) { console.log(`[_dismissDialogs] round ${i}: clicked Discard`); await page.waitForTimeout(2000); continue; }

      // 优先级2: 内容检查弹窗 - 关闭/跳过
      clicked = await dismiss(['Not now', 'Skip', "Don't turn on", 'Cancel', '以后再说', '跳过', '取消', '暂不开启', '不开启']);
      if (clicked) { console.log(`[_dismissDialogs] round ${i}: clicked ${clicked}`); await page.waitForTimeout(2000); continue; }

      // 优先级3: 其他确认弹窗
      clicked = await dismiss(['Got it', 'OK', 'Continue', '确定', '继续', '我知道了']);
      if (clicked) { console.log(`[_dismissDialogs] round ${i}: clicked ${clicked}`); await page.waitForTimeout(2000); continue; }

      // 没有弹窗了，退出
      break;
    }

    // 最终检查：页面是否还有弹窗文本
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('Discard this post') || bodyText.includes("wasn't saved")) {
      console.log('[_dismissDialogs] WARNING: 弹窗仍在页面上！');
      // 最后一次尝试：用更宽泛的匹配
      await page.evaluate(() => {
        const all = document.querySelectorAll('button, a, [role="button"], [data-e2e]');
        for (const el of all) {
          const t = (el.innerText || '').trim();
          if (t === 'Discard') { el.click(); return; }
        }
      }).catch(() => {});
      await page.waitForTimeout(1000);
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
      localFilePath = filePath.replace(/^\/data\//, 'D:/WILLLUXE/yix-repo/feedaccount/data/');
    }

    // 1. 等待并找到 file input
    let fileInput = null;
    let alreadyUploaded = false;
    for (let i = 0; i < 10; i++) {
      fileInput = await page.$('input[type="file"]');
      if (fileInput) break;
      // 每次 retry 前 dismiss 弹窗
      await this._dismissDialogs();
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

    // 2. 用 Playwright setInputFiles 上传文件（跳过已上传的情况）
    if (fileInput) {
      await fileInput.setInputFiles(localFilePath);
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
      localFilePath = filePath.replace(/^\/data\//, 'D:/WILLLUXE/yix-repo/feedaccount/data/');
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

    await fileInput.setInputFiles(localFilePath);

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
   * 访问账号主页，抓取所有视频的播放量/点赞/评论/分享数据
   * @param {string} username - TikTok 用户名
   * @returns {Array<{videoId, videoUrl, views, likes, comments, shares, title}>}
   */
  async recordAnalytics(username) {
    const page = this.page;
    if (!username) throw new Error('缺失 TikTok 用户名');

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
    const videos = await page.evaluate(() => {
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

        // 播放量在 <strong data-e2e="video-views">
        const viewsEl = card.querySelector('[data-e2e="video-views"]');
        const viewsText = viewsEl?.innerText || viewsEl?.textContent || '';

        // 视频标题在 img alt
        const imgEl = card.querySelector('img');
        const title = imgEl?.getAttribute('alt') || '';

        items.push({
          videoId: match[2],
          videoUrl: href,
          views: viewsText,
          title: title.substring(0, 100),
        });
      }
      return items;
    }).catch(() => []);

    return { profileUrl, videoCount: videos.length, videos };
  }

  async close() {
    // connectOverCDP 不应该关闭浏览器，只断开连接
    if (this.browser) {
      try { this.browser.close(); } catch {}
    }
  }
}
