const REQUEST_TIMEOUT_MS = 15000;

function makeTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export class BitBrowserApi {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
  }

  async request(pathname, body = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const timeout = makeTimeoutSignal(timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timeout.signal,
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`BitBrowser 返回了无法解析的响应（HTTP ${response.status}）`);
      }

      if (!response.ok) {
        throw new Error(payload?.msg || `BitBrowser 请求失败（HTTP ${response.status}）`);
      }
      if (payload?.success === false) {
        throw new Error(payload.msg || "BitBrowser 拒绝了该请求");
      }
      return payload?.data ?? payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("连接 BitBrowser Local API 超时");
      }
      if (error instanceof TypeError && /fetch/i.test(error.message)) {
        throw new Error(`无法连接 BitBrowser Local API：${this.baseUrl}`);
      }
      throw error;
    } finally {
      timeout.clear();
    }
  }

  async listProfiles({ includeAlive = true } = {}) {
    // BitBrowser's local service can serialize requests on some versions.
    // Keeping these calls sequential avoids one request waiting for the other
    // until the timeout expires.
    const profileData = await this.request("/browser/list", { page: 0, pageSize: 100 });
    const aliveData = includeAlive
      ? await this.request("/browser/pids/all", {}, 5000).catch(() => ({}))
      : {};

    const list = Array.isArray(profileData?.list)
      ? profileData.list
      : Array.isArray(profileData)
        ? profileData
        : [];
    const alive = aliveData && typeof aliveData === "object" ? aliveData : {};

    return list.map((profile) => ({
      id: String(profile.id),
      seq: profile.seq ?? null,
      name: profile.name || "未命名实例",
      status: profile.status ?? null,
      running: Boolean(alive[profile.id]),
      pid: alive[profile.id] ?? null,
    }));
  }

  async openProfile(profileId, { extractIp = false } = {}) {
    const data = await this.request("/browser/open", { id: profileId, ...(extractIp ? { extractIp: true } : {}) }, 30000);
    const wsUrl =
      (typeof data?.ws === "string" && data.ws) ||
      data?.ws?.selenium ||
      data?.ws?.puppeteer ||
      data?.ws?.playwright;

    if (!wsUrl) {
      throw new Error("BitBrowser 未返回可用的调试连接地址");
    }

    return {
      wsUrl,
      http: data.http || null,
      coreVersion: data.coreVersion || null,
    };
  }

  async closeProfile(profileId) {
    return this.request("/browser/close", { id: profileId }, 15000);
  }
}
