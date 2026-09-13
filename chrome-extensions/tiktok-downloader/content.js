/**
 * TikTok Downloader - Content Script
 * 注入下载按钮 + 从页面 __UNIVERSAL_DATA_FOR_REHYDRATION__ 提取视频元数据
 * 三策略：bitrateInfo最高码率 → TikWM API → playAddr兜底
 */

(() => {
  'use strict';

  // ============================================================
  // 工具函数
  // ============================================================

  /** 从页面提取 __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON */
  function getUniversalData() {
    try {
      // 方式1: 查找 script#SIGI_STATE 或 __UNIVERSAL_DATA_FOR_REHYDRATION__
      const scriptEl =
        document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
        document.querySelector('script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]');
      if (scriptEl && scriptEl.textContent) {
        return JSON.parse(scriptEl.textContent);
      }
      // 方式2: 遍历所有 script 标签查找
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        if (s.textContent.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
          const text = s.textContent.trim();
          if (text.startsWith('{')) {
            return JSON.parse(text);
          }
        }
      }
      // 方式3: 查找带 universa 或 sigi 的 script
      const allScripts = document.querySelectorAll('script');
      for (const s of allScripts) {
        const id = (s.id || '').toLowerCase();
        if (
          id.includes('universal') ||
          id.includes('rehydration') ||
          id.includes('sigi_state') ||
          id.includes('__sigi_state')
        ) {
          try {
            return JSON.parse(s.textContent);
          } catch (_) {
            // continue
          }
        }
      }
    } catch (e) {
      console.error('[TikTokDL] 解析 UNIVERSAL_DATA 失败:', e);
    }
    return null;
  }

  /** 从 SIGI_STATE（旧版TikTok）提取数据 */
  function getSigiState() {
    try {
      if (window.SIGI_STATE) return window.SIGI_STATE;
      const el = document.getElementById('SIGI_STATE');
      if (el && el.textContent) return JSON.parse(el.textContent);
    } catch (_) {
      // ignore
    }
    return null;
  }

  /** 获取 __DEFAULT_SCOPE__ 下的数据 */
  function getDefaultScope() {
    const data = getUniversalData();
    if (data && data.__DEFAULT_SCOPE__) return data.__DEFAULT_SCOPE__;
    // 有些页面直接就是 scope 对象
    if (data && (data['webapp.video-detail'] || data['webapp.user-detail'])) return data;
    return null;
  }

  /** 从 video 对象中提取最高码率无水印 URL（策略1: bitrateInfo） */
  function extractBestBitrateURL(videoObj) {
    if (!videoObj) return null;
    try {
      const bitrateInfo =
        videoObj.bitrateInfo ||
        videoObj.BitrateInfo ||
        videoObj.bitrateInfos ||
        videoObj.playAddr?.BitrateList;
      if (Array.isArray(bitrateInfo) && bitrateInfo.length > 0) {
        // 按 Bitrate 降序排列
        const sorted = [...bitrateInfo].sort((a, b) => {
          const brA = a.Bitrate || a.bitrate || a.QualityType || 0;
          const brB = b.Bitrate || b.bitrate || b.QualityType || 0;
          return brB - brA;
        });
        const best = sorted[0];
        // PlayAddr.UrlList 或 PlayAddr
        const playAddr = best.PlayAddr || best.playAddr || best.play_addr;
        if (playAddr) {
          const urlList = playAddr.UrlList || playAddr.url_list || [];
          if (urlList.length > 0) return urlList[0];
          if (typeof playAddr === 'string') return playAddr;
        }
      }
    } catch (e) {
      console.error('[TikTokDL] 提取 bitrateInfo 失败:', e);
    }
    return null;
  }

  /** 从 video 对象中提取 playAddr（策略3: 兜底） */
  function extractPlayAddr(videoObj) {
    if (!videoObj) return null;
    try {
      const pa = videoObj.playAddr || videoObj.PlayAddr || videoObj.play_addr;
      if (pa) {
        if (typeof pa === 'string') return pa;
        const urlList = pa.UrlList || pa.url_list || [];
        if (urlList.length > 0) return urlList[0];
      }
    } catch (_) {
      // ignore
    }
    return null;
  }

  /** 从当前页面提取单个视频的完整信息 */
  function extractVideoInfo() {
    const scope = getDefaultScope();
    if (!scope) return null;

    // 路径1: __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
    const videoDetail = scope['webapp.video-detail'];
    if (videoDetail) {
      const itemInfo = videoDetail.itemInfo;
      if (itemInfo) {
        const itemStruct = itemInfo.itemStruct;
        if (itemStruct) {
          const video = itemStruct.video || {};
          return {
            videoId: itemStruct.id || itemStruct.video?.id || '',
            desc: itemStruct.desc || '',
            author: {
              id: itemStruct.author?.id || '',
              nickname: itemStruct.author?.nickname || itemStruct.author?.uniqueId || '',
              uniqueId: itemStruct.author?.uniqueId || '',
            },
            video: video,
            bestUrl: extractBestBitrateURL(video),
            playUrl: extractPlayAddr(video),
            duration: video.duration || 0,
            createTime: itemStruct.createTime || 0,
            cover: video.cover || video.originCover || video.dynamicCover,
          };
        }
      }
    }

    // 路径2: SIGI_STATE（旧版）
    const sigi = getSigiState();
    if (sigi) {
      // SIGI_STATE有不同的路径
      const itemId = sigi.ItemModule?.[Object.keys(sigi.ItemModule || {})[0]];
      if (itemId) {
        const video = itemId.video || {};
        return {
          videoId: itemId.id || '',
          desc: itemId.desc || '',
          author: {
            id: itemId.author || '',
            nickname: itemId.author || '',
            uniqueId: itemId.author || '',
          },
          video: video,
          bestUrl: extractBestBitrateURL(video),
          playUrl: extractPlayAddr(video),
          duration: video.duration || 0,
          createTime: itemId.createTime || 0,
          cover: video.cover || video.originCover,
        };
      }
    }

    return null;
  }

  /** 从达人主页提取视频列表 */
  function extractUserVideoList() {
    const scope = getDefaultScope();
    if (!scope) return null;

    // webapp.user-detail 中的视频列表
    const userDetail = scope['webapp.user-detail'];
    if (userDetail) {
      // 新版: userDetail.userInfo 或 userDetail.itemList
      const itemList =
        userDetail.itemList ||
        userDetail.items ||
        userDetail.userInfo?.itemList ||
        [];
      if (Array.isArray(itemList) && itemList.length > 0) {
        return itemList.map((item) => {
          const video = item.video || {};
          return {
            videoId: item.id || item.video?.id || '',
            desc: item.desc || '',
            author: {
              id: item.author?.id || '',
              nickname: item.author?.nickname || item.author?.uniqueId || '',
              uniqueId: item.author?.uniqueId || '',
            },
            video: video,
            bestUrl: extractBestBitrateURL(video),
            playUrl: extractPlayAddr(video),
            duration: video.duration || 0,
            createTime: item.createTime || 0,
            cover: video.cover || video.originCover || video.dynamicCover,
            pageUrl: window.location.origin + '/@' + (item.author?.uniqueId || '') + '/video/' + (item.id || ''),
          };
        });
      }
    }

    // SIGI_STATE 旧版主页
    const sigi = getSigiState();
    if (sigi && sigi.ItemModule) {
      return Object.values(sigi.ItemModule).map((item) => {
        const video = item.video || {};
        return {
          videoId: item.id || '',
          desc: item.desc || '',
          author: { id: item.author || '', nickname: item.author || '', uniqueId: item.author || '' },
          video: video,
          bestUrl: extractBestBitrateURL(video),
          playUrl: extractPlayAddr(video),
          duration: video.duration || 0,
          createTime: item.createTime || 0,
        };
      });
    }

    return null;
  }

  /** 判断当前页面类型 */
  function getPageType() {
    const url = window.location.href;
    // 视频页面: /@username/video/xxx
    if (/\/@[^/]+\/video\/\d+/.test(url)) return 'video';
    // 达人主页: /@username（不带 /video）
    if (/\/@[^/]+$/.test(url) || /\/@[^/]+\?(?!.*video)/.test(url)) return 'profile';
    return 'other';
  }

  /** 发送下载请求到 background */
  function sendDownloadRequest(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO', ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  /** 发送 TikWM API 请求到 background（绕过CORS） */
  function sendTikwmRequest(tiktokUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'TIKWM_API', url: tiktokUrl }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ============================================================
  // 三策略下载逻辑
  // ============================================================

  /**
   * 获取最佳下载URL，按三策略尝试
   * 返回 { url, strategy, info }
   */
  async function resolveBestURL(videoInfo) {
    const pageUrl = videoInfo.pageUrl || window.location.href;

    // 策略1: 页面 bitrateInfo 最高码率
    if (videoInfo.bestUrl) {
      console.log('[TikTokDL] 策略1(最优): bitrateInfo 最高码率URL');
      return { url: videoInfo.bestUrl, strategy: 'bitrateInfo', info: videoInfo };
    }

    // 策略2: TikWM API
    try {
      console.log('[TikTokDL] 策略2(次优): TikWM API');
      const tikwmRes = await sendTikwmRequest(pageUrl);
      if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
        return { url: tikwmRes.data.play, strategy: 'tikwm', info: tikwmRes.data };
      }
    } catch (e) {
      console.warn('[TikTokDL] TikWM API 失败:', e.message);
    }

    // 策略3: playAddr 兜底
    if (videoInfo.playUrl) {
      console.log('[TikTokDL] 策略3(兜底): playAddr');
      return { url: videoInfo.playUrl, strategy: 'playAddr', info: videoInfo };
    }

    // 全部失败，再尝试 TikWM（即使策略1有URL，可能也需要）
    try {
      const tikwmRes = await sendTikwmRequest(pageUrl);
      if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
        return { url: tikwmRes.data.play, strategy: 'tikwm-fallback', info: tikwmRes.data };
      }
    } catch (_) {
      // ignore
    }

    return null;
  }

  // ============================================================
  // UI: 注入下载按钮
  // ============================================================

  let downloadBtn = null;
  let isDownloading = false;

  function createDownloadButton() {
    if (downloadBtn && document.body.contains(downloadBtn)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'tt-dl-wrapper';

    const btn = document.createElement('button');
    btn.className = 'tt-dl-btn';
    btn.innerHTML = `
      <svg class="tt-dl-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      <span class="tt-dl-label">下载无水印</span>
    `;
    btn.addEventListener('click', handleDownloadClick);

    wrapper.appendChild(btn);
    downloadBtn = btn;

    // 找到合适的注入位置
    const mountPoint = findMountPoint();
    if (mountPoint) {
      mountPoint.parentElement.insertBefore(wrapper, mountPoint);
    } else {
      document.body.appendChild(wrapper);
    }
  }

  function findMountPoint() {
    // TikTok 页面右侧操作栏（点赞/评论/收藏 旁边）
    const selectors = [
      'div[data-e2e="video-player"]',
      'div[data-e2e="like-icon"]',
      'div[class*="DivActionItemContainer"]',
      'div[class*="x6s0dn4"]',
      'div[class*="action-bar"]',
      'div[class*="ActionButtons"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        // 找它的父容器
        return el.closest('div[class*="DivActionItemContainer"]') || el.parentElement || el;
      }
    }
    return null;
  }

  async function handleDownloadClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (isDownloading) return;
    isDownloading = true;
    updateBtnStatus('loading', '获取高清URL...');

    try {
      const videoInfo = extractVideoInfo();
      if (!videoInfo || !videoInfo.video) {
        // 无法从DOM提取，直接尝试 TikWM
        updateBtnStatus('loading', '调用 TikWM API...');
        const pageUrl = window.location.href;
        const result = await sendTikwmRequest(pageUrl);
        if (result && result.data && result.data.play) {
          await triggerDownload(result.data.play, result.data, 'tikwm-direct');
          updateBtnStatus('success', '下载已开始!');
          return;
        }
        throw new Error('无法提取视频信息，请刷新页面重试');
      }

      updateBtnStatus('loading', '三策略获取最佳URL...');
      const resolved = await resolveBestURL(videoInfo);
      if (!resolved) {
        throw new Error('三策略均无法获取下载URL');
      }

      updateBtnStatus('loading', `策略[${resolved.strategy}] 下载中...`);
      await triggerDownload(resolved.url, videoInfo, resolved.strategy);
      updateBtnStatus('success', `下载已开始 (${resolved.strategy})`);
    } catch (err) {
      console.error('[TikTokDL] 下载失败:', err);
      updateBtnStatus('error', `失败: ${err.message}`);
    } finally {
      isDownloading = false;
      setTimeout(() => updateBtnStatus('idle', '下载无水印'), 3000);
    }
  }

  async function triggerDownload(url, info, strategy) {
    // 发送到 background 下载
    await sendDownloadRequest({
      url: url,
      filename: buildFilename(info),
      strategy: strategy,
      pageUrl: window.location.href,
      videoInfo: {
        videoId: info.videoId || info.id || '',
        desc: info.desc || info.title || '',
        author: info.author?.uniqueId || info.author?.nickname || info.author?.id || 'tiktok',
      },
    });
  }

  function buildFilename(info) {
    const author = info.author?.uniqueId || info.author?.nickname || info.author?.id || 'tiktok';
    const videoId = info.videoId || info.id || Date.now();
    return `TikTok_${author}_${videoId}.mp4`;
  }

  function updateBtnStatus(status, label) {
    if (!downloadBtn) return;
    downloadBtn.className = 'tt-dl-btn tt-dl-' + status;
    const labelEl = downloadBtn.querySelector('.tt-dl-label');
    if (labelEl) labelEl.textContent = label;
  }

  // ============================================================
  // 消息监听: popup -> content
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_INFO') {
      const pageType = getPageType();
      const videoInfo = pageType === 'video' ? extractVideoInfo() : null;
      const videoList = pageType === 'profile' ? extractUserVideoList() : null;
      sendResponse({
        pageType: pageType,
        url: window.location.href,
        videoInfo: videoInfo,
        videoList: videoList,
      });
      return true;
    }

    if (msg.type === 'DOWNLOAD_FROM_POPUP') {
      // 弹窗触发的批量/单个下载
      handlePopupDownload(msg.payload)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // keep alive for async
    }

    if (msg.type === 'EXTRACT_PROFILE_VIDEOS') {
      const list = extractUserVideoList();
      sendResponse({ videoList: list });
      return true;
    }
  });

  async function handlePopupDownload(payload) {
    // 从 popup 发来的下载请求
    const { url, pageUrl, filename, strategy } = payload;
    const result = await sendDownloadRequest({
      url: url,
      filename: filename,
      strategy: strategy,
      pageUrl: pageUrl,
      videoInfo: payload.videoInfo || {},
    });
    return result;
  }

  // ============================================================
  // 初始化
  // ============================================================

  function init() {
    const pageType = getPageType();
    console.log(`[TikTokDL] 页面类型: ${pageType}, URL: ${window.location.href}`);

    if (pageType === 'video' || pageType === 'profile') {
      // 等待页面加载完成再注入按钮
      setTimeout(() => {
        createDownloadButton();
        // 持续检查（TikTok 是 SPA，按钮可能被重渲染）
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.tt-dl-btn')) {
            createDownloadButton();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }, 2000);
    }
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
