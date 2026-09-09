const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes('chatgpt.com/c/6aa10fa0')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.log('ChatGPT page not found'); process.exit(1); }
  console.log('Found page:', await page.title());

  // 1. 找到视频文件按钮
  const fileInfo = await page.evaluate(() => {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    let lastTurn = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break; }
    }
    if (!lastTurn) return null;

    // 找包含 .mp4 的 button
    const btns = [...lastTurn.querySelectorAll('button')];
    const mp4Btns = btns.filter(b => {
      const t = b.textContent || '';
      const a = b.getAttribute('aria-label') || '';
      return t.includes('.mp4') || a.includes('.mp4');
    });

    // 也找 a[href] 中的 mp4 链接
    const links = [...lastTurn.querySelectorAll('a[href]')].filter(a => a.href.includes('.mp4') || a.href.includes('download'));

    return {
      mp4BtnCount: mp4Btns.length,
      mp4BtnTexts: mp4Btns.map(b => b.textContent?.trim()),
      mp4BtnAriaLabels: mp4Btns.map(b => b.getAttribute('aria-label')),
      linkCount: links.length,
      linkHrefs: links.map(a => a.href),
      // 看看有没有"下载文件"按钮
      downloadBtns: btns.filter(b => {
        const a = b.getAttribute('aria-label') || '';
        return a.includes('下载') || a.includes('Download');
      }).map(b => b.getAttribute('aria-label')),
    };
  });
  console.log('File info:', JSON.stringify(fileInfo, null, 2));

  if (!fileInfo || fileInfo.mp4BtnCount === 0) {
    console.log('No .mp4 button found');
    process.exit(1);
  }

  // 2. 尝试拦截下载：点击文件按钮看触发什么 URL
  console.log('\n--- 尝试拦截文件按钮点击 ---');
  
  const fileName = fileInfo.mp4BtnTexts[0];
  console.log('Target file:', fileName);

  // 方式1: 拦截 page 上的下载事件
  page.on('download', async (download) => {
    console.log('Download event fired!');
    console.log('URL:', download.url());
    console.log('Filename:', download.suggestedFilename());
    const savePath = path.join(__dirname, 'data', 'remix-output', `test_download_${Date.now()}.mp4`);
    await download.saveAs(savePath);
    const stat = fs.statSync(savePath);
    console.log(`Downloaded to: ${savePath} (${Math.round(stat.size / 1024 / 1024)}MB)`);
  });

  // 方式2: 拦截网络请求
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('download') || url.includes('.mp4') || url.includes('interpreter') || url.includes('file')) {
      console.log('Network request:', req.method(), url.substring(0, 150));
    }
  });

  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('download') || url.includes('.mp4') || url.includes('interpreter') || url.includes('file')) {
      console.log('Response:', resp.status(), url.substring(0, 150));
      console.log('Content-Type:', resp.headers()['content-type']);
      console.log('Content-Length:', resp.headers()['content-length']);
    }
  });

  // 点击文件按钮
  const clicked = await page.evaluate((fname) => {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    let lastTurn = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break; }
    }
    if (!lastTurn) return false;
    const btn = [...lastTurn.querySelectorAll('button')].find(b => b.textContent?.includes('.mp4'));
    if (!btn) return false;
    btn.click();
    return true;
  }, fileName);
  
  console.log('Clicked file button:', clicked);

  // 等待下载或网络请求
  console.log('Waiting 10s for download...');
  await page.waitForTimeout(10000);

  // 方式3: 尝试从 React fiber 获取 sandbox 路径，然后找下载按钮
  console.log('\n--- 尝试找"下载文件"按钮 ---');
  const downloadResult = await page.evaluate(() => {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    let lastTurn = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break; }
    }
    if (!lastTurn) return null;
    
    // 找所有 button，看有没有"下载"相关的
    const btns = [...lastTurn.querySelectorAll('button')];
    const downloadBtns = btns.filter(b => {
      const a = b.getAttribute('aria-label') || '';
      const t = b.textContent || '';
      return a.includes('下载') || a.includes('Download') || a.includes('download');
    });
    
    // 也尝试从 React fiber 获取文件信息
    const mp4Btn = btns.find(b => b.textContent?.includes('.mp4'));
    let sandboxPath = null;
    if (mp4Btn) {
      const fiberKey = Object.keys(mp4Btn).find(k => k.startsWith('__reactFiber'));
      if (fiberKey) {
        let fiber = mp4Btn[fiberKey];
        for (let i = 0; i < 10 && fiber; i++) {
          const props = fiber.memoizedProps;
          if (props?.href) { sandboxPath = props.href; break; }
          fiber = fiber.return;
        }
      }
    }
    
    return {
      downloadBtnCount: downloadBtns.length,
      downloadBtnLabels: downloadBtns.map(b => b.getAttribute('aria-label')),
      sandboxPath,
    };
  });
  console.log('Download button info:', JSON.stringify(downloadResult, null, 2));

  // 如果找到下载按钮，点击它
  if (downloadResult && downloadResult.downloadBtnCount > 0) {
    console.log('\n--- 点击下载按钮 ---');
    const dlClicked = await page.evaluate(() => {
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      let lastTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break; }
      }
      if (!lastTurn) return false;
      const btn = [...lastTurn.querySelectorAll('button')].find(b => {
        const a = b.getAttribute('aria-label') || '';
        return a.includes('下载') || a.includes('Download');
      });
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log('Clicked download button:', dlClicked);
    
    console.log('Waiting 15s for download...');
    await page.waitForTimeout(15000);
  }

  // 方式4: 直接 fetch interpreter/download URL
  console.log('\n--- 尝试直接 fetch API ---');
  const fetchResult = await page.evaluate(async () => {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    let lastTurn = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break; }
    }
    if (!lastTurn) return { error: 'no last turn' };
    
    // 获取 conversation ID
    const convId = window.location.pathname.split('/c/')[1];
    
    // 获取 message ID
    const msgEl = lastTurn.getAttribute('data-message-id');
    const msgId = msgEl || lastTurn.id;
    
    // 从 React fiber 找 message id
    const fiberKey = Object.keys(lastTurn).find(k => k.startsWith('__reactFiber'));
    let realMsgId = null;
    if (fiberKey) {
      let fiber = lastTurn[fiberKey];
      for (let i = 0; i < 15 && fiber; i++) {
        const props = fiber.memoizedProps;
        if (props?.id) { realMsgId = props.id; break; }
        if (props?.message?.id) { realMsgId = props.message.id; break; }
        fiber = fiber.return;
      }
    }
    
    return { convId, msgId, realMsgId };
  });
  console.log('Message info:', JSON.stringify(fetchResult, null, 2));

  if (fetchResult && fetchResult.convId && (fetchResult.msgId || fetchResult.realMsgId)) {
    const mid = fetchResult.realMsgId || fetchResult.msgId;
    const downloadUrl = `https://chatgpt.com/backend-api/conversation/${fetchResult.convId}/interpreter/download?message_id=${mid}`;
    console.log('Trying download URL:', downloadUrl);
    
    const fetchRes = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type'), contentLength: res.headers.get('content-length') };
      } catch (e) {
        return { error: e.message };
      }
    }, downloadUrl);
    console.log('Fetch result:', JSON.stringify(fetchResult, null, 2));
    console.log('Download API response:', JSON.stringify(fetchRes, null, 2));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message, e.stack); process.exit(1); });
