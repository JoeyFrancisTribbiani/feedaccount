import net from "node:net";
import tls from "node:tls";

const STAGE_GREETING = 0;
const STAGE_AUTH = 1;
const STAGE_CONNECT = 2;
const STAGE_TLS = 3;

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
    const socket = net.createConnection({ host, port: Number(port) });
    let stage = STAGE_GREETING;
    let buffer = Buffer.alloc(0);
    let tlsSocket = null;
    let httpBuffer = "";

    const timer = setTimeout(() => {
      socket.destroy();
      tlsSocket?.destroy();
      reject(new Error("SOCKS5 代理检测超时"));
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
    };

    socket.on("connect", () => {
      if (username && password) {
        send([0x05, 0x01, 0x02]);
      } else {
        send([0x05, 0x01, 0x00]);
      }
    });

    socket.on("data", (chunk) => {
      if (stage === STAGE_TLS) return;

      buffer = Buffer.concat([buffer, chunk]);

      if (stage === STAGE_GREETING) {
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.subarray(2);

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
        } else if (method === 0x00) {
          stage = STAGE_CONNECT;
          sendConnectRequest();
        } else {
          socket.destroy();
          clearTimeout(timer);
          reject(new Error("SOCKS5 代理不支持的认证方法"));
        }
      } else if (stage === STAGE_AUTH) {
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.subarray(2);

        if (status !== 0x00) {
          socket.destroy();
          clearTimeout(timer);
          reject(new Error("SOCKS5 代理认证失败"));
          return;
        }
        stage = STAGE_CONNECT;
        sendConnectRequest();
      } else if (stage === STAGE_CONNECT) {
        if (buffer.length < 4) return;
        const rep = buffer[1];
        if (rep !== 0x00) {
          socket.destroy();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 代理连接失败（错误码 ${rep}）`));
          return;
        }

        stage = STAGE_TLS;
        tlsSocket = tls.connect(
          { socket, servername: targetHost, rejectUnauthorized: true },
          () => {
            const req = `GET /format=json HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
            tlsSocket.write(req);
          },
        );

        tlsSocket.on("data", (tlsChunk) => {
          httpBuffer += tlsChunk.toString();
        });

        tlsSocket.on("end", () => {
          clearTimeout(timer);
          const sep = httpBuffer.indexOf("\r\n\r\n");
          if (sep === -1) {
            resolve(null);
            return;
          }
          const body = httpBuffer.substring(sep + 4).trim();
          if (/^[0-9a-fA-F]+\r\n/.test(body)) {
            const lines = body.split("\r\n");
            let decoded = "";
            for (let i = 0; i < lines.length; i += 2) {
              const size = parseInt(lines[i], 16);
              if (!size) break;
              decoded += lines[i + 1] || "";
            }
            try {
              resolve(JSON.parse(decoded).ip || null);
            } catch {
              resolve(null);
            }
            return;
          }
          try {
            resolve(JSON.parse(body).ip || null);
          } catch {
            resolve(null);
          }
        });

        tlsSocket.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`TLS握手失败：${err.message}`));
        });
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
