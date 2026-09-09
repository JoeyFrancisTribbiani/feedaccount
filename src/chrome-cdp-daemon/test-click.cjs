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

  // 监听下载事件
  page.on('download', async (download) => {
    console.log('[DOWNLOAD EVENT] URL:', download.url());
    console.log('[DOWNLOAD EVENT] Filename:', download.suggestedFilename());
    const savePath = path.join(__dirname, '..', '..', 'data', 'remix-output', `test_dl_${Date.now()}.mp4`);
    await download.saveAs(savePath);
    const stat = fs.statSync(savePath);
    console.log(`[DOWNLOAD EVENT] Saved to: ${savePath} (${Math.round(stat.size / 1024 / 1024)}MB)`);
  });

  // 监听网络请求
  const requests = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('download') || url.includes('file') || url.includes('mp4') || url.includes('interpreter') || url.includes('backend-api/files')) {
      const headers = resp.headers();
      console.log(`[RESPONSE] ${resp.status()} ${url.substring(0, 150)}`);
      console.log(`  Content-Type: ${headers['content-type']}, Content-Length: ${headers['content-length']}`);
    }
  });

  console.log('Clicking "下载最终 MP4" button...');
  
  // 点击 "下载最终 MP4" button
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => 
      b.textContent?.trim() === '下载最终 MP4'
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  console.log('Clicked:', clicked);

  // 等待下载
  console.log('Waiting 20s for download...');
  await page.waitForTimeout(20000);

  console.log('Done.');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
