const WebSocket = require('ws');
const http = require('http');

// 获取已打开窗口的 page 列表
function getPages(httpUrl) {
  return new Promise((resolve, reject) => {
    http.get(`http://${httpUrl}/json`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d).filter(t => t.type === 'page');
        resolve(tabs);
      });
    }).on('error', reject);
  });
}

async function run() {
  const httpUrl = '127.0.0.1:9339';
  const tabs = await getPages(httpUrl);
  console.log('Tabs:', tabs.length);
  for (const t of tabs) {
    console.log(`  ${t.url?.substring(0, 80)}  title=${t.title?.substring(0, 40)}`);
  }

  if (tabs.length === 0) {
    console.log('No page tabs found');
    return;
  }

  // 连接第一个 tab 检查 URL 和页面状态
  const tab = tabs[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
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

  // 导航到 upload 页面
  console.log('\nNavigating to TikTok Studio upload...');
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://www.tiktok.com/tiktokstudio/upload' });
  
  // 等待
  await new Promise(r => setTimeout(r, 5000));

  // 检查当前 URL
  const r1 = await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
  console.log('Current URL:', r1.result?.result?.value);

  // 检查页面标题
  const r2 = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  console.log('Page title:', r2.result?.result?.value);

  // 检查有没有 file input
  const r3 = await send('Runtime.evaluate', { expression: 'document.querySelectorAll(\'input[type="file"]\').length', returnByValue: true });
  console.log('File inputs found:', r3.result?.result?.value);

  // 检查 body 文本（看是否是登录页）
  const r4 = await send('Runtime.evaluate', { expression: 'document.body?.innerText?.substring(0, 200)', returnByValue: true });
  console.log('Body text preview:', r4.result?.result?.value);

  ws.close();
}

run().catch(e => console.error(e));
