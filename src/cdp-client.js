import net from "node:net";
import crypto from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class CdpClient {
  constructor() {
    this.socket = null;
    this.state = "idle";
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.pending = new Map();
    this.eventWaiters = [];
    this.fragmentOpcode = null;
    this.fragmentParts = [];
  }

  async connect(wsUrl, timeoutMs = 10000) {
    if (this.state !== "idle" && this.state !== "closed") {
      throw new Error("CDP 客户端已经连接或正在连接");
    }

    const url = new URL(wsUrl);
    if (url.protocol !== "ws:") {
      throw new Error("当前仅支持本机 ws:// 调试地址");
    }

    const host = url.hostname;
    const port = Number(url.port || 80);
    const path = `${url.pathname}${url.search}`;
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error("出于安全考虑，仅允许连接本机 BitBrowser 调试端口");
    }
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");

    this.state = "connecting";
    this.buffer = Buffer.alloc(0);
    this.socket = new net.Socket();

    const connected = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        this.state = "closed";
        this.socket.destroy();
        finish(reject, new Error("连接 BitBrowser 调试端口超时"));
      }, timeoutMs);

      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.state === "handshake") {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;

          const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
          this.buffer = this.buffer.subarray(headerEnd + 4);
          const lines = headerText.split("\r\n");
          const headers = new Map();
          for (const line of lines.slice(1)) {
            const separator = line.indexOf(":");
            if (separator > 0) {
              headers.set(
                line.slice(0, separator).trim().toLowerCase(),
                line.slice(separator + 1).trim(),
              );
            }
          }

          if (!/^HTTP\/1\.1 101\b/.test(lines[0] || "")) {
            finish(reject, new Error(`调试连接握手失败：${lines[0] || "未知响应"}`));
            this.socket.destroy();
            return;
          }
          if (headers.get("sec-websocket-accept") !== expectedAccept) {
            finish(reject, new Error("调试连接握手校验失败"));
            this.socket.destroy();
            return;
          }

          this.state = "open";
          finish(resolve);
        }

        if (this.state === "open") {
          try {
            this.#parseFrames();
          } catch (error) {
            this.#fail(error);
          }
        }
      });

      this.socket.on("error", (error) => {
        finish(reject, new Error(`调试连接失败：${error.message}`));
        this.#fail(error);
      });
      this.socket.on("close", () => {
        if (this.state !== "closed") {
          const error = new Error("BitBrowser 调试连接已断开");
          finish(reject, error);
          this.#fail(error);
        }
      });

      this.socket.connect(port, host, () => {
        this.state = "handshake";
        this.socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${host}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });

    await connected;
  }

  call(method, params = {}, sessionId = null, timeoutMs = 15000) {
    if (this.state !== "open") {
      return Promise.reject(new Error("BitBrowser 调试连接不可用"));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 执行超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#sendJson({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  waitForEvent(method, { sessionId = null, predicate = null, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`${method} 等待超时`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    try {
      this.#sendFrame(Buffer.alloc(0), 8);
    } catch {
      // The socket may already be closed.
    }
    this.socket?.end();
    this.socket?.destroy();
    this.#rejectAll(new Error("调试连接已关闭"));
  }

  #sendJson(value) {
    this.#sendFrame(Buffer.from(JSON.stringify(value), "utf8"), 1);
  }

  #sendFrame(payload, opcode) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("调试连接不可用");
    }

    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] ^= mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  #parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_FRAME_BYTES)) {
          throw new Error("调试端口返回的数据帧过大");
        }
        length = Number(bigLength);
        offset = 10;
      }

      if (length > MAX_FRAME_BYTES) {
        throw new Error("调试端口返回的数据帧过大");
      }

      const maskBytes = masked ? 4 : 0;
      const frameLength = offset + maskBytes + length;
      if (this.buffer.length < frameLength) return;

      let mask;
      if (masked) {
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(frameLength);
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 8) {
        this.close();
        return;
      }
      if (opcode === 9) {
        this.#sendFrame(payload, 10);
        continue;
      }
      if (opcode === 10) continue;

      if (opcode === 1 || opcode === 2) {
        this.fragmentOpcode = opcode;
        this.fragmentParts = [payload];
      } else if (opcode === 0 && this.fragmentOpcode !== null) {
        this.fragmentParts.push(payload);
      } else {
        continue;
      }

      if (final) {
        const complete = Buffer.concat(this.fragmentParts);
        const completeOpcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragmentParts = [];
        if (completeOpcode === 1) this.#handleMessage(complete.toString("utf8"));
      }
    }
  }

  #handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP 命令执行失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (let index = this.eventWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.eventWaiters[index];
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      if (waiter.predicate && !waiter.predicate(message.params)) continue;

      this.eventWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  #fail(error) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.socket?.destroy();
    this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.eventWaiters = [];
  }
}
