/**
 * FFmpeg 统一配置与可用性探测
 *
 * 解析优先级：设置页自定义目录 > FFMPEG_BIN/FFPROBE_BIN > 内置静态包 > PATH。
 * 设置值由 db/index 注入的 loader 提供，保存后无需重启即可切换。
 *
 * 背景：Windows 上若 node_modules 跨平台拷贝、或 ffmpeg-static postinstall
 * 下载损坏（HTML 错误页被存成 ffmpeg.exe），spawn 非 PE 文件会同步抛
 * EFTYPE；该异常发生在 fluent-ffmpeg 的延迟回调里，外层 try/catch 接不住，
 * 直接崩掉整个 Node 进程。这里在业务调用前主动 spawn -version 探测，
 * 不可用时由业务侧优雅降级（海报帧跳过 / 拼接返回明确错误）。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { createRequire } from 'module'
import { mediaBinaryName, normalizeFfmpegDir } from './media-paths.js'

// ffmpeg-static / ffprobe-static 均为可选依赖：npm 安装时提供内置二进制；
// 桌面版打包不携带这两个 npm 包（二进制随 resources/bin 分发），缺失时走 FFMPEG_BIN/FFPROBE_BIN
const req = createRequire(import.meta.url)

function resolveStatic(moduleName: string): string | null {
  try {
    const mod = req(moduleName)
    return (moduleName === 'ffprobe-static' ? mod?.path : mod) ?? null
  } catch {
    return null
  }
}

const staticFfmpegPath = resolveStatic('ffmpeg-static')
const staticFfprobePath = resolveStatic('ffprobe-static')

export type FfmpegSource = 'custom' | 'env' | 'static' | 'path' | 'none'

export interface ResolvedBinary {
  path: string | null
  source: FfmpegSource
}

export interface ResolvedFfmpegSuite {
  ffmpegDir: string
  ffmpeg: ResolvedBinary
  ffprobe: ResolvedBinary
}

export interface FfmpegBinaryStatus extends ResolvedBinary {
  available: boolean
  version: string | null
}

export interface FfmpegStatus {
  ffmpegDir: string
  ffmpeg: FfmpegBinaryStatus
  ffprobe: FfmpegBinaryStatus
}

export interface FfmpegSuite {
  ffmpeg: boolean
  ffprobe: boolean
}

let ffmpegDirLoader: () => string = () => ''

/** 由 db/index 注入（读取 app_settings），避免 utils 直接依赖 db */
export function setFfmpegDirLoader(loader: () => string): void {
  ffmpegDirLoader = loader
}

function findExecutableOnPath(binaryName: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const candidates = process.platform === 'win32'
    ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`]
    : [binaryName]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      try {
        if (!fs.statSync(full).isFile()) continue
        fs.accessSync(full, fs.constants.X_OK)
        return full
      } catch { /* 继续下一个候选 */ }
    }
  }
  return null
}

function pickBinary(
  base: 'ffmpeg' | 'ffprobe',
  envValue: string | undefined,
  staticPath: string | null,
): ResolvedBinary {
  const envPath = typeof envValue === 'string' ? envValue.trim() : ''
  if (envPath) return { path: envPath, source: 'env' }
  if (staticPath) return { path: staticPath, source: 'static' }
  const onPath = findExecutableOnPath(mediaBinaryName(base))
  return onPath ? { path: onPath, source: 'path' } : { path: null, source: 'none' }
}

export function resolveFfmpegSuite(): ResolvedFfmpegSuite {
  let configuredDir = ''
  try {
    configuredDir = normalizeFfmpegDir(ffmpegDirLoader())
  } catch {
    configuredDir = ''
  }
  if (configuredDir) {
    return {
      ffmpegDir: configuredDir,
      ffmpeg: { path: path.join(configuredDir, mediaBinaryName('ffmpeg')), source: 'custom' },
      ffprobe: { path: path.join(configuredDir, mediaBinaryName('ffprobe')), source: 'custom' },
    }
  }
  return {
    ffmpegDir: '',
    ffmpeg: pickBinary('ffmpeg', process.env.FFMPEG_BIN, staticFfmpegPath),
    ffprobe: pickBinary('ffprobe', process.env.FFPROBE_BIN, staticFfprobePath),
  }
}

// 成功的探测结果缓存；路径变化时失效。失败不缓存，修复二进制后无需重启即可恢复
let appliedSignature: string | null = null
let okCache: FfmpegSuite | null = null
let warned = false

function applyResolvedSuite(suite: ResolvedFfmpegSuite): ResolvedFfmpegSuite {
  const signature = `${suite.ffmpeg.path ?? ''}\u0000${suite.ffprobe.path ?? ''}`
  if (signature === appliedSignature) return suite
  appliedSignature = signature
  okCache = null
  warned = false
  // 清空自定义目录后回落到 PATH 名称，避免 fluent-ffmpeg 残留上一个路径
  ffmpeg.setFfmpegPath(suite.ffmpeg.path || mediaBinaryName('ffmpeg'))
  ffmpeg.setFfprobePath(suite.ffprobe.path || mediaBinaryName('ffprobe'))
  return suite
}

/** 重新读取设置并应用到 fluent-ffmpeg（启动与保存设置时调用） */
export function refreshFfmpegConfig(): ResolvedFfmpegSuite {
  return applyResolvedSuite(resolveFfmpegSuite())
}

// 导入即应用一次默认解析，保证未显式 refresh 的调用方（如直接使用 fluent-ffmpeg 的单测）
// 也走内置/环境二进制，而不是 PATH 上可能不完整的 ffmpeg
applyResolvedSuite(resolveFfmpegSuite())

/** spawn 一次 -version 验证二进制真实可执行，并取首行版本号 */
function probeBinaryVersion(binPath: string | null): Promise<{ ok: boolean; version: string | null }> {
  if (!binPath || !fs.existsSync(binPath)) return Promise.resolve({ ok: false, version: null })
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const finish = (ok: boolean, version: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, version })
    }
    const timer = setTimeout(() => finish(false, null), 10_000)
    let child
    try {
      child = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      // Windows 上 spawn 非 PE 文件（如下载损坏的 ffmpeg.exe）会同步抛 EFTYPE
      finish(false, null)
      return
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += String(chunk)
    })
    child.on('error', () => finish(false, null))
    child.on('close', (code) => {
      const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
      finish(code === 0, code === 0 ? firstLine?.slice(0, 200) || null : null)
    })
  })
}

/** 探测当前解析到的 ffmpeg/ffprobe 是否可用 */
export async function checkFfmpegSuite(): Promise<FfmpegSuite> {
  const suite = applyResolvedSuite(resolveFfmpegSuite())
  if (okCache) return okCache
  const [ffmpegResult, ffprobeResult] = await Promise.all([
    probeBinaryVersion(suite.ffmpeg.path),
    probeBinaryVersion(suite.ffprobe.path),
  ])
  const result = { ffmpeg: ffmpegResult.ok, ffprobe: ffprobeResult.ok }
  if (result.ffmpeg && result.ffprobe) {
    okCache = result
  } else if (!warned) {
    warned = true
    console.warn(
      `[ffmpeg] 二进制不可用 (ffmpeg=${suite.ffmpeg.path || '未找到'} [${suite.ffmpeg.source}], ` +
      `ffprobe=${suite.ffprobe.path || '未找到'} [${suite.ffprobe.source}])。` +
      `海报帧提取与视频拼接将跳过/失败。修复：在设置页「通用 → 媒体工具」指定 FFmpeg 目录，` +
      `或设置 FFMPEG_BIN/FFPROBE_BIN 指向有效的可执行文件`
    )
  }
  return result
}

/** 设置页展示用：解析路径、来源、可用性与版本 */
export async function getFfmpegStatus(): Promise<FfmpegStatus> {
  const suite = applyResolvedSuite(resolveFfmpegSuite())
  const [ffmpegResult, ffprobeResult] = await Promise.all([
    probeBinaryVersion(suite.ffmpeg.path),
    probeBinaryVersion(suite.ffprobe.path),
  ])
  return {
    ffmpegDir: suite.ffmpegDir,
    ffmpeg: { ...suite.ffmpeg, available: ffmpegResult.ok, version: ffmpegResult.version },
    ffprobe: { ...suite.ffprobe, available: ffprobeResult.ok, version: ffprobeResult.version },
  }
}

export { ffmpeg }
