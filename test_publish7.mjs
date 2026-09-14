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

  await sendCDP('DOM.enable', {});
  await sendCDP('Page.enable', {});
  await sendCDP('Runtime.enable', {});

  // 1. DOM.getDocument - 注意返回结构是 { result: { root: { nodeId } } }
  console.log('[1] DOM.getDocument...');
  const docRes = await sendCDP('DOM.getDocument', { depth: -1 });
  const rootNodeId = docRes?.result?.root?.nodeId;
  console.log('root nodeId:', rootNodeId);

  // 2. DOM.querySelector
  console.log('[2] querySelector input[type=file]...');
  const qiRes = await sendCDP('DOM.querySelector', {
    nodeId: rootNodeId,
    selector: 'input[type="file"]',
  });
  const fileInputNodeId = qiRes?.result?.nodeId;
  console.log('file input nodeId:', fileInputNodeId);

  if (fileInputNodeId) {
    // 3. setFileInputFiles
    console.log('[3] DOM.setFileInputFiles...');
    const setRes = await sendCDP('DOM.setFileInputFiles', {
      files: [filePath],
      nodeId: fileInputNodeId,
    });
    console.log('setFile result:', JSON.stringify(setRes));

    // 检查
    await new Promise(r => setTimeout(r, 3000));
    const check = await evalJS(`document.querySelector('input[type="file"]').files?.length || 0`);
    console.log('files count:', check?.result?.result?.value);

    if ((check?.result?.result?.value || 0) > 0) {
      console.log('✅ 文件设置成功！等待编辑器...');
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const s = await evalJS(`(() => {
          const editor = document.querySelector('.public-DraftEditor-content,[contenteditable="true"],textarea,div[data-e2e="caption-input"]');
          const btns=[...document.querySelectorAll('button')];
          const postBtn=btns.find(b=>/post|发布/i.test(b.textContent));
          return JSON.stringify({hasEditor:!!editor,hasPostBtn:!!postBtn,postDisabled:postBtn?(postBtn.disabled||postBtn.getAttribute('aria-disabled')==='true'):true});
        })()`);
        const st = JSON.parse(s?.result?.result?.value || '{}');
        if (i % 5 === 0) console.log(`[${i+1}s] editor=${st.hasEditor} post=${st.hasPostBtn} disabled=${st.postDisabled}`);
        if (st.hasEditor && st.hasPostBtn && !st.postDisabled) {
          console.log('\n✅ 编辑器就绪！');
          await evalJS(`const e=document.querySelector('.public-DraftEditor-content,[contenteditable="true"],textarea');if(e)e.focus();`);
          await new Promise(r => setTimeout(r, 500));
          await sendCDP('Input.insertText', { text: 'Test upload 🎬 #test #fyp' });
          await new Promise(r => setTimeout(r, 1000));

          console.log('点击发布...');
          const click = await evalJS(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/post|发布/i.test(b.textContent));if(!b)return'no btn';b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));return b.textContent?.trim();})()`);
          console.log('点击:', click?.result?.result?.value);

          for (let j = 0; j < 30; j++) {
            await new Promise(r => setTimeout(r, 1000));
            const d = await evalJS(`(()=>{const t=document.body.innerText||'';const isDone=t.includes('Your video is being uploaded')||t.includes('Manage your posts')||t.includes('Upload another video')||t.includes('你的视频正在上传')||t.includes('管理你的作品');const l=document.querySelector('a[href*="/video/"]');return JSON.stringify({isDone,videoUrl:l?l.href:''});})()`);
            const r = JSON.parse(d?.result?.result?.value || '{}');
            if (r.isDone || r.videoUrl) { console.log('\n✅ 发布成功！', r); break; }
            if (j % 5 === 0) console.log(`等待发布... ${j+1}s`);
          }
          break;
        }
      }
    } else {
      console.log('❌ 文件未设置成功');
    }
  } else {
    console.log('❌ 未找到 file input');
  }

  ws.close();
  console.log('\nDone.');
})().catch(e => { console.error('Error:', e.message); });
