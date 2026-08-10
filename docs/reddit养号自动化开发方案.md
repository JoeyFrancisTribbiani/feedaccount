# Reddit 养号流程自动化开发方案

> 基于 `docs/reddit人工养号流程.md` 的三周养号流程，结合项目现有自动化能力分析，制定分阶段自动化开发方案。

---

## 一、现状分析

### 已有自动化能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 自动点赞帖子 | `job-manager.js:#tryAutoUpvotePost` | Feed 等待阶段按概率点赞当前帖 |
| 自动点赞评论 | `job-manager.js:#tryAutoUpvoteComment` | 评论区滚动时按概率点赞当前评论 |
| 自动关注子版块 | `job-manager.js:#tryAutoJoinSubreddit` + `browser-session.js:joinSubreddit` | 从预配置列表顺序关注，带间隔和上限 |
| 逐帖阅读+详情浏览 | `job-manager.js:#stepFeed` / `#openDetail` | 模拟人类浏览节奏 |
| 评论区阅读 | `job-manager.js:#scrollComments` | 逐条滚动评论 |
| 拟人化输入 | `natural-input.js` | 鼠标移动轨迹、滚轮脉冲、点击节奏 |
| UI 元素定位 | `reddit-interaction-locator.js` | **已支持**评论编辑器、评论提交按钮、发帖入口、标题/正文编辑器、发帖提交按钮的识别 |

### 缺失的自动化能力（按流程文档对照）

| 流程要求 | 现状 | 优先级 |
|---|---|---|
| 进入帖子评论区点赞（而非 Feed 外点赞） | 已有——详情浏览模式下自动点赞评论 | ✅ 已满足 |
| 按 new 排序浏览帖子 | 不存在 | 低（见下方说明） |
| 检查发帖人权重（karma/注册时间） | 不存在 | 低（见下方说明） |
| 自动发评论 | 定位器已就绪，缺 actor 方法 | **高** |
| 评论内容生成 | 不存在 | **高** |
| 图片处理（去水印、改文件名、查重） | 不存在 | 中（第三周才需要） |
| 自动发帖 | 定位器已就绪，缺 actor 方法 | 中（第三周才需要） |
| 发帖文案生成 | 不存在 | 中 |
| karma 值监控 | 不存在 | 中（用于判断养号进度） |

### 关于"按 new 排序"和"检查作者权重"的设计决策

**不建议实现自动按 new 排序浏览。** 理由：

1. Reddit 反作弊系统对"短时间内对新帖新号集中互动"极其敏感。现有 `feed=home` 默认排序 + 概率点赞的设计是正确的"伪装成普通浏览者"策略。
2. 如果改成去 `/new` 刷帖，行为模式从"像人"变成"像 bot"。
3. 流程文档中提到"new 的帖子点赞"是人工养号策略，人工可以灵活判断帖子质量和作者可信度，自动化做不到这种判断。

**不建议实现自动检查作者 karma/年龄来筛选互动对象。** 理由：

1. 读取作者信息需要额外 DOM 解析或 API 调用，增加复杂度。
2. 即使读到了，"karma > 200 且注册 > 1 个月"这种硬规则在自动化中容易被反作弊系统识别为模式。
3. 更好的策略是：坚持 home feed（Reddit 算法已经帮你筛选了高质量帖子），用概率控制互动频率。

如果用户坚持需要 new 排序和作者筛选，可以作为**可选模块**在后续版本中加入，但不作为默认行为。

---

## 二、分阶段开发方案

### 阶段一：自动发评论（第二周流程自动化）

这是最高价值的自动化能力。账号活跃度的核心指标是评论，而非点赞。

#### 2.1.1 评论内容管理

**新建文件：`src/comment-library.js`**

```
CommentLibrary
├── 预设评论模板库（按社群分类）
│   ├── 奢侈品品类（LV/Chanel/Coach/handbags）
│   ├── 通用赞美类
│   ├── 经验分享类
│   └── 提问互动类
├── 评论选取逻辑
│   ├── 根据当前帖子所在 subredddit 选取对应分类
│   ├── 随机选取，避免重复
│   └── 变体变换（同义词替换、语序调整）
└── 评论质量规则
    ├── 最少字数限制（不少于 15 个词）
    ├── 禁止纯赞美（"Great post!" 之类）
    └── 鼓励带观点/经验分享
```

**配置项（`config.js` 新增）：**
- `autoCommentEnabled: false` — 是否启用自动发评论
- `autoCommentProbability: 0` — 发评论概率（0-100）
- `autoCommentMinIntervalSec: 1800` — 两次评论最小间隔（秒），默认 30 分钟
- `autoCommentMaxIntervalSec: 7200` — 两次评论最大间隔（秒），默认 2 小时
- `autoCommentMaxPerRun: 2` — 单次运行最多发评论数
- `autoCommentMinPostAge: 1` — 只对发布超过 N 小时的帖子评论（防审核中帖子被删）
- `commentLibraryPath: null` — 评论模板库文件路径（JSON）

#### 2.1.2 评论发布 Actor

**修改文件：`src/browser-session.js`**

新增方法 `postComment(text)`，流程：

```
1. 确认当前在帖子详情页（不在 Feed）
2. 调用 locateCommentControls() 定位评论编辑器
3. 点击评论编辑器激活输入框
4. 使用 natural-input.js 的拟人化节奏逐字输入评论文本
   ├── 每个字符间随机延迟 50-200ms
   ├── 偶尔停顿（模拟思考）
   └── 输入完毕后随机等待 1-3 秒
5. 定位评论提交按钮
6. 拟人化点击提交
7. 等待 3-5 秒验证评论是否发布成功
   ├── 检查页面上是否出现新评论
   ├── 检查是否有错误提示
   └── 如果失败，记录原因但不重试
8. 返回 { ok, commentId?, error? }
```

关键设计点：
- **不重试**。评论发布失败就跳过，不反复提交（避免被检测为 spam）。
- **逐字输入**。使用 CDP 的 `Input.dispatchKeyEvent`，通过 `natural-input.js` 的节奏参数模拟人类打字。
- **帖子年龄检查**。在 `job-manager.js` 层面过滤，只对发布超过 1 小时的帖子发评论。

#### 2.1.3 JobManager 集成

**修改文件：`src/job-manager.js`**

新增 `#tryAutoPostComment(job)` 方法，在详情页评论浏览阶段调用：

```
#tryAutoPostComment(job)
├── 检查 autoCommentEnabled
├── 检查 autoCommentMaxPerRun 上限
├── 检查距上次评论的间隔
├── 检查当前帖子的发布时间（autoCommentMinPostAge）
├── 从 CommentLibrary 选取评论文本
├── 调用 job.session.postComment(text)
├── 记录结果到 job.autoCommentCount
├── 持久化到数据库（新增 task_events 记录）
└── 设置下次评论的间隔
```

#### 2.1.4 数据库扩展

**修改文件：`src/database.js`**

- `task_runs` 表新增列：`auto_comment_count INTEGER NOT NULL DEFAULT 0`
- `task_runs` 表新增列：`posted_comment_ids_json TEXT NOT NULL DEFAULT '[]'`（已发评论的帖子 ID，幂等保护）
- `app_settings` 新增键：`comment_library`（存储评论模板库 JSON）

#### 2.1.5 前端配置

**修改文件：`public/index.html` + `public/app.js`**

在任务参数面板新增"自动评论"区域：
- 开关：自动评论
- 概率滑块
- 最小/最大间隔
- 单次运行上限
- 帖子最小年龄（小时）
- 评论模板库编辑器（textarea，每行一条模板）

---

### 阶段二：养号进度监控（贯穿三周）

#### 2.2.1 Karma 值读取

**修改文件：`src/browser-session.js`**

新增方法 `readKarma()`，在每次打开浏览器时调用：

```
1. 在 Reddit 页面执行 JS 读取用户 karma
   ├── 优先从侧边栏用户面板读取
   ├── 回退到 API: fetch('/api/v1/me') 
   └── 返回 { karma, postKarma, commentKarma, accountAge }
2. 记录到 job 和数据库
```

#### 2.2.2 账号管理与养号策略（人工指定）

**不做自动阶段判定。** 由用户人工指定每个账号的养号策略（点赞/评论/发帖），程序只负责记录和展示。

**新建数据库表 `reddit_accounts`：**
```sql
CREATE TABLE IF NOT EXISTS reddit_accounts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE,
  reddit_username TEXT,
  registered_at TEXT,          -- 账号注册时间（人工填写）
  nurture_started_at TEXT,     -- 开始养号时间（人工填写）
  nurture_stage TEXT DEFAULT 'week1',  -- 人工指定：week1 / week2 / week3
  karma_total INTEGER DEFAULT 0,
  karma_post INTEGER DEFAULT 0,
  karma_comment INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**前端账号管理表格：**
- 列：实例序号、实例名称、Reddit 用户名、注册时间、开始养号时间、当前阶段、karma、备注
- 支持新增/编辑/删除
- 时间字段用日期选择器
- 阶段用下拉框（Week 1 / Week 2 / Week 3）
- karma 值可手动填写或后续自动读取

**设计原则：**
- 策略由用户在任务参数面板中为每个实例单独配置（复用现有 `getTiktokOptions` 模式，新增 `getRedditOptions(profileId)`）
- 不做"根据时间自动切换策略"的逻辑——太复杂且容易出错
- 用户根据自己观察决定每个账号该做什么
- **操作项按周分组，可多选**：用户可为每个账号灵活勾选以下操作项

**Week 1：点赞养号**
| 操作项 key | 说明 | 对应流程 |
|---|---|---|
| `w1_feed_upvote` | 主页 Feed 点赞 | Day 1-7 |
| `w1_comment_upvote` | 评论区点赞 | Day 2+ |
| `w1_join_subreddit` | 关注目标社群 | Day 4+ |
| `w1_targeted_upvote` | 浏览目标社群并点赞 | Day 5+ |

**Week 2：评论互动**
| 操作项 key | 说明 | 对应流程 |
|---|---|---|
| `w2_post_comment` | 发评论 | Day 1+ |
| `w2_comment_on_new` | 筛选 new 帖子评论 | Day 1+ |
| `w2_check_post_age` | 帖子发布 >1 小时检查 | Day 1+ |
| `w2_check_author` | 发帖人权重检查 | Day 1+ |
| `w2_multi_comment` | 多条评论（每天 2+） | Day 3+ |
| `w2_hourly_comment` | 每小时一条评论 | Day 5+ |

**Week 3：发帖**
| 操作项 key | 说明 | 对应流程 |
|---|---|---|
| `w3_create_post` | 发帖 | Day 1+ |
| `w3_narrative_post` | 叙事图文帖（谁在哪里干了什么） | Day 1+ |
| `w3_image_post` | 带实拍图发帖 | Day 1+ |

操作项存储为 `reddit_accounts.enabled_actions_json`（JSON 数组），如 `["w1_feed_upvote", "w1_comment_upvote", "w2_post_comment"]`。

---

### 阶段三：自动发帖（第三周流程自动化）

#### 2.3.1 发帖内容管理

**新建文件：`src/post-library.js`**

```
PostLibrary
├── 发帖模板库（按社群分类）
│   ├── 图文分享类（"谁在哪里干了什么"叙事）
│   ├── 经验讨论类
│   └── 求推荐类
├── 发帖计划
│   ├── 目标社群列表
│   ├── 每个社群的发帖间隔（至少 2-3 天）
│   └── 发帖时间段（模拟人类活跃时间）
└── 文案生成
    ├── 标题模板 + 随机变换
    ├── 正文模板 + 变体
    └── 图片选择（从本地素材库）
```

#### 2.3.2 发帖 Actor

**修改文件：`src/browser-session.js`**

新增方法 `createPost({ subreddit, title, body, imagePath? })`：

```
1. 导航到 /r/{subreddit}/submit
2. 等待发帖表单加载
3. 选择发帖类型（文本帖 or 图片帖）
4. 拟人化输入标题
5. 拟人化输入正文
6. 如果是图片帖，上传图片
7. 检查表单完整性
8. 拟人化点击提交
9. 等待跳转确认发帖成功
10. 返回 { ok, postUrl?, error? }
```

#### 2.3.3 图片处理（可选）

**新建文件：`src/image-processor.js`**

```
ImageProcessor
├── 去水印
│   ├── 裁剪右下角区域（小红书水印位置）
│   └── 可配置裁剪区域
├── 改文件名
│   ├── 随机生成文件名
│   └── 保留扩展名
├── 基础查重
│   ├── 文件哈希计算
│   └── 与已用图片比对
└── 格式转换
    └── 确保输出为 JPEG/PNG
```

**依赖：** 无需外部库，使用 Node.js 的 `crypto` 计算哈希，`fs` 处理文件。裁剪需要 `sharp` 或 `canvas`，可作为可选依赖。

---

### 阶段四：修复现有问题

#### 2.4.1 joinSubreddit 进度恢复

**问题：** `browser-session.js:joinSubreddit` 的 `finally` 块调用 `#navigateBackToFeed()`，会丢失 Feed 滚动位置（`lastPostId = null`）。每次自动关注后浏览进度被重置，与"像人在浏览"的目标相悖。

**修复方案：**

```
joinSubreddit 改造：
1. 关注前保存当前 Feed 状态
   ├── 当前帖子 ID (lastPostId)
   ├── 滚动位置
   └── Feed 帖子列表快照
2. 导航到子版块并关注
3. 关注完成后，使用 returnToFeed() 的快照恢复机制
   而非 #navigateBackToFeed() 的硬导航
4. 恢复滚动位置到关注前的帖子
```

#### 2.4.2 评论编辑器定位优化

**问题：** `reddit-interaction-locator.js` 已能定位评论编辑器，但未验证在 Reddit 新版 UI 下的可靠性。

**优化方案：**
- 在 `browser-session.js` 新增 `locateCommentEditor()` 方法
- 使用 `reddit-interaction-locator.js` 的 `locateCommentControls`
- 增加多级回退定位策略（shadowRoot → data-testid → 文本匹配）

---

## 三、开发优先级与时间线

| 优先级 | 模块 | 预估工时 | 依赖 |
|---|---|---|---|
| P0 | 阶段一：自动发评论 | 3-4 天 | 无 |
| P0 | 阶段四：joinSubreddit 进度恢复 | 0.5 天 | 无 |
| P1 | 阶段二：Karma 读取 + 养号阶段判定 | 2 天 | 无 |
| P1 | 阶段二：前端进度展示 | 1 天 | Karma 读取 |
| P2 | 阶段三：发帖内容管理 | 2 天 | 无 |
| P2 | 阶段三：发帖 Actor | 2-3 天 | 内容管理 |
| P3 | 阶段三：图片处理 | 1-2 天 | 可选依赖 sharp |
| P3 | 阶段二：karma 趋势图 | 1 天 | Karma 读取 |

---

## 四、风险与对策

### 4.1 反作弊风险

| 风险 | 对策 |
|---|---|
| 评论内容重复被检测 | 模板变体变换 + 每条评论至少 3 个可变片段 |
| 评论频率异常 | 最小间隔 30 分钟 + 概率控制 + 每日上限 |
| 发帖频率异常 | 每个社群至少间隔 2-3 天 + 每日最多 1 帖 |
| 输入速度异常 | 使用 `natural-input.js` 的拟人化节奏 |
| 互动对象集中 | 坚持 home feed，不去 /new 集中互动 |

### 4.2 技术风险

| 风险 | 对策 |
|---|---|
| Reddit UI 变更导致定位失效 | 多级回退定位策略 + 定期验证 |
| 评论发布失败 | 不重试，记录失败原因，人工排查 |
| 帖子被审核/删除 | 帖子年龄过滤（>= 1 小时）+ 失败不重试 |
| 账号被封 | 每日操作量限制 + 间隔随机化 + 多账号独立 IP |

### 4.3 内容质量风险

| 风险 | 对策 |
|---|---|
| 评论过于模板化 | 模板库定期更新 + 变体变换 + 鼓励带观点 |
| 发帖内容被识别为引流 | 遵循"谁在哪里干了什么"叙事模式 + 避免纯问题/鉴定 |
| 图片被识别为转载 | 去水印 + 改文件名 + 基础查重（后续可加 perceptual hash） |

---

## 五、架构图

```
┌─────────────────────────────────────────────────────┐
│                    前端配置面板                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │ 点赞设置  │ │ 评论设置  │ │ 关注设置  │ │ 发帖设置 │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘ │
└───────┼────────────┼────────────┼────────────┼──────┘
        │            │            │            │
┌───────▼────────────▼────────────▼────────────▼──────┐
│                  JobManager                          │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │#tryAutoUp-  │ │#tryAutoPost- │ │#tryAutoJoin- │  │
│  │votePost     │ │Comment  [新] │ │Subreddit     │  │
│  └──────┬──────┘ └──────┬───────┘ └──────┬───────┘  │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │#tryAutoUp-  │ │#tryAutoPost- │ │NurtureTracker│  │
│  │voteComment  │ │Submit  [新]  │ │       [新]   │  │
│  └──────┬──────┘ └──────┬───────┘ └──────────────┘  │
└─────────┼───────────────┼───────────────────────────┘
          │               │
┌─────────▼───────────────▼───────────────────────────┐
│                  BrowserSession                      │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐  │
│  │upvote   │ │postComment│ │joinSub- │ │createPost│  │
│  │Post     │ │   [新]    │ │reddit   │ │  [新]    │  │
│  └─────────┘ └────┬─────┘ └────┬────┘ └────┬─────┘  │
│  ┌─────────┐ ┌────▼─────┐      │      ┌────▼─────┐  │
│  │upvote   │ │naturalIn-│      │      │ImageProc-│  │
│  │Comment  │ │put.js    │      │      │essor[新] │  │
│  └─────────┘ └──────────┘      │      └──────────┘  │
└────────────────────────────────┼────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────┐
│           reddit-interaction-locator.js              │
│  (已有：定位评论编辑器/提交/发帖入口/标题/正文/提交)    │
└─────────────────────────────────────────────────────┘
```

---

## 六、实施建议

1. **先跑通阶段一（自动评论），再考虑其他。** 评论是养号核心，先让这个闭环跑起来。
2. **评论模板库用 JSON 文件管理，不要硬编码。** 方便后续更新和 A/B 测试。
3. **养号策略由用户人工指定，不做自动阶段判定。** 用户根据自己观察决定每个账号该做什么，程序只记录注册时间和养号时间。
4. **每个新功能都加开关。** 默认关闭，用户确认配置后再开启。
5. **joinSubreddit 的进度恢复问题应该立即修复。** 这是一个现有 bug，不需要等阶段四。
6. **不要急于实现发帖。** 发帖是最高风险的操作，在评论功能稳定运行 1-2 周后再考虑。
