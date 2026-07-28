import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

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

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
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
  const jobs = jobManager || new JobManager({ bitBrowserApi: api, persistence: store });
  const tiktokJobs = new TiktokJobManager({ bitBrowserApi: api, persistence: store });
  const tiktokPublisherManager = new TiktokPublishManager({ bitBrowserApi: api, persistence: store });
  tiktokPublisherManager.startScheduler();
  const sseClients = new Map();

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
      if (
        pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      ) {
        assertLocalWriteRequest(request);
      }

      if (request.method === "GET" && pathname === "/api/config") {
        sendJson(response, 200, {
          targetUrl: TARGET_URL,
          bitBrowserApiUrl,
          defaults: DEFAULT_OPTIONS,
          savedOptions: store.getSavedOptions(),
          databaseFile:
            store.filename === ":memory:" ? ":memory:" : path.basename(store.filename || databasePath),
        });
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
        sendJson(response, 200, { defaults: TIKTOK_DEFAULT_OPTIONS, saved: store.getTiktokOptions(), jobs: tiktokJobs.list() });
        return;
      }

      if (request.method === "PUT" && pathname === "/api/tiktok/settings") {
        const body = await readJson(request);
        const saved = store.saveTiktokOptions(body.options || {});
        sendJson(response, 200, { options: saved });
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

      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "接口不存在" });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "不支持该请求方式" });
        return;
      }
      await serveStatic(publicDir, pathname, response, request.method === "HEAD");
    } catch (error) {
      sendJson(response, error?.statusCode || 400, {
        error: error instanceof Error ? error.message : String(error),
      });
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
  const host = "127.0.0.1";
  const bitBrowserApiUrl = process.env.BITBROWSER_API_URL || DEFAULT_BITBROWSER_API;
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : DEFAULT_DATABASE_PATH;
  const { server, jobs } = createMonitorServer({ bitBrowserApiUrl, databasePath });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`BitBrowser Reddit 监控面板已启动：${url}`);
    console.log(`BitBrowser Local API：${bitBrowserApiUrl}`);
    console.log(`本地数据库：${databasePath}`);
    console.log("关闭此窗口即可停止监控服务。\n");
    if (process.argv.includes("--open")) openDashboard(url);
  });

  const shutdown = async () => {
    await jobs.stopAll().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
