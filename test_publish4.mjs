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

  // 启用需要的域
  await sendCDP('Runtime.enable', {});
  await sendCDP('Page.enable', {});

  // 1. 检查 file input
  console.log('[1] 检查 file input...');
  const checkRes = await evalJS(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) return JSON.stringify({ found: false });
    return JSON.stringify({ 
      found: true,
      type: input.type,
      accept: input.accept,
      multiple: input.multiple,
      id: input.id,
      className: input.className?.substring(0, 80),
      parentClass: input.parentElement?.className?.substring(0, 80),
    });
  })()`);
  console.log('File input:', checkRes?.result?.result?.value);

  // 2. 用 Runtime获取 objectId，然后 DOM.setFileInputFiles by objectId
  console.log('\n[2] 上传文件...');
  
  // 获取 file input 的 remote objectId
  const objRes = await sendCDP('Runtime.evaluate', {
    expression: 'document.querySelector(\'input[type="file"]\')',
    returnByValue: false,
  });
  const objectId = objRes?.result?.result?.objectId;
  console.log('ObjectId:', objectId);

  if (objectId) {
    // 用 DOM.requestNode 拿 nodeId
    const nodeRes = await sendCDP('DOM.requestNode', { objectId });
    console.log('Node result:', JSON.stringify(nodeRes));
    const nodeId = nodeRes?.nodeId;
    console.log('NodeId:', nodeId);
    
    if (nodeId) {
      console.log('设置文件:', filePath);
      const setRes = await sendCDP('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: nodeId,
      });
      console.log('setFileInputFiles:', JSON.stringify(setRes));
    }
  }

  // 3. 如果上面不行，用另一种方式：构造 DataTransfer
  if (!objectId) {
    console.log('objectId 为空，尝试 JS 方式...');
  }

  // 4. 等待编辑器就绪
  console.log('\n[3] 等待编辑器...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const check = await evalJS(`(() => {
      const editor = document.querySelector('.public-DraftEditor-content')
        || document.querySelector('[contenteditable="true"]')
        || document.querySelector('div[data-e2e="caption-input"]')
        || document.querySelector('textarea');
      const btns = [...document.querySelectorAll('button')];
      const postBtn = btns.find(b => /post|发布/i.test(b.textContent));
      const bodyText = document.body?.innerText?.substring(0, 100) || '';
      return JSON.stringify({ 
        hasEditor: !!editor, 
        hasPostBtn: !!postBtn, 
        postDisabled: postBtn ? (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') : true,
        bodyText,
      });
    })()`);
    const s = JSON.parse(check?.result?.result?.value || '{}');
    
    if (i % 5 === 0 || s.hasEditor) {
      console.log(`[${i+1}s] editor=${s.hasEditor} postBtn=${s.hasPostBtn} disabled=${s.postDisabled} body="${s.bodyText?.substring(0, 50)}"`);
    }
    
    if (s.hasEditor && s.hasPostBtn && !s.postDisabled) {
      console.log('\n✅ 编辑器就绪！填写标题...');
      
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
})().catch(e => { console.error('Error:', e.message, e.stack); });
