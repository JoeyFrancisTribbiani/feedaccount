const cdpBase = 'http://localhost:9222';
const fs = await import('fs');

const tabs = await (await fetch(cdpBase + '/json')).json();
const page = tabs.find(t => t.type === 'page' && t.url.includes('tiktok'));
if (!page) { console.log('no tiktok page'); process.exit(1); }

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

await send('Page.enable');
console.log('Navigating...');
await send('Page.navigate', { url: 'https://www.tiktok.com/@cierraryyan/video/7684415508044729614' });
await new Promise(r => setTimeout(r, 5000));

// 在页面内 fetch Q2 bitrateInfo 的 URL
console.log('Fetching Q2 video via page context...');
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const data = JSON.parse(el.textContent);
      const video = data['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct.video;
      const bitrateInfo = video.bitrateInfo || [];
      
      // 找 Q2 (QualityType=2, 最高码率 h265 1080p)
      const q2 = bitrateInfo.find(b => b.QualityType === '2');
      if (!q2 || !q2.PlayAddr || !q2.PlayAddr.UrlList) return JSON.stringify({error: 'no Q2 url', available: bitrateInfo.map(b=>b.QualityType)});
      const url = q2.PlayAddr.UrlList[0];
      
      // 页面内 fetch
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return JSON.stringify({error: 'fetch Q2 failed: ' + resp.status});
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      
      let binary = '';
      const chunk = 16384;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      
      return JSON.stringify({ok: true, size: bytes.length, sizeMB: (bytes.length/1024/1024).toFixed(2), base64});
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
    const buf = Buffer.from(data.base64, 'base64');
    fs.writeFileSync('D:/Download/test_cdp_q2_hd.mp4', buf);
    console.log('Saved to D:/Download/test_cdp_q2_hd.mp4');
  }
} else {
  console.log('No result');
}
ws.close();
