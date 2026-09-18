# 审查轮5：后端API + 数据流转正确性

**审查范围**：`src/server.js`（新增 publish-history API + 增强 pipeline API）、`src/database.js`（Store 方法/SQL）、`public/app.js`（前端调用）
**审查日期**：2026-09-19
**模式**：只报告，不改代码

---

## 一、问题汇总（按严重程度排序）

| # | 严重程度 | 位置 | 问题 |
|---|---------|------|------|
| 1 | 🔴 高 | server.js:4274 | publish-history 的 accountId 查找逻辑存在矩阵过滤风险 |
| 2 | 🔴 高 | server.js:4336-4337 | publish-history 的 matrix_accounts LEFT JOIN 条件会导致行膨胀/错配 |
| 3 | 🟠 中 | server.js:4336-4337 | 多平台账号矩阵下 publish-history 去重后 accountName 可能不是被查账号 |
| 4 | 🟠 中 | server.js:4416 | logs API 在无 taskId 时硬编码过滤 "发布任务"，遗漏其他前缀日志 |
| 5 | 🟠 中 | app.js:8148-8149 | pipeline 渲染显示播放量占位，但 pipeline API 不返回 viewsCount（设计不一致） |
| 6 | 🟡 低 | server.js:4260 | limit 参数类型转换未防御 NaN |
| 7 | 🟡 低 | server.js:4412 | logs API 的 LIKE 拼接虽有参数化，但 `%taskId%` 可产生误匹配 |
| 8 | 🟢 提示 | server.js:4343-4376 | 去重逻辑用 JS Set 而非 SQL DISTINCT，limit 截断后数据可能不足 |

---

## 二、详细问题分析

### 问题 1 🔴 高：publish-history accountId 查找逻辑可能查不到账号

**位置**：`server.js:4273-4288`

**代码**：
```js
if (accountId) {
  const acc = store.listMatrixAccounts(matrixId || '').find(a => a.id === accountId);
  // 若未通过 matrixId 限定，则全表搜
  const acc2 = acc || (() => {
    const matrices = store.listMatrices();
    for (const m of matrices) {
      const found = store.listMatrixAccounts(m.id).find(a => a.id === accountId);
      if (found) return found;
    }
    return null;
  })();
  ...
}
```

**问题**：
- `store.listMatrixAccounts(matrixId || '')` 当 `matrixId` 为 null 时传入空字符串 `''`。
- `listMatrixAccounts` 执行 `WHERE matrix_id = ?`，查 `matrix_id = ''` 永远返回空数组（没有矩阵 id 是空串）。
- 虽然有 `acc2` 全表搜的降级分支补救，但第一步查询是无意义的死代码，且 `listMatrixAccounts` 会被多调用一次。
- 更严重的是：前端 `fetchPublishHistory(accountId)`（app.js:8304-8327）**只传 accountId，不传 matrixId**。所以每次都走全表搜降级路径——N 次查询 matrices + N 次查询 matrix_accounts，性能差且脆弱。

**影响**：功能可用（降级路径有效），但每次发布历史查询触发 O(矩阵数) 次 DB 查询，矩阵多时性能退化；代码可读性误导。

---

### 问题 2 🔴 高：publish-history 的 matrix_accounts LEFT JOIN 导致行膨胀/错配

**位置**：`server.js:4336-4337`

**代码**：
```sql
LEFT JOIN matrix_accounts ma ON ma.matrix_id = p.matrix_id
  AND (ma.account_name = j.account_id OR ma.platform = 'tiktok')
```

**问题**：
1. **JOIN 条件过宽**：`ma.platform = 'tiktok'` 会让该矩阵下**所有 tiktok 平台账号**都匹配上，即使该 pipeline 任务实际发布到的是账号 A，账号 B 也会被 JOIN 进来，产生重复行。
2. **1:N 膨胀**：一个矩阵可有多个平台账号（虽然 UNIQUE(matrix_id, platform) 限制每平台一个，但可多平台共存）。当矩阵有 tiktok + instagram 两个账号，且其中 tiktok 账号的 account_name 不等于 j.account_id 时，`ma.platform = 'tiktok'` 仍会匹配 tiktok 账号 → 产生 1~2 行。
3. **去重掩盖问题**：server.js:4343-4376 用 JS `Set` 按 `task_id` 去重，但**去重后保留的是第一行**，其 `accountName/platform` 可能是被错误 JOIN 进来的其他账号，而非真正发布的账号。

**具体场景**：矩阵 M 有账号 A(tiktok, name="user_a") 和 B(instagram)。一个 pipeline 任务发布到账号 A。JOIN 时：
- A 匹配 `ma.platform='tiktok'` → 行1，accountName="user_a" ✓
- 若 account_name 不等于 j.account_id（见问题：publish_jobs.account_id 存的是 account 名而非 matrix_account.id），则仅靠 platform 匹配。
- 去重后保留行1，accountName 正确。但若查询时按 accountId=B 过滤，WHERE `ma.account_name=? OR j.account_id=?` 用的是 B 的 name，而 JOIN 仍可能把 A 拉进来（因为 A.platform='tiktok'）→ 返回的任务 accountName 可能错乱。

**影响**：发布历史列表中账号名/平台可能显示错误；按账号筛选时可能返回不属该账号的任务（或漏掉）。

---

### 问题 3 🟠 中：publish-history 按 accountId 筛选时 WHERE 条件与 JOIN 不一致

**位置**：`server.js:4288` (WHERE) vs `server.js:4337` (JOIN)

**代码**：
```js
// WHERE 条件
if (accountName) { where.push("(ma.account_name = ? OR j.account_id = ?)"); params.push(accountName, accountId); }
```
```sql
-- JOIN 条件
LEFT JOIN matrix_accounts ma ON ma.matrix_id = p.matrix_id
  AND (ma.account_name = j.account_id OR ma.platform = 'tiktok')
```

**问题**：
- WHERE 用 `accountName`（matrix_account.account_name）匹配 `ma.account_name` 或 `j.account_id`。
- 但 `tk_publish_jobs.account_id` 的语义在 `createTkPublishJob`（database.js:1778）中是 `data.accountId || data.profileId`，即可能是 matrix_account.id、profile_id、或 account_name——**存值不统一**。
- 这导致 `j.account_id = accountId`（这里 accountId 是 matrix_account.id，形如 `ma_xxx`）几乎永远不匹配，因为 publish_jobs.account_id 存的往往是 account_name 或 profile_id。
- 实际过滤主要靠 `ma.account_name = accountName`，而由于问题2的 JOIN 膨胀，ma.account_name 可能是同矩阵其他账号的 name → 误匹配。

**影响**：按账号筛选发布历史时结果不准确。

---

### 问题 4 🟠 中：logs API 无 taskId 时硬编码 "发布任务" 过滤

**位置**：`server.js:4414-4416`

**代码**：
```js
if (taskId) {
  query += " AND (task_id = ? OR message LIKE ?)";
  params.push(taskId, `%${taskId}%`);
} else {
  query += " AND message LIKE ?";  // 硬编码
  params.push("%发布任务%");
}
```

**问题**：前端 `fetchPublishLogs`（app.js:8402-8411）调 logs API 时不传 taskId，只传 level。后端无 taskId 时强制过滤 `message LIKE '%发布任务%'`，导致**非"发布任务"前缀的发布相关日志（如"混剪完成"、"上传成功"等）全部被过滤掉**。前端日志面板显示不全。

**影响**：发布日志面板数据不完整。

---

### 问题 5 🟠 中：pipeline 渲染显示播放量但 API 不返回该字段

**位置**：`app.js:8148-8149` + `database.js:2106-2151` (listPipelineTasks)

**前端代码**：
```js
// 播放量：需要从历史接口获取，这里先显示占位（pipeline 接口暂不含 analytics）
const views = t.viewsCount != null ? t.viewsCount : '—';
```

**后端**：`listPipelineTasks`（database.js:2106-2151）返回字段包含 `materialTitle, materialFilePath, jobExecutedAt, jobStatus, publishedVideoId, publishedVideoUrl`，但**不包含 `viewsCount/likesCount` 等 analytics 字段**，也未 JOIN `tk_video_analytics` 表。

**问题**：
- 注释承认"pipeline 接口暂不含 analytics"，但渲染代码仍尝试读 `t.viewsCount`，永远得到 `undefined` → 永远显示 `—`。
- 任务要求"增强的 pipeline API 是否返回了 materialTitle/materialFilePath 等新字段"——这两个字段**已正确返回**（database.js:2145-2146）。但播放量未返回，前端占位逻辑是死代码。

**影响**：pipeline 表格播放量列永远显示 `—`，用户体验差；死代码误导。

---

### 问题 6 🟡 低：limit 参数 NaN 防御不足

**位置**：`server.js:4260`

**代码**：
```js
const limit = Math.min(Number(url.searchParams.get("limit") || "100"), 500);
```

**问题**：若传入 `?limit=abc`，`Number("abc")` = `NaN`，`Math.min(NaN, 500)` = `NaN`。SQL `LIMIT ?` 传入 `NaN`，node:sqlite 的行为依赖驱动——可能报错或返回0行。前端当前传固定 '100'，暂不触发，但 API 健壮性不足。

对比 `listPipelineTasks`（database.js:2126）用 `Math.min(Number(limit) || 100, 500)` 有 `|| 100` 兜底，更健壮。

**影响**：恶意/异常请求可能触发500错误。

---

### 问题 7 🟡 低：logs API 的 LIKE 匹配可能误匹配

**位置**：`server.js:4412-4413`

**代码**：
```js
query += " AND (task_id = ? OR message LIKE ?)";
params.push(taskId, `%${taskId}%`);
```

**问题**：taskId 形如 `pl_1234_abcd`，`message LIKE '%pl_1234_abcd%'` 可能匹配到日志消息中恰好包含该字符串但非该任务的消息。概率低但存在。参数化已防注入，仅逻辑层面误匹配。

**影响**：极低概率显示无关日志。

---

### 问题 8 🟢 提示：去重在 JS 层用 Set，LIMIT 后数据可能不足

**位置**：`server.js:4343-4376`

**问题**：SQL `LIMIT ?` 在 JOIN 膨胀后先截断，再用 JS Set 去重。若矩阵有 N 个账号，每个任务膨胀 N 行，LIMIT 100 最多只返回 `100/N` 个唯一任务。前端要求 limit=100 条历史，实际可能只得到 50 条。

**建议**：应在 SQL 层用 `DISTINCT` 或子查询去重后再 LIMIT。

**影响**：发布历史条数可能少于预期。

---

## 三、审查重点逐项结论

### 1. 新增 GET /api/auto-publish/publish-history API
- ✅ 路由匹配正确（`GET` + 精确 pathname 匹配，server.js:4256）
- ⚠️ 查询参数 matrixId/accountId/limit 均已解析，但 accountId 查找逻辑有问题（问题1）
- 🔴 SQL JOIN 逻辑错误（问题2、3）：`ma.platform='tiktok'` 条件过宽，导致行膨胀和账号错配
- ✅ 返回字段完整（jobId/taskId/matrixName/accountName/materialTitle/viewsCount 等 24 字段）
- ✅ 播放量聚合正确使用子查询 `SELECT SUM(va.views_count) FROM tk_video_analytics va WHERE va.publish_job_id = j.id`（server.js:4320-4331），JOIN 逻辑本身正确
- ✅ 参数化查询，无 SQL 注入

### 2. 增强的 pipeline API
- ✅ `listPipelineTasks`（database.js:2082-2152）已返回 `materialTitle`、`materialFilePath`、`jobExecutedAt`、`jobStatus`、`publishedVideoId`、`publishedVideoUrl`
- ✅ 通过 `LEFT JOIN tk_publish_jobs j ON j.id = p.publish_job_id` + `LEFT JOIN tk_video_materials vm ON vm.id = j.material_id` 正确关联
- ⚠️ 未返回播放量字段，前端渲染占位（问题5）

### 3. 前端 fetchPublishHistory/renderPublishHistory API 路径
- ✅ 路径一致：前端调 `/api/auto-publish/publish-history?accountId=&limit=100`（app.js:8320），后端路由匹配（server.js:4256）
- ✅ 参数名一致：accountId、limit

### 4. 前端 renderPipeline 字段与后端返回匹配
- ✅ `matrixName`、`accountName`、`platform`、`sourceVideoId`、`materialTitle`、`status`、`attemptCount`、`createdAt`、`jobExecutedAt`、`publishJobId`、`failReason` 均匹配
- ⚠️ `viewsCount` 前端读取但后端未返回（问题5）
- ⚠️ 前端用 `t.jobExecutedAt`（app.js:8140），后端返回字段名为 `jobExecutedAt`（database.js:2147）✓ 匹配

### 5. 矩阵账号树形选择器数据来源
- ✅ `fetchMatrices`（app.js:7992）调 `/api/auto-publish/matrices`，后端（server.js:4184-4208）返回矩阵+账号+配置+profileId
- ✅ 树渲染（app.js:8266-8274）使用 `m.accounts`，数据链路正确
- ✅ 账号点击 → `fetchPublishHistory(accountId)`（app.js:8289-8291）

### 6. 播放量数据查询
- ✅ publish-history API 正确用子查询聚合 `tk_video_analytics`（server.js:4320-4331）
- ✅ analytics API（server.js:4436-4478）正确查询 `tk_video_analytics WHERE publish_job_id = ?`
- ⚠️ pipeline API 未 JOIN analytics 表（设计选择，非错误）

### 7. 错误处理
- ✅ 各 API 失败时 sendJson 返回 400/404 + error 消息
- ✅ 前端 fetchPublishHistory catch 块显示错误（app.js:8323-8326）
- ⚠️ publish-history API 无 try-catch，SQL 异常会导致未捕获错误（依赖全局 uncaughtException 兜底，server.js:9-11）
- ⚠️ limit NaN 未防御（问题6）

### 8. SQL 注入风险
- ✅ **全部查询使用参数化**（`?` 占位符 + params 数组）
- ✅ `listPipelineTasks`、`publish-history`、`logs`、`analytics` 均 `.prepare().all(...params)`
- ✅ 无字符串拼接 SQL 值的情况
- ⚠️ `#ensureColumn`（database.js:786）用模板字符串拼表名/列名，但表名/列名是代码内常量，非用户输入，无风险

---

## 四、总结

**核心风险**集中在 publish-history API 的 `matrix_accounts` JOIN 逻辑（问题2、3），会导致发布历史按账号筛选时数据不准确、行膨胀后去重丢失数据。这是前端重构后新页面（auto-publish 发布历史页）的核心数据源，建议优先修复。

**pipeline API 增强**基本正确，materialTitle/materialFilePath 等新字段已完整返回，仅播放量未返回（设计缺口）。

**SQL 注入**全面参数化，无风险。

**建议修复优先级**：
1. 问题2/3（JOIN 逻辑）→ 重写 JOIN 条件，改为子查询精确匹配 account
2. 问题1（accountId 查找）→ 直接全表搜，去掉无意义的空字符串查询
3. 问题8（去重+LIMIT）→ SQL 层 DISTINCT
4. 问题5（pipeline 播放量）→ 决定是 pipeline API 补 analytics，还是前端删掉占位列
5. 问题4（logs 过滤）→ 去掉硬编码 "发布任务" 过滤或改为可配置
