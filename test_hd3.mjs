const cdpBase = 'http://localhost:9222';
const fs = await import('fs');

const tabs = await (await fetch(cdpBase + '/json')).json();
const page = tabs.find(t => t.type === 'page' && t.url.includes('tiktok'));
if (!page) { console.log('no tiktok page'); process.exit(1); }

console.log('Using page:', page.url.substring(0, 60));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); setTimeout(() => rej(new Error('timeout')), 10000); });

let id = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const h = (e) => { const d = JSON.parse(e.data); if (d.id === i) { ws.removeEventListener('message', h); res(d); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => rej(new Error(method + ' timeout')), 120000);
});

// 先导航到视频页面
await send('Page.enable');
console.log('Navigating to video page...');
await send('Page.navigate', { url: 'https://www.tiktok.com/@cierraryyan/video/7684415508044729614' });
await new Promise(r => setTimeout(r, 5000));

// 在页面内用 fetch 下载视频
console.log('Fetching video via page context...');
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el) return JSON.stringify({error: 'no universal data'});
      const data = JSON.parse(el.textContent);
      const video = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct?.video;
      if (!video) return JSON.stringify({error: 'no video'});
      
      // playAddr 就是最高码率版本
      const playAddr = video.playAddr;
      if (!playAddr) return JSON.stringify({error: 'no playAddr'});
      
      // 用页面内 fetch 下载（带 cookie）
      const resp = await fetch(playAddr, { credentials: 'include' });
      if (!resp.ok) return JSON.stringify({error: 'fetch failed: ' + resp.status, url: playAddr.substring(0, 80)});
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      
      // 转 base64 分块返回
      let binary = '';
      const chunk = 16384;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      
      return JSON.stringify({
        ok: true,
        size: bytes.length,
        sizeMB: (bytes.length / 1024 / 1024).toFixed(2),
        base64: base64,
      });
    } catch(e) { return JSON.stringify({error: e.message}); }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});

const val = r?.result?.result?.value;
if (val) {
  const data = JSON.parse(val);
  if (data.error) {
    console.log('Error:', data.error);
  } else {
    console.log('Downloaded:', data.sizeMB, 'MB', '(', data.size, 'bytes)');
    // 写入文件
    const buf = Buffer.from(data.base64, 'base64');
    fs.writeFileSync('D:/Download/test_cdp_hd.mp4', buf);
    console.log('Saved to D:/Download/test_cdp_hd.mp4');
  }
} else {
  console.log('No result, full:', JSON.stringify(r?.result).substring(0, 300));
}
ws.close();
