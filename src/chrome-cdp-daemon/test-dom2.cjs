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
    const turn2 = turns[1];
    if (!turn2) return { error: 'no turn 2' };
    
    // 获取所有 button 的详细信息
    const btns = [...turn2.querySelectorAll('button')];
    const btnInfo = btns.map((b, i) => ({
      index: i,
      text: b.textContent?.trim()?.substring(0, 200),
      ariaLabel: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
      className: b.className?.substring(0, 100),
      hasHref: !!b.querySelector('a[href]'),
      childTags: [...b.children].map(c => c.tagName).join(','),
    }));
    
    // 获取所有 a[href]
    const links = [...turn2.querySelectorAll('a[href]')];
    const linkInfo = links.map((a, i) => ({
      index: i,
      href: a.href,
      text: a.textContent?.trim()?.substring(0, 100),
    }));
    
    // 查找包含"下载"的元素
    const allElements = [...turn2.querySelectorAll('*')];
    const downloadElements = allElements.filter(el => 
      (el.textContent || '').includes('下载') || (el.textContent || '').includes('Download')
    ).slice(0, 10).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim()?.substring(0, 100),
      className: el.className?.substring(0, 60),
    }));
    
    // 查找包含 .mp4 的元素
    const mp4Elements = allElements.filter(el => 
      (el.textContent || '').includes('.mp4')
    ).slice(0, 10).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim()?.substring(0, 150),
      className: el.className?.substring(0, 60),
    }));

    // 获取 turn2 的完整 outerHTML（截断）
    const html = turn2.innerHTML.substring(0, 5000);
    
    return {
      btnCount: btns.length,
      btns: btnInfo,
      linkCount: links.length,
      links: linkInfo,
      downloadElements,
      mp4Elements,
      htmlPreview: html,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
