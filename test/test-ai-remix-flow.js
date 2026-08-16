/**
 * AI 混剪后半段测试：检测ChatGPT完成 → 下载图片 → 拼接视频
 * 
 * 用法：node test/test-ai-remix-flow.js
 * 
 * 前提条件：
 * 1. 主服务在运行 (端口 39210)
 * 2. CDP daemon 在运行 (端口 9223)
 * 3. ChatGPT 页面上有已完成的图片生成结果
 */

import http from 'http';

const SERVER_URL = 'http://127.0.0.1:39210';
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
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, text: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function test() {
  console.log('=== AI 混剪后半段测试 ===\n');

  // Step 1: 检查 daemon 健康
  console.log('Step 1: 检查 daemon 健康...');
  const health = await fetchJson(`${DAEMON_URL}/health`);
  if (!health.json?.ok) {
    console.log('❌ daemon 不可用，请先启动 daemon');
    return;
  }
  console.log(`✅ daemon 正常, CDP连接=${health.json.cdpConnected}, 页面=${health.json.pageUrl?.substring(0, 50)}\n`);

  // Step 2: 检测 ChatGPT 页面状态（检测完成状态）
  console.log('Step 2: 检测 ChatGPT 页面状态...');
  const stateScript = `(function(){
    var turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    var lastTurn = null;
    for(var i=turns.length-1;i>=0;i--){
      if(turns[i].getAttribute('data-message-author-role')!=='user'){lastTurn=turns[i];break}
    }
    if(!lastTurn) return JSON.stringify({error:'no assistant turn'});
    var imgs = lastTurn.querySelectorAll('img[src*="estuary/content"], img[src*="oaiusercontent"], img[src*="files."]');
    var text = lastTurn.textContent.trim();
    var submitBtn = document.querySelector('button[class*="composer-submit-button"]');
    var submitAria = submitBtn ? (submitBtn.getAttribute('aria-label')||'') : '';
    var stopBtns = document.querySelectorAll('button[data-testid="stop-button"]');
    var isGenerating = false;
    for(var i=0;i<stopBtns.length;i++){if(stopBtns[i].offsetParent!==null) isGenerating=true;}
    if(submitAria.indexOf('停止')>=0||submitAria.indexOf('Stop')>=0) isGenerating=true;
    return JSON.stringify({textLen:text.length, imgCount:imgs.length, isGenerating:isGenerating, submitAria:submitAria});
  })()`;

  const execRes = await fetchJson(`${DAEMON_URL}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ action: 'evaluate', script: stateScript }] }),
  });

  if (!execRes.json?.ok) {
    console.log('❌ 无法获取页面状态:', execRes.json?.error);
    return;
  }
  const state = JSON.parse(execRes.json.results[0].result);
  console.log(`  文本长度: ${state.textLen}`);
  console.log(`  图片数量: ${state.imgCount}`);
  console.log(`  正在生成: ${state.isGenerating}`);
  console.log(`  提交按钮: ${state.submitAria}`);

  if (state.isGenerating) {
    console.log('❌ ChatGPT 仍在生成中，请等待完成后再测试');
    return;
  }
  if (state.imgCount === 0) {
    console.log('❌ 页面上没有图片，请先让 ChatGPT 生成图片');
    return;
  }
  console.log('✅ 检测到 ChatGPT 已完成，有图片\n');

  // Step 3: 测试图片下载
  console.log('Step 3: 测试图片下载...');
  const dlRes = await fetchJson(`${DAEMON_URL}/api/download-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!dlRes.json?.ok) {
    console.log('❌ 图片下载失败:', dlRes.json?.error);
    return;
  }
  const images = dlRes.json.images || [];
  const successCount = images.filter(i => i.filename).length;
  console.log(`✅ 下载了 ${successCount}/${images.length} 张图片`);
  images.forEach((img, i) => {
    if (img.filename) console.log(`  ${i + 1}. ${img.filename} (${Math.round(img.size / 1024)}KB)`);
    else console.log(`  ${i + 1}. 失败: ${img.error}`);
  });

  if (successCount === 0) {
    console.log('❌ 没有成功下载的图片，无法继续拼接');
    return;
  }
  console.log('');

  // Step 4: 测试图片拼接（通过提交一个模拟的 AI 混剪任务）
  console.log('Step 4: 测试图片拼接（通过 API 提交任务）...');
  
  // 获取第一个达人和视频
  const creatorsRes = await fetchJson(`${SERVER_URL}/api/remix/creators`);
  const creators = Array.isArray(creatorsRes.json) ? creatorsRes.json : [];
  if (!creators.length) {
    console.log('❌ 没有达人数据');
    return;
  }
  const creator = creators[0];
  console.log(`  达人: ${creator.name}`);

  const videosRes = await fetchJson(`${SERVER_URL}/api/remix/creators/${creator.id}/videos`);
  const videos = Array.isArray(videosRes.json) ? videosRes.json : (videosRes.json?.videos || []);
  if (!videos.length) {
    console.log('❌ 没有视频数据');
    return;
  }
  const video = videos[0];
  console.log(`  视频: ${video.title}`);

  // 获取第一个矩阵
  const matricesRes = await fetchJson(`${SERVER_URL}/api/matrices`);
  const matrices = Array.isArray(matricesRes.json) ? matricesRes.json : [];
  if (!matrices.length) {
    console.log('❌ 没有矩阵数据');
    return;
  }
  const matrix = matrices[0];
  console.log(`  矩阵: ${matrix.name}`);

  // 获取第一个方案
  const presetsRes = await fetchJson(`${SERVER_URL}/api/ai-presets`);
  const presets = Array.isArray(presetsRes.json) ? presetsRes.json : [];
  if (!presets.length) {
    console.log('❌ 没有方案数据');
    return;
  }
  const preset = presets[0];
  console.log(`  方案: ${preset.name}`);

  // 获取 CDP 实例
  const instancesRes = await fetchJson(`${SERVER_URL}/api/cdp/instances`);
  const instances = instancesRes.json?.instances || [];
  if (!instances.length) {
    console.log('❌ 没有 CDP 实例');
    return;
  }
  const instance = instances[0];
  console.log(`  CDP实例: ${instance.name}`);

  console.log('\n  提交 AI 混剪任务...');
  const taskRes = await fetchJson(`${SERVER_URL}/api/remix/ai-remix-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      matrixIds: [matrix.id],
      creatorId: creator.id,
      videoIds: [video.id],
      cdpInstanceId: instance.id,
      presetId: preset.id,
      prompt: preset.prompt.substring(0, 200),
      ratio: '9:16',
    }),
  });

  if (taskRes.json?.tasks?.length > 0) {
    const task = taskRes.json.tasks[0];
    console.log(`  ✅ 任务已创建: ${task.id}`);
    console.log('\n  任务正在后台处理中，请监控日志查看进度:');
    console.log(`  - CDP Tab 实时日志`);
    console.log(`  - 去重/混剪历史中的任务状态`);
    console.log(`  - 任务ID: ${task.id}`);
  } else {
    console.log('❌ 任务创建失败:', taskRes.json?.error || JSON.stringify(taskRes.json));
  }

  console.log('\n=== 测试完成 ===');
  console.log('后续处理（图片下载→拼接→矩阵链接）会在后台异步完成');
  console.log('请观察 CDP Tab 的实时日志确认流程是否顺畅');
}

test().catch(err => console.error('测试异常:', err.message));
