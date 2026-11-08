/**
 * 波形 peaks（设计 8.11）
 *
 * FFmpeg 解码为 8kHz 单声道 s16le，Node 计算 4 级 min/max 峰值；
 * JSON 按「文件路径 + mtime + size」缓存，缩放只切层级、不重复解码。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { normalizeEditSourceUrl, EditSourceUrlError } from './edit-source-url.js'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectSubdirPath } from './project-storage.js'

export const PEAK_LEVELS = [128, 512, 2048, 8192] as const
const SAMPLE_RATE = 8000

export type PeaksSource = 'asset' | 'take' | 'sample'

export interface PeaksPayload {
  assetId?: number
  takeId?: number
  sampleId?: number
  sampleRate: number
  durationMs: number
  levels: { spp: number; peaks: [number, number][] }[]
}

export class PeaksError extends Error {
  readonly status: 400 | 404 | 503
  constructor(message: string, status: 400 | 404 | 503 = 400) {
    super(message)
    this.name = 'PeaksError'
    this.status = status
  }
}

function round5(value: number): number {
  return Math.round(value * 100000) / 100000
}

export function computePeaksFromPcm(samples: Int16Array, sampleRate = SAMPLE_RATE): PeaksPayload {
  if (!samples.length) {
    return { sampleRate: SAMPLE_RATE, durationMs: 0, levels: [] }
  }
  const levels = PEAK_LEVELS.map((spp) => {
    const peaks: [number, number][] = []
    for (let start = 0; start < samples.length; start += spp) {
      const end = Math.min(samples.length, start + spp)
      let min = 32767
      let max = -32768
      for (let i = start; i < end; i += 1) {
        const value = samples[i]
        if (value < min) min = value
        if (value > max) max = value
      }
      peaks.push([round5(min / 32768), round5(max / 32768)])
    }
    return { spp, peaks }
  })
  return {
    sampleRate: SAMPLE_RATE,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    levels,
  }
}

function requireEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new PeaksError('集不存在', 404)
  return episode
}

function peekCacheFile(dramaId: number, file: string): string {
  const stat = fs.statSync(file)
  const key = crypto.createHash('sha1')
    .update(`${path.resolve(file)}\u0000${stat.mtimeMs}\u0000${stat.size}`)
    .digest('hex')
  return path.join(projectSubdirPath(dramaId, 'audio'), 'peaks', `${key}.json`)
}

function readCache(file: string): PeaksPayload | null {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf-8')) as PeaksPayload
    if (!Array.isArray(payload.levels)) return null
    return payload
  } catch {
    return null
  }
}

function decodePcm(file: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpegSuite().ffmpeg.path
    if (!bin) {
      reject(new PeaksError('FFmpeg 不可用，无法生成波形', 503))
      return
    }
    let child
    try {
      child = spawn(bin, [
        '-hide_banner', '-loglevel', 'error',
        '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 's16le', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new PeaksError(`FFmpeg 启动失败：${(err as Error).message}`, 503))
      return
    }
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new PeaksError('波形解码超时', 503))
    }, 120_000)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new PeaksError(`FFmpeg 解码失败：${err.message}`, 503))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new PeaksError(`FFmpeg 解码失败：${stderr.slice(-600) || `退出码 ${code}`}`, 503))
        return
      }
      const buffer = Buffer.concat(chunks)
      const usable = buffer.length - (buffer.length % 2)
      const samples = new Int16Array(usable / 2)
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = buffer.readInt16LE(i * 2)
      }
      resolve(samples)
    })
  })
}

async function peaksForFile(dramaId: number, file: string): Promise<PeaksPayload> {
  if (!fs.existsSync(file)) throw new PeaksError('音频文件不存在', 404)
  const cacheFile = peekCacheFile(dramaId, file)
  const cached = readCache(cacheFile)
  if (cached) return cached

  const samples = await decodePcm(file)
  const payload = computePeaksFromPcm(samples, SAMPLE_RATE)
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf-8')
  return payload
}

function resolveMediaUrl(raw: string | null | undefined): string {
  const value = String(raw || '').trim()
  if (!value) throw new PeaksError('音频尚未生成', 400)
  return path.isAbsolute(value) ? value : getAbsolutePath(value)
}

export async function getPeaksForEditSource(
  episodeId: number,
  rawUrl: string,
): Promise<PeaksPayload> {
  const episode = requireEpisode(episodeId)
  let file: string
  try {
    // 与导出 resolveSourceUrl 同口径：/static/ 前缀剥掉后进存储根解析，越界/远程路径在 normalize 拒绝
    const url = normalizeEditSourceUrl(rawUrl)
    file = url.startsWith('/static/') ? getAbsolutePath(url.slice(1)) : getAbsolutePath(url)
  } catch (error) {
    if (error instanceof EditSourceUrlError) throw new PeaksError(error.message, 400)
    throw error
  }
  return peaksForFile(episode.dramaId, file)
}

export async function getPeaksForAsset(episodeId: number, assetId: number): Promise<PeaksPayload> {
  const episode = requireEpisode(episodeId)
  const asset = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.id, assetId),
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .get()
  if (!asset) throw new PeaksError('音频素材不存在', 404)
  const payload = await peaksForFile(episode.dramaId, resolveMediaUrl(asset.url))
  return { ...payload, assetId }
}

export async function getPeaksForSource(
  episodeId: number,
  source: PeaksSource,
  id: number,
): Promise<PeaksPayload> {
  if (source === 'asset') return getPeaksForAsset(episodeId, id)
  const episode = requireEpisode(episodeId)

  if (source === 'take') {
    const take = db.select().from(schema.lineTakes)
      .where(and(
        eq(schema.lineTakes.id, id),
        eq(schema.lineTakes.episodeId, episodeId),
        isNull(schema.lineTakes.deletedAt),
      ))
      .get()
    if (!take) throw new PeaksError('Take 不存在', 404)
    const payload = await peaksForFile(episode.dramaId, resolveMediaUrl(take.audioUrl))
    return { ...payload, takeId: id }
  }

  const sample = db.select().from(schema.voiceSamples)
    .where(and(eq(schema.voiceSamples.id, id), isNull(schema.voiceSamples.deletedAt)))
    .get()
  if (!sample || sample.dramaId !== episode.dramaId) throw new PeaksError('试音样本不存在', 404)
  const payload = await peaksForFile(episode.dramaId, resolveMediaUrl(sample.audioUrl))
  return { ...payload, sampleId: id }
}
