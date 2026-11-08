/**
 * 分镜末帧资产 — 抽出的末帧只在本集生效
 *
 * 文件落在项目 storyboards/frames/ep-<剧集>/，资产行写 assets(category=storyboard_frame)。
 * 同一来源分镜重复抽取只保留一条资产；地址变化时同步本集已手工引用该资产的首帧。
 * 抽取不再自动改写下一镜首帧：末帧作为下一镜的参考图与提示词 @ 引用使用。
 * 来源分镜删除/重建后资产随剧集清理，列表只返回来源仍存活的资产。
 */
import fs from 'node:fs'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { extractVideoFrame } from './video-frames.js'

export const FRAME_ASSET_CATEGORY = 'storyboard_frame'

type AssetRow = typeof schema.assets.$inferSelect
type DbExecutor = Pick<typeof db, 'select' | 'update' | 'insert' | 'delete'>

export interface ExtractLastFrameResult {
  asset: AssetRow
}

function assetSubDir(episodeId: number): string {
  return `storyboards/frames/ep-${episodeId}`
}

function clearFirstFrameReferences(exec: DbExecutor, episodeId: number, url: string, ts: string): number {
  const rows = exec.select({ id: schema.storyboards.id })
    .from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      eq(schema.storyboards.firstFrameImage, url),
    ))
    .all()
  if (!rows.length) return 0
  exec.update(schema.storyboards)
    .set({ firstFrameImage: null, updatedAt: ts })
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      eq(schema.storyboards.firstFrameImage, url),
    ))
    .run()
  return rows.length
}

export async function listEpisodeFrameAssets(episodeId: number): Promise<AssetRow[]> {
  const rows = await db.select().from(schema.assets)
    .where(and(
      eq(schema.assets.episodeId, episodeId),
      eq(schema.assets.category, FRAME_ASSET_CATEGORY),
      isNull(schema.assets.deletedAt),
    ))
    .orderBy(desc(schema.assets.id))
  const liveShots = await db.select({ id: schema.storyboards.id }).from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
    ))
  const liveIds = new Set(liveShots.map(row => row.id))
  return rows.filter(row => row.storyboardId != null && liveIds.has(row.storyboardId))
}

export async function extractLastFrameAsset(storyboardId: number): Promise<ExtractLastFrameResult> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard || storyboard.deletedAt) throw new Error('镜头不存在')

  const videoUrl = String(storyboard.videoUrl || '').trim()
  if (!videoUrl) throw new Error('该镜头还没有视频，请先生成镜头视频')

  const [episode] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboard.episodeId))
  if (!episode) throw new Error('剧集不存在')

  const frame = await extractVideoFrame(videoUrl, 'last', {
    dramaId: episode.dramaId,
    label: `sb-${storyboard.id}`,
    subDir: assetSubDir(storyboard.episodeId),
  })

  const ts = now()
  const fileSize = fs.statSync(frame.absolutePath).size
  return db.transaction((tx) => {
    const existing = tx.select().from(schema.assets)
      .where(and(
        eq(schema.assets.episodeId, storyboard.episodeId),
        eq(schema.assets.storyboardId, storyboard.id),
        eq(schema.assets.category, FRAME_ASSET_CATEGORY),
        isNull(schema.assets.deletedAt),
      ))
      .get()

    let assetId: number
    const assetName = `镜头${storyboard.storyboardNumber}末帧`
    if (existing) {
      tx.update(schema.assets).set({
        name: assetName,
        url: frame.relativePath,
        thumbnailUrl: frame.relativePath,
        localPath: frame.absolutePath,
        fileSize,
        width: frame.width,
        height: frame.height,
        updatedAt: ts,
      }).where(eq(schema.assets.id, existing.id)).run()
      assetId = existing.id
      if (existing.url && existing.url !== frame.relativePath) {
        tx.update(schema.storyboards)
          .set({ firstFrameImage: frame.relativePath, updatedAt: ts })
          .where(and(
            eq(schema.storyboards.episodeId, storyboard.episodeId),
            eq(schema.storyboards.firstFrameImage, existing.url),
          ))
          .run()
      }
    } else {
      assetId = getInsertId(tx.insert(schema.assets).values({
        dramaId: episode.dramaId,
        episodeId: storyboard.episodeId,
        storyboardId: storyboard.id,
        storyboardNum: storyboard.storyboardNumber,
        name: assetName,
        description: '仅本集可用',
        type: 'image',
        category: FRAME_ASSET_CATEGORY,
        url: frame.relativePath,
        thumbnailUrl: frame.relativePath,
        localPath: frame.absolutePath,
        fileSize,
        mimeType: 'image/jpeg',
        width: frame.width,
        height: frame.height,
        format: 'jpeg',
        createdAt: ts,
        updatedAt: ts,
      }).run())
    }

    const asset = tx.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get()!
    return { asset }
  })
}

export async function setStoryboardFirstFrame(storyboardId: number, assetId: number | null): Promise<string | null> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard || storyboard.deletedAt) throw new Error('镜头不存在')

  let url: string | null = null
  if (assetId != null) {
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId))
    if (!asset || asset.deletedAt || asset.category !== FRAME_ASSET_CATEGORY) {
      throw new Error('分镜资产不存在')
    }
    if (asset.episodeId !== storyboard.episodeId) {
      throw new Error('该资产不属于当前剧集')
    }
    url = asset.url
  }

  await db.update(schema.storyboards)
    .set({ firstFrameImage: url, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
  return url
}

export async function deleteEpisodeFrameAsset(episodeId: number, assetId: number): Promise<number> {
  const ts = now()
  return db.transaction((tx) => {
    const asset = tx.select().from(schema.assets)
      .where(and(
        eq(schema.assets.id, assetId),
        eq(schema.assets.episodeId, episodeId),
        eq(schema.assets.category, FRAME_ASSET_CATEGORY),
        isNull(schema.assets.deletedAt),
      ))
      .get()
    if (!asset) throw new Error('分镜资产不存在')

    tx.update(schema.assets).set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.assets.id, assetId))
      .run()
    return asset.url ? clearFirstFrameReferences(tx, episodeId, asset.url, ts) : 0
  })
}

export function cleanupFrameAssetsForStoryboard(exec: DbExecutor, storyboardId: number, ts: string): number {
  const rows = exec.select({ id: schema.assets.id, episodeId: schema.assets.episodeId, url: schema.assets.url })
    .from(schema.assets)
    .where(and(
      eq(schema.assets.storyboardId, storyboardId),
      eq(schema.assets.category, FRAME_ASSET_CATEGORY),
      isNull(schema.assets.deletedAt),
    ))
    .all()
  for (const row of rows) {
    exec.update(schema.assets).set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.assets.id, row.id))
      .run()
    if (row.episodeId && row.url) clearFirstFrameReferences(exec, row.episodeId, row.url, ts)
  }
  return rows.length
}

/** 重建/重做整集分镜后清空本集分镜资产，避免来源已消失的孤儿资产继续出现在列表 */
export function cleanupFrameAssetsForEpisode(exec: DbExecutor, episodeId: number, ts: string): number {
  const rows = exec.select({ id: schema.assets.id, url: schema.assets.url })
    .from(schema.assets)
    .where(and(
      eq(schema.assets.episodeId, episodeId),
      eq(schema.assets.category, FRAME_ASSET_CATEGORY),
      isNull(schema.assets.deletedAt),
    ))
    .all()
  for (const row of rows) {
    exec.update(schema.assets).set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.assets.id, row.id))
      .run()
    if (row.url) clearFirstFrameReferences(exec, episodeId, row.url, ts)
  }
  return rows.length
}
