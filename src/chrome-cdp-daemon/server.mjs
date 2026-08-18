/**
 * Chrome CDP Daemon — 通过 CDP 连接 Chrome 实例，暴露统一任务 API。
 *
 * 架构：
 *   yix-new-api → HTTP → 本守护进程 → Playwright connectOverCDP → Chrome → 网页端
 *
 * 统一任务 API：
 *   POST /api/tasks   — 提交任务（异步，立即返回 taskNo）
 *   GET  /api/tasks/{taskNo} — 轮询任务状态
 *   POST /api/files   — 上传文件（multipart）
 *   GET  /outputs/{filename} — 下载输出文件
 *   GET  /health      — 健康检查
 *   POST /api/execute — 通用 Playwright 命令（调试用）
 *   POST /api/screenshot — 截图（调试用）
 *
 * 环境变量：
 *   CDP_TARGET_URL  — Chrome CDP 调试地址，默认 http://localhost:9222
 *   DAEMON_PORT     — 本服务监听端口，默认 9223
 *   CHATGPT_URL     — ChatGPT 网页地址，默认 https://chatgpt.com
 */

import http from 'http'
import { chromium } from 'playwright'
import { existsSync, writeFileSync, mkdirSync, unlinkSync, createReadStream, readFileSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ===== 配置 =====
const CDP_URL = process.env.CDP_TARGET_URL || 'http://localhost:9222'
const PORT = parseInt(process.env.DAEMON_PORT || '9223', 10)
const HOST = process.env.DAEMON_HOST || '0.0.0.0'
const CHATGPT_URL = process.env.CHATGPT_URL || 'https://chatgpt.com'
const DEBUG = process.argv.includes('--debug')
const TMP_DIR = join(__dirname, 'tmp')
const OUTPUTS_DIR = process.env.DAEMON_OUTPUTS_DIR || join(__dirname, 'outputs')

// Ensure directories exist
mkdirSync(TMP_DIR, { recursive: true })
mkdirSync(OUTPUTS_DIR, { recursive: true })

function ts() {
  const d = new Date()
  const utc = d.getTime() + d.getTimezoneOffset() * 60000
  return new Date(utc + 8 * 3600000).toISOString().replace('Z', '+08:00')
}
let log = function(...args) {
  console.log(`[${ts()}]`, ...args)
}
let logErr = function(...args) {
  console.error(`[${ts()}]`, ...args)
}

// ===== 工具函数 =====
function sendJSON(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

/**
 * 解析 multipart/form-data 请求体，返回 { fieldName: string | { filename, data } }
 */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || ''
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/)
    if (!boundaryMatch) { reject(new Error('No boundary in content-type')); return }
    const boundary = Buffer.from('--' + boundaryMatch[1])
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const parts = {}
      let pos = 0
      while (pos < buffer.length) {
        const start = buffer.indexOf(boundary, pos)
        if (start === -1) break
        const afterBoundary = start + boundary.length
        // Skip \r\n after boundary
        const partStart = afterBoundary + 2
        const nextBoundary = buffer.indexOf(boundary, partStart)
        if (nextBoundary === -1) break
        // Part data is between partStart and nextBoundary - 2 (remove trailing \r\n)
        const partBuffer = buffer.slice(partStart, nextBoundary - 2)
        // Find header/body separator
        const headerEnd = partBuffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) { pos = nextBoundary; continue }
        const headers = partBuffer.slice(0, headerEnd).toString()
        const body = partBuffer.slice(headerEnd + 4)
        // Parse Content-Disposition
        const nameMatch = headers.match(/name="([^"]+)"/)
        const filenameMatch = headers.match(/filename="([^"]+)"/)
        if (nameMatch) {
          const name = nameMatch[1]
          if (filenameMatch) {
            parts[name] = { filename: filenameMatch[1], data: body }
          } else {
            parts[name] = body.toString()
          }
        }
        pos = nextBoundary
      }
      resolve(parts)
    })
    req.on('error', reject)
  })
}

// ===== CDP 连接管理 =====
let browser = null
let context = null
let page = null

async function connectCDP() {
  log('正在连接 CDP:', CDP_URL)
  browser = await chromium.connectOverCDP(CDP_URL)
  const contexts = browser.contexts()
  context = contexts[0] || await browser.newContext()
  const pages = context.pages()
  page = pages.find(p => p.url().includes('chatgpt.com')) || pages[0] || await context.newPage()
  log('CDP 连接成功, 当前页面:', page.url())
  return { browser, context, page }
}

async function ensureConnection() {
  if (!browser || !page) {
    await connectCDP()
    return
  }
  try {
    await page.evaluate(() => 1)
  } catch {
    log('CDP 连接已断开，正在重连...')
    browser = null
    context = null
    page = null
    await connectCDP()
  }
}

// ===== 文件存储 =====
const fileStore = new Map() // fileId → { localPath, filename, size, createdAt }

setInterval(() => {
  const now = Date.now()
  for (const [fileId, record] of fileStore) {
    if (now - record.createdAt > 3600000) {
      try { unlinkSync(record.localPath) } catch {}
      fileStore.delete(fileId)
      if (DEBUG) log('清理过期文件:', fileId)
    }
  }
}, 600000)

// ===== 任务存储 =====
const taskStore = new Map() // taskNo → { status, outputs, error, progress, startedAt, completedAt }

setInterval(() => {
  const now = Date.now()
  for (const [taskNo, task] of taskStore) {
    // 清理已完成且超过 2 小时的任务
    if (task.completedAt && now - task.completedAt > 7200000) {
      taskStore.delete(taskNo)
      if (DEBUG) log('清理过期任务:', taskNo)
    }
  }
}, 600000)

// ===== 并发控制（单浏览器同一时间只能处理一个任务）=====
let taskRunning = false
const taskQueue = []

function enqueueTask(taskNo, type, params) {
  taskQueue.push({ taskNo, type, params })
  processQueue()
}

async function processQueue() {
  if (taskRunning || taskQueue.length === 0) return
  taskRunning = true
  const { taskNo, type, params } = taskQueue.shift()
  const handler = taskHandlers[type]
  if (!handler) {
    taskStore.set(taskNo, { status: 'failed', outputs: [], error: `Unknown task type: ${type}`, completedAt: Date.now() })
    taskRunning = false
    processQueue()
    return
  }
  handler(taskNo, params)
    .catch(err => {
      logErr(`任务 ${taskNo} 异常:`, err.message)
      taskStore.set(taskNo, { status: 'failed', outputs: [], error: err.message, completedAt: Date.now() })
    })
    .finally(() => {
      taskRunning = false
      processQueue()
    })
}

// ===== 任务处理器注册 =====
const taskHandlers = {}

function registerTaskHandler(type, handler) {
  taskHandlers[type] = handler
}

async function submitTask(type, params) {
  const handler = taskHandlers[type]
  if (!handler) throw new Error(`Unknown task type: ${type}`)
  const taskNo = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  taskStore.set(taskNo, { status: 'pending', outputs: [], error: null, progress: '0%', startedAt: Date.now() })
  enqueueTask(taskNo, type, params)
  return taskNo
}

// ===== Playwright 命令执行器（调试用）=====
async function executeCommand(page, cmd) {
  const { action, selector, value, url, script, filePath, timeout, key, attribute, x, y, deltaX, deltaY } = cmd
  const t = timeout || 30000

  switch (action) {
    case 'goto':
      await page.goto(url, { timeout: t, waitUntil: 'domcontentloaded' })
      return { ok: true, url: page.url() }
    case 'click':
      await page.click(selector, { timeout: t })
      return { ok: true }
    case 'dblclick':
      await page.dblclick(selector, { timeout: t })
      return { ok: true }
    case 'fill':
      await page.fill(selector, value || '', { timeout: t })
      return { ok: true }
    case 'type':
      await page.type(selector, value || '', { timeout: t, delay: cmd.delay || 0 })
      return { ok: true }
    case 'press':
      await page.press(selector || 'body', key || 'Enter', { timeout: t })
      return { ok: true }
    case 'waitForSelector':
      await page.waitForSelector(selector, { timeout: t, state: cmd.state || 'visible' })
      return { ok: true }
    case 'waitForTimeout':
      await page.waitForTimeout(value || 1000)
      return { ok: true }
    case 'waitForURL':
      await page.waitForURL(url || cmd.urlPattern, { timeout: t })
      return { ok: true }
    case 'textContent':
      const text = await page.textContent(selector, { timeout: t })
      return { ok: true, text }
    case 'innerText':
      const innerText = await page.innerText(selector, { timeout: t })
      return { ok: true, text: innerText }
    case 'innerHTML':
      const html = await page.innerHTML(selector, { timeout: t })
      return { ok: true, html }
    case 'evaluate':
      const result = await page.evaluate(script)
      return { ok: true, result }
    case 'screenshot':
      const buffer = await page.screenshot({ fullPage: cmd.fullPage || false, type: cmd.type || 'png' })
      return { ok: true, base64: buffer.toString('base64') }
    case 'upload':
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: t })
      if (selector) await page.click(selector)
      const fileChooser = await fileChooserPromise
      await fileChooser.setFiles(filePath)
      return { ok: true }
    case 'setInputFiles':
      await page.setInputFiles(selector, filePath)
      return { ok: true }
    case 'getAttribute':
      const attrVal = await page.getAttribute(selector, attribute || 'href', { timeout: t })
      return { ok: true, value: attrVal }
    case 'count':
      const count = await page.locator(selector).count()
      return { ok: true, count }
    case 'isVisible':
      const visible = await page.locator(selector).isVisible()
      return { ok: true, visible }
    case 'scroll':
      if (selector) {
        await page.locator(selector).scrollIntoViewIfNeeded({ timeout: t })
      } else {
        await page.evaluate((args) => window.scrollBy(args.dx, args.dy), { dx: deltaX || 0, dy: deltaY || 0 })
      }
      return { ok: true }
    case 'hover':
      await page.hover(selector, { timeout: t })
      return { ok: true }
    case 'select':
      const selected = await page.selectOption(selector, value, { timeout: t })
      return { ok: true, selected }
    case 'url':
      return { ok: true, url: page.url() }
    case 'title':
      return { ok: true, title: await page.title() }
    default:
      return { ok: false, error: `Unknown action: ${action}` }
  }
}

// ===== ChatGPT 自动化函数 =====

async function ensureChatGPT() {
  await ensureConnection()
  if (!page.url().includes('chatgpt.com')) {
    log('导航到 ChatGPT...')
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)
  }
}

function getInputSelector() {
  return '#prompt-textarea'
}

async function chatgptSendMessage(text, opts = {}) {
  await ensureChatGPT()
  const inputSel = getInputSelector()
  await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' })

  // ChatGPT 输入框是 ProseMirror contenteditable div，不是 textarea
  // 方案1: 聚焦输入框 → 清空 → 用 insertText 命令插入文本（瞬间完成）
  let filled = false
  try {
    await page.click(inputSel)
    await page.waitForTimeout(200)
    // 清空已有内容
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(50)
    // 用 document.execCommand('insertText') 插入（ProseMirror 支持）
    filled = await page.evaluate((content) => {
      const editor = document.querySelector('#prompt-textarea')
      if (!editor) return false
      editor.focus()
      // 清空
      const sel = window.getSelection()
      sel.selectAllChildren(editor)
      sel.deleteFromDocument()
      // 插入文本
      return document.execCommand('insertText', false, content)
    }, text)
    if (filled) log('提示词已通过 insertText 填充')
  } catch (e) { log('insertText 方式失败: ' + e.message) }

  // 方案2: 如果 insertText 失败，用 page.fill
  if (!filled) {
    try {
      await page.click(inputSel)
      await page.waitForTimeout(100)
      await page.fill(inputSel, text)
      log('提示词已通过 fill 填充')
      filled = true
    } catch (e) {
      log('fill 方式失败: ' + e.message)
    }
  }

  // 方案3: 最后回退到剪贴板粘贴
  if (!filled) {
    log('回退到剪贴板粘贴')
    await page.click(inputSel)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.evaluate((t) => navigator.clipboard.writeText(t), text)
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+v')
  }

  await page.waitForTimeout(500)

  const sendSel = 'button[aria-label="发送提示"], button[aria-label="Send"], button[aria-label="发送"], button[data-testid="send-button"]'
  let sent = false
  for (let attempt = 0; attempt < 600; attempt++) {  // 最多等10分钟
    try {
      const state = await page.evaluate(() => {
        // 先用 aria-label 匹配
        const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]']
        for (const sel of selectors) {
          const btn = document.querySelector(sel)
          if (btn) return { found: true, disabled: btn.disabled, visible: btn.offsetParent !== null }
        }
        // 再用 composer-submit-button class 匹配（排除 stop-button）
        const submitBtns = document.querySelectorAll('button[class*="composer-submit-button"]')
        for (const btn of submitBtns) {
          if (btn.dataset.testid === 'stop-button') continue
          if (btn.offsetParent !== null) return { found: true, disabled: btn.disabled, visible: true }
        }
        return { found: false }
      })
      if (state.found && !state.disabled && state.visible) {
        // 用 evaluate 直接点击
        await page.evaluate(() => {
          const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]']
          for (const sel of selectors) {
            const btn = document.querySelector(sel)
            if (btn && !btn.disabled) { btn.click(); return }
          }
          const submitBtns = document.querySelectorAll('button[class*="composer-submit-button"]')
          for (const btn of submitBtns) {
            if (btn.dataset.testid === 'stop-button') continue
            if (btn.offsetParent !== null && !btn.disabled) { btn.click(); return }
          }
        })
        sent = true
        log('消息已通过发送按钮发送')
        break
      } else if (state.found && state.disabled) {
        // 按钮存在但disabled（文件可能还在上传），继续等
        if (attempt % 10 === 0) log(`等待发送按钮可用... (${attempt}s)`)
        await page.waitForTimeout(1000)
      } else {
        // 按钮还没渲染出来，继续等
        await page.waitForTimeout(1000)
      }
    } catch (err) {
      if (DEBUG) log('发送尝试失败:', err.message)
      await page.waitForTimeout(500)
    }
  }
  if (!sent) {
    // 后备: 用 Ctrl+Enter 提交（ChatGPT 快捷键）
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(500)
    // 如果 Ctrl+Enter 也不行，再试普通 Enter
    const stillGenerating = await isStillGenerating().catch(() => false)
    if (!stillGenerating) {
      await page.keyboard.press('Enter')
    }
    log('消息已通过快捷键发送（后备）')
  }
  log('消息已发送:', text.slice(0, 80) + (text.length > 80 ? '...' : ''))
  return { ok: true }
}

async function chatgptUploadFile(filePath, opts = {}) {
  await ensureChatGPT()
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)

  await dismissModal()

  // 方式1: 直接用 setInputFiles 操作 input#upload-files（小文件可用）
  try {
    const fileInput = page.locator('input#upload-files')
    const inputCount = await fileInput.count()
    log(`input#upload-files 找到 ${inputCount} 个`)
    if (inputCount > 0) {
      // 记录上传前的 file-tile 数量
      const tilesBefore = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
      // 先尝试 setInputFiles（小文件有效）
      try {
        await fileInput.first().setInputFiles(filePath)
        await page.waitForTimeout(3000)
        const tilesAfter = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
        log(`setInputFiles 完成, tilesBefore=${tilesBefore} tilesAfter=${tilesAfter}`)
        if (tilesAfter > tilesBefore) { log('文件已上传 (input#upload-files):', filePath); return { ok: true, method: 'input-direct' } }
      } catch (sizeErr) {
        log(`setInputFiles 失败(可能文件过大): ${sizeErr.message.substring(0, 80)}`)
        // setInputFiles 可能实际已上传成功但方法超时，先检查 tile 数量是否增加
        const tilesAfter = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
        if (tilesAfter > tilesBefore) {
          log('setInputFiles 超时但文件已上传成功，跳过 DataTransfer')
          return { ok: true, method: 'input-direct-timeout' }
        }
        // 大文件: 用 CDP 的 Page.handleFileChooser 或直接操作 input
        // 通过 evaluate 设置 input 的 files 属性
        const fileName = filePath.split(/[/\\]/).pop()
        const fileBuffer = readFileSync(filePath)
        const base64 = fileBuffer.toString('base64')
        await page.evaluate(async ({ b64, name }) => {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: 'video/mp4' })
          const file = new File([blob], name, { type: 'video/mp4' })
          const dt = new DataTransfer()
          dt.items.add(file)
          const input = document.querySelector('input#upload-files')
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }, { b64: base64, name: fileName })
        await page.waitForTimeout(3000)
        const tilesAfterDt = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
        log(`DataTransfer 方式完成, tilesBefore=${tilesBefore} tilesAfter=${tilesAfterDt}`)
        if (tilesAfterDt > tilesBefore) { log('文件已上传 (DataTransfer):', filePath); return { ok: true, method: 'datatransfer' } }
      }
    }
  } catch (err) { log('setInputFiles 方式失败: ' + err.message) }

  // 方式2: 点击 plus 按钮 → 点击"添加照片和文件"菜单项 → filechooser
  try {
    const plusBtn = page.locator('button[data-testid="composer-plus-btn"]')
    if (await plusBtn.count() > 0) {
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15000 })
      
      await plusBtn.click({ timeout: 5000 })
      await page.waitForTimeout(1000)
      
      // 用文字匹配"添加照片和文件"菜单项
      const menuItem = page.locator('div[class*="__menu-item"]').filter({ hasText: '添加照片和文件' }).first()
      if (await menuItem.count() > 0) {
        await menuItem.click({ timeout: 5000 })
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(filePath)
        await page.waitForTimeout(3000)
        const attached = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
        if (attached) { log('文件已上传 (plus menu → filechooser):', filePath); return { ok: true, method: 'plus-menu-filechooser' } }
      }
    }
  } catch (err) { if (DEBUG) log('plus 菜单方式失败:', err.message) }

  await dismissModal()
  await page.waitForTimeout(1000)
  await dismissModal()
  const tilesFinal = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
  if (tilesFinal > tilesBefore) {
    log('文件已挂载（最终检测）')
    return { ok: true, method: 'already-attached-final' }
  }
  throw new Error('无法找到文件上传入口')
}

async function getLastAssistantText() {
  return await page.evaluate(() => {
    const selectors = ['[data-message-author-role="assistant"]', 'div[class*="markdown"]', '[data-testid^="conversation-turn-"]']
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel)
      if (elements.length > 0) return elements[elements.length - 1].textContent || ''
    }
    return ''
  })
}

async function isStillGenerating() {
  return await page.evaluate(() => {
    // 方式1: 标准 stop-button 存在且可见（生成中会显示）
    const stopBtns = document.querySelectorAll('button[data-testid="stop-button"]')
    for (const btn of stopBtns) { if (btn.offsetParent !== null) return true }

    // 方式2: composer-submit-button 的 aria-label 判断
    const submitBtn = document.querySelector('button[class*="composer-submit-button"]')
    if (submitBtn) {
      const aria = (submitBtn.getAttribute('aria-label') || '').toLowerCase()
      // 生成中: aria-label 包含停止/stop
      if (aria.includes('停止') || aria.includes('stop') || aria.includes('中断') || aria.includes('cancel')) return true
      // 已完成: aria-label 是发送/语音功能 → 明确不在生成
      if (aria.includes('发送') || aria.includes('send') || aria.includes('语音') || aria.includes('voice')) return false
    }

    // 默认: 没有停止按钮也没有明确的完成信号，检查是否有 stop 相关 class
    const allStopLike = document.querySelectorAll('button[class*="stop"], button[data-testid*="stop"]')
    for (const btn of allStopLike) { if (btn.offsetParent !== null) return true }

    return false
  })
}

async function chatgptWaitForResponse(opts = {}) {
  const timeout = opts.timeout || 300000
  const pollInterval = opts.pollInterval || 2000
  const stableCount = opts.stableCount || 3
  const startTimeout = opts.startTimeout || 60000
  const minResponseLength = opts.minResponseLength || 0

  await ensureChatGPT()
  log('等待 ChatGPT 回复...')

  const preText = await getLastAssistantText()
  const startTime = Date.now()
  let newResponseStarted = false

  while (Date.now() - startTime < startTimeout) {
    const currentText = await getLastAssistantText()
    if (currentText && currentText !== preText) { newResponseStarted = true; log('新回复已开始出现'); break }
    if (await isStillGenerating()) { newResponseStarted = true; log('检测到 GPT 开始处理'); break }
    await page.waitForTimeout(pollInterval)
  }
  if (!newResponseStarted) { log('警告: 未检测到新回复开始'); return { ok: false, text: preText, timeout: true, reason: 'response_not_started' } }

  let lastText = ''
  let lastImgCount = 0
  let stableIterations = 0

  while (Date.now() - startTime < timeout) {
    const currentText = await getLastAssistantText()
    const stillGenerating = await isStillGenerating()
    // 检测图片数量（图片生成任务回复的是图片不是文本）
    const currentImgCount = await page.evaluate(() => {
      var turns = document.querySelectorAll('[data-testid^="conversation-turn-"]')
      var lastTurn = null
      for (var i = turns.length - 1; i >= 0; i--) {
        if (turns[i].getAttribute('data-message-author-role') !== 'user') { lastTurn = turns[i]; break }
      }
      if (!lastTurn) return 0
      return lastTurn.querySelectorAll('img[src*="estuary/content"], img[src*="oaiusercontent"], img[src*="files."]').length
    }).catch(() => 0)
    if (DEBUG) log(`轮询: textLen=${currentText.length} imgCount=${currentImgCount} stable=${stableIterations}/${stableCount} generating=${stillGenerating}`)

    // 检测 ChatGPT 错误提示
    if (currentText && (currentText.includes('出了点问题') || currentText.includes('请重试') || currentText.includes('Something went wrong') || currentText.includes('try again'))) {
      log('检测到 ChatGPT 错误提示: ' + currentText.substring(0, 100))
      return { ok: false, text: currentText, error: true, reason: 'chatgpt_error', duration: Date.now() - startTime }
    }

    // 文本和图片数量都没变化时认为稳定
    const textStable = currentText === lastText
    const imgStable = currentImgCount === lastImgCount
    if (textStable && imgStable) {
      if (!stillGenerating) {
        // 有图片时跳过文本长度检查，稳定2次即可（6秒）
        if (currentImgCount > 0) {
          stableIterations++
          if (stableIterations >= 2) {
            const duration = Date.now() - startTime
            log(`图片回复完成 (${currentImgCount}张图片, ${Math.round(duration / 1000)}s)`)
            return { ok: true, text: currentText, duration }
          }
        } else if (minResponseLength > 0 && currentText.length < minResponseLength) {
          if (DEBUG) log(`响应过短, 继续等待...`)
        } else if (minResponseLength > 0 && !currentText.includes('{')) {
          if (DEBUG) log(`回复无 JSON 内容, 继续等待...`)
        } else {
          stableIterations++
        }
        const noJson = minResponseLength > 0 && !currentText.includes('{')
        const requiredStable = (minResponseLength > 0 && (currentText.length < minResponseLength || noJson)) ? 999 : (currentText.length < 100 ? 10 : stableCount)
        if (stableIterations >= requiredStable) {
          const duration = Date.now() - startTime
          log(`回复完成 (${(currentText.length / 1000).toFixed(1)}K chars, ${Math.round(duration / 1000)}s)`)
          return { ok: true, text: currentText, duration }
        }
      } else {
        // isStillGenerating 返回 true（还在生成中），重置稳定计数
        stableIterations = 0
      }
    } else {
      stableIterations = 0
      lastText = currentText
      lastImgCount = currentImgCount
    }
    await page.waitForTimeout(pollInterval)
  }
  log('警告: 等待回复超时')
  return { ok: false, text: lastText, timeout: true, duration: Date.now() - startTime }
}

async function dismissModal() {
  try {
    await page.evaluate(() => {
      const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popover"]')
      for (const modal of modals) {
        if (modal.offsetParent === null) continue
        const btns = modal.querySelectorAll('button')
        for (const btn of btns) {
          const text = btn.textContent?.trim() || ''
          if (['确定', 'OK', '好的', 'Close', '关闭'].includes(text) || text.length <= 3) { btn.click(); return true }
        }
      }
      return false
    })
    await page.waitForTimeout(500)
  } catch { /* ignore */ }
}

async function chatgptSendMessageWithFile(text) {
  await ensureChatGPT()
  const inputSel = getInputSelector()
  await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' })
  await page.click(inputSel)
  await page.waitForTimeout(300)

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.type(inputSel, lines[i], { delay: 0 })
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter')
  }
  await page.waitForTimeout(500)

  const enteredText = await page.evaluate(() => document.querySelector('#prompt-textarea')?.textContent || '')
  if (!enteredText.trim()) {
    log('page.type 失败，尝试剪贴板粘贴...')
    await page.evaluate((t) => navigator.clipboard.writeText(t), text)
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(800)
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    const clickResult = await page.evaluate(() => {
      const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[data-testid="send-button"]']
      for (const sel of selectors) {
        const btn = document.querySelector(sel)
        if (btn && !btn.disabled && btn.offsetParent !== null) { btn.click(); return 'clicked' }
      }
      for (const sel of selectors) {
        const btn = document.querySelector(sel)
        if (btn) return btn.disabled ? 'disabled' : 'not-visible'
      }
      return 'not-found'
    })
    if (clickResult === 'clicked') { log('消息已通过发送按钮发送'); break }
    if (clickResult === 'disabled') { await page.waitForTimeout(1000) }
    else break
  }
}

// ===== 任务处理器 =====

/**
 * ChatGPT 视频分析任务
 */
async function handleChatGptAnalyzeVideo(taskNo, params) {
  const { prompt, fileIds = [], options = {} } = params
  const responseTimeout = options.responseTimeout || 1800000

  // 从 fileIds 解析本地文件路径
  if (!fileIds.length) throw new Error('fileIds is required')
  const fileRecord = fileStore.get(fileIds[0])
  if (!fileRecord) throw new Error(`File not found: ${fileIds[0]}`)
  const videoPath = fileRecord.localPath

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '10%', startedAt: Date.now() })

  log(`=== 开始 ChatGPT 视频分析 (taskNo=${taskNo}) ===`)

  // 确保浏览器连接
  await ensureConnection()

  // Step 0: 新建标签页导航到新对话
  log('Step 0: 新建标签页，导航到新对话...')
  page = await context.newPage()
  await dismissModal()
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForTimeout(3000)
  for (let i = 0; i < 3; i++) { await dismissModal(); await page.waitForTimeout(1000) }
  // 点击侧边栏「新聊天」按钮确保是新会话
  try {
    const newChatBtn = page.locator('a[href="/"], a:has-text("新聊天"), button:has-text("新聊天"), button:has-text("New chat"), [class*="__menu-item"]:has-text("新聊天")').first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click({ timeout: 5000, force: true })
      await page.waitForTimeout(2000)
      log('已点击新聊天按钮')
    } else {
      log('未找到新聊天按钮，继续...')
    }
  } catch (e) { log('点击新聊天按钮失败: ' + e.message) }

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '20%', startedAt: taskStore.get(taskNo).startedAt })

  log(`视频: ${videoPath}`)
  log(`提示词: ${(prompt || '').slice(0, 100)}...`)

  // Step 1: 上传视频
  log('Step 1: 上传视频文件...')
  const uploadResult = await chatgptUploadFile(videoPath)
  await dismissModal()

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '40%', startedAt: taskStore.get(taskNo).startedAt })

  // Step 2: 等待上传完成
  log('Step 2: 等待上传处理...')
  await page.waitForTimeout(3000)
  await dismissModal()

  // Step 3: 发送分析提示词
  log('Step 3: 发送分析提示词...')
  await chatgptSendMessage(prompt)

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '60%', startedAt: taskStore.get(taskNo).startedAt })

  // Step 4: 等待回复
  log('Step 4: 等待 ChatGPT 回复...')
  const response = await chatgptWaitForResponse({
    timeout: responseTimeout,
    pollInterval: 3000,
    stableCount: 5,
    minResponseLength: 200,
  })

  log('=== 视频分析完成 ===')
  taskStore.set(taskNo, {
    status: response.ok ? 'completed' : 'failed',
    outputs: response.ok ? [{ type: 'text', content: response.text }] : [],
    error: response.ok ? null : (response.timeout ? '分析超时' : '分析失败'),
    progress: '100%',
    startedAt: taskStore.get(taskNo).startedAt,
    completedAt: Date.now(),
  })
}

/**
 * ChatGPT 纯文本对话任务
 */
async function handleChatGptChat(taskNo, params) {
  const { prompt, options = {} } = params
  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '20%', startedAt: Date.now() })

  await chatgptSendMessage(prompt)
  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '60%', startedAt: taskStore.get(taskNo).startedAt })

  const response = await chatgptWaitForResponse({ timeout: options.responseTimeout || 300000 })
  taskStore.set(taskNo, {
    status: response.ok ? 'completed' : 'failed',
    outputs: response.ok ? [{ type: 'text', content: response.text }] : [],
    error: response.ok ? null : '对话超时',
    progress: '100%',
    startedAt: taskStore.get(taskNo).startedAt,
    completedAt: Date.now(),
  })
}

/**
 * ChatGPT AI 视频混剪任务
 * 上传多个文件（原视频+开头音频+结尾音频+提示词txt）→ 发送 → 等待 → 提取视频链接 → 下载
 */
async function handleChatGptAiRemix(taskNo, params) {
  const { prompt, fileIds = [], options = {} } = params
  const responseTimeout = options.responseTimeout || 1800000
  const serverTaskId = options.taskId || null

  // 临时覆盖 log 函数，让每条日志带上 serverTaskId
  const origLog = log
  const origLogErr = logErr
  if (serverTaskId) {
    log = (...args) => console.log(`[${ts()}]`, `[TASK:${serverTaskId}]`, ...args)
    logErr = (...args) => console.error(`[${ts()}]`, `[TASK:${serverTaskId}]`, ...args)
  }

  try {

  if (!fileIds.length) throw new Error('fileIds is required')

  // 解析所有文件路径
  const filePaths = []
  for (const fileId of fileIds) {
    const record = fileStore.get(fileId)
    if (!record) throw new Error(`File not found: ${fileId}`)
    filePaths.push(record.localPath)
  }

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '5%', startedAt: Date.now() })

  log(`=== 开始 ChatGPT AI 视频混剪 (taskNo=${taskNo}) ===`)
  log(`文件数: ${filePaths.length}`)

  await ensureConnection()

  // Step 0: 新建标签页导航到新对话
  log('Step 0: 新建标签页，导航到新对话...')
  page = await context.newPage()
  await dismissModal()
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForTimeout(3000)
  for (let i = 0; i < 3; i++) { await dismissModal(); await page.waitForTimeout(1000) }
  // 点击侧边栏「新聊天」按钮确保是新会话
  try {
    const newChatBtn = page.locator('a[href="/"], a:has-text("新聊天"), button:has-text("新聊天"), button:has-text("New chat"), [class*="__menu-item"]:has-text("新聊天")').first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click({ timeout: 5000, force: true })
      await page.waitForTimeout(2000)
      log('已点击新聊天按钮')
    } else {
      log('未找到新聊天按钮，继续...')
    }
  } catch (e) { log('点击新聊天按钮失败: ' + e.message) }

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '15%', startedAt: taskStore.get(taskNo).startedAt })

  // Step 1: 依次上传所有文件
  for (let i = 0; i < filePaths.length; i++) {
    log(`Step 1.${i + 1}: 上传文件 ${i + 1}/${filePaths.length}: ${filePaths[i]}`)
    await chatgptUploadFile(filePaths[i])
    await dismissModal()
    await page.waitForTimeout(2000)
    // 重置 already-attached 检测——上传后 file-tile 会增加，下一个文件需要重新触发上传
    // chatgptUploadFile 内部会检查 file-tile 数量，如果已有附件会跳过
    // 所以这里需要在每次上传后清除已有的 file-tile 标记，让下次上传继续
    // 实际上 ChatGPT 的 file-tile 计数会增加，alreadyAttached 检测会误判
    // 修改：通过 page.evaluate 检查当前 file-tile 数量是否等于已上传数量
  }

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '40%', startedAt: taskStore.get(taskNo).startedAt })

  // Step 2: 发送提示词
  log('Step 2: 发送提示词...')
  const promptText = prompt || '请根据上传的文件生成混剪视频'
  await chatgptSendMessage(promptText)

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '50%', startedAt: taskStore.get(taskNo).startedAt })

  // Step 3: 等待回复
  log('Step 3: 等待 ChatGPT 回复...')
  const response = await chatgptWaitForResponse({
    timeout: responseTimeout,
    pollInterval: 3000,
    stableCount: 5,
    minResponseLength: 50,
  })

  taskStore.set(taskNo, { status: 'running', outputs: [], error: null, progress: '80%', startedAt: taskStore.get(taskNo).startedAt })

  if (!response.ok) {
    taskStore.set(taskNo, {
      status: 'failed', outputs: [], error: 'ChatGPT 回复超时或失败',
      progress: '100%', startedAt: taskStore.get(taskNo).startedAt, completedAt: Date.now(),
    })
    return
  }

  log(`回复长度: ${response.text.length} 字符`)

  // Step 4: 从回复中提取视频下载链接
  log('Step 4: 提取视频下载链接...')
  const videoLinks = extractVideoLinks(response.text)

  if (!videoLinks.length) {
    log('未找到视频下载链接，尝试下载图片...')
    // 下载 ChatGPT 生成的图片
    const images = await downloadGeneratedImages(OUTPUTS_DIR)
    if (images.length > 0) {
      const outputs = [
        { type: 'text', content: response.text },
        ...images.map(img => ({ type: 'image', filename: img.filename, url: img.downloadUrl || `/outputs/${img.filename}` })),
      ]
      taskStore.set(taskNo, {
        status: 'completed', outputs, error: null, progress: '100%',
        startedAt: taskStore.get(taskNo).startedAt, completedAt: Date.now(),
      })
      log(`=== AI 混剪完成，下载了 ${images.length} 张图片 ===`)
      return
    }

    log('未找到视频链接或图片，保存回复文本')
    taskStore.set(taskNo, {
      status: 'completed', outputs: [{ type: 'text', content: response.text }],
      error: null, progress: '100%',
      startedAt: taskStore.get(taskNo).startedAt, completedAt: Date.now(),
    })
    return
  }

  log(`找到 ${videoLinks.length} 个视频链接: ${videoLinks.join(', ')}`)

  // Step 5: 下载视频文件
  const outputs = [{ type: 'text', content: response.text }]
  for (let i = 0; i < videoLinks.length; i++) {
    const link = videoLinks[i]
    log(`Step 5.${i + 1}: 下载视频 ${i + 1}/${videoLinks.length}: ${link}`)
    try {
      const downloadResult = await downloadFile(link, OUTPUTS_DIR, `ai-remix-${taskNo}-${i + 1}.mp4`)
      outputs.push({ type: 'file', filename: downloadResult.filename, url: `/outputs/${downloadResult.filename}`, originalUrl: link })
      log(`视频已下载: ${downloadResult.filename} (${downloadResult.size} bytes)`)
    } catch (err) {
      logErr(`下载视频失败: ${link} - ${err.message}`)
      outputs.push({ type: 'error', url: link, error: err.message })
    }
  }

  taskStore.set(taskNo, {
    status: 'completed', outputs, error: null, progress: '100%',
    startedAt: taskStore.get(taskNo).startedAt, completedAt: Date.now(),
  })
  log('=== AI 视频混剪完成 ===')
  } catch (err) {
    // 在恢复 log 之前记录异常，确保带 [TASK:xxx] 前缀
    logErr(`任务异常: ${err.message}`)
    throw err
  } finally {
    // 关闭本次任务的标签页（释放浏览器资源，不影响 CDP 连接）
    try {
      if (page) {
        await page.close()
        log('已关闭本次任务标签页')
      }
    } catch (e) { /* 页面可能已关闭，忽略 */ }
    // 恢复原始 log 函数
    log = origLog
    logErr = origLogErr
  }
}

/**
 * 从文本中提取视频下载链接
 */
function extractVideoLinks(text) {
  const links = []
  // 匹配沙盒下载链接（oaiusercontent.com, chatgpt.com/ddm/files 等）
  const patterns = [
    /https?:\/\/[^\s"'<>]+\.mp4/gi,
    /https?:\/\/oaiusercontent\.com[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]*sandbox[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]*chatgpt\.com\/ddm\/files[^\s"'<>]*/gi,
    /https?:\/\/files\.oaiusercontent\.com[^\s"'<>]+/gi,
    /https?:\/\/cdn\.openai\.com[^\s"'<>]+\.mp4/gi,
    /https?:\/\/[^\s"'<>]*download[^\s"'<>]*/gi,
  ]
  const found = new Set()
  for (const pattern of patterns) {
    const matches = text.match(pattern)
    if (matches) for (const m of matches) found.add(m.replace(/[.,;!?)]+$/, ''))
  }
  return [...found]
}

/**
 * 下载文件到本地
 */
async function downloadFile(url, destDir, filename) {
  const { writeFile } = await import('fs/promises')
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, filename)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destPath, buffer)

  return { filename, path: destPath, size: buffer.length }
}

/**
 * 从 ChatGPT 页面提取所有生成的图片 URL 并下载
 */
async function downloadGeneratedImages(destDir) {
  const { writeFile } = await import('fs/promises')
  mkdirSync(destDir, { recursive: true })
  await ensureChatGPT()

  // 在浏览器上下文中提取最后一条助手回复中的图片 URL（去重）
  const imageUrls = await page.evaluate(() => {
    // 找所有对话 turn，排除用户消息
    var turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    var lastAssistantTurn = null;
    for (var i = turns.length - 1; i >= 0; i--) {
      var role = turns[i].getAttribute('data-message-author-role');
      if (role !== 'user') { lastAssistantTurn = turns[i]; break; }
    }
    // 如果没找到 role 标记，用最后一个包含图片且不是用户消息的 turn
    if (!lastAssistantTurn) {
      for (var i = turns.length - 1; i >= 0; i--) {
        var userEl = turns[i].querySelector('[data-message-author-role="user"]');
        if (!userEl && turns[i].querySelectorAll('img').length > 0) { lastAssistantTurn = turns[i]; break; }
      }
    }
    if (!lastAssistantTurn) return [];
    var imgs = lastAssistantTurn.querySelectorAll('img');
    var seenIds = new Set();
    var urls = [];
    for (var img of imgs) {
      var src = img.src;
      if (!src || src.includes('favicon') || src.includes('icon') || src.includes('avatar') || src.includes('logo')) continue;
      // 只取大图（naturalWidth > 900），跳过缩略图
      if (img.naturalWidth < 900) continue;
      // 从 URL 提取 file_id 去重（estuary/content?id=xxx）
      var idMatch = src.match(/[?&]id=([^&]+)/);
      var fileId = idMatch ? idMatch[1] : src;
      if (!seenIds.has(fileId)) { seenIds.add(fileId); urls.push(src) }
    }
    return urls
  })

  log(`找到 ${imageUrls.length} 张图片，开始下载...`)
  const results = []

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i]
    log(`下载图片 ${i + 1}/${imageUrls.length}: ${url.substring(0, 80)}...`)
    try {
      // 在浏览器上下文中 fetch 图片（带 Cookie）
      const base64 = await page.evaluate(async (url) => {
        const resp = await fetch(url)
        if (!resp.ok) return null
        const blob = await resp.blob()
        const reader = new FileReader()
        return new Promise((resolve) => {
          reader.onloadend = () => resolve(reader.result.split(',')[1])
          reader.readAsDataURL(blob)
        })
      }, url)

      if (!base64) { logErr(`图片下载失败 (fetch 返回空): ${url}`); results.push({ url, error: 'fetch failed' }); continue }

      const buffer = Buffer.from(base64, 'base64')
      const filename = `img_${Date.now()}_${i + 1}.png`
      const destPath = join(destDir, filename)
      await writeFile(destPath, buffer)
      results.push({ url, filename, path: destPath, size: buffer.length, downloadUrl: `/outputs/${filename}` })
      log(`图片已下载: ${filename} (${buffer.length} bytes)`)
    } catch (err) {
      logErr(`图片下载失败: ${url} - ${err.message}`)
      results.push({ url, error: err.message })
    }
  }

  return results
}

// 注册任务处理器
registerTaskHandler('chatgpt-analyze-video', handleChatGptAnalyzeVideo)
registerTaskHandler('chatgpt-chat', handleChatGptChat)
registerTaskHandler('chatgpt-ai-remix', handleChatGptAiRemix)

// ===== HTTP 路由 =====
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    res.end()
    return
  }

  try {
    // ===== 健康检查 =====
    if (path === '/health' && method === 'GET') {
      let cdpOk = false
      let pageUrl = null
      try { await ensureConnection(); cdpOk = true; pageUrl = page?.url() } catch {}
      return sendJSON(res, 200, { ok: true, cdpConnected: cdpOk, pageUrl, cdpUrl: CDP_URL, port: PORT })
    }

    // ===== 文件上传 =====
    if (path === '/api/files' && method === 'POST') {
      const parts = await readMultipart(req)
      const filePart = parts.file
      if (!filePart || !filePart.filename) {
        return sendJSON(res, 400, { error: 'No file in multipart data' })
      }
      const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fileDir = join(TMP_DIR, fileId)
      mkdirSync(fileDir, { recursive: true })
      const localPath = join(fileDir, filePart.filename)
      writeFileSync(localPath, filePart.data)
      fileStore.set(fileId, { localPath, filename: filePart.filename, size: filePart.data.length, createdAt: Date.now() })
      log(`文件已上传: ${fileId} (${filePart.filename}, ${filePart.data.length} bytes)`)
      return sendJSON(res, 200, { fileId, filename: filePart.filename, size: filePart.data.length })
    }

    // ===== 统一任务 API: 提交任务 =====
    if (path === '/api/tasks' && method === 'POST') {
      const body = await readBody(req)
      const { type, params = {} } = body
      if (!type) return sendJSON(res, 400, { error: 'Missing task type' })
      const taskNo = await submitTask(type, params)
      log(`任务已提交: ${taskNo} (type=${type})`)
      return sendJSON(res, 200, { taskNo, status: 'pending' })
    }

    // ===== 统一任务 API: 查询任务状态 =====
    if (path.startsWith('/api/tasks/') && method === 'GET') {
      const taskNo = path.replace('/api/tasks/', '')
      const task = taskStore.get(taskNo)
      if (!task) return sendJSON(res, 404, { error: 'Task not found' })
      return sendJSON(res, 200, task)
    }

    // ===== 输出文件静态服务 =====
    if (path.startsWith('/outputs/') && method === 'GET') {
      const filename = path.replace('/outputs/', '')
      const filePath = resolve(OUTPUTS_DIR, filename)
      // 防止路径遍历
      if (!filePath.startsWith(OUTPUTS_DIR)) return sendJSON(res, 403, { error: 'Forbidden' })
      if (!existsSync(filePath)) return sendJSON(res, 404, { error: 'File not found' })
      const stream = createReadStream(filePath)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' })
      stream.pipe(res)
      return
    }

    // ===== 通用命令执行（调试用）=====
    if (path === '/api/execute' && method === 'POST') {
      const body = await readBody(req)
      const commands = body.commands || []
      await ensureConnection()
      const results = []
      for (const cmd of commands) {
        try {
          if (DEBUG) log('执行命令:', cmd.action, cmd.selector || cmd.url || '')
          const result = await executeCommand(page, cmd)
          results.push(result)
          if (!result.ok) return sendJSON(res, 200, { ok: false, error: `Command "${cmd.action}" failed`, results, failedIndex: results.length - 1 })
        } catch (err) {
          results.push({ ok: false, error: err.message })
          return sendJSON(res, 200, { ok: false, error: err.message, results, failedIndex: results.length - 1 })
        }
      }
      return sendJSON(res, 200, { ok: true, results })
    }

    // ===== 截图（调试用）=====
    if (path === '/api/screenshot' && method === 'POST') {
      await ensureConnection()
      const body = await readBody(req)
      const buffer = await page.screenshot({ fullPage: body.fullPage || false, type: body.type || 'png' })
      return sendJSON(res, 200, { ok: true, base64: buffer.toString('base64') })
    }

    // ===== 下载页面中的生成图片 =====
    if (path === '/api/download-images' && method === 'POST') {
      const body = await readBody(req)
      const destDir = body.destDir || OUTPUTS_DIR
      const images = await downloadGeneratedImages(destDir)
      return sendJSON(res, 200, { ok: true, count: images.length, images })
    }

    // ===== 404 =====
    return sendJSON(res, 404, { error: `Not found: ${method} ${path}` })
  } catch (err) {
    logErr('请求处理失败:', err.message)
    return sendJSON(res, 500, { error: err.message })
  }
}

// ===== 启动服务 =====
async function start() {
  log('=== Chrome CDP Daemon 启动 ===')
  log(`CDP 地址: ${CDP_URL}`)
  log(`服务端口: ${PORT}`)
  log(`监听地址: ${HOST}`)
  log(`ChatGPT URL: ${CHATGPT_URL}`)
  log(`Debug 模式: ${DEBUG}`)

  try {
    await connectCDP()
    log('CDP 连接成功')
  } catch (err) {
    logErr('CDP 连接失败:', err.message)
    log('服务仍将启动，等待 CDP 可用后再连接...')
  }

  const server = http.createServer(handleRequest)
  server.listen(PORT, HOST, () => {
    log(`HTTP 服务已启动: http://${HOST}:${PORT}`)
    log('')
    log('可用端点:')
    log('  GET  /health                — 健康检查')
    log('  POST /api/files             — 上传文件 (multipart)')
    log('  POST /api/tasks             — 提交任务 (异步)')
    log('  GET  /api/tasks/{taskNo}    — 查询任务状态')
    log('  GET  /outputs/{filename}    — 下载输出文件')
    log('  POST /api/execute           — 执行 Playwright 命令 (调试)')
    log('  POST /api/screenshot        — 截图 (调试)')
    log('')
    log('已注册任务类型:')
    for (const type of Object.keys(taskHandlers)) {
      log(`  ${type}`)
    }
    log('')
  })

  // 定期心跳检测
  setInterval(async () => {
    try { if (browser) await page.evaluate(() => 1).catch(() => {}) } catch {}
  }, 30000)

  // 优雅关闭
  process.on('SIGINT', async () => {
    log('正在关闭...')
    server.close()
    if (browser) await browser.close().catch(() => {})
    process.exit(0)
  })
}

start().catch((err) => {
  logErr('启动失败:', err)
  process.exit(1)
})
