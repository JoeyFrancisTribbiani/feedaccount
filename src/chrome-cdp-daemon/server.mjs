/**
 * ChatGPT CDP Daemon — 通过 CDP 连接本地 Chrome 实例，暴露 HTTP API 供外部调用。
 *
 * 架构：
 *   调用方 (Worker/API) → HTTP POST → 本守护进程 → Playwright connectOverCDP → Chrome → ChatGPT 网页端
 *
 * 部署：
 *   本机开发：node server.mjs
 *   局域网部署：node server.mjs --host 0.0.0.0 --cdp-host <chrome机器IP>:9222
 *
 * 环境变量：
 *   CDP_TARGET_URL  — Chrome CDP 调试地址，默认 http://localhost:9222
 *   DAEMON_PORT     — 本服务监听端口，默认 9223
 *   CHATGPT_URL     — ChatGPT 网页地址，默认 https://chatgpt.com
 */

import http from 'http'
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ===== 配置 =====
const CDP_URL = process.env.CDP_TARGET_URL || 'http://localhost:9222'
const PORT = parseInt(process.env.DAEMON_PORT || '9223', 10)
const HOST = process.env.DAEMON_HOST || '0.0.0.0'
const CHATGPT_URL = process.env.CHATGPT_URL || 'https://chatgpt.com'
const DEBUG = process.argv.includes('--debug')

function ts() {
  const d = new Date()
  const utc = d.getTime() + d.getTimezoneOffset() * 60000
  return new Date(utc + 8 * 3600000).toISOString().replace('Z', '+08:00')
}
function log(...args) {
  console.log(`[${ts()}]`, ...args)
}
function logErr(...args) {
  console.error(`[${ts()}]`, ...args)
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

// ===== Playwright 命令执行器 =====
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

// ===== ChatGPT 专用操作 =====

/**
 * 确保在 ChatGPT 页面，如果没有则导航过去
 */
async function ensureChatGPT() {
  await ensureConnection()
  if (!page.url().includes('chatgpt.com')) {
    log('导航到 ChatGPT...')
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)
  }
}

/**
 * 获取 ChatGPT 输入框 selector
 * ChatGPT 当前使用 div#prompt-textarea[contenteditable=true] 作为输入框
 */
function getInputSelector() {
  return '#prompt-textarea'
}

/**
 * 获取发送按钮 selector
 * ChatGPT 的发送按钮可能不存在或变化，默认用 Enter 键发送
 */
function getSendButtonSelector() {
  return [
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="发送"]',
  ].join(', ')
}

/**
 * 向 ChatGPT 发送文字消息
 */
async function chatgptSendMessage(text, opts = {}) {
  await ensureChatGPT()

  const inputSel = getInputSelector()
  await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' })
  
  // 点击输入框使其获得焦点
  await page.click(inputSel)
  await page.waitForTimeout(200)

  // 清空已有内容
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)

  // 用剪贴板粘贴输入文字（解决中文编码 + React 状态更新的双重问题）
  // 1. 写入剪贴板
  await page.evaluate((text) => navigator.clipboard.writeText(text), text)
  // 2. 聚焦输入框
  await page.click(inputSel)
  await page.waitForTimeout(100)
  // 3. 清空已有内容
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  // 4. 粘贴（触发 React paste 事件，正确更新状态）
  await page.keyboard.press('Control+v')
  await page.waitForTimeout(800)

  // 发送：等待发送按钮可用后用 Playwright 原生 click（模拟真实鼠标事件）
  const sendSel = 'button[aria-label="发送提示"], button[aria-label="Send"], button[data-testid="send-button"]'
  let sent = false
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      // 检查按钮状态
      const state = await page.evaluate(() => {
        const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[data-testid="send-button"]']
        for (const sel of selectors) {
          const btn = document.querySelector(sel)
          if (btn) return { found: true, disabled: btn.disabled, visible: btn.offsetParent !== null }
        }
        return { found: false }
      })

      if (state.found && !state.disabled && state.visible) {
        // 用 Playwright 原生 click（触发完整的 mousedown→mouseup→click 事件链）
        await page.click(sendSel.split(',')[0].trim(), { timeout: 5000 })
        sent = true
        log('消息已通过 Playwright click 发送')
        break
      } else if (state.found && state.disabled) {
        await page.waitForTimeout(1000)
      } else {
        // 按钮不存在，尝试 Enter
        break
      }
    } catch (err) {
      if (DEBUG) log('发送尝试失败:', err.message)
      await page.waitForTimeout(500)
    }
  }

  if (!sent) {
    // 后备：Enter 键
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    log('消息已通过 Enter 键发送（后备）')
  }

  log('消息已发送:', text.slice(0, 80) + (text.length > 80 ? '...' : ''))
  return { ok: true }
}

/**
 * 上传文件到 ChatGPT
 */
async function chatgptUploadFile(filePath, opts = {}) {
  await ensureChatGPT()

  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }

  // 0. 先关闭可能存在的模态框（如"已上传过此文件"）
  await dismissModal()

  // 0.5. 检查文件是否已经挂载在 composer 中（之前上传成功但弹了警告框的情况）
  const alreadyAttached = await page.evaluate(() => {
    return document.querySelectorAll('[class*="file-tile"]').length > 0
  })
  if (alreadyAttached) {
    log('文件已挂载在 composer 中，跳过上传')
    await dismissModal()
    return { ok: true, method: 'already-attached' }
  }

  // 方式1：通过 + 按钮触发，然后用 filechooser 事件设置文件
  const plusBtnSelectors = [
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="Attach"]',
    'button[aria-label*="attach"]',
    'button[aria-label*="添加"]',
  ]

  for (const sel of plusBtnSelectors) {
    try {
      const count = await page.locator(sel).count()
      if (count > 0) {
        // 方式1a：filechooser 事件方式（最可靠，不依赖 hidden input selector）
        try {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 })
          await page.click(sel, { timeout: 5000 })
          const fileChooser = await fileChooserPromise
          await fileChooser.setFiles(filePath)
          await page.waitForTimeout(2000)
          await dismissModal()

          // 检查文件是否已挂载
          const attached = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
          if (attached) {
            log('文件已上传 (filechooser):', filePath)
            return { ok: true, method: 'filechooser' }
          }
        } catch (err) {
          if (DEBUG) log('filechooser 方式失败:', err.message)
          await dismissModal()
        }

        // 方式1b：+ 按钮点击后找 hidden file input
        try {
          await page.click(sel, { timeout: 5000 })
          await page.waitForTimeout(500)
          const fileInput = page.locator('input#upload-files')
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(filePath)
            await page.waitForTimeout(2000)
            await dismissModal()

            const attached = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
            if (attached) {
              log('文件已上传 (+ button → input#upload-files):', filePath)
              return { ok: true, method: 'plus-button' }
            }
          }
        } catch (err) {
          if (DEBUG) log('+ button input 方式失败:', err.message)
          await dismissModal()
        }
      }
    } catch (err) {
      if (DEBUG) log('上传尝试失败 (+ button):', sel, err.message)
      await dismissModal()
    }
  }

  // 方式2：直接 setInputFiles（后备）
  const fileInputSelectors = [
    'input#upload-files',
    'input[type="file"]:not([accept])',
    'input[type="file"]',
  ]

  for (const sel of fileInputSelectors) {
    try {
      const count = await page.locator(sel).count()
      if (count > 0) {
        await page.setInputFiles(sel, filePath)
        await page.evaluate((selector) => {
          const input = document.querySelector(selector)
          if (input) {
            const event = new Event('change', { bubbles: true })
            input.dispatchEvent(event)
          }
        }, sel)
        await page.waitForTimeout(2000)
        await dismissModal()

        const attached = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
        if (attached) {
          log('文件已上传 (setInputFiles + change event):', filePath)
          return { ok: true, method: 'input' }
        }
      }
    } catch (err) {
      if (DEBUG) log('上传尝试失败:', sel, err.message)
      await dismissModal()
    }
  }

  // 最后兜底：关闭所有对话框后重新检查文件是否已挂载
  await dismissModal()
  await page.waitForTimeout(1000)
  await dismissModal()
  const finalCheck = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
  if (finalCheck) {
    log('文件已挂载（最终检测）— "已上传过此文件"对话框意味着文件实际已在 composer 中')
    return { ok: true, method: 'already-attached-final' }
  }

  throw new Error('无法找到文件上传入口')
}

/**
 * 提取最后一条 assistant 消息的文本
 */
async function getLastAssistantText() {
  return await page.evaluate(() => {
    const selectors = [
      '[data-message-author-role="assistant"]',
      'div[class*="markdown"]',
      '[data-testid^="conversation-turn-"]',
    ]
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel)
      if (elements.length > 0) {
        return elements[elements.length - 1].textContent || ''
      }
    }
    return ''
  })
}

/**
 * 检测 ChatGPT 是否仍在生成回复
 * 只依赖停止按钮（最可靠信号），移除容易误报的 loading/class 选择器
 */
async function isStillGenerating() {
  return await page.evaluate(() => {
    // 停止按钮：ChatGPT 生成中会显示，完成后消失
    const stopBtns = document.querySelectorAll(
      'button[data-testid="stop-button"], ' +
      'button[aria-label="停止生成"], ' +
      'button[aria-label="Stop"], ' +
      'button[aria-label="停止"]'
    )
    for (const btn of stopBtns) {
      if (btn.offsetParent !== null) return true
    }
    return false
  })
}

/**
 * 等待 ChatGPT 回复完成并提取文本
 * 
 * 优化：通过检测停止按钮和 loading 状态，避免在 Code Interpreter 执行期间
 * 因文本暂时不变而误判为回复完成。
 */
async function chatgptWaitForResponse(opts = {}) {
  const timeout = opts.timeout || 300000
  const pollInterval = opts.pollInterval || 2000
  const stableCount = opts.stableCount || 3
  const startTimeout = opts.startTimeout || 60000
  const minResponseLength = opts.minResponseLength || 0  // 最小响应长度，不够则继续等

  await ensureChatGPT()

  log('等待 ChatGPT 回复...')

  // 记录发送前的最后一条 assistant 消息文本
  const preText = await getLastAssistantText()

  // 阶段1：等待新回复开始出现
  const startTime = Date.now()
  let newResponseStarted = false

  while (Date.now() - startTime < startTimeout) {
    const currentText = await getLastAssistantText()
    if (currentText && currentText !== preText) {
      newResponseStarted = true
      log('新回复已开始出现')
      break
    }
    // 也检查是否正在生成（可能文本还没出现但 GPT 已在思考）
    if (await isStillGenerating()) {
      newResponseStarted = true
      log('检测到 GPT 开始处理（loading 状态）')
      break
    }
    await page.waitForTimeout(pollInterval)
  }

  if (!newResponseStarted) {
    log('警告: 未检测到新回复开始，返回当前内容')
    return { ok: false, text: preText, timeout: true, reason: 'response_not_started' }
  }

  // 阶段2：等待回复内容稳定且 GPT 不再生成
  // 只依赖停止按钮消失判定完成，不做强制超时
  let lastText = ''
  let stableIterations = 0

  while (Date.now() - startTime < timeout) {
    const currentText = await getLastAssistantText()
    const stillGenerating = await isStillGenerating()

    if (DEBUG) {
      log(`轮询: textLen=${currentText.length} stable=${stableIterations}/${stableCount} generating=${stillGenerating}`)
    }

    if (currentText === lastText) {
      if (!stillGenerating) {
        if (minResponseLength > 0 && currentText.length < minResponseLength) {
          if (DEBUG) log(`响应过短 (${currentText.length} < ${minResponseLength})，继续等待...`)
        } else if (minResponseLength > 0 && !currentText.includes('{')) {
          if (DEBUG) log(`回复无 JSON 内容 (${currentText.length} chars)，继续等待...`)
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
      }
    } else {
      stableIterations = 0
      lastText = currentText
    }

    await page.waitForTimeout(pollInterval)
  }

  log('警告: 等待回复超时，返回最后获取的内容')
  return { ok: false, text: lastText, timeout: true, duration: Date.now() - startTime }
}

// ===== 异步分析任务存储 =====
const analysisJobs = new Map() // jobId → { status, response, error, startedAt, completedAt }

/**
 * 关闭 ChatGPT 弹出的模态框（如"已上传过此文件"提示）
 */
async function dismissModal() {
  try {
    await page.evaluate(() => {
      // 查找模态框中的"确定"按钮
      const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popover"]')
      for (const modal of modals) {
        if (modal.offsetParent === null) continue
        const btns = modal.querySelectorAll('button')
        for (const btn of btns) {
          const text = btn.textContent?.trim() || ''
          if (['确定', 'OK', '好的', 'Close', '关闭'].includes(text) || text.length <= 3) {
            btn.click()
            return true
          }
        }
      }
      return false
    })
    await page.waitForTimeout(500)
  } catch { /* ignore */ }
}

/**
 * 完整的视频分析流程：上传视频 → 发送提示词 → 等待回复 → 返回结果
 * 改为异步模式：启动后台处理，立即返回 jobId
 */
async function chatgptAnalyzeVideoAsync(opts) {
  const { videoPath, prompt, responseTimeout = 600000 } = opts
  const jobId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  analysisJobs.set(jobId, { status: 'running', response: null, error: null, startedAt: Date.now() })

  // 后台执行（不 await）
  ;(async () => {
    try {
      log('=== 开始 ChatGPT 视频分析 (jobId=' + jobId + ') ===')

      // Step 0: 关闭可能存在的模态框 + 导航到新对话（避免重复文件上传）
      log('Step 0: 导航到新对话...')
      await dismissModal()
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(3000)
      // 对话框可能延迟弹出，多次尝试关闭
      for (let i = 0; i < 3; i++) {
        await dismissModal()
        await page.waitForTimeout(1000)
      }

      log(`视频: ${videoPath}`)
      log(`提示词: ${(prompt || '').slice(0, 100)}...`)

      // Step 1: 上传视频
      log('Step 1: 上传视频文件...')
      const uploadResult = await chatgptUploadFile(videoPath)
      await dismissModal()

      // Step 2: 等待上传完成
      log('Step 2: 等待上传处理...')
      await page.waitForTimeout(3000)
      await dismissModal()

      // Step 3: 发送分析提示词（不清空输入框，避免删除文件附件）
      log('Step 3: 发送分析提示词...')
      await chatgptSendMessageWithFile(prompt)

      // Step 4: 等待回复
      log('Step 4: 等待 ChatGPT 回复...')
      const response = await chatgptWaitForResponse({
        timeout: responseTimeout,
        pollInterval: 3000,
        stableCount: 5,
        minResponseLength: 200,  // JSON 分析结果至少 200 字符
      })

      log('=== 视频分析完成 ===')
      analysisJobs.set(jobId, {
        status: response.ok ? 'completed' : 'timeout',
        response: response.text,
        uploadMethod: uploadResult.method,
        responseDuration: response.duration,
        timeout: response.timeout || false,
        completedAt: Date.now(),
      })
    } catch (err) {
      logErr('视频分析失败:', err.message)
      analysisJobs.set(jobId, {
        status: 'failed',
        error: err.message,
        completedAt: Date.now(),
      })
    }
  })()

  return { jobId, status: 'started' }
}

/**
 * 发送消息（已有文件附件时使用，不清空输入框）
 */
async function chatgptSendMessageWithFile(text) {
  await ensureChatGPT()

  const inputSel = getInputSelector()
  await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' })
  await page.click(inputSel)
  await page.waitForTimeout(300)

  // 用 page.type 逐行输入，\n 用 Shift+Enter 代替（避免误提交）
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.type(inputSel, lines[i], { delay: 0 })
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter')
  }
  await page.waitForTimeout(500)

  // 验证文字是否进入输入框
  const enteredText = await page.evaluate(() => document.querySelector('#prompt-textarea')?.textContent || '')
  if (!enteredText.trim()) {
    // page.type 失败，尝试剪贴板粘贴
    log('page.type 失败，尝试剪贴板粘贴...')
    await page.evaluate((t) => navigator.clipboard.writeText(t), text)
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(800)
  }

  // 等待发送按钮可用并点击
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
      try {
        await ensureConnection()
        cdpOk = true
        pageUrl = page?.url()
      } catch {}
      return sendJSON(res, 200, { ok: true, cdpConnected: cdpOk, pageUrl, cdpUrl: CDP_URL, port: PORT })
    }

    // ===== 通用命令执行 =====
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
          if (!result.ok) {
            return sendJSON(res, 200, { ok: false, error: `Command "${cmd.action}" failed`, results, failedIndex: results.length - 1 })
          }
        } catch (err) {
          results.push({ ok: false, error: err.message })
          return sendJSON(res, 200, { ok: false, error: err.message, results, failedIndex: results.length - 1 })
        }
      }
      return sendJSON(res, 200, { ok: true, results })
    }

    // ===== 截图 =====
    if (path === '/api/screenshot' && method === 'POST') {
      await ensureConnection()
      const body = await readBody(req)
      const buffer = await page.screenshot({ fullPage: body.fullPage || false, type: body.type || 'png' })
      return sendJSON(res, 200, { ok: true, base64: buffer.toString('base64') })
    }

    // ===== ChatGPT: 发送消息 =====
    if (path === '/api/chatgpt/send-message' && method === 'POST') {
      const body = await readBody(req)
      const result = await chatgptSendMessage(body.text || body.message || '', body)
      return sendJSON(res, 200, result)
    }

    // ===== ChatGPT: 上传文件 =====
    if (path === '/api/chatgpt/upload-file' && method === 'POST') {
      const body = await readBody(req)
      const result = await chatgptUploadFile(body.filePath || body.path)
      return sendJSON(res, 200, result)
    }

    // ===== ChatGPT: 获取回复 =====
    if (path === '/api/chatgpt/get-response' && method === 'POST') {
      const body = await readBody(req)
      const result = await chatgptWaitForResponse(body)
      return sendJSON(res, 200, result)
    }

    // ===== ChatGPT: 视频分析（异步模式，立即返回 jobId） =====
    if (path === '/api/chatgpt/analyze-video' && method === 'POST') {
      const body = await readBody(req)
      const result = await chatgptAnalyzeVideoAsync(body)
      return sendJSON(res, 200, result)
    }

    // ===== ChatGPT: 查询分析结果（轮询） =====
    if (path === '/api/chatgpt/analysis-status' && method === 'GET') {
      const jobId = url.searchParams.get('jobId')
      if (!jobId) return sendJSON(res, 400, { ok: false, error: 'missing jobId' })
      const job = analysisJobs.get(jobId)
      if (!job) return sendJSON(res, 404, { ok: false, error: 'job not found' })
      return sendJSON(res, 200, { ok: true, ...job })
    }

    // ===== ChatGPT: 获取当前页面状态 =====
    if (path === '/api/chatgpt/status' && method === 'GET') {
      await ensureConnection()
      const url = page.url()
      const title = await page.title().catch(() => '')
      return sendJSON(res, 200, { ok: true, url, title, isChatGPT: url.includes('chatgpt.com') })
    }

    // ===== 404 =====
    return sendJSON(res, 404, { ok: false, error: `Not found: ${method} ${path}` })
  } catch (err) {
    logErr('请求处理失败:', err.message)
    return sendJSON(res, 500, { ok: false, error: err.message })
  }
}

// ===== 启动服务 =====
async function start() {
  log('=== ChatGPT CDP Daemon 启动 ===')
  log(`CDP 地址: ${CDP_URL}`)
  log(`服务端口: ${PORT}`)
  log(`监听地址: ${HOST}`)
  log(`ChatGPT URL: ${CHATGPT_URL}`)
  log(`Debug 模式: ${DEBUG}`)

  // 连接 CDP
  try {
    await connectCDP()
    log('CDP 连接成功')
  } catch (err) {
    logErr('CDP 连接失败:', err.message)
    log('服务仍将启动，等待 CDP 可用后再连接...')
  }

  // 启动 HTTP 服务
  const server = http.createServer(handleRequest)
  server.listen(PORT, HOST, () => {
    log(`HTTP 服务已启动: http://${HOST}:${PORT}`)
    log('')
    log('可用端点:')
    log('  GET  /health                      — 健康检查')
    log('  POST /api/execute                 — 执行 Playwright 命令序列')
    log('  POST /api/screenshot              — 截图')
    log('  POST /api/chatgpt/send-message    — 发送消息到 ChatGPT')
    log('  POST /api/chatgpt/upload-file     — 上传文件到 ChatGPT')
    log('  POST /api/chatgpt/get-response    — 等待并获取 ChatGPT 回复')
    log('  POST /api/chatgpt/analyze-video   — 完整视频分析流程')
    log('  GET  /api/chatgpt/status          — 获取页面状态')
    log('')
  })

  // 定期心跳检测
  setInterval(async () => {
    try {
      if (browser) {
        await page.evaluate(() => 1).catch(() => {})
      }
    } catch {}
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
