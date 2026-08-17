/**
 * 监听 ChatGPT 提交按钮状态变化
 * 用法: node test/test-button-monitor.js
 * 
 * 每2秒抓取一次按钮状态，记录变化
 */
import http from 'http';

const DAEMON_URL = 'http://localhost:9223';

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(urlObj, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getButtonState() {
  const script = `(function(){
    // 找提交按钮
    var btn = document.querySelector('button[class*="composer-submit-button"]');
    if (!btn) return JSON.stringify({error: 'no submit button'});
    
    var aria = btn.getAttribute('aria-label') || '';
    var testid = btn.dataset.testid || '';
    var cls = btn.className || '';
    var rect = btn.getBoundingClientRect();
    
    // 检查按钮内的图标/内容
    var innerHTML = btn.innerHTML.substring(0, 200);
    
    // 检查是否有 stop-button
    var stopBtns = document.querySelectorAll('button[data-testid="stop-button"]');
    var hasStop = false;
    for (var s of stopBtns) { if (s.offsetParent !== null) hasStop = true; }
    
    // 检查按钮是否显示停止图标（方块）
    var svg = btn.querySelector('svg');
    var svgPath = svg ? svg.innerHTML.substring(0, 100) : '';
    
    return JSON.stringify({
      aria: aria,
      testid: testid,
      cls: cls.substring(0, 80),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0,
      hasStop: hasStop,
      svgPath: svgPath,
      innerHTML: innerHTML.substring(0, 150),
      timestamp: new Date().toISOString()
    });
  })()`;

  const payload = JSON.stringify({ commands: [{ action: 'evaluate', script }] });
  const res = await fetchJson(`${DAEMON_URL}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  if (res.results && res.results[0] && res.results[0].result) {
    return JSON.parse(res.results[0].result);
  }
  return { error: 'failed to get button state', raw: JSON.stringify(res).substring(0, 200) };
}

async function main() {
  console.log('=== ChatGPT 提交按钮状态监听 ===');
  console.log('每2秒抓取一次，状态变化时打印\n');
  
  let lastState = null;
  let count = 0;
  
  while (true) {
    try {
      const state = await getButtonState();
      count++;
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      
      if (state.error) {
        console.log(`[${ts}] #${count} 错误: ${state.error}`);
      } else {
        // 状态变化时打印
        const stateKey = `${state.aria}|${state.hasStop}|${state.svgPath}`;
        if (!lastState || lastState !== stateKey) {
          console.log(`[${ts}] #${count} 状态变化!`);
          console.log(`  aria-label: ${state.aria}`);
          console.log(`  hasStop: ${state.hasStop}`);
          console.log(`  svgPath: ${state.svgPath}`);
          console.log(`  innerHTML: ${state.innerHTML.substring(0, 100)}`);
          console.log(`  class: ${state.cls}`);
          console.log('');
          lastState = stateKey;
        } else {
          // 没变化也每30次打印一次心跳
          if (count % 30 === 0) {
            console.log(`[${ts}] #${count} 心跳: aria=${state.aria} hasStop=${state.hasStop}`);
          }
        }
      }
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 请求失败: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(err => console.error('异常:', err.message));
