/**
 * 测试 AI 混剪拼接步骤（跳过上传/发送/等待/下载，直接从图片拼接开始）
 * 从最近一次AI混剪任务读取参数，从remix-output目录找最新10张图片
 */
import { composeAiRemixVideo, setOutputDir } from "../src/video-remix.js";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "reddit-flow.db");
const OUTPUT_DIR = path.join(ROOT, "data", "remix-output");

setOutputDir(OUTPUT_DIR);

// 1. 从数据库读取最近一次AI混剪任务
const db = new DatabaseSync(DB_PATH);
const task = db.prepare("SELECT * FROM remix_tasks WHERE mode = ? ORDER BY created_at DESC LIMIT 1").get("ai-remix");
console.log("任务:", task.id, "|", task.title);
console.log("原视频:", JSON.parse(task.video_urls_json));

// 2. 获取方案配置
const preset = db.prepare("SELECT * FROM ai_remix_presets WHERE id = ?").get(task.preset_id);
const introConfig = JSON.parse(preset.intro_config_json || "{}");
const outroConfig = JSON.parse(preset.outro_config_json || "{}");
const musicConfig = JSON.parse(preset.music_config_json || "{}");

// 3. 从 ai_preset_files 填充 segmentFile
const presetFiles = db.prepare("SELECT * FROM ai_preset_files WHERE preset_id = ?").all(task.preset_id);
const findFile = (varName) => {
  const f = presetFiles.find(f => f.var_name === varName);
  return f ? f.file_path : null;
};
if (!introConfig.segmentFile) introConfig.segmentFile = findFile("_intro_segment");
if (!outroConfig.segmentFile) outroConfig.segmentFile = findFile("_outro_segment");
if (!musicConfig.segmentFile) musicConfig.segmentFile = findFile("_music_segment");

console.log("\n方案配置:");
console.log("  片头:", introConfig);
console.log("  片尾:", outroConfig);
console.log("  音乐:", musicConfig);
db.close();

// 4. 解析原视频本地路径
const videoUrl = JSON.parse(task.video_urls_json)[0];
const mainVideoPath = path.resolve(ROOT, videoUrl.replace(/^\//, ""));
console.log("\n原视频路径:", mainVideoPath, "| 存在:", existsSync(mainVideoPath));

// 5. 解析片头/片尾/音乐本地路径
const resolveResource = (fp) => fp ? path.resolve(ROOT, fp.replace(/^\//, "")) : null;
const introPath = resolveResource(introConfig.segmentFile);
const outroPath = resolveResource(outroConfig.segmentFile);
const musicPath = resolveResource(musicConfig.segmentFile);
console.log("片头路径:", introPath, "| 存在:", introPath ? existsSync(introPath) : false);
console.log("片尾路径:", outroPath, "| 存在:", outroPath ? existsSync(outroPath) : false);
console.log("音乐路径:", musicPath, "| 存在:", musicPath ? existsSync(musicPath) : false);

// 6. 找最新的10张图片（按修改时间排序）
const allImages = readdirSync(OUTPUT_DIR)
  .filter(f => f.startsWith("ai_img_") && f.endsWith(".png"))
  .map(f => ({ name: f, path: path.join(OUTPUT_DIR, f), mtime: statSync(path.join(OUTPUT_DIR, f)).mtime }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 10);
// 按文件名中的序号排序（1到10）
allImages.sort((a, b) => {
  const aNum = parseInt(a.name.match(/_(\d+)\.png/)?.[1] || 0);
  const bNum = parseInt(b.name.match(/_(\d+)\.png/)?.[1] || 0);
  return aNum - bNum;
});
console.log(`\n找到 ${allImages.length} 张图片:`);
allImages.forEach((img, i) => console.log(`  ${i + 1}. ${img.name}`));

// 7. 开始拼接
console.log("\n=== 开始 composeAiRemixVideo ===");
try {
  const finalOut = await composeAiRemixVideo(
    mainVideoPath,
    allImages.map(img => img.path),
    { introConfig, outroConfig, musicConfig },
    task.ratio || "9:16"
  );
  console.log("\n✅ 拼接成功!");
  console.log("成品:", finalOut);
  console.log("访问: http://127.0.0.1:39210/data/remix-output/" + path.basename(finalOut));
} catch (e) {
  console.error("\n❌ 拼接失败:", e.message);
  console.error(e.stack);
}
