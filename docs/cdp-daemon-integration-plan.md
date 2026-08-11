# CDP Daemon 整合进 yix-new-api 开发计划

## 一、背景与动机

### 1.1 现状

yix 项目的视频复刻 Max 功能通过 `chatgpt-cdp-daemon` 服务操控 ChatGPT 网页端进行视频分析。当前架构：

```
yix worker → 直接 fetch → CDP daemon (:9223) → Playwright → Chrome → ChatGPT 网页
```

daemon 绕过了 yix-new-api 网关，存在以下问题：

1. **脱离统一管理** — 不经过 yix-new-api，无法享受计费、日志、重试、渠道路由等网关能力
2. **文件传输依赖本地路径** — worker 把本地文件路径传给 daemon，要求两者在同一台机器
3. **API 端点网站耦合** — daemon 的端点 `/api/chatgpt/analyze-video` 以网站名命名，未来扩展其他网站（即梦、豆包等）时命名冲突
4. **无法横向扩展** — daemon 部署到不同机器时，本地文件路径不可用

### 1.2 目标

1. **yix-new-api 统一管理所有 AI 调用** — 不管是 API 调用还是网页端自动化，都经过 new-api 网关
2. **daemon 支持多网站** — 统一任务 API，通过 `type` 字段区分不同网站的操作
3. **文件直接上传** — worker 直接上传文件到 daemon（multipart），不经过 Cloudinary 中转
4. **全异步模式** — 所有操作走提交+轮询模式，不强行同步等待
5. **支持跨机器部署** — daemon 可部署在不同机器，文件通过网络传输

### 1.3 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 谁掌握网页操作逻辑 | daemon 封装（fat daemon） | 网页操作有状态、需容错，逻辑和浏览器实例绑定；加新网站只改 daemon（Node.js），不写 Go |
| 文件传输方式 | worker 直接上传到 daemon（multipart） | 避免 Cloudinary 中转；文件传输不是 AI 调用，不需要 new-api 中转 |
| 任务管理模式 | 异步（提交+轮询） | 网页操作慢（5-10 分钟），同步会超时 |
| new-api 集成方式 | 新建 task adaptor 渠道类型 | 和 chengmeng/gxcapi 同一模式，复用现有 task 基础设施 |
| daemon API 命名 | 网站无关（`/api/tasks`、`/api/files`） | 统一入口，通过 `type` 字段区分网站 |
| 认证 | 无 | 内网部署，依赖网络隔离 |

## 二、架构设计

### 2.1 整体架构

```
Worker                              yix-new-api (Go)              CDP Daemon (Node.js)
──────                              ────────────────              ─────────────────────
1. 上传文件 ─────────────────────────────────────────────→  POST /api/files (multipart)
   ← { fileId }                                            → 保存到 /tmp/cdp-{fileId}

2. 提交任务 ──→  POST /v1/videos  ──→  POST /api/tasks  ──→  创建异步任务
   (带 fileId)    (JSON)              (JSON)                →  用 fileId 找到文件
                  ← { id }            ← { taskNo }          →  开始后台处理

3. 轮询    ──→  GET /v1/videos/{id} ──→ GET /api/tasks/{no} ──→ 返回状态+输出
                 ← { status, output }   ← { status, outputs }

4. 下载输出 ←────────────────────────────────────────────  GET /outputs/{filename}
```

### 2.2 分工

| 组件 | 职责 |
|------|------|
| **Worker** | 下载视频到本地（ffprobe 需要）→ 上传文件到 daemon → 通过 new-api 提交任务 → 轮询 → 下载输出 |
| **yix-new-api** | 任务提交+轮询的统一网关，负责计费、日志、重试、渠道路由。Go task adaptor 做格式转换 |
| **CDP Daemon** | 封装网页操作逻辑，暴露统一任务 API。内部根据 `type` 路由到不同网站的 handler |

### 2.3 文件流转

**输入文件**：
```
worker 本地文件 → POST /api/files (multipart) → daemon 保存到 /tmp/cdp-{fileId}/
→ worker 拿到 fileId → 通过 new-api 提交任务（JSON 里带 fileId）
→ new-api 转发给 daemon → daemon 用 fileId 找到本地文件 → Playwright 上传到网页
```

**输出文件**：
```
daemon 从网页提取图片/视频/文件 → 保存到 outputs/ 目录
→ task 结果里返回 http://daemon:9223/outputs/xxx.png
→ new-api 透传给 worker → worker 下载
```

### 2.4 模型名 → 任务类型映射

new-api 根据模型名决定调 daemon 的哪个任务类型。加新网站 = 加新模型 + daemon 加新 handler，Go 代码不用改。

| 模型名 | daemon 任务类型 | 用途 |
|--------|----------------|------|
| `chatgpt-web` | `chatgpt-analyze-video` | ChatGPT 视频分析（当前） |
| `chatgpt-web-chat` | `chatgpt-chat` | ChatGPT 纯文本对话 |
| `chatgpt-web-image` | `chatgpt-generate-image` | 通过 ChatGPT 调 DALL-E 生图（未来） |
| `jimeng-web` | `jimeng-generate-video` | 即梦网页端生视频（未来） |

## 三、开发计划

### Phase 1: CDP Daemon 改造

**项目**：`d:\WILLLUXE\yix-repo\feedaccount\src\chrome-cdp-daemon`
**文件**：`server.mjs` + `package.json`

#### 1.1 修改 package.json

- name 从 `chatgpt-cdp-daemon` 改为 `chrome-cdp-daemon`（未来不只操作 ChatGPT）

#### 1.2 新增文件上传端点

```
POST /api/files
  Content-Type: multipart/form-data
  body: file=<binary>
  返回: { fileId: "file-{timestamp}-{random}", filename: "xxx.mp4", size: 12345 }
```

内部逻辑：
- 解析 multipart（用 Node.js 原生 stream 或轻量解析，不引入额外依赖）
- 保存到 `/tmp/cdp-{fileId}/{filename}`
- 内存 Map 记录 `{fileId → {localPath, filename, size, createdAt}}`
- 定期清理超过 1 小时的临时文件

#### 1.3 新增统一任务 API

```
POST /api/tasks
  Content-Type: application/json
  body: {
    type: "chatgpt-analyze-video",
    params: {
      prompt: "分析这个视频",
      fileIds: ["file-xxx"],
      options: { responseTimeout: 600000 }
    }
  }
  返回: { taskNo: "task-{timestamp}-{random}", status: "pending" }

GET /api/tasks/{taskNo}
  返回: {
    status: "pending" | "running" | "completed" | "failed",
    outputs: [
      { type: "text", content: "分析结果JSON..." },
      { type: "image", url: "http://daemon:9223/outputs/img-xxx.png" },
      { type: "file", url: "http://daemon:9223/outputs/report.pdf", name: "报告.pdf" }
    ],
    error: null,
    progress: "50%"
  }
```

#### 1.4 内部任务路由

```javascript
const taskHandlers = {
  "chatgpt-analyze-video": handleChatGptAnalyzeVideo,
  "chatgpt-chat": handleChatGptChat,
  // 未来扩展:
  // "chatgpt-generate-image": handleChatGptGenerateImage,
  // "jimeng-generate-video": handleJimengGenerateVideo,
}

async function submitTask(type, params) {
  const handler = taskHandlers[type]
  if (!handler) throw new Error(`Unknown task type: ${type}`)
  const taskNo = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  taskStore.set(taskNo, { status: 'pending', outputs: [], error: null, startedAt: Date.now() })
  handler(taskNo, params).catch(err => {
    taskStore.set(taskNo, { status: 'failed', outputs: [], error: err.message })
  })
  return taskNo
}
```

#### 1.5 改造 chatgptAnalyzeVideoAsync

当前签名：
```javascript
async function chatgptAnalyzeVideoAsync({ videoPath, prompt, responseTimeout })
```

改为：
```javascript
async function handleChatGptAnalyzeVideo(taskNo, { prompt, fileIds, options }) {
  // 1. 从 fileIds 解析本地文件路径
  const fileRecord = fileStore.get(fileIds[0])
  if (!fileRecord) throw new Error(`File not found: ${fileIds[0]}`)
  const videoPath = fileRecord.localPath

  // 2. 更新状态为 running
  taskStore.set(taskNo, { ...taskStore.get(taskNo), status: 'running' })

  // 3. 执行现有流程（导航→上传→发送→等待→提取）
  // ... 现有 chatgptAnalyzeVideoAsync 的逻辑搬过来 ...

  // 4. 返回结果到 taskStore
  taskStore.set(taskNo, {
    status: 'completed',
    outputs: [
      { type: 'text', content: response.text }
    ]
  })
}
```

#### 1.6 新增输出文件静态服务

```
GET /outputs/{filename}
  → 返回 outputs/ 目录下的文件
```

```javascript
if (path.startsWith('/outputs/')) {
  const filePath = resolve(__dirname, 'outputs', path.replace('/outputs/', ''))
  if (!existsSync(filePath)) return sendJSON(res, 404, { error: 'File not found' })
  const stream = createReadStream(filePath)
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
  stream.pipe(res)
  return
}
```

#### 1.7 删除旧端点

删除以下端点，统一走 `/api/tasks`：
- `POST /api/chatgpt/send-message`
- `POST /api/chatgpt/upload-file`
- `POST /api/chatgpt/get-response`
- `POST /api/chatgpt/analyze-video`
- `GET /api/chatgpt/analysis-status`
- `GET /api/chatgpt/status`

保留：
- `GET /health` — 健康检查
- `POST /api/execute` — 通用 Playwright 命令执行（调试用）
- `POST /api/screenshot` — 截图（调试用）

### Phase 2: yix-new-api 改造

**项目**：`d:\WILLLUXE\yix-repo\yix-new-api`

#### 2.1 新增渠道类型

**文件**：`constant/channel.go`

```go
ChannelTypeCdpDaemon = 63
// ChannelBaseURLs[63] = "http://localhost:9223"
// ChannelTypeNames[63] = "CdpDaemon"
```

#### 2.2 新建 task adaptor

**目录**：`relay/channel/task/cdpdaemon/`

**constants.go**:
```go
package cdpdaemon

var ModelList = []string{
    "chatgpt-web",       // 视频分析
    "chatgpt-web-chat",  // 纯文本对话
}

var ChannelName = "cdp-daemon"

var modelToTaskType = map[string]string{
    "chatgpt-web":      "chatgpt-analyze-video",
    "chatgpt-web-chat": "chatgpt-chat",
}
```

**adaptor.go** — 实现 TaskAdaptor 接口：

| 方法 | 逻辑 |
|------|------|
| `Init` | 存储 baseURL, apiKey |
| `BuildRequestURL` | `{baseURL}/api/tasks` |
| `BuildRequestHeader` | `Content-Type: application/json`（无 Auth） |
| `BuildRequestBody` | 从标准请求提取 prompt + 文件 ID。模型名→任务类型映射。输出 `{type, params:{prompt, fileIds, options}}` |
| `DoRequest` | `channel.DoTaskApiRequest` |
| `DoResponse` | 解析 `{taskNo}`，返回 taskID |
| `FetchTask` | `GET {baseURL}/api/tasks/{taskNo}` |
| `ParseTaskResult` | daemon 状态映射：pending→queued, running→in_progress, completed→success, failed→failed。outputs 里 text→taskData, image/video/file url→resultUrl |
| `ConvertToOpenAIVideo` | 格式化 outputs 为 OpenAI video 响应 |
| `EstimateBilling` | 按次计费（return nil，用基础价格） |
| `GetModelList` | 返回 ModelList |
| `GetChannelName` | 返回 ChannelName |

**BuildRequestBody 关键逻辑**：
- 从 `req.Metadata.content` 提取 `video_url.url` / `image_url.url` 作为 fileId
- 从 `modelToTaskType` 映射模型名到任务类型
- 构造 `{type, params: {prompt, fileIds, options}}`

**ParseTaskResult 关键逻辑**：
- daemon 状态映射到 new-api 标准状态
- 从 `outputs` 数组找 text 内容存入 task data
- 从 `outputs` 数组找 image/video/file URL 作为 `result_url`

#### 2.3 注册

**文件**：`relay/relay_adaptor.go`
```go
import taskcdpdaemon "github.com/QuantumNous/new-api/relay/channel/task/cdpdaemon"

// 在 GetTaskAdaptor 的 switch 中:
case constant.ChannelTypeCdpDaemon:
    return &taskcdpdaemon.TaskAdaptor{}
```

**文件**：前端 `web/src/features/channels/constants.ts` + `channel-utils.ts`
```typescript
63: 'CdpDaemon',
// display order 加 63
// channel-utils: 63: 'OpenAI'
```

### Phase 3: yix Worker 改造

**项目**：`d:\WILLLUXE\yix-repo\yix`

#### 3.1 改造 cdp-client.ts

**文件**：`apps/ai-worker/src/vr-max/cdp-client.ts`

当前流程：
```
直接调 daemon: POST /api/chatgpt/analyze-video { videoPath }
轮询 daemon: GET /api/chatgpt/analysis-status?jobId=xxx
```

改为：
```typescript
export async function analyzeVideoViaChatGPT(
  params: { videoPath: string; prompt: string; responseTimeout?: number },
  prisma?: any
): Promise<CdpDaemonResponse> {
  const daemonUrl = await getCdpDaemonUrl(prisma)

  // Step 1: 上传文件到 daemon
  const formData = new FormData()
  const fileBuffer = readFileSync(params.videoPath)
  formData.append('file', new Blob([fileBuffer]), basename(params.videoPath))
  const uploadRes = await fetch(`${daemonUrl}/api/files`, { method: 'POST', body: formData })
  const { fileId } = await uploadRes.json()

  // Step 2: 通过 new-api 提交任务
  const { apiKey, baseUrl } = await getUserAIConfig(prisma, userId)
  const route = await resolveUpstreamModelId(prisma, 'chatgpt-web', 'chatgpt-web')
  const submitRes = await fetch(`${baseUrl}/v1/videos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: route.upstreamModelId,
      prompt: params.prompt,
      metadata: {
        content: [{ type: 'video_url', video_url: { url: fileId } }]
      }
    })
  })
  const { id: taskId } = await submitRes.json()

  // Step 3: 通过 new-api 轮询
  while (Date.now() - startTime < totalTimeout) {
    const pollRes = await fetch(`${baseUrl}/v1/videos/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    const pollData = await pollRes.json()
    // 解析状态，返回结果
  }
}
```

#### 3.2 handlers.ts 微调

**文件**：`apps/ai-worker/src/vr-max/handlers.ts`

`handlers.ts:45-64` 基本不变 — 仍然需要 `resolveLocalVideoPath` 下载视频到本地（ffprobe 需要），然后传本地路径给 `analyzeVideoViaChatGPT`。cdp-client 内部会把这个本地文件上传到 daemon。

### Phase 4: 配置

#### 4.1 yix-new-api 后台

新建渠道：
- 类型：CdpDaemon
- Base URL：`http://localhost:9223`（或 daemon 所在机器 IP）
- Key：随意（daemon 不验证）
- 模型：`chatgpt-web`

#### 4.2 yix model-mappings

- `chatgpt-web-analysis` → `chatgpt-web`（路由到 CdpDaemon 渠道）

#### 4.3 yix systemconfig

- `VRM_CDP_DAEMON_URL` = `http://<daemon机器>:9223`（worker 用这个地址上传文件）

## 四、实施顺序

| 步骤 | 项目 | 内容 | 依赖 |
|------|------|------|------|
| 1 | feedaccount | daemon: 改 package.json name | 无 |
| 2 | feedaccount | daemon: 加 `POST /api/files` 文件上传 | 无 |
| 3 | feedaccount | daemon: 加 `POST /api/tasks` + `GET /api/tasks/{id}` 统一任务 API | 步骤 2 |
| 4 | feedaccount | daemon: 加 `GET /outputs/` 静态文件服务 | 无 |
| 5 | feedaccount | daemon: 改造 `chatgptAnalyzeVideoAsync` → `handleChatGptAnalyzeVideo`，接受 fileIds | 步骤 2-3 |
| 6 | feedaccount | daemon: 删除旧 `/api/chatgpt/*` 端点 | 步骤 3-5 |
| 7 | yix-new-api | 加渠道类型 63 + task adaptor | 步骤 3 |
| 8 | yix-new-api | 前端加渠道选项 | 步骤 7 |
| 9 | yix | 改 cdp-client.ts（上传文件 + 调 new-api） | 步骤 5-7 |
| 10 | yix | 改 handlers.ts（适配新 cdp-client） | 步骤 9 |
| 11 | 全部 | 配置渠道 + model-mappings + 端到端测试 | 全部 |

## 五、未来扩展方向

1. **即梦网页端** — 在 daemon 加 `handlers/jimeng.ts` + 注册 `jimeng-generate-video` 任务类型。new-api 渠道配置加模型 `jimeng-web`。零 Go 代码改动。

2. **ChatGPT 生图** — 在 daemon 加 `chatgpt-generate-image` 任务类型，通过 ChatGPT 调 DALL-E 生成图片，从页面提取图片保存到 `outputs/`。

3. **多模态输出提取** — 当前只提取文本。未来从 ChatGPT 页面提取生成的图片、文件下载链接，保存到 `outputs/` 并在 task 结果的 `outputs` 数组里返回。

4. **流式响应** — 如果需要实时展示 ChatGPT 的回复进度，daemon 可以用 SSE（Server-Sent Events）流式返回文本块。

5. **daemon 集群** — 多个 daemon 实例连接不同 Chrome，new-api 通过权重/优先级分流。

6. **直接上传到 daemon 的 multipart 任务提交** — 当前设计是先上传文件（`POST /api/files`）再提交任务（`POST /api/tasks`）。未来可以合并为一步：`POST /api/tasks` 直接接受 multipart（文件 + 任务参数），减少一次 HTTP 往返。
