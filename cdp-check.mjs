import WebSocket from 'ws';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const chatgpt = targets.find(t => t.url.includes('chatgpt.com/c/6aa10fa0'));
if (!chatgpt) { console.log('ChatGPT page not found'); process.exit(1); }
console.log('Found:', chatgpt.title);

const ws = new WebSocket(chatgpt.webSocketDebuggerUrl);

ws.on('open', () => {
  const expr = `(() => {
    const sendBtn = document.querySelector('button[data-testid="send-button"]');
    const stopBtn = document.querySelector('button[data-testid="stop-button"]');
    const articles = document.querySelectorAll('article');
    const lastArticle = articles[articles.length - 1];
    const links = document.querySelectorAll('a[href]');
    const videoLinks = [...links].filter(a => a.href.includes('.mp4') || a.href.includes('download') || a.href.includes('file'));
    const fileButtons = document.querySelectorAll('button[aria-label]');
    const downloadBtns = [...fileButtons].filter(b => b.getAttribute('aria-label')?.includes('下载') || b.getAttribute('aria-label')?.includes('Download'));
    return JSON.stringify({
      sendBtnExists: !!sendBtn, sendBtnDisabled: sendBtn?.disabled,
      stopBtnExists: !!stopBtn,
      articleCount: articles.length,
      lastArticleText: lastArticle?.textContent?.substring(0, 1000),
      videoLinkCount: videoLinks.length,
      videoLinkHrefs: videoLinks.map(a => a.href).slice(0, 5),
      downloadBtnCount: downloadBtns.length,
      fileButtonCount: fileButtons.length,
      fileButtonLabels: [...fileButtons].map(b => b.getAttribute('aria-label')).slice(0, 10),
    });
  })()`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id === 1 && msg.result) {
    try { console.log(JSON.stringify(JSON.parse(msg.result.result.value), null, 2)); }
    catch { console.log(JSON.stringify(msg.result, null, 2)); }
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => { ws.close(); process.exit(1); }, 10000);
