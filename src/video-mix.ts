import { PrismaClient, creditlog_reason, Prisma } from '@yix/database'
import ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs'
import * as path from 'path'
import axios from 'axios'
import { execFile } from 'child_process'

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH)
}
if (process.env.FFPROBE_PATH) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH)
}

interface VideoMeta {
  duration: number
  width: number
  height: number
  fps: number
  sampleRate: number
  hasAudio: boolean
}

const UPLOAD_DIR = () =>
  process.env.UPLOAD_DIR || path.join(process.cwd(), '..', 'web', 'public', 'uploads')

function getFfmpegBin(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function runFFmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = getFfmpegBin()
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[video-mix] FFmpeg stderr:', stderr.slice(-2000))
        reject(new Error(`FFmpeg failed: ${error.message}`))
      } else {
        resolve(stderr)
      }
    })
  })
}

async function resolveToLocalFile(url: string, uploadDir: string, prefix: string): Promise<{ localPath: string; temporary: boolean }> {
  const extractFilename = (u: string) => {
    if (u.startsWith('/api/uploads/')) return u.slice('/api/uploads/'.length)
    if (u.startsWith('/uploads/')) return u.slice('/uploads/'.length)
    return null
  }

  const filename = extractFilename(url)
  if (filename) {
    const localPath = path.join(uploadDir, filename)
    if (fs.existsSync(localPath)) return { localPath, temporary: false }
  }
  if (fs.existsSync(url)) return { localPath: url, temporary: false }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    const outputPath = path.join(uploadDir, `${prefix}-${Date.now()}.mp4`)
    const response = await axios.get(url, { responseType: 'stream', timeout: 120000 })
    const writer = fs.createWriteStream(outputPath)
    response.data.pipe(writer)
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve())
      writer.on('error', reject)
    })
    return { localPath: outputPath, temporary: true }
  }

  throw new Error(`无法解析视频路径: ${url}`)
}

function probeVideo(filePath: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: any, data: any) => {
      if (err) return reject(err)
      const videoStream = data.streams?.find((s: any) => s.codec_type === 'video')
      const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio')
      const fpsParts = (videoStream?.r_frame_rate || '30/1').split('/')
      const fpsNum = Number(fpsParts[0]) || 30
      const fpsDen = Number(fpsParts[1]) || 1
      resolve({
        duration: Number(data.format?.duration || videoStream?.duration || 0),
        width: videoStream?.width || 1080,
        height: videoStream?.height || 1920,
        fps: fpsDen > 0 ? fpsNum / fpsDen : 30,
        sampleRate: audioStream?.sample_rate || 44100,
        hasAudio: !!audioStream,
      })
    })
  })
}

async function failVideoAndRefund(prisma: PrismaClient, taskId: string, message: string) {
  const idempotencyKey = `refund:VIDEO_TASK:${taskId}`
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const task = await tx.videotask.findUnique({
      where: { id: taskId },
      select: { status: true, userId: true, creditCost: true },
    })
    if (!task || task.status === 'DONE') return
    const existing = await tx.creditlog.findUnique({ where: { idempotencyKey }, select: { id: true } })
    if (existing) return

    await tx.videotask.update({
      where: { id: taskId },
      data: { status: 'FAILED', errorMessage: message },
    })
    if (task.creditCost <= 0) return

    await tx.user.update({
      where: { id: task.userId },
      data: { credits: { increment: task.creditCost } },
    })
    const user = await tx.user.findUnique({ where: { id: task.userId }, select: { credits: true } })
    if (!user) throw new Error('User not found')
    await tx.creditlog.create({
      data: {
        userId: task.userId,
        delta: task.creditCost,
        reason: creditlog_reason.REFUND,
        bizType: 'VIDEO_TASK',
        bizId: taskId,
        remark: message.slice(0, 500),
        balanceAfter: user.credits,
        idempotencyKey,
      },
    })
  })
}

async function processSingleVideo(
  inputPath: string,
  outputPath: string,
  meta: VideoMeta
): Promise<void> {
  const { duration, width, height, fps, sampleRate, hasAudio } = meta

  const trimStart = duration > 3 ? 1 : 0
  const trimEnd = duration > 3 ? duration - 1 : duration
  const trimmedDuration = trimEnd - trimStart
  const segLen = trimmedDuration / 3
  const seg1End = segLen
  const seg2End = segLen * 2
  const seg3End = trimmedDuration

  const fpsStr = fps.toFixed(2)
  const durStr = trimmedDuration.toFixed(3)

  const overlayColors = ['0x1a1a2e', '0x2e1a1a', '0x1a2e1a']

  const args: string[] = [
    '-i', inputPath,
    '-f', 'lavfi', '-t', durStr, '-i', `color=c=${overlayColors[0]}:s=${width}x${height}:r=${fpsStr}`,
    '-f', 'lavfi', '-t', durStr, '-i', `color=c=${overlayColors[1]}:s=${width}x${height}:r=${fpsStr}`,
    '-f', 'lavfi', '-t', durStr, '-i', `color=c=${overlayColors[2]}:s=${width}x${height}:r=${fpsStr}`,
  ]

  const videoFilters: string[] = []
  if (trimStart > 0) {
    videoFilters.push(`trim=start=${trimStart}:end=${trimEnd}`, 'setpts=PTS-STARTPTS')
  }
  videoFilters.push(
    'colorbalance=rm=-0.02:gm=-0.02:bm=0.02',
    'eq=brightness=0.01',
    'unsharp=5:5:0.7:5:5:0',
    'unsharp=13:13:0.1:13:13:0',
  )

  const filterParts: string[] = [
    `[0:v]${videoFilters.join(',')}[v_base]`,
    `[1:v]format=rgba,colorchannelmixer=aa=0.01[ov1]`,
    `[2:v]format=rgba,colorchannelmixer=aa=0.02[ov2]`,
    `[3:v]format=rgba,colorchannelmixer=aa=0.01[ov3]`,
    `[v_base][ov1]overlay=0:0:enable='between(t,0,${seg1End.toFixed(3)})'[v1]`,
    `[v1][ov2]overlay=0:0:enable='between(t,${seg1End.toFixed(3)},${seg2End.toFixed(3)})'[v2]`,
    `[v2][ov3]overlay=0:0:enable='between(t,${seg2End.toFixed(3)},${seg3End.toFixed(3)})'[v_out]`,
  ]

  if (hasAudio) {
    const audioFilters: string[] = []
    if (trimStart > 0) {
      audioFilters.push(`atrim=start=${trimStart}:end=${trimEnd}`, 'asetpts=PTS-STARTPTS')
    }
    audioFilters.push(
      'volume=8dB',
      `asetrate=${sampleRate}*1.0601`,
      'atempo=0.9433',
    )
    filterParts.push(`[0:a]${audioFilters.join(',')}[a_out]`)
  }

  args.push('-filter_complex', filterParts.join(';'))

  if (hasAudio) {
    args.push('-map', '[v_out]', '-map', '[a_out]')
  } else {
    args.push('-map', '[v_out]')
  }

  args.push(
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  )

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k')
  }

  args.push('-shortest', '-y', outputPath)

  console.log(`[video-mix] Processing single video: ${inputPath} -> ${outputPath}`)
  await runFFmpeg(args)
}

async function concatVideos(inputPaths: string[], outputPath: string, uploadDir: string): Promise<void> {
  if (inputPaths.length === 1) {
    await fs.promises.copyFile(inputPaths[0], outputPath)
    return
  }

  const listFile = path.join(uploadDir, `mix-concat-${Date.now()}.txt`)
  const listContent = inputPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await fs.promises.writeFile(listFile, listContent, 'utf-8')

  try {
    await runFFmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y', outputPath,
    ])
  } catch {
    await runFFmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '128k',
      '-y', outputPath,
    ])
  } finally {
    try { await fs.promises.unlink(listFile) } catch {}
  }
}

export async function processVideoMixJob(prisma: PrismaClient, taskId: string): Promise<void> {
  console.log(`[video-mix] Starting mix task: ${taskId}`)

  const vTask = await prisma.videotask.findUnique({ where: { id: taskId } })
  if (!vTask || !vTask.sourceUrl) {
    throw new Error(`VideoTask ${taskId} or sourceUrl not found`)
  }

  const payload = JSON.parse(vTask.sourceUrl)
  const videoUrls: string[] = payload.videoUrls || payload.segments?.map((s: any) => s.videoUrl).filter(Boolean) || []

  if (videoUrls.length < 1) {
    throw new Error('去重至少需要 1 个视频')
  }

  const uploadDir = UPLOAD_DIR()
  await fs.promises.mkdir(uploadDir, { recursive: true })

  const temporaryPaths: string[] = []
  const processedPaths: string[] = []
  const outputFileName = `mixed-${taskId}-${Date.now()}.mp4`
  const outputPath = path.join(uploadDir, outputFileName)
  let uploadedToOss = false

  try {
    await prisma.videotask.update({
      where: { id: taskId },
      data: { status: 'PROCESSING' },
    })

    for (let i = 0; i < videoUrls.length; i++) {
      console.log(`[video-mix] Downloading video ${i + 1}/${videoUrls.length}: ${videoUrls[i]}`)
      const resolved = await resolveToLocalFile(
        videoUrls[i],
        uploadDir,
        `mix-input-${taskId}-${i}`,
      )
      if (resolved.temporary) temporaryPaths.push(resolved.localPath)

      console.log(`[video-mix] Probing video ${i + 1}`)
      const meta = await probeVideo(resolved.localPath)
      console.log(`[video-mix] Meta: ${meta.duration}s ${meta.width}x${meta.height} ${meta.fps}fps audio=${meta.hasAudio}`)

      const processedPath = path.join(uploadDir, `mix-segment-${taskId}-${i}-${Date.now()}.mp4`)
      await processSingleVideo(resolved.localPath, processedPath, meta)
      processedPaths.push(processedPath)
      temporaryPaths.push(processedPath)
    }

    console.log(`[video-mix] Concatenating ${processedPaths.length} processed segments`)
    await concatVideos(processedPaths, outputPath, uploadDir)

    let permanentUrl = `/uploads/${outputFileName}`
    if (process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET) {
      const { uploadBuffer } = await import('@yix/shared')
      const resultBuffer = await fs.promises.readFile(outputPath)
      permanentUrl = await uploadBuffer(resultBuffer, outputFileName)
      uploadedToOss = true
    }

    await prisma.videotask.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        outputUrl: permanentUrl,
        completedAt: new Date(),
      } as any,
    })

    console.log(`[video-mix] Task ${taskId} complete: ${permanentUrl}`)
  } catch (err: any) {
    console.error(`[video-mix] Task ${taskId} failed:`, err.message)
    await failVideoAndRefund(prisma, taskId, `视频混剪失败退款: ${err.message}`)
    throw err
  } finally {
    for (const tempPath of temporaryPaths) {
      try { await fs.promises.unlink(tempPath) } catch {}
    }
    if (uploadedToOss) {
      try {
        if (fs.existsSync(outputPath)) {
          await fs.promises.unlink(outputPath)
        }
      } catch {}
    }
  }
}
