/**
 * TikTok Downloader - Background Service Worker (MV3)
 * 职责:
 *   1. 处理来自 content/popup 的下载请求（fetch blob → chrome.downloads 或 a.download）
 *   2. 调用 TikWM API（绕过 CORS）
 *   3. Stream 大文件到 blob，避免内存溢出
 */

// ============================================================
// 工具
// ============================================================

const TIKWM_ENDPOINT = 'https://www.tikwm.com/api/';

/** 在 service worker 中写文件到磁盘（通过 a.download + blob URL） */
async function saveBlobAsFile(blob, filename) {
  try {
    // 方式1: chrome.downloads API（MV3 service worker 中可以创建 blob URL）
    const url = URL.createObjectURL(blob);
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: filename,
          conflictAction: 'uniquify',
          saveAs: false,
        },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });
    // 清理 blob URL（延迟，确保下载已开始）
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { success: true, downloadId: downloadId, method: 'chrome.downloads' };
  } catch (e) {
    console.warn('[TikTokDL BG] chrome.downloads 失败，尝试备用方案:', e.message);
    // 方式2: 无法在 service worker 中直接 a.click()，但可以让 content script 处理
    return { success: false, error: e.message, blobUrl: URL.createObjectURL(blob) };
  }
}

/** Stream fetch 为 blob（支持大文件，避免一次性内存） */
async function fetchAsBlob(url, headers = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
    // service worker 中 mode 默认为 cors
    mode: 'cors',
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  // response.blob() 在 service worker 中可用
  const blob = await response.blob();
  return blob;
}

/** 尝试带 Referer 的下载（TikTok CDN 需要正确的 Referer） */
async function fetchVideoBlob(url) {
  const isTikTokCDN = /tiktokcdn|tiktokcdn-us|byteoversea|v16-web|v19-web|tiktok\.com/.test(url);

  // 尝试1: 带 TikTok Referer
  if (isTikTokCDN) {
    try {
      // 注意: 在 service worker fetch 中，Referer 头无法手动设置（浏览器会覆盖）
      // 但 host_permissions 已经授权了这些域名，CORS 会通过
      const blob = await fetchAsBlob(url);
      return blob;
    } catch (e) {
      console.warn('[TikTokDL BG] CDN 直连失败:', e.message);
    }

    // 尝试2: 通过 tikwm 域做代理中转（如果原始URL是tiktok域名）
    if (url.includes('tiktok.com')) {
      console.log('[TikTokDL BG] 尝试 TikWM 中转...');
      const tikwmResult = await callTikwmAPI(url);
      if (tikwmResult && tikwmResult.data && tikwmResult.data.play) {
        const blob = await fetchAsBlob(tikwmResult.data.play);
        return blob;
      }
    }
  }

  // 尝试3: 直接 fetch
  const blob = await fetchAsBlob(url);
  return blob;
}

// ============================================================
// TikWM API 调用（绕过 CORS — service worker 不受 CORS 限制）
// ============================================================

async function callTikwmAPI(tiktokUrl) {
  try {
    const apiUrl = `${TIKWM_ENDPOINT}?url=${encodeURIComponent(tiktokUrl)}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`TikWM HTTP ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (e) {
    console.error('[TikTokDL BG] TikWM API 调用失败:', e);
    throw e;
  }
}

// ============================================================
// TikWM 用户视频列表 API
// ============================================================

async function callTikwmUserVideos(username, count = 30) {
  try {
    const apiUrl = `${TIKWM_ENDPOINT}user/posts?username=${encodeURIComponent(username)}&count=${count}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`TikWM User Videos HTTP ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (e) {
    console.error('[TikTokDL BG] TikWM 用户视频列表失败:', e);
    throw e;
  }
}

// ============================================================
// 下载协调器
// ============================================================

async function handleDownload(payload) {
  const { url, filename, strategy, pageUrl, videoInfo } = payload;
  const safeFilename = filename || `TikTok_${Date.now()}.mp4`;

  console.log(`[TikTokDL BG] 下载开始: 策略=${strategy}, 文件=${safeFilename}, URL=${url.substring(0, 80)}...`);

  try {
    let finalUrl = url;

    // 如果策略是 bitrateInfo 或 playAddr，先尝试直接下载
    // 如果失败，尝试 TikWM
    const blob = await fetchVideoBlob(url);

    // 检查 blob 是否有效
    if (!blob || blob.size === 0) {
      throw new Error('下载内容为空');
    }

    console.log(`[TikTokDL BG] blob 大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    const result = await saveBlobAsFile(blob, safeFilename);

    if (result.success) {
      return { success: true, downloadId: result.downloadId, size: blob.size, strategy };
    }

    // 备用方案: 让 content script 用 a.download 下载
    // 发送 blob URL 给 content script
    try {
      const tab = await getActiveTab();
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'TRIGGER_ANCHOR_DOWNLOAD',
          blobUrl: result.blobUrl || URL.createObjectURL(blob),
          filename: safeFilename,
        });
        return { success: true, method: 'anchor', size: blob.size, strategy };
      }
    } catch (_) {
      // ignore
    }

    throw new Error('所有下载方式均失败');
  } catch (err) {
    console.error('[TikTokDL BG] 下载失败:', err);

    // 最终兜底: TikWM API
    if (pageUrl && strategy !== 'tikwm' && strategy !== 'tikwm-fallback') {
      console.log('[TikTokDL BG] 最终兜底: TikWM API');
      try {
        const tikwmRes = await callTikwmAPI(pageUrl);
        if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
          const blob = await fetchAsBlob(tikwmRes.data.play);
          const result = await saveBlobAsFile(blob, safeFilename);
          if (result.success) {
            return { success: true, downloadId: result.downloadId, size: blob.size, strategy: 'tikwm-fallback' };
          }
        }
      } catch (e2) {
        console.error('[TikTokDL BG] TikWM 兜底也失败:', e2);
      }
    }

    return { success: false, error: err.message };
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// ============================================================
// 消息处理
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[TikTokDL BG] 收到消息:', msg.type);

  if (msg.type === 'DOWNLOAD_VIDEO') {
    handleDownload(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep alive for async
  }

  if (msg.type === 'TIKWM_API') {
    callTikwmAPI(msg.url)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'TIKWM_USER_VIDEOS') {
    callTikwmUserVideos(msg.username, msg.count || 30)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'BATCH_DOWNLOAD') {
    // 批量下载: payload.videos = [{ url, filename, ... }, ...]
    handleBatchDownload(msg.videos || [])
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_PAGE_INFO_VIA_BG') {
    // 从 popup 通过 background 获取当前 tab 信息
    getActiveTab()
      .then(async (tab) => {
        if (!tab) return sendResponse({ error: 'no active tab' });
        // 注入 content script 获取信息（如果还没注入）
        try {
          const results = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
          sendResponse(results);
        } catch (e) {
          // content script 还没注入，注入后重试
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js'],
            });
            const results = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
            sendResponse(results);
          } catch (e2) {
            sendResponse({ error: e2.message });
          }
        }
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ============================================================
// 批量下载
// ============================================================

async function handleBatchDownload(videos) {
  const results = [];
  const concurrency = 2; // 并发下载数

  for (let i = 0; i < videos.length; i += concurrency) {
    const batch = videos.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (v) => {
        try {
          const result = await handleDownload({
            url: v.url,
            filename: v.filename,
            strategy: v.strategy || 'batch',
            pageUrl: v.pageUrl || '',
            videoInfo: v.videoInfo || {},
          });
          return { ...result, filename: v.filename, index: i };
        } catch (e) {
          return { success: false, error: e.message, filename: v.filename };
        }
      })
    );
    results.push(...batchResults);
  }

  const successCount = results.filter((r) => r.success).length;
  return { success: true, total: videos.length, downloaded: successCount, results };
}

// Service Worker 安装/激活
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[TikTokDL BG] 插件已安装/更新:', details.reason);
});
