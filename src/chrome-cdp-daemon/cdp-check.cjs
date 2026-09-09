const { chromium } = require('playwright');

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

  const result = await page.evaluate(() => {
    const sendBtn = document.querySelector('button[data-testid="send-button"]');
    const stopBtn = document.querySelector('button[data-testid="stop-button"]');
    const articles = document.querySelectorAll('article');
    const lastArticle = articles[articles.length - 1];
    const links = document.querySelectorAll('a[href]');
    const videoLinks = [...links].filter(a => a.href.includes('.mp4') || a.href.includes('download') || a.href.includes('file'));
    const fileButtons = document.querySelectorAll('button[aria-label]');
    const downloadBtns = [...fileButtons].filter(b => b.getAttribute('aria-label')?.includes('下载') || b.getAttribute('aria-label')?.includes('Download'));
    return {
      sendBtnExists: !!sendBtn, sendBtnDisabled: sendBtn?.disabled,
      stopBtnExists: !!stopBtn,
      articleCount: articles.length,
      lastArticleText: lastArticle?.textContent?.substring(0, 1000),
      videoLinkCount: videoLinks.length,
      videoLinkHrefs: videoLinks.map(a => a.href).slice(0, 5),
      downloadBtnCount: downloadBtns.length,
      fileButtonCount: fileButtons.length,
      fileButtonLabels: [...fileButtons].map(b => b.getAttribute('aria-label')).slice(0, 10),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
