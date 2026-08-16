/**
 * 测试 AI 混剪图片覆盖拼接
 * 用最新10张图片 + 指定原视频 + 默认方案规则
 * 用法: node test/test-overlay-stitch.js
 */
import { fileURLToPath } from 'url';
import { join } from 'path';
import { readdirSync, statSync, existsSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUTS_DIR = join(ROOT, 'src', 'chrome-cdp-daemon', 'outputs');
const MAIN_VIDEO = 'D:\\WILLLUXE\\yix-repo\\feedaccount\\data\\remix-videos\\666.mp4';

async function main() {
  console.log('=== AI 混剪图片覆盖拼接测试 ===\n');

  // Step 1: 找到最后下载的10张图片（按修改时间倒序）
  console.log('Step 1: 查找最新下载的图片...');
  if (!existsSync(OUTPUTS_DIR)) {
    console.log('❌ outputs 目录不存在');
    return;
  }
  const allImgs = readdirSync(OUTPUTS_DIR)
    .filter(f => f.endsWith('.png'))
    .map(f => {
      const fp = join(OUTPUTS_DIR, f);
      return { name: f, path: fp, mtime: statSync(fp).mtimeMs, size: statSync(fp).size };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10);

  if (allImgs.length < 10) {
    console.log(`❌ 图片不足10张，当前只有 ${allImgs.length} 张`);
    return;
  }
  console.log(`  找到 ${allImgs.length} 张最新图片:`);
  allImgs.forEach((img, i) => console.log(`  ${i + 1}. ${img.name} (${Math.round(img.size / 1024)}KB, ${new Date(img.mtime).toLocaleTimeString()})`));

  // Step 2: 获取方案配置
  console.log('\nStep 2: 获取方案配置...');
  const dbUrl = 'file://' + join(ROOT, 'src', 'database.js').replace(/\\/g, '/');
  const { LocalDatabase } = await import(dbUrl);
  const db = new LocalDatabase(join(ROOT, 'data', 'reddit-flow.db'));
  const presets = db.listAiRemixPresets();
  if (!presets.length) {
    console.log('❌ 没有方案');
    return;
  }
  const preset = presets[0];
  console.log(`  方案: ${preset.name}`);
  console.log(`  片头配置: insertStart=${preset.introConfig.imageInsertStart}s, count=${preset.introConfig.imageCount}, duration=${preset.introConfig.imageDuration}s`);
  console.log(`  片尾配置: insertStart=${preset.outroConfig.imageInsertStart}s, count=${preset.outroConfig.imageCount}, duration=${preset.outroConfig.imageDuration}s`);
  console.log(`  音乐配置: volume=${preset.musicConfig.volumePercent}%, scope=${preset.musicConfig.scope}`);

  // Step 3: 检查原视频
  console.log('\nStep 3: 检查原视频...');
  console.log(`  原视频: ${MAIN_VIDEO}`);
  if (!existsSync(MAIN_VIDEO)) {
    console.log('❌ 原视频不存在');
    return;
  }
  console.log(`  文件大小: ${Math.round(statSync(MAIN_VIDEO).size / 1024)}KB`);

  // Step 4: 调用 composeAiRemixVideo
  console.log('\nStep 4: 调用 composeAiRemixVideo...');
  const videoRemixUrl = 'file://' + join(ROOT, 'src', 'video-remix.js').replace(/\\/g, '/');
  const { composeAiRemixVideo } = await import(videoRemixUrl);

  const imagePaths = allImgs.map(img => img.path);
  try {
    const outputPath = await composeAiRemixVideo(
      MAIN_VIDEO,
      imagePaths,
      {
        introConfig: preset.introConfig,
        outroConfig: preset.outroConfig,
        musicConfig: preset.musicConfig,
      },
      '9:16'
    );
    const size = Math.round(statSync(outputPath).size / 1024);
    const filename = outputPath.split('\\').pop().split('/').pop();
    console.log(`\n✅ 合成成功!`);
    console.log(`  输出文件: ${outputPath}`);
    console.log(`  文件大小: ${size}KB (${(size / 1024).toFixed(1)}MB)`);
    console.log(`  访问URL: http://127.0.0.1:39210/data/remix-output/${filename}`);
  } catch (e) {
    console.log(`\n❌ 合成失败: ${e.message}`);
    console.log(e.stack);
  }

  db.close();
}

main().catch(err => console.error('测试异常:', err));
