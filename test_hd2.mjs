const cdpBase = 'http://localhost:9222';
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
  setTimeout(() => rej(new Error(method + ' timeout')), 60000);
});

// 在页面里用 fetch 下载视频（带 cookie），转成 base64
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const data = JSON.parse(el.textContent);
      const video = data['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct.video;
      
      // 拿 Q2 最高码率的 URL
      const q2 = (video.bitrateInfo || []).find(b => b.QualityType === '2');
      if (!q2) return JSON.stringify({error: 'no Q2'});
      const url = q2.PlayAddr.UrlList[0];
      
      // 用页面内 fetch 下载（带 cookie 和正确的 Referer）
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return JSON.stringify({error: 'fetch failed: ' + resp.status});
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      
      // 转 base64
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      
      return JSON.stringify({
        size: bytes.length,
        base64Length: base64.length,
        // 只返回前 100 字符确认格式
        base64Head: base64.substring(0, 100),
      });
    } catch(e) { return 'ERROR: ' + e.message; }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});

console.log(r?.result?.result?.value || 'no result');
ws.close();
