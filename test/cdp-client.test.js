import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";

import { CdpClient } from "../src/cdp-client.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readClientFrame(buffer) {
  if (buffer.length < 6) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 8) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return {
    opcode: buffer[0] & 0x0f,
    text: payload.toString("utf8"),
    rest: buffer.subarray(offset + length),
  };
}

test("CdpClient completes a local websocket handshake and CDP call", async () => {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 4);
        const key = /Sec-WebSocket-Key:\s*(.+)\r\n/i.exec(header)?.[1].trim();
        const accept = crypto.createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        handshaken = true;
      }

      let frame;
      while ((frame = readClientFrame(buffer))) {
        buffer = frame.rest;
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.text);
        if (message.method === "Browser.getVersion") {
          socket.write(
            serverFrame(JSON.stringify({ id: message.id, result: { product: "Chrome/Test" } })),
          );
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = new CdpClient();
  try {
    await client.connect(`ws://127.0.0.1:${address.port}/devtools/browser/test`);
    const result = await client.call("Browser.getVersion");
    assert.equal(result.product, "Chrome/Test");
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
