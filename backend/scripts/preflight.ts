/**
 * V2 环境能力预检
 *
 * 目的：在动工前确认 ffmpeg 能力矩阵与语音服务可达性，避免「烧字幕静默失败」
 * 或「跑到 e2e 才发现 TTS 连不上」。
 *
 * 用法：
 *   npx tsx scripts/preflight.ts
 *   TTS_BASE_URL=http://192.168.1.10:8000 npx tsx scripts/preflight.ts
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const req = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(here, '../../data')

/** 与 utils/ffmpeg.ts 保持同一解析顺序：环境变量优先，其次内置 ffmpeg-static */
function resolveBin(kind: 'ffmpeg' | 'ffprobe'): string | null {
  const env = process.env[kind === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN']
  if (env && fs.existsSync(env)) return env
  try {
    const mod = req(kind === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static')
    const p = kind === 'ffmpeg' ? (mod as string) : (mod as { path?: string })?.path
    return p && fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

interface Check {
  name: string
  ok: boolean
  required: boolean
  detail: string
}

const checks: Check[] = []

function record(name: string, ok: boolean, required: boolean, detail: string) {
  checks.push({ name, ok, required, detail })
}

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const ffmpegBin = resolveBin('ffmpeg')
const ffprobeBin = resolveBin('ffprobe')

if (!ffmpegBin) {
  record('ffmpeg 可执行', false, true, '未找到：设置 FFMPEG_BIN 或安装 ffmpeg-static')
} else {
  const v = run(ffmpegBin, ['-hide_banner', '-version'])
  const firstLine = v.out.split('\n')[0]?.trim() || '未知版本'
  record('ffmpeg 可执行', v.ok, true, `${ffmpegBin} | ${firstLine}`)

  const filters = run(ffmpegBin, ['-hide_banner', '-filters'])
  const has = (name: string) => new RegExp(`\\s${name}\\s`).test(filters.out)

  // 混音与动效必需
  for (const f of ['sidechaincompress', 'loudnorm', 'amix', 'zoompan', 'xfade']) {
    record(`滤镜 ${f}`, has(f), true, has(f) ? 'ok' : '缺失：混音/动效将不可用')
  }
  // 字幕烧录依赖 libass；缺失时降级为软字幕
  const libass = has('subtitles') && has('ass')
  record('字幕烧录（libass）', libass, false, libass ? 'ok' : '缺失：仅能输出软字幕，不能烧录')
  record('drawtext（freetype）', has('drawtext'), false, has('drawtext') ? 'ok' : '缺失：图文动画不能用文字叠加')
}

if (!ffprobeBin) {
  record('ffprobe 可执行', false, true, '未找到：无法读取音频/视频真实时长')
} else {
  const v = run(ffprobeBin, ['-hide_banner', '-version'])
  record('ffprobe 可执行', v.ok, true, ffprobeBin)
}

// 数据目录可写（配音缓存与静态产物都落这里）
try {
  fs.mkdirSync(dataDir, { recursive: true })
  const probe = path.join(dataDir, `.preflight-${Date.now()}`)
  fs.writeFileSync(probe, 'ok')
  fs.unlinkSync(probe)
  record('data 目录可写', true, true, dataDir)
} catch (err) {
  record('data 目录可写', false, true, `${dataDir} 不可写：${(err as Error).message}`)
}

// 语音服务可达性：未配置时跳过，不阻塞 M0
const ttsBase = process.env.TTS_BASE_URL?.replace(/\/+$/, '')
if (!ttsBase) {
  record('TTS 服务', true, false, 'SKIP：未设置 TTS_BASE_URL（M0 允许，G1 前必须配置）')
} else {
  try {
    const resp = await fetch(`${ttsBase}/health`, { signal: AbortSignal.timeout(5000) })
    const body = await resp.text()
    record('TTS 服务', resp.ok, false, `HTTP ${resp.status} ${body.slice(0, 200)}`)
  } catch (err) {
    record('TTS 服务', false, false, `不可达：${(err as Error).message}`)
  }
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
console.log('\n能力矩阵')
console.log('-'.repeat(78))
for (const c of checks) {
  const flag = c.ok ? 'PASS' : c.required ? 'FAIL' : 'WARN'
  console.log(`${pad(flag, 5)} ${pad(c.name, 22)} ${c.detail}`)
}
console.log('-'.repeat(78))

const failed = checks.filter((c) => !c.ok && c.required)
if (failed.length) {
  console.error(`\n阻塞项 ${failed.length} 个：${failed.map((f) => f.name).join('、')}`)
  console.error('修复后再继续；非阻塞项（WARN）按降级方案实施。')
  process.exit(1)
}
console.log('\n预检通过：必需能力齐全，可进入 M0-3。')
