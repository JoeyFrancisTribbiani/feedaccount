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
  setTimeout(() => rej(new Error(method + ' timeout')), 15000);
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
      return JSON.stringify({
        playAddr: video.playAddr,
        bitrateInfo: (video.bitrateInfo || []).map(b => ({
          quality: b.QualityType,
          bitrate: b.Bitrate,
          codec: b.CodecType,
          data_size: b.DataSize,
          width: b.Width,
          height: b.Height,
          urls: b.PlayAddr?.UrlList,
        })),
      });
    } catch(e) { return 'ERROR: ' + e.message; }
  })()`,
  returnByValue: true,
});

const val = r?.result?.result?.value;
if (val) {
  const data = JSON.parse(val);
  console.log('playAddr:', data.playAddr);
  console.log('bitrateInfo count:', data.bitrateInfo.length);
  for (const b of data.bitrateInfo) {
    console.log(`  Q${b.quality} | ${b.bitrate}bps | ${b.codec} | ${b.width}x${b.height} | ${b.data_size}bytes`);
    if (b.urls) for (const u of b.urls) console.log(`    ${u}`);
  }
}
ws.close();
