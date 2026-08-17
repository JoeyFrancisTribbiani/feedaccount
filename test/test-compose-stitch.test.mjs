/**
 * 测试 AI 混剪拼接全流程
 * 测试1: 片头+片尾+音乐全开
 * 测试2: 全关（只有原视频去重）
 * 测试3: 只开片头
 * 测试4: enabled=false 时不加载片段
 */
import { composeAiRemixVideo, setOutputDir, probeVideo } from "../src/video-remix.js";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "reddit-flow.db");
const OUTPUT_DIR = path.join(ROOT, "data", "remix-output");

setOutputDir(OUTPUT_DIR);

// 从数据库读取方案和文件
const db = new DatabaseSync(DB_PATH);
const task = db.prepare("SELECT * FROM remix_tasks WHERE mode = ? ORDER BY created_at DESC LIMIT 1").get("ai-remix");
const preset = db.prepare("SELECT * FROM ai_remix_presets WHERE id = ?").get(task.preset_id);
const presetFiles = db.prepare("SELECT * FROM ai_preset_files WHERE preset_id = ?").all(task.preset_id);

const baseIntro = JSON.parse(preset.intro_config_json || "{}");
const baseOutro = JSON.parse(preset.outro_config_json || "{}");
const baseMusic = JSON.parse(preset.music_config_json || "{}");

const findFile = (varName) => {
  const f = presetFiles.find(f => f.var_name === varName);
  return f ? f.file_path : null;
};
const introFilePath = findFile("_intro_segment");
const outroFilePath = findFile("_outro_segment");
const musicFilePath = findFile("_music_segment");

const videoUrl = JSON.parse(task.video_urls_json)[0];
const mainVideoPath = path.resolve(ROOT, videoUrl.replace(/^\//, ""));
const ratio = task.ratio || "9:16";
db.close();

// 找最新10张图片
const images = readdirSync(OUTPUT_DIR)
  .filter(f => f.startsWith("ai_img_") && f.endsWith(".png"))
  .map(f => ({ name: f, path: path.join(OUTPUT_DIR, f), mtime: statSync(path.join(OUTPUT_DIR, f)).mtime }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 10)
  .sort((a, b) => {
    const aNum = parseInt(a.name.match(/_(\d+)\.png/)?.[1] || 0);
    const bNum = parseInt(b.name.match(/_(\d+)\.png/)?.[1] || 0);
    return aNum - bNum;
  });

console.log(`原视频: ${mainVideoPath} (存在: ${existsSync(mainVideoPath)})`);
console.log(`片头: ${introFilePath} (存在: ${existsSync(path.resolve(ROOT, introFilePath?.replace(/^\//, "")))})`);
console.log(`片尾: ${outroFilePath} (存在: ${existsSync(path.resolve(ROOT, outroFilePath?.replace(/^\//, "")))})`);
console.log(`音乐: ${musicFilePath} (存在: ${existsSync(path.resolve(ROOT, musicFilePath?.replace(/^\//, "")))})`);
console.log(`图片: ${images.length}张\n`);

let passed = 0, failed = 0;

async function runTest(name, config, expectIntro, expectOutro, expectMusic) {
  console.log(`--- 测试: ${name} ---`);
  try {
    const out = await composeAiRemixVideo(mainVideoPath, images.map(i => i.path), config, ratio);
    const meta = await probeVideo(out);
    const duration = meta?.duration || 0;

    // 原视频去重后约37s
    // 片头: 图片从insertStart开始覆盖imageCount×imageDuration秒后截断
    // 片尾: 同理
    const introSeg = config.introConfig?.enabled !== false && config.introConfig?.segmentFilePath;
    const outroSeg = config.outroConfig?.enabled !== false && config.outroConfig?.segmentFilePath;
    const musicSeg = config.musicConfig?.enabled !== false && config.musicConfig?.segmentFilePath;

    console.log(`  成品时长: ${duration.toFixed(1)}s`);
    console.log(`  成品: ${path.basename(out)}`);

    // 全关: 只有原视频约37s
    if (!introSeg && !outroSeg) {
      if (duration > 42) { console.log(`  ❌ 全关但时长${duration.toFixed(1)}s过长(期望<42s)`); failed++; }
      else { console.log(`  ✅ 全关时长正确`); passed++; }
    }
    // 有片头: 应该 > 40s (片头截断后7s + 原视频37s = 44s)
    else if (introSeg && !outroSeg) {
      if (duration < 40) { console.log(`  ❌ 有片头但时长${duration.toFixed(1)}s太短(期望>40s)`); failed++; }
      else { console.log(`  ✅ 有片头时长正确`); passed++; }
    }
    // 有片尾: 应该 > 42s (原视频37s + 片尾截断后约12s = 49s)
    else if (!introSeg && outroSeg) {
      if (duration < 42) { console.log(`  ❌ 有片尾但时长${duration.toFixed(1)}s太短(期望>42s)`); failed++; }
      else { console.log(`  ✅ 有片尾时长正确`); passed++; }
    }
    // 全开: 片头+原视频+片尾
    else {
      if (duration < 45) { console.log(`  ❌ 全开但时长${duration.toFixed(1)}s太短(期望>45s)`); failed++; }
      else { console.log(`  ✅ 全开时长正确`); passed++; }
    }
  } catch (e) {
    console.log(`  ❌ 失败: ${e.message}`);
    failed++;
  }
  console.log("");
}

// 测试1: 全开
await runTest("全开（片头+片尾+音乐）", {
  introConfig: { ...baseIntro, segmentFilePath: introFilePath },
  outroConfig: { ...baseOutro, segmentFilePath: outroFilePath },
  musicConfig: { ...baseMusic, segmentFilePath: musicFilePath },
}, true, true, true);

// 测试2: 全关
await runTest("全关", {
  introConfig: { enabled: false, segmentFilePath: null },
  outroConfig: { enabled: false, segmentFilePath: null },
  musicConfig: { enabled: false, segmentFilePath: null },
}, false, false, false);

// 测试3: 只开片头
await runTest("只开片头", {
  introConfig: { ...baseIntro, segmentFilePath: introFilePath },
  outroConfig: { enabled: false, segmentFilePath: null },
  musicConfig: { enabled: false, segmentFilePath: null },
}, true, false, false);

// 测试4: 只开片尾+音乐
await runTest("只开片尾+音乐", {
  introConfig: { enabled: false, segmentFilePath: null },
  outroConfig: { ...baseOutro, segmentFilePath: outroFilePath },
  musicConfig: { ...baseMusic, segmentFilePath: musicFilePath },
}, false, true, true);

console.log(`=== 结果: ${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
