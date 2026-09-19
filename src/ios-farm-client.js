/**
 * iOS Farm Client — 对接 prod-FARM-IOS-Core 的 HTTP 客户端
 *
 * prod-FARM-IOS-Core 部署在 Mac 上，通过 USB 连接多台 iPhone，
 * 用 WebDriverAgent + Appium 驱动 TikTok App 自动发布视频。
 *
 * 本客户端负责：
 * 1. 上传混剪好的视频到 Mac（POST /api/assets）
 * 2. 创建 TikTok 发布任务（POST /api/schedules）
 * 3. 轮询执行状态（GET /api/executions/:id）
 * 4. 管理设备列表（GET /api/devices）
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getOutputDir } from './video-remix.js';

export class IosFarmClient {
  /**
   * @param {string} baseUrl — prod-FARM-IOS-Core 的 URL（如 http://192.168.50.xxx:3000）
   * @param {string|null} apiKey — Bearer token（如果配置了 auth provider）
   */
  constructor(baseUrl, apiKey = null) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /**
   * 发送 HTTP 请求到 iOS Farm API
   * @private
   */
  async _request(method, pathname, options = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const headers = { ...(options.headers || {}) };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: options.signal,
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      const errorMsg = (data && typeof data === 'object' && data.error) || text || `HTTP ${response.status}`;
      throw new Error(`iOS Farm API ${method} ${pathname} 失败: ${errorMsg}`);
    }
    return data;
  }

  /**
   * 健康检查
   * @returns {Promise<{ok: boolean, plugins: Array}>}
   */
  async health() {
    return this._request('GET', '/health');
  }

  /**
   * 获取已注册的设备列表（含在线状态）
   * @returns {Promise<Array>} 设备数组，每项含 { udid, name, connected, disabled, hasPasscode, pluginData }
   */
  async listDevices() {
    const data = await this._request('GET', '/api/devices');
    return Array.isArray(data) ? data : (data?.devices || []);
  }

  /**
   * 获取单个设备的连接状态
   * @param {string} udid
   */
  async getDeviceConnection(udid) {
    return this._request('GET', `/api/devices/${encodeURIComponent(udid)}/connection`);
  }

  /**
   * 上传视频文件到 Mac
   * 使用 multipart/form-data，与 prod-FARM-IOS-Core 的 POST /api/assets 对接
   *
   * @param {string} filePath — 本地视频文件路径
   * @param {string} fileName — 文件名
   * @returns {Promise<{assetId: string, relativePath: string, originalName: string, mimeType: string, size: number, sha256: string}>}
   */
  async uploadAsset(filePath, fileName) {
    // 读取文件（支持 /data/ 前缀的路径转换）
    let localPath = filePath;
    if (/^\/data\//.test(filePath)) {
      localPath = path.join(path.dirname(getOutputDir()), filePath.replace(/^\/data\//, ''));
    }

    const buffer = readFileSync(localPath);
    const name = fileName || path.basename(localPath);
    const ext = path.extname(name).toLowerCase();
    const mimeType = ext === '.mp4' ? 'video/mp4'
      : ext === '.mov' ? 'video/quicktime'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : 'application/octet-stream';

    // 构建 multipart/form-data
    const boundary = `----IosFarmUpload${Date.now()}`;
    const parts = [];

    // file part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const endBoundary = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(parts.join(''), 'utf8'),
      buffer,
      Buffer.from(endBoundary, 'utf8'),
    ]);

    const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/api/assets`, {
      method: 'POST',
      headers,
      body,
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      throw new Error(`iOS Farm 上传素材失败: ${(data && data.error) || text || response.status}`);
    }

    // registerAssets 返回 { assets: [{ id, relativePath, originalName, mimeType, size, sha256 }] }
    const assets = Array.isArray(data) ? data : (data?.assets || []);
    if (!assets.length) throw new Error('iOS Farm 上传素材返回空');
    return assets[0];
  }

  /**
   * 创建 TikTok 发布任务
   *
   * @param {object} params
   * @param {string} params.deviceUdid — 目标 iPhone 的 UDID
   * @param {Array<{assetId: string, name: string, mimeType: string}>} params.media — 已上传的素材
   * @param {string} params.account — TikTok 账号（如 @username）
   * @param {string} params.caption — 视频标题
   * @param {string} params.destination — 'publish' 或 'draft'
   * @param {object} params.timing — 调度时间 { kind: 'now'|'once'|'daily'|'weekly', ... }
   * @returns {Promise<object>} 创建的 schedule
   */
  async createPostSchedule({ deviceUdid, media, account, caption, destination = 'publish', timing = { kind: 'now' } }) {
    const body = {
      deviceUdid,
      task: {
        pluginId: 'com.git-agni.tiktok',
        taskType: 'post',
        taskVersion: 1,
        payload: {
          media,
          destination,
          account,
          caption: caption || '',
        },
      },
      timing,
      assetIds: media.map((m) => m.assetId),
    };

    return this._request('POST', '/api/schedules', { body });
  }

  /**
   * 创建 TikTok doomscroll（养号）任务
   *
   * @param {object} params
   * @param {string} params.deviceUdid
   * @param {number} params.durationMinutes — 持续分钟数 1-180
   * @param {string} params.personality — 'skimmer' | 'casual' | 'engaged'
   * @param {boolean} params.likeEnabled
   * @param {boolean} params.saveEnabled
   * @param {string} params.account
   * @param {object} params.timing
   */
  async createDoomscrollSchedule({ deviceUdid, durationMinutes = 15, personality = 'casual', likeEnabled = true, saveEnabled = false, account, timing = { kind: 'now' } }) {
    const body = {
      deviceUdid,
      task: {
        pluginId: 'com.git-agni.tiktok',
        taskType: 'doomscroll',
        taskVersion: 1,
        payload: {
          durationMinutes,
          personality,
          likeEnabled,
          saveEnabled,
          ...(account ? { account } : {}),
        },
      },
      timing,
    };

    return this._request('POST', '/api/schedules', { body });
  }

  /**
   * 获取执行状态
   * @param {string} executionId
   * @returns {Promise<object>} { id, status, logs, error, scheduledFor, ... }
   */
  async getExecution(executionId) {
    return this._request('GET', `/api/executions/${encodeURIComponent(executionId)}`);
  }

  /**
   * 列出执行历史
   * @param {string} deviceUdid — 可选，按设备过滤
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async listExecutions(deviceUdid = null, limit = 50) {
    const query = deviceUdid ? `?deviceUdid=${encodeURIComponent(deviceUdid)}` : '';
    const data = await this._request('GET', `/api/executions${query}`);
    return Array.isArray(data) ? data : (data?.executions || []);
  }

  /**
   * 列出调度任务
   * @param {string} deviceUdid
   * @returns {Promise<Array>}
   */
  async listSchedules(deviceUdid = null) {
    const query = deviceUdid ? `?deviceUdid=${encodeURIComponent(deviceUdid)}` : '';
    const data = await this._request('GET', `/api/schedules${query}`);
    return Array.isArray(data) ? data : (data?.schedules || []);
  }

  /**
   * 停止执行
   * @param {string} executionId
   */
  async stopExecution(executionId) {
    return this._request('POST', `/api/executions/${encodeURIComponent(executionId)}/stop`, {
      body: {},
    });
  }

  /**
   * 重试执行
   * @param {string} executionId
   */
  async retryExecution(executionId) {
    return this._request('POST', `/api/executions/${encodeURIComponent(executionId)}/retry`, {
      body: {},
    });
  }

  /**
   * 取消调度
   * @param {string} scheduleId
   */
  async cancelSchedule(scheduleId) {
    return this._request('POST', `/api/schedules/${encodeURIComponent(scheduleId)}/cancel`, {
      body: { status: 'cancelled' },
    });
  }

  /**
   * 获取已安装的插件列表
   * @returns {Promise<Array>}
   */
  async listPlugins() {
    return this._request('GET', '/api/plugins');
  }
}

/**
 * 从数据库配置创建 IosFarmClient 实例
 * @param {import('./database.js').LocalDatabase} store
 * @returns {IosFarmClient|null}
 */
export function createIosFarmClient(store) {
  const config = store.getPathConfig?.() || {};
  const baseUrl = config.iosFarmBaseUrl || process.env.IOS_FARM_BASE_URL || '';
  const apiKey = config.iosFarmApiKey || process.env.IOS_FARM_API_KEY || null;
  if (!baseUrl) return null;
  return new IosFarmClient(baseUrl, apiKey);
}
