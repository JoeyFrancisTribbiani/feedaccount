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
const tkTab = tabs.find(t => t.type === 'page' && /tiktok\.com/.test(t.url));
if (!tkTab) { console.log('No TikTok tab'); process.exit(1); }

const ws = new WebSocket(tkTab.webSocketDebuggerUrl);
let msgId = 0;
const pending = {};
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
});
await new Promise(r => ws.on('open', r));
function send(method, params = {}) {
  return new Promise(r => { const id = ++msgId; pending[id] = r; ws.send(JSON.stringify({ id, method, params })); });
}

// Grab full HTML of first 2 video cards
const r1 = await send('Runtime.evaluate', {
  expression: `
    (function() {
      var cards = document.querySelectorAll('[data-e2e="user-post-item"]');
      if (!cards.length) return 'no cards';
      var result = [];
      for (var i = 0; i < Math.min(2, cards.length); i++) {
        result.push({
          outerHTML: cards[i].outerHTML,
        });
      }
      return JSON.stringify(result);
    })()
  `,
  returnByValue: true,
});

const val = r1.result?.result?.value;
if (val) {
  try {
    const cards = JSON.parse(val);
    cards.forEach((c, i) => {
      console.log(`\n=== Card ${i+1} full HTML ===`);
      console.log(c.outerHTML);
    });
  } catch(e) {
    console.log('Raw:', val.substring(0, 2000));
  }
} else {
  console.log('Result:', JSON.stringify(r1.result?.result).substring(0, 500));
}

ws.close();
