/**
 * 视频换人项目媒体存储 — 与短剧项目 ID/目录完全隔离。
 *
 * 逻辑路径：static/video-projects/<projectId>/<subDir>/<file>
 * 物理路径：DATA_ROOT/static/video-projects/<projectId>/<subDir>/<file>
 *
 * 该模块不依赖数据库；项目存在性由路由/服务层校验。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'
import { isPathInside } from './project-storage.js'

export const VIDEO_PROJECT_SUBDIRS = [
  'source',
  'faces',
  'analysis',
  'scene-refs',
  'chunks',
  'seams',
  'outputs',
  'logs',
] as const

export type VideoProjectSubdir = typeof VIDEO_PROJECT_SUBDIRS[number]

const VIDEO_PROJECT_PATH_RE = /^static\/video-projects\/(\d+)\/(.+)$/

export function isValidVideoProjectId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function defaultVideoProjectStorageRoot(projectId: number): string {
  return path.join(DATA_ROOT, 'static', 'video-projects', String(projectId))
}

export function getVideoProjectStorageRoot(projectId: number): string {
  if (!isValidVideoProjectId(projectId)) throw new Error(`非法的视频项目 ID：${projectId}`)
  return defaultVideoProjectStorageRoot(projectId)
}

export function videoProjectSubdirPath(projectId: number, subDir: string): string {
  return path.join(getVideoProjectStorageRoot(projectId), normalizeSubdir(subDir))
}

export function videoProjectStorageRelative(projectId: number, subDir: string, filename: string): string {
  return `static/video-projects/${projectId}/${normalizeSubdir(subDir)}/${filename}`
}

export function parseVideoProjectStoragePath(relativePath: string): { projectId: number; rest: string } | null {
  const normalized = String(relativePath || '').replace(/\\/g, '/')
  const match = VIDEO_PROJECT_PATH_RE.exec(normalized)
  if (!match) return null
  const projectId = Number(match[1])
  const rest = match[2]
  if (!isValidVideoProjectId(projectId)) return null
  if (!rest || rest.split('/').some(part => !part || part === '..')) return null
  return { projectId, rest }
}

export function isVideoProjectStoragePath(relativePath: string): boolean {
  return parseVideoProjectStoragePath(relativePath) !== null
}

export function resolveVideoProjectStorageFile(projectId: number, rest: string): string {
  if (!isValidVideoProjectId(projectId)) throw new Error(`非法的视频项目 ID：${projectId}`)
  if (!rest || rest.includes('\\') || rest.split('/').some(part => !part || part === '..')) {
    throw new Error(`非法的视频项目文件路径：${rest}`)
  }
  const root = getVideoProjectStorageRoot(projectId)
  const target = path.resolve(root, ...rest.split('/'))
  if (!isPathInside(root, target)) throw new Error(`非法的视频项目文件路径：${rest}`)
  return target
}

export async function ensureVideoProjectStorageLayout(projectId: number): Promise<string> {
  const root = getVideoProjectStorageRoot(projectId)
  await fsp.mkdir(root, { recursive: true })
  await Promise.all(
    VIDEO_PROJECT_SUBDIRS.map(sub => fsp.mkdir(path.join(root, sub), { recursive: true })),
  )
  return root
}

export async function removeVideoProjectStorage(projectId: number): Promise<void> {
  if (!isValidVideoProjectId(projectId)) throw new Error(`非法的视频项目 ID：${projectId}`)
  await fsp.rm(getVideoProjectStorageRoot(projectId), { recursive: true, force: true })
}

export function videoProjectStorageExists(projectId: number): boolean {
  if (!isValidVideoProjectId(projectId)) return false
  return fs.existsSync(getVideoProjectStorageRoot(projectId))
}

function normalizeSubdir(subDir: string): string {
  const value = String(subDir || '').trim()
  if (!VIDEO_PROJECT_SUBDIRS.includes(value as VideoProjectSubdir)) {
    throw new Error(`非法的视频项目子目录：${subDir}`)
  }
  return value
}
