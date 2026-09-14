// 直接用 page-level WebSocket 操作 TikTok 上传页面
const pageWsUrl = 'ws://127.0.0.1:7539/devtools/page/5475FFD96208FA6814E9E56316FEB9FF';
const filePath = 'D:/Download/mmexport1789272791126.mp4';

(async () => {
  console.log('=== TikTok 发布测试 (page-level CDP) ===');
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
      const handler = (e) => {
        const d = JSON.parse(e.data);
        if (d.id === id) { ws.removeEventListener('message', handler); resolve(d); }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
    });
  }
  const evalJS = (expr) => sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });

  // 1. 检查页面状态
  console.log('\n[1] 检查页面状态...');
  const statusRes = await evalJS(`(() => {
    return JSON.stringify({
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasFileInput: !!document.querySelector('input[type="file"]'),
      inputCount: document.querySelectorAll('input').length,
      bodyText: document.body?.innerText?.substring(0, 300),
    });
  })()`);
  const status = JSON.parse(statusRes?.result?.result?.value || '{}');
  console.log('URL:', status.url);
  console.log('Title:', status.title);
  console.log('Has file input:', status.hasFileInput);
  console.log('Input count:', status.inputCount);
  console.log('Body text:', status.bodyText?.substring(0, 200));

  if (!status.hasFileInput) {
    console.log('\n⚠️ 没有 file input，等待页面加载...');
    // 等5秒再检查
    await new Promise(r => setTimeout(r, 5000));
    
    const status2Res = await evalJS(`(() => {
      return JSON.stringify({
        url: window.location.href,
        hasFileInput: !!document.querySelector('input[type="file"]'),
        bodyText: document.body?.innerText?.substring(0, 500),
        allInputs: [...document.querySelectorAll('input')].map(i => ({ type: i.type, accept: i.accept, name: i.name })),
      });
    })()`);
    const status2 = JSON.parse(status2Res?.result?.result?.value || '{}');
    console.log('重检 URL:', status2.url);
    console.log('Has file input:', status2.hasFileInput);
    console.log('All inputs:', JSON.stringify(status2.allInputs));
    console.log('Body text:', status2.bodyText);
    
    if (!status2.hasFileInput) {
      console.log('\n仍然没有 file input，尝试导航到上传页...');
      await sendCDP('Page.navigate', { url: 'https://www.tiktok.com/tiktokstudio/upload' });
      await new Promise(r => setTimeout(r, 8000));
      
      const status3Res = await evalJS(`(() => {
        return JSON.stringify({
          url: window.location.href,
          hasFileInput: !!document.querySelector('input[type="file"]'),
          bodyText: document.body?.innerText?.substring(0, 300),
        });
      })()`);
      const status3 = JSON.parse(status3Res?.result?.result?.value || '{}');
      console.log('导航后 URL:', status3.url);
      console.log('Has file input:', status3.hasFileInput);
      console.log('Body text:', status3.bodyText);
    }
  }

  // 2. 如果有 file input，上传文件
  const finalCheck = await evalJS(`!!document.querySelector('input[type="file"]')`);
  const hasInput = finalCheck?.result?.result?.value;
  
  if (hasInput) {
    console.log('\n[2] 找到 file input，上传文件...');
    
    // 启用 DOM
    await sendCDP('DOM.enable', {});
    await sendCDP('Page.enable', {});
    
    // 获取 document
    const doc = await sendCDP('DOM.getDocument', { depth: -1 });
    
    // 找 file input
    const fileInput = await sendCDP('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]'
    });
    
    console.log('File input nodeId:', fileInput?.nodeId);
    
    // 设置文件
    console.log('设置文件:', filePath);
    await sendCDP('DOM.setFileInputFiles', {
      files: [filePath],
      nodeId: fileInput.nodeId
    });
    
    console.log('文件已设置，等待上传...');
    
    // 等待编辑器就绪
    for (let i = 0; i < 40; i++) {
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
      console.log(`[${i+1}] editor=${s.hasEditor} postBtn=${s.hasPostBtn} disabled=${s.postDisabled}`);
      if (s.hasEditor && s.hasPostBtn && !s.postDisabled) {
        console.log('\n编辑器就绪！');
        
        // 填写标题
        console.log('填写标题...');
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
        
        // 点击发布
        console.log('点击发布...');
        const clickRes = await evalJS(`(() => {
          const btns = [...document.querySelectorAll('button')];
          const postBtn = btns.find(b => /post|发布/i.test(b.textContent));
          if (!postBtn) return false;
          postBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          postBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          postBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return postBtn.textContent?.trim();
        })()`);
        console.log('点击结果:', clickRes?.result?.result?.value);
        
        // 等待发布成功
        for (let i = 0; i < 30; i++) {
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
          if (i % 5 === 0) console.log(`等待发布... ${i+1}s`);
        }
        break;
      }
    }
  } else {
    console.log('\n❌ 无法找到 file input 元素');
  }
  
  ws.close();
  console.log('\nDone.');
})().catch(e => { console.error('Error:', e.message); });
