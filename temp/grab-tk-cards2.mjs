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

// 导航到账号主页
console.log('Navigating to profile...');
await send('Page.navigate', { url: 'https://www.tiktok.com/@bougieeditblog' });
await new Promise(r => setTimeout(r, 5000));

// 检查当前URL
const urlR = await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
console.log('URL:', urlR.result?.result?.value);

// 滚动加载
await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
await new Promise(r => setTimeout(r, 3000));
await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
await new Promise(r => setTimeout(r, 3000));

// 抓取视频卡片 - TikTok主页视频卡片结构
const r1 = await send('Runtime.evaluate', {
  expression: `
    (function() {
      // TikTok profile page video cards use data-e2e="user-post-item" or similar
      var selectors = [
        '[data-e2e="user-post-item"]',
        '[data-e2e="user-post-item-list"] > div',
        'div[class*="DivItemContainer"]',
        'a[href*="/video/"]'
      ];
      var info = {};
      for (var s of selectors) {
        info[s] = document.querySelectorAll(s).length;
      }
      
      // 找视频卡片
      var cards = document.querySelectorAll('[data-e2e="user-post-item"]') || [];
      if (!cards.length) {
        // fallback: 找所有 /video/ 链接的容器
        var links = document.querySelectorAll('a[href*="/video/"]');
        var seen = new Set();
        var results = [];
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute('href') || '';
          var m = href.match(/\\/video\\/(\\d+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          // 向上找带播放量的容器
          var card = links[i];
          for (var j = 0; j < 8; j++) {
            if (!card.parentElement) break;
            card = card.parentElement;
            var cls = card.className || '';
            if (cls.indexOf('ItemContainer') >= 0 || cls.indexOf('PostItem') >= 0) break;
          }
          results.push({
            videoId: m[1],
            cardText: (card.innerText || '').substring(0, 200),
            cardClass: (card.className || '').substring(0, 100),
            cardHTML: (card.outerHTML || '').substring(0, 600),
          });
          if (results.length >= 3) break;
        }
        return JSON.stringify({ selectors: info, cards: results });
      }
      
      var cardData = [];
      for (var i = 0; i < Math.min(3, cards.length); i++) {
        cardData.push({
          cardText: (cards[i].innerText || '').substring(0, 200),
          cardClass: (cards[i].className || '').substring(0, 100),
          cardHTML: (cards[i].outerHTML || '').substring(0, 600),
        });
      }
      return JSON.stringify({ selectors: info, cards: cardData });
    })()
  `,
  returnByValue: true,
});

const val = r1.result?.result?.value;
if (val) {
  try {
    const data = JSON.parse(val);
    console.log('\nSelectors:', JSON.stringify(data.selectors));
    console.log('\nCards:', data.cards.length);
    data.cards.forEach((c, i) => {
      console.log(`\n--- Card ${i+1} ---`);
      console.log('Class:', c.cardClass);
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
