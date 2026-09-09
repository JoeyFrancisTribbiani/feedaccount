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
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    const turnInfo = [...turns].map((t, i) => ({
      index: i,
      testid: t.getAttribute('data-testid'),
      role: t.getAttribute('data-message-author-role'),
      msgId: t.getAttribute('data-message-id'),
      textPreview: t.textContent?.substring(0, 200),
      buttonCount: t.querySelectorAll('button').length,
      mp4Buttons: [...t.querySelectorAll('button')].filter(b => 
        (b.textContent || '').includes('.mp4')
      ).map(b => ({
        text: b.textContent?.trim()?.substring(0, 100),
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className?.substring(0, 80),
      })),
      linkCount: t.querySelectorAll('a[href]').length,
      mp4Links: [...t.querySelectorAll('a[href]')].filter(a => 
        a.href.includes('.mp4') || a.href.includes('download')
      ).map(a => ({ href: a.href.substring(0, 120), text: a.textContent?.substring(0, 50) })),
    }));
    return { turnCount: turns.length, turns: turnInfo };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
