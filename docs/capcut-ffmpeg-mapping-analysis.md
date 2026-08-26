# 剪映(CapCut/JianYing)核心概念 → FFmpeg操作映射 技术分析

> 调研日期：2026-08-25
> 目标：将剪映的「新建复合片段」「分离音频」操作映射到FFmpeg命令，并解释
> 「分离音频→新建复合片段→导出→TikTok显示原声」工作流的底层原理。

---

## 1. 新建复合片段 (Compound Clip / 复合片段)

### 1.1 概念定义

**来源：TourBox官方教程 + CapCut官方文档**

> "Creating a compound clip in CapCut refers to packaging one or multiple assets on the CapCut tracks into a single entity, which can be seen as a new bundled asset placed on a single track."
> — TourBox

复合片段的本质是**将多个轨道/素材打包成一个独立的、可整体操作的单一实体**。具体行为：

- **轨道合并**：选中的多个轨道（视频、音频、文字、贴纸等）被"压扁"到一条单轨上
- **独立容器**：复合片段成为一个独立的编辑容器，内部编辑不影响原始素材
- **整体操作**：可对整个复合片段统一施加速度、调色、运动等效果
- **可嵌套**：复合片段内可再建复合片段
- **可预渲染**：Pre-process 功能可预渲染复合片段以获得更流畅的回放
- **快捷键**：`Alt/Option + G` 创建，`Shift + Alt/Option + G` 取消

### 1.2 技术本质

从数据模型角度看，复合片段是一个**非破坏性的引用容器（reference container）**：

```
复合片段 = {
  素材引用列表: [clip1, clip2, clip3, ...],
  时间轴映射: { 原时间 → 复合内时间 },
  效果链: [全局滤镜...],
  预渲染缓存: 可选
}
```

它**不立即渲染**——它只是时间线上的一个逻辑分组。只有在以下情况才真正"烘焙"(bake)：

1. **导出时**：所有轨道被合成为最终单一音视频流
2. **预渲染(Pre-process)时**：生成中间缓存文件
3. **施加需要合并的效果时**（如全局变速）

### 1.3 对应到FFmpeg

复合片段的"打包+合成"行为对应FFmpeg中的 **`filter_complex` 滤镜图**：

#### 场景A：多个视频素材叠加到同一画面（画中画、分屏）

```bash
# 剪映：选两个视频轨道 → 新建复合片段
# FFmpeg：filter_complex + overlay
ffmpeg -i video1.mp4 -i video2.mp4 -filter_complex \
  "[0:v]scale=1080:1920[bg]; \
   [1:v]scale=540:960[fg]; \
   [bg][fg]overlay=x=270:y=480[vout]" \
  -map "[vout]" -c:v libx264 output.mp4
```

#### 场景B：多个视频素材时间线拼接（前后衔接）

```bash
# 剪映：选多个素材 → 新建复合片段（顺序排列）
# FFmpeg方式1：concat filter（需要重编码，最灵活）
ffmpeg -i clip1.mp4 -i clip2.mp4 -i clip3.mp4 -filter_complex \
  "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[vout][aout]" \
  -map "[vout]" -map "[aout]" output.mp4

# FFmpeg方式2：concat demuxer（流复制，最快但要求编码一致）
# file list.txt 内容：
#   file 'clip1.mp4'
#   file 'clip2.mp4'
ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4
```

#### 场景C：视频+音频+文字+贴纸全部打包

```bash
# 剪映：选中视频轨+音频轨+文字轨 → 新建复合片段
# FFmpeg：多输入 filter_complex，视频overlay + 音频amix
ffmpeg -i video.mp4 -i audio.mp3 -i subtitle.srt -filter_complex \
  "[0:v]ass=subtitle.ass[vsub]; \
   [0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]" \
  -map "[vsub]" -map "[aout]" output.mp4
```

#### 场景D：对复合片段施加全局效果（如整体变速）

```bash
# 剪映：选中复合片段 → 改变速度
# FFmpeg：先合成再施加全局滤镜
ffmpeg -i compound_input.mp4 -filter_complex \
  "[0:v]setpts=0.5*PTS,fps=60[vout]; \
   [0:a]atempo=2.0[aout]" \
  -map "[vout]" -map "[aout]" output.mp4
```

### 1.4 关键映射关系总结

| 剪映操作 | FFmpeg对应 |
|---------|-----------|
| 选中多轨道素材 | 多个 `-i` 输入 |
| 新建复合片段（叠加） | `filter_complex` + `overlay` |
| 新建复合片段（拼接） | `filter_complex` + `concat` filter 或 concat demuxer |
| 复合片段内多音频混合 | `amix` / `acrossfade` |
| 对复合片段全局变速 | `setpts` + `atempo` |
| 对复合片段全局调色 | `eq` / `hue` / `curves` |
| 预渲染(Pre-process) | 提前执行一次 `-c:v libx264` 中间编码 |
| 取消复合片段 | 无直接对应（非破坏性操作，删除引用即可） |

### 1.5 feedaccount现有代码中的对应

`video-remix.js` 中的 `concatWithTransition()` 函数已经在做类似的事：
- 多个视频片段 → `-filter_complex` 构建 xfade 链 → 输出单一流
- 这本质上就是一个"复合片段"的FFmpeg实现

`overlayImagesOnVideo()` 函数也是复合片段的体现：
- 视频轨 + 多个图片轨 → overlay 链 → 输出单一流

---

## 2. 分离音频 (Separate Audio / 音频分离)

### 2.1 概念定义

**来源：CapCut官方文档 + Hollyland教程**

> "To separate the audio from your video, click on the uploaded video in the timeline. Right-click the video clip. Select 'Separate audio'. This instantly detaches the audio from the video, allowing you to split sound, split audio from video, and edit both parts independently."
> — CapCut官方资源

分离音频的核心行为：

1. **拆分音视频流**：将原本绑定在一个视频素材中的视频流和音频流拆开
2. **独立轨道**：视频留在原轨道，音频被提取到新的独立音频轨道
3. **独立编辑**：两条轨道可以分别裁剪、移动、删除、施加效果
4. **保持同步引用**：分离后仍可重新对齐（如果手动操作的话）

### 2.2 技术本质

一个视频文件（如MP4）在容器层包含：
- 视频流（Video Track）
- 音频流（Audio Track）

剪映的"分离音频"操作在编辑器层面做的是：
1. 读取素材文件的流信息
2. 在时间线上将音频流"解绑"——创建一个新的独立音频片段引用
3. 视频片段的音频被静音或移除
4. 两个片段保持相同的时间码起始点

这是**纯编辑层面的操作**，不涉及实际渲染。直到导出时才真正处理。

### 2.3 对应到FFmpeg

#### 操作A：提取音频到独立文件

```bash
# 剪映：右键视频 → 分离音频
# FFmpeg：提取音频流（不转码）
ffmpeg -i input.mp4 -vn -acodec copy audio.aac

# 或转码为WAV/MP3（更通用）
ffmpeg -i input.mp4 -vn -acodec libmp3lame -b:a 192k audio.mp3
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 44100 audio.wav
```

#### 操作B：提取无音频的纯视频

```bash
# 剪映：分离后视频轨（无音频）
ffmpeg -i input.mp4 -an -c:v copy video_silent.mp4
```

#### 操作C：一次性分离（同时输出视频和音频）

```bash
# 一步分离音视频
ffmpeg -i input.mp4 -map 0:v -map 0:a \
  -c copy video_only.mp4 \
  -c copy audio_only.aac
```

#### 操作D：分离后用在新轨道（与其它素材合成）

```bash
# 剪映：分离音频 → 新素材放新轨 → 合成
# FFmpeg：先提取音频，再与新视频合成
ffmpeg -i original.mp4 -vn -c:a copy extracted_audio.aac
ffmpeg -i new_video.mp4 -i extracted_audio.aac \
  -map 0:v -map 1:a \
  -c:v copy -c:a copy output.mp4
```

#### 操作E：用filter_complex在同一命令中分离+重组合

```bash
# 分离原视频的音频，与新的视频画面组合
ffmpeg -i original.mp4 -i new_video.mp4 -filter_complex \
  "[1:v]scale=1080:1920[vout]; \
   [0:a]volume=1.0[aout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -c:a aac output.mp4
```

### 2.4 feedaccount现有代码中的对应

`video-remix.js` 中的 `mixBackgroundMusic()` 函数已经实现了类似"分离+重组"的逻辑：

```javascript
// 第650-651行：保留视频原声 + 叠加背景音乐
filterParts.push(`[0:a]volume=1.0[a0];[a0][${musicOut}]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
```

这里 `[0:a]` 就是从视频输入中"分离"出来的音频流，然后与背景音乐 `amix` 合并。

---

## 3. 关键问题：「分离音频→新建复合片段→TikTok显示原声」的原理

### 3.1 操作流程回顾

```
原视频(有音频)
  ↓ 右键→分离音频
视频轨(无音频) + 音频轨(原视频音频)
  ↓ 添加新素材到新轨道
视频轨(无音频) + 音频轨(原音频) + 新素材轨(视频/音频)
  ↓ 选中音频轨+新素材轨 → 右键→新建复合片段
复合片段(原音频 + 新素材，合成为单一音视频流)
  ↓ 导出
最终视频文件(音频是"烘焙"在文件里的，非TikTok库音乐)
  ↓ 上传到TikTok
TikTok显示「原声」标志 ✓
```

### 3.2 TikTok"原声"(Original Sound)识别机制

**核心来源：Soundstripe官方教程（2026年8月更新）**

> "Original Sound is TikTok's name for any audio track that comes directly from a creator's video rather than from TikTok's built-in audio library. When you post a video without attaching a library track, TikTok packages your video's audio as a standalone sound, links it to your profile, and makes it available for other creators to use."
>
> "TikTok's system checks whether a posted video contains audio from its official library. If none is detected, it automatically tags the audio as Original Sound and credits it to the posting account."
> — Soundstripe

#### TikTok音频识别的双层机制

**第一层：库音乐匹配（Audio Fingerprinting / Content ID）**

TikTok使用音频指纹技术（类似Shazam/ACRCloud）扫描上传视频的音频：
1. 提取音频指纹（基于频谱特征的哈希）
2. 与TikTok商业音乐库的指纹数据库比对
3. 如果匹配到库内曲目 → 标记为该曲目名称
4. 如果未匹配到库内曲目 → 进入第二层判断

**第二层：原声标记（Original Sound Assignment）**

当音频指纹未匹配到任何库曲目时：
1. TikTok将该音频标记为"Original Sound - [用户名]"
2. 创建一个独立的Sound Page
3. 该声音被关联到发布者的账号
4. 其他用户可以使用该声音（如果视频是公开的）

### 3.3 为什么"复合片段导出"会被识别为原声

关键在于**复合片段导出后的文件结构**：

#### 复合片段导出做了什么

当你把"分离出的音频 + 新素材"新建复合片段并导出时：

1. **音频被"烘焙"(baked/embedded)进视频文件**：导出的MP4文件包含一条音视频复合流，音频不可分离地嵌入在容器中
2. **音频来源信息丢失**：原始音频和新素材的音频被混音(amix)成单条音轨，无法追溯来源
3. **无TikTok库标记**：这个音频从未通过TikTok应用内"添加音乐"功能附加，因此没有TikTok的库引用元数据
4. **音频指纹不匹配库**：混音后的音频是原始音频+新素材的组合体，其指纹特征与任何单一库曲目都不匹配

#### 对比：什么情况不会显示原声

| 操作方式 | TikTok识别结果 |
|---------|--------------|
| 直接在TikTok应用内添加库音乐 | 显示音乐名称，非原声 |
| 上传带库音乐的视频(指纹匹配) | 显示匹配的库曲目名称 |
| 上传无任何库音乐的纯原创音频 | **显示"原声"** ✓ |
| CapCut导出(TikTok库音乐通过CapCut添加) | 取决于CapCut是否注入TikTok库引用元数据 |
| CapCut复合片段导出(混合音频) | **显示"原声"** ✓ |

#### 核心原理

```
TikTok的判断逻辑：
音频指纹 → 匹配库曲目？
  ├─ 是 → 标记为库曲目
  └─ 否 → 标记为"原声" + 关联到发布账号

复合片段导出的音频：
  - 是多轨混音后的单一音轨
  - 从未通过TikTok库附加
  - 指纹特征是混合体，不匹配任何单一库曲目
  → TikTok判定为"原声" ✓
```

### 3.4 更深层的原因：元数据和音频指纹

TikTok判断"原声"有两个信号维度：

#### 信号1：元数据标记（Metadata Flag）

当用户在TikTok应用内"添加音乐"时，TikTok会在视频发布时附带一个**库音乐引用ID**（sound_id）。这个ID直接告诉TikTok"这个视频用了库里的哪首歌"。

CapCut导出的视频**不包含任何TikTok库音乐引用ID**，因为音频是在CapCut内处理的，完全独立于TikTok的音频系统。

#### 信号2：音频指纹比对（Audio Fingerprinting）

即使没有元数据标记，TikTok也会通过音频指纹系统扫描上传视频的音频。这个系统会：
1. 提取音频的频谱特征
2. 生成指纹哈希
3. 与库内曲目的指纹数据库匹配

复合片段导出后的音频是**混音产物**——原始视频音频 + 新素材音频被 `amix` 成一条流。混音后的指纹特征：
- 与原始视频音频的指纹**不完全匹配**（因为叠加了新素材的音频）
- 与新素材音频的指纹**也不完全匹配**（因为叠加了原始音频）
- 与库内任何曲目的指纹**都不匹配**

因此，TikTok的音频指纹系统判定为"未匹配到库曲目" → 标记为原声。

### 3.5 用FFmpeg复现这个工作流

以下是完整的FFmpeg命令链，复现"分离音频→添加新素材→复合→导出"的操作：

#### 步骤1：分离原视频音频

```bash
ffmpeg -i original.mp4 -vn -c:a copy original_audio.aac
# 或转码
ffmpeg -i original.mp4 -vn -c:a aac -b:a 128k original_audio.aac
```

#### 步骤2：准备新素材（确保有音频）

```bash
# 如果新素材需要归一化
ffmpeg -i new_clip.mp4 -vf scale=1080:1920:flags=bicubic,format=yuv420p \
  -c:v libx264 -crf 23 -c:a aac -b:a 128k new_clip_norm.mp4
```

#### 步骤3：复合（混音音频 + 合成视频）

```bash
# 将原视频音频与新素材合成（这就是"新建复合片段+导出"）
ffmpeg -i new_clip_norm.mp4 -i original_audio.aac -filter_complex \
  "[1:a]volume=1.0[a1]; \
   [0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]" \
  -map 0:v -map "[aout]" \
  -c:v copy -c:a aac -b:a 128k \
  -movflags +faststart output_compound.mp4
```

#### 步骤4（可选）：如果原视频音频需要与新素材视频的画面同步

```bash
# 更完整的复合：新素材视频 + 原视频音频 + 新素材自身音频（混音）
ffmpeg -i new_clip.mp4 -i original_audio.aac -filter_complex \
  "[0:a]volume=0.5[a0]; \
   [1:a]volume=1.0,adelay=0:all=1[a1]; \
   [a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]" \
  -map 0:v -map "[aout]" \
  -c:v libx264 -crf 23 -c:a aac -b:a 128k \
  -movflags +faststart output_compound.mp4
```

### 3.6 feedaccount项目中的实现建议

当前 `video-remix.js` 的 `mixBackgroundMusic()` 函数已经实现了类似逻辑——保留视频原声 + 叠加背景音乐。但要做"TikTok原声"效果，关键区别是：

1. **不要使用TikTok库音乐作为背景音乐** → 使用自己的音频素材
2. **确保最终输出的音频是混合体** → 指纹不匹配任何单一来源
3. **不注入任何TikTok库引用元数据** → 保持音频为纯文件内嵌

现有代码的 `musicScope: "original"` 选项（第590-593行）已经支持"仅在主视频区间混入音乐"：
```javascript
case "original":
  return tl.main ? [{ start: tl.main.start, end: tl.main.end }] : [{ start: 0, end: tl.total }];
```

这个模式正好对应了"原视频音频 + 新音频混合"的场景。

---

## 4. 完整的FFmpeg命令映射表

| 剪映操作 | 概念 | FFmpeg核心操作 | feedaccount代码位置 |
|---------|------|----------------|-------------------|
| 新建复合片段(叠加) | 多轨打包为单一实体 | `filter_complex` + `overlay` | `overlayImagesOnVideo()` |
| 新建复合片段(拼接) | 多素材顺序合成 | `filter_complex` + `concat` 或 concat demuxer | `concatVideos()`, `concatWithTransition()` |
| 新建复合片段(混音) | 多音频轨合成 | `filter_complex` + `amix` | `mixBackgroundMusic()` |
| 分离音频 | 解绑音视频流 | `-vn` 提音频 / `-an` 提纯视频 | `mixBackgroundMusic()` 中 `[0:a]` 引用 |
| 预渲染复合片段 | 提前烘焙中间结果 | 中间 `-c:v libx264` 编码 | `processSingleVideo()` 的中间输出 |
| 全局变速(复合片段) | 整体速度调整 | `setpts` + `atempo` | `processSingleVideo()` L214-219 |
| 全局调色(复合片段) | 整体色彩调整 | `hue` + `eq` | `processSingleVideo()` L257-260 |

---

## 5. 技术要点总结

### 5.1 复合片段 ≠ 立即渲染

剪映的复合片段在编辑阶段是**非破坏性引用容器**，不立即渲染。导出时才将多轨道合成为单一流。这对应FFmpeg的 `filter_complex` 在一次命令中处理多输入→多滤镜→单一输出的模式。

### 5.2 分离音频 = 流解复用

剪映的分离音频在技术上是**容器层的流解复用(demux)**，对应FFmpeg的 `-vn` / `-an` / `-map` 操作。

### 5.3 TikTok原声 = 无库匹配 + 无库元数据

TikTok识别"原声"的核心逻辑：
1. **无库音乐引用元数据**（音频不是通过TikTok应用内"添加音乐"附加的）
2. **音频指纹不匹配库曲目**（混音后的指纹特征是独特组合体）

复合片段导出满足这两个条件：
- 音频是在外部编辑器(CapCut)中处理并烘焙进文件的
- 混音后的音频指纹不匹配任何单一库曲目

### 5.4 feedaccount的启示

对于TikTok养号/发布，如果想要"原声"效果：
1. 在FFmpeg中用 `amix` 将原视频音频与自有音频素材混合
2. 不要使用TikTok商业音乐库的曲目
3. 确保最终输出的MP4文件中音频是内嵌的单一音轨
4. 这样上传后TikTok会自动标记为"原声 - [账号名]"
