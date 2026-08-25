/**
 * ComfyUI 网关模块
 * 
 * 把 ComfyUI 的 4 步 API 调用（上传图→提交工作流→轮询→下载结果）
 * 封装成一个简单的 POST /api/comfyui/edit 端点。
 * 
 * 调用方只需：POST 一个 multipart 表单（image + instruction），直接拿回编辑后的图片。
 */

import { readFile, writeFile, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── 配置 ──────────────────────────────────────────────
const DEFAULT_COMFYUI_HOST = "http://127.0.0.1:8189";
const DEFAULT_WORKFLOW_DIR = "F:/Comfy-Desktop/api";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300_000; // 5 分钟超时

// 运行时配置（由外部通过 updateConfig 设置）
let runtimeConfig = {
  comfyuiHost: DEFAULT_COMFYUI_HOST,
  workflowDir: DEFAULT_WORKFLOW_DIR,
};

/** 更新运行时配置（由 server.js 在收到配置变更时调用） */
export function updateComfyuiConfig(config) {
  if (config?.comfyuiHost) runtimeConfig.comfyuiHost = config.comfyuiHost;
  if (config?.workflowDir) runtimeConfig.workflowDir = config.workflowDir;
  // 清除缓存
  objectInfoCache = null;
}

function getHost() {
  return runtimeConfig.comfyuiHost;
}

function getWorkflowPath(workflowName) {
  const dir = runtimeConfig.workflowDir;
  // 支持 .json 扩展名省略
  const name = workflowName.endsWith(".json") ? workflowName : `${workflowName}.json`;
  return path.join(dir, name);
}

// ── 内联 multipart 解析（不依赖第三方库）──────────────
/**
 * 从 multipart/form-data 请求体中提取字段
 * @returns {{ fields: Record<string,string>, files: Record<string,{name:string,data:Buffer}> }}
 */
async function parseMultipart(request) {
  const contentType = request.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error("缺少 multipart boundary");

  const boundary = "--" + boundaryMatch[1];
  const chunks = [];
  let size = 0;
  const MAX_BODY = 50 * 1024 * 1024; // 50MB

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体过大（>50MB）");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const fields = {};
  const files = {};

  // 按 boundary 分割
  const parts = body.split(Buffer.from(boundary));
  for (const part of parts) {
    if (part.length === 0 || part.toString("utf8").trim() === "--") continue;

    // 去掉头尾 \r\n
    let buf = part;
    if (buf[0] === 0x0d && buf[1] === 0x0a) buf = buf.subarray(2);
    if (buf[buf.length - 2] === 0x0d && buf[buf.length - 1] === 0x0a) buf = buf.subarray(0, buf.length - 2);

    // 分离 header 和 body
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerStr = buf.subarray(0, headerEnd).toString("utf8");
    const data = buf.subarray(headerEnd + 4);

    // 解析 Content-Disposition
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    if (filenameMatch) {
      files[fieldName] = {
        name: filenameMatch[1],
        data: data,
      };
    } else {
      fields[fieldName] = data.toString("utf8");
    }
  }

  return { fields, files };
}

// ── ComfyUI API 封装 ──────────────────────────────────
async function uploadImage(imageBuffer, filename) {
  const boundary = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
  const parts = [];

  // image 字段
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
        `Content-Type: image/png\r\n\r\n`
    )
  );
  parts.push(imageBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}\r\n`));
  parts.push(
    Buffer.from(
      `Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
        `--${boundary}\r\n`
    )
  );
  parts.push(Buffer.from(`Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(`${getHost()}/upload/image`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    },
    body: body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`上传图片失败 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.name; // 服务器端文件名
}

async function submitWorkflow(workflow) {
  const res = await fetch(`${getHost()}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "feedaccount-gateway" }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`提交工作流失败 (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`工作流验证失败: ${JSON.stringify(data.node_errors).slice(0, 500)}`);
  }

  return data.prompt_id;
}

async function pollResult(promptId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${getHost()}/history/${promptId}`);
    if (!res.ok) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const data = await res.json();
    const entry = data[promptId];

    if (entry) {
      // 检查是否有错误
      const status = entry.status;
      if (status?.status_str === "error") {
        const errMsg = (status.messages || [])
          .filter((m) => m[0] === "execution_error")
          .map((m) => m[1]?.exception_message || "")
          .join("; ");
        throw new Error(`执行错误: ${errMsg || status.status_str}`);
      }

      const outputs = entry.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const nodeOutput = outputs[nodeId];
        // SaveImage 节点输出 images 数组
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          return nodeOutput.images[0]; // { filename, subfolder, type }
        }
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("等待结果超时");
}

async function downloadResult(imageInfo) {
  const params = new URLSearchParams({
    filename: imageInfo.filename,
    subfolder: imageInfo.subfolder || "",
    type: imageInfo.type || "output",
  });

  const res = await fetch(`${getHost()}/view?${params}`);
  if (!res.ok) throw new Error(`下载结果失败 (${res.status})`);

  return Buffer.from(await res.arrayBuffer());
}

// ── 工作流格式转换（编辑器格式 → API 格式）────────────
/**
 * 将 ComfyUI 编辑器格式（nodes+links 数组）转换为 API 格式（{id:{class_type,inputs}}）
 * 这是核心转换逻辑，让用户只需 Ctrl+S 保存工作流即可，无需导出 API 格式。
 */
async function convertEditorToApi(editorWorkflow, objectInfo) {
  const nodes = editorWorkflow.nodes || [];
  const links = editorWorkflow.links || [];

  // 构建 link 查找表: link_id → [origin_node, origin_slot]
  const linkMap = {};
  for (const link of links) {
    // link 格式: [link_id, origin_node, origin_slot, target_node, target_slot, type]
    linkMap[link[0]] = [String(link[1]), link[2]];
  }

  // 处理子图：把子图内的节点也展开
  const subgraphs = editorWorkflow.definitions?.subgraphs || [];
  const subgraphNodes = [];
  for (const sg of subgraphs) {
    for (const n of sg.nodes || []) {
      // 子图节点的 ID 可能与顶层冲突，但通常不会
      subgraphNodes.push(n);
    }
  }
  const allNodes = [...nodes, ...subgraphNodes];

  const apiWorkflow = {};

  for (const node of allNodes) {
    const nodeType = node.type;
    const nodeId = String(node.id);

    // 跳过注释节点和虚拟节点
    if (nodeType === "MarkdownNote" || nodeType === "Note" || nodeType === "Reroute") {
      continue;
    }

    // 跳过子图容器节点（type 是 UUID）
    if (nodeType.length > 36 && /^[0-9a-f-]+$/i.test(nodeType)) {
      continue;
    }

    const inputs = {};
    const nodeDef = objectInfo[nodeType];

    // 处理连接的输入
    const connectedInputs = new Set();
    for (const inp of node.inputs || []) {
      if (inp.link !== null && inp.link !== undefined) {
        const origin = linkMap[inp.link];
        if (origin) {
          inputs[inp.name] = origin;
          connectedInputs.add(inp.name);
        }
      }
    }

    // 处理 widget 值
    const widgetValues = node.widgets_values || [];
    let widgetIdx = 0;

    if (nodeDef) {
      // 从 object_info 获取输入定义，按顺序匹配 widget_values
      const requiredInputs = nodeDef.input?.required || {};
      const optionalInputs = nodeDef.input?.optional || {};
      const allInputDefs = { ...requiredInputs, ...optionalInputs };

      for (const [inputName, inputDef] of Object.entries(allInputDefs)) {
        // 跳过已连接的输入
        if (connectedInputs.has(inputName)) {
          // 但仍需要消费对应的 widget 值（如果有）
          // 实际上，连接的输入通常不消费 widget 值
          continue;
        }

        // 判断这个输入是否是 widget-backed（有默认值/选项，而非纯连接端口）
        // widget 类型：STRING, INT, FLOAT, BOOLEAN, COMBO 等
        const inputType = Array.isArray(inputDef) ? inputDef[0] : inputDef;
        const isWidget =
          ["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"].includes(inputType) ||
          (Array.isArray(inputDef) &&
            ["STRING", "INT", "FLOAT", "BOOLEAN"].includes(inputDef[0]));

        if (isWidget && widgetIdx < widgetValues.length) {
          // 跳过 advanced 类型的 widget（ComfyUI 前端也会跳过，除非展开高级选项）
          const config = Array.isArray(inputDef) ? inputDef[1] : {};
          if (config?.advanced) {
            // advanced widget 仍需要消费一个值（如果它在 widgets_values 数组中）
            // 但实际位置取决于前端是否展开高级选项。这里保守跳过。
            // 注意：这可能导致 widget_values 错位，但大部分常见工作流不会用 advanced widget。
            widgetIdx++;
            continue;
          }

          let value = widgetValues[widgetIdx];
          widgetIdx++;

          // 处理特殊 widget 值（如 COMBO 的选项）
          if (inputType === "COMBO" || (Array.isArray(inputDef) && inputDef[0] === "COMBO")) {
            // COMBO 的值就是选项字符串，直接用
            inputs[inputName] = value;
          } else {
            inputs[inputName] = value;
          }
        }
      }
    } else {
      // 未知节点类型，尽力把所有 widget 值按输入名填入
      // 按输入数组顺序匹配
      for (const inp of node.inputs || []) {
        if (inp.link === null && widgetIdx < widgetValues.length) {
          inputs[inp.name] = widgetValues[widgetIdx];
          widgetIdx++;
        }
      }
    }

    apiWorkflow[nodeId] = {
      class_type: nodeType,
      inputs: inputs,
    };
  }

  return apiWorkflow;
}

// ── object_info 缓存 ───────────────────────────────────
let objectInfoCache = null;
let objectInfoCacheTime = 0;
const OBJECT_INFO_TTL = 60_000; // 1 分钟缓存

async function getObjectInfo() {
  if (objectInfoCache && Date.now() - objectInfoCacheTime < OBJECT_INFO_TTL) {
    return objectInfoCache;
  }

  const res = await fetch(`${getHost()}/object_info`);
  if (!res.ok) throw new Error(`获取 object_info 失败 (${res.status})`);

  objectInfoCache = await res.json();
  objectInfoCacheTime = Date.now();
  return objectInfoCache;
}

// ── 工作流模板加载与注入 ────────────────────────────────
/**
 * 加载工作流模板，自动检测格式（编辑器格式 or API 格式），
 * 转换为 API 格式，注入图片名和编辑指令。
 * 
 * 支持两种格式：
 * - 编辑器格式（有 nodes/links 数组）→ 自动转换
 * - API 格式（有 class_type 键）→ 直接使用
 */
async function buildWorkflow(workflowName, imageName, instruction, megapixels) {
  const templatePath = getWorkflowPath(workflowName);
  const raw = await readFile(templatePath, "utf8");
  const wf = JSON.parse(raw);

  let apiWorkflow;

  // 自动检测格式
  if (wf.nodes && Array.isArray(wf.nodes)) {
    // 编辑器格式，需要转换
    const objectInfo = await getObjectInfo();
    apiWorkflow = convertEditorToApi(wf, objectInfo);
    console.log("[comfyui-gateway] 编辑器格式已自动转换为 API 格式");
  } else {
    // 已经是 API 格式
    apiWorkflow = wf;
  }

  // 智能注入参数：按节点类型查找，而不是硬编码 ID
  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    const ct = node.class_type;

    // LoadImage 节点 → 注入图片名
    if (ct === "LoadImage" || ct === "LoadImageMask" || ct === "LoadImageUpload") {
      if (node.inputs.image !== undefined) {
        node.inputs.image = imageName;
      }
    }

    // TextEncodeQwenImageEdit 节点 → 注入编辑指令
    // 策略：找到两个 TextEncodeQwenImageEdit 节点，
    // 第一个填正面指令（instruction），第二个填负面指令（如果有的话）
    if (ct === "TextEncodeQwenImageEdit" || ct === "TextEncodeQwenImageEditPlus") {
      if (node._promptRole !== "negative") {
        node.inputs.prompt = instruction;
      }
      // 负面提示词保持原样不注入
    }

    // ImageScaleToTotalPixels 节点 → 注入分辨率
    if (ct === "ImageScaleToTotalPixels" && megapixels !== undefined) {
      if (node.inputs.megapixels !== undefined) {
        node.inputs.megapixels = megapixels;
      }
    }
  }

  return apiWorkflow;
}

// ── 主处理函数 ────────────────────────────────────────
/**
 * 处理 POST /api/comfyui/edit 请求
 * 接收 multipart 表单：image（文件）+ instruction（文本）+ 可选 megapixels
 * 返回编辑后的图片
 */
export async function handleComfyuiEdit(request, response) {
  try {
    const { fields, files } = await parseMultipart(request);

    if (!files.image) {
      sendJsonResponse(response, 400, { error: "缺少 image 字段" });
      return;
    }

    const instruction = fields.instruction || "";
    if (!instruction) {
      sendJsonResponse(response, 400, { error: "缺少 instruction 字段" });
      return;
    }

    // 工作流名称（可选，默认 qwen_edit_2511_api）
    const workflowName = fields.workflow || "qwen_edit_2511_api";
    const megapixels = fields.megapixels ? parseFloat(fields.megapixels) : undefined;

    // 1. 上传图片到 ComfyUI
    const imageName = await uploadImage(files.image.data, files.image.name);

    // 2. 构建工作流（按名称从配置的工作流目录读取）
    const workflow = await buildWorkflow(workflowName, imageName, instruction, megapixels);

    // 3. 提交工作流
    const promptId = await submitWorkflow(workflow);

    // 4. 轮询等待结果
    const imageInfo = await pollResult(promptId);

    // 5. 下载结果
    const resultBuffer = await downloadResult(imageInfo);

    // 6. 返回图片
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": resultBuffer.length,
      "Cache-Control": "no-store",
      "X-Result-Filename": imageInfo.filename,
    });
    response.end(resultBuffer);
  } catch (err) {
    console.error("[comfyui-gateway] 错误:", err.message);
    sendJsonResponse(response, 500, { error: err.message });
  }
}

// ── 辅助函数 ──────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
