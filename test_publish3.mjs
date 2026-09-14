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

  // 启用 DOM 和 Page
  await sendCDP('DOM.enable', {});
  await sendCDP('Page.enable', {});

  // 1. 找 file input 的 nodeId
  console.log('[1] 查找 file input...');
  const doc = await sendCDP('DOM.getDocument', { depth: -1 });
  console.log('document nodeId:', doc?.root?.nodeId);
  
  const fileInputRes = await sendCDP('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  console.log('querySelector result:', JSON.stringify(fileInputRes));

  // 如果 DOM.querySelector 不行，用 Runtime.evaluate 找
  let fileInputNodeId = fileInputRes?.nodeId;
  
  if (!fileInputNodeId) {
    console.log('DOM.querySelector 失败，用 Runtime 方式...');
    // 用 Runtime.evaluate 给 file input 加个 id
    await evalJS(`
      const input = document.querySelector('input[type="file"]');
      if (input) { input.id = '__tk_file_input__'; }
    `);
    
    // 再用 querySelector
    const fileInputRes2 = await sendCDP('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '#__tk_file_input__',
    });
    fileInputNodeId = fileInputRes2?.nodeId;
    console.log('retry nodeId:', fileInputNodeId);
  }

  if (!fileInputNodeId) {
    // 最后手段：用 requestNode 然后从 JS 获取
    console.log('用 Runtime.requestNode...');
    const nodeRes = await evalJS(`document.querySelector('input[type="file"]')`);
    // 获取 objectId
    const objectId = nodeRes?.result?.result?.objectId;
    if (objectId) {
      const descRes = await sendCDP('DOM.requestNode', { objectId });
      fileInputNodeId = descRes?.nodeId;
      console.log('requestNode nodeId:', fileInputNodeId);
    }
  }

  if (!fileInputNodeId) {
    console.log('❌ 找不到 file input');
    ws.close();
    return;
  }

  // 2. 设置文件
  console.log('[2] 设置文件:', filePath);
  await sendCDP('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: fileInputNodeId,
  });
  console.log('文件已设置');

  // 3. 等待编辑器就绪
  console.log('[3] 等待编辑器...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const check = await evalJS(`(() => {
      const editor = document.querySelector('.public-DraftEditor-content')
        || document.querySelector('[contenteditable="true"]')
        || document.querySelector('div[data-e2e="caption-input"]')
        || document.querySelector('textarea');
      const btns = [...document.querySelectorAll('button')];
      const postBtn = btns.find(b => /post|发布/i.test(b.textContent));
      return JSON.stringify({ 
        hasEditor: !!editor, 
        hasPostBtn: !!postBtn, 
        postDisabled: postBtn ? (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') : true,
        bodyText: document.body.innerText?.substring(0, 100),
      });
    })()`);
    const s = JSON.parse(check?.result?.result?.value || '{}');
    if (s.hasEditor) {
      console.log(`[${i+1}s] editor ✓ postBtn=${s.hasPostBtn} disabled=${s.postDisabled}`);
    }
    if (s.hasEditor && s.hasPostBtn && !s.postDisabled) {
      console.log('\n编辑器就绪！填写标题...');
      
      await evalJS(`(() => {
        const editor = document.querySelector('.public-DraftEditor-content')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('textarea');
        if (editor) { editor.focus(); return true; }
        return false;
      })()`);
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
      console.log('点击结果:', clickRes?.result?.result?.value);
      
      for (let j = 0; j < 30; j++) {
        await new Promise(r => setTimeout(r, 1000));
        const doneCheck = await evalJS(`(() => {
          const text = document.body.innerText || '';
          const isDone = text.includes('Your video is being uploaded') || text.includes('Manage your posts') || text.includes('Upload another video') || text.includes('你的视频正在上传') || text.includes('管理你的作品');
          const link = document.querySelector('a[href*="/video/"]');
          return JSON.stringify({ isDone, videoUrl: link ? link.href : '' });
        })()`);
        const ret = JSON.parse(doneCheck?.result?.result?.value || '{}');
        if (ret.isDone || ret.videoUrl) {
          console.log('\n✅ 发布成功！', ret);
          break;
        }
        if (j % 5 === 0) console.log(`等待发布... ${j+1}s`);
      }
      break;
    }
  }

  ws.close();
  console.log('\nDone.');
})().catch(e => { console.error('Error:', e.message); });
