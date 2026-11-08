import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import {
  deleteEpisodeFrameAsset,
  extractLastFrameAsset,
  listEpisodeFrameAssets,
  setStoryboardFirstFrame,
} from '../services/storyboard-frame-assets.js'

const app = new Hono()

function parseId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function publicAsset(row: { localPath?: string | null } & Record<string, unknown>) {
  const { localPath: _localPath, ...rest } = row
  return toSnakeCase(rest)
}

// GET /episodes/:id/frame-assets — 本集分镜资产
app.get('/episodes/:id/frame-assets', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '剧集 ID 非法')
  const rows = await listEpisodeFrameAssets(episodeId)
  return success(c, rows.map(row => publicAsset(row)))
})

// POST /storyboards/:id/frame-assets/last — 抽末帧作为本集参考图资产（不改写首帧）
app.post('/storyboards/:id/frame-assets/last', async (c) => {
  const storyboardId = parseId(c.req.param('id'))
  if (!storyboardId) return badRequest(c, '镜头 ID 非法')
  try {
    const result = await extractLastFrameAsset(storyboardId)
    return success(c, { asset: publicAsset(result.asset) })
  } catch (error) {
    return badRequest(c, errorMessage(error, '抽取末帧失败'))
  }
})

// POST /storyboards/:id/first-frame — 从本集资产设置/清除首帧
app.post('/storyboards/:id/first-frame', async (c) => {
  const storyboardId = parseId(c.req.param('id'))
  if (!storyboardId) return badRequest(c, '镜头 ID 非法')
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'asset_id')) {
    return badRequest(c, '缺少 asset_id')
  }
  const raw = (body as Record<string, unknown>).asset_id
  const assetId = raw === null ? null : Number(raw)
  if (assetId !== null && (!Number.isSafeInteger(assetId) || assetId <= 0)) {
    return badRequest(c, 'asset_id 非法')
  }
  try {
    const firstFrameImage = await setStoryboardFirstFrame(storyboardId, assetId)
    return success(c, { first_frame_image: firstFrameImage })
  } catch (error) {
    return badRequest(c, errorMessage(error, '设置首帧失败'))
  }
})

// DELETE /episodes/:id/frame-assets/:assetId — 删除资产并清理本集引用
app.delete('/episodes/:id/frame-assets/:assetId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const assetId = parseId(c.req.param('assetId'))
  if (!episodeId || !assetId) return badRequest(c, '资产 ID 非法')
  try {
    const cleared = await deleteEpisodeFrameAsset(episodeId, assetId)
    return success(c, { deleted_id: assetId, cleared_storyboards: cleared })
  } catch (error) {
    return badRequest(c, errorMessage(error, '删除分镜资产失败'))
  }
})

export default app
