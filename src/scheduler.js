import { CdpClient } from "./cdp-client.js";

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
    };
  }

  #log(message, level = "info", data = {}) {
    const entry = { at: nowIso(), level, message, data };
    this.state.log.push(entry);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.status() }));
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-30) };
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
    };
    this.#emit();
    this.#run(opts).catch((e) => this.#fail(e));
    return this.status();
  }

  async #run(opts) {
    const profiles = await this.bitBrowserApi.listProfiles({ includeAlive: false });
    const queue = profiles
      .filter((p) => p.seq != null)
      .sort((a, b) => a.seq - b.seq);
    this.state.totalProfiles = queue.length;
    this.#log(`轮换调度开始，共 ${queue.length} 个实例，每实例 ${opts.minMinutes}-${opts.maxMinutes} 分钟`, "info", { count: queue.length });

    const savedRedditOptions = this.persistence?.getSavedOptions?.() || {};
    const savedTiktokOptions = this.persistence?.getTiktokOptions?.() || {};
    let prevId = null;

    for (let i = 0; i < queue.length; i++) {
      if (this.state.cancelled) break;
      const profile = queue[i];
      this.state.profileIndex = i;
      this.state.currentSeq = profile.seq;
      this.state.currentName = profile.name;

      // 关前一个浏览器
      if (prevId) {
        this.state.phase = "switching";
        this.#log(`关闭上一个实例的浏览器`, "info", { prevId });
        this.#emit();
        await this.redditJobs.stop(prevId).catch(() => {});
        await this.tiktokJobs.stop(prevId).catch(() => {});
        await this.bitBrowserApi.closeProfile(prevId).catch(() => {});
      }

      // 打开当前 + 刷新代理 + 确认IP变化
      this.state.phase = "opening";
      this.#log(`打开实例 #${profile.seq} ${profile.name}`, "info", { profileId: profile.id, seq: profile.seq });
      this.#emit();
      await this.#openAndCheckIp(profile, opts);

      // 按平台开关启动任务
      this.state.phase = "running";
      const platforms = [];
      if (opts.enableReddit) platforms.push("Reddit");
      if (opts.enableTiktok) platforms.push("TikTok");
      this.#log(`实例 #${profile.seq} 启动 ${platforms.join(" + ")} 任务`, "info");
      this.#emit();
      if (opts.enableReddit) {
        await this.redditJobs.start(profile.id, profile.name, savedRedditOptions).catch((e) =>
          this.#log(`实例 #${profile.seq} Reddit 启动失败：${e.message}`, "warning"),
        );
      }
      if (opts.enableTiktok) {
        await this.tiktokJobs.start(profile.id, profile.name, savedTiktokOptions).catch((e) =>
          this.#log(`实例 #${profile.seq} TikTok 启动失败：${e.message}`, "warning"),
        );
      }

      // 跑随机时长
      const minutes = randomInt(opts.minMinutes, opts.maxMinutes);
      const totalMs = minutes * 60_000;
      this.state.totalMs = totalMs;
      this.state.remainingMs = totalMs;
      this.#log(`实例 #${profile.seq} 开始养号 ${minutes} 分钟`, "info", { minutes });
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
      this.#log(`实例 #${profile.seq} 时间到，停止任务`, "info");
      this.#emit();
      await this.redditJobs.stop(profile.id).catch(() => {});
      await this.tiktokJobs.stop(profile.id).catch(() => {});
      prevId = profile.id;
    }

    // 收尾：关最后一个浏览器
    if (prevId && !this.state.cancelled) {
      this.state.phase = "finishing";
      this.#log("轮换调度完成，关闭最后一个浏览器", "info");
      this.#emit();
      await this.bitBrowserApi.closeProfile(prevId).catch(() => {});
    }
    this.state.running = false;
    this.state.phase = this.state.cancelled ? "stopped" : "completed";
    this.state.currentSeq = null;
    this.state.currentName = null;
    this.state.remainingMs = 0;
    this.#log(this.state.cancelled ? "轮换调度已停止" : "轮换调度全部完成", "info");
    this.#emit();
  }

  async #rotateProxy(url) {
    try {
      const res = await fetch(url);
      this.#log(`代理刷新响应：${res.status} ${res.statusText}`, res.ok ? "info" : "warning");
    } catch (e) {
      this.#log(`代理刷新请求失败：${e.message}`, "warning");
    }
    await new Promise((r) => setTimeout(r, 8000));
  }

  async #fetchCurrentIp(wsUrl) {
    const client = new CdpClient();
    await client.connect(wsUrl);
    try {
      const targets = await client.call("Target.getTargets");
      const page = (targets.targetInfos || []).find((t) => t.type === "page");
      if (!page) return null;
      const attached = await client.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const sid = attached.sessionId;
      await client.call("Page.enable", {}, sid);
      const res = await client.call(
        "Runtime.evaluate",
        { expression: "fetch('https://api.ipify.org?format=json').then(r=>r.json()).then(d=>d.ip||'').catch(()=>'')", awaitPromise: true, returnByValue: true },
        sid, 15000,
      );
      return res?.result?.value || null;
    } catch (e) {
      this.#log(`获取出口IP失败：${e.message}`, "warning");
      return null;
    } finally {
      client.close().catch(() => {});
    }
  }

  async #openAndCheckIp(profile, opts) {
    const wantRotate = Boolean(opts.proxyRotateUrl);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (wantRotate) {
        await this.#rotateProxy(opts.proxyRotateUrl);
      }
      const conn = await this.bitBrowserApi.openProfile(profile.id, { extractIp: !wantRotate && opts.extractIp });
      if (!wantRotate) return;
      const ip = await this.#fetchCurrentIp(conn.wsUrl);
      const oldIp = this.state.lastIp;
      const suffix = attempt > 0 ? `（第${attempt}次重试）` : "";
      this.state.ipChange = { old: oldIp, new: ip };
      this.#log(`实例 #${profile.seq} 出口IP：${oldIp || "—"} → ${ip || "未知"}${suffix}`, "info", { ip, oldIp });
      this.#emit();
      if (!oldIp || !ip || ip !== oldIp) {
        this.state.lastIp = ip;
        return;
      }
      this.#log(`IP未变化（仍为 ${ip}），关闭后重试刷新`, "warning");
      await this.bitBrowserApi.closeProfile(profile.id).catch(() => {});
    }
    this.#log(`IP 重试3次仍未变化，继续运行（代理商可能未换IP）`, "warning");
    await this.bitBrowserApi.openProfile(profile.id, { extractIp: false });
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
