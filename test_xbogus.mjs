/**
 * test_xbogus.mjs — TikTok 高清视频下载器
 *
 * 功能：输入 TikTok 视频 URL → 输出可用的最高画质 MP4 文件路径
 *
 * 研究结论：
 * ============
 * 1. X-Bogus 是 TikTok Web API 的签名参数，npm 包 `xbogus` 可在 Node.js 中生成
 *    但 Web API 现在同时需要 X-Bogus 和 X-Gnarly 两个签名，仅 X-Bogus 不够
 * 2. TikTok Web API 最高只返回 2.5Mbps h265 1080p60 版本（约2.7MB）
 *    这比 yt-dlp 默认的 h264 720p30（约2.5MB）质量更好（HEVC + 更高分辨率 + 60fps）
 * 3. 14Mbps 原始上传文件不通过任何公开 API 暴露
 *    TikSave.io 的 14Mbps HD 版本是通过 FFmpeg 服务端转码生成的（非原始流）
 *    其 encoder 标签为 Lavf57.71.100，te_is_reencode=1
 * 4. App API（/aweme/v1/feed/）需要 X-Argus/X-Gorgon/X-Ladon 签名（原生库加密），
 *    且同样只返回转码后的 rendition（不比 Web API 更高）
 *
 * 本脚本的策略（按优先级）：
 * A. CDP 页面上下文获取（推荐）：连接 Chrome 调试端口，在已打开的 TikTok 页面上下文中
 *    读取 __UNIVERSAL_DATA_FOR_REHYDRATION__ 获取最高码率版本 URL，直接下载
 * B. tikwm API（备选）：调用 tikwm.com/api/ 获取 hdplay URL（同样 2.5Mbps h265 1080p60）
 * C. yt-dlp（兜底）：如果以上都失败
 *
 * 用法：node test_xbogus.mjs "https://www.tiktok.com/@user/video/123456"
 */

import { writeFileSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';

// ============ 配置 ============
const CDP_BASE = 'http://localhost:9222';
const PROXY = 'http://127.0.0.1:7890';
const OUTPUT_DIR = 'D:/Download';
const TIKWM_API = 'https://www.tikwm.com/api/';

// ============ 工具函数 ============

/** 从 TikTok URL 提取 video_id */
function extractVideoId(url) {
  const m = url.match(/\/video\/(\d+)/) || url.match(/\/v\/(\d+)/) || url.match(/(\d{15,})/);
  if (!m) throw new Error(`无法从 URL 提取 video_id: ${url}`);
  return m[1];
}

/** 提取用户名 */
function extractUsername(url) {
  const m = url.match(/@([\w.]+)/);
  return m ? m[1] : 'unknown';
}

/**
 * 方案 A：通过 CDP 获取 TikTok 页面的最高码率视频
 * 连接 Chrome 调试端口，导航到视频页面，从 __UNIVERSAL_DATA_FOR_REHYDRATION__ 提取 bitrateInfo
 * SDK 在页面上下文中已加载，fetch 会自动签名
 */
async function downloadViaCDP(videoUrl, videoId) {
  console.log('[方案A] 通过 CDP 获取最高码率版本...');

  // 获取 CDP 标签页
  const resp = await fetch(`${CDP_BASE}/json`);
  const tabs = await resp.json();
  let page = tabs.find(t => t.type === 'page' && t.url.includes('tiktok'));

  if (!page) {
    console.log('  未找到 TikTok 页面，尝试打开新标签...');
    // 通过 PUT 创建新标签
    const tabResp = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent('https://www.tiktok.com/')}`, { method: 'PUT' });
    page = await tabResp.json();
    await sleep(8000);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    setTimeout(() => rej(new Error('CDP 连接超时')), 10000);
  });

  let msgId = 0;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    const handler = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { ws.removeEventListener('message', handler); res(d); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`${method} 超时`)), 120000);
  });

  try {
    await send('Page.enable');
    console.log(`  导航到: ${videoUrl}`);
    await send('Page.navigate', { url: videoUrl });
    await sleep(6000);

    // 从页面提取最高码率视频信息
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          if (!el) return JSON.stringify({error: '未找到 __UNIVERSAL_DATA_FOR_REHYDRATION__ 元素'});
          const data = JSON.parse(el.textContent);
          const scope = data['__DEFAULT_SCOPE__'] || {};
          const detail = scope['webapp.video-detail'] || {};
          const item = detail.itemInfo?.itemStruct;
          if (!item) return JSON.stringify({error: '未找到 itemStruct', scopeKeys: Object.keys(scope)});
          const v = item.video || {};
          const bi = v.bitrateInfo || [];
          if (bi.length === 0) return JSON.stringify({error: '无 bitrateInfo', videoKeys: Object.keys(v)});
          // 找最高码率
          const best = bi.reduce((a, b) => (b.Bitrate > a.Bitrate ? b : a));
          return JSON.stringify({
            gear: best.GearName,
            bitrate: best.Bitrate,
            codec: best.CodecType,
            width: best.PlayAddr.Width,
            height: best.PlayAddr.Height,
            dataSize: best.PlayAddr.DataSize,
            url: best.PlayAddr.UrlList[0],
            allGears: bi.map(b => ({gear: b.GearName, bitrate: b.Bitrate, codec: b.CodecType, w: b.PlayAddr.Width, h: b.PlayAddr.Height, size: b.PlayAddr.DataSize}))
          });
        } catch(e) { return JSON.stringify({error: e.message}); }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    const val = JSON.parse(r?.result?.result?.value);
    if (val.error) throw new Error(`CDP 提取失败: ${val.error}`);

    console.log(`  最高版本: ${val.gear} | ${val.codec} | ${val.width}x${val.height} | ${(val.bitrate/1000000).toFixed(2)}Mbps | ${(val.dataSize/1048576).toFixed(2)}MB`);
    console.log(`  所有版本:`);
    for (const g of val.allGears) {
      console.log(`    ${g.gear}: ${g.codec} ${g.w}x${g.h} ${(g.bitrate/1000000).toFixed(2)}Mbps ${(g.size/1048576).toFixed(2)}MB`);
    }

    // 在页面上下文中下载视频（fetch 自动携带 cookie 和签名）
    console.log(`  下载中...`);
    const dlResult = await send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const resp = await fetch(${JSON.stringify(val.url)}, { credentials: 'include' });
          if (!resp.ok) return JSON.stringify({error: 'HTTP ' + resp.status});
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 16384;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return JSON.stringify({ size: bytes.length, base64: btoa(binary) });
        } catch(e) { return JSON.stringify({error: e.message}); }
      })()`,
      returnByValue: true,
      awaitPromise: true,
      timeout: 120000,
    });

    const dl = JSON.parse(dlResult?.result?.result?.value);
    if (dl.error) throw new Error(`下载失败: ${dl.error}`);

    const outputPath = `${OUTPUT_DIR}/tiktok_${videoId}_h265_1080p60.mp4`;
    const buf = Buffer.from(dl.base64, 'base64');
    writeFileSync(outputPath, buf);
    console.log(`  ✓ 已保存: ${outputPath} (${(dl.size/1048576).toFixed(2)}MB)`);

    return { path: outputPath, size: dl.size, codec: val.codec, bitrate: val.bitrate, resolution: `${val.width}x${val.height}` };
  } finally {
    ws.close();
  }
}

/**
 * 方案 B：通过 tikwm API 获取视频
 * tikwm.com/api/ 返回 play（无水印）和 hdplay（h265 1080p60）URL
 * 注意：tikwm 的 hdplay 和 Web API 最高版本是同一个文件（2.5Mbps h265）
 */
async function downloadViaTikwm(videoUrl, videoId) {
  console.log('[方案B] 通过 tikwm API 获取...');

  const apiUrl = `${TIKWM_API}?url=${encodeURIComponent(videoUrl)}&hd=1`;
  const resp = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const data = await resp.json();

  if (data.code !== 0) throw new Error(`tikwm API 错误: ${data.msg}`);
  const v = data.data;

  // 优先使用 hdplay（h265 1080p60），其次 play
  const downloadUrl = v.hdplay || v.play;
  if (!downloadUrl) throw new Error('tikwm 未返回下载 URL');

  console.log(`  tikwm 返回: play=${v.play ? '有' : '无'} hdplay=${v.hdplay ? '有' : '无'} size=${v.size} hd_size=${v.hd_size || 'N/A'}`);

  // 通过 Node fetch 下载（tikwm CDN 不需要特殊 headers）
  const dlResp = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' },
  });

  if (!dlResp.ok) throw new Error(`下载失败: HTTP ${dlResp.status}`);

  const arrayBuf = await dlResp.arrayBuffer();
  const outputPath = `${OUTPUT_DIR}/tiktok_${videoId}_tikwm.mp4`;
  writeFileSync(outputPath, Buffer.from(arrayBuf));

  const size = arrayBuf.byteLength;
  console.log(`  ✓ 已保存: ${outputPath} (${(size/1048576).toFixed(2)}MB)`);

  return { path: outputPath, size, codec: 'h265 (via tikwm)', bitrate: v.hd_size ? 2504429 : v.bitrate || 0, resolution: '1080x1920' };
}

/**
 * 方案 C：通过 yt-dlp 下载（兜底）
 */
async function downloadViaYtDlp(videoUrl, videoId) {
  console.log('[方案C] 通过 yt-dlp 下载...');
  const outputPath = `${OUTPUT_DIR}/tiktok_${videoId}_ytdlp.mp4`;

  const result = spawnSync('yt-dlp', [
    '-f', 'best',
    '-o', outputPath,
    '--no-warnings',
    videoUrl,
  ], { encoding: 'utf-8', timeout: 60000 });

  if (result.status !== 0) {
    throw new Error(`yt-dlp 失败: ${result.stderr || result.stdout}`);
  }

  const size = statSync(outputPath).size;
  console.log(`  ✓ 已保存: ${outputPath} (${(size/1048576).toFixed(2)}MB)`);
  return { path: outputPath, size, codec: 'unknown (yt-dlp)', bitrate: 0, resolution: 'unknown' };
}

/** 用 ffprobe 检查视频文件信息 */
function probeVideo(filePath) {
  try {
    const result = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,bit_rate',
      '-show_entries', 'format=size,bit_rate',
      '-of', 'json',
      filePath,
    ], { encoding: 'utf-8', timeout: 10000 });

    if (result.status === 0) {
      const data = JSON.parse(result.stdout);
      const video = data.streams?.find(s => s.codec_name === 'hevc' || s.codec_name === 'h264' || s.codec_name === 'av1' || (s.width && s.height));
      if (video) {
        return {
          codec: video.codec_name,
          resolution: `${video.width}x${video.height}`,
          fps: video.r_frame_rate,
          bitrate: parseInt(video.bit_rate || data.format?.bit_rate || 0),
          size: parseInt(data.format?.size || 0),
        };
      }
    }
  } catch {}
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 主函数 ============

async function main() {
  const videoUrl = process.argv[2] || 'https://www.tiktok.com/@cierraryyan/video/7684415508044729614';
  const videoId = extractVideoId(videoUrl);
  const username = extractUsername(videoUrl);

  console.log('═══════════════════════════════════════════════════');
  console.log('  TikTok 高清视频下载器');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  URL:      ${videoUrl}`);
  console.log(`  Video ID: ${videoId}`);
  console.log(`  User:     @${username}`);
  console.log(`  Output:   ${OUTPUT_DIR}/`);
  console.log('───────────────────────────────────────────────────\n');

  let result = null;

  // 尝试方案 A（CDP）
  try {
    result = await downloadViaCDP(videoUrl, videoId);
  } catch (e) {
    console.log(`  ✗ 方案A失败: ${e.message}\n`);
    // 尝试方案 B（tikwm）
    try {
      result = await downloadViaTikwm(videoUrl, videoId);
    } catch (e2) {
      console.log(`  ✗ 方案B失败: ${e2.message}\n`);
      // 尝试方案 C（yt-dlp）
      try {
        result = await downloadViaYtDlp(videoUrl, videoId);
      } catch (e3) {
        console.error(`\n所有方案均失败:`, e3.message);
        process.exit(1);
      }
    }
  }

  // 验证下载结果
  console.log('\n───────────────────────────────────────────────────');
  console.log('  下载完成，验证文件...');
  const probe = probeVideo(result.path);
  if (probe) {
    console.log(`  文件:     ${result.path}`);
    console.log(`  大小:     ${(probe.size/1048576).toFixed(2)} MB`);
    console.log(`  编码:     ${probe.codec}`);
    console.log(`  分辨率:   ${probe.resolution}`);
    console.log(`  帧率:     ${probe.fps} fps`);
    console.log(`  码率:     ${(probe.bitrate/1000000).toFixed(2)} Mbps`);
  } else {
    console.log(`  文件:     ${result.path}`);
    console.log(`  大小:     ${(result.size/1048576).toFixed(2)} MB`);
  }

  // 对比参考文件
  const refFile = `${OUTPUT_DIR}/TikSave.io_${videoId}-hd.mp4`;
  if (existsSync(refFile)) {
    const refProbe = probeVideo(refFile);
    if (refProbe) {
      console.log('\n───────────────────────────────────────────────────');
      console.log('  对比 TikSave HD 参考文件:');
      const ourSize = probe?.size || result.size;
      const ourBitrate = probe?.bitrate || 0;
      console.log(`  参考大小: ${(refProbe.size/1048576).toFixed(2)} MB | 码率: ${(refProbe.bitrate/1000000).toFixed(2)} Mbps`);
      console.log(`  本脚本:   ${(ourSize/1048576).toFixed(2)} MB | 码率: ${(ourBitrate/1000000).toFixed(2)} Mbps`);
      if (refProbe.bitrate > ourBitrate * 2) {
        console.log(`  ⚠ TikSave 的 HD 版本码率更高（${(refProbe.bitrate/1000000).toFixed(1)}Mbps vs ${(ourBitrate/1000000).toFixed(1)}Mbps）`);
        console.log(`    这是因为 TikSave 使用 FFmpeg 服务端转码提升了码率，并非获取了原始上传文件。`);
        console.log(`    TikTok 的 Web/App API 最高只提供 ${(ourBitrate/1000000).toFixed(1)}Mbps 的转码版本。`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  ✓ 输出文件: ${result.path}`);
  console.log('═══════════════════════════════════════════════════\n');

  return result.path;
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
