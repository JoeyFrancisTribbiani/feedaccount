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
await send('Page.navigate', { url: 'https://www.tiktok.com/@cierraryyan/video/7684415508044729614' });
await new Promise(r => setTimeout(r, 5000));

// 在页面内 fetch Q2 URL (用 == 匹配，不关心类型)
console.log('Fetching Q2 via page fetch...');
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const data = JSON.parse(el.textContent);
      const video = data['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct.video;
      const bitrateInfo = video.bitrateInfo || [];
      
      // 找最高码率 (Bitrate 最大)
      const best = bitrateInfo.reduce((a, b) => (b.Bitrate > a.Bitrate ? b : a));
      const url = best.PlayAddr.UrlList[0];
      
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return JSON.stringify({error: 'fetch failed: ' + resp.status});
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      
      let binary = '';
      const chunk = 16384;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      
      return JSON.stringify({
        ok: true,
        bitrate: best.Bitrate,
        codec: best.CodecType,
        width: best.PlayAddr.Width,
        height: best.PlayAddr.Height,
        size: bytes.length,
        sizeMB: (bytes.length/1024/1024).toFixed(2),
        base64,
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
    console.log('Codec:', data.codec, '| Bitrate:', data.bitrate, '| Resolution:', data.width + 'x' + data.height);
    console.log('Size:', data.sizeMB, 'MB', '(', data.size, 'bytes)');
    const buf = Buffer.from(data.base64, 'base64');
    fs.writeFileSync('D:/Download/test_cdp_best.mp4', buf);
    console.log('Saved to D:/Download/test_cdp_best.mp4');
  }
} else {
  console.log('No result');
}
ws.close();
