import { createReadStream, mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync, readdirSync } from "node:fs";
import { stat, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execSync } from "node:child_process";

import { BitBrowserApi } from "./bitbrowser-api.js";
import {
  DEFAULT_BITBROWSER_API,
  DEFAULT_OPTIONS,
  DEFAULT_SERVER_PORT,
  TARGET_URL,
  normalizeOptions,
} from "./config.js";
import { JobManager } from "./job-manager.js";
import { LocalDatabase } from "./database.js";
import { TiktokJobManager, TIKTOK_DEFAULT_OPTIONS } from "./tiktok/tiktok-job-manager.js";
import { TiktokPublishManager } from "./tiktok/tiktok-publish-manager.js";
import { RotationScheduler, SCHEDULER_DEFAULTS } from "./scheduler.js";
import { checkIpGeoViaSocks5 } from "./socks5-check.js";
import { DEDUP_PRESETS, dedupVideo, stitchVideos, probeVideo, remixVideoWithResources, composeAiRemixVideo, antiAiProcessImage, setOutputDir, setUploadDir, getOutputDir, getUploadDir, OUTPUT_DIR as REMIX_OUTPUT_DIR } from "./video-remix.js";
import { handleComfyuiEdit, updateComfyuiConfig, handleV1Models, handleV1ImagesGenerations, handleV1ChatCompletions, handleV1VideosGenerations } from "./comfyui-gateway.js";
import { ImageGenTaskManager } from "./image-gen-task-manager.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CDP_DAEMON_DIR = path.resolve(THIS_DIR, "chrome-cdp-daemon");
const CDP_DAEMON_SCRIPT = path.join(CDP_DAEMON_DIR, "server.mjs");

// ngrok 进程管理
let ngrokProc = null;
let ngrokConfig = null;
let ngrokStore = null; // 在 createMonitorServer 中赋值

function loadNgrokConfig() {
  try {
    const db = ngrokStore?.db || globalThis.__ngrokDb;
    if (!db) return null;
    const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'ngrok_config'").get();
    ngrokConfig = row ? JSON.parse(row.value_json) : null;
  } catch { ngrokConfig = null; }
  return ngrokConfig;
}

function saveNgrokConfig(config) {
  const db = ngrokStore?.db || globalThis.__ngrokDb;
  if (!db) return config;
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES ('ngrok_config', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(config || {}), new Date().toISOString());
  ngrokConfig = config;
  return config;
}

function startNgrok(port) {
  if (ngrokProc && !ngrokProc.killed) throw new Error("ngrok 已在运行");
  const args = ["http", String(port)];
  ngrokProc = spawn("ngrok", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const logs = [];
  const pushLog = (level, msg) => {
    const line = msg.trim();
    if (!line) return;
    logs.push({ at: new Date().toISOString(), level, message: line });
    if (logs.length > 100) logs.shift();
  };
  ngrokProc.stdout.on("data", (d) => pushLog("info", d.toString()));
  ngrokProc.stderr.on("data", (d) => pushLog("warning", d.toString()));
  ngrokProc.on("exit", (code) => {
    pushLog("info", `ngrok 进程退出 (code=${code})`);
    ngrokProc = null;
  });
  ngrokProc.on("error", (err) => {
    pushLog("error", `ngrok 启动失败: ${err.message}`);
    ngrokProc = null;
  });
  ngrokProc._logs = logs;
  return { pid: ngrokProc.pid, port };
}

function stopNgrok() {
  if (!ngrokProc) throw new Error("ngrok 未运行");
  ngrokProc.kill("SIGTERM");
  setTimeout(() => { if (ngrokProc && !ngrokProc.killed) ngrokProc.kill("SIGKILL"); }, 3000);
  ngrokProc = null;
  return { stopped: true };
}

function getNgrokStatus() {
  if (!ngrokProc) return { running: false };
  return {
    running: true,
    pid: ngrokProc.pid,
    port: ngrokConfig?.port || 9223,
    config: ngrokConfig,
    recentLogs: ngrokProc._logs ? ngrokProc._logs.slice(-20) : [],
  };
}
// Chrome CDP daemon 进程管理
const cdpDaemonProcesses = new Map();
let _store = null; // 由 createMonitorServer 设置

function startCdpDaemon(instance) {
  const existing = cdpDaemonProcesses.get(instance.id);
  if (existing && existing.proc && !existing.proc.killed) {
    throw new Error("守护进程已在运行");
  }

  const env = {
    ...process.env,
    CDP_TARGET_URL: `http://${instance.cdpHost}:${instance.cdpPort}`,
    DAEMON_PORT: String(instance.daemonPort),
    DAEMON_HOST: "127.0.0.1",
  };
  // 传全局路径配置给 daemon
  const pathCfg = _store?.getPathConfig?.() || {};
  if (pathCfg.outputPath) env.DAEMON_OUTPUTS_DIR = pathCfg.outputPath;

  const proc = spawn("node", ["--no-warnings", CDP_DAEMON_SCRIPT], {
    cwd: CDP_DAEMON_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const procInfo = { proc, startedAt: new Date().toISOString(), logs: [] };
  cdpDaemonProcesses.set(instance.id, procInfo);

  const pushLog = (level, msg) => {
    const line = msg.trim();
    if (!line) return;
    // 解析 [TASK:xxx] 前缀提取 taskId
    let taskId = null;
    let cleanLine = line;
    const taskMatch = line.match(/\[TASK:([^\]]+)\]/);
    if (taskMatch) {
      taskId = taskMatch[1];
      cleanLine = line.replace(/\[TASK:[^\]]+\]\s*/, '');
    }
    procInfo.logs.push({ at: new Date().toISOString(), level, message: cleanLine });
    if (procInfo.logs.length > 200) procInfo.logs.shift();
    if (_store) _store.logCdpEvent(instance.id, level, cleanLine, null, taskId);
  };

  proc.stdout.on("data", (d) => pushLog("info", d.toString()));
  proc.stderr.on("data", (d) => pushLog("warning", d.toString()));

  proc.on("exit", (code) => {
    pushLog("info", `守护进程退出 (code=${code})`);
    if (_store) _store.updateChromeInstanceStatus(instance.id, "stopped");
    cdpDaemonProcesses.delete(instance.id);
  });

  proc.on("error", (err) => {
    pushLog("error", `守护进程启动失败: ${err.message}`);
    if (_store) _store.updateChromeInstanceStatus(instance.id, "error");
    cdpDaemonProcesses.delete(instance.id);
  });

  _store.updateChromeInstanceStatus(instance.id, "running");
  return { pid: proc.pid, startedAt: procInfo.startedAt };
}

function stopCdpDaemon(instanceId) {
  const procInfo = cdpDaemonProcesses.get(instanceId);
  if (!procInfo || !procInfo.proc) {
    throw new Error("守护进程未运行");
  }
  procInfo.proc.kill("SIGTERM");
  setTimeout(() => {
    if (procInfo.proc && !procInfo.proc.killed) {
      procInfo.proc.kill("SIGKILL");
    }
  }, 3000);
  _store.updateChromeInstanceStatus(instanceId, "stopped");
  cdpDaemonProcesses.delete(instanceId);
  return { stopped: true };
}

function getCdpDaemonStatus(instanceId) {
  const procInfo = cdpDaemonProcesses.get(instanceId);
  if (!procInfo || !procInfo.proc) return { running: false };
  return {
    running: true,
    pid: procInfo.proc.pid,
    startedAt: procInfo.startedAt,
    uptime: Date.now() - new Date(procInfo.startedAt).getTime(),
    recentLogs: procInfo.logs.slice(-20),
  };
}

const DEFAULT_PUBLIC_DIR = path.resolve(THIS_DIR, "../public");
const DEFAULT_DATABASE_PATH = path.resolve(THIS_DIR, "../data/reddit-flow.db");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function assertLocalWriteRequest(request) {
  const host = request.headers.host || "";
  let hostname = "";
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    const error = new Error("无效的本机请求地址");
    error.statusCode = 403;
    throw error;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    const error = new Error("只接受来自本机监控页的控制请求");
    error.statusCode = 403;
    throw error;
  }

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    const error = new Error("已拒绝跨站控制请求");
    error.statusCode = 403;
    throw error;
  }

  const origin = request.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      const error = new Error("无效的请求来源");
      error.statusCode = 403;
      throw error;
    }
    if (originHost !== host) {
      const error = new Error("已拒绝非监控页来源的控制请求");
      error.statusCode = 403;
      throw error;
    }
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function sendCsv(response, filename, columns, rows) {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const lines = rows.map((row) =>
    columns
      .map((column) => csvCell(typeof column.value === "function" ? column.value(row) : row[column.value]))
      .join(","),
  );
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  response.end(`\ufeff${[header, ...lines].join("\r\n")}`);
}

function collectAllRows(loader, pageSize) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = loader(pageSize, offset);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRemixUrl(url) {
  if (!url) return url;
  const base = path.resolve(THIS_DIR, "..", "data");
  const norm = url.replace(/\\/g, "/");
  if (norm.includes("/data/remix-videos/")) {
    const idx = norm.indexOf("/data/remix-videos/");
    return norm.substring(idx);
  }
  if (norm.includes("/data/remix-output/")) {
    const idx = norm.indexOf("/data/remix-output/");
    return norm.substring(idx);
  }
  if (existsSync(url)) {
    const abs = path.resolve(url).replace(/\\/g, "/");
    const marker = "/data/remix-videos/";
    const idx = abs.indexOf(marker);
    if (idx !== -1) return abs.substring(idx);
  }
  return url;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求内容不是有效的 JSON");
  }
}

// 简单 multipart/form-data 解析（不依赖第三方库）
async function parseMultipartSimple(request) {
  const contentType = request.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error("缺少 multipart boundary");

  const boundary = "--" + boundaryMatch[1];
  const chunks = [];
  let size = 0;
  const MAX_BODY = 50 * 1024 * 1024;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体过大（>50MB）");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const fields = {};
  const files = {};

  // 按 boundary 分割
  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = body.indexOf(boundaryBuf, start)) !== -1) {
    if (start < idx) parts.push(body.subarray(start, idx));
    start = idx + boundaryBuf.length;
  }
  if (start < body.length) parts.push(body.subarray(start));

  for (const part of parts) {
    if (part.length === 0 || part.toString("utf8").trim() === "--") continue;

    let buf = part;
    if (buf[0] === 0x0d && buf[1] === 0x0a) buf = buf.subarray(2);
    if (buf[buf.length - 2] === 0x0d && buf[buf.length - 1] === 0x0a) buf = buf.subarray(0, buf.length - 2);

    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerStr = Buffer.from(buf.subarray(0, headerEnd)).toString("utf8");
    const data = Buffer.from(buf.subarray(headerEnd + 4));

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    if (filenameMatch) {
      files[fieldName] = { name: filenameMatch[1], data: data };
    } else {
      fields[fieldName] = data.toString("utf8");
    }
  }

  return { fields, files };
}

async function serveStatic(publicDir, urlPath, response, headOnly = false) {
  const requested = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(publicDir, normalized);
  if (!filePath.startsWith(`${path.resolve(publicDir)}${path.sep}`) && filePath !== path.resolve(publicDir)) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not-file");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache, must-revalidate",
    });
    if (headOnly) response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "页面不存在" });
  }
}

export function createMonitorServer({
  bitBrowserApi,
  jobManager,
  database,
  databasePath = DEFAULT_DATABASE_PATH,
  publicDir = DEFAULT_PUBLIC_DIR,
  bitBrowserApiUrl = DEFAULT_BITBROWSER_API,
} = {}) {
  const api = bitBrowserApi || new BitBrowserApi(bitBrowserApiUrl);
  const store = database || new LocalDatabase(databasePath);
  _store = store; // 让模块级函数（startCdpDaemon 等）也能访问

  // 应用全局路径配置
  const pathCfg = store.getPathConfig();
  if (pathCfg.outputPath) setOutputDir(pathCfg.outputPath);
  if (pathCfg.videoUploadPath) setUploadDir(pathCfg.videoUploadPath);
  // 应用 ComfyUI 网关配置
  const comfyuiCfg = store.getComfyuiConfig();
  updateComfyuiConfig(comfyuiCfg);
  ngrokStore = store;
  globalThis.__ngrokDb = store.db;
  const jobs = jobManager || new JobManager({ bitBrowserApi: api, persistence: store });
  const tiktokJobs = new TiktokJobManager({ bitBrowserApi: api, persistence: store });
  const tiktokPublisherManager = new TiktokPublishManager({ bitBrowserApi: api, persistence: store });
  tiktokPublisherManager.startScheduler();
  const sseClients = new Map();

  const remixQueue = [];
  let remixProcessing = false;
  async function processRemixQueue() {
    if (remixProcessing) return;
    remixProcessing = true;
    while (remixQueue.length > 0) {
      const { taskId, localPaths, mode, ratio, preset, matrixIds, creatorId, sourceVideoId, videoTitle, introPath, outroPath, musicPath, introVolume = 100, outroVolume = 100, musicVolume = 8, musicScope = "full", musicLoop = true, dedup = true } = remixQueue.shift();
      store.updateRemixTask(taskId, { status: "PROCESSING" });
      try {
        const opts = preset ? { preset: DEDUP_PRESETS[preset] || DEDUP_PRESETS.medium } : {};

        if (mode === "matrix-remix") {
          // 新混剪流程：去重 → 拼接 intro+dedup+outro → 叠加背景音乐
          store.logCdpEvent(null, "info", `开始混剪: ${videoTitle || "未命名"}`, null, taskId);
          store.logCdpEvent(null, "info", `片头=${introPath ? "有" : "无"}, 片尾=${outroPath ? "有" : "无"}, 音乐=${musicPath ? "有" : "无"}`, null, taskId);
          const out = await remixVideoWithResources(localPaths[0], { introPath, outroPath, musicPath, introVolume, outroVolume, musicVolume, musicScope, musicLoop }, ratio, { ...opts, dedup });
          const outputUrl = `/data/remix-output/${path.basename(out)}`;
          store.updateRemixTask(taskId, { status: "DONE", outputUrl, completedAt: nowIso() });
          store.logCdpEvent(null, "info", `混剪完成: ${outputUrl}`, null, taskId);

          // 将成品视频链接到每个选中的社媒矩阵
          if (matrixIds && matrixIds.length) {
            for (const matrixId of matrixIds) {
              store.createMatrixVideo({
                matrixId,
                sourceVideoId,
                creatorId,
                filePath: outputUrl,
                title: videoTitle || null,
              });
            }
          }
        } else if (mode === "stitch") {
          store.logCdpEvent(null, "info", `开始拼接: ${localPaths.length}个视频`, null, taskId);
          const out = await stitchVideos(localPaths, ratio, opts);
          store.updateRemixTask(taskId, { status: "DONE", outputUrl: `/data/remix-output/${path.basename(out)}`, completedAt: nowIso() });
          store.logCdpEvent(null, "info", `拼接完成: ${path.basename(out)}`, null, taskId);
        } else {
          store.logCdpEvent(null, "info", `开始去重: ${localPaths.length}个视频`, null, taskId);
          let lastOut = null;
          for (let i = 0; i < localPaths.length; i++) {
            const out = await dedupVideo(localPaths[i], ratio, opts);
            lastOut = out;
          }
          store.updateRemixTask(taskId, { status: "DONE", outputUrl: `/data/remix-output/${path.basename(lastOut)}`, completedAt: nowIso() });
          store.logCdpEvent(null, "info", `去重完成: ${path.basename(lastOut)}`, null, taskId);
        }
      } catch (e) {
        store.updateRemixTask(taskId, { status: "FAILED", errorMessage: e.message, completedAt: nowIso() });
        store.logCdpEvent(null, "error", `任务失败: ${e.message}`, null, taskId);
      }
    }
    remixProcessing = false;
  }

  // AI 混剪队列（最多3个并发，间隔1分钟启动）
  const aiRemixQueue = [];
  let aiRemixActiveCount = 0;
  const AI_REMIX_MAX_CONCURRENT = 1;
  const AI_REMIX_START_INTERVAL = 60000; // 任务启动间隔60秒
  // 记录正在运行的daemon任务，用于中止
  const activeDaemonTasks = new Map(); // taskId → { daemonUrl, daemonTaskNo }

  async function processAiRemixQueue() {
    while (aiRemixQueue.length > 0 && aiRemixActiveCount < AI_REMIX_MAX_CONCURRENT) {
      const taskData = aiRemixQueue.shift();
      aiRemixActiveCount++;

      // 异步执行单个任务（不阻塞队列调度）
      processSingleAiRemixTask(taskData).finally(() => {
        aiRemixActiveCount--;
        // 任务完成后尝试启动下一个
        processAiRemixQueue();
      });

      // 如果队列还有任务，等待60秒再启动下一个
      if (aiRemixQueue.length > 0 && aiRemixActiveCount < AI_REMIX_MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, AI_REMIX_START_INTERVAL));
      }
    }
  }

  async function processSingleAiRemixTask(taskData) {
    const { taskId, daemonUrl, filesToUpload, prompt, matrixIds, creatorId, sourceVideoId, videoTitle, presetId, mainVideoLocalPath } = taskData;
    console.log(`[AI混剪] 任务开始: ${taskId}, daemonUrl=${daemonUrl}, files=${filesToUpload?.length}, prompt=${(prompt||'').slice(0,50)}`);
    store.updateRemixTask(taskId, { status: "PROCESSING" });
    store.logCdpEvent(null, "info", `AI混剪任务开始: ${taskId}`, null, taskId);
    const taskStartTime = Date.now();
    try {
        // Step 0: 预压缩和穿搭取图（异步处理，不阻塞提交）
        let uploadFiles = [...filesToUpload];
        let uploadMainVideoPath = mainVideoLocalPath;

        // 预压缩：文件超过20MB先压缩
        if (uploadMainVideoPath && existsSync(uploadMainVideoPath)) {
          try {
            const { statSync } = await import('fs');
            const fileSize = statSync(uploadMainVideoPath).size;
            if (fileSize > 20 * 1024 * 1024) {
              store.logCdpEvent(null, "info", `原视频 ${Math.round(fileSize / 1024 / 1024)}MB 超过20MB，预压缩...`, null, taskId);
              const { execFileSync } = await import('child_process');
              const { renameSync, unlinkSync } = await import('fs');
              const compressedPath = path.join(path.dirname(getOutputDir()), 'remix-tmp', `precompressed_${Date.now()}.mp4`);
              const compress = (input, output, crf, scale) => {
                execFileSync('ffmpeg', ['-err_detect', 'ignore_err', '-y', '-i', input, '-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast', '-vf', `scale=${scale}`, '-c:a', 'copy', '-movflags', '+faststart', output], { stdio: 'pipe', timeout: 300000 });
              };
              // 循环压缩直到 ≤50MB，音频直通不重编码
              const steps = [
                { crf: 32, scale: '-2:720' },
                { crf: 35, scale: '-2:540' },
                { crf: 38, scale: '-2:480' },
                { crf: 40, scale: '-2:360' },
              ];
              let currentInput = uploadMainVideoPath;
              let currentSize = fileSize;
              let stepIdx = 0;
              while (currentSize > 20 * 1024 * 1024 && stepIdx < steps.length) {
                const step = steps[stepIdx];
                const outputPath = stepIdx === 0 ? compressedPath : compressedPath.replace('.mp4', `_${stepIdx + 1}.mp4`);
                store.logCdpEvent(null, "info", `压缩第${stepIdx + 1}轮: CRF=${step.crf}, 分辨率=${step.scale}`, null, taskId);
                compress(currentInput, outputPath, step.crf, step.scale);
                // 如果不是第一轮，删掉上一轮的临时文件
                if (stepIdx > 0) {
                  try { unlinkSync(currentInput); } catch {}
                  // 重命名最终文件为 compressedPath
                  if (outputPath !== compressedPath) {
                    try { unlinkSync(compressedPath); } catch {}
                    renameSync(outputPath, compressedPath);
                  }
                }
                currentInput = compressedPath;
                currentSize = statSync(compressedPath).size;
                stepIdx++;
              }
              store.logCdpEvent(null, "info", `预压缩完成: ${Math.round(currentSize / 1024 / 1024)}MB (${stepIdx}轮)`, null, taskId);
              uploadMainVideoPath = compressedPath;
              uploadFiles = [compressedPath];
            }
          } catch (e) { store.logCdpEvent(null, "warning", `预压缩失败，使用原文件: ${e.message}`, null, taskId); }
        }

        // 穿搭指南取图
        if (presetId) {
          const preset = store.getAiRemixPreset(presetId);
          if (preset?.outfitGuide) {
            if (preset.outfitSource === "remote") {
              try {
                const pickUrl = preset.outfitPickUrl || "http://localhost:12999/api/image-washing/queue/pick";
                const pickIndices = preset.outfitPickIndex || [1];
                const pickRes = await fetch(pickUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indices: pickIndices }) });
                if (pickRes.ok) {
                  const pickData = await pickRes.json();
                  if (pickData.productId && pickData.images?.length) {
                    const outfitTaskIds = pickData.images.map(img => img.taskId);
                    store.updateRemixTask(taskId, { outfitTaskIds });
                    for (const img of pickData.images) {
                      try {
                        if (!img.url) continue;
                        const imgRes = await fetch(img.url);
                        if (imgRes.ok) {
                          const buffer = Buffer.from(await imgRes.arrayBuffer());
                          const fileName = `outfit_remote_${img.taskId}_${Date.now()}.jpg`;
                          writeFileSync(path.join(getOutputDir(), fileName), buffer);
                          uploadFiles.push(path.join(getOutputDir(), fileName));
                        }
                      } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]下载失败: ${e.message}`, null, taskId); }
                    }
                  }
                }
              } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]取图异常: ${e.message}`, null, taskId); }
            } else {
              const outfitCats = ["shoes", "clothing", "scene"];
              for (const cat of outfitCats) {
                const outfit = store.randomOutfitByCategory(cat);
                if (outfit) {
                  const p = path.resolve(THIS_DIR, "..", outfit.file_path.replace(/^\//, ""));
                  if (existsSync(p)) { uploadFiles.push(p); store.logCdpEvent(null, "info", `穿搭指南[${cat}]: ${outfit.brand}`, null, taskId); }
                }
              }
            }
          }
        }

        // Step 1: 上传文件到 daemon
        const fileIds = [];
        for (const filePath of uploadFiles) {
          if (!filePath || !existsSync(filePath)) {
            store.logCdpEvent(null, "warning", `AI混剪: 文件不存在，跳过: ${filePath}`, null, taskId);
            continue;
          }
          const fileBuffer = await readFile(filePath);
          const formData = new FormData();
          formData.append("file", new Blob([fileBuffer]), path.basename(filePath));
          const uploadRes = await fetch(`${daemonUrl}/api/files`, { method: "POST", body: formData });
          const uploadData = await uploadRes.json();
          if (!uploadRes.ok || !uploadData.fileId) throw new Error(`上传文件失败: ${uploadData.error || path.basename(filePath)}`);
          fileIds.push(uploadData.fileId);
        }

        if (!fileIds.length) throw new Error("没有可上传的文件");

        // Step 2: 提交 AI 混剪任务（传入 taskId 让 daemon 日志能关联）
        // 把方案的 resourceTypes 传给 daemon，让回复检测逻辑知道期望什么类型的输出
        const taskInfo0 = store.getRemixTask(taskId);
        const expectedResourceTypes = taskInfo0?.resourceTypes || ["image"];
        const taskRes = await fetch(`${daemonUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "chatgpt-ai-remix", params: { prompt, fileIds, options: { responseTimeout: 3600000, taskId, expectedResourceTypes } } }),
        });
        const daemonResData = await taskRes.json();
        if (!taskRes.ok || !daemonResData.taskNo) throw new Error(`提交 AI 混剪任务失败: ${daemonResData.error}`);
        const daemonTaskNo = daemonResData.taskNo;
        activeDaemonTasks.set(taskId, { daemonUrl, daemonTaskNo });

        // Step 3: 轮询任务状态
        let completed = false;
        let daemonTask = null;
        const pollStart = Date.now();
        while (Date.now() - pollStart < 3600000) {
          await new Promise((r) => setTimeout(r, 5000));
          const statusRes = await fetch(`${daemonUrl}/api/tasks/${daemonTaskNo}`);
          daemonTask = await statusRes.json();
          if (daemonTask.status === "completed" || daemonTask.status === "failed") {
            completed = daemonTask.status === "completed";
            break;
          }
        }

        if (!completed || !daemonTask) {
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "AI 混剪任务超时或失败", completedAt: nowIso() });
          return;
        }

        // Step 4: 从 daemon 输出中找到文件（视频或图片或分段脚本）并下载到本地
        const fileOutputs = (daemonTask.outputs || []).filter((o) => o.type === "file" || o.type === "image" || o.type === "segment_script");
        let outputUrl = null;

        // 资源类型校验：根据方案配置的 resourceTypes 检查 AI 是否返回了对应类型的资源
        const taskInfo = store.getRemixTask(taskId);
        const expectedTypes = taskInfo?.resourceTypes || ["image"];
        const hasImages = fileOutputs.some((o) => o.type === "image");
        const hasVideos = fileOutputs.some((o) => o.type === "file");
        const hasSegmentScripts = fileOutputs.some((o) => o.type === "segment_script");
        const expectImage = expectedTypes.includes("image");
        const expectVideo = expectedTypes.includes("video");
        const expectSegmentScript = expectedTypes.includes("segment_script");

        // 分段脚本校验
        if (expectSegmentScript && !hasSegmentScripts) {
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "方案要求返回分段脚本，但 AI 未返回任何分段脚本 JSON", completedAt: nowIso() });
          store.logCdpEvent(null, "error", "资源类型校验失败：方案要求分段脚本但 AI 未返回", null, taskId);
          return;
        }
        if (expectImage && !hasImages && !hasVideos) {
          // 方案要求图片但 AI 没返回任何图片/视频
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "方案要求返回图片，但 AI 未返回任何图片", completedAt: nowIso() });
          store.logCdpEvent(null, "error", "资源类型校验失败：方案要求图片但 AI 未返回图片", null, taskId);
          return;
        }
        if (expectImage && expectVideo && (!hasImages || !hasVideos)) {
          // 方案要求图片+视频但缺少其中一种
          const missing = [];
          if (!hasImages) missing.push("图片");
          if (!hasVideos) missing.push("视频");
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: `方案要求图片+视频，但 AI 未返回${missing.join("和")}`, completedAt: nowIso() });
          store.logCdpEvent(null, "error", `资源类型校验失败：缺少${missing.join("和")}`, null, taskId);
          return;
        }
        if (!expectImage && expectVideo && !hasVideos) {
          // 方案只要求视频但 AI 没返回视频
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "方案要求返回视频，但 AI 未返回任何视频", completedAt: nowIso() });
          store.logCdpEvent(null, "error", "资源类型校验失败：方案要求视频但 AI 未返回视频", null, taskId);
          return;
        }

        if (hasImages) {
          // 图片输出：下载图片到任务专属目录，按序号命名
          const task = store.getRemixTask(taskId);
          const taskSeq = task?.seqNum || taskId.replace(/[^0-9]/g, "").slice(-6) || taskId;
          const taskDir = path.join(getOutputDir(), "tasks", String(taskSeq));
          mkdirSync(taskDir, { recursive: true });
          store.logCdpEvent(null, "info", `任务专属目录: tasks/${taskSeq}`, null, taskId)
          store.logCdpEvent(null, "info", "AI 返回图片，开始下载图片...", null, taskId)
            const imagePaths = [];
            for (const imgOutput of fileOutputs) {
              try {
                const downloadRes = await fetch(`${daemonUrl}${imgOutput.url}`);
                if (downloadRes.ok) {
                  const buffer = Buffer.from(await downloadRes.arrayBuffer());
                  const imgIndex = imagePaths.length + 1;
                  const rawPath = path.join(taskDir, `${imgIndex}_raw.png`);
                  writeFileSync(rawPath, buffer);
                  // 反AI检测处理
                  const processedPath = path.join(taskDir, `${imgIndex}.png`);
                  try {
                    await antiAiProcessImage(rawPath, processedPath);
                    imagePaths.push(processedPath);
                    store.logCdpEvent(null, "info", `图片反AI处理完成: ${imagePaths.length}/${fileOutputs.length}`, null, taskId);
                  } catch (e) {
                    store.logCdpEvent(null, "warning", `图片反AI处理失败，使用原图: ${e.message}`, null, taskId);
                    // 原图重命名为最终文件
                    writeFileSync(processedPath, buffer);
                    imagePaths.push(processedPath);
                  }
                  // 删除raw文件
                  try { unlinkSync(rawPath); } catch {}
                }
              } catch (e) { store.logCdpEvent(null, "warning", `下载图片失败: ${e.message}`, null, taskId); }
            }

            // 记录图片路径到数据库（用任务目录的相对URL）
            try {
              const imgUrls = imagePaths.map(p => `/data/remix-output/tasks/${taskSeq}/${path.basename(p)}`);
              store.updateRemixTask(taskId, { imagePaths: imgUrls });
            } catch (e) { console.error("[AI混剪] 记录图片路径失败:", e.message); }

            // 自动存入 TikTok 图片素材库
            try {
              for (const imgPath of imagePaths) {
                const imgUrl = `/data/remix-output/tasks/${taskSeq}/${path.basename(imgPath)}`;
                store.createTkMaterial({ title: path.basename(imgPath), filePath: imgUrl, category: "image", hashtags: [] });
              }
              store.logCdpEvent(null, "info", `已将 ${imagePaths.length} 张图片存入图片素材库`, null, taskId);
            } catch (e) { console.error("[AI混剪] 存入图片素材库失败:", e.message); }

            // ★ 多类型资源下载（不影响现有图片逻辑）
            try {
              const taskInfo = store.getRemixTask(taskId);
              const resourceTypes = taskInfo?.resourceTypes || ["image"];
              // 只下载非 image 类型（image 已在前面下载处理过）
              const nonImageTypes = resourceTypes.filter(t => t !== "image");
              if (nonImageTypes.length > 0) {
                store.logCdpEvent(null, "info", `开始下载多类型资源: ${nonImageTypes.join(", ")}`, null, taskId);
                const allResources = await downloadAllResources(daemonUrl, fileOutputs, nonImageTypes, taskId);
                for (const res of allResources) {
                  store.createTaskResource({ taskId, type: res.type, filePath: res.url, filename: res.filename, fileSize: res.size || 0 });
                }
                store.logCdpEvent(null, "info", `多类型资源下载完成: ${allResources.length}个`, null, taskId);
              }
            } catch (e) { console.error("[AI混剪] 多类型资源下载失败:", e.message); }

            // ★ 远程穿搭指南回调：将生成的指定图片回传给远程服务
            try {
              const preset = presetId ? store.getAiRemixPreset(presetId) : null;
              if (preset?.outfitGuide && preset.outfitSource === "remote") {
                // 从任务记录读取 pick 时保存的 taskId
                const taskInfo = store.getRemixTask(taskId);
                const outfitTaskIds = taskInfo?.outfitTaskIds || [];
                // pick 失败或无可用产品时 outfitTaskIds 为空，跳过回调
                if (!outfitTaskIds.length) {
                  store.logCdpEvent(null, "info", "穿搭指南[远程]: 无pick记录，跳过回调", null, taskId);
                } else {
                  const callbackUrl = preset.outfitCallbackUrl || "http://localhost:12999/api/image-washing/queue/callback";
                  const callbackIndices = preset.outfitCallbackIndex || [5];
                  // 从已下载的图片中按回传下标取图（下标从1开始）
                  const items = [];
                  for (let i = 0; i < callbackIndices.length; i++) {
                    const idx = callbackIndices[i];
                    if (idx >= 1 && idx <= imagePaths.length) {
                      const imgPath = imagePaths[idx - 1];
                      try {
                        const { readFile } = await import("node:fs/promises");
                        const imgBuffer = await readFile(imgPath);
                        const base64 = imgBuffer.toString("base64");
                        // 用 pick 时保存的 taskId（按顺序配对）
                        const outfitTaskId = i < outfitTaskIds.length ? outfitTaskIds[i] : null;
                        if (outfitTaskId) {
                          items.push({ taskId: outfitTaskId, imageBase64: base64 });
                        } else {
                          store.logCdpEvent(null, "warning", `穿搭指南[远程]回传: 第${i}个taskId缺失，跳过`, null, taskId);
                        }
                      } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]回传图片读取失败: index=${idx}`, null, taskId); }
                    } else {
                      store.logCdpEvent(null, "warning", `穿搭指南[远程]回传: 下标${idx}超出图片数量${imagePaths.length}`, null, taskId);
                    }
                  }
                  if (items.length > 0) {
                    const cbRes = await fetch(callbackUrl, {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ items }),
                    });
                    if (cbRes.ok) {
                      const cbData = await cbRes.json();
                      store.logCdpEvent(null, "info", `穿搭指南[远程]回传完成: ${cbData.updated || 0}成功 ${cbData.failed || 0}失败`, null, taskId);
                    } else {
                      store.logCdpEvent(null, "warning", `穿搭指南[远程]回传失败: ${cbRes.status}`, null, taskId);
                    }
                  } else {
                    store.logCdpEvent(null, "info", "穿搭指南[远程]: 无可回传图片", null, taskId);
                  }
                }
              }
            } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]回传异常: ${e.message}`, null, taskId); }

            // ★ 图片下载完成，AI 部分结束。提前释放队列，允许下一个 AI 任务开始
            store.logCdpEvent(null, "info", `图片下载完成(${imagePaths.length}张)，开始本地拼接，释放AI队列`, null, taskId);
            aiRemixActiveCount--;
            processAiRemixQueue();

            // 本地拼接在后台异步执行（不阻塞 AI 队列）
            composeAiRemixVideoAsync(taskId, uploadMainVideoPath || mainVideoLocalPath, imagePaths, presetId, matrixIds, creatorId, sourceVideoId, videoTitle);
            return; // processSingleAiRemixTask 到此结束，finally 中不再减 aiRemixActiveCount（已提前减了）
        } else if (hasVideos) {
          // 视频输出：下载后走本地拼接流程（去重/片头片尾/背景音乐）
          const fileOutput = fileOutputs.find((o) => o.type === "file");
          const downloadRes = await fetch(`${daemonUrl}${fileOutput.url}`);
          if (downloadRes.ok) {
            const buffer = Buffer.from(await downloadRes.arrayBuffer());
            const aiVideoFileName = `ai_returned_${Date.now()}_${path.basename(fileOutput.filename)}`;
            const aiVideoPath = path.join(getOutputDir(), aiVideoFileName);
            writeFileSync(aiVideoPath, buffer);
            store.logCdpEvent(null, "info", `AI 返回视频已下载: ${aiVideoFileName}`, null, taskId);

            // AI 返回的视频作为主视频走本地拼接（去重/片头片尾/音乐）
            store.logCdpEvent(null, "info", `AI 返回视频，开始本地拼接`, null, taskId);
            // 提前释放 AI 队列
            aiRemixActiveCount--;
            processAiRemixQueue();
            composeAiRemixVideoAsync(taskId, aiVideoPath, [], presetId, matrixIds, creatorId, sourceVideoId, videoTitle);
            return;
          }
        }

        // 分段脚本输出：下载 JSON 到本地，然后走本地拼接（去重+分段打乱+片头片尾+音乐）
        if (hasSegmentScripts) {
          const scriptOutput = fileOutputs.find((o) => o.type === "segment_script");
          if (scriptOutput) {
            try {
              const scriptDownloadRes = await fetch(`${daemonUrl}${scriptOutput.url}`);
              if (scriptDownloadRes.ok) {
                const buffer = Buffer.from(await scriptDownloadRes.arrayBuffer());
                const scriptFileName = `ai_segment_script_${Date.now()}.json`;
                const scriptPath = path.join(getOutputDir(), scriptFileName);
                writeFileSync(scriptPath, buffer);
                store.logCdpEvent(null, "info", `分段脚本已下载: ${scriptFileName} (${buffer.length} bytes)`, null, taskId);

                // 记录到任务资源表
                store.createTaskResource({ taskId, type: "segment_script", filePath: `/data/remix-output/${scriptFileName}`, filename: scriptFileName, fileSize: buffer.length });

                // 走本地拼接（分段打乱+去重+片头片尾+音乐）
                store.logCdpEvent(null, "info", `分段脚本模式，开始本地拼接`, null, taskId);
                aiRemixActiveCount--;
                processAiRemixQueue();
                composeAiRemixVideoAsync(taskId, uploadMainVideoPath || mainVideoLocalPath, [], presetId, matrixIds, creatorId, sourceVideoId, videoTitle);
                return;
              } else {
                store.logCdpEvent(null, "error", `分段脚本下载失败: ${scriptDownloadRes.status}`, null, taskId);
              }
            } catch (e) {
              store.logCdpEvent(null, "error", `分段脚本下载异常: ${e.message}`, null, taskId);
            }
          }
        }

        // 走到这里说明既没有图片也没有视频也没有分段脚本
        store.updateRemixTask(taskId, {
          status: "FAILED",
          errorMessage: "AI 未返回任何可用的图片或视频",
          completedAt: nowIso(),
        });

        // Step 5: 链接到矩阵
        if (outputUrl && matrixIds?.length) {
          for (const matrixId of matrixIds) {
            store.createMatrixVideo({
              matrixId, sourceVideoId, creatorId,
              filePath: outputUrl, title: videoTitle || null,
            });
          }
        }
      } catch (e) {
        console.error(`[AI混剪] 任务失败: ${taskId}`, e.message, e.stack);
        store.updateRemixTask(taskId, { status: "FAILED", errorMessage: e.message, completedAt: nowIso(), durationMs: Date.now() - taskStartTime });
        store.logCdpEvent(null, "error", `AI混剪任务失败: ${e.message}`, null, taskId);
      }
    console.log(`[AI混剪] 任务结束: ${taskId}`);
    activeDaemonTasks.delete(taskId);
  }

  // 多类型资源下载
  async function downloadAllResources(daemonUrl, fileOutputs, resourceTypes, taskId) {
    const results = [];
    for (const output of fileOutputs) {
      // 根据输出类型匹配用户选的资源类型
      let matchedType = null;
      if (output.type === "image" && resourceTypes.includes("image")) matchedType = "image";
      else if (output.type === "video" && resourceTypes.includes("video")) matchedType = "video";
      else if (output.type === "audio" && resourceTypes.includes("audio")) matchedType = "audio";
      else if (output.type === "text" && resourceTypes.includes("text")) matchedType = "text";
      else if (output.type === "segment_script" && resourceTypes.includes("segment_script")) matchedType = "segment_script";
      else if (output.type === "file" && resourceTypes.includes("other")) matchedType = "other";
      if (!matchedType) continue;

      try {
        const downloadRes = await fetch(`${daemonUrl}${output.url}`);
        if (downloadRes.ok) {
          const buffer = Buffer.from(await downloadRes.arrayBuffer());
          const ext = matchedType === "image" ? "png" : matchedType === "video" ? "mp4" : matchedType === "audio" ? "mp3" : matchedType === "segment_script" ? "json" : matchedType === "text" ? "txt" : "bin";
          const fileName = `ai_res_${matchedType}_${Date.now()}_${results.length + 1}.${ext}`;
          const filePath = path.join(getOutputDir(), fileName);
          writeFileSync(filePath, buffer);
          results.push({ type: matchedType, url: `/data/remix-output/${fileName}`, filename: fileName, size: buffer.length });
          store.logCdpEvent(null, "info", `资源下载: ${matchedType} ${fileName} (${buffer.length} bytes)`, null, taskId);
        }
      } catch (e) { store.logCdpEvent(null, "warning", `资源下载失败: ${e.message}`, null, taskId); }
    }
    return results;
  }

  // 本地拼接异步执行（不阻塞 AI 队列）
  async function composeAiRemixVideoAsync(taskId, mainVideoLocalPath, imagePaths, presetId, matrixIds, creatorId, sourceVideoId, videoTitle, oldOutputUrl = null) {
    const composeStartTime = Date.now();
    try {
      // imagePaths 为空时仍可继续（AI 返回视频模式，只做去重/片头片尾/音乐）

      const preset = presetId ? store.getAiRemixPreset(presetId) : null;
      const presetFiles = presetId ? store.getPresetFiles(presetId) : [];
      const findFile = (varName) => {
        const f = presetFiles.find(f => f.varName === varName);
        return f ? f.filePath : null;
      };
      const introConfig = preset?.introConfig || {};
      const outroConfig = preset?.outroConfig || {};
      const musicConfig = preset?.musicConfig || {};
      if (!introConfig.segmentFilePath) introConfig.segmentFilePath = findFile("_intro_segment");
      if (!outroConfig.segmentFilePath) outroConfig.segmentFilePath = findFile("_outro_segment");
      if (!musicConfig.segmentFilePath) musicConfig.segmentFilePath = findFile("_music_segment");

      store.logCdpEvent(null, "info", `AI混剪合成: ${imagePaths.length}张图片, 方案=${preset?.name || "默认"}, 片头=${introConfig.segmentFilePath ? "有" : "无"}, 片尾=${outroConfig.segmentFilePath ? "有" : "无"}, 音乐=${musicConfig.segmentFilePath ? "有" : "无"}, 去重=${preset?.dedup !== false ? "是" : "否"}`, null, taskId);

      if (mainVideoLocalPath && existsSync(mainVideoLocalPath)) {
        // ★ 分段脚本处理：去重开启 + 有分段脚本资源时，打乱中间段顺序
        let videoForRemix = mainVideoLocalPath;
        const resourceTypes = preset?.resourceTypes || [];
        const hasSegmentScript = resourceTypes.includes("segment_script");
        if (hasSegmentScript && preset?.dedup !== false) {
          try {
            const resolveLocalPath = (url) => {
              if (!url) return null;
              if (url.startsWith("/data/remix-output/")) return path.join(getOutputDir(), path.basename(url));
              return url;
            };
            const resources = store.listTaskResources(taskId);
            const scriptResource = resources.find(r => r.type === "segment_script");
            if (scriptResource) {
              const scriptPath = resolveLocalPath(scriptResource.filePath);
              if (scriptPath && existsSync(scriptPath)) {
                const { readFileSync } = await import("fs");
                const scriptData = JSON.parse(readFileSync(scriptPath, "utf-8"));

                // 检查 status
                if (scriptData.status === "failed") {
                  const errMsg = scriptData.errors?.map(e => e.message).join("; ") || "分段脚本分析失败";
                  store.logCdpEvent(null, "error", `分段脚本状态: failed — ${errMsg}`, null, taskId);
                  store.updateRemixTask(taskId, { status: "FAILED", errorMessage: `分段脚本分析失败: ${errMsg}`, completedAt: nowIso(), durationMs: Date.now() - composeStartTime });
                  return;
                } else {
                  const segments = scriptData.segments || [];
                  if (Array.isArray(segments) && segments.length >= 3) {
                    // 解析每段
                    const parsedSegs = segments.map((s, i) => ({
                      index: i,
                      originalOrder: s.original_order ?? (i + 1),
                      segmentId: s.segment_id ?? `seg_${String(i + 1).padStart(3, "0")}`,
                      startFrame: s.start_frame ?? s.startFrame ?? s.start,
                      endFrame: s.end_frame ?? s.endFrame ?? s.end,
                      reorderable: s.reorderable === true,
                      recommendedPosition: s.recommended_position ?? null,
                    })).filter(s => typeof s.startFrame === "number" && typeof s.endFrame === "number");

                    if (parsedSegs.length >= 3) {
                      // V3 新版：直接用 AI 的 recommended_order，不再随机打乱
                      const reorderPlan = scriptData.reorder_plan || {};
                      const recommendedOrder = reorderPlan.recommended_order || [];
                      let orderedSegs;

                      if (recommendedOrder.length === parsedSegs.length) {
                        // 按 recommended_order 重新排序
                        const segMap = {};
                        for (const s of parsedSegs) segMap[s.segmentId] = s;
                        orderedSegs = recommendedOrder.map(id => segMap[id]).filter(Boolean);
                        store.logCdpEvent(null, "info", `分段脚本V3: ${parsedSegs.length}段, AI推荐顺序, strategy=${reorderPlan.strategy || "ai_global_reorder"}, strength=${reorderPlan.reorder_strength || "?"}`, null, taskId);
                        store.logCdpEvent(null, "info", `原顺序: ${parsedSegs.map(s => s.segmentId).join("→")}`, null, taskId);
                        store.logCdpEvent(null, "info", `推荐顺序: ${orderedSegs.map(s => s.segmentId).join("→")}`, null, taskId);
                        if (reorderPlan.reorder_note) {
                          store.logCdpEvent(null, "info", `重排说明: ${reorderPlan.reorder_note}`, null, taskId);
                        }
                      } else {
                        // 兼容旧版：没有 recommended_order，用 recommended_position 排序
                        if (parsedSegs.every(s => s.recommendedPosition != null)) {
                          orderedSegs = [...parsedSegs].sort((a, b) => a.recommendedPosition - b.recommendedPosition);
                          store.logCdpEvent(null, "info", `分段脚本: ${parsedSegs.length}段, 按recommended_position排序`, null, taskId);
                        } else {
                          // 旧版兼容：Fisher-Yates 随机打乱 reorderable=true 的段
                          orderedSegs = [...parsedSegs];
                          const trueIndices = parsedSegs.map((s, i) => s.reorderable ? i : -1).filter(i => i >= 0);
                          if (trueIndices.length >= 2) {
                            const trueSegs = trueIndices.map(i => orderedSegs[i]);
                            let shuffled;
                            let attempts = 0;
                            do {
                              shuffled = [...trueSegs];
                              for (let i = shuffled.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                              }
                              attempts++;
                            } while (shuffled.every((s, i) => s.index === trueSegs[i].index) && attempts < 10);
                            for (let i = 0; i < trueIndices.length; i++) {
                              orderedSegs[trueIndices[i]] = shuffled[i];
                            }
                          }
                          store.logCdpEvent(null, "info", `分段脚本(旧版兼容): ${parsedSegs.length}段, 随机打乱`, null, taskId);
                        }
                      }

                      if (orderedSegs && orderedSegs.length === parsedSegs.length) {
                        // 用 FFmpeg 按帧范围切割并按推荐顺序重新拼接
                        const { probeVideo } = await import("./video-remix.js");
                        const videoMeta = await probeVideo(mainVideoLocalPath);
                        const fps = videoMeta?.fps || 30;
                        const shuffledPath = path.join(getOutputDir(), `shuffled_${Date.now()}.mp4`);

                        // 切割每段（按推荐顺序）
                        const segFiles = [];
                        for (let i = 0; i < orderedSegs.length; i++) {
                          const seg = orderedSegs[i];
                          const segPath = path.join(getOutputDir(), `seg_${i}_${Date.now()}.mp4`);
                          const startTime = (seg.startFrame / fps).toFixed(3);
                          const endTime = ((seg.endFrame + 1) / fps).toFixed(3);
                          const { execFileSync } = await import("child_process");
                          execFileSync("ffmpeg", [
                            "-err_detect", "ignore_err", "-y",
                            "-i", mainVideoLocalPath,
                            "-ss", startTime, "-to", endTime,
                            "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
                            "-c:a", "aac", "-b:a", "128k",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                            "-shortest",
                            segPath,
                          ], { stdio: "pipe", timeout: 300000 });
                          segFiles.push(segPath);
                        }

                        // 拼接所有段
                        const listFile = path.join(getOutputDir(), `concat_list_${Date.now()}.txt`);
                        const { writeFileSync: writeSync } = await import("fs");
                        writeSync(listFile, segFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");
                        const { execFileSync } = await import("child_process");
                        execFileSync("ffmpeg", [
                          "-err_detect", "ignore_err", "-y",
                          "-f", "concat", "-safe", "0",
                          "-i", listFile,
                          "-c", "copy",
                          "-movflags", "+faststart",
                          shuffledPath,
                        ], { stdio: "pipe", timeout: 300000 });

                        // 清理临时文件
                        try { for (const f of segFiles) unlinkSync(f); unlinkSync(listFile); } catch {}

                        store.logCdpEvent(null, "info", `分段重排完成: ${shuffledPath}`, null, taskId);
                        videoForRemix = shuffledPath;
                      } else {
                        store.logCdpEvent(null, "warning", "推荐顺序与段数不匹配，跳过重排", null, taskId);
                      }
                    } else {
                      store.logCdpEvent(null, "warning", "分段脚本有效段数不足(<3)，跳过重排", null, taskId);
                    }
                  } else {
                    store.logCdpEvent(null, "warning", "分段脚本格式无效或段数不足", null, taskId);
                  }
                }

                // 解析 TikTok 内容
                if (scriptData.tiktok_content) {
                  const tc = scriptData.tiktok_content;
                  store.logCdpEvent(null, "info", `TikTok内容: title="${(tc.title || "").substring(0, 60)}", hashtags=${(tc.hashtags || []).length}个, note=${(tc.expert_buying_note || "").length}字符`, null, taskId);
                  // 存储到任务记录（复用 errorMessage 字段不行，需要单独存储）
                  try {
                    const { DatabaseSync } = await import("node:sqlite");
                    const dbPath = path.join(path.dirname(THIS_DIR), "data", "reddit-flow.db");
                    const db = new DatabaseSync(dbPath);
                    // 确保 tiktok_content_json 列存在
                    try { db.exec("ALTER TABLE remix_tasks ADD COLUMN tiktok_content_json TEXT"); } catch {}
                    db.prepare("UPDATE remix_tasks SET tiktok_content_json = ? WHERE id = ?").run(JSON.stringify(tc), taskId);
                    db.close();
                  } catch (e) { console.error("[AI混剪] TikTok内容存储失败:", e.message); }
                }
              } else {
                store.logCdpEvent(null, "warning", "分段脚本文件不存在", null, taskId);
              }
            } else {
              store.logCdpEvent(null, "info", "未找到分段脚本资源，跳过重排", null, taskId);
            }
          } catch (e) {
            store.logCdpEvent(null, "warning", `分段脚本处理失败: ${e.message}，使用原视频`, null, taskId);
          }
        }

        const finalOut = await composeAiRemixVideo(videoForRemix, imagePaths, { introConfig, outroConfig, musicConfig, dedup: preset?.dedup !== false, videoTitle: videoTitle || null }, "9:16");
        // 验证成品文件是否存在
        if (!existsSync(finalOut)) {
          throw new Error(`成品视频生成失败：文件不存在 ${finalOut}`);
        }
        const outputUrl = `/data/remix-output/${path.basename(finalOut)}`;
        store.logCdpEvent(null, "info", `AI 混剪成品: ${outputUrl}`, null, taskId);
        store.updateRemixTask(taskId, { status: "DONE", outputUrl, completedAt: nowIso(), durationMs: Date.now() - composeStartTime });

        // 链接到矩阵（重新剪辑时先删旧的再建新的，避免重复）
        if (matrixIds?.length) {
          // 获取成品视频信息
          const outMeta = await probeVideo(finalOut).catch(() => null);
          const { statSync } = await import('fs');
          const outSize = existsSync(finalOut) ? statSync(finalOut).size : 0;
          for (const matrixId of matrixIds) {
            // 删除旧的矩阵视频记录（匹配原 outputUrl 的旧记录）
            try {
              const oldVideos = store.listMatrixVideos(matrixId);
              for (const ov of oldVideos) {
                if (ov.filePath === outputUrl || (oldOutputUrl && ov.filePath === oldOutputUrl)) {
                  // 删除旧的视频文件
                  if (ov.filePath) {
                    const oldFp = ov.filePath.startsWith("/data/remix-output/")
                      ? path.join(getOutputDir(), ov.filePath.replace("/data/remix-output/", ""))
                      : ov.filePath;
                    try { if (existsSync(oldFp)) unlink(oldFp); } catch {}
                  }
                  store.deleteMatrixVideo(ov.id);
                }
              }
            } catch {}
            store.createMatrixVideo({ matrixId, sourceVideoId, creatorId, filePath: outputUrl, title: videoTitle || null, duration: outMeta?.duration ?? null, fileSize: outSize });
          }
        }
      } else {
        store.logCdpEvent(null, "error", "找不到原视频文件，无法合成", null, taskId);
        store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "找不到原视频文件", completedAt: nowIso(), durationMs: Date.now() - composeStartTime });
      }
    } catch (e) {
      console.error(`[AI混剪] 拼接失败: ${taskId}`, e.message);
      store.updateRemixTask(taskId, { status: "FAILED", errorMessage: e.message, completedAt: nowIso(), durationMs: Date.now() - composeStartTime });
      store.logCdpEvent(null, "error", `AI混剪拼接失败: ${e.message}`, null, taskId);
    }
  }

  const broadcast = (jobList) => {
    const frame = `event: jobs\ndata: ${JSON.stringify(jobList)}\n\n`;
    for (const client of sseClients.keys()) client.write(frame);
  };
  const broadcastTiktok = (jobList) => {
    const frame = `event: tiktok-jobs\ndata: ${JSON.stringify(jobList)}\n\n`;
    for (const client of sseClients.keys()) client.write(frame);
  };
  const scheduler = new RotationScheduler({ bitBrowserApi: api, redditJobs: jobs, tiktokJobs, persistence: store, proxyRotateUrl: process.env.PROXY_ROTATE_URL || null });
  const onTiktokChange = (event) => broadcastTiktok(event.detail);
  const onSchedulerChange = (event) => {
    const frame = `event: scheduler\ndata: ${JSON.stringify(event.detail)}\n\n`;
    for (const client of sseClients.keys()) client.write(frame);
  };
  jobs.on("change", broadcast);
  tiktokJobs.addEventListener("change", onTiktokChange);
  scheduler.addEventListener("change", onSchedulerChange);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;

    try {
      // ComfyUI 图片编辑网关 - 异步模式
      // POST /api/comfyui/edit → 立刻返回 task_id，后台执行
      // GET /api/comfyui/result/{taskId} → 查询状态/获取结果
      // GET /api/comfyui/tasks → 查询所有任务
      if (request.method === "POST" && pathname === "/api/comfyui/edit") {
        // 解析 multipart
        let parsed;
        try {
          parsed = await parseMultipartSimple(request);
        } catch (e) {
          sendJson(response, 400, { error: e.message });
          return;
        }

        if (!parsed.files.image) {
          sendJson(response, 400, { error: "缺少 image 字段" });
          return;
        }
        const instruction = parsed.fields.instruction || "";
        if (!instruction) {
          sendJson(response, 400, { error: "缺少 instruction 字段" });
          return;
        }

        const workflowName = parsed.fields.workflow || "qwen_edit_2511_api";
        const megapixels = parsed.fields.megapixels ? parseFloat(parsed.fields.megapixels) : null;

        // 创建异步任务
        const taskId = scheduler.imageGenManager.createEditTask(
          parsed.files.image.data,
          parsed.files.image.name,
          instruction,
          workflowName,
          megapixels
        );

        sendJson(response, 202, { task_id: taskId, status: "pending", message: "图片编辑任务已提交" });
        return;
      }

      // 查询单个任务状态
      const resultMatch = pathname.match(/^\/api\/comfyui\/result\/(.+)$/);
      if (request.method === "GET" && resultMatch) {
        const taskId = decodeURIComponent(resultMatch[1]);
        const task = scheduler.imageGenManager.getTask(taskId);
        if (!task) {
          sendJson(response, 404, { error: "任务不存在" });
          return;
        }
        // 如果完成，返回图片
        if (task.status === "done" && task.result?.imageBuffer) {
          response.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": task.result.imageBuffer.length,
            "Cache-Control": "no-store",
            "X-Task-Status": "done",
            "X-Result-Filename": task.result.filename || "result.png",
          });
          response.end(task.result.imageBuffer);
          return;
        }
        // 否则返回状态
        sendJson(response, 200, {
          task_id: taskId,
          status: task.status,
          statusLabel: task.statusLabel || task.status,
          elapsedMs: task.elapsedMs,
          error: task.error,
          instruction: task.instruction,
        });
        return;
      }

      // 查询所有任务
      if (request.method === "GET" && pathname === "/api/comfyui/tasks") {
        sendJson(response, 200, scheduler.imageGenManager.getSummary());
        return;
      }

      if (
        pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      ) {
        assertLocalWriteRequest(request);
      }

      // ── OpenAI 兼容路由（给 new-api 做模型提供者）──────────────
      // GET /v1/models → 模型列表
      if (request.method === "GET" && pathname === "/v1/models") {
        handleV1Models(request, response);
        return;
      }

      // POST /v1/images/generations → 图片生成/编辑
      if (request.method === "POST" && pathname === "/v1/images/generations") {
        let body;
        try {
          body = await readJson(request);
        } catch (e) {
          sendJson(response, 400, { error: { message: "无效的 JSON 请求体", type: "invalid_request_error" } });
          return;
        }
        await handleV1ImagesGenerations(request, response, body);
        return;
      }

      // POST /v1/chat/completions → 对话兼容（包装图片编辑）
      if (request.method === "POST" && pathname === "/v1/chat/completions") {
        let body;
        try {
          body = await readJson(request);
        } catch (e) {
          sendJson(response, 400, { error: { message: "无效的 JSON 请求体", type: "invalid_request_error" } });
          return;
        }
        await handleV1ChatCompletions(request, response, body);
        return;
      }

      // POST /v1/videos/generations → 视频生成
      if (request.method === "POST" && pathname === "/v1/videos/generations") {
        let body;
        try {
          body = await readJson(request);
        } catch (e) {
          sendJson(response, 400, { error: { message: "无效的 JSON 请求体", type: "invalid_request_error" } });
          return;
        }
        await handleV1VideosGenerations(request, response, body);
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        sendJson(response, 200, {
          targetUrl: TARGET_URL,
          bitBrowserApiUrl,
          defaults: DEFAULT_OPTIONS,
          savedOptions: store.getSavedOptions(),
          databaseFile:
            store.filename === ":memory:" ? ":memory:" : path.basename(store.filename || databasePath),
          pathConfig: store.getPathConfig(),
        });
        return;
      }

      // 全局路径配置
      if (request.method === "GET" && pathname === "/api/path-config") {
        sendJson(response, 200, store.getPathConfig());
        return;
      }
      if (request.method === "POST" && pathname === "/api/path-config") {
        const body = await readJson(request);
        const config = store.savePathConfig({
          videoUploadPath: body.videoUploadPath || "",
          outputPath: body.outputPath || "",
        });
        // 实时应用路径
        setOutputDir(config.outputPath || null);
        setUploadDir(config.videoUploadPath || null);
        sendJson(response, 200, config);
        return;
      }

      // ComfyUI 网关配置
      if (request.method === "GET" && pathname === "/api/comfyui/config") {
        sendJson(response, 200, store.getComfyuiConfig());
        return;
      }
      // 生图任务状态
      if (request.method === "GET" && pathname === "/api/scheduler/image-gen-tasks") {
        sendJson(response, 200, scheduler.imageGenManager?.getSummary() || { total: 0, active: 0, tasks: [] });
        return;
      }
      if (request.method === "POST" && pathname === "/api/comfyui/config") {
        const body = await readJson(request);
        const config = store.saveComfyuiConfig({
          workflowDir: body.workflowDir || "",
          comfyuiHost: body.comfyuiHost || "",
        });
        updateComfyuiConfig(config);
        sendJson(response, 200, config);
        return;
      }

      if (request.method === "GET" && pathname === "/api/profiles") {
        const profiles = await api.listProfiles();
        store.upsertProfiles(profiles);
        sendJson(response, 200, { profiles });
        return;
      }

      if (request.method === "GET" && pathname === "/api/stats") {
        sendJson(response, 200, { stats: store.getStats() });
        return;
      }

      if (request.method === "PUT" && pathname === "/api/settings") {
        const body = await readJson(request);
        const options = normalizeOptions(body.options);
        sendJson(response, 200, { options: store.saveOptions(options) });
        return;
      }

      const profileSettingsMatch = pathname.match(/^\/api\/settings\/profile\/([^/]+)$/);
      if (request.method === "GET" && profileSettingsMatch) {
        const profileId = decodeURIComponent(profileSettingsMatch[1]);
        const options = store.getSavedOptions(profileId);
        sendJson(response, 200, { options, profileId, hasProfileOverride: options !== null });
        return;
      }
      if (request.method === "PUT" && profileSettingsMatch) {
        const profileId = decodeURIComponent(profileSettingsMatch[1]);
        const body = await readJson(request);
        const options = normalizeOptions(body.options);
        sendJson(response, 200, { options: store.saveOptions(options, profileId), profileId });
        return;
      }
      if (request.method === "DELETE" && profileSettingsMatch) {
        const profileId = decodeURIComponent(profileSettingsMatch[1]);
        const deleted = store.deleteProfileOptions(profileId);
        sendJson(response, 200, { deleted: deleted > 0, profileId });
        return;
      }

      if (request.method === "GET" && pathname === "/api/settings/ai-comment") {
        sendJson(response, 200, { config: store.getAiCommentConfig() || {} });
        return;
      }
      if (request.method === "PUT" && pathname === "/api/settings/ai-comment") {
        const body = await readJson(request);
        const config = store.saveAiCommentConfig(body.config || {});
        sendJson(response, 200, { config });
        return;
      }

      // --- Chrome CDP 实例管理 ---
      if (request.method === "GET" && pathname === "/api/cdp/instances") {
        sendJson(response, 200, { instances: store.listChromeInstances() });
        return;
      }
      if (request.method === "POST" && pathname === "/api/cdp/instances") {
        const body = await readJson(request);
        const inst = store.upsertChromeInstance(body);
        store.logCdpEvent(inst.id, "info", `实例「${inst.name}」已${body.id ? "更新" : "创建"}`);
        sendJson(response, 200, { instance: inst });
        return;
      }
      const cdpInstanceMatch = pathname.match(/^\/api\/cdp\/instances\/([^/]+)$/);
      if (cdpInstanceMatch) {
        const instId = decodeURIComponent(cdpInstanceMatch[1]);
        if (request.method === "DELETE") {
          store.deleteChromeInstance(instId);
          sendJson(response, 200, { deleted: true });
          return;
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          const inst = store.upsertChromeInstance({ ...body, id: instId });
          store.logCdpEvent(instId, "info", `实例「${inst.name}」已更新`);
          sendJson(response, 200, { instance: inst });
          return;
        }
      }

      // --- Chrome CDP 代理请求 → 转发到 daemon ---
      const cdpProxyMatch = pathname.match(/^\/api\/cdp\/instances\/([^/]+)\/(health|status|send-message|upload-file|analyze-video|analysis-status|screenshot|execute)$/);
      if (cdpProxyMatch) {
        const instId = decodeURIComponent(cdpProxyMatch[1]);
        const action = cdpProxyMatch[2];
        const inst = store.getChromeInstance(instId);
        if (!inst) { sendJson(response, 404, { error: "实例不存在" }); return; }
        const daemonUrl = inst.ngrokUrl || `http://${inst.cdpHost}:${inst.daemonPort}`;
        const proxyPath = action === "health" ? "/health"
          : action === "status" ? "/api/chatgpt/status"
          : action === "send-message" ? "/api/chatgpt/send-message"
          : action === "upload-file" ? "/api/chatgpt/upload-file"
          : action === "analyze-video" ? "/api/chatgpt/analyze-video"
          : action === "analysis-status" ? "/api/chatgpt/analysis-status"
          : action === "screenshot" ? "/api/screenshot"
          : action === "execute" ? "/api/execute"
          : null;
        if (!proxyPath) { sendJson(response, 400, { error: "未知操作" }); return; }
        try {
          const proxyUrl = `${daemonUrl}${proxyPath}${action === "analysis-status" ? `?jobId=${url.searchParams.get("jobId") || ""}` : ""}`;
          const fetchOpts = { method: request.method, headers: { "Content-Type": "application/json" } };
          if (request.method === "POST") {
            const body = await readJson(request);
            fetchOpts.body = JSON.stringify(body);
            store.logCdpEvent(instId, "info", `→ ${action}: ${JSON.stringify(body).substring(0, 100)}`);
          }
          const proxyRes = await fetch(proxyUrl, fetchOpts);
          const proxyData = await proxyRes.json();
          if (action === "health") {
            store.updateChromeInstanceStatus(instId, proxyData.cdpConnected ? "connected" : "disconnected");
          }
          store.logCdpEvent(instId, proxyData.ok === false ? "warning" : "info", `← ${action}: ${JSON.stringify(proxyData).substring(0, 150)}`);
          sendJson(response, proxyRes.ok ? 200 : 502, proxyData);
        } catch (e) {
          store.logCdpEvent(instId, "error", `代理请求失败 (${action}): ${e.message}`);
          store.updateChromeInstanceStatus(instId, "error");
          sendJson(response, 502, { error: `无法连接守护进程 (${daemonUrl}): ${e.message}` });
        }
        return;
      }

      // --- Chrome CDP 日志 ---
      if (request.method === "GET" && pathname === "/api/cdp/logs") {
        const instanceId = url.searchParams.get("instanceId") || null;
        const level = url.searchParams.get("level") || null;
        const limit = url.searchParams.get("limit") || 100;
        const taskId = url.searchParams.get("taskId") || null;
        sendJson(response, 200, { logs: store.listCdpLogs({ instanceId, level, limit, taskId }) });
        return;
      }
      if (request.method === "DELETE" && pathname === "/api/cdp/logs") {
        const instanceId = url.searchParams.get("instanceId") || null;
        const deleted = store.clearCdpLogs(instanceId);
        sendJson(response, 200, { deleted });
        return;
      }

      // --- Chrome CDP 守护进程管理 ---
      const cdpDaemonMatch = pathname.match(/^\/api\/cdp\/instances\/([^/]+)\/(daemon-start|daemon-stop|daemon-status)$/);
      if (cdpDaemonMatch) {
        const instId = decodeURIComponent(cdpDaemonMatch[1]);
        const action = cdpDaemonMatch[2];
        const inst = store.getChromeInstance(instId);
        if (!inst) { sendJson(response, 404, { error: "实例不存在" }); return; }
        try {
          if (action === "daemon-start") {
            const result = startCdpDaemon(inst);
            store.logCdpEvent(instId, "info", `守护进程已启动 (PID=${result.pid})`);
            sendJson(response, 200, { ok: true, ...result });
          } else if (action === "daemon-stop") {
            const result = stopCdpDaemon(instId);
            store.logCdpEvent(instId, "info", "守护进程已停止");
            sendJson(response, 200, { ok: true, ...result });
          } else if (action === "daemon-status") {
            const status = getCdpDaemonStatus(instId);
            sendJson(response, 200, { ok: true, ...status });
          }
        } catch (e) {
          store.logCdpEvent(instId, "error", `守护进程操作失败 (${action}): ${e.message}`);
          sendJson(response, 400, { error: e.message });
        }
        return;
      }

      // --- ngrok 管理 ---
      if (request.method === "GET" && pathname === "/api/cdp/ngrok") {
        sendJson(response, 200, { status: getNgrokStatus(), config: ngrokConfig || loadNgrokConfig() });
        return;
      }
      if (request.method === "PUT" && pathname === "/api/cdp/ngrok") {
        const body = await readJson(request);
        const config = { url: body.url || "", port: Number(body.port) || 9223, autoStart: Boolean(body.autoStart) };
        saveNgrokConfig(config);
        sendJson(response, 200, { config });
        return;
      }
      if (request.method === "POST" && pathname === "/api/cdp/ngrok/start") {
        const cfg = ngrokConfig || loadNgrokConfig();
        const port = cfg?.port || 9223;
        try {
          const result = startNgrok(port);
          sendJson(response, 200, { ok: true, ...result });
        } catch (e) { sendJson(response, 400, { error: e.message }); }
        return;
      }
      if (request.method === "POST" && pathname === "/api/cdp/ngrok/stop") {
        try {
          const result = stopNgrok();
          sendJson(response, 200, { ok: true, ...result });
        } catch (e) { sendJson(response, 400, { error: e.message }); }
        return;
      }

      if (request.method === "POST" && pathname === "/api/cdp/scan") {
        const body = await readJson(request);
        const host = body.host || "localhost";
        const portStart = Number(body.portStart) || 9222;
        const portEnd = Number(body.portEnd) || 9232;
        const results = [];
        const probes = [];
        for (let port = portStart; port <= portEnd; port++) {
          probes.push(
            fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
                .then(async (r) => {
                  const data = await r.json().catch(() => null);
                  // 只识别真正的 Chrome 调试端口（必须有 Browser 或 webSocketDebuggerUrl 字段）
                  if (data && (data.Browser || data.webSocketDebuggerUrl)) {
                    results.push({ host, port, chromeInfo: data });
                  }
                })
                .catch(() => {})
          );
        }
        await Promise.all(probes);
        sendJson(response, 200, { instances: results });
        return;
      }

      // 一键启动 Chrome 调试实例
      if (request.method === "POST" && pathname === "/api/cdp/launch-chrome") {
        const body = await readJson(request);
        const { profilePath, port, proxy, profileDirectory } = body;
        if (!profilePath) { sendJson(response, 400, { error: "请填写 Chrome profile 路径" }); return; }
        const cdpPort = Number(port) || 9222;

        // 查找 Chrome 可执行文件
        let chromePath = null;
        const candidates = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ];
        // 也尝试通过注册表查找
        try {
          const regResult = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
          const match = regResult.match(/REG_SZ\s+(.+)/);
          if (match) candidates.unshift(match[1].trim());
        } catch {}
        for (const c of candidates) {
          if (existsSync(c)) { chromePath = c; break; }
        }
        if (!chromePath) { sendJson(response, 400, { error: "未找到 Chrome 可执行文件，请确认 Chrome 已安装" }); return; }

        const args = [
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${profilePath}`,
          "--restore-last-session",
          "--remote-allow-origins=*",
        ];
        if (profileDirectory && profileDirectory.trim()) {
          args.push(`--profile-directory=${profileDirectory.trim()}`);
        }
        if (proxy) {
          args.push(`--proxy-server=${proxy}`);
        }

        const child = spawn(chromePath, args, { detached: true, stdio: "ignore", windowsHide: false });
        child.unref();

        // 启动成功后自动注册 CDP 实例到数据库
        const instance = store.upsertChromeInstance({
          name: `Chrome调试 (${cdpPort})`,
          cdpHost: "127.0.0.1",
          cdpPort: cdpPort,
          daemonPort: cdpPort + 1,
          profilePath: profilePath,
        });
        store.logCdpEvent(instance.id, "info", `Chrome 调试实例已启动 (PID=${child.pid}, 端口=${cdpPort})`);

        sendJson(response, 200, { ok: true, pid: child.pid, chromePath, cdpPort, profilePath, instanceId: instance.id });
        return;
      }

      if (request.method === "GET" && pathname === "/api/reddit/join-targets") {
        sendJson(response, 200, { targets: store.getJoinTargets() });
        return;
      }
      if (request.method === "PUT" && pathname === "/api/reddit/join-targets") {
        const body = await readJson(request);
        const targets = store.saveJoinTargets(body.targets || []);
        sendJson(response, 200, { targets });
        return;
      }

      if (request.method === "GET" && pathname === "/api/history") {
        const runs = store.listRuns({
          limit: url.searchParams.get("limit") || 100,
          offset: url.searchParams.get("offset") || 0,
          profileId: url.searchParams.get("profileId") || null,
          status: url.searchParams.get("status") || null,
        });
        sendJson(response, 200, { runs });
        return;
      }

      const historyMatch = pathname.match(/^\/api\/history\/(\d+)$/);
      if (request.method === "GET" && historyMatch) {
        const run = store.getRun(Number(historyMatch[1]));
        if (!run) {
          sendJson(response, 404, { error: "未找到该历史任务" });
          return;
        }
        sendJson(response, 200, { run });
        return;
      }

      if (request.method === "GET" && pathname === "/api/logs") {
        const logs = store.listEvents({
          limit: url.searchParams.get("limit") || 200,
          offset: url.searchParams.get("offset") || 0,
          profileId: url.searchParams.get("profileId") || null,
          level: url.searchParams.get("level") || null,
        });
        sendJson(response, 200, { logs });
        return;
      }

      if (request.method === "DELETE" && pathname === "/api/logs") {
        const body = await readJson(request);
        const deleted = store.clearEvents({ profileId: body.profileId || null });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && pathname === "/api/export/history.csv") {
        const profileId = url.searchParams.get("profileId") || null;
        const status = url.searchParams.get("status") || null;
        const rows = collectAllRows(
          (limit, offset) => store.listRuns({ limit, offset, profileId, status }),
          500,
        );
        sendCsv(
          response,
          "reddit-flow-history.csv",
          [
            { label: "任务ID", value: "id" },
            { label: "实例序号", value: "profileSeq" },
            { label: "实例名称", value: "profileName" },
            { label: "状态", value: "statusText" },
            { label: "开始时间", value: "startedAt" },
            { label: "结束时间", value: "stoppedAt" },
            { label: "任务模式", value: (row) => (row.taskMode === "post" ? "逐帖阅读" : "像素滚动（旧版）") },
            { label: "展示帖子", value: "postCount" },
            { label: "完整入镜", value: "fullPostCount" },
            { label: "最后帖子", value: (row) => row.currentPost?.title || "" },
            { label: "页面移动像素", value: "totalPixels" },
            { label: "错误", value: "error" },
            {
              label: "工作流模式",
              value: (row) =>
                row.taskMode !== "post"
                  ? "不适用（旧版像素）"
                  : row.workflowMode === "feed_detail_readonly"
                    ? "Feed 与详情只读循环"
                    : "仅 Feed 阅读",
            },
            { label: "查看详情", value: "detailVisitCount" },
            { label: "评论区移动", value: "commentScrollCount" },
            { label: "跳过广告", value: "skippedPromotedCount" },
            { label: "最后详情帖", value: (row) => row.currentDetailPost?.title || "" },
            { label: "最后工作流阶段", value: "workflowPhase" },
          ],
          rows,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/export/logs.csv") {
        const profileId = url.searchParams.get("profileId") || null;
        const level = url.searchParams.get("level") || null;
        const rows = collectAllRows(
          (limit, offset) => store.listEvents({ limit, offset, profileId, level }),
          1000,
        );
        sendCsv(
          response,
          "reddit-flow-logs.csv",
          [
            { label: "日志ID", value: "id" },
            { label: "任务ID", value: "runId" },
            { label: "实例序号", value: "profileSeq" },
            { label: "实例名称", value: "profileName" },
            { label: "时间", value: "createdAt" },
            { label: "级别", value: "level" },
            { label: "类型", value: "eventType" },
            { label: "内容", value: "message" },
          ],
          rows,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/jobs") {
        sendJson(response, 200, { jobs: jobs.list() });
        return;
      }

      if (request.method === "GET" && pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`event: jobs\ndata: ${JSON.stringify(jobs.list())}\n\n`);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
        sseClients.set(response, heartbeat);
        request.on("close", () => {
          clearInterval(heartbeat);
          sseClients.delete(response);
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/jobs/start") {
        const body = await readJson(request);
        const profileIds = [...new Set(Array.isArray(body.profileIds) ? body.profileIds.map(String) : [])];
        if (!profileIds.length) throw new Error("请至少选择一个 BitBrowser 实例");
        if (profileIds.length > 20) throw new Error("一次最多启动 20 个实例");

        const options = normalizeOptions(body.options);
        store.saveOptions(options);
        const profiles = await api.listProfiles({ includeAlive: false });
        const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
        const started = [];
        const errors = [];
        for (const profileId of profileIds) {
          const profile = profileMap.get(profileId);
          if (!profile) {
            errors.push({ profileId, error: "实例不存在或当前不可见" });
            continue;
          }
          try {
            started.push(jobs.start(profile, options));
          } catch (error) {
            errors.push({ profileId, error: error.message });
          }
        }
        sendJson(response, started.length ? 202 : 409, { started, errors });
        return;
      }

      if (request.method === "POST" && pathname === "/api/jobs/stop-all") {
        const stopped = await jobs.stopAll();
        sendJson(response, 200, { stopped });
        return;
      }

      const manualUpvoteMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/manual-upvote$/);
      if (request.method === "POST" && manualUpvoteMatch) {
        const profileId = decodeURIComponent(manualUpvoteMatch[1]);
        const body = await readJson(request);
        const expectedPostId = String(body.expectedPostId || "").trim();
        if (!expectedPostId) throw new Error("缺少待确认的帖子 ID");
        const result = await jobs.manualUpvote(profileId, expectedPostId);
        sendJson(response, 200, { job: jobs.get(profileId), result });
        return;
      }

      const manualCommentUpvoteMatch = pathname.match(
        /^\/api\/jobs\/([^/]+)\/manual-comment-upvote$/,
      );
      if (request.method === "POST" && manualCommentUpvoteMatch) {
        const profileId = decodeURIComponent(manualCommentUpvoteMatch[1]);
        const body = await readJson(request);
        const expectedCommentId = String(body.expectedCommentId || "").trim();
        if (!expectedCommentId) throw new Error("缺少待确认的评论 ID");
        const result = await jobs.manualCommentUpvote(profileId, expectedCommentId);
        sendJson(response, 200, { job: jobs.get(profileId), result });
        return;
      }

      const controlMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|trigger)$/);
      if (request.method === "POST" && controlMatch) {
        const profileId = decodeURIComponent(controlMatch[1]);
        const action = controlMatch[2];
        const result =
          action === "pause"
            ? await jobs.pause(profileId)
            : action === "resume"
              ? jobs.resume(profileId)
              : jobs.triggerNow(profileId);
        sendJson(response, 200, { job: result });
        return;
      }

      const stopMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const stopped = await jobs.stop(decodeURIComponent(stopMatch[1]));
        sendJson(response, 200, { stopped });
        return;
      }

      if (request.method === "GET" && pathname === "/api/tiktok/config") {
        const profileId = url.searchParams.get("profileId") || null;
        const saved = store.getTiktokOptions(profileId);
        sendJson(response, 200, { defaults: TIKTOK_DEFAULT_OPTIONS, saved, jobs: tiktokJobs.list() });
        return;
      }

      if (request.method === "PUT" && pathname === "/api/tiktok/settings") {
        const body = await readJson(request);
        const profileId = body.profileId || null;
        const saved = store.saveTiktokOptions(profileId, body.options || {});
        sendJson(response, 200, { options: saved });
        return;
      }

      if (request.method === "PUT" && pathname === "/api/tiktok/settings/batch") {
        const body = await readJson(request);
        const profileIds = Array.isArray(body.profileIds) ? body.profileIds.filter(Boolean) : [];
        const options = body.options || {};
        const results = [];
        for (const pid of profileIds) {
          try {
            const saved = store.saveTiktokOptions(pid, options);
            results.push({ profileId: pid, ok: true });
          } catch (e) {
            results.push({ profileId: pid, ok: false, error: e.message });
          }
        }
        sendJson(response, 200, { results, count: results.filter(r => r.ok).length });
        return;
      }

      if (request.method === "POST" && pathname === "/api/tiktok/jobs/stop-all") {
        const results = await tiktokJobs.stopAll();
        sendJson(response, 200, { stopped: results.length });
        return;
      }

      if (request.method === "GET" && pathname === "/api/tiktok/jobs") {
        sendJson(response, 200, { jobs: tiktokJobs.list() });
        return;
      }

      const tiktokStartMatch = pathname.match(/^\/api\/tiktok\/jobs\/([^/]+)\/start$/);
      if (request.method === "POST" && tiktokStartMatch) {
        const profileId = decodeURIComponent(tiktokStartMatch[1]);
        const body = await readJson(request);
        const profiles = await api.listProfiles({ includeAlive: false });
        const profile = profiles.find((p) => p.id === profileId);
        const job = await tiktokJobs.start(profileId, profile?.name || "未命名实例", body.options || {});
        sendJson(response, 200, { job });
        return;
      }

      const tiktokControlMatch = pathname.match(/^\/api\/tiktok\/jobs\/([^/]+)\/(pause|resume|stop)$/);
      if (request.method === "POST" && tiktokControlMatch) {
        const profileId = decodeURIComponent(tiktokControlMatch[1]);
        const action = tiktokControlMatch[2];
        const result = action === "stop"
          ? await tiktokJobs.stop(profileId)
          : action === "pause"
            ? tiktokJobs.pause(profileId)
            : tiktokJobs.resume(profileId);
        sendJson(response, 200, { job: result });
        return;
      }

      if (request.method === "GET" && pathname === "/api/tiktok/history") {
        const runs = store.listTiktokRuns({
          limit: url.searchParams.get("limit") || 100,
          offset: url.searchParams.get("offset") || 0,
          profileId: url.searchParams.get("profileId") || null,
          status: url.searchParams.get("status") || null,
        });
        sendJson(response, 200, { runs });
        return;
      }

      if (request.method === "GET" && pathname === "/api/tiktok/logs") {
        const logs = store.listTiktokEvents({
          limit: url.searchParams.get("limit") || 200,
          offset: url.searchParams.get("offset") || 0,
          profileId: url.searchParams.get("profileId") || null,
          level: url.searchParams.get("level") || null,
        });
        sendJson(response, 200, { logs });
        return;
      }

      // --- TK 账号与比特浏览器实例映射 API ---
      if (request.method === "GET" && pathname === "/api/tiktok/accounts") {
        const accounts = store.listTkAccounts();
        sendJson(response, 200, { accounts });
        return;
      }

      if (request.method === "POST" && pathname === "/api/tiktok/accounts") {
        const body = await readJson(request);
        if (!body.profileId) throw new Error("缺失对应的 Profile ID");
        const account = store.upsertTkAccount(body);
        sendJson(response, 200, { account });
        return;
      }

      const tkAccountDeleteMatch = pathname.match(/^\/api\/tiktok\/accounts\/([^/]+)$/);
      if (request.method === "DELETE" && tkAccountDeleteMatch) {
        const deleted = store.deleteTkAccount(decodeURIComponent(tkAccountDeleteMatch[1]));
        sendJson(response, 200, { deleted });
        return;
      }

      // --- Reddit 账号管理 API ---
      if (request.method === "GET" && pathname === "/api/reddit/accounts") {
        const accounts = store.listRedditAccounts();
        sendJson(response, 200, { accounts });
        return;
      }
      if (request.method === "POST" && pathname === "/api/reddit/accounts") {
        const body = await readJson(request);
        if (!body.profileId) throw new Error("缺失对应的 Profile ID");
        const account = store.upsertRedditAccount(body);
        sendJson(response, 200, { account });
        return;
      }
      const redditAccountDeleteMatch = pathname.match(/^\/api\/reddit\/accounts\/([^/]+)$/);
      if (request.method === "DELETE" && redditAccountDeleteMatch) {
        const deleted = store.deleteRedditAccount(decodeURIComponent(redditAccountDeleteMatch[1]));
        sendJson(response, 200, { deleted });
        return;
      }

      // --- TK 视频素材库 API ---
      if (request.method === "GET" && pathname === "/api/tiktok/materials") {
        const category = url.searchParams.get("category") || null;
        const status = url.searchParams.get("status") || null;
        const materials = store.listTkMaterials({ category, status });
        sendJson(response, 200, { materials });
        return;
      }

      if (request.method === "POST" && pathname === "/api/tiktok/materials") {
        const body = await readJson(request);
        if (!body.filePath || !body.title) throw new Error("必须提供视频文件路径与标题");
        const material = store.createTkMaterial(body);
        sendJson(response, 200, { material });
        return;
      }

      const tkMaterialDeleteMatch = pathname.match(/^\/api\/tiktok\/materials\/([^/]+)$/);
      if (request.method === "DELETE" && tkMaterialDeleteMatch) {
        const deleted = store.deleteTkMaterial(decodeURIComponent(tkMaterialDeleteMatch[1]));
        sendJson(response, 200, { deleted });
        return;
      }

      // --- TK 账号发布详情 ---
      if (request.method === "GET" && pathname.startsWith("/api/tiktok/account-detail/")) {
        const profileId = decodeURIComponent(pathname.split("/api/tiktok/account-detail/")[1]);
        // 发布历史
        const jobs = store.listTkPublishJobs({ profileId });
        // 查找TK账号绑定信息
        const tkAccount = store.getTkAccountByProfileId(profileId);
        let matrixVideos = [];
        if (tkAccount?.accountName) {
          // 通过accountName查找社媒矩阵账号，获取关联的矩阵ID
          const allMatrices = store.listMatrices();
          for (const mx of allMatrices) {
            const accounts = store.listMatrixAccounts(mx.id);
            const matched = accounts.find(a => a.accountName === tkAccount.accountName);
            if (matched) {
              matrixVideos = store.listMatrixVideos(mx.id);
              break;
            }
          }
        }
        sendJson(response, 200, { jobs, matrixVideos, tkAccount });
        return;
      }

      // --- TK 视频自动发布任务队列 API ---
      if (request.method === "GET" && pathname === "/api/tiktok/publish/jobs") {
        const status = url.searchParams.get("status") || null;
        const profileId = url.searchParams.get("profileId") || null;
        const jobsList = store.listTkPublishJobs({ status, profileId });
        sendJson(response, 200, { jobs: jobsList });
        return;
      }

      if (request.method === "POST" && pathname === "/api/tiktok/publish/jobs") {
        const body = await readJson(request);
        if (!body.profileId || !body.materialId) throw new Error("必须指定发布的目标实例与视频素材");
        const job = store.createTkPublishJob(body);
        sendJson(response, 200, { job });
        return;
      }

      const tkPublishExecuteMatch = pathname.match(/^\/api\/tiktok\/publish\/jobs\/([^/]+)\/execute$/);
      if (request.method === "POST" && tkPublishExecuteMatch) {
        const jobId = decodeURIComponent(tkPublishExecuteMatch[1]);
        tiktokPublisherManager.executeJob(jobId).then(() => {}).catch(() => {});
        sendJson(response, 202, { message: "已触发自动发布任务", jobId });
        return;
      }

      const tkPublishDeleteMatch = pathname.match(/^\/api\/tiktok\/publish\/jobs\/([^/]+)$/);
      if (request.method === "DELETE" && tkPublishDeleteMatch) {
        const deleted = store.deleteTkPublishJob(decodeURIComponent(tkPublishDeleteMatch[1]));
        sendJson(response, 200, { deleted });
        return;
      }

      if (pathname.startsWith("/api/tiktok/")) {
        sendJson(response, 404, { error: "TikTok 接口不存在" });
        return;
      }

      if (request.method === "GET" && pathname === "/api/scheduler/status") {
        sendJson(response, 200, { status: scheduler.status(), defaults: SCHEDULER_DEFAULTS, proxyRotateUrl: scheduler.defaultProxyRotateUrl });
        return;
      }

      if (request.method === "POST" && pathname === "/api/scheduler/start") {
        const body = await readJson(request);
        const status = await scheduler.start(body.options || {});
        sendJson(response, 200, { status });
        return;
      }

      if (request.method === "POST" && pathname === "/api/scheduler/stop") {
        const status = scheduler.stop();
        sendJson(response, 200, { status });
        return;
      }

      if (request.method === "POST" && pathname === "/api/scheduler/check-ip") {
        const body = await readJson(request);
        const profileId = body.profileId;
        if (!profileId) {
          sendJson(response, 400, { error: "缺少 profileId" });
          return;
        }
        try {
          const detail = await api.getProfileDetail(profileId);
          if (!detail.host || !detail.port) {
            sendJson(response, 200, { error: "该实例未配置代理", detail });
            return;
          }
          const startMs = Date.now();
          try {
            const geo = await checkIpGeoViaSocks5({
              host: detail.host,
              port: detail.port,
              username: detail.proxyUserName,
              password: detail.proxyPassword,
            });
            if (geo) {
              sendJson(response, 200, {
                ip: geo.ip,
                city: geo.city,
                zip: geo.zip,
                region: geo.region,
                country: geo.country,
                countryCode: geo.countryCode,
                remark: detail.remark || "",
                durationMs: Date.now() - startMs,
                proxyType: detail.proxyType,
                host: detail.host,
                port: detail.port,
                lastIp: detail.lastIp,
                hasAuth: Boolean(detail.proxyUserName),
              });
            } else {
              console.error("[check-ip] SOCKS5 geo 检测返回 null，请查看上方 [socks5-check] 日志");
              sendJson(response, 200, {
                ip: null,
                error: "代理检测返回空结果（详见终端日志）",
                durationMs: Date.now() - startMs,
                proxyType: detail.proxyType,
                host: detail.host,
                port: detail.port,
                hasAuth: Boolean(detail.proxyUserName),
              });
            }
          } catch (e) {
            sendJson(response, 200, {
              ip: null,
              error: e.message,
              durationMs: Date.now() - startMs,
              proxyType: detail.proxyType,
              host: detail.host,
              port: detail.port,
              hasAuth: Boolean(detail.proxyUserName),
            });
          }
        } catch (e) {
          sendJson(response, 200, { error: `获取实例配置失败：${e.message}` });
        }
        return;
      }

      if (pathname.startsWith("/api/") && !pathname.startsWith("/api/matrices") && !pathname.startsWith("/api/ai-presets")) {
        // ---- Remix: 达人管理 ----
        if (request.method === "GET" && pathname === "/api/remix/creators") {
          sendJson(response, 200, store.listRemixCreators());
          return;
        }
        if (request.method === "POST" && pathname === "/api/remix/creators") {
          const body = await readJson(request);
          if (!body.name) { sendJson(response, 400, { error: "缺少达人名称" }); return; }
          sendJson(response, 200, store.createRemixCreator({ name: body.name, platform: body.platform || null }));
          return;
        }
        const remixCreatorMatch = pathname.match(/^\/api\/remix\/creators\/([^/]+)$/);
        if (request.method === "DELETE" && remixCreatorMatch) {
          const id = decodeURIComponent(remixCreatorMatch[1]);
          store.deleteRemixCreator(id);
          sendJson(response, 200, { ok: true });
          return;
        }

        // ---- Remix: 视频管理 ----
        const remixVideosMatch = pathname.match(/^\/api\/remix\/creators\/([^/]+)\/videos$/);
        if (remixVideosMatch) {
          const creatorId = decodeURIComponent(remixVideosMatch[1]);
          if (request.method === "GET") {
            const videos = store.listRemixVideos(creatorId).map((v) => {
              const vid = { ...v, url: normalizeRemixUrl(v.url), matrixLinks: store.getMatrixLinksForVideo(v.id) };
              // 检查缩略图是否存在
              const thumbName = `thumb_${v.id}.jpg`;
              const thumbPath = path.join(getUploadDir(), 'thumbs', thumbName);
              if (existsSync(thumbPath)) vid.thumbUrl = `/data/remix-videos/thumbs/${thumbName}`;
              return vid;
            });
            sendJson(response, 200, videos);
            return;
          }
          if (request.method === "POST") {
            const body = await readJson(request);
            if (!body.url) { sendJson(response, 400, { error: "缺少视频URL" }); return; }
            const video = store.createRemixVideo({ creatorId, url: body.url, title: body.title || null });
            const meta = await probeVideo(body.url).catch(() => null);
            const dur = meta?.duration ?? null;
            if (dur) {
              store.updateRemixVideoDuration(video.id, dur);
              video.duration = dur;
            }
            // 获取文件大小
            try {
              const { statSync } = await import('fs');
              const { getUploadDir, getOutputDir } = await import('./video-remix.js');
              const localPath = body.url.startsWith('/data/remix-videos/')
                ? path.join(getUploadDir(), path.basename(body.url))
                : body.url.startsWith('/data/remix-output/')
                ? path.join(getOutputDir(), path.basename(body.url))
                : body.url;
              const fSize = statSync(localPath).size;
              store.db.prepare('UPDATE remix_videos SET file_size = ? WHERE id = ?').run(fSize, video.id);
              video.fileSize = fSize;
            } catch {}
            // 生成缩略图（第1秒截取）
            try {
              const { execFileSync } = await import('child_process');
              const { getUploadDir, getOutputDir } = await import('./video-remix.js');
              const localPath = body.url.startsWith('/data/remix-videos/') 
                ? path.join(getUploadDir(), path.basename(body.url))
                : body.url.startsWith('/data/remix-output/')
                ? path.join(getOutputDir(), path.basename(body.url))
                : body.url;
              const thumbName = `thumb_${video.id}.jpg`;
              const thumbDir = path.join(getUploadDir(), 'thumbs');
              mkdirSync(thumbDir, { recursive: true });
              const thumbPath = path.join(thumbDir, thumbName);
              const seekTime = Math.min(1, (dur || 1) * 0.1);
              execFileSync('ffmpeg', ['-ss', seekTime.toFixed(1), '-i', localPath, '-frames:v', '1', '-vf', 'scale=270:-1', '-q:v', '3', '-y', thumbPath], { stdio: 'pipe', timeout: 30000 });
              video.thumbUrl = `/data/remix-videos/thumbs/${thumbName}`;
            } catch (e) { console.error('[缩略图] 生成失败:', e.message); }
            sendJson(response, 200, video);
            return;
          }
        }
        const remixVideoDeleteMatch = pathname.match(/^\/api\/remix\/creators\/([^/]+)\/videos\/([^/]+)$/);
        if (request.method === "DELETE" && remixVideoDeleteMatch) {
          store.deleteRemixVideo(decodeURIComponent(remixVideoDeleteMatch[2]));
          sendJson(response, 200, { ok: true });
          return;
        }

        // ---- Remix: 现有素材库 ----
        if (request.method === "GET" && pathname === "/api/remix/materials") {
          sendJson(response, 200, store.listTkMaterials());
          return;
        }

        // ---- Remix: 探测视频时长 ----
        if (request.method === "GET" && pathname === "/api/remix/probe") {
          const filePath = url.searchParams.get("path");
          if (!filePath) { sendJson(response, 400, { error: "缺少 path 参数" }); return; }
          const localPath = filePath.startsWith("/") ? path.join(process.cwd(), filePath) : filePath;
          if (!existsSync(localPath)) { sendJson(response, 404, { error: "文件不存在" }); return; }
          try {
            const meta = await probeVideo(localPath);
            sendJson(response, 200, { duration: meta?.duration || 0, width: meta?.width, height: meta?.height });
          } catch (e) {
            sendJson(response, 400, { error: e.message });
          }
          return;
        }

        // ---- Remix: 上传 ----
        if (request.method === "POST" && pathname === "/api/remix/upload") {
          const contentType = request.headers["content-type"] || "";
          const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
          if (!boundaryMatch) { sendJson(response, 400, { error: "无效的上传请求" }); return; }
          const boundaryBuf = Buffer.from("--" + boundaryMatch[1]);
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const buf = Buffer.concat(chunks);

          let filename = null;
          let fileContent = null;
          let searchStart = 0;
          while (true) {
            const pos = buf.indexOf(boundaryBuf, searchStart);
            if (pos === -1) break;
            const afterBoundary = pos + boundaryBuf.length;
            if (buf[afterBoundary] === 0x2d && buf[afterBoundary + 1] === 0x2d) break;
            const partStart = afterBoundary + 2;
            const nextPos = buf.indexOf(boundaryBuf, partStart);
            if (nextPos === -1) break;
            const part = buf.subarray(partStart, nextPos - 2);
            const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
            if (headerEnd !== -1) {
              const headerStr = part.subarray(0, headerEnd).toString("latin1");
              const fnMatch = headerStr.match(/filename="([^"]*)"/);
              const nameMatch = headerStr.match(/name="([^"]*)"/);
              if (fnMatch && nameMatch) {
                filename = fnMatch[1];
                fileContent = part.subarray(headerEnd + 4);
                break;
              }
            }
            searchStart = nextPos;
          }
          if (!filename || !fileContent) { sendJson(response, 400, { error: "未找到文件" }); return; }
          const uploadDir = getUploadDir();
          mkdirSync(uploadDir, { recursive: true });
          const safeName = `${Date.now()}_${filename.replace(/[^\w.-]/g, "_")}`;
          const filePath = path.join(uploadDir, safeName);
          writeFileSync(filePath, fileContent);
          sendJson(response, 200, { url: `/data/remix-videos/${safeName}`, filename: safeName });
          return;
        }

        // ---- Remix: 模板变量文件上传 ----
        if (request.method === "POST" && pathname === "/api/remix/creators/_template/upload") {
          const contentType = request.headers["content-type"] || "";
          const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
          if (!boundaryMatch) { sendJson(response, 400, { error: "无效的上传请求" }); return; }
          const boundaryBuf = Buffer.from("--" + boundaryMatch[1]);
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const SEP = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]);
          let filename = null;
          let fileContent = null;
          let searchStart = 0;
          while (true) {
            const pos = buf.indexOf(boundaryBuf, searchStart);
            if (pos === -1) break;
            const afterBoundary = pos + boundaryBuf.length;
            if (buf[afterBoundary] === 0x2d && buf[afterBoundary + 1] === 0x2d) break;
            const partStart = afterBoundary + 2;
            const nextPos = buf.indexOf(boundaryBuf, partStart);
            if (nextPos === -1) break;
            const part = buf.subarray(partStart, nextPos - 2);
            const headerEnd = part.indexOf(SEP);
            if (headerEnd !== -1) {
              const headerStr = part.subarray(0, headerEnd).toString("latin1");
              const fnMatch = headerStr.match(/filename="([^"]*)"/);
              if (fnMatch) {
                filename = fnMatch[1];
                fileContent = part.subarray(headerEnd + 4);
                break;
              }
            }
            searchStart = nextPos;
          }
          if (!filename || !fileContent) { sendJson(response, 400, { error: "未找到文件" }); return; }
          const uploadDir = getUploadDir();
          mkdirSync(uploadDir, { recursive: true });
          const safeName = `${Date.now()}_${filename.replace(/[^\w.-]/g, "_")}`;
          const filePath = path.join(uploadDir, safeName);
          writeFileSync(filePath, fileContent);
          sendJson(response, 200, { url: `/data/remix-videos/${safeName}`, filename: safeName });
          return;
        }

        // ---- Remix: AI 自动视频混剪任务 ----
        if (request.method === "POST" && pathname === "/api/remix/ai-remix-task") {
          const body = await readJson(request);
          const { matrixIds, creatorId, videoIds, cdpInstanceId, ratio, presetId } = body;
          // 从方案获取提示词
          let prompt = body.prompt;
          if (!prompt && presetId) {
            const preset = store.getAiRemixPreset(presetId);
            if (preset) prompt = preset.prompt;
          }
          // 参考社媒账号语言：在提示词顶部注入语言
          if (presetId) {
            const preset = store.getAiRemixPreset(presetId);
            if (preset?.refLang && matrixIds?.length) {
              const accounts = [];
              for (const mid of matrixIds) {
                const accs = store.listMatrixAccounts(mid);
                accounts.push(...accs);
              }
              const languages = [...new Set(accounts.map(a => a.language).filter(Boolean))];
              if (languages.length === 1) {
                prompt = `文案语言为〖${languages[0]}〗\n\n${prompt}`;
              } else if (languages.length > 1) {
                prompt = `文案语言为〖${languages.join("、")}〗\n\n${prompt}`;
              }
            }
          }
          if (!matrixIds?.length) { sendJson(response, 400, { error: "请选择至少一个社媒矩阵" }); return; }
          if (!creatorId) { sendJson(response, 400, { error: "请选择达人" }); return; }
          if (!videoIds?.length) { sendJson(response, 400, { error: "请选择至少一个视频" }); return; }
          if (!cdpInstanceId) { sendJson(response, 400, { error: "请选择 CDP 实例" }); return; }

          // 获取 CDP 实例
          const inst = store.getChromeInstance(cdpInstanceId);
          if (!inst) { sendJson(response, 404, { error: "CDP 实例不存在" }); return; }
          const daemonUrl = inst.ngrokUrl || `http://${inst.cdpHost}:${inst.daemonPort}`;

          // 从方案中获取绑定的变量文件
          const presetFiles = presetId ? store.getPresetFiles(presetId) : [];

          // 获取达人资源
          const resources = store.listRemixResources(creatorId);
          const intros = resources.filter((r) => r.type === "intro");
          const outros = resources.filter((r) => r.type === "outro");
          const musics = resources.filter((r) => r.type === "music");

          // 获取视频信息
          const videos = store.listRemixVideos(creatorId);
          const selectedVideos = videoIds.map((vid) => videos.find((v) => v.id === vid)).filter(Boolean);
          if (!selectedVideos.length) { sendJson(response, 400, { error: "未找到选中的视频" }); return; }

          const resolveLocal = (url) => {
            if (url.startsWith("/data/remix-videos/")) {
              return path.join(getUploadDir(), path.basename(url));
            }
            if (url.startsWith("/data/remix-output/")) {
              return path.join(getOutputDir(), path.basename(url));
            }
            if (url.startsWith("/data/remix-resources/")) {
              return path.resolve(THIS_DIR, "..", url.replace(/^\//, ""));
            }
            return url;
          };
          const resolveResource = (fp) => {
            if (!fp) return null;
            return path.resolve(THIS_DIR, "..", fp.replace(/^\//, ""));
          };

          // 为每个视频创建 remix task（快速创建，预压缩和穿搭取图交给队列异步处理）
          const tasks = [];
          for (const video of selectedVideos) {
            const title = `AI混剪 · ${video.title || "未命名"} → ${matrixIds.length}个矩阵`;
            const task = store.createRemixTask({
              title, mode: "ai-remix", videoUrls: [video.url],
              sourceVideos: [{ url: video.url, title: video.title, creatorName: store.getRemixCreator(creatorId)?.name || "" }],
              ratio: ratio || "9:16",
              creatorId, matrixIds, presetId, prompt,
              cdpInstanceId,
            });
            // 记录资源类型到任务
            if (presetId) {
              const preset = store.getAiRemixPreset(presetId);
              if (preset?.resourceTypes) {
                store.updateRemixTask(task.id, { resourceTypes: preset.resourceTypes });
              }
            }

            const mainVideoLocalPath = resolveLocal(video.url);

            // 提交到 AI 混剪队列（异步处理，预压缩和穿搭取图在队列中做）
            aiRemixQueue.push({
              taskId: task.id, daemonUrl, filesToUpload: [mainVideoLocalPath], prompt: prompt || "",
              matrixIds, creatorId, sourceVideoId: video.id, videoTitle: video.title,
              presetId: presetId || null,
              mainVideoLocalPath,
            });
            processAiRemixQueue();

            tasks.push(task);
          }

          sendJson(response, 200, { tasks, count: tasks.length });
          return;
        }

        // ---- Remix: 新混剪任务（社媒矩阵 + 达人资源） ----
        if (request.method === "POST" && pathname === "/api/remix/matrix-task") {
          const body = await readJson(request);
          const { matrixIds, creatorId, videoIds, ratio, preset, introId, outroId, musicId, introEnabled = true, outroEnabled = true, musicEnabled = true, introVolume = 100, outroVolume = 100, musicVolume = 8, musicScope = "full", musicLoop = true, dedup = true } = body;
          if (!matrixIds?.length) { sendJson(response, 400, { error: "请选择至少一个社媒矩阵" }); return; }
          if (!creatorId) { sendJson(response, 400, { error: "请选择达人" }); return; }
          if (!videoIds?.length) { sendJson(response, 400, { error: "请选择至少一个视频" }); return; }

          // 获取达人资源
          const resources = store.listRemixResources(creatorId);
          const intros = resources.filter((r) => r.type === "intro");
          const outros = resources.filter((r) => r.type === "outro");
          const musics = resources.filter((r) => r.type === "music");

          // 获取视频信息
          const videos = store.listRemixVideos(creatorId);
          const selectedVideos = videoIds.map((vid) => videos.find((v) => v.id === vid)).filter(Boolean);
          if (!selectedVideos.length) { sendJson(response, 400, { error: "未找到选中的视频" }); return; }

          // 为每个视频创建任务
          const tasks = [];
          for (const video of selectedVideos) {
            const title = `混剪 · ${video.title || "未命名"} → ${matrixIds.length}个矩阵`;
            const task = store.createRemixTask({
              title, mode: "matrix-remix", videoUrls: [video.url],
              sourceVideos: [{ url: video.url, title: video.title, creatorName: store.getRemixCreator(creatorId)?.name || "" }],
              ratio: ratio || "9:16",
              creatorId, matrixIds,
              introEnabled, outroEnabled, musicEnabled,
              introId: introId || null, outroId: outroId || null, musicId: musicId || null,
            });
            // 解析本地文件路径
            const resolveLocal = (url) => {
              if (url.startsWith("/data/remix-videos/")) {
                return path.join(getUploadDir(), path.basename(url));
              }
              if (url.startsWith("/data/remix-output/")) {
                return path.join(getOutputDir(), path.basename(url));
              }
              return url;
            };
            const resolveResource = (fp) => {
              if (!fp) return null;
              return path.resolve(THIS_DIR, "..", fp.replace(/^\//, ""));
            };

            // 选取资源：用户指定 > 随机，开关关闭则为 null
            const pickResource = (list, selectedId, enabled) => {
              if (!enabled || selectedId === "none") return null;
              if (selectedId && list.length) {
                const found = list.find(r => r.id === selectedId);
                if (found) return resolveResource(found.filePath);
              }
              return list.length ? resolveResource(list[Math.floor(Math.random() * list.length)].filePath) : null;
            };
            const introPath = pickResource(intros, introId, introEnabled);
            const outroPath = pickResource(outros, outroId, outroEnabled);
            const musicPath = pickResource(musics, musicId, musicEnabled);

            remixQueue.push({
              taskId: task.id, localPaths: [resolveLocal(video.url)], mode: "matrix-remix",
              ratio: ratio || "9:16", preset: preset || "medium",
              matrixIds, creatorId, sourceVideoId: video.id, videoTitle: video.title,
              introPath, outroPath, musicPath, introVolume, outroVolume, musicVolume, musicScope, musicLoop, dedup,
            });
            tasks.push(task);
          }

          processRemixQueue();
          sendJson(response, 200, { tasks, count: tasks.length });
          return;
        }

        // ---- Remix: 达人资源管理 ----
        const remixResourcesMatch = pathname.match(/^\/api\/remix\/creators\/([^/]+)\/resources$/);
        if (remixResourcesMatch) {
          const creatorId = decodeURIComponent(remixResourcesMatch[1]);

          if (request.method === "GET") {
            const type = url.searchParams.get("type") || null;
            sendJson(response, 200, store.listRemixResources(creatorId, type));
            return;
          }

          if (request.method === "POST") {
            const contentType = request.headers["content-type"] || "";
            const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
            if (!boundaryMatch) { sendJson(response, 400, { error: "无效的上传请求" }); return; }
            const boundaryBuf = Buffer.from("--" + boundaryMatch[1]);
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const buf = Buffer.concat(chunks);

            const fields = {};
            let fileContent = null;
            let filename = null;
            let searchStart = 0;
            while (true) {
              const pos = buf.indexOf(boundaryBuf, searchStart);
              if (pos === -1) break;
              const afterBoundary = pos + boundaryBuf.length;
              if (buf[afterBoundary] === 0x2d && buf[afterBoundary + 1] === 0x2d) break;
              const partStart = afterBoundary + 2;
              const nextPos = buf.indexOf(boundaryBuf, partStart);
              if (nextPos === -1) break;
              const part = buf.subarray(partStart, nextPos - 2);
              const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
              if (headerEnd !== -1) {
                const headerStr = part.subarray(0, headerEnd).toString("latin1");
                const nameMatch = headerStr.match(/name="([^"]*)"/);
                const fnMatch = headerStr.match(/filename="([^"]*)"/);
                if (nameMatch) {
                  if (fnMatch) {
                    filename = fnMatch[1];
                    fileContent = part.subarray(headerEnd + 4);
                  } else {
                    fields[nameMatch[1]] = part.subarray(headerEnd + 4).toString("utf8");
                  }
                }
              }
              searchStart = nextPos;
            }

            const type = fields.type;
            if (!["intro", "outro", "music"].includes(type)) {
              sendJson(response, 400, { error: "资源类型无效，应为 intro / outro / music" });
              return;
            }
            if (!filename || !fileContent) { sendJson(response, 400, { error: "未找到文件" }); return; }

            const resourceDir = path.resolve(THIS_DIR, "..", "data", "remix-resources", type);
            mkdirSync(resourceDir, { recursive: true });
            const safeName = `${Date.now()}_${filename.replace(/[^\w.-]/g, "_")}`;
            const filePath = path.join(resourceDir, safeName);
            writeFileSync(filePath, fileContent);

            let duration = null;
            if (type === "intro" || type === "outro") {
              const meta = await probeVideo(filePath).catch(() => null);
              duration = meta?.duration ?? null;
            }

            const resource = store.createRemixResource({
              creatorId,
              type,
              filePath: `/data/remix-resources/${type}/${safeName}`,
              filename: safeName,
              fileSize: fileContent.length,
              duration,
            });
            sendJson(response, 200, resource);
            return;
          }
        }

        const remixResourceDeleteMatch = pathname.match(/^\/api\/remix\/creators\/([^/]+)\/resources\/([^/]+)$/);
        if (request.method === "DELETE" && remixResourceDeleteMatch) {
          const resourceId = decodeURIComponent(remixResourceDeleteMatch[2]);
          const resource = store.deleteRemixResource(resourceId);
          if (resource?.filePath) {
            const absPath = path.resolve(THIS_DIR, "..", resource.filePath.replace(/^\//, ""));
            try { await unlink(absPath); } catch {}
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        // ---- Remix: 任务管理 ----
        if (request.method === "GET" && pathname === "/api/remix/tasks") {
          sendJson(response, 200, store.listRemixTasks());
          return;
        }
        if (request.method === "POST" && pathname === "/api/remix/tasks") {
          const body = await readJson(request);
          const { videoUrls, sourceVideos, title, ratio, mode, preset } = body;
          if (!videoUrls || !videoUrls.length) { sendJson(response, 400, { error: "缺少视频" }); return; }

          const resolveLocal = (url) => {
            if (url.startsWith("/data/remix-videos/")) {
              return path.join(getUploadDir(), path.basename(url));
            }
            if (url.startsWith("/data/remix-output/")) {
              return path.join(getOutputDir(), path.basename(url));
            }
            return url;
          };
          const localPaths = videoUrls.map(resolveLocal);

          const task = store.createRemixTask({ title: title || "未命名任务", mode: mode || "dedup", videoUrls, sourceVideos, ratio: ratio || "9:16" });
          sendJson(response, 200, task);
          remixQueue.push({ taskId: task.id, localPaths, mode: mode || "dedup", ratio: ratio || "9:16", preset: preset || "medium" });
          processRemixQueue();
          return;
        }
        const remixTaskMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)$/);
        if (remixTaskMatch) {
          const taskId = decodeURIComponent(remixTaskMatch[1]);
          if (request.method === "PATCH") {
            const body = await readJson(request);
            const updated = store.updateRemixTask(taskId, {
              status: body.status || null,
              outputUrl: body.outputUrl || null,
              errorMessage: body.errorMessage || null,
              completedAt: body.status === "DONE" ? nowIso() : null,
            });
            sendJson(response, 200, updated);
            return;
          }
          if (request.method === "DELETE") {
            const task = store.getRemixTask(taskId);
            // 删除输出视频文件
            if (task?.outputUrl) {
              try {
                const fp = task.outputUrl.startsWith("/data/remix-output/")
                  ? path.join(getOutputDir(), task.outputUrl.replace("/data/remix-output/", ""))
                  : task.outputUrl;
                if (existsSync(fp)) unlink(fp);
              } catch {}
            }
            // 删除任务专属目录（图片等资源）
            if (task?.seqNum) {
              try {
                const taskDir = path.join(getOutputDir(), "tasks", String(task.seqNum));
                if (existsSync(taskDir)) {
                  const { rmSync } = await import("node:fs");
                  rmSync(taskDir, { recursive: true, force: true });
                }
              } catch {}
            }
            // 删除任务资源记录
            try { store.deleteTaskResources(taskId); } catch {}
            store.deleteRemixTask(taskId);
            sendJson(response, 200, { ok: true });
            return;
          }
        }

        // 批量删除任务
        if (request.method === "POST" && pathname === "/api/remix/tasks/batch-delete") {
          const body = await readJson(request);
          const taskIds = body.taskIds || [];
          for (const taskId of taskIds) {
            const task = store.getRemixTask(taskId);
            if (task?.outputUrl) {
              try {
                const fp = task.outputUrl.startsWith("/data/remix-output/")
                  ? path.join(getOutputDir(), task.outputUrl.replace("/data/remix-output/", ""))
                  : task.outputUrl;
                if (existsSync(fp)) unlink(fp);
              } catch {}
            }
            if (task?.seqNum) {
              try {
                const taskDir = path.join(getOutputDir(), "tasks", String(task.seqNum));
                if (existsSync(taskDir)) {
                  const { rmSync } = await import("node:fs");
                  rmSync(taskDir, { recursive: true, force: true });
                }
              } catch {}
            }
            try { store.deleteTaskResources(taskId); } catch {}
            store.deleteRemixTask(taskId);
          }
          sendJson(response, 200, { ok: true, deleted: taskIds.length });
          return;
        }

        // 穿搭图库索引
        if (request.method === "POST" && pathname === "/api/outfit-library/index") {
          const OUTFIT_DIR = path.resolve(THIS_DIR, "..", "data", "luxury-image-library", "images");
          if (!existsSync(OUTFIT_DIR)) { sendJson(response, 404, { error: "穿搭图库目录不存在" }); return; }
          store.clearOutfitLibrary();
          const { readdirSync: rdSync } = await import("node:fs");
          // 品牌目录
          const brands = rdSync(OUTFIT_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("_")).map(d => d.name);
          // 全局分类目录 _Scene 和 _Accessories
          const globalCats = ["_Scene", "_Accessories"];
          // 服装类别映射
          const clothingCats = ["Top", "Bottom", "Outerwear", "Dress", "Knitwear", "Denim", "Pants", "Shorts", "Skirt"];
          // 配饰类别
          const accessoryCats = ["Eyewear"];
          let count = 0;
          for (const brand of brands) {
            const brandDir = path.join(OUTFIT_DIR, brand);
            const cats = rdSync(brandDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            for (const cat of cats) {
              const catDir = path.join(brandDir, cat);
              const files = rdSync(catDir).filter(f => /\.(jpg|jpeg|png|webp|avif)$/i.test(f));
              for (const file of files) {
                const filePath = `/data/luxury-image-library/images/${brand}/${cat}/${file}`;
                // 统一分类
                let unifiedCat;
                if (cat === "Shoes") unifiedCat = "shoes";
                else if (accessoryCats.includes(cat)) unifiedCat = "accessories";
                else if (clothingCats.includes(cat)) unifiedCat = "clothing";
                else unifiedCat = cat.toLowerCase();
                store.indexOutfitLibrary(brand, unifiedCat, filePath, file);
                count++;
              }
            }
          }
          // 索引全局分类目录
          for (const gcat of globalCats) {
            const gdir = path.join(OUTFIT_DIR, gcat);
            if (existsSync(gdir)) {
              const files = rdSync(gdir).filter(f => /\.(jpg|jpeg|png|webp|avif)$/i.test(f));
              const unifiedCat = gcat === "_Scene" ? "scene" : "accessories";
              for (const file of files) {
                const filePath = `/data/luxury-image-library/images/${gcat}/${file}`;
                store.indexOutfitLibrary(gcat, unifiedCat, filePath, file);
                count++;
              }
            }
          }
          sendJson(response, 200, { ok: true, indexed: count });
          return;
        }
        // 查询穿搭图库
        if (request.method === "GET" && pathname === "/api/outfit-library/stats") {
          const stats = {};
          for (const cat of ["shoes", "clothing", "scene", "accessories"]) {
            stats[cat] = store.db.prepare("SELECT COUNT(*) as c FROM outfit_library WHERE category = ?").get(cat).c;
          }
          stats.total = store.countOutfitLibrary();
          sendJson(response, 200, stats);
          return;
        }

        // 重新剪辑
        const remixRecomposeMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/recompose$/);
        if (request.method === "POST" && remixRecomposeMatch) {
          const taskId = decodeURIComponent(remixRecomposeMatch[1]);
          const origTask = store.getRemixTask(taskId);
          if (!origTask) { sendJson(response, 404, { error: "任务不存在" }); return; }

          // 检查是否有分段脚本资源
          const segmentResources = store.listTaskResources(taskId);
          const scriptResource = segmentResources.find(r => r.type === "segment_script");

          if (scriptResource) {
            // 分段脚本模式：重新做去重+分段打乱+拼接
            const resolveLocal = (url) => {
              if (url.startsWith("/data/remix-videos/")) return path.join(getUploadDir(), path.basename(url));
              if (url.startsWith("/data/remix-output/")) return path.join(getOutputDir(), path.basename(url));
              return url;
            };
            const mainVideoLocalPath = resolveLocal(origTask.videoUrls[0]);
            if (!mainVideoLocalPath || !existsSync(mainVideoLocalPath)) {
              sendJson(response, 400, { error: "原视频文件不存在" }); return;
            }

            store.updateRemixTask(taskId, { status: "PROCESSING", errorMessage: null, completedAt: null });
            store.logCdpEvent(null, "info", `重新去重(分段脚本模式)`, null, taskId);
            composeAiRemixVideoAsync(taskId, mainVideoLocalPath, [], origTask.presetId, origTask.matrixIds, origTask.creatorId, null, origTask.videoUrls[0]?.replace(/^.*\//, '').replace(/\.mp4$/, '') || origTask.title, origTask.outputUrl);
            sendJson(response, 200, { ok: true, message: "重新去重已开始（分段脚本模式）" });
            return;
          }

          // 图片模式重新剪辑（原有逻辑）
          // 从任务专属目录读取图片
          const taskSeq = origTask.seqNum || taskId.replace(/[^0-9]/g, "").slice(-6) || taskId;
          const taskDir = path.join(getOutputDir(), "tasks", String(taskSeq));
          if (!existsSync(taskDir)) { sendJson(response, 400, { error: "任务目录不存在" }); return; }

          // 读取目录中的图片（按序号排序），也支持自定义顺序
          const orderFile = path.join(taskDir, "order.json");
          let imageUrls = origTask.imagePaths || [];
          // 如果有自定义顺序文件，用它
          if (existsSync(orderFile)) {
            try {
              const order = JSON.parse(readFileSync(orderFile, "utf-8"));
              if (Array.isArray(order) && order.length) imageUrls = order;
            } catch {}
          }

          // 转为本地路径
          const imagePaths = imageUrls.map(url => {
            if (url.startsWith("/data/remix-output/tasks/")) {
              return path.join(getOutputDir(), "tasks", url.replace("/data/remix-output/tasks/", ""));
            }
            if (url.startsWith("/data/remix-output/")) {
              return path.join(getOutputDir(), path.basename(url));
            }
            return url;
          }).filter(p => existsSync(p));

          if (!imagePaths.length) { sendJson(response, 400, { error: "没有可用的图片" }); return; }

          // 获取原视频路径
          const resolveLocal = (url) => {
            if (url.startsWith("/data/remix-videos/")) return path.join(getUploadDir(), path.basename(url));
            if (url.startsWith("/data/remix-output/")) return path.join(getOutputDir(), path.basename(url));
            return url;
          };
          const mainVideoLocalPath = resolveLocal(origTask.videoUrls[0]);
          if (!mainVideoLocalPath || !existsSync(mainVideoLocalPath)) {
            sendJson(response, 400, { error: "原视频文件不存在" }); return;
          }

          // 异步重新拼接
          store.updateRemixTask(taskId, { status: "PROCESSING", errorMessage: null });
          store.logCdpEvent(null, "info", `重新剪辑: ${imagePaths.length}张图片`, null, taskId);
          composeAiRemixVideoAsync(taskId, mainVideoLocalPath, imagePaths, origTask.presetId, origTask.matrixIds, origTask.creatorId, null, origTask.title, origTask.outputUrl);

          sendJson(response, 200, { ok: true, message: "重新剪辑已开始" });
          return;
        }

        // 保存图片顺序
        const remixSaveOrderMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/image-order$/);
        if (request.method === "POST" && remixSaveOrderMatch) {
          const taskId = decodeURIComponent(remixSaveOrderMatch[1]);
          const body = await readJson(request);
          const task = store.getRemixTask(taskId);
          if (!task) { sendJson(response, 404, { error: "任务不存在" }); return; }
          const taskSeq = task.seqNum || taskId.replace(/[^0-9]/g, "").slice(-6) || taskId;
          const taskDir = path.join(getOutputDir(), "tasks", String(taskSeq));
          const orderFile = path.join(taskDir, "order.json");
          writeFileSync(orderFile, JSON.stringify(body.order || []));
          // 也更新数据库
          store.updateRemixTask(taskId, { imagePaths: body.order || [] });
          sendJson(response, 200, { ok: true });
          return;
        }

        // 上传图片到任务目录
        const remixAddImageMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/add-image$/);
        if (request.method === "POST" && remixAddImageMatch) {
          const taskId = decodeURIComponent(remixAddImageMatch[1]);
          const task = store.getRemixTask(taskId);
          if (!task) { sendJson(response, 404, { error: "任务不存在" }); return; }
          const taskSeq = task.seqNum || taskId.replace(/[^0-9]/g, "").slice(-6) || taskId;
          const taskDir = path.join(getOutputDir(), "tasks", String(taskSeq));
          if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });

          // 找最大编号
          const existing = readdirSync(taskDir).filter(f => /^(\d+)\.png$/.test(f)).map(f => parseInt(f)).sort((a,b)=>a-b);
          const nextNum = existing.length ? existing[existing.length-1] + 1 : 1;
          const imgPath = path.join(taskDir, `${nextNum}.png`);
          // 读取 raw body
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);
          writeFileSync(imgPath, buffer);
          const imgUrl = `/data/remix-output/tasks/${taskSeq}/${nextNum}.png`;
          // 更新数据库 imagePaths
          const currentPaths = task.imagePaths || [];
          if (!currentPaths.includes(imgUrl)) {
            currentPaths.push(imgUrl);
            store.updateRemixTask(taskId, { imagePaths: currentPaths });
          }
          sendJson(response, 200, { url: imgUrl, filename: `${nextNum}.png` });
          return;
        }

        // 查询任务资源
        const taskResourcesMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/resources$/);
        if (request.method === "GET" && taskResourcesMatch) {
          const tid = decodeURIComponent(taskResourcesMatch[1]);
          const resources = store.listTaskResources(tid);
          // 也返回图片路径（兼容旧的imagePaths）
          const task = store.getRemixTask(tid);
          const imagePaths = task?.imagePaths || [];
          sendJson(response, 200, { resources, imagePaths });
          return;
        }

        // TikTok 内容
        const tkMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/tiktok-content$/);
        if (request.method === "GET" && tkMatch) {
          const tid = decodeURIComponent(tkMatch[1]);
          try {
            const { DatabaseSync } = await import("node:sqlite");
            const dbPath = path.join(path.dirname(THIS_DIR), "data", "reddit-flow.db");
            const db = new DatabaseSync(dbPath);
            const row = db.prepare("SELECT tiktok_content_json FROM remix_tasks WHERE id = ?").get(tid);
            db.close();
            if (row?.tiktok_content_json) {
              sendJson(response, 200, JSON.parse(row.tiktok_content_json));
            } else {
              sendJson(response, 200, {});
            }
          } catch (e) {
            sendJson(response, 200, {});
          }
          return;
        }

        // 中止任务
        const remixAbortMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/abort$/);
        if (request.method === "POST" && remixAbortMatch) {
          const taskId = decodeURIComponent(remixAbortMatch[1]);
          store.updateRemixTask(taskId, { status: "FAILED", errorMessage: "用户手动中止", completedAt: nowIso() });
          store.logCdpEvent(null, "warning", "任务被用户中止", null, taskId);
          // 从队列中移除
          const aiIdx = aiRemixQueue.findIndex(q => q.taskId === taskId);
          if (aiIdx !== -1) aiRemixQueue.splice(aiIdx, 1);
          const remixIdx = remixQueue.findIndex(q => q.taskId === taskId);
          if (remixIdx !== -1) remixQueue.splice(remixIdx, 1);
          // 通知 daemon 中止
          const daemonInfo = activeDaemonTasks.get(taskId);
          if (daemonInfo) {
            try {
              await fetch(`${daemonInfo.daemonUrl}/api/tasks/${daemonInfo.daemonTaskNo}/abort`, { method: "POST" });
              store.logCdpEvent(null, "info", "已通知 daemon 中止任务", null, taskId);
            } catch (e) { console.error("[中止] 通知 daemon 失败:", e.message); }
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        // 重试任务
        const remixRetryMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/retry$/);
        if (request.method === "POST" && remixRetryMatch) {
          const taskId = decodeURIComponent(remixRetryMatch[1]);
          const origTask = store.getRemixTask(taskId);
          if (!origTask) { sendJson(response, 404, { error: "任务不存在" }); return; }

            // 用原任务的参数创建新任务
            // AI 混剪重试：从方案重新读取最新prompt
            let retryPrompt = origTask.prompt;
            if (origTask.presetId) {
              const latestPreset = store.getAiRemixPreset(origTask.presetId);
              if (latestPreset) retryPrompt = latestPreset.prompt;
            }

            const newTask = store.createRemixTask({
              title: origTask.title + " (重试)",
              mode: origTask.mode,
              videoUrls: origTask.videoUrls,
              sourceVideos: origTask.sourceVideos,
              ratio: origTask.ratio,
              creatorId: origTask.creatorId,
              matrixIds: origTask.matrixIds,
              presetId: origTask.presetId,
              prompt: retryPrompt,
              introEnabled: origTask.introEnabled,
              outroEnabled: origTask.outroEnabled,
              musicEnabled: origTask.musicEnabled,
              introId: origTask.introId,
              outroId: origTask.outroId,
              musicId: origTask.musicId,
              cdpInstanceId: origTask.cdpInstanceId,
            });

            if (origTask.mode === "ai-remix") {
              // AI 混剪重试
              const inst = origTask.cdpInstanceId ? store.getChromeInstance(origTask.cdpInstanceId) : null;
              const daemonUrl = inst ? (inst.ngrokUrl || `http://${inst.cdpHost}:${inst.daemonPort}`) : null;
              if (!daemonUrl) { sendJson(response, 400, { error: "CDP 实例不存在" }); return; }

              const resolveRetryLocal = (url) => {
                if (url.startsWith("/data/remix-videos/")) return path.join(getUploadDir(), path.basename(url));
                if (url.startsWith("/data/remix-output/")) return path.join(getOutputDir(), path.basename(url));
                return url;
              };
              let retryVideoPath = resolveRetryLocal(origTask.videoUrls[0]);
              // 重试也预检压缩
              try {
                const { statSync } = await import('fs');
                const fileSize = statSync(retryVideoPath).size;
                if (fileSize > 20 * 1024 * 1024) {
                  store.logCdpEvent(null, "info", `重试: 原视频 ${Math.round(fileSize / 1024 / 1024)}MB 超过20MB，预压缩...`, null, newTask.id);
                  const { execFileSync } = await import('child_process');
                  const { renameSync, unlinkSync } = await import('fs');
                  const compressedPath = path.join(path.dirname(getOutputDir()), 'remix-tmp', `precompressed_${Date.now()}.mp4`);
                  const compress = (input, output, crf, scale) => {
                    execFileSync('ffmpeg', ['-err_detect', 'ignore_err', '-y', '-i', input, '-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast', '-vf', `scale=${scale}`, '-c:a', 'copy', '-movflags', '+faststart', output], { stdio: 'pipe', timeout: 300000 });
                  };
                  const steps = [
                    { crf: 32, scale: '-2:720' },
                    { crf: 35, scale: '-2:540' },
                    { crf: 38, scale: '-2:480' },
                    { crf: 40, scale: '-2:360' },
                  ];
                  let currentInput = retryVideoPath;
                  let currentSize = fileSize;
                  let stepIdx = 0;
                  while (currentSize > 20 * 1024 * 1024 && stepIdx < steps.length) {
                    const step = steps[stepIdx];
                    const outputPath = stepIdx === 0 ? compressedPath : compressedPath.replace('.mp4', `_${stepIdx + 1}.mp4`);
                    store.logCdpEvent(null, "info", `重试: 压缩第${stepIdx + 1}轮: CRF=${step.crf}, 分辨率=${step.scale}`, null, newTask.id);
                    compress(currentInput, outputPath, step.crf, step.scale);
                    if (stepIdx > 0) {
                      try { unlinkSync(currentInput); } catch {}
                      if (outputPath !== compressedPath) {
                        try { unlinkSync(compressedPath); } catch {}
                        renameSync(outputPath, compressedPath);
                      }
                    }
                    currentInput = compressedPath;
                    currentSize = statSync(compressedPath).size;
                    stepIdx++;
                  }
                  store.logCdpEvent(null, "info", `重试: 预压缩完成 ${Math.round(currentSize / 1024 / 1024)}MB (${stepIdx}轮)`, null, newTask.id);
                  retryVideoPath = compressedPath;
                }
              } catch (e) { store.logCdpEvent(null, "warning", `重试: 预压缩失败: ${e.message}`, null, newTask.id); }
              const filesToUpload = [retryVideoPath];

              // 记录资源类型到任务
              if (origTask.presetId) {
                const preset = store.getAiRemixPreset(origTask.presetId);
                if (preset?.resourceTypes) {
                  store.updateRemixTask(newTask.id, { resourceTypes: preset.resourceTypes });
                }
                // 穿搭指南：根据来源选择本地或远程取图
                if (preset?.outfitGuide) {
                  if (preset.outfitSource === "remote") {
                    try {
                      const pickUrl = preset.outfitPickUrl || "http://localhost:12999/api/image-washing/queue/pick";
                      const pickIndices = preset.outfitPickIndex || [1];
                      const pickRes = await fetch(pickUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indices: pickIndices }) });
                      if (pickRes.ok) {
                        const pickData = await pickRes.json();
                        if (pickData.productId && pickData.images?.length) {
                          // 保存 taskId 到任务记录
                          const outfitTaskIds = pickData.images.map(img => img.taskId);
                          store.updateRemixTask(newTask.id, { outfitTaskIds });
                          for (const img of pickData.images) {
                            try {
                              if (!img.url) { store.logCdpEvent(null, "warning", `穿搭指南[远程]: taskId=${img.taskId} 无URL，跳过`, null, newTask.id); continue; }
                              const imgRes = await fetch(img.url);
                              if (imgRes.ok) {
                                const buffer = Buffer.from(await imgRes.arrayBuffer());
                                const outfitFileName = `outfit_remote_${img.taskId}_${Date.now()}.jpg`;
                                const outfitPath = path.join(getOutputDir(), outfitFileName);
                                writeFileSync(outfitPath, buffer);
                                filesToUpload.push(outfitPath);
                                store.logCdpEvent(null, "info", `穿搭指南[远程]: taskId=${img.taskId} index=${img.index}`, null, newTask.id);
                              } else {
                                store.logCdpEvent(null, "warning", `穿搭指南[远程]下载失败: taskId=${img.taskId} status=${imgRes.status}`, null, newTask.id);
                              }
                            } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]下载失败: ${e.message}`, null, newTask.id); }
                          }
                        } else { store.logCdpEvent(null, "info", "穿搭指南[远程]: 无可用产品", null, newTask.id); }
                      } else { store.logCdpEvent(null, "warning", `穿搭指南[远程]取图失败: ${pickRes.status}`, null, newTask.id); }
                    } catch (e) { store.logCdpEvent(null, "warning", `穿搭指南[远程]取图异常: ${e.message}`, null, newTask.id); }
                  } else {
                    const outfitCats = ["shoes", "clothing", "scene"];
                    for (const cat of outfitCats) {
                      const outfit = store.randomOutfitByCategory(cat);
                      if (outfit) {
                        const outfitLocalPath = path.resolve(THIS_DIR, "..", outfit.file_path.replace(/^\//, ""));
                        if (existsSync(outfitLocalPath)) {
                          filesToUpload.push(outfitLocalPath);
                          store.logCdpEvent(null, "info", `穿搭指南[${cat}]: ${outfit.brand} ${outfit.filename}`, null, newTask.id);
                        }
                      } else {
                        store.logCdpEvent(null, "info", `穿搭指南[${cat}]: 无可用图片，跳过`, null, newTask.id);
                      }
                    }
                  }
                }
              }

              aiRemixQueue.push({
                taskId: newTask.id, daemonUrl, filesToUpload,
                prompt: retryPrompt || origTask.prompt || "",
                matrixIds: origTask.matrixIds || [],
                creatorId: origTask.creatorId,
                sourceVideoId: null,
                videoTitle: origTask.title,
                presetId: origTask.presetId,
                mainVideoLocalPath: filesToUpload[0],
              });
              processAiRemixQueue();
            } else {
              // 拼接混剪重试
              const resolveLocal = (url) => {
                if (url.startsWith("/data/remix-videos/")) return path.join(getUploadDir(), path.basename(url));
                if (url.startsWith("/data/remix-output/")) return path.join(getOutputDir(), path.basename(url));
                return url;
              };
              const localPaths = origTask.videoUrls.map(resolveLocal);

              // 重新选取资源
              const resources = origTask.creatorId ? store.listRemixResources(origTask.creatorId) : [];
              const intros = resources.filter(r => r.type === "intro");
              const outros = resources.filter(r => r.type === "outro");
              const musics = resources.filter(r => r.type === "music");
              const resolveResource = (fp) => fp ? path.resolve(THIS_DIR, "..", fp.replace(/^\//, "")) : null;
              const pickResource = (list, selectedId, enabled) => {
                if (!enabled || selectedId === "none") return null;
                if (selectedId && list.length) {
                  const found = list.find(r => r.id === selectedId);
                  if (found) return resolveResource(found.filePath);
                }
                return list.length ? resolveResource(list[Math.floor(Math.random() * list.length)].filePath) : null;
              };
              const introPath = pickResource(intros, origTask.introId, origTask.introEnabled);
              const outroPath = pickResource(outros, origTask.outroId, origTask.outroEnabled);
              const musicPath = pickResource(musics, origTask.musicId, origTask.musicEnabled);

              remixQueue.push({
                taskId: newTask.id, localPaths, mode: origTask.mode,
                ratio: origTask.ratio, preset: "medium",
                matrixIds: origTask.matrixIds || [],
                creatorId: origTask.creatorId,
                sourceVideoId: null,
                videoTitle: origTask.title,
                introPath, outroPath, musicPath,
              });
              processRemixQueue();
            }

            sendJson(response, 200, { ok: true, task: newTask });
            return;
          }

        const remixDownloadedMatch = pathname.match(/^\/api\/remix\/tasks\/([^/]+)\/downloaded$/);
        if (request.method === "POST" && remixDownloadedMatch) {
          const task = store.markRemixTaskDownloaded(decodeURIComponent(remixDownloadedMatch[1]));
          // 同步标记矩阵成品视频为已下载
          if (task?.outputUrl) {
            const matrixVideos = store.listAllMatrixVideos();
            for (const mv of matrixVideos) {
              if (mv.filePath === task.outputUrl) {
                store.markMatrixVideoDownloaded(mv.id);
              }
            }
          }
          sendJson(response, 200, task);
          return;
        }

        sendJson(response, 404, { error: "接口不存在" });
        return;
      }

      // ---- 社媒矩阵管理 ----
      if (pathname.startsWith("/api/matrices")) {
        // 矩阵列表
        if (request.method === "GET" && pathname === "/api/matrices") {
          sendJson(response, 200, store.listMatrices());
          return;
        }
        // 创建矩阵
        if (request.method === "POST" && pathname === "/api/matrices") {
          const body = await readJson(request);
          if (!body.name) { sendJson(response, 400, { error: "缺少矩阵名称" }); return; }
          sendJson(response, 200, store.createMatrix({ name: body.name, notes: body.notes || null }));
          return;
        }

        const matrixMatch = pathname.match(/^\/api\/matrices\/([^/]+)$/);
        if (matrixMatch) {
          const matrixId = decodeURIComponent(matrixMatch[1]);
          if (request.method === "DELETE") {
            store.deleteMatrix(matrixId);
            sendJson(response, 200, { ok: true });
            return;
          }
        }

        // 矩阵账号管理
        const matrixAccountsMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/accounts$/);
        if (matrixAccountsMatch) {
          const matrixId = decodeURIComponent(matrixAccountsMatch[1]);
          if (request.method === "GET") {
            sendJson(response, 200, store.listMatrixAccounts(matrixId));
            return;
          }
          if (request.method === "POST") {
            const body = await readJson(request);
            if (!body.platform || !body.accountName) { sendJson(response, 400, { error: "缺少平台或账号名称" }); return; }
            if (!["tiktok", "instagram", "youtube"].includes(body.platform)) {
              sendJson(response, 400, { error: "不支持的平台，仅支持 tiktok / instagram / youtube" });
              return;
            }
            try {
              const account = store.createMatrixAccount({ matrixId, platform: body.platform, accountName: body.accountName, language: body.language || null });
              sendJson(response, 200, account);
            } catch (e) {
              sendJson(response, 400, { error: e.message.includes("UNIQUE") ? "该矩阵中此平台已有账号" : e.message });
            }
            return;
          }
        }
        const matrixAccountMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/accounts\/([^/]+)$/);
        if (matrixAccountMatch) {
          const accountId = decodeURIComponent(matrixAccountMatch[2]);
          if (request.method === "DELETE") {
            store.deleteMatrixAccount(accountId);
            sendJson(response, 200, { ok: true });
            return;
          }
          if (request.method === "PUT") {
            const body = await readJson(request);
            const updated = store.updateMatrixAccount(accountId, {
              platform: body.platform,
              accountName: body.accountName,
              language: body.language || null,
            });
            sendJson(response, 200, updated);
            return;
          }
        }

        // 社媒账号绑定达人
        const accountCreatorsMatch = pathname.match(/^\/api\/matrices\/accounts\/([^/]+)\/creators$/);
        if (accountCreatorsMatch) {
          const accountId = decodeURIComponent(accountCreatorsMatch[1]);
          if (request.method === "GET") {
            sendJson(response, 200, store.getMatrixAccountCreators(accountId));
            return;
          }
          if (request.method === "POST") {
            const body = await readJson(request);
            store.bindMatrixAccountCreators(accountId, body.creatorIds || []);
            sendJson(response, 200, { ok: true });
            return;
          }
          if (request.method === "DELETE") {
            const body = await readJson(request);
            store.unbindMatrixAccountCreator(accountId, body.creatorId);
            sendJson(response, 200, { ok: true });
            return;
          }
        }

        // 矩阵-实例绑定管理
        const matrixProfilesMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/profiles$/);
        if (matrixProfilesMatch) {
          const matrixId = decodeURIComponent(matrixProfilesMatch[1]);
          if (request.method === "GET") {
            const bindings = store.getMatrixProfiles(matrixId);
            // 合并 BitBrowser profile 信息
            const profiles = await api.listProfiles().catch(() => []);
            const result = bindings.map((b) => {
              const profile = profiles.find((p) => p.id === b.profileId);
              return {
                ...b,
                profileName: profile?.name || null,
                profileSeq: profile?.seq || null,
                profileStatus: profile?.status || null,
                profileRunning: profile?.running || false,
              };
            });
            sendJson(response, 200, result);
            return;
          }
          if (request.method === "POST") {
            const body = await readJson(request);
            if (!body.profileId) { sendJson(response, 400, { error: "缺少 profileId" }); return; }
            const bindings = store.bindMatrixProfile({ matrixId, profileId: body.profileId });
            sendJson(response, 200, bindings);
            return;
          }
        }
        const matrixProfileDeleteMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/profiles\/([^/]+)$/);
        if (request.method === "DELETE" && matrixProfileDeleteMatch) {
          const matrixId = decodeURIComponent(matrixProfileDeleteMatch[1]);
          const profileId = decodeURIComponent(matrixProfileDeleteMatch[2]);
          const bindings = store.unbindMatrixProfile(matrixId, profileId);
          sendJson(response, 200, bindings);
          return;
        }

        // 矩阵成品视频库
        const matrixVideosMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/videos$/);
        if (matrixVideosMatch) {
          const matrixId = decodeURIComponent(matrixVideosMatch[1]);
          if (request.method === "GET") {
            const videos = store.listMatrixVideos(matrixId).map((v) => {
              const fp = normalizeRemixUrl(v.filePath);
              // 查找与该视频filePath匹配的任务
              const allTasks = store.listRemixTasks();
              const matchingTask = allTasks.find(t => t.outputUrl === fp);
              return {
                ...v,
                filePath: fp,
                imagePaths: matchingTask?.imagePaths || [],
                taskId: matchingTask?.id || null,
              };
            });
            sendJson(response, 200, videos);
            return;
          }
          if (request.method === "DELETE") {
            const body = await readJson(request);
            if (body.videoId) {
              const mv = store.getMatrixVideo(body.videoId);
              if (mv?.filePath) {
                // 删除视频文件
                try {
                  const fp = mv.filePath.startsWith("/data/remix-output/")
                    ? path.join(getOutputDir(), mv.filePath.replace("/data/remix-output/", ""))
                    : mv.filePath;
                  if (existsSync(fp)) unlink(fp);
                } catch {}
              }
              store.deleteMatrixVideo(body.videoId);
              sendJson(response, 200, { ok: true });
            } else {
              sendJson(response, 400, { error: "缺少 videoId" });
            }
            return;
          }
        }

        // 标记矩阵视频已下载
        const matrixVideoDownloadedMatch = pathname.match(/^\/api\/matrices\/([^/]+)\/videos\/([^/]+)\/downloaded$/);
        if (request.method === "POST" && matrixVideoDownloadedMatch) {
          const videoId = decodeURIComponent(matrixVideoDownloadedMatch[2]);
          const video = store.markMatrixVideoDownloaded(videoId);
          sendJson(response, 200, video);
          return;
        }

        sendJson(response, 404, { error: "矩阵接口不存在" });
        return;
      }

      // ---- AI 混剪方案管理 ----
      if (pathname === "/api/ai-presets") {
        if (request.method === "GET") {
          sendJson(response, 200, store.listAiRemixPresets());
          return;
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body.name || !body.prompt) { sendJson(response, 400, { error: "缺少方案名称或提示词" }); return; }
          sendJson(response, 200, store.createAiRemixPreset({
            name: body.name, prompt: body.prompt, isDefault: body.isDefault || false,
            introConfig: body.introConfig ?? null, outroConfig: body.outroConfig ?? null, musicConfig: body.musicConfig ?? null,
            dedup: body.dedup, refLang: body.refLang, resourceTypes: body.resourceTypes, outfitGuide: body.outfitGuide,
            outfitSource: body.outfitSource, outfitPickUrl: body.outfitPickUrl, outfitCallbackUrl: body.outfitCallbackUrl,
            outfitPickIndex: body.outfitPickIndex, outfitCallbackIndex: body.outfitCallbackIndex,
          }));
          return;
        }
      }

      const aiPresetMatch = pathname.match(/^\/api\/ai-presets\/([^/]+)$/);
      if (aiPresetMatch) {
        const presetId = decodeURIComponent(aiPresetMatch[1]);
        if (request.method === "PUT") {
          const body = await readJson(request);
          const updated = store.updateAiRemixPreset(presetId, {
            name: body.name, prompt: body.prompt, isDefault: body.isDefault,
            introConfig: body.introConfig, outroConfig: body.outroConfig, musicConfig: body.musicConfig,
            dedup: body.dedup, refLang: body.refLang, resourceTypes: body.resourceTypes, outfitGuide: body.outfitGuide,
            outfitSource: body.outfitSource, outfitPickUrl: body.outfitPickUrl, outfitCallbackUrl: body.outfitCallbackUrl,
            outfitPickIndex: body.outfitPickIndex, outfitCallbackIndex: body.outfitCallbackIndex,
          });
          if (!updated) { sendJson(response, 404, { error: "方案不存在" }); return; }
          sendJson(response, 200, updated);
          return;
        }
        if (request.method === "DELETE") {
          store.deleteAiRemixPreset(presetId);
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      // 方案变量文件绑定
      const presetFileMatch = pathname.match(/^\/api\/ai-presets\/([^/]+)\/files$/);
      if (presetFileMatch) {
        const presetId = decodeURIComponent(presetFileMatch[1]);
        if (request.method === "GET") {
          sendJson(response, 200, store.getPresetFiles(presetId));
          return;
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body.varName || !body.filePath) { sendJson(response, 400, { error: "缺少 varName 或 filePath" }); return; }
          const files = store.upsertPresetFile({
            presetId, varName: body.varName,
            filePath: body.filePath, filename: body.filename || path.basename(body.filePath),
          });
          sendJson(response, 200, files);
          return;
        }
      }
      const presetFileDeleteMatch = pathname.match(/^\/api\/ai-presets\/([^/]+)\/files\/(.+)$/);
      if (request.method === "DELETE" && presetFileDeleteMatch) {
        const presetId = decodeURIComponent(presetFileDeleteMatch[1]);
        const varName = decodeURIComponent(presetFileDeleteMatch[2]);
        store.deletePresetFile(presetId, varName);
        sendJson(response, 200, { ok: true });
        return;
      }

      // ---- 静态文件: 穿搭图库 ----
      if (pathname.startsWith("/data/luxury-image-library/")) {
        const subPath = decodeURIComponent(pathname.replace("/data/luxury-image-library/", ""));
        const filePath = path.resolve(THIS_DIR, "..", "data", "luxury-image-library", subPath);
        const baseDir = path.resolve(THIS_DIR, "..", "data", "luxury-image-library");
        if (!filePath.startsWith(baseDir)) { response.writeHead(403, { "Content-Type": "text/plain" }); response.end("禁止访问"); return; }
        if (!existsSync(filePath)) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("文件不存在"); return; }
        const statResult = await stat(filePath);
        const ext = path.extname(subPath).toLowerCase();
        const ct = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "application/octet-stream";
        response.writeHead(200, { "Content-Type": ct, "Content-Length": statResult.size, "Cache-Control": "public, max-age=3600" });
        createReadStream(filePath).pipe(response);
        return;
      }

      // ---- 静态文件: remix 输出 ----
      if (pathname.startsWith("/data/remix-output/")) {
        const subPath = decodeURIComponent(pathname.replace("/data/remix-output/", ""));
        const { getOutputDir } = await import("./video-remix.js");
        let outputDir = getOutputDir();
        let filePath = path.join(outputDir, subPath);
        // 防止路径穿越
        if (!filePath.startsWith(outputDir)) {
          response.writeHead(403, { "Content-Type": "text/plain" });
          response.end("禁止访问");
          return;
        }
        // 文件不在自定义路径，回退到默认路径
        if (!existsSync(filePath)) {
          const defaultDir = path.resolve(THIS_DIR, "..", "data", "remix-output");
          const defaultPath = path.join(defaultDir, subPath);
          if (existsSync(defaultPath)) { filePath = defaultPath; outputDir = defaultDir; }
        }
        if (!existsSync(filePath)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("文件不存在: " + subPath);
          return;
        }
        const statResult = await stat(filePath);
        const range = request.headers["range"];
        if (range) {
          // 支持 Range 请求（视频拖动进度条）
          const match = range.match(/bytes=(\d*)-(\d*)/);
          if (match) {
            let start = match[1] ? parseInt(match[1]) : 0;
            let end = match[2] ? parseInt(match[2]) : statResult.size - 1;
            if (start >= statResult.size) {
              response.writeHead(416, { "Content-Range": `bytes */${statResult.size}` });
              response.end();
              return;
            }
            end = Math.min(end, statResult.size - 1);
            const ext = path.extname(subPath).toLowerCase();
            const ct = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "video/mp4";
            response.writeHead(206, {
              "Content-Type": ct,
              "Content-Length": end - start + 1,
              "Content-Range": `bytes ${start}-${end}/${statResult.size}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "public, max-age=3600",
            });
            createReadStream(filePath, { start, end }).pipe(response);
            return;
          }
        }
        // 非预览的下载请求
        const isDownload = request.headers["sec-fetch-dest"] === "document" || request.headers["sec-fetch-dest"] === "empty" || new URL(pathname, "http://localhost").searchParams.get("download") !== null;
        // 根据文件扩展名设置正确的Content-Type
        const basename = path.basename(subPath);
        const ext = path.extname(subPath).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "video/mp4";
        // Content-Disposition 用 RFC 5987 格式支持中文文件名
        const dispositionFilename = `attachment; filename="${basename.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(basename)}`;
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": statResult.size,
          "Accept-Ranges": "bytes",
          ...(isDownload ? { "Content-Disposition": dispositionFilename } : {}),
          "Cache-Control": "public, max-age=3600",
        });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (pathname.startsWith("/data/remix-videos/")) {
        const filename = decodeURIComponent(path.basename(pathname));
        const subPath = pathname.slice("/data/remix-videos/".length);
        const { getUploadDir } = await import("./video-remix.js");
        let uploadDir = getUploadDir();
        let filePath = path.resolve(uploadDir, subPath);
        // 文件不在自定义路径，回退到默认路径
        if (!existsSync(filePath)) {
          const defaultDir = path.resolve(THIS_DIR, "..", "data", "remix-videos");
          const defaultPath = path.join(defaultDir, subPath);
          if (existsSync(defaultPath)) { filePath = defaultPath; uploadDir = defaultDir; }
        }
        if (!filePath.startsWith(uploadDir)) { sendJson(response, 403, { error: "禁止访问" }); return; }
        if (!existsSync(filePath)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("文件不存在: " + filename);
          return;
        }
        const statResult = await stat(filePath);
        const ext = path.extname(filename).toLowerCase();
        const ct = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : "video/mp4";
        response.writeHead(200, { "Content-Type": ct, "Content-Length": statResult.size, "Cache-Control": "public, max-age=3600" });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (pathname.startsWith("/data/remix-resources/")) {
        const subPath = pathname.slice("/data/remix-resources/".length);
        const filePath = path.resolve(THIS_DIR, "..", "data", "remix-resources", subPath);
        const resourceBase = path.resolve(THIS_DIR, "..", "data", "remix-resources");
        if (!filePath.startsWith(resourceBase)) { sendJson(response, 403, { error: "禁止访问" }); return; }
        if (!existsSync(filePath)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("文件不存在: " + subPath);
          return;
        }
        const statResult = await stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === ".mp4" ? "video/mp4" : ext === ".mp3" ? "audio/mpeg" : "application/octet-stream";
        response.writeHead(200, { "Content-Type": mime, "Content-Length": statResult.size, "Cache-Control": "public, max-age=3600" });
        createReadStream(filePath).pipe(response);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "不支持该请求方式" });
        return;
      }
      await serveStatic(publicDir, pathname, response, request.method === "HEAD");
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error?.statusCode || 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        console.error("[server] 响应头已发送，无法返回错误:", error?.message || error);
      }
    }
  });

  const nativeClose = server.close.bind(server);
  server.close = (callback) => {
    for (const [client, heartbeat] of sseClients) {
      clearInterval(heartbeat);
      client.end();
    }
    sseClients.clear();
    return nativeClose(callback);
  };

  server.on("close", () => {
    jobs.off("change", broadcast);
    tiktokJobs.removeEventListener("change", onTiktokChange);
    scheduler.removeEventListener("change", onSchedulerChange);
    scheduler.stop();
    tiktokPublisherManager.stopScheduler();
    tiktokJobs.stopAll().catch(() => {});
    store.close();
  });

  return { server, api, jobs, tiktokJobs, scheduler, database: store };
}

function openDashboard(url) {
  if (process.platform !== "win32") return;
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || DEFAULT_SERVER_PORT);
  const host = process.env.HOST || "0.0.0.0";
  const bitBrowserApiUrl = process.env.BITBROWSER_API_URL || DEFAULT_BITBROWSER_API;
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : DEFAULT_DATABASE_PATH;
  const { server, jobs } = createMonitorServer({ bitBrowserApiUrl, databasePath });

  // 自动启动 ngrok
  const ngrokCfg = loadNgrokConfig();
  if (ngrokCfg?.autoStart && ngrokCfg?.url) {
    try {
      startNgrok(ngrokCfg.port || 9223);
      console.log(`ngrok 已自动启动 (端口 ${ngrokCfg.port || 9223})`);
    } catch (e) {
      console.log(`ngrok 自动启动失败: ${e.message}`);
    }
  }

  server.listen(port, host, () => {

  // 主进程退出时杀掉所有 daemon 子进程
  const killAllDaemons = () => {
    for (const [id, procInfo] of cdpDaemonProcesses) {
      try { procInfo.proc.kill("SIGTERM"); } catch {}
    }
  };
  process.on("SIGINT", () => { killAllDaemons(); process.exit(0); });
  process.on("SIGTERM", () => { killAllDaemons(); process.exit(0); });
  process.on("exit", killAllDaemons);
    const url = `http://127.0.0.1:${port}`;
    console.log(`BitBrowser Reddit 监控面板已启动：${url}`);
    console.log(`BitBrowser Local API：${bitBrowserApiUrl}`);
    console.log(`本地数据库：${databasePath}`);
    console.log("关闭此窗口即可停止监控服务。\n");
    if (process.argv.includes("--open")) openDashboard(url);
  });

  const shutdown = async () => {
    if (ngrokProc) { ngrokProc.kill("SIGTERM"); ngrokProc = null; }
    await jobs.stopAll().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
