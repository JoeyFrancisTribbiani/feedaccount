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
  setTimeout(() => rej(new Error(method + ' timeout')), 120000);
});

await send('Page.enable');
await send('Page.navigate', { url: 'https://www.tiktok.com/@cierraryyan/video/7684415508044729614' });
await new Promise(r => setTimeout(r, 5000));

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const data = JSON.parse(el.textContent);
      const video = data['__DEFAULT_SCOPE__']['webapp.video-detail'].itemInfo.itemStruct.video;
      const bitrateInfo = video.bitrateInfo || [];
      // 打印每个 bitrateInfo 的完整结构
      return JSON.stringify(bitrateInfo.map(b => {
        const keys = Object.keys(b);
        const playAddrKeys = b.PlayAddr ? Object.keys(b.PlayAddr) : [];
        const urls = b.PlayAddr?.UrlList || [];
        return {
          QualityType: b.QualityType,
          Bitrate: b.Bitrate,
          CodecType: b.CodecType,
          PlayAddrKeys: playAddrKeys,
          UrlCount: urls.length,
          FirstUrl: urls[0] ? urls[0].substring(0, 80) : null,
          OtherKeys: keys.filter(k => k !== 'PlayAddr' && k !== 'QualityType' && k !== 'Bitrate' && k !== 'CodecType'),
        };
      }));
    } catch(e) { return 'ERROR: ' + e.message; }
  })()`,
  returnByValue: true,
});

console.log(r?.result?.result?.value || 'no result');
ws.close();
