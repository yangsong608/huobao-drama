import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA_ROOT } from '../utils/paths.js'

export type FaceEngine = 'h3' | 'facefusion'

export interface FaceFusionSettings {
  dir: string
  python: string
  model: string
  executionProviders: string
  pixelBoost: string
  timeoutMs: number
}

export class FaceFusionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FaceFusionError'
  }
}

function textSetting(settings: Record<string, unknown>, key: string, fallback: string): string {
  const value = settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function resolveFaceEngine(settings: Record<string, unknown>): FaceEngine {
  return settings.face_engine === 'facefusion' ? 'facefusion' : 'h3'
}

export function resolveFaceFusionSettings(settings: Record<string, unknown>): FaceFusionSettings {
  const dir = textSetting(settings, 'facefusion_dir', '') || path.join(DATA_ROOT, 'tools', 'facefusion')
  const timeout = Number(settings.facefusion_timeout_seconds)
  return {
    dir,
    python: textSetting(settings, 'facefusion_python', path.join(dir, '.venv', 'bin', 'python')),
    model: textSetting(settings, 'facefusion_model', 'hyperswap_1a_256'),
    executionProviders: textSetting(settings, 'facefusion_execution_providers', 'cpu'),
    pixelBoost: textSetting(settings, 'facefusion_pixel_boost', '512x512'),
    timeoutMs: Number.isFinite(timeout) ? Math.min(7200, Math.max(60, timeout)) * 1000 : 1800_000,
  }
}

function modelPath(settings: FaceFusionSettings): string {
  return path.join(settings.dir, '.assets', 'models', `${settings.model}.onnx`)
}

export function validateFaceFusionInstall(settings: FaceFusionSettings): string[] {
  const blockers: string[] = []
  if (!fs.existsSync(settings.dir) || !fs.statSync(settings.dir).isDirectory()) {
    blockers.push(`FaceFusion 目录不存在：${settings.dir}`)
  }
  if (!fs.existsSync(path.join(settings.dir, 'facefusion.py'))) {
    blockers.push('FaceFusion 缺少 facefusion.py')
  }
  if (!fs.existsSync(settings.python)) {
    blockers.push(`FaceFusion Python 不存在：${settings.python}`)
  }
  if (!fs.existsSync(modelPath(settings))) {
    blockers.push(`FaceFusion 模型不存在：${modelPath(settings)}`)
  }
  return blockers
}

export interface RunFaceFusionInput {
  sourcePath: string
  referenceFacePath: string
  outputPath: string
  settings: FaceFusionSettings
}

export async function runFaceFusion(input: RunFaceFusionInput): Promise<void> {
  const { settings } = input
  if (!fs.existsSync(input.sourcePath)) throw new FaceFusionError('FaceFusion 源视频不存在')
  if (!fs.existsSync(input.referenceFacePath)) throw new FaceFusionError('FaceFusion 参考人脸不存在')
  await fsp.mkdir(path.dirname(input.outputPath), { recursive: true })
  await fsp.rm(input.outputPath, { force: true })

  const providers = settings.executionProviders.split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
  const args = [
    path.join(settings.dir, 'facefusion.py'),
    'headless-run',
    '-s', input.referenceFacePath,
    '-t', input.sourcePath,
    '-o', input.outputPath,
    '--processors', 'face_swapper',
    '--face-swapper-model', settings.model,
    '--face-swapper-weight', '1.0',
    '--face-swapper-pixel-boost', settings.pixelBoost,
    '--face-detector-model', 'retinaface',
    '--face-detector-score', '0.3',
    '--face-landmarker-model', '2dfan4',
    '--face-selector-mode', 'one',
    '--face-selector-order', 'large-small',
    '--face-mask-types', 'box',
    '--execution-providers', ...(providers.length ? providers : ['cpu']),
    '--output-audio-encoder', 'aac',
    '--output-video-quality', '90',
    '--log-level', 'error',
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(settings.python, args, {
      cwd: settings.dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new FaceFusionError(`FaceFusion 超时（${Math.round(settings.timeoutMs / 1000)} 秒）`))
    }, settings.timeoutMs)
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000)
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(new FaceFusionError(`FaceFusion 启动失败：${error.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      const tail = stderr.trim().split('\n').slice(-8).join('\n')
      reject(new FaceFusionError(`FaceFusion 失败（exit ${code}）${tail ? `：${tail}` : ''}`))
    })
  })

  const stat = await fsp.stat(input.outputPath).catch(() => null)
  if (!stat || stat.size === 0) throw new FaceFusionError('FaceFusion 未生成输出视频')
}