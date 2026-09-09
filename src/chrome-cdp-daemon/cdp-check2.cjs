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

  const result = await page.evaluate(() => {
    // 查所有可能的消息容器
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    const markdowns = document.querySelectorAll('.markdown');
    const messages = document.querySelectorAll('[class*="message"]');
    const streaming = document.querySelectorAll('[data-streaming]');
    const resultDivs = document.querySelectorAll('[class*="result"]');
    
    // 查下载链接
    const allLinks = [...document.querySelectorAll('a[href]')];
    const fileLinks = allLinks.filter(a => 
      a.href.includes('file') || a.href.includes('download') || 
      a.href.includes('mp4') || a.href.includes('video') ||
      a.href.includes('backend-api')
    );
    
    // 查 button 中带文件名的
    const allBtns = [...document.querySelectorAll('button')];
    const fileBtns = allBtns.filter(b => {
      const label = b.getAttribute('aria-label') || b.textContent || '';
      return label.includes('.mp4') || label.includes('.json') || label.includes('.txt') || 
             label.includes('下载') || label.includes('Download') ||
             label.includes('file');
    });
    
    // 查 main 区域内容
    const main = document.querySelector('main');
    const mainText = main?.textContent?.substring(0, 2000);
    
    return {
      turnCount: turns.length,
      markdownCount: markdowns.length,
      messageCount: messages.length,
      streamingCount: streaming.length,
      resultDivCount: resultDivs.length,
      fileLinkCount: fileLinks.length,
      fileLinkHrefs: fileLinks.map(a => ({href: a.href, text: a.textContent?.substring(0,50)})).slice(0, 5),
      fileBtnCount: fileBtns.length,
      fileBtnInfo: fileBtns.map(b => ({label: b.getAttribute('aria-label'), text: b.textContent?.substring(0,50)})).slice(0, 10),
      mainTextPreview: mainText?.substring(0, 500),
      // 检查是否有正在生成的标记
      loadingIndicator: !!document.querySelector('[class*="loading"]'),
      generatingText: !!document.querySelector('[class*="generating"]'),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
