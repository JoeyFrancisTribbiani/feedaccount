// 测试转场效果：片头淡入淡出 + 片尾放大
import { composeAiRemixVideo } from "./src/video-remix.js";
import { readdirSync } from "fs";
import path from "path";

const IMAGES_DIR = "src/chrome-cdp-daemon/outputs";
const MAIN_VIDEO = "data/remix-videos/1786779313181_8___11___.mp4";

// 获取图片（取前10张）
const allImages = readdirSync(IMAGES_DIR)
  .filter(f => f.endsWith(".png"))
  .sort()
  .slice(0, 10)
  .map(f => path.join(IMAGES_DIR, f));

console.log(`使用 ${allImages.length} 张图片`);
console.log(`原视频: ${MAIN_VIDEO}`);

const config = {
  introConfig: {
    imageInsertStart: 2.8,
    imageCount: 6,
    imageDuration: 0.7,
    effect: "fade",        // 片头图片动效：淡入淡出
    transition: "fade",     // 片头→正片转场：淡入淡出
    segmentFile: { filePath: "/data/remix-videos/1786866434172_____________.mp4", filename: "打铁片头.mp4" },
  },
  outroConfig: {
    imageInsertStart: 0,
    imageCount: 4,
    imageDuration: 3,
    effect: "zoom_in",      // 片尾图片动效：放大
    transition: "zoom_in",   // 正片→片尾转场：放大
    segmentFile: { filePath: "/data/remix-videos/1786866440515_____________.mp4", filename: "打铁片尾.mp4" },
  },
  musicConfig: {
    volumePercent: 8,
    scope: "original",
    loop: true,
    segmentFile: { filePath: "/data/remix-videos/1786866443577_________________20260813-121536__2_.mp3", filename: "钢琴纯音乐.mp3" },
  },
};

console.log("开始生成测试视频...");
console.log(`片头转场: ${config.introConfig.transition}`);
console.log(`片尾转场: ${config.outroConfig.transition}`);
console.log(`片头图片动效: ${config.introConfig.effect}`);
console.log(`片尾图片动效: ${config.outroConfig.effect}`);

try {
  const outputPath = await composeAiRemixVideo(MAIN_VIDEO, allImages, config, "9:16");
  console.log(`\n✓ 测试视频已生成: ${outputPath}`);
} catch (err) {
  console.error(`\n✗ 生成失败: ${err.message}`);
  console.error(err.stack);
}
