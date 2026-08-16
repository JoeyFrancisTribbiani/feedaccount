/**
 * 测试图片拼接：用已下载的图片 + 方案配置拼接成视频
 * 不经过 ChatGPT，直接测试后半段拼接流程
 * 
 * 用法：node test/test-image-stitch.js
 */

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUTS_DIR = join(ROOT, 'src', 'chrome-cdp-daemon', 'outputs');
const REMIX_OUTPUT_DIR = join(ROOT, 'data', 'remix-output');

async function main() {
  console.log('=== 图片拼接测试 ===\n');

  // Step 1: 找到已下载的图片
  console.log('Step 1: 查找已下载的图片...');
  const allImgs = readdirSync(OUTPUTS_DIR)
    .filter(f => f.endsWith('.png'))
    .map(f => ({ name: f, path: join(OUTPUTS_DIR, f), size: statSync(join(OUTPUTS_DIR, f)).size }))
    .sort((a, b) => b.size - a.size); // 按大小排序，大图在前（缩略图更小）

  // 取最大的10张（主图，非缩略图）
  const images = allImgs.slice(0, 10);
  console.log(`  找到 ${allImgs.length} 张图片，取最大的 ${images.length} 张`);
  images.forEach((img, i) => console.log(`  ${i + 1}. ${img.name} (${Math.round(img.size / 1024)}KB)`));

  if (images.length === 0) {
    console.log('❌ 没有找到图片，请先运行图片下载');
    return;
  }

  // Step 2: 获取方案配置
  console.log('\nStep 2: 获取方案配置...');
  const dbPath = join(ROOT, 'data', 'reddit-flow.db');
  const { LocalDatabase } = await import('file://' + join(ROOT, 'src', 'database.js').replace(/\\/g, '/'));
  const db = new LocalDatabase(join(ROOT, 'data', 'reddit-flow.db'));
  const presets = db.listAiRemixPresets();
  if (!presets.length) {
    console.log('❌ 没有方案');
    return;
  }
  const preset = presets[0];
  const introConfig = preset.introConfig || {};
  const outroConfig = preset.outroConfig || {};
  console.log(`  方案: ${preset.name}`);
  console.log(`  片头: ${introConfig.imageCount || '默认'}张, 每张${introConfig.imageDuration || 0.4}秒`);
  console.log(`  片尾: ${outroConfig.imageCount || '默认'}张, 每张${outroConfig.imageDuration || 5}秒`);

  // Step 3: 获取方案绑定的片头/片尾/音乐
  console.log('\nStep 3: 获取方案绑定的文件...');
  const presetFiles = db.getPresetFiles(preset.id);
  const introFile = presetFiles.find(f => f.varName === '_intro_segment');
  const outroFile = presetFiles.find(f => f.varName === '_outro_segment');
  const musicFile = presetFiles.find(f => f.varName === '_music_segment');
  
  const resolveLocal = (url) => {
    if (!url) return null;
    if (existsSync(url)) return url;
    const local = join(ROOT, url.replace(/^\//, ''));
    if (existsSync(local)) return local;
    return null;
  };
  
  const introPath = introFile ? resolveLocal(introFile.filePath) : null;
  const outroPath = outroFile ? resolveLocal(outroFile.filePath) : null;
  const musicPath = musicFile ? resolveLocal(musicFile.filePath) : null;
  console.log(`  片头: ${introPath || '无'}`);
  console.log(`  片尾: ${outroPath || '无'}`);
  console.log(`  音乐: ${musicPath || '无'}`);

  // Step 4: 用 FFmpeg 把图片合成幻灯片视频
  console.log('\nStep 4: 生成幻灯片视频...');
  const slidePath = join(REMIX_OUTPUT_DIR, `test_slide_${Date.now()}.mp4`);
  const introCount = Math.min(introConfig.imageCount || images.length, images.length);
  const introDur = introConfig.imageDuration || 0.4;
  const outroDur = outroConfig.imageDuration || 5;

  let concatList = '';
  for (let i = 0; i < images.length; i++) {
    const dur = i < introCount ? introDur : outroDur;
    concatList += `file '${images[i].path.replace(/'/g, "'\\''")}'\nduration ${dur}\n`;
  }
  if (images.length > 0) {
    concatList += `file '${images[images.length - 1].path.replace(/'/g, "'\\''")}'\n`;
  }

  // 写 concat 列表到临时文件
  const concatFile = join(REMIX_OUTPUT_DIR, `concat_${Date.now()}.txt`);
  writeFileSync(concatFile, concatList);

  try {
    execFileSync('ffmpeg', [
      '-threads', '0', '-err_detect', 'ignore_err',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30',
      '-movflags', '+faststart', '-y', slidePath,
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
    console.log(`✅ 幻灯片视频已生成: ${basename(slidePath)} (${Math.round(statSync(slidePath).size / 1024)}KB)`);
  } catch (e) {
    console.log(`❌ 幻灯片生成失败: ${e.message}`);
    return;
  }

  // Step 5: 用 remixVideoWithResources 拼接
  console.log('\nStep 5: 拼接片头+幻灯片+片尾+背景音乐...');
  try {
    const { remixVideoWithResources } = await import('file://' + join(ROOT, 'src', 'video-remix.js').replace(/\\/g, '/'));
    const finalOut = await remixVideoWithResources(
      slidePath,
      { introPath, outroPath, musicPath },
      '9:16',
      {}
    );
    const outputUrl = `/data/remix-output/${basename(finalOut)}`;
    console.log(`✅ 拼接完成: ${outputUrl}`);
    console.log(`  文件大小: ${Math.round(statSync(finalOut).size / 1024)}KB`);
    console.log('\n=== 测试通过！完整流程成功 ===');
    console.log('图片→幻灯片视频→拼接片头片尾音乐→成品视频');
  } catch (e) {
    console.log(`❌ 拼接失败: ${e.message}`);
  }

  db.close();
}

main().catch(err => console.error('测试异常:', err.message));
