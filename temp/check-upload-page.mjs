import http from 'node:http';
import { WebSocket } from 'ws';

function getPages(httpUrl) {
  return new Promise((resolve, reject) => {
    http.get(`http://${httpUrl}/json`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        resolve(JSON.parse(d));
      });
    }).on('error', reject);
  });
}

async function run() {
  const tabs = await getPages('127.0.0.1:9339');
  const tkTab = tabs.find(t => t.type === 'page' && /tiktokstudio|upload/i.test(t.url));
  if (!tkTab) { console.log('No TikTok tab found'); process.exit(1); }
  
  console.log('Tab:', tkTab.url, '|', tkTab.title);

  const ws = new WebSocket(tkTab.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = {};

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending[msg.id]) {
      pending[msg.id](msg);
      delete pending[msg.id];
    }
  });

  await new Promise(r => ws.on('open', r));

  function send(method, params = {}) {
    return new Promise(r => {
      const id = ++msgId;
      pending[id] = r;
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Check current URL
  const r1 = await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
  console.log('URL:', r1.result?.result?.value);

  // Check all inputs
  const r2 = await send('Runtime.evaluate', { 
    expression: `[...document.querySelectorAll('input')].map(i => ({type: i.type, name: i.name, id: i.id, accept: i.accept, hidden: i.hidden, style: i.style?.cssText?.substring(0,60)}))`,
    returnByValue: true 
  });
  console.log('All inputs:', r2.result?.result?.value);

  // Check for file inputs specifically
  const r3 = await send('Runtime.evaluate', { 
    expression: `document.querySelectorAll('input[type="file"]').length`,
    returnByValue: true 
  });
  console.log('File inputs count:', r3.result?.result?.value);

  // Check if there's an upload button or dropzone
  const r4 = await send('Runtime.evaluate', { 
    expression: `[...document.querySelectorAll('[class*="upload"], [class*="Upload"], [data-e2e*="upload"], button')].slice(0,10).map(e => ({tag: e.tagName, cls: e.className?.toString?.()?.substring(0,80), text: e.textContent?.trim()?.substring(0,40), dataE2e: e.dataset?.e2e}))`,
    returnByValue: true 
  });
  console.log('Upload elements:', JSON.stringify(r4.result?.result?.value, null, 2));

  // Check body text for login redirect
  const r5 = await send('Runtime.evaluate', { 
    expression: 'document.body?.innerText?.substring(0, 300)',
    returnByValue: true 
  });
  console.log('Body preview:', r5.result?.result?.value);

  ws.close();
}

run().catch(e => console.error(e));
