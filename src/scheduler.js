import { checkIpViaSocks5 } from "./socks5-check.js";

export const SCHEDULER_DEFAULTS = Object.freeze({
  minMinutes: 23,
  maxMinutes: 35,
  extractIp: true,
  proxyRotateUrl: null,
  enableReddit: true,
  enableTiktok: true,
});

function nowIso() {
  return new Date().toISOString();
}

function randomInt(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error("随机数范围无效");
  }
  const { randomInt: cryptoRandomInt } = globalThis?.crypto ?? {};
  if (typeof cryptoRandomInt === "function") return cryptoRandomInt(min, max + 1);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class RotationScheduler extends EventTarget {
  constructor({ bitBrowserApi, redditJobs, tiktokJobs, persistence = null, proxyRotateUrl = null } = {}) {
    super();
    this.bitBrowserApi = bitBrowserApi;
    this.redditJobs = redditJobs;
    this.tiktokJobs = tiktokJobs;
    this.persistence = persistence;
    this.defaultProxyRotateUrl = proxyRotateUrl;
    this.state = {
      running: false,
      cancelled: false,
      currentSeq: null,
      currentName: null,
      profileIndex: 0,
      totalProfiles: 0,
      remainingMs: 0,
      totalMs: 0,
      phase: "idle",
      log: [],
      lastIp: null,
      ipChange: null,
      currentProfileId: null,
    };
  }

  #log(message, level = "info", data = {}) {
    const entry = { at: nowIso(), level, message, data };
    this.state.log.push(entry);
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.status() }));
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-50) };
  }

  async start(options = {}) {
    if (this.state.running) throw new Error("轮换调度已在运行");
    const opts = { ...SCHEDULER_DEFAULTS, proxyRotateUrl: this.defaultProxyRotateUrl, ...options };
    if (!opts.enableReddit && !opts.enableTiktok) throw new Error("至少需要启用一个平台（Reddit 或 TikTok）");
    this.state = {
      running: true,
      cancelled: false,
      currentSeq: null,
      currentName: null,
      profileIndex: 0,
      totalProfiles: 0,
      remainingMs: 0,
      totalMs: 0,
      phase: "starting",
      log: [],
      ipChange: null,
      currentProfileId: null,
    };
    this.#emit();
    this.#run(opts).catch((e) => this.#fail(e));
    return this.status();
  }

  async #run(opts) {
    this.#log(`正在获取 BitBrowser 实例列表`, "info");
    const profiles = await this.bitBrowserApi.listProfiles({ includeAlive: false });
    let queue = profiles
      .filter((p) => p.seq != null)
      .sort((a, b) => a.seq - b.seq);
    if (Array.isArray(opts.profileIds) && opts.profileIds.length > 0) {
      const idSet = new Set(opts.profileIds);
      const before = queue.length;
      queue = queue.filter((p) => idSet.has(p.id));
      this.#log(`实例筛选：共 ${before} 个，选中 ${queue.length} 个`, "info");
    }
    this.state.totalProfiles = queue.length;
    if (queue.length === 0) {
      this.#log("没有符合条件的实例可轮换", "warning");
      this.state.running = false;
      this.state.phase = "error";
      this.#emit();
      return;
    }
    const platformList = [];
    if (opts.enableReddit) platformList.push("Reddit");
    if (opts.enableTiktok) platformList.push("TikTok");
    this.#log(`轮换调度开始，共 ${queue.length} 个实例：${queue.map((p) => `#${p.seq}`).join(" → ")}，平台：${platformList.join(" + ")}，每实例 ${opts.minMinutes}-${opts.maxMinutes} 分钟`, "info", { count: queue.length });

    const savedRedditOptions = this.persistence?.getSavedOptions?.() || {};
    let prevId = null;

    for (let i = 0; i < queue.length; i++) {
      if (this.state.cancelled) break;
      const profile = queue[i];
      this.state.profileIndex = i;
      this.state.currentSeq = profile.seq;
      this.state.currentName = profile.name;
      this.state.currentProfileId = profile.id;
      this.#log(`━━━ 开始实例 ${i + 1}/${queue.length}：#${profile.seq} ${profile.name} ━━━`, "info");

      // 关前一个浏览器
      if (prevId) {
        this.state.phase = "switching";
        this.#log(`正在关闭上一个实例浏览器`, "info", { prevId });
        this.#emit();
        await this.redditJobs.stop(prevId).catch((e) => this.#log(`关闭上一个实例 Reddit 任务时出错：${e.message}`, "warning"));
        await this.tiktokJobs.stop(prevId).catch((e) => this.#log(`关闭上一个实例 TikTok 任务时出错：${e.message}`, "warning"));
        await this.bitBrowserApi.closeProfile(prevId).catch((e) => this.#log(`关闭上一个实例浏览器时出错：${e.message}`, "warning"));
        this.#log(`上一个实例浏览器已关闭`, "info");
      }

      // 打开当前 + 刷新代理 + 确认IP变化
      this.state.phase = "opening";
      this.#emit();
      await this.#openAndCheckIp(profile, opts);

      if (this.state.cancelled) {
        this.#log(`实例 #${profile.seq} 代理检测阶段收到停止指令，跳过任务启动`, "warning");
        break;
      }

      // 按平台开关启动任务
      this.state.phase = "running";
      const platforms = [];
      if (opts.enableReddit) platforms.push("Reddit");
      if (opts.enableTiktok) platforms.push("TikTok");
      this.#log(`实例 #${profile.seq} 正在启动 ${platforms.join(" + ")} 任务`, "info");
      this.#emit();
      if (opts.enableReddit) {
        await this.redditJobs.start(profile.id, profile.name, savedRedditOptions)
          .then(() => this.#log(`实例 #${profile.seq} Reddit 任务已启动`, "info"))
          .catch((e) => this.#log(`实例 #${profile.seq} Reddit 启动失败：${e.message}`, "warning"));
      }
      if (opts.enableTiktok) {
        const savedTiktokOptions = this.persistence?.getTiktokOptions?.(profile.id)
          || this.persistence?.getTiktokOptions?.()
          || {};
        this.#log(`实例 #${profile.seq} TikTok 配置来源：${this.persistence?.getTiktokOptions?.(profile.id) ? "实例独立" : "全局默认"}`, "info");
        await this.tiktokJobs.start(profile.id, profile.name, savedTiktokOptions)
          .then(() => this.#log(`实例 #${profile.seq} TikTok 任务已启动`, "info"))
          .catch((e) => this.#log(`实例 #${profile.seq} TikTok 启动失败：${e.message}`, "warning"));
      }

      // 跑随机时长
      const minutes = randomInt(opts.minMinutes, opts.maxMinutes);
      const totalMs = minutes * 60_000;
      this.state.totalMs = totalMs;
      this.state.remainingMs = totalMs;
      this.#log(`实例 #${profile.seq} 开始养号 ${minutes} 分钟（预计 ${new Date(Date.now() + totalMs).toLocaleTimeString("zh-CN", { hour12: false })} 结束）`, "info", { minutes });
      this.#emit();

      const startAt = Date.now();
      let lastEmit = 0;
      while (!this.state.cancelled && Date.now() - startAt < totalMs) {
        await new Promise((r) => setTimeout(r, 1000));
        this.state.remainingMs = Math.max(0, totalMs - (Date.now() - startAt));
        const now = Date.now();
        if (now - lastEmit > 5000) {
          lastEmit = now;
          this.#emit();
        }
      }

      // 停两个任务
      this.state.phase = "stopping";
      if (this.state.cancelled) {
        this.#log(`实例 #${profile.seq} 收到停止指令，提前结束养号`, "warning");
      } else {
        this.#log(`实例 #${profile.seq} 养号时间到（${minutes} 分钟），正在停止任务`, "info");
      }
      this.#emit();
      await this.redditJobs.stop(profile.id).catch((e) => this.#log(`实例 #${profile.seq} 停止 Reddit 任务时出错：${e.message}`, "warning"));
      await this.tiktokJobs.stop(profile.id).catch((e) => this.#log(`实例 #${profile.seq} 停止 TikTok 任务时出错：${e.message}`, "warning"));
      this.#log(`实例 #${profile.seq} 任务已全部停止`, "info");
      prevId = profile.id;
    }

    // 收尾：关最后一个浏览器
    if (prevId && !this.state.cancelled) {
      this.state.phase = "finishing";
      this.#log("轮换调度全部完成，正在关闭最后一个浏览器", "info");
      this.#emit();
      await this.bitBrowserApi.closeProfile(prevId).catch((e) => this.#log(`关闭最后一个浏览器时出错：${e.message}`, "warning"));
    } else if (prevId && this.state.cancelled) {
      this.state.phase = "finishing";
      this.#log("轮换调度已停止，正在关闭当前浏览器", "info");
      this.#emit();
      await this.bitBrowserApi.closeProfile(prevId).catch((e) => this.#log(`关闭当前浏览器时出错：${e.message}`, "warning"));
    }
    this.state.running = false;
    this.state.phase = this.state.cancelled ? "stopped" : "completed";
    this.state.currentSeq = null;
    this.state.currentName = null;
    this.state.currentProfileId = null;
    this.state.remainingMs = 0;
    this.#log(this.state.cancelled ? "轮换调度已停止" : "轮换调度全部完成", "info");
    this.#emit();
  }

  async #rotateProxy(url) {
    const maskedUrl = url.replace(/(token|key|password|pwd)=[^&]+/gi, "$1=***");
    this.#log(`正在请求代理刷新API：${maskedUrl}`, "info");
    try {
      const res = await fetch(url);
      const body = await res.text().catch(() => "");
      const bodyPreview = body ? body.substring(0, 300) : "";
      this.#log(`代理刷新响应：HTTP ${res.status} ${res.statusText}${bodyPreview ? `，响应体：${bodyPreview}` : ""}`, res.ok ? "info" : "warning", { status: res.status, body: bodyPreview });
    } catch (e) {
      this.#log(`代理刷新请求失败：${e.message}`, "warning");
    }
    this.#log(`代理刷新请求已完成，等待 20 秒让代理生效`, "info");
    await new Promise((r) => setTimeout(r, 20000));
    this.#log(`等待结束，开始检测出口IP`, "info");
  }

  async #openAndCheckIp(profile, opts) {
    const wantRotate = Boolean(opts.proxyRotateUrl);
    if (!wantRotate) {
      this.#log(`实例 #${profile.seq} 未配置代理刷新，直接打开浏览器`, "info");
      await this.bitBrowserApi.openProfile(profile.id, { extractIp: opts.extractIp });
      this.#log(`实例 #${profile.seq} 浏览器已打开`, "info");
      return;
    }

    // 获取代理配置和上次IP（不打开浏览器，避免关联风险）
    this.#log(`实例 #${profile.seq} 正在获取代理配置（不打开浏览器）`, "info");
    const detail = await this.bitBrowserApi.getProfileDetail(profile.id);
    const baselineIp = detail.lastIp || this.state.lastIp || null;
    const baselineSource = detail.lastIp ? "BitBrowser记录" : (this.state.lastIp ? "上个实例" : "无");
    this.#log(`实例 #${profile.seq} 代理配置：类型=${detail.proxyType}，地址=${detail.host}:${detail.port}，认证=${detail.proxyUserName ? "有用户名密码" : "无"}，基线IP=${baselineIp || "无"}（来源：${baselineSource}）`, "info", { proxyType: detail.proxyType, host: detail.host, port: detail.port });

    // 刷新代理
    await this.#rotateProxy(opts.proxyRotateUrl);

    // 通过 SOCKS5 代理检测出口IP（不打开浏览器）
    const maxAttempts = 6;
    const pollIntervalMs = 5000;
    this.#log(`实例 #${profile.seq} 开始通过 SOCKS5 代理检测出口IP（最多 ${maxAttempts} 次，间隔 ${pollIntervalMs / 1000} 秒）`, "info");

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.state.cancelled) {
        this.#log(`实例 #${profile.seq} 代理检测阶段收到停止指令，中止检测`, "warning");
        return;
      }

      const attemptStart = Date.now();
      let ip = null;
      try {
        ip = await checkIpViaSocks5({
          host: detail.host,
          port: detail.port,
          username: detail.proxyUserName,
          password: detail.proxyPassword,
        });
      } catch (e) {
        this.#log(`实例 #${profile.seq} 第${attempt + 1}次检测失败：${e.message}（耗时 ${Date.now() - attemptStart}ms）`, "warning");
      }

      this.state.ipChange = { old: baselineIp, new: ip };
      this.#emit();

      if (ip) {
        const changed = !baselineIp || ip !== baselineIp;
        this.#log(`实例 #${profile.seq} 第${attempt + 1}次检测获取到IP：${ip}（耗时 ${Date.now() - attemptStart}ms）${changed ? "" : "，与基线相同"}`, changed ? "info" : "warning");
      }

      if (ip && (!baselineIp || ip !== baselineIp)) {
        this.state.lastIp = ip;
        this.#log(`实例 #${profile.seq} ✅ IP确认变化：${baselineIp || "—"} → ${ip}，准备打开浏览器`, "info", { ip, oldIp: baselineIp });
        this.#emit();
        this.#log(`实例 #${profile.seq} 正在打开浏览器（IP已确认）`, "info");
        await this.bitBrowserApi.openProfile(profile.id, { extractIp: false });
        this.#log(`实例 #${profile.seq} 浏览器已打开，开始任务`, "info");
        return;
      }

      if (attempt < maxAttempts - 1) {
        const reason = !ip ? "获取失败" : `与基线相同（${ip}）`;
        this.#log(`实例 #${profile.seq} IP尚未生效（${reason}），${pollIntervalMs / 1000}秒后进行第${attempt + 2}次检测`, "warning");
        this.#emit();
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    this.#log(`实例 #${profile.seq} ⚠️ 等待 ${maxAttempts} 次后IP仍未变化，强制打开浏览器继续运行（代理商可能未换IP）`, "warning");
    this.#emit();
    this.#log(`实例 #${profile.seq} 正在打开浏览器（IP未确认，强制继续）`, "warning");
    await this.bitBrowserApi.openProfile(profile.id, { extractIp: false });
    this.#log(`实例 #${profile.seq} 浏览器已打开（IP未确认）`, "warning");
  }

  #fail(error) {
    this.state.running = false;
    this.state.phase = "error";
    this.#log(`调度出错：${error.message}`, "error", { error: error.message });
    this.#emit();
  }

  stop() {
    if (!this.state.running) return this.status();
    this.state.cancelled = true;
    this.#log("已请求停止轮换调度，当前实例养完后停止", "info");
    this.#emit();
    return this.status();
  }
}
