import { spawn, execFile } from "node:child_process";
import { mkdirSync, existsSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUTPUT_DIR = path.resolve(process.cwd(), "data", "remix-output");
const TEMP_DIR = path.resolve(process.cwd(), "data", "remix-tmp");
mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile("ffmpeg", args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFmpeg 失败：${error.message}\n${stderr?.slice(-800)}`));
      } else {
        resolve(stderr);
      }
    });
  });
}

function probeVideo(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
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

function genId() {
  return crypto.randomBytes(6).toString("hex");
}

async function processSingleVideo(inputPath, outputPath, meta, ratio) {
  const { duration, width, height, fps, sampleRate, hasAudio } = meta;

  const trimStart = duration > 3 ? 1 : 0;
  const trimEnd = duration > 3 ? duration - 1 : duration;
  const trimmedDuration = trimEnd - trimStart;
  const segLen = trimmedDuration / 3;
  const seg1End = segLen;
  const seg2End = segLen * 2;
  const seg3End = trimmedDuration;

  const fpsStr = fps.toFixed(2);
  const durStr = trimmedDuration.toFixed(3);

  const overlayColors = ["0x1a1a2e", "0x2e1a1a", "0x1a2e1a"];

  const args = [
    "-i", inputPath,
    "-f", "lavfi", "-t", durStr, "-i", `color=c=${overlayColors[0]}:s=${width}x${height}:r=${fpsStr}`,
    "-f", "lavfi", "-t", durStr, "-i", `color=c=${overlayColors[1]}:s=${width}x${height}:r=${fpsStr}`,
    "-f", "lavfi", "-t", durStr, "-i", `color=c=${overlayColors[2]}:s=${width}x${height}:r=${fpsStr}`,
  ];

  const videoFilters = [];
  if (trimStart > 0) {
    videoFilters.push(`trim=start=${trimStart}:end=${trimEnd}`, "setpts=PTS-STARTPTS");
  }
  videoFilters.push(
    "colorbalance=rm=-0.02:gm=-0.02:bm=0.02",
    "eq=brightness=0.01",
    "unsharp=5:5:0.7:5:5:0",
    "unsharp=13:13:0.1:13:13:0",
  );

  if (ratio) {
    const [tw, th] = ratio === "16:9" ? [1920, 1080] : ratio === "1:1" ? [1080, 1080] : [1080, 1920];
    videoFilters.push(`scale=${tw}:${th}:force_original_aspect_ratio=increase`, `crop=${tw}:${th}`);
  }

  const filterParts = [
    `[0:v]${videoFilters.join(",")}[v_base]`,
    `[1:v]format=rgba,colorchannelmixer=aa=0.01[ov1]`,
    `[2:v]format=rgba,colorchannelmixer=aa=0.02[ov2]`,
    `[3:v]format=rgba,colorchannelmixer=aa=0.01[ov3]`,
    `[v_base][ov1]overlay=0:0:enable='between(t,0,${seg1End.toFixed(3)})'[v1]`,
    `[v1][ov2]overlay=0:0:enable='between(t,${seg1End.toFixed(3)},${seg2End.toFixed(3)})'[v2]`,
    `[v2][ov3]overlay=0:0:enable='between(t,${seg2End.toFixed(3)},${seg3End.toFixed(3)})'[v_out]`,
  ];

  if (hasAudio) {
    const audioFilters = [];
    if (trimStart > 0) {
      audioFilters.push(`atrim=start=${trimStart}:end=${trimEnd}`, "asetpts=PTS-STARTPTS");
    }
    audioFilters.push(
      "volume=8dB",
      `asetrate=${sampleRate}*1.0601`,
      "atempo=0.9433",
    );
    filterParts.push(`[0:a]${audioFilters.join(",")}[a_out]`);
  }

  args.push("-filter_complex", filterParts.join(";"));

  if (hasAudio) {
    args.push("-map", "[v_out]", "-map", "[a_out]");
  } else {
    args.push("-map", "[v_out]");
  }

  args.push(
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );

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

export async function dedupVideo(inputPath, ratio = null) {
  const id = genId();
  const meta = await probeVideo(inputPath);
  if (!meta) throw new Error("无法读取视频信息");

  const outputPath = path.join(OUTPUT_DIR, `dedup_${id}.mp4`);
  await processSingleVideo(inputPath, outputPath, meta, ratio);
  return outputPath;
}

export async function stitchVideos(inputPaths, ratio = null) {
  const id = genId();
  const tempPaths = [];

  try {
    const processedPaths = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const meta = await probeVideo(inputPaths[i]);
      if (!meta) throw new Error(`无法读取视频 ${i + 1} 的信息`);

      const processedPath = path.join(TEMP_DIR, `segment_${id}_${i}.mp4`);
      await processSingleVideo(inputPaths[i], processedPath, meta, ratio);
      processedPaths.push(processedPath);
      tempPaths.push(processedPath);
    }

    const outputPath = path.join(OUTPUT_DIR, `stitch_${id}.mp4`);
    await concatVideos(processedPaths, outputPath);
    return outputPath;
  } finally {
    for (const p of tempPaths) {
      try { await unlink(p); } catch {}
    }
  }
}

export { probeVideo, OUTPUT_DIR };
