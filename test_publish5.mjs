// 用 page-level CDP 直接 JS 操作 file input
const pageWsUrl = 'ws://127.0.0.1:7539/devtools/page/5475FFD96208FA6814E9E56316FEB9FF';
const filePath = 'D:/Download/mmexport1789272791126.mp4';

(async () => {
  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 10000);
  });

  let msgId = 0;
  function sendCDP(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      const handler = (e) => { const d = JSON.parse(e.data); if (d.id === id) { ws.removeEventListener('message', handler); resolve(d); } };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
    });
  }
  const evalJS = (expr) => sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });

  await sendCDP('Runtime.enable', {});
  await sendCDP('Page.enable', {});
  // 也启用 DOM
  await sendCDP('DOM.enable', {});

  // 方法1: 用 DOM.getDocument + DOM.querySelector (重试)
  console.log('[1] 尝试 DOM.getDocument...');
  const docRes = await sendCDP('DOM.getDocument', { depth: -1 });
  console.log('doc result:', JSON.stringify(docRes).substring(0, 200));

  if (docRes?.root?.nodeId) {
    const qiRes = await sendCDP('DOM.querySelector', {
      nodeId: docRes.root.nodeId,
      selector: 'input[type="file"]',
    });
    console.log('querySelector:', JSON.stringify(qiRes));
    
    if (qiRes?.nodeId) {
      console.log('setFileInputFiles...');
      const setRes = await sendCDP('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: qiRes.nodeId,
      });
      console.log('setFile result:', JSON.stringify(setRes));
    }
  }

  // 检查文件是否上传了
  await new Promise(r => setTimeout(r, 3000));
  const checkRes = await evalJS(`(() => {
    const input = document.querySelector('input[type="file"]');
    return JSON.stringify({
      files: input?.files?.length || 0,
      bodyText: document.body.innerText?.substring(0, 200),
      hasEditor: !!document.querySelector('.public-DraftEditor-content, [contenteditable="true"], textarea'),
    });
  })()`);
  console.log('上传后状态:', checkRes?.result?.result?.value);

  // 方法2: 如果 DOM API 不行，用 Runtime + IO.read + fetch
  // 先把文件读成 base64，然后在页面里 fetch blob
  const check2 = JSON.parse(checkRes?.result?.result?.value || '{}');
  if (!check2.hasEditor) {
    console.log('\n[2] DOM API 不行，用 Runtime + base64 方式...');
    
    // 读文件为 base64
    const fs = await import('fs');
    const fileBuf = fs.readFileSync(filePath);
    const base64 = fileBuf.toString('base64');
    console.log('文件大小:', fileBuf.length, 'base64长度:', base64.length);
    
    // 分块传到页面，用 fetch + blob 构造 File
    // 先在页面创建一个函数接收 base64
    console.log('传 base64 到页面...');
    
    // 分块：每次 1MB
    const chunkSize = 1024 * 1024;
    const totalChunks = Math.ceil(base64.length / chunkSize);
    
    // 初始化
    await evalJS('window.__tk_base64 = "";');
    
    for (let i = 0; i < totalChunks; i++) {
      const chunk = base64.substring(i * chunkSize, (i + 1) * chunkSize);
      await evalJS(`window.__tk_base64 += "${chunk}";`);
      if (i % 5 === 0) console.log(`  传输中... ${i+1}/${totalChunks}`);
    }
    console.log('base64 传输完成');
    
    // 构造 File 对象并设置到 input
    console.log('构造 File 对象...');
    const setFileRes = await evalJS(`
      (async () => {
        try {
          const base64 = window.__tk_base64;
          window.__tk_base64 = ''; // 释放内存
          
          // base64 -> Uint8Array
          const byteChars = atob(base64);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          
          // 构造 File
          const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
          
          // 设置到 input
          const input = document.querySelector('input[type="file"]');
          if (!input) return 'no input';
          
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          
          // 触发 change 事件
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          
          return 'file set: ' + input.files.length + ' files, size: ' + file.size;
        } catch(e) { return 'error: ' + e.message; }
      })()
    `);
    console.log('设置文件结果:', setFileRes?.result?.result?.value);
    
    // 等待编辑器
    console.log('\n等待编辑器...');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await evalJS(`(() => {
        const editor = document.querySelector('.public-DraftEditor-content')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('div[data-e2e="caption-input"]')
          || document.querySelector('textarea');
        const btns = [...document.querySelectorAll('button')];
        const postBtn = btns.find(b => /post|发布/i.test(b.textContent));
        return JSON.stringify({ hasEditor: !!editor, hasPostBtn: !!postBtn, postDisabled: postBtn ? (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') : true });
      })()`);
      const s = JSON.parse(check?.result?.result?.value || '{}');
      if (i % 5 === 0) console.log(`[${i+1}s] editor=${s.hasEditor} postBtn=${s.hasPostBtn} disabled=${s.postDisabled}`);
      if (s.hasEditor && s.hasPostBtn && !s.postDisabled) {
        console.log('\n✅ 编辑器就绪！填写标题...');
        await evalJS(`(() => { const e = document.querySelector('.public-DraftEditor-content, [contenteditable="true"], textarea'); if(e){e.focus();return true;} return false; })()`);
        await new Promise(r => setTimeout(r, 500));
        await sendCDP('Input.insertText', { text: 'Test upload 🎬 #test #fyp' });
        await new Promise(r => setTimeout(r, 1000));
        
        console.log('点击发布...');
        const clickRes = await evalJS(`(() => {
          const btns = [...document.querySelectorAll('button')];
          const postBtn = btns.find(b => /post|发布/i.test(b.textContent));
          if (!postBtn) return 'no button';
          postBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          postBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          postBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return postBtn.textContent?.trim();
        })()`);
        console.log('点击:', clickRes?.result?.result?.value);
        
        for (let j = 0; j < 30; j++) {
          await new Promise(r => setTimeout(r, 1000));
          const doneCheck = await evalJS(`(() => {
            const text = document.body.innerText || '';
            const isDone = text.includes('Your video is being uploaded') || text.includes('Manage your posts') || text.includes('Upload another video') || text.includes('你的视频正在上传') || text.includes('管理你的作品');
            const link = document.querySelector('a[href*="/video/"]');
            return JSON.stringify({ isDone, videoUrl: link ? link.href : '' });
          })()`);
          const ret = JSON.parse(doneCheck?.result?.result?.value || '{}');
          if (ret.isDone || ret.videoUrl) { console.log('\n✅ 发布成功！', ret); break; }
          if (j % 5 === 0) console.log(`等待发布... ${j+1}s`);
        }
        break;
      }
    }
  }

  ws.close();
  console.log('\nDone.');
})().catch(e => { console.error('Error:', e.message); });
