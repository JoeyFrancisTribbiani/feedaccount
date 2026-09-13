/**
 * TikTok Downloader - Popup Script
 * 弹窗逻辑: 检测页面类型 → 展示视频信息/主页视频列表 → 触发下载
 */

(() => {
  'use strict';

  // ============================================================
  // DOM 引用
  // ============================================================
  const els = {
    pageStatus: document.getElementById('pageStatus'),
    videoSection: document.getElementById('videoSection'),
    profileSection: document.getElementById('profileSection'),
    otherSection: document.getElementById('otherSection'),
    videoCover: document.getElementById('videoCover'),
    videoDesc: document.getElementById('videoDesc'),
    videoAuthor: document.getElementById('videoAuthor'),
    videoDuration: document.getElementById('videoDuration'),
    strat1: document.getElementById('strat1'),
    strat2: document.getElementById('strat2'),
    strat3: document.getElementById('strat3'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllStrategies'),
    videoList: document.getElementById('videoList'),
    selectAll: document.getElementById('selectAll'),
    selectedCount: document.getElementById('selectedCount'),
    batchDownloadBtn: document.getElementById('batchDownloadBtn'),
    progressContainer: document.getElementById('progressContainer'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    progressLog: document.getElementById('progressLog'),
    autoRetry: document.getElementById('autoRetry'),
    highQuality: document.getElementById('highQuality'),
  };

  let currentVideoInfo = null;
  let currentVideoList = null;
  let selectedVideos = new Set();

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    try {
      const pageInfo = await getActiveTabInfo();
      if (!pageInfo || pageInfo.error) {
        showOther('无法获取页面信息');
        return;
      }
      console.log('[TikTokDL Popup] 页面信息:', pageInfo);

      if (pageInfo.pageType === 'video' && pageInfo.videoInfo) {
        currentVideoInfo = pageInfo.videoInfo;
        showVideoPage(pageInfo.videoInfo);
      } else if (pageInfo.pageType === 'profile') {
        showProfilePage(pageInfo);
      } else if (pageInfo.pageType === 'profile' || pageInfo.videoList) {
        if (pageInfo.videoList && pageInfo.videoList.length > 0) {
          showProfileVideoList(pageInfo.videoList);
        } else {
          showProfilePage(pageInfo);
        }
      } else {
        showOther();
      }
    } catch (e) {
      console.error('[TikTokDL Popup] 初始化失败:', e);
      showOther(e.message);
    }
  }

  async function getActiveTabInfo() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO_VIA_BG' }, (response) => {
        resolve(response);
      });
    });
  }

  // ============================================================
  // 消息发送
  // ============================================================

  function sendMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function sendToContent(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return reject(new Error('no active tab'));
        chrome.tabs.sendMessage(tabs[0].id, { type, ...payload }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  // ============================================================
  // 页面展示
  // ============================================================

  function showVideoPage(info) {
    els.pageStatus.textContent = '视频页面';
    els.pageStatus.className = 'status-badge video';
    els.videoSection.style.display = 'block';
    els.profileSection.style.display = 'none';
    els.otherSection.style.display = 'none';

    // 展示视频信息
    if (info.cover) {
      const coverUrl = info.cover.url_list?.[0] || info.cover;
      if (typeof coverUrl === 'string') els.videoCover.src = coverUrl;
    }
    els.videoDesc.textContent = info.desc || '(无描述)';
    els.videoAuthor.textContent = '@' + (info.author?.uniqueId || info.author?.nickname || 'unknown');
    if (info.duration) {
      els.videoDuration.textContent = formatDuration(info.duration);
    }

    // 检测三策略状态
    checkStrategies(info);
  }

  function showProfilePage(pageInfo) {
    els.pageStatus.textContent = '达人主页';
    els.pageStatus.className = 'status-badge profile';
    els.profileSection.style.display = 'block';
    els.videoSection.style.display = 'none';
    els.otherSection.style.display = 'none';

    // 从DOM提取的视频列表
    if (pageInfo.videoList && pageInfo.videoList.length > 0) {
      showProfileVideoList(pageInfo.videoList);
    } else {
      // 尝试通过TikWM API获取用户视频列表
      loadUserVideosViaTikwm(pageInfo);
    }
  }

  function showProfileVideoList(videoList) {
    currentVideoList = videoList;
    els.videoList.innerHTML = '';

    if (!videoList || videoList.length === 0) {
      els.videoList.innerHTML = '<div class="loading">未找到视频，请滚动页面加载更多后重新打开</div>';
      return;
    }

    videoList.forEach((video, idx) => {
      const item = createVideoListItem(video, idx);
      els.videoList.appendChild(item);
    });

    // 全选事件
    els.selectAll.onchange = (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('.video-item').forEach((item, idx) => {
        item.classList.toggle('selected', checked);
        const checkbox = item.querySelector('.video-item-checkbox');
        if (checkbox) checkbox.checked = checked;
      });
      selectedVideos.clear();
      if (checked) videoList.forEach((_, i) => selectedVideos.add(i));
      updateSelectedCount();
    };
  }

  function createVideoListItem(video, idx) {
    const item = document.createElement('div');
    item.className = 'video-item';
    item.dataset.index = idx;

    const coverUrl =
      video.cover?.url_list?.[0] ||
      video.cover?.UrlList?.[0] ||
      (typeof video.cover === 'string' ? video.cover : '');

    item.innerHTML = `
      <input type="checkbox" class="video-item-checkbox" />
      <img class="video-item-cover" src="${coverUrl}" alt="" onerror="this.style.opacity=0.3" />
      <div class="video-item-info">
        <div class="video-item-desc">${escapeHtml(video.desc || '(无描述)')}</div>
        <div class="video-item-meta">${formatDuration(video.duration || 0)} · ${formatDate(video.createTime)}</div>
      </div>
      <button class="video-item-download" title="单独下载">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
      </button>
    `;

    // 选择事件
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      const checkbox = item.querySelector('.video-item-checkbox');
      checkbox.checked = !checkbox.checked;
      toggleSelect(idx, checkbox.checked, item);
    });

    const checkbox = item.querySelector('.video-item-checkbox');
    checkbox.addEventListener('change', () => {
      toggleSelect(idx, checkbox.checked, item);
    });

    // 单独下载
    const dlBtn = item.querySelector('.video-item-download');
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSingleFromList(idx);
    });

    return item;
  }

  function toggleSelect(idx, selected, item) {
    if (selected) {
      selectedVideos.add(idx);
      item.classList.add('selected');
    } else {
      selectedVideos.delete(idx);
      item.classList.remove('selected');
    }
    updateSelectedCount();
  }

  function updateSelectedCount() {
    els.selectedCount.textContent = selectedVideos.size;
    els.batchDownloadBtn.disabled = selectedVideos.size === 0;
  }

  // ============================================================
  // 三策略检测
  // ============================================================

  async function checkStrategies(info) {
    // 策略1: bitrateInfo
    if (info.bestUrl) {
      els.strat1.textContent = '✓ 可用';
      els.strat1.className = 'strategy-status success';
    } else {
      els.strat1.textContent = '✗ 无';
      els.strat1.className = 'strategy-status fail';
    }

    // 策略3: playAddr
    if (info.playUrl) {
      els.strat3.textContent = '✓ 可用';
      els.strat3.className = 'strategy-status success';
    } else {
      els.strat3.textContent = '✗ 无';
      els.strat3.className = 'strategy-status fail';
    }

    // 策略2: TikWM (异步检测)
    els.strat2.textContent = '检测中...';
    els.strat2.className = 'strategy-status pending';
    try {
      const pageUrl = await getActiveTabUrl();
      if (pageUrl) {
        const tikwmRes = await sendMessage('TIKWM_API', { url: pageUrl });
        if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
          els.strat2.textContent = '✓ 可用';
          els.strat2.className = 'strategy-status success';
        } else {
          els.strat2.textContent = '✗ 无';
          els.strat2.className = 'strategy-status fail';
        }
      }
    } catch (_) {
      els.strat2.textContent = '✗ 失败';
      els.strat2.className = 'strategy-status fail';
    }
  }

  async function getActiveTabUrl() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0]?.url || '');
      });
    });
  }

  // ============================================================
  // 下载触发
  // ============================================================

  els.downloadBtn.addEventListener('click', async () => {
    if (!currentVideoInfo) return;
    els.downloadBtn.disabled = true;
    els.downloadBtn.innerHTML = '<span>获取URL中...</span>';

    try {
      const pageUrl = await getActiveTabUrl();
      // 优先策略1
      let bestUrl = currentVideoInfo.bestUrl;
      let strategy = 'bitrateInfo';

      // 策略2: 如果策略1不可用，尝试TikWM
      if (!bestUrl && els.autoRetry.checked) {
        const tikwmRes = await sendMessage('TIKWM_API', { url: pageUrl });
        if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
          bestUrl = tikwmRes.data.play;
          strategy = 'tikwm';
        }
      }

      // 策略3: 兜底
      if (!bestUrl) {
        bestUrl = currentVideoInfo.playUrl;
        strategy = 'playAddr';
      }

      if (!bestUrl) {
        throw new Error('三策略均无法获取URL');
      }

      // 发送到 background 下载
      await sendMessage('DOWNLOAD_VIDEO', {
        url: bestUrl,
        filename: buildFilename(currentVideoInfo),
        strategy: strategy,
        pageUrl: pageUrl,
        videoInfo: {
          videoId: currentVideoInfo.videoId,
          desc: currentVideoInfo.desc,
          author: currentVideoInfo.author?.uniqueId || currentVideoInfo.author?.nickname,
        },
      });

      els.downloadBtn.innerHTML = '<span>✓ 下载已开始</span>';
    } catch (e) {
      els.downloadBtn.innerHTML = `<span>✗ ${e.message}</span>`;
    } finally {
      setTimeout(() => {
        els.downloadBtn.disabled = false;
        els.downloadBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          下载无水印高清
        `;
      }, 3000);
    }
  });

  els.downloadAllBtn.addEventListener('click', () => {
    // 三策略全部获取（主要用于测试/对比）
    checkStrategies(currentVideoInfo);
  });

  // ============================================================
  // 批量下载
  // ============================================================

  els.batchDownloadBtn.addEventListener('click', async () => {
    if (selectedVideos.size === 0 || !currentVideoList) return;

    const pageUrl = await getActiveTabUrl();
    const videos = [];

    for (const idx of selectedVideos) {
      const v = currentVideoList[idx];
      let url = v.bestUrl || v.playUrl;
      let strategy = v.bestUrl ? 'bitrateInfo' : 'playAddr';

      videos.push({
        url: url,
        filename: buildFilename(v),
        strategy: strategy,
        pageUrl: pageUrl,
        videoInfo: {
          videoId: v.videoId,
          desc: v.desc,
          author: v.author?.uniqueId || v.author?.nickname,
        },
      });
    }

    showProgress(videos.length);
    updateProgress(0);

    try {
      // 逐个下载，更新进度
      for (let i = 0; i < videos.length; i++) {
        updateProgress(i);
        logProgress(`下载 ${i + 1}/${videos.length}: ${videos[i].filename}`);
        await sendMessage('DOWNLOAD_VIDEO', videos[i]);
        // 间隔避免频率限制
        await sleep(500);
      }
      updateProgress(videos.length);
      logProgress('✓ 全部完成');
    } catch (e) {
      logProgress(`✗ ${e.message}`);
    }
  });

  async function downloadSingleFromList(idx) {
    if (!currentVideoList || !currentVideoList[idx]) return;
    const v = currentVideoList[idx];
    const pageUrl = await getActiveTabUrl();
    let url = v.bestUrl || v.playUrl;
    let strategy = v.bestUrl ? 'bitrateInfo' : 'playAddr';

    if (!url) {
      // 尝试 TikWM
      try {
        const tikwmRes = await sendMessage('TIKWM_API', { url: v.pageUrl || pageUrl });
        if (tikwmRes && tikwmRes.data && tikwmRes.data.play) {
          url = tikwmRes.data.play;
          strategy = 'tikwm';
        }
      } catch (_) {
        // ignore
      }
    }

    if (!url) {
      alert('无法获取此视频的下载URL');
      return;
    }

    await sendMessage('DOWNLOAD_VIDEO', {
      url: url,
      filename: buildFilename(v),
      strategy: strategy,
      pageUrl: pageUrl,
      videoInfo: {
        videoId: v.videoId,
        desc: v.desc,
        author: v.author?.uniqueId || v.author?.nickname,
      },
    });
  }

  // ============================================================
  // TikWM 加载用户视频
  // ============================================================

  async function loadUserVideosViaTikwm(pageInfo) {
    els.videoList.innerHTML = '<div class="loading">通过 TikWM 加载视频列表...</div>';

    try {
      // 从 URL 提取用户名
      const pageUrl = await getActiveTabUrl();
      const match = pageUrl.match(/\/@([^/?]+)/);
      const username = match ? match[1] : '';

      if (!username) {
        els.videoList.innerHTML = '<div class="loading">无法识别用户名</div>';
        return;
      }

      const res = await sendMessage('TIKWM_USER_VIDEOS', { username, count: 30 });
      if (res && res.data && res.data.videos) {
        const list = res.data.videos.map((v) => ({
          videoId: v.video_id || v.id || '',
          desc: v.title || v.desc || '',
          author: { uniqueId: username, nickname: username },
          video: v,
          bestUrl: null, // TikWM 列表中不含 bitrateInfo
          playUrl: v.play || null,
          duration: v.duration || 0,
          createTime: v.create_time || 0,
          cover: v.cover || v.origin_cover,
          pageUrl: pageUrl + '/video/' + (v.video_id || v.id || ''),
        }));
        showProfileVideoList(list);
      } else {
        els.videoList.innerHTML = '<div class="loading">未找到视频（可能需要滚动页面加载）</div>';
      }
    } catch (e) {
      els.videoList.innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
    }
  }

  // ============================================================
  // 进度条
  // ============================================================

  function showProgress(total) {
    els.progressContainer.style.display = 'block';
    els.progressText.textContent = `0 / ${total}`;
    els.progressFill.style.width = '0%';
    els.progressLog.innerHTML = '';
  }

  function updateProgress(current) {
    const total = selectedVideos.size || 1;
    const pct = Math.round((current / total) * 100);
    els.progressFill.style.width = pct + '%';
    els.progressText.textContent = `${current} / ${total}`;
  }

  function logProgress(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    els.progressLog.appendChild(line);
    els.progressLog.scrollTop = els.progressLog.scrollHeight;
  }

  // ============================================================
  // 工具
  // ============================================================

  function showOther(msg) {
    els.pageStatus.textContent = msg || '非TikTok页面';
    els.pageStatus.className = 'status-badge other';
    els.otherSection.style.display = 'block';
    els.videoSection.style.display = 'none';
    els.profileSection.style.display = 'none';
  }

  function buildFilename(info) {
    const author = info.author?.uniqueId || info.author?.nickname || info.author?.id || 'tiktok';
    const videoId = info.videoId || info.id || Date.now();
    return `TikTok_${author}_${videoId}.mp4`;
  }

  function formatDuration(seconds) {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp * 1000);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ============================================================
  // 启动
  // ============================================================

  init();
})();
