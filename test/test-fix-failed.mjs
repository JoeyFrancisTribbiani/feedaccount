/** 手动拼接失败任务 rt_1787023235269_zcofl */
import { composeAiRemixVideo, setOutputDir } from "../src/video-remix.js";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "reddit-flow.db");
const OUTPUT_DIR = path.join(ROOT, "data", "remix-output");
const DAEMON_OUTPUTS = path.join(ROOT, "src", "chrome-cdp-daemon", "outputs");

setOutputDir(OUTPUT_DIR);

const db = new DatabaseSync(DB_PATH);
const task = db.prepare("SELECT * FROM remix_tasks WHERE id = ?").get("rt_1787023235269_zcofl");
const preset = db.prepare("SELECT * FROM ai_remix_presets WHERE id = ?").get(task.preset_id);
const presetFiles = db.prepare("SELECT * FROM ai_preset_files WHERE preset_id = ?").all(task.preset_id);

const findFile = (varName) => {
  const f = presetFiles.find(f => f.var_name === varName);
  return f ? f.file_path : null;
};
const introConfig = JSON.parse(preset.intro_config_json || "{}");
const outroConfig = JSON.parse(preset.outro_config_json || "{}");
const musicConfig = JSON.parse(preset.music_config_json || "{}");
if (!introConfig.segmentFilePath) introConfig.segmentFilePath = findFile("_intro_segment");
if (!outroConfig.segmentFilePath) outroConfig.segmentFilePath = findFile("_outro_segment");
if (!musicConfig.segmentFilePath) musicConfig.segmentFilePath = findFile("_music_segment");
db.close();

const videoUrl = JSON.parse(task.video_urls_json)[0];
const mainVideoPath = path.resolve(ROOT, videoUrl.replace(/^\//, ""));

// 找这个任务下载的11张图片（时间戳1787025463-1787025471）
const images = readdirSync(DAEMON_OUTPUTS)
  .filter(f => f.startsWith("img_1787025463") || f.startsWith("img_1787025464") || f.startsWith("img_1787025468") || f.startsWith("img_1787025469") || f.startsWith("img_1787025470") || f.startsWith("img_1787025471"))
  .map(f => ({ name: f, path: path.join(DAEMON_OUTPUTS, f) }))
  .sort((a, b) => {
    const aNum = parseInt(a.name.match(/_(\d+)\./)?.[1] || 0);
    const bNum = parseInt(b.name.match(/_(\d+)\./)?.[1] || 0);
    return aNum - bNum;
  });

console.log(`原视频: ${mainVideoPath} (存在: ${existsSync(mainVideoPath)})`);
console.log(`片头: ${introConfig.segmentFilePath}`);
console.log(`片尾: ${outroConfig.segmentFilePath}`)
console.log(`音乐: ${musicConfig.segmentFilePath}`)
console.log(`图片: ${images.length}张\n`);

console.log("=== 开始拼接 ===");
try {
  const finalOut = await composeAiRemixVideo(
    mainVideoPath,
    images.map(img => img.path),
    { introConfig, outroConfig, musicConfig },
    task.ratio || "9:16"
  );
  console.log("\n✅ 拼接成功!");
  console.log("成品: http://127.0.0.1:39210/data/remix-output/" + path.basename(finalOut));

  // 更新任务状态
  const db2 = new DatabaseSync(DB_PATH);
  db2.prepare("UPDATE remix_tasks SET status = ?, output_url = ?, error_message = NULL, completed_at = ? WHERE id = ?")
    .run("DONE", `/data/remix-output/${path.basename(finalOut)}`, new Date().toISOString(), task.id);
  db2.close();
  console.log("任务状态已更新为 DONE");
} catch (e) {
  console.error("\n❌ 拼接失败:", e.message);
  console.error(e.stack);
}
