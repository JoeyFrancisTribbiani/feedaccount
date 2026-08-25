/**
 * 生图任务管理器
 * 
 * 独立管理 ComfyUI 生图任务的完整生命周期：
 * 提交工作流 → 轮询结果 → 下载图片 → 上传 TikTok
 * 
 * 特性：
 * - 异步并行：不阻塞养号计时
 * - 进度追踪：实时状态（提交中/排队中/生成中/下载中/上传中/完成）
 * - 超时保护：fetch 加 AbortController
 * - 取消支持：养号停止时可中断
 * - 任务历史：记录每次生图的结果
 */

import { readFile, writeFile, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { generatePrompt, getNegativePrompt } from "./image-gen-prompts.js";
import { TiktokPublisher } from "./tiktok/tiktok-publisher.js";

// ── 配置 ──────────────────────────────────────────────
const COMFYUI_HOST = process.env.COMFYUI_HOST || "http://127.0.0.1:8189";
const WORKFLOW_PATH = process.env.COMFYUI_WORKFLOW || "F:/Comfy-Desktop/api/bg_generator_9x16.json";
const OUTPUT_DIR = path.resolve(process.cwd(), "data", "image-gen");
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 600_000; // 10 分钟
const FETCH_TIMEOUT_MS = 30_000; // 单次 fetch 超时

// ── 任务状态 ──────────────────────────────────────────
const TaskStatus = {
  PENDING: "pending",         // 已创建，待提交
  SUBMITTING: "submitting",   // 正在提交到 ComfyUI
  QUEUED: "queued",           // ComfyUI 已接受，排队中
  GENERATING: "generating",   // 正在生成
  DOWNLOADING: "downloading",  // 正在下载结果
  UPLOADING: "uploading",      // 正在上传到 TikTok
  DONE: "done",               // 全部完成
  ERROR: "error",             // 出错
  CANCELLED: "cancelled",     // 已取消
};

const STATUS_LABELS = {
  pending: "等待中", submitting: "提交中", queued: "排队中", generating: "生成中",
  downloading: "下载中", uploading: "上传中", done: "已完成", error: "出错", cancelled: "已取消",
};

// ── 任务管理器 ────────────────────────────────────────
export class ImageGenTaskManager {
  constructor({ bitBrowserApi, persistence = null } = {}) {
    this.bitBrowserApi = bitBrowserApi;
    this.persistence = persistence;
    this.tasks = new Map(); // taskId → task object
    this.activeAbortControllers = new Map(); // taskId → AbortController
  }

  /**
   * 创建并启动一个生图任务（异步，不阻塞调用方）
   * @param {Object} profile - BitBrowser 实例信息 { id, seq, name }
   * @param {Object} opts - { category: "jesus"|"beauty" }
   * @param {Function} onProgress - 进度回调 (task) => void
   * @returns {string} taskId
   */
  createTask(profile, opts = {}, onProgress = null) {
    const taskId = `imggen_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const category = opts.imageGenCategory || "jesus";
    const prompt = generatePrompt(category);
    const negativePrompt = getNegativePrompt(category);
    const seed = Math.floor(Math.random() * 0xffffffff);

    const task = {
      id: taskId,
      profileId: profile.id,
      profileSeq: profile.seq,
      profileName: profile.name,
      category,
      prompt: prompt.slice(0, 200),
      seed,
      status: TaskStatus.PENDING,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      result: null,        // { localPath, filename, tiktokResult }
      elapsedMs: 0,
    };

    this.tasks.set(taskId, task);

    // 异步执行，不阻塞调用方
    this.#executeTask(task, { prompt, negativePrompt, seed }, onProgress).catch((err) => {
      task.status = TaskStatus.ERROR;
      task.error = err.message;
      task.completedAt = new Date().toISOString();
      task.elapsedMs = Date.now() - new Date(task.startedAt).getTime();
      onProgress?.(task);
    });

    return taskId;
  }

  /**
   * 取消指定任务
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const ac = this.activeAbortControllers.get(taskId);
    if (ac) ac.abort();
    task.status = TaskStatus.CANCELLED;
    task.completedAt = new Date().toISOString();
    task.elapsedMs = Date.now() - new Date(task.startedAt).getTime();
  }

  /**
   * 取消所有进行中的任务
   */
  cancelAll() {
    for (const [taskId, task] of this.tasks) {
      if (![TaskStatus.DONE, TaskStatus.ERROR, TaskStatus.CANCELLED].includes(task.status)) {
        this.cancelTask(taskId);
      }
    }
  }

  /**
   * 获取所有任务（按时间倒序）
   */
  getAllTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => 
      new Date(b.startedAt) - new Date(a.startedAt)
    );
  }

  /**
   * 获取活跃任务数
   */
  getActiveCount() {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (![TaskStatus.DONE, TaskStatus.ERROR, TaskStatus.CANCELLED].includes(task.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取任务摘要（给前端用）
   */
  getSummary() {
    const all = this.getAllTasks();
    return {
      total: all.length,
      active: this.getActiveCount(),
      done: all.filter((t) => t.status === TaskStatus.DONE).length,
      failed: all.filter((t) => t.status === TaskStatus.ERROR).length,
      tasks: all.slice(0, 20).map((t) => ({
        id: t.id,
        profileSeq: t.profileSeq,
        category: t.category,
        status: t.status,
        statusLabel: STATUS_LABELS[t.status] || t.status,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        elapsedMs: t.elapsedMs,
        error: t.error,
        prompt: t.prompt,
        result: t.result,
      })),
    };
  }

  // ── 内部执行逻辑 ────────────────────────────────────
  async #executeTask(task, { prompt, negativePrompt, seed }, onProgress) {
    const update = (status, extra = {}) => {
      task.status = status;
      task.elapsedMs = Date.now() - new Date(task.startedAt).getTime();
      Object.assign(task, extra);
      onProgress?.(task);
    };

    // 1. 读取工作流模板并注入参数
    update(TaskStatus.SUBMITTING);
    const workflowRaw = await readFile(WORKFLOW_PATH, "utf8");
    const workflow = JSON.parse(workflowRaw);
    if (workflow["76"]) workflow["76"].inputs.prompt = prompt;
    if (workflow["77"]) workflow["77"].inputs.prompt = negativePrompt;
    if (workflow["3"]) workflow["3"].inputs.seed = seed;

    // 2. 提交到 ComfyUI
    const submitAc = this.#createAbortController(task.id);
    const submitRes = await this.#fetchWithTimeout(`${COMFYUI_HOST}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: `feedaccount-${task.id}` }),
    }, submitAc);

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`提交工作流失败 (HTTP ${submitRes.status})：${text.slice(0, 300)}`);
    }
    const submitData = await submitRes.json();
    if (submitData.node_errors && Object.keys(submitData.node_errors).length > 0) {
      throw new Error(`工作流验证失败：${JSON.stringify(submitData.node_errors).slice(0, 500)}`);
    }
    const promptId = submitData.prompt_id;
    update(TaskStatus.QUEUED, { comfyuiPromptId: promptId });

    // 3. 轮询等待结果
    const pollStart = Date.now();
    let imageInfo = null;

    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      // 检查取消
      if (task.status === TaskStatus.CANCELLED) return;

      const pollAc = this.#createAbortController(task.id);
      const histRes = await this.#fetchWithTimeout(
        `${COMFYUI_HOST}/history/${promptId}`, {}, pollAc
      ).catch(() => null);

      if (histRes && histRes.ok) {
        const histData = await histRes.json();
        const entry = histData[promptId];
        if (entry) {
          if (entry.status?.status_str === "error") {
            const errMsg = (entry.status.messages || [])
              .filter((m) => m[0] === "execution_error")
              .map((m) => m[1]?.exception_message || "")
              .join("; ");
            throw new Error(`ComfyUI 执行错误：${errMsg || "execution_error"}`);
          }
          // 检查是否在队列中运行
          const outputs = entry.outputs || {};
          if (Object.keys(outputs).length > 0) {
            for (const nodeId of Object.keys(outputs)) {
              const nodeOutput = outputs[nodeId];
              if (nodeOutput.images && nodeOutput.images.length > 0) {
                imageInfo = nodeOutput.images[0];
                break;
              }
            }
            if (imageInfo) break;
          }
        }
      }

      // 更新状态为生成中（第一次轮询成功后）
      if (task.status === TaskStatus.QUEUED) {
        update(TaskStatus.GENERATING);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!imageInfo) throw new Error("ComfyUI 生图超时（10分钟内未返回结果）");

    // 4. 下载结果图片
    update(TaskStatus.DOWNLOADING);
    const downloadAc = this.#createAbortController(task.id);
    const params = new URLSearchParams({
      filename: imageInfo.filename,
      subfolder: imageInfo.subfolder || "",
      type: imageInfo.type || "output",
    });
    const dlRes = await this.#fetchWithTimeout(
      `${COMFYUI_HOST}/view?${params}`, {}, downloadAc
    );
    if (!dlRes.ok) throw new Error(`下载结果图片失败 (HTTP ${dlRes.status})`);
    const imgBuffer = Buffer.from(await dlRes.arrayBuffer());

    // 保存到本地
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const localPath = path.join(OUTPUT_DIR, `gen_${task.category}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`);
    await writeFile(localPath, imgBuffer);

    // 5. 上传到 TikTok
    update(TaskStatus.UPLOADING);
    if (!this.bitBrowserApi) {
      throw new Error("未配置 BitBrowser API，无法上传");
    }

    const conn = await this.bitBrowserApi.openProfile(task.profileId, { extractIp: false });
    if (!conn || !conn.wsUrl) {
      throw new Error(`BitBrowser 实例 #${task.profileSeq} 未返回 CDP WebSocket 地址`);
    }

    const publisher = new TiktokPublisher();
    try {
      await publisher.connect(conn.wsUrl);
      const hashtags = task.category === "jesus"
        ? ["jesus", "faith", "christian", "blessed", "god"]
        : ["beautiful", "aesthetic", "photo", "trending", "viral"];
      const result = await publisher.uploadPhoto({
        filePath: localPath,
        title: task.category === "jesus" ? "Divine moments ✨" : "Daily aesthetic ✨",
        hashtags,
        privacyLevel: "public",
      });

      task.result = {
        localPath,
        filename: imageInfo.filename,
        tiktokResult: result,
      };

      update(TaskStatus.DONE, {
        completedAt: new Date().toISOString(),
        result: task.result,
      });
    } finally {
      await publisher.close().catch(() => {});
    }
  }

  // ── 辅助方法 ────────────────────────────────────────
  #createAbortController(taskId) {
    const ac = new AbortController();
    this.activeAbortControllers.set(taskId, ac);
    return ac;
  }

  async #fetchWithTimeout(url, options, abortController) {
    const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: abortController.signal });
      return res;
    } finally {
      clearTimeout(timeoutId);
      this.activeAbortControllers.delete(abortController);
    }
  }
}
