/**
 * 应用设置路由 — 全局配置的读写入口（AI 内容语言 / 引导漫游 / 配音默认值）
 */
import { Hono } from 'hono'
import {
  getContentLanguage,
  setContentLanguage,
  getToursSeen,
  setToursSeen,
  getDubbingDefaults,
  setDubbingDefaults,
  getNovelSettings,
  setNovelSettings,
  NovelSettingsValidationError,
  getMediaSettings,
  setMediaSettings,
  getUiSettings,
  setUiSettings,
  getDirectorSettings,
  setDirectorSettings,
  getEditSettings,
  setEditSettings,
  getAgentSettings,
  setAgentSettings,
  FoundationSettingsValidationError,
  CONTENT_LANGUAGES,
  type ContentLanguage,
} from '../services/app-settings.js'
import { getFfmpegStatus } from '../utils/ffmpeg.js'
import { MediaPathValidationError } from '../utils/media-paths.js'
import { success, badRequest } from '../utils/response.js'

const app = new Hono()

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

// GET /dubbing — 配音默认值（字幕/混音/音色/新建剧集偏好）
app.get('/dubbing', async (c) => {
  return success(c, { defaults: await getDubbingDefaults() })
})

// PUT /dubbing — 部分更新配音默认值，非法值自动钳制
app.put('/dubbing', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  return success(c, { defaults: await setDubbingDefaults(body) })
})

async function mediaPayload() {
  return { settings: getMediaSettings(), status: await getFfmpegStatus() }
}

// GET /media — FFmpeg 目录设置与当前解析/探测状态
app.get('/media', async (c) => {
  return success(c, await mediaPayload())
})

// PUT /media — 保存目录（空字符串 = 自动）；无效目录仍落库，由 status 明确报告不可用
app.put('/media', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    setMediaSettings(body)
  } catch (error) {
    if (error instanceof MediaPathValidationError) return badRequest(c, error.message)
    throw error
  }
  return success(c, await mediaPayload())
})

// GET /novel — 小说生成设置（flat novel.* 键；不含任何 API Key）
app.get('/novel', (c) => {
  return success(c, { settings: getNovelSettings() })
})

// PUT /novel — 部分更新；数值钳制、非法 stageModels 返回 400
app.put('/novel', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, { settings: setNovelSettings(body) })
  } catch (error) {
    if (error instanceof NovelSettingsValidationError) return badRequest(c, error.message)
    throw error
  }
})

// GET/PUT /ui|director|edit|agent — B0 基础层四命名空间（整体 JSON 存储，读取时叠加环境变量，环境变量值不落库）
app.get('/ui', (c) => success(c, { settings: getUiSettings() }))
app.put('/ui', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, { settings: setUiSettings(body) })
  } catch (error) {
    if (error instanceof FoundationSettingsValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.get('/director', (c) => success(c, { settings: getDirectorSettings() }))
app.put('/director', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, { settings: setDirectorSettings(body) })
  } catch (error) {
    if (error instanceof FoundationSettingsValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.get('/edit', (c) => success(c, { settings: getEditSettings() }))
app.put('/edit', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, { settings: setEditSettings(body) })
  } catch (error) {
    if (error instanceof FoundationSettingsValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.get('/agent', (c) => success(c, { settings: getAgentSettings() }))
app.put('/agent', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, { settings: setAgentSettings(body) })
  } catch (error) {
    if (error instanceof FoundationSettingsValidationError) return badRequest(c, error.message)
    throw error
  }
})

export default app
