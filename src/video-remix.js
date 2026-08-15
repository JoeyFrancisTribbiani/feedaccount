import { spawn, execFile, execSync } from "node:child_process";
import { mkdirSync, existsSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUTPUT_DIR = path.resolve(process.cwd(), "data", "remix-output");
const TEMP_DIR = path.resolve(process.cwd(), "data", "remix-tmp");
mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

let ffprobePath = null;
try {
  const ffmpegPath = execSync('where ffmpeg', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0];
  const ffmpegDir = path.dirname(ffmpegPath);
  const candidate = path.join(ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (existsSync(candidate)) ffprobePath = candidate;
  else ffprobePath = 'ffprobe';
} catch {
  ffprobePath = 'ffprobe';
}

function runFfmpeg(args) {
  const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const proc = execFile("ffmpeg", ["-threads", "0", ...args], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        reject(new Error(`FFmpeg 失败：${error.message}\n${stderr?.slice(-800)}`));
      } else {
        resolve(stderr);
      }
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg 处理超时（10分钟），可能视频过大或滤镜链过重"));
    }, FFMPEG_TIMEOUT_MS);
  });
}

function probeVideoViaFfprobe(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate",
      "-of", "json",
      filePath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        const data = JSON.parse(out);
        const videoStream = (data.streams || []).find((s) => s.codec_type === "video");
        const audioStream = (data.streams || []).find((s) => s.codec_type === "audio");
        const fpsParts = (videoStream?.r_frame_rate || "30/1").split("/");
        const fpsNum = Number(fpsParts[0]) || 30;
        const fpsDen = Number(fpsParts[1]) || 1;
        resolve({
          duration: Number(data.format?.duration || videoStream?.duration || 0),
          width: videoStream?.width || 1080,
          height: videoStream?.height || 1920,
          fps: fpsDen > 0 ? fpsNum / fpsDen : 30,
          sampleRate: audioStream?.sample_rate || 44100,
          hasAudio: !!audioStream,
        });
      } catch { resolve(null); }
    });
  });
}

function probeVideoViaFfmpeg(filePath) {
  return new Promise((resolve) => {
    const proc = execFile("ffmpeg", ["-i", filePath, "-hide_banner"], { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = stderr || "";
      const result = { duration: 0, width: 1080, height: 1920, fps: 30, sampleRate: 44100, hasAudio: false };
      const durMatch = text.match(/Duration:\s*([\d:.]+)/);
      if (durMatch) {
        const parts = durMatch[1].split(":").map(Number);
        result.duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
      const vMatch = text.match(/Video:\s*\S+.*?(\d{2,5})x(\d{2,5})/);
      if (vMatch) { result.width = Number(vMatch[1]); result.height = Number(vMatch[2]); }
      const fpsMatch = text.match(/(\d+(?:\.\d+)?)\s*fps/);
      if (fpsMatch) result.fps = Number(fpsMatch[1]);
      const aMatch = text.match(/Audio:\s*\S+/);
      if (aMatch) {
        result.hasAudio = true;
        const srMatch = text.match(/Audio:\s*\S+.*?(\d+)\s*Hz/);
        if (srMatch) result.sampleRate = Number(srMatch[1]);
      }
      resolve(text.includes("Video:") ? result : null);
    });
    proc.on("error", () => resolve(null));
  });
}

async function probeVideo(filePath) {
  const meta = await probeVideoViaFfprobe(filePath);
  if (meta) return meta;
  return probeVideoViaFfmpeg(filePath);
}

function genId() {
  return crypto.randomBytes(6).toString("hex");
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// ─── 去重强度预设 ───
export const DEDUP_PRESETS = Object.freeze({
  light: { flip: true, speed: 0.97, cropPercent: 0.03, hueShift: 5, saturation: 1.08, contrast: 1.03, brightness: 0.01, grainStrength: 8, pitchSemitones: 1, watermarkOpacity: 0.06 },
  medium: { flip: true, speed: 0.95, cropPercent: 0.05, hueShift: 8, saturation: 1.15, contrast: 1.05, brightness: 0.02, grainStrength: 12, pitchSemitones: 2, watermarkOpacity: 0.08 },
  strong: { flip: true, speed: 0.92, cropPercent: 0.08, hueShift: 12, saturation: 1.25, contrast: 1.08, brightness: 0.03, grainStrength: 18, pitchSemitones: 3, watermarkOpacity: 0.10 },
});

const RATIO_MAP = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
};

function pickRandomTransform(preset) {
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  return {
    flip: preset.flip,
    speed: preset.speed + randomBetween(-0.01, 0.01),
    cropPercent: preset.cropPercent + randomBetween(-0.01, 0.01),
    hueShift: preset.hueShift * sign() + randomBetween(-2, 2),
    saturation: preset.saturation + randomBetween(-0.03, 0.03),
    contrast: preset.contrast + randomBetween(-0.02, 0.02),
    brightness: preset.brightness + randomBetween(-0.01, 0.01),
    grainStrength: Math.round(preset.grainStrength + randomBetween(-3, 3)),
    pitchSemitones: preset.pitchSemitones * sign() + randomBetween(-0.5, 0.5),
    watermarkOpacity: preset.watermarkOpacity,
  };
}

async function processSingleVideo(inputPath, outputPath, meta, options = {}) {
  const { duration, width, height, fps, sampleRate, hasAudio } = meta;
  const preset = options.preset || DEDUP_PRESETS.medium;
  const t = pickRandomTransform(preset);
  const ratio = options.ratio || null;

  // 目标尺寸
  let targetW = width;
  let targetH = height;
  if (ratio && RATIO_MAP[ratio]) {
    targetW = RATIO_MAP[ratio].w;
    targetH = RATIO_MAP[ratio].h;
  }

  // 裁切计算：先按目标比例裁切，再从边缘裁掉 cropPercent
  const targetAspect = targetW / targetH;
  const srcAspect = width / height;
  let ratioCropW = width;
  let ratioCropH = height;
  if (Math.abs(srcAspect - targetAspect) > 0.01) {
    if (srcAspect > targetAspect) {
      ratioCropW = Math.round(height * targetAspect);
    } else {
      ratioCropH = Math.round(width / targetAspect);
    }
  }
  const cropW = Math.round(ratioCropW * (1 - 2 * t.cropPercent));
  const cropH = Math.round(ratioCropH * (1 - 2 * t.cropPercent));
  const cropX = Math.round((width - cropW) / 2);
  const cropY = Math.round((height - cropH) / 2);

  // 首尾裁切：去掉 0.3~0.8 秒
  const trimHead = Math.min(0.8, duration * 0.03);
  const trimTail = Math.min(0.8, duration * 0.03);
  const needTrim = duration > 5 && (trimHead + trimTail) > 0.5;

  // 变速
  const speed = Math.max(0.5, Math.min(2.0, t.speed));
  const setptsFactor = (1 / speed).toFixed(6);

  // 音频变调
  const pitchFactor = Math.pow(2, t.pitchSemitones / 12);
  const atempoVal = (speed / pitchFactor).toFixed(6);

  // 帧率微调
  const targetFps = Math.round(fps) === 30 ? 29 : Math.round(fps) === 60 ? 59 : Math.round(fps * 0.97);

  // 水印：在随机角落画一个半透明色块
  const wmSize = Math.round(Math.min(targetW, targetH) * 0.04);
  const corners = [
    `${targetW - wmSize - 10}:${targetH - wmSize - 10}`,
    `10:${targetH - wmSize - 10}`,
    `${targetW - wmSize - 10}:10`,
    `10:10`,
  ];
  const wmPos = corners[Math.floor(Math.random() * corners.length)];

  // ─── 构建 video filter chain ───
  const vFilters = [];

  // 1. 首尾裁切
  if (needTrim) {
    vFilters.push(`trim=start=${trimHead.toFixed(3)}:end=${(duration - trimTail).toFixed(3)}`, "setpts=PTS-STARTPTS");
  }

  // 2. 水平镜像翻转（最有效的单手段）
  if (t.flip) {
    vFilters.push("hflip");
  }

  // 3. 中心裁切（改变像素位置）
  vFilters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);

  // 4. 缩放到目标尺寸（bicubic 比 lanczos 快很多，去重场景足够）
  vFilters.push(`scale=${targetW}:${targetH}:flags=bicubic`);

  // 5. 变速
  vFilters.push(`setpts=PTS*${setptsFactor}`);

  // 6. 色彩变换：色相偏移 + 饱和度 + 对比度 + 亮度
  vFilters.push(
    `hue=h=${t.hueShift.toFixed(1)}:s=${t.saturation.toFixed(3)}`,
    `eq=contrast=${t.contrast.toFixed(3)}:brightness=${t.brightness.toFixed(3)}:saturation=1.0`,
  );

  // 7. 轻微锐化（减小范围以加速）
  vFilters.push(`unsharp=3:3:0.4:3:3:0`);

  // 8. 胶片颗粒噪点（只用 temporal 避免逐像素计算过重）
  vFilters.push(`noise=alls=${t.grainStrength}:allf=t`);

  // 9. 水印色块
  vFilters.push(`drawbox=x=${wmPos.split(":")[0]}:y=${wmPos.split(":")[1]}:w=${wmSize}:h=${wmSize}:color=0x000000@${(t.watermarkOpacity).toFixed(2)}:t=fill`);

  // 10. 帧率变换
  vFilters.push(`fps=${targetFps}`);

  // 11. 确保像素格式
  vFilters.push("format=yuv420p");

  // ─── 构建 audio filter chain ───
  let audioArgs = [];
  if (hasAudio) {
    const aFilters = [];

    // 首尾裁切同步
    if (needTrim) {
      aFilters.push(`atrim=start=${trimHead.toFixed(3)}:end=${(duration - trimTail).toFixed(3)}`, "asetpts=PTS-STARTPTS");
    }

    // 变调 + 变速
    aFilters.push(
      `asetrate=${sampleRate}*${pitchFactor.toFixed(6)}`,
      `atempo=${atempoVal}`,
      `aresample=${sampleRate}`,
    );

    // EQ 调整（改变音频指纹）
    aFilters.push(
      `equalizer=f=800:t=q:w=1:g=2`,
      `equalizer=f=3000:t=q:w=1:g=-1.5`,
      `bass=g=2:f=120:w=0.7`,
      `treble=g=1.5:f=8000:w=0.7`,
    );

    // 音量归一化
    aFilters.push(`volume=1.5dB`);

    audioArgs = ["-af", aFilters.join(",")];
  }

  // ─── 构建 ffmpeg 命令 ───
  const args = [
    "-i", inputPath,
    "-vf", vFilters.join(","),
    ...audioArgs,
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k");
  }

  args.push("-shortest", "-y", outputPath);
  await runFfmpeg(args);
}

async function concatVideos(inputPaths, outputPath) {
  if (inputPaths.length === 1) {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(inputPaths[0], outputPath);
    return;
  }

  const listFile = path.join(TEMP_DIR, `concat-${Date.now()}.txt`);
  const listContent = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listFile, listContent, "utf-8");

  try {
    await runFfmpeg([
      "-f", "concat", "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      "-y", outputPath,
    ]);
  } catch {
    await runFfmpeg([
      "-f", "concat", "-safe", "0",
      "-i", listFile,
      "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "128k",
      "-y", outputPath,
    ]);
  } finally {
    try { await unlink(listFile); } catch {}
  }
}

export async function dedupVideo(inputPath, ratio = null, options = {}) {
  const meta = await probeVideo(inputPath);
  if (!meta) throw new Error("无法读取视频信息");

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const cleanName = baseName.startsWith("dedup_") ? baseName.slice(6) : baseName;
  const outputPath = path.join(OUTPUT_DIR, `dedup_${cleanName}.mp4`);
  await processSingleVideo(inputPath, outputPath, meta, { ...options, ratio });
  return outputPath;
}

export async function stitchVideos(inputPaths, ratio = null, options = {}) {
  const id = genId();
  const tempPaths = [];

  try {
    const processedPaths = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const meta = await probeVideo(inputPaths[i]);
      if (!meta) throw new Error(`无法读取视频 ${i + 1} 的信息`);

      const processedPath = path.join(TEMP_DIR, `segment_${id}_${i}.mp4`);
      await processSingleVideo(inputPaths[i], processedPath, meta, { ...options, ratio });
      processedPaths.push(processedPath);
      tempPaths.push(processedPath);
    }

    const baseNames = inputPaths.map((p) => {
      const name = path.basename(p, path.extname(p));
      return name.startsWith("stitch_") ? name.slice(7) : name;
    });
    const cleanName = baseNames.join("_");
    const safeName = cleanName.length > 120 ? cleanName.slice(0, 120) : cleanName;
    const outputPath = path.join(OUTPUT_DIR, `stitch_${safeName}.mp4`);
    await concatVideos(processedPaths, outputPath);
    return outputPath;
  } finally {
    for (const p of tempPaths) {
      try { await unlink(p); } catch {}
    }
  }
}

/**
 * 混剪视频：去重原视频 → 拼接 intro + 去重视频 + outro → 叠加背景音乐(8%音量)
 * @param {string} inputPath - 原视频路径
 * @param {object} resources - { introPath, outroPath, musicPath } 每项可为 null
 * @param {string|null} ratio - 目标比例
 * @param {object} options - { preset }
 * @returns {Promise<string>} 输出文件路径
 */
export async function remixVideoWithResources(inputPath, resources = {}, ratio = null, options = {}) {
  const { introPath = null, outroPath = null, musicPath = null } = resources;
  const id = genId();
  const tempPaths = [];

  try {
    // 1. 读取原视频信息（不做去重，直接使用原视频）
    const meta = await probeVideo(inputPath);
    if (!meta) throw new Error("无法读取原视频信息");

    // 2. 收集需要拼接的片段（intro + 原视频 + outro）
    const segments = [];
    if (introPath && existsSync(introPath)) {
      const introMeta = await probeVideo(introPath);
      if (introMeta) {
        const introNorm = path.join(TEMP_DIR, `remix_intro_${id}.mp4`);
        await normalizeSegment(introPath, introNorm, meta, ratio);
        segments.push(introNorm);
        tempPaths.push(introNorm);
      }
    }
    segments.push(inputPath);
    if (outroPath && existsSync(outroPath)) {
      const outroMeta = await probeVideo(outroPath);
      if (outroMeta) {
        const outroNorm = path.join(TEMP_DIR, `remix_outro_${id}.mp4`);
        await normalizeSegment(outroPath, outroNorm, meta, ratio);
        segments.push(outroNorm);
        tempPaths.push(outroNorm);
      }
    }

    // 3. 拼接
    const concatenatedPath = path.join(TEMP_DIR, `remix_concat_${id}.mp4`);
    if (segments.length > 1) {
      await concatVideos(segments, concatenatedPath);
      tempPaths.push(concatenatedPath);
    } else {
      concatenatedPath = dedupedPath;
    }

    // 4. 叠加背景音乐
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const cleanName = baseName.startsWith("remix_") ? baseName.slice(6) : baseName;
    const outputPath = path.join(OUTPUT_DIR, `remix_${cleanName}_${id}.mp4`);

    if (musicPath && existsSync(musicPath)) {
      await mixBackgroundMusic(concatenatedPath, musicPath, outputPath);
    } else {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(concatenatedPath, outputPath);
    }

    return outputPath;
  } finally {
    for (const p of tempPaths) {
      try { await unlink(p); } catch {}
    }
  }
}

/** 将 intro/outro 片段归一化到与主视频相同的分辨率和帧率 */
async function normalizeSegment(inputPath, outputPath, mainVideoMeta, ratio = null) {
  const meta = await probeVideo(inputPath);
  if (!meta) throw new Error("无法读取片段信息");

  let targetW = mainVideoMeta.width;
  let targetH = mainVideoMeta.height;
  if (ratio && RATIO_MAP[ratio]) {
    targetW = RATIO_MAP[ratio].w;
    targetH = RATIO_MAP[ratio].h;
  }

  const args = [
    "-i", inputPath,
    "-vf", `scale=${targetW}:${targetH}:flags=bicubic,format=yuv420p,fps=${Math.round(mainVideoMeta.fps)}`,
    "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k",
    "-y", outputPath,
  ];
  await runFfmpeg(args);
}

/** 将背景音乐混入视频，音乐音量 8% */
async function mixBackgroundMusic(videoPath, musicPath, outputPath) {
  const videoMeta = await probeVideo(videoPath);
  const musicMeta = await probeVideo(musicPath);
  const duration = videoMeta?.duration || 0;
  const hasVideoAudio = videoMeta?.hasAudio;

  const args = [
    "-i", videoPath,
    "-i", musicPath,
  ];

  // 如果视频有原声音轨，保留原声 + 叠加背景音乐
  if (hasVideoAudio) {
    args.push(
      "-filter_complex",
      `[0:a]volume=1.0[a0];[1:a]volume=0.08,atrim=duration=${duration.toFixed(3)}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      "-map", "0:v", "-map", "[aout]",
    );
  } else {
    // 视频没有原声音轨，只有背景音乐
    args.push(
      "-filter_complex",
      `[1:a]volume=0.08,atrim=duration=${duration.toFixed(3)}[aout]`,
      "-map", "0:v", "-map", "[aout]",
    );
  }

  args.push(
    "-c:v", "copy",
    "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest", "-y", outputPath,
  );
  await runFfmpeg(args);
}

export { probeVideo, OUTPUT_DIR };
