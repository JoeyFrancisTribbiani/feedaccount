# iOS Farm 适配器代码审查报告

**审查范围**：`src/ios-farm-client.js`、`src/tiktok/tiktok-publish-manager.js`、`src/server.js`（iOS Farm 路由段）、`public/app.js`（路径配置 + 绑定实例下拉框）、`public/index.html`（iOS Farm 输入框）

**审查方式**：静态阅读源码，交叉比对数据流转链路（`createTkPublishJob` → `_executeViaIosFarm`）。未修改任何代码。

**严重程度分级**：🔴 高危（影响功能正确性/数据安全）、🟡 中危（边界/健壮性问题）、🟢 低危（可维护性/规范）。

---

## 一、ios-farm-client.js

### 🔴 高危-1：`uploadAsset` 的 multipart 缺少 `Content-Length`，且对部分后端可能导致截断

**位置**：`ios-farm-client.js:121-134`

`Buffer.concat([...])` 生成完整 body 后，使用原生 `fetch` 发送。Node 的 `fetch`（undici）对 `Buffer`/`Uint8Array` body 会自动计算并设置 `Content-Length`，这点没问题。但需确认 prod-FARM-IOS-Core 的 `POST /api/assets`（multer/busboy 等解析器）能正确识别该 boundary —— 当前 boundary 格式 `----IosFarmUpload<timestamp>` 是合法的（以 `--` 开头），multipart 语法正确。

**真正风险点**：`filename="${name}"` 未对 `name` 中的双引号/换行做转义。若 `fileName` 含 `"` 或 `\r\n`（极端情况下文件名含特殊字符），会破坏 multipart 帧结构，导致解析失败或 header 注入。建议对 `name` 做 `name.replace(/"/g, '\\"')` 处理。

### 🟡 中危-1：`readFileSync` 同步阻塞事件循环

**位置**：`ios-farm-client.js:100`

```js
const buffer = readFileSync(localPath);
```

`uploadAsset` 在发布调度器主循环中被调用（`_executeViaIosFarm` → `uploadAsset`）。混剪成品 MP4 通常 10-100MB，`readFileSync` 会阻塞 Node 事件循环数百毫秒到数秒，期间 SSE 推送、其他 HTTP 请求、调度器心跳全部卡住。应改用 `await readFile(localPath)`（异步）或流式上传（`fs.createReadStream` + 流式 multipart，避免一次性把整个视频读进内存）。

### 🟡 中危-2：`_request` 中 `instanceof FormData` 判断在 Node 环境的可靠性

**位置**：`ios-farm-client.js:37`

```js
if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
```

Node 18+ 全局有 `FormData`，判断本身成立。但本类所有调用点（`createPostSchedule`/`createDoomscrollSchedule`/`stopExecution` 等）传入的都是普通对象，从不传 `FormData`，因此该分支永远进入 JSON 序列化路径 —— 这是冗余但无害的防御代码。仅作记录。

### 🟢 低危-1：路径转换逻辑正确，与 Playwright 模式一致

**位置**：`ios-farm-client.js:96-98`

```js
if (/^\/data\//.test(filePath)) {
  localPath = path.join(path.dirname(getOutputDir()), filePath.replace(/^\/data\//, ''));
}
```

与 `tiktok-publisher.js:161-162` 完全一致。`getOutputDir()` 返回 `data/remix-output`（或自定义目录），`path.dirname()` 得到 `data/`，`/data/remix-output/xxx.mp4` → `data/remix-output/xxx.mp4`。经核对 `server.js:458/467` 确认 `outputUrl` 确以 `/data/remix-output/` 存储，转换正确。✅

### 🟢 低危-2：`createPostSchedule` payload 结构

**位置**：`ios-farm-client.js:162-181`

payload 结构 `{ deviceUdid, task: { pluginId, taskType, taskVersion, payload }, timing, assetIds }` 符合 prod-FARM-IOS-Core 的 schedule 创建约定。`assetIds` 与 `task.payload.media` 双写 —— 取决于后端是否要求顶层 `assetIds`，若后端仅读 `payload.media` 则 `assetIds` 冗余但无害。**建议核对后端 `POST /api/schedules` 的实际 schema**（本次审查无后端代码，无法最终确认）。

### 🟢 低危-3：`createDoomscrollSchedule` payload 正确

**位置**：`ios-farm-client.js:195-213`

`taskType: 'doomscroll'`、`payload` 含 `durationMinutes/personality/likeEnabled/saveEnabled`，结构合理。`account` 用 `...(account ? { account } : {})` 条件展开，避免传空字符串，处理得当。

### 🟡 中危-3：错误信息可能泄露原始响应体

**位置**：`ios-farm-client.js:54-55, 141`

```js
const errorMsg = (data && typeof data === 'object' && data.error) || text || `HTTP ${response.status}`;
throw new Error(`iOS Farm API ${method} ${pathname} 失败: ${errorMsg}`);
```

当后端返回非 JSON 的 HTML 错误页（如 nginx 502），`text` 可能是整页 HTML，被拼进 Error message 写入日志/前端，体积大且可能含敏感路径。建议对 `text` 做长度截断（如 `text.slice(0, 500)`）。

---

## 二、tiktok-publish-manager.js

### 🔴 高危-2：`executionId` 查找逻辑不可靠，可能误匹配他人任务

**位置**：`tiktok-publish-manager.js:201-213`

```js
const executions = await this.iosFarm.listExecutions(udid, 5);
const found = executions.find(e =>
  e.status === "queued" || e.status === "running" ||
  (scheduleId && e.scheduleId === scheduleId)
);
```

问题：
1. **竞态误匹配**：`listExecutions(udid, 5)` 取该设备最近 5 条执行。若该 iPhone 上有多个账号/任务并发，`find` 按 `status === "queued" || "running"` 匹配，会命中**任意**一个排队/运行中的任务，不一定是本次 schedule 产生的。只有当 `e.scheduleId === scheduleId` 时才是准确匹配，但该条件被 `||` 在前两个宽泛条件之后，逻辑上"或"关系导致宽泛条件先生效。
2. **scheduleId 可能为 undefined**：`schedule?.id || schedule?.scheduleId`（第 195 行）。若后端返回字段名不同（如 `schedule._id`），`scheduleId` 为 falsy，则 `(scheduleId && e.scheduleId === scheduleId)` 永远为 false，完全依赖宽泛匹配。

**建议**：优先用 `scheduleId` 精确匹配；若后端 schedule 创建接口能直接返回 `executionId`，应直接使用，避免事后轮询查找。

### 🟡 中危-4：轮询超时 10 分钟可能不足，且超时后未停止远端任务

**位置**：`tiktok-publish-manager.js:222-254`

- `maxPollAttempts = 300` × 2s = 10 分钟。TikTok App 自动发布（上传 + 编辑 + 发布 + 等待审核）在弱网或 App 弹窗时可能超过 10 分钟。超时后抛错标记 job 失败，但**远端 execution 仍在运行**，未调用 `stopExecution`，导致 iPhone 上任务继续执行却本地已判失败，可能重复入列造成重复发布。
- 建议超时后调用 `this.iosFarm.stopExecution(executionId)` 清理远端。

### 🟡 中危-5：`finally` 块清理正确，但 `_executeViaIosFarm` 的 `return` 与 `finally` 交互需确认

**位置**：`tiktok-publish-manager.js:67-70, 163-270`

```js
// executeJob 中：
if (job.profileId && job.profileId.startsWith("ios_")) {
  const udid = job.profileId.replace(/^ios_/, "");
  return await this._executeViaIosFarm(jobId, udid, job);
}
// ... Playwright 分支 ...
} finally {
  this.runningJobIds.delete(jobId);
  if (publisher) await publisher.close().catch(() => {});
  this.dispatchEvent(new CustomEvent("change"));
}
```

**问题**：iOS Farm 分支用 `return await _executeViaIosFarm(...)` 提前返回，**绕过了 executeJob 末尾的 `finally` 块**（该 finally 属于 Playwright 分支的 try-catch-finally，iOS 分支在 try 块外提前 return）。

但 `_executeViaIosFarm` 内部有自己的 `try/catch/finally`（第 266-269 行），其中 `finally` 做了 `this.runningJobIds.delete(jobId)` 和 `dispatchEvent`。所以 `runningJobIds` 清理**没有遗漏**。✅

**但**：`executeJob` 第 60 行 `this.runningJobIds.add(jobId)` 后，iOS 分支 return 时，executeJob 的外层 finally（第 149-155 行）**不会执行**（因为 return 在 try 块之前，不在 try 内）。需确认 executeJob 的 try 结构 —— 经核对第 72 行 `let publisher = null; try {` 在 iOS return 之后，所以 iOS 分支确实不走该 try-finally。清理责任完全落在 `_executeViaIosFarm` 的 finally，逻辑自洽。✅ 仅作记录。

### 🟢 低危-4：标题处理逻辑与 Playwright 模式一致

**位置**：`tiktok-publish-manager.js:175-178`

```js
publishTitle = publishTitle.replace(/^AI混剪\s*·\s*/, '').replace(/\s*→\s*\d+个矩阵$/, '');
const creativeMatch = publishTitle.match(/创作的\s*(.+)$/);
if (creativeMatch) publishTitle = creativeMatch[1].trim();
```

与 `executeJob` 第 87-90 行完全一致。✅

### 🟡 中危-6：`account` 字段传递 `job.accountId`，对 iOS Farm 含义需确认

**位置**：`tiktok-publish-manager.js:189`

```js
account: job.accountId || "",
```

`createTkPublishJob` 中 `accountId: profileId`（`auto-publish-scheduler.js:646`），即 `accountId` 实际是 BitBrowser profileId 或 `ios_<udid>`。传给 iOS Farm 的 `account` 字段语义是"TikTok 账号句柄（如 @username）"，但这里传的是 profileId/udid 前缀，**语义不匹配**。若 prod-FARM-IOS-Core 的 TikTok 插件用 `account` 字段定位 App 内账号，传 `ios_xxxx` 会导致找不到账号或发布到错误账号。

**建议**：应从 `tk_accounts` 表查真实 TikTok 用户名传入，或留空让 iPhone 端用当前登录账号。

---

## 三、server.js

### 🔴 高危-3：`GET /api/ios-farm/config` 存在语法错误，`apiKey` 字段引用了不存在的变量

**位置**：`server.js:4215`

```js
apiKey: pathCf...iKey ? "***" : "",
```

源码中确实是 `pathCf...iKey`（三个点），这是**语法错误**（`pathCf` 后跟 `...iKey` 不是合法的 JS 标识符或扩展运算符用法）。该路由在请求时会抛 `ReferenceError: pathCf is not defined`，导致 **GET /api/ios-farm/config 接口完全不可用**，前端 `loadPathConfig()` 无法回显已保存的 iOS Farm 地址。

需修正为 `pathCfg.iosFarmApiKey ? "***" : ""`。

### 🔴 高危-4：`POST /api/path-config` 覆盖写入，会清除 iOS Farm 配置

**位置**：`server.js:1501-1512` + `database.js:1091-1098`

```js
// server.js POST /api/path-config
const config = store.savePathConfig({
  videoUploadPath: body.videoUploadPath || "",
  outputPath: body.outputPath || "",
});
```

`savePathConfig` 是**整体替换**（`JSON.stringify(config)` 全量写入，非 merge）。该接口只传 `videoUploadPath` 和 `outputPath`，**不携带 `iosFarmBaseUrl`/`iosFarmApiKey`**，导致每次保存路径配置时 iOS Farm 配置被清空。

前端 `#path-config-save` 按钮（`app.js:4024-4040`）的执行顺序是：
1. `POST /api/path-config`（此时 iOS Farm 配置被清空）
2. `PUT /api/ios-farm/config`（重新写入 iOS Farm 配置）

两步顺序执行能最终恢复 iOS Farm 配置，但：
- **中间态不一致**：若步骤 1 成功、步骤 2 失败（网络抖动），iOS Farm 配置丢失。
- **其他调用方**：若有其他地方单独调 `POST /api/path-config`（如初始化脚本），会意外清空 iOS Farm 配置。

**建议**：`POST /api/path-config` 改为先 `getPathConfig()` 再 merge 新字段后保存，与 `PUT /api/ios-farm/config` 的 merge 写法一致。

### 🟡 中危-7：`PUT /api/ios-farm/config` 空字符串覆盖 baseUrl 后未清理 apiKey

**位置**：`server.js:4222-4237`

```js
if (body.iosFarmBaseUrl !== undefined) pathCfg.iosFarmBaseUrl = body.iosFarmBaseUrl;
if (body.iosFarmApiKey !== undefined) pathCfg.iosFarmApiKey = body.iosFarmApiKey;
```

前端（`app.js:4035-4036`）在 key 为空时不传 `iosFarmApiKey`：
```js
const iosPayload = { iosFarmBaseUrl: iosUrlEl?.value.trim() || "" };
if (iosKeyEl?.value.trim()) iosPayload.iosFarmApiKey = iosKeyEl.value.trim();
```

场景：用户清空 iOS Farm 地址（baseUrl=""）但保留旧 key。`iosFarmBaseUrl` 被设为 ""，但 `iosFarmApiKey` 未传，保留旧值。`createIosFarmClient` 中 `if (!baseUrl) return null`，客户端不创建，但 `pathCfg.iosFarmApiKey` 仍残留在数据库。虽不影响功能，但属于敏感信息残留。建议 baseUrl 清空时同步清空 apiKey。

### 🟡 中危-8：`iosFarmClient` 重新创建后，`iosFarmExecMatch` 路由仍用旧闭包变量

**位置**：`server.js:4230-4231, 4241-4247`

```js
const newClient = createIosFarmClient(store);
tiktokPublisherManager.iosFarm = newClient;  // 更新 publisher
// 但 iosFarmClient 闭包变量未重新赋值！
```

`iosFarmClient` 是 `createServer` 作用域内的 `const`（第 405 行）。`PUT /api/ios-farm/config` 后只更新了 `tiktokPublisherManager.iosFarm`，但路由处理函数中仍引用原 `iosFarmClient`（第 4188/4200/4242 行的 `if (!iosFarmClient)` 判断和 `iosFarmClient.health()` 调用）。

**后果**：用户在前端修改 iOS Farm 地址并保存后：
- 发布任务（走 `tiktokPublisherManager.iosFarm`）能用新地址 ✅
- 但 `GET /api/ios-farm/health`、`GET /api/ios-farm/devices`、`GET /api/ios-farm/executions` 仍用**旧客户端**（旧地址或 null）❌

若首次配置（原 `iosFarmClient` 为 null），保存后这些 GET 接口仍返回 503"未配置"，前端设备列表永远加载不出，无法绑定 iOS Farm 设备。

**建议**：将 `iosFarmClient` 改为 `let`，PUT 后重新赋值；或路由内每次通过 `createIosFarmClient(store)` 现取。

### 🟢 低危-5：CSRF / auth 检查不影响 iOS Farm API

经搜索 `server.js` 无 `csrf`/`CSRF`/`requireAuth`/`isAuthenticated` 等中间件（0 匹配）。iOS Farm API 与其他 API 一样无鉴权，本地内网部署模型下可接受。✅

### 🟢 低危-6：5 个 iOS Farm 路由结构清晰

`health`/`devices`/`config`(GET+PUT)/`executions` 共 5 个路由，方法+pathname 匹配清晰，错误统一 `sendJson(..., 5xx/4xx, {error})`。✅

---

## 四、前端（app.js + index.html）

### 🟢 低危-7：`loadPathConfig` 正确加载 iOS Farm 配置

**位置**：`app.js:3972-3989`

分两次请求 `/api/path-config` 和 `/api/ios-farm/config`，分别填充路径和 iOS Farm 地址。key 字段不回显（安全考虑）。✅

**但依赖高危-3 修复**：当前 `GET /api/ios-farm/config` 因语法错误不可用，`loadPathConfig` 的 iOS Farm 部分会静默失败（`catch {}`），地址栏永远空白。

### 🟢 低危-8：保存按钮正确同时保存路径和 iOS Farm 配置

**位置**：`app.js:4024-4040`

先 `POST /api/path-config`，再 `PUT /api/ios-farm/config`，逻辑正确。仅当 key 输入框有值时才传 `iosFarmApiKey`（避免用空串覆盖已有 key）。✅

**受高危-4 影响**：步骤 1 会临时清空 iOS Farm 配置，但步骤 2 会恢复，最终一致（前提是两步都成功）。

### 🟡 中危-9：绑定实例下拉框 optgroup 渲染基本正确，但 `escapeHtml` 用在 `value` 上会导致值损坏

**位置**：`app.js:6284`

```js
options.push({ value: `ios_${escapeHtml(d.udid)}`, label: `iPhone ${escapeHtml(d.name)} (${status})`, group: "iOS Farm" });
```

**问题**：`value` 字段被 `escapeHtml` 处理后写入 `<option value="ios_&quot;xxx&quot;">`。虽然 UDID 通常是纯十六进制不含特殊字符，`escapeHtml` 对正常 UDID 不会改变值。但：
1. **语义错误**：`value` 是 HTML 属性值，应放在 `value="..."` 中由浏览器解析。当前代码 `html += \`<option value="${o.value}">\``（第 6301 行）—— `o.value` 已被 escape，再放进 `value="..."` 属性，浏览器解析属性时不会再 unescape 一次，导致 `profileId` 存为转义后的字符串（如 `ios_&amp;xxx` 而非 `ios_xxx`）。
2. **下游影响**：`mxEl.profileSelect.value` 取出的是转义后的值，存入 `matrix_profiles.profile_id`。后续 `_executeViaIosFarm` 中 `udid = job.profileId.replace(/^ios_/, "")` 得到的是转义后的 udid，传给 iOS Farm API 时设备查找失败。

**实际风险**：UDID 一般为 `[0-9a-f-]{25,40}`，`escapeHtml` 对其无影响，所以**绝大多数情况下不会触发**。但若 UDID 含特殊字符（极罕见），会损坏。BitBrowser 侧 `value: p.id`（第 6274 行）**未做 escapeHtml**，对比可见 iOS 侧处理不一致。

**建议**：`value` 字段不做 `escapeHtml`，保持原始值；`label` 字段做 escape 防 XSS。与 BitBrowser 侧统一。

### 🟡 中危-10：iOS Farm 设备加载失败时不影响 BitBrowser 列表 ✅

**位置**：`app.js:6277-6287`

iOS Farm 设备加载在独立 `try {} catch {}` 中，失败时 `options` 仅含 BitBrowser 项，不影响 BitBrowser 列表渲染。✅ 设计合理。

### 🟢 低危-9：index.html 输入框正确新增

**位置**：`index.html:1120-1127`

`#ios-farm-url`（type=text）和 `#ios-farm-key`（type=password）两个 label 已正确加入 `.remix-controls-bar`，与 app.js 的 selector 对应。✅

---

## 五、数据流转

### 🔴 高危-5：`accountId` 语义错位（同中危-6，升级为高危）

**流转链路**：
```
auto-publish-scheduler.js:645-651
  createTkPublishJob({ accountId: profileId, profileId, ... })
    ↓
database.js:1778
  INSERT INTO tk_publish_jobs (account_id, profile_id, ...) VALUES (?, ?, ...)
  // account_id 存的是 profileId（如 "ios_<udid>"）
    ↓
tiktok-publish-manager.js:189
  account: job.accountId || ""  // 传给 iOS Farm 的 account = "ios_<udid>"
    ↓
ios-farm-client.js:172
  payload: { account, ... }  // TikTok 插件收到 account = "ios_<udid>"
```

**问题**：iOS Farm 的 TikTok 插件 `payload.account` 语义是 TikTok 账号句柄（如 `@username`），用于在 App 内切换/定位账号。这里传入 `ios_<udid>` 或 BitBrowser profileId，**语义完全错误**。若 iPhone 上登录了多个 TikTok 账号，插件无法据此选择正确账号；若插件用该字段做账号校验，会直接失败。

**建议**：`_executeViaIosFarm` 中应从 `tk_accounts` 表（通过 `profile_id` 或 `matrix_account` 关联）查出真实 TikTok `account_name` 传入，而非直接用 `job.accountId`。

### 🟢 低危-10：`udid = job.profileId.replace(/^ios_/, "")` 正确

**位置**：`tiktok-publish-manager.js:68`

`profileId` 存为 `ios_<udid>`，`replace(/^ios_/, "")` 得到原始 udid。传给 `createPostSchedule({ deviceUdid: udid })` 和 `listExecutions(udid, 5)`。✅

**但受中危-9 影响**：若 optgroup 的 `escapeHtml` 损坏了 value，此处 `udid` 也会是损坏后的值。

### 🟢 低危-11：上传视频路径转换与 Playwright 模式一致

`_executeViaIosFarm` 第 170-171 行：
```js
const fileName = job.materialFilePath?.split("/").pop() || `video_${jobId}.mp4`;
const asset = await this.iosFarm.uploadAsset(job.materialFilePath, fileName);
```

`uploadAsset` 内部路径转换（`/data/` → 本地）与 `tiktok-publisher.js` 一致（见低危-1）。✅

---

## 六、问题汇总

| 编号 | 严重程度 | 文件 | 问题 |
|------|---------|------|------|
| 高危-1 | 🔴 | ios-farm-client.js:116 | multipart `filename` 未转义，特殊字符破坏帧 |
| 高危-2 | 🔴 | tiktok-publish-manager.js:208 | executionId 查找逻辑宽泛匹配，可能误匹配他人任务 |
| 高危-3 | 🔴 | server.js:4215 | `pathCf...iKey` 语法错误，GET /api/ios-farm/config 完全不可用 |
| 高危-4 | 🔴 | server.js:1501 | POST /api/path-config 整体覆盖，清空 iOS Farm 配置 |
| 高危-5 | 🔴 | 数据流转 | accountId 传 `ios_<udid>` 给 TikTok 插件，语义错位 |
| 中危-1 | 🟡 | ios-farm-client.js:100 | readFileSync 阻塞事件循环（大文件） |
| 中危-2 | 🟡 | ios-farm-client.js:37 | instanceof FormData 冗余防御 |
| 中危-3 | 🟡 | ios-farm-client.js:54 | 错误信息可能泄露整页 HTML |
| 中危-4 | 🟡 | tiktok-publish-manager.js:252 | 超时未停止远端任务，可能重复发布 |
| 中危-5 | 🟡 | tiktok-publish-manager.js:67 | return 与 finally 交互（经核对自洽，仅记录） |
| 中危-6 | 🟡 | tiktok-publish-manager.js:189 | account 字段语义（同高危-5） |
| 中危-7 | 🟡 | server.js:4222 | 清空 baseUrl 时 apiKey 残留 |
| 中危-8 | 🟡 | server.js:4230 | iosFarmClient 闭包未更新，GET 路由用旧客户端 |
| 中危-9 | 🟡 | app.js:6284 | value 字段 escapeHtml 导致值损坏（罕见） |
| 中危-10 | 🟡 | app.js:6277 | iOS Farm 加载失败不影响 BitBrowser ✅ |
| 低危-1~11 | 🟢 | 多处 | 路径转换、payload 结构、标题处理等均正确 |

---

## 七、修复优先级建议

1. **立即修复**（阻断功能）：
   - 高危-3：`pathCf...iKey` → `pathCfg.iosFarmApiKey`
   - 高危-4：`POST /api/path-config` 改为 merge 写入
   - 高危-5/中危-6：`_executeViaIosFarm` 传入真实 TikTok 账号名

2. **尽快修复**（影响可靠性）：
   - 高危-2：executionId 优先用 scheduleId 精确匹配
   - 中危-8：`iosFarmClient` 改为 `let`，PUT 后重新赋值
   - 中危-4：超时后调用 `stopExecution` 清理远端

3. **建议修复**（健壮性）：
   - 高危-1：`filename` 转义双引号
   - 中危-1：改用异步 `readFile` 或流式上传
   - 中危-9：`value` 不做 escapeHtml
   - 中危-7：清空 baseUrl 时同步清空 apiKey

---

**审查结论**：iOS Farm 适配器整体架构清晰，路径转换、标题处理、finally 清理等关键逻辑正确。但存在 5 个高危问题，其中 **高危-3（语法错误）和高危-4（配置覆盖）会直接导致功能不可用**，高危-5（账号语义错位）会导致发布到错误账号或失败，需立即修复后方可上线。
