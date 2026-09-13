# TikTok 无水印高清下载器 (Chrome MV3)

三策略获取最高码率无水印 TikTok 视频，支持单视频下载和达人主页批量下载。

## 安装

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」(右上角)
3. 点击「加载已解压的扩展程序」
4. 选择 `tiktok-downloader` 目录

## 功能

### 单视频下载
- 在 TikTok 视频页面 (`/@username/video/xxx`) 自动注入下载按钮
- 点击工具栏图标查看视频信息和三策略状态
- 点击「下载无水印高清」开始下载

### 达人主页批量下载
- 在达人主页 (`/@username`) 打开弹窗
- 自动加载视频列表（从页面 DOM 或 TikWM API）
- 勾选多个视频，点击「批量下载选中」

## 三策略获取高清 URL

| 策略 | 来源 | 说明 |
|------|------|------|
| 策略1 (最优) | 页面 `bitrateInfo` 数组 | 取 Bitrate 最高的版本，~5-6 Mbps 真高清 |
| 策略2 (次优) | TikWM API `data.play` | 高码率无水印，无需 key |
| 策略3 (兜底) | 页面 `playAddr` | 无水印但低码率 ~1.5-2 Mbps |

下载时按 1→2→3 顺序尝试，失败自动降级。

## 技术要点

- **数据提取**: 解析页面 `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON，路径 `__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct`
- **旧版兼容**: 支持 `SIGI_STATE` 路径
- **绕过 CORS**: TikWM API 和 CDN 下载通过 background service worker 的 `fetch` 完成
- **大文件流式下载**: `fetch → blob → chrome.downloads`，避免内存问题
- **文件命名**: `TikTok_{username}_{videoId}.mp4`
- **SPA 兼容**: MutationObserver 监听 TikTok 路由变化，重新注入按钮

## 文件结构

```
tiktok-downloader/
├── manifest.json     # MV3 配置
├── content.js        # 注入按钮 + 提取 URL
├── content.css       # 按钮样式
├── background.js     # service worker: 下载 + TikWM API
├── popup.html        # 弹窗界面
├── popup.js          # 弹窗逻辑
├── popup.css         # 弹窗样式
├── icons/            # 图标 (16/48/128px)
└── README.md
```

## TikWM API

- 视频信息: `https://www.tikwm.com/api/?url=<TikTok_URL>`
- 用户视频: `https://www.tikwm.com/api/user/posts?username=<username>&count=30`
- 无需 API key

## 注意事项

- TikTok 页面结构可能变化，`__UNIVERSAL_DATA_FOR_REHYDRATION__` 的 JSON 路径需定期维护
- TikWM 为第三方免费 API，可能有限流或不稳定
- 下载大文件时 service worker 有生命周期限制（30s），MV3 中长下载可能被中断
- 批量下载并发数为 2，每个间隔 500ms 避免频率限制
