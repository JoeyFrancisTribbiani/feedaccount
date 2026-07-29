import net from "node:net";
import tls from "node:tls";

const STAGE_GREETING = 0;
const STAGE_AUTH = 1;
const STAGE_CONNECT = 2;
const STAGE_TLS = 3;

const STAGE_NAMES = ["GREETING", "AUTH", "CONNECT", "TLS"];

function log(msg) {
  console.error(`[socks5-check] ${msg}`);
}

export function checkIpViaSocks5({
  host,
  port,
  username = "",
  password = "",
  targetHost = "api.ipify.org",
  targetPort = 443,
  timeoutMs = 12000,
}) {
  return new Promise((resolve, reject) => {
    log(`连接代理 ${host}:${port}（认证：${username ? "有" : "无"}）→ 目标 ${targetHost}:${targetPort}`);
    const socket = net.createConnection({ host, port: Number(port) });
    let stage = STAGE_GREETING;
    let buffer = Buffer.alloc(0);
    let tlsSocket = null;
    let httpBuffer = "";
    let resolved = false;

    const done = (fn, value) => {
      if (resolved) return;
      resolved = true;
      fn(value);
    };

    const timer = setTimeout(() => {
      log(`超时（${timeoutMs}ms），当前阶段：${STAGE_NAMES[stage]}`);
      socket.destroy();
      tlsSocket?.destroy();
      done(reject, new Error(`SOCKS5 代理检测超时（阶段：${STAGE_NAMES[stage]}）`));
    }, timeoutMs);

    const send = (data) => socket.write(Buffer.from(data));

    const sendConnectRequest = () => {
      const targetBuf = Buffer.from(targetHost);
      const req = Buffer.alloc(7 + targetBuf.length);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = targetBuf.length;
      targetBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + targetBuf.length);
      send(req);
      log(`已发送 CONNECT 请求 → ${targetHost}:${targetPort}`);
    };

    socket.on("connect", () => {
      log(`TCP 已连接到 ${host}:${port}`);
      if (username && password) {
        send([0x05, 0x01, 0x02]);
        log("已发送握手：请求用户名密码认证");
      } else {
        send([0x05, 0x01, 0x00]);
        log("已发送握手：请求无认证");
      }
    });

    socket.on("data", (chunk) => {
      if (stage === STAGE_TLS) return;

      buffer = Buffer.concat([buffer, chunk]);

      if (stage === STAGE_GREETING) {
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.subarray(2);
        log(`握手响应：认证方法=${method === 0x00 ? "无认证" : method === 0x02 ? "用户名密码" : `不支持(0x${method.toString(16)})`}`);

        if (method === 0x02) {
          stage = STAGE_AUTH;
          const u = Buffer.from(username);
          const p = Buffer.from(password);
          const auth = Buffer.alloc(3 + u.length + p.length);
          auth[0] = 0x01;
          auth[1] = u.length;
          u.copy(auth, 2);
          auth[2 + u.length] = p.length;
          p.copy(auth, 3 + u.length);
          send(auth);
          log("已发送认证凭据");
        } else if (method === 0x00) {
          stage = STAGE_CONNECT;
          sendConnectRequest();
        } else {
          socket.destroy();
          clearTimeout(timer);
          log("代理不支持的认证方法");
          done(reject, new Error("SOCKS5 代理不支持的认证方法"));
        }
      } else if (stage === STAGE_AUTH) {
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.subarray(2);
        log(`认证结果：${status === 0x00 ? "成功" : `失败(0x${status.toString(16)})`}`);

        if (status !== 0x00) {
          socket.destroy();
          clearTimeout(timer);
          done(reject, new Error("SOCKS5 代理认证失败"));
          return;
        }
        stage = STAGE_CONNECT;
        sendConnectRequest();
      } else if (stage === STAGE_CONNECT) {
        if (buffer.length < 4) return;
        const rep = buffer[1];
        const REP_MSGS = {
          0x01: "一般性失败", 0x02: "规则不允许", 0x03: "网络不可达",
          0x04: "主机不可达", 0x05: "连接被拒绝", 0x06: "TTL 过期",
          0x07: "不支持的命令", 0x08: "不支持的地址类型",
        };
        if (rep !== 0x00) {
          socket.destroy();
          clearTimeout(timer);
          const msg = REP_MSGS[rep] || `错误码 0x${rep.toString(16)}`;
          log(`CONNECT 失败：${msg}`);
          done(reject, new Error(`SOCKS5 代理连接失败：${msg}`));
          return;
        }
        log("CONNECT 成功，开始 TLS 握手");

        stage = STAGE_TLS;
        tlsSocket = tls.connect(
          { socket, servername: targetHost, rejectUnauthorized: true },
          () => {
            log("TLS 握手成功，发送 HTTPS 请求");
            const req = `GET /format=json HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
            tlsSocket.write(req);
          },
        );

        tlsSocket.on("data", (tlsChunk) => {
          httpBuffer += tlsChunk.toString();
        });

        tlsSocket.on("end", () => {
          clearTimeout(timer);
          log(`收到响应，长度=${httpBuffer.length} 字节`);
          const sep = httpBuffer.indexOf("\r\n\r\n");
          if (sep === -1) {
            log(`响应无 HTTP 头分隔符，原始内容前200字符：${httpBuffer.substring(0, 200)}`);
            done(resolve, null);
            return;
          }
          const header = httpBuffer.substring(0, sep);
          const body = httpBuffer.substring(sep + 4).trim();
          log(`响应头：${header.replace(/\r\n/g, " | ")}`);
          log(`响应体：${body.substring(0, 200)}`);

          if (/^[0-9a-fA-F]+\r\n/.test(body)) {
            const lines = body.split("\r\n");
            let decoded = "";
            for (let i = 0; i < lines.length; i += 2) {
              const size = parseInt(lines[i], 16);
              if (!size) break;
              decoded += lines[i + 1] || "";
            }
            try {
              const ip = JSON.parse(decoded).ip || null;
              log(`解析成功（chunked）：IP=${ip}`);
              done(resolve, ip);
            } catch (e) {
              log(`JSON 解析失败（chunked）：${e.message}，decoded=${decoded.substring(0, 100)}`);
              done(resolve, null);
            }
            return;
          }
          try {
            const ip = JSON.parse(body).ip || null;
            log(`解析成功：IP=${ip}`);
            done(resolve, ip);
          } catch (e) {
            log(`JSON 解析失败：${e.message}，body=${body.substring(0, 100)}`);
            done(resolve, null);
          }
        });

        tlsSocket.on("error", (err) => {
          clearTimeout(timer);
          log(`TLS 错误：${err.message}`);
          done(reject, new Error(`TLS握手失败：${err.message}`));
        });
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      log(`TCP 错误（阶段 ${STAGE_NAMES[stage]}）：${err.message}`);
      done(reject, err);
    });

    socket.on("close", (hadError) => {
      if (!resolved && stage !== STAGE_TLS) {
        log(`连接关闭（阶段 ${STAGE_NAMES[stage]}，hadError=${hadError}）`);
        done(reject, new Error(`代理连接在 ${STAGE_NAMES[stage]} 阶段被关闭`));
      }
    });
  });
}
