import http from 'node:http';
import { WebSocket } from 'ws';

function fetch_json(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const tabs = await fetch_json('http://127.0.0.1:9339/json');
const tkTab = tabs.find(t => t.type === 'page' && /tiktok\.com\/@/.test(t.url));
if (!tkTab) { console.log('No profile tab found'); process.exit(1); }
console.log('Tab:', tkTab.url);

const ws = new WebSocket(tkTab.webSocketDebuggerUrl);
let msgId = 0;
const pending = {};

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
});

await new Promise(r => ws.on('open', r));

function send(method, params = {}) {
  return new Promise(r => {
    const id = ++msgId;
    pending[id] = r;
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Scroll to load videos
await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
await new Promise(r => setTimeout(r, 3000));

const r1 = await send('Runtime.evaluate', {
  expression: `
    (function() {
      var links = document.querySelectorAll('a[href*="/video/"]');
      if (!links.length) return JSON.stringify({error: 'no video links found', bodyLen: document.body.innerText.length});
      var cards = [];
      var seen = new Set();
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var href = link.getAttribute('href') || '';
        var m = href.match(/\\/video\\/(\\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        var card = link;
        for (var j = 0; j < 6; j++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          var text = card.innerText || '';
          if (text.length > 20 && text.length < 500) break;
        }
        cards.push({
          videoId: m[1],
          cardText: (card.innerText || '').substring(0, 300),
          cardHTML: (card.outerHTML || '').substring(0, 800),
        });
        if (cards.length >= 3) break;
      }
      return JSON.stringify(cards);
    })()
  `,
  returnByValue: true,
});

const val = r1.result?.result?.value;
if (val) {
  try {
    const cards = JSON.parse(val);
    cards.forEach((c, i) => {
      console.log(`\n--- Card ${i+1} (videoId: ${c.videoId}) ---`);
      console.log('Text:', c.cardText);
      console.log('HTML:', c.cardHTML);
    });
  } catch(e) {
    console.log('Parse error:', e.message);
    console.log('Raw:', val);
  }
} else {
  console.log('Result:', JSON.stringify(r1.result?.result).substring(0, 500));
}

ws.close();
