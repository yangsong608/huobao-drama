/**
 * 剪辑素材解析（技术设计 §4.7、§6.3）：
 * 逻辑 URL → 本地文件 → ffprobe 元数据 + size/mtime 指纹。
 * 远程 URL 不进入渲染链路；导入素材必须先落 project storage。
 */
import fsp from 'node:fs/promises'
import { getAbsolutePath } from '../utils/storage.js'
import { probeMedia } from './export-validation.js'
import type { EditClipSource, EditSourceKind } from './edit-plan.js'
import { editSourceRelativePath, EditSourceUrlError } from './edit-source-url.js'

export interface EditMediaProbe {
  durationMs: number
  width: number
  height: number
  fps: number | null
  hasAudio: boolean
  sizeBytes: number
  fingerprint: string
}

const probeCache = new Map<string, EditMediaProbe>()

export function clearEditMediaProbeCache(): void {
  probeCache.clear()
}

export async function fingerprintOfFile(file: string): Promise<string> {
  const stat = await fsp.stat(file)
  return `${stat.size}:${Math.round(stat.mtimeMs)}`
}

function resolveLocalMediaPath(raw: string): string {
  try {
    return getAbsolutePath(editSourceRelativePath(raw))
  } catch (error) {
    if (error instanceof EditSourceUrlError) throw new Error(error.message)
    throw error
  }
}

export async function probeEditMedia(url: string): Promise<EditMediaProbe> {
  const file = resolveLocalMediaPath(url)
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`媒体文件不存在：${url}`)

  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`
  const cacheKey = `${url}|${fingerprint}`
  const cached = probeCache.get(cacheKey)
  if (cached) return cached

  const probe = await probeMedia(file)
  if (probe.durationMs <= 0 || !probe.video) {
    throw new Error(`媒体不可用于剪辑：${url}`)
  }
  const result: EditMediaProbe = {
    durationMs: probe.durationMs,
    width: probe.video.width,
    height: probe.video.height,
    fps: probe.video.fps,
    hasAudio: Boolean(probe.audio),
    sizeBytes: stat.size,
    fingerprint,
  }
  probeCache.set(cacheKey, result)
  return result
}

export async function editSourceFromUrl(input: {
  kind: EditSourceKind
  id: number | string
  url: string
  label?: string | null
}): Promise<EditClipSource> {
  const probe = await probeEditMedia(input.url)
  return {
    kind: input.kind,
    id: input.id,
    url: input.url,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    fingerprint: probe.fingerprint,
    ...(input.label ? { label: input.label } : {}),
  }
}
