const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes('chatgpt.com/c/')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.log('No ChatGPT page'); process.exit(1); }
  console.log('Page:', await page.title(), page.url());

  // 测试 getLastAssistantText 逻辑
  const text = await page.evaluate(() => {
    const selectors = ['[data-message-author-role="assistant"]', 'div[class*="markdown"]', '[data-testid^="conversation-turn-"]'];
    const results = [];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      results.push({ selector: sel, count: elements.length, lastText: elements[elements.length-1]?.textContent?.substring(0, 200) });
    }
    return results;
  });
  console.log('getLastAssistantText selectors:', JSON.stringify(text, null, 2));

  // 测试 isStillGenerating 逻辑
  const gen = await page.evaluate(() => {
    const stopBtns = document.querySelectorAll('button[data-testid="stop-button"]');
    const stopVisible = [...stopBtns].filter(b => b.offsetParent !== null).length;
    
    const submitBtn = document.querySelector('button[class*="composer-submit-button"]');
    let submitAria = null;
    if (submitBtn) {
      submitAria = (submitBtn.getAttribute('aria-label') || '').toLowerCase();
    }
    
    const allStopLike = document.querySelectorAll('button[class*="stop"], button[data-testid*="stop"]');
    const stopLikeVisible = [...allStopLike].filter(b => b.offsetParent !== null).length;
    
    return { stopBtnCount: stopBtns.length, stopVisible, submitBtnExists: !!submitBtn, submitAria, stopLikeCount: allStopLike.length, stopLikeVisible };
  });
  console.log('isStillGenerating:', JSON.stringify(gen, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
