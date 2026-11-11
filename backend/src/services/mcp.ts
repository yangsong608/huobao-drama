/**
 * MCP（Model Context Protocol）服务端
 *
 * 设计要点：
 * - 独立固定端口（默认 5780，只绑 127.0.0.1）：桌面版主端口每次启动随机，
 *   外部客户端无法配置，所以 MCP 必须另起一个稳定端口。
 * - 鉴权：Bearer token（`Authorization: Bearer xxx`，也接受 `?token=`，方便不支持自定义头的客户端）。
 *   token 存在 app_settings，可在设置页生成/重置；关闭服务后端口不再监听。
 * - 协议：手写 JSON-RPC 2.0（initialize / tools/list / tools/call / ping），
 *   走 Streamable HTTP 的 POST 形态，不引入额外 SDK，避免打包依赖膨胀。
 * - 工具分两层：
 *   1) 常用业务动作（项目/剧集/资产/任务/合并/风格/存储）——语义清晰，模型好选；
 *   2) api_request + list_api_endpoints——覆盖全部 REST 端点，真正「所有接口都能调」。
 */
import crypto from 'node:crypto'
import type { Context, Hono } from 'hono'
import { serve } from '@hono/node-server'
import { and, eq, isNull } from 'drizzle-orm'
import { withInternalAppToken } from '../middleware/app-token.js'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { MAX_ASSET_REFERENCE_IMAGES, parseReferenceImages } from '../utils/asset-references.js'
import { commitNovelImport } from './novel-import.js'

const KEY_ENABLED = 'mcp.enabled'
const KEY_PORT = 'mcp.port'
const KEY_TOKEN = 'mcp.token'

export const DEFAULT_MCP_PORT = 5780
const MIN_MCP_PORT = 1024
const MAX_MCP_PORT = 65535
const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]
const SERVER_INFO = { name: 'huobao-drama', version: '1.0.0' }

interface ServerTypeLike {
  close: (cb?: (err?: Error) => void) => void
  on: (event: string, listener: (...args: any[]) => void) => void
}

let mainApp: Hono | null = null
let mcpServer: ServerTypeLike | null = null
let runningPort: number | null = null
let lastError: string | null = null

/** 由 index.ts 注入主 Hono 应用：工具通过 app.fetch 调内部 REST，避免走网络与鉴权 */
export function setMcpMainApp(app: Hono) {
  mainApp = app
}

// ---------------------------------------------------------------------------
// 配置读写（app_settings）
// ---------------------------------------------------------------------------

function readSetting(key: string): string {
  try {
    const row = db.select().from(schema.appSettings)
      .where(eq(schema.appSettings.key, key))
      .get()
    return row?.value ?? ''
  } catch {
    return ''
  }
}

function writeSetting(key: string, value: string) {
  db.insert(schema.appSettings)
    .values({ key, value, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now() } })
    .run()
}

function normalizePort(raw: unknown): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < MIN_MCP_PORT || port > MAX_MCP_PORT) {
    throw new Error(`端口必须是 ${MIN_MCP_PORT}-${MAX_MCP_PORT} 之间的整数`)
  }
  return port
}

/** 当前 token；没有则返回空串（未生成时不允许启动） */
export function getMcpToken(): string {
  return readSetting(KEY_TOKEN)
}

/** 轮换 token：立即失效旧 token（运行中的服务不需要重启） */
export function rotateMcpToken(): string {
  const token = crypto.randomBytes(24).toString('hex')
  writeSetting(KEY_TOKEN, token)
  return token
}

function ensureToken(): string {
  const existing = getMcpToken()
  return existing || rotateMcpToken()
}

function tokenEquals(a: string, b: string): boolean {
  if (!a || !b) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  token: string
  tool_count: number
  tools: string[]
  error: string | null
}

/** 桌面版固定回环；容器/服务器可用 MCP_HOST 覆盖（需自行保证网络隔离） */
function mcpHost(): string {
  return process.env.MCP_HOST || '127.0.0.1'
}

export function getMcpStatus(): McpStatus {
  const port = Number(readSetting(KEY_PORT)) || DEFAULT_MCP_PORT
  const token = getMcpToken()
  return {
    enabled: readSetting(KEY_ENABLED) === '1',
    running: Boolean(mcpServer) && runningPort === port,
    port,
    url: `http://${mcpHost()}:${port}/mcp`,
    token,
    tool_count: TOOLS.length,
    tools: TOOLS.map(t => t.name),
    error: lastError,
  }
}

// ---------------------------------------------------------------------------
// 内部 REST 调用
// ---------------------------------------------------------------------------

interface ApiCallOptions {
  query?: Record<string, unknown>
  body?: unknown
}

/** 通过主 Hono app 直接派发内部请求（不经过 TCP，也不会被 CORS/静态托管影响） */
async function callApi(method: string, path: string, options: ApiCallOptions = {}): Promise<any> {
  if (!mainApp) throw new Error('服务尚未就绪，请稍后重试')
  const url = new URL(path.startsWith('/') ? path : `/${path}`, 'http://internal')
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const init: RequestInit = { method: method.toUpperCase() }
  if (options.body !== undefined && init.method !== 'GET' && init.method !== 'DELETE') {
    init.body = JSON.stringify(options.body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await mainApp.fetch(new Request(url.toString(), withInternalAppToken(init)))
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${json?.message ? `：${json.message}` : `：${text.slice(0, 200)}`}`)
  }
  if (json && typeof json.code === 'number' && json.code >= 400) {
    throw new Error(json.message || `接口返回 ${json.code}`)
  }
  return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
}

async function callApiRaw(method: string, path: string, body: FormData): Promise<any> {
  if (!mainApp) throw new Error('服务尚未就绪，请稍后重试')
  const url = new URL(path.startsWith('/') ? path : `/${path}`, 'http://internal')
  const res = await mainApp.fetch(new Request(url.toString(), withInternalAppToken({ method: method.toUpperCase(), body })))
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}${json?.message ? `：${json.message}` : `：${text.slice(0, 200)}`}`)
  if (json && typeof json.code === 'number' && json.code >= 400) throw new Error(json.message || `接口返回 ${json.code}`)
  return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
}

// --- 上传：base64 直传，复用 /upload/* 路由的格式与体积校验 ------------------

const MCP_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
}
const DEFAULT_UPLOAD_EXT: Record<'image' | 'video' | 'audio', string> = { image: 'png', video: 'mp4', audio: 'mp3' }
/** 每种媒体允许的扩展名；文件名缺失/不匹配时补默认扩展名，避免存成 .bin 后浏览器与模型都识别不了 */
const UPLOAD_EXTS: Record<'image' | 'video' | 'audio', string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  video: ['.mp4', '.mov', '.webm', '.m4v'],
  audio: ['.mp3', '.wav', '.m4a', '.aac'],
}

function decodeBase64(input: unknown): Buffer {
  const raw = String(input || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  if (!raw) throw new Error('data_base64 必填（可带 data:image/png;base64, 前缀）')
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) throw new Error('data_base64 不是合法的 base64 内容')
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new Error('base64 解码后为空，请检查内容')
  if (buffer.length > MCP_UPLOAD_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(MCP_UPLOAD_MAX_BYTES / 1048576)}MB，请压缩后重试，或在界面里直接上传`)
  }
  return buffer
}

function uploadFilename(kind: 'image' | 'video' | 'audio', raw: unknown): string {
  const fallback = `mcp-${Date.now()}.${DEFAULT_UPLOAD_EXT[kind]}`
  const name = String(raw || '').split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name) return fallback
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  // 扩展名与该媒体不匹配（含完全没写扩展名）时，按该媒体默认扩展名补齐
  if (UPLOAD_EXTS[kind].includes(ext)) return name.slice(0, 120)
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base}.${DEFAULT_UPLOAD_EXT[kind]}`.slice(0, 120)
}

async function callUpload(kind: 'image' | 'video' | 'audio', args: any): Promise<any> {
  if (!mainApp) throw new Error('服务尚未就绪，请稍后重试')
  const buffer = decodeBase64(args?.data_base64)
  const filename = uploadFilename(kind, args?.filename)
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: MIME_BY_EXT[ext] || 'application/octet-stream' }), filename)
  if (args?.drama_id !== undefined && args?.drama_id !== null && args?.drama_id !== '') {
    form.append('drama_id', String(Number(args.drama_id)))
  }
  const res = await mainApp.fetch(new Request(`http://internal/api/v1/upload/${kind}`, withInternalAppToken({ method: 'POST', body: form })))
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok || (json && typeof json.code === 'number' && json.code >= 400)) {
    throw new Error(json?.message || `上传失败（HTTP ${res.status}）`)
  }
  return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
}

// --- 资产图：一步上传并回写（角色 / 场景 / 道具） ---------------------------

type AssetKind = 'character' | 'scene' | 'prop'

const ASSET_LABEL: Record<AssetKind, string> = { character: '角色', scene: '场景', prop: '道具' }
const ASSET_ROUTE: Record<AssetKind, string> = {
  character: '/api/v1/characters',
  scene: '/api/v1/scenes',
  prop: '/api/v1/props',
}

const ASSET_KIND_ALIAS: Record<string, AssetKind> = {
  character: 'character', characters: 'character', role: 'character', char: 'character', 角色: 'character', 人物: 'character',
  scene: 'scene', scenes: 'scene', 场景: 'scene',
  prop: 'prop', props: 'prop', item: 'prop', 道具: 'prop',
}

function normalizeAssetKind(raw: unknown): AssetKind {
  const key = String(raw ?? '').trim().toLowerCase()
  const kind = ASSET_KIND_ALIAS[key]
  if (!kind) throw new Error('asset_type 仅支持 character / scene / prop')
  return kind
}

interface AssetSnapshot {
  id: number
  dramaId: number
  name: string
  imageUrl: string | null
  referenceImages: string | null
}

/** 读资产自身（含 dramaId），用于定位项目目录与判断是否存在 */
function loadAsset(kind: AssetKind, id: number): AssetSnapshot | null {
  if (kind === 'character') {
    const row = db.select().from(schema.characters)
      .where(and(eq(schema.characters.id, id), isNull(schema.characters.deletedAt))).get()
    return row ? { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, referenceImages: row.referenceImages } : null
  }
  if (kind === 'scene') {
    const row = db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.id, id), isNull(schema.scenes.deletedAt))).get()
    return row ? { id: row.id, dramaId: row.dramaId, name: row.location, imageUrl: row.imageUrl, referenceImages: row.referenceImages } : null
  }
  const row = db.select().from(schema.props)
    .where(and(eq(schema.props.id, id), isNull(schema.props.deletedAt))).get()
  return row ? { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, referenceImages: row.referenceImages } : null
}

/** 只接受 static/ 相对路径或 http(s) 地址，返回与生图回写一致的存库格式 */
function normalizeAssetPath(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (value.includes('..')) throw new Error('path 不合法')
  const relative = value.replace(/^\/+/, '')
  if (!relative.startsWith('static/')) throw new Error('path 需为 static/… 相对路径或 http(s) 地址')
  return relative
}

async function setAssetImage(args: any): Promise<any> {
  const kind = normalizeAssetKind(args?.asset_type)
  const id = Number(args?.asset_id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('asset_id 必填且为正整数')
  const asset = loadAsset(kind, id)
  if (!asset) throw new Error(`${ASSET_LABEL[kind]} ${id} 不存在`)

  let path = normalizeAssetPath(args?.path ?? args?.url)
  let uploaded = false
  if (args?.data_base64) {
    const result = await callUpload('image', { data_base64: args.data_base64, filename: args.filename, drama_id: asset.dramaId })
    path = result?.path || normalizeAssetPath(result?.url)
    uploaded = true
  }
  if (!path) throw new Error('data_base64 与 path 至少传一个')

  const body: Record<string, unknown> = { image_url: path, local_path: path }
  let referenceImages: string[] | null = null
  if (args?.also_reference) {
    const existing = parseReferenceImages(asset.referenceImages).filter(item => item !== path)
    referenceImages = [...existing, path].slice(-MAX_ASSET_REFERENCE_IMAGES)
    body.reference_images = referenceImages
  }

  await callApi('PUT', `${ASSET_ROUTE[kind]}/${id}`, { body })
  return {
    asset_type: kind,
    asset_id: id,
    name: asset.name,
    drama_id: asset.dramaId,
    image_url: path,
    url: /^https?:\/\//i.test(path) ? path : `/${path}`,
    uploaded,
    previous_image_url: asset.imageUrl,
    ...(referenceImages ? { reference_images: referenceImages } : {}),
  }
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: any) => Promise<any>
}

export function getMcpTool(name: string): ToolDef | undefined {
  return TOOLS.find(t => t.name === name)
}

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const int = (description: string) => ({ type: 'integer', description })
const str = (description: string) => ({ type: 'string', description })
const bool = (description: string) => ({ type: 'boolean', description })
const intArray = (description: string) => ({ type: 'array', items: { type: 'integer' }, description })

/** 解析 "1-10" / "1,3,5" 形式的章节范围；留空返回 undefined（全部章节） */
function parseChapterRange(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const text = String(raw).trim()
  if (!text) return undefined
  const numbers = new Set<number>()
  for (const part of text.split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-~～至]\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < start || end - start > 5000) throw new Error(`chapter_range 不合法：${part}`)
      for (let n = start; n <= end; n++) numbers.add(n)
      continue
    }
    const single = Number(part)
    if (!/^\d+$/.test(part) || !Number.isSafeInteger(single) || single < 1) {
      throw new Error(`chapter_range 不合法：${part}`)
    }
    numbers.add(single)
  }
  if (!numbers.size) throw new Error('chapter_range 不合法')
  return [...numbers].sort((a, b) => a - b)
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    description: '列出全部短剧项目（含 id、标题、风格、集数、更新时间）。',
    inputSchema: obj({}),
    handler: () => callApi('GET', '/api/v1/dramas'),
  },
  {
    name: 'get_project',
    description: '读取单个项目详情与统计信息。',
    inputSchema: obj({ drama_id: int('项目 ID') }, ['drama_id']),
    handler: ({ drama_id }) => callApi('GET', `/api/v1/dramas/${Number(drama_id)}`),
  },
  {
    name: 'create_project',
    description: '新建短剧项目。style 传风格预设的 value（见 list_style_presets），默认 3d。background 是项目背景（世界观/时代/地域），会注入到所有资产与视频生成提示词。',
    inputSchema: obj({
      title: str('项目标题'),
      style: str('风格预设 value，如 3d / guofeng / custom-xxx'),
      background: str('项目背景（世界观/时代/地域/主线设定），可选'),
      aspect_ratio: str('画面比例，如 16:9 或 9:16'),
    }, ['title']),
    handler: args => callApi('POST', '/api/v1/dramas', { body: args }),
  },
  {
    name: 'list_episodes',
    description: '列出某个项目下的剧集。',
    inputSchema: obj({ drama_id: int('项目 ID') }, ['drama_id']),
    handler: ({ drama_id }) => callApi('GET', '/api/v1/episodes', { query: { drama_id } }),
  },
  {
    name: 'get_episode',
    description: '读取单集详情（含剧本内容、锁定模型、分辨率等）。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}`),
  },
  {
    name: 'create_episode',
    description: [
      '在某项目下新建一集并返回 id。content 传该集原始内容（小说章节/剧本文本），供全自动流程改写使用。',
      '短剧生成完整链路：list_projects → create_project → create_episode → start_episode_automation → get_episode_automation 轮询到 done → merge_episode 合片。',
    ].join('\n'),
    inputSchema: obj({
      drama_id: int('项目 ID'),
      title: str('集标题（可选，默认「第N集」）'),
      content: str('该集原始内容：小说章节/剧本正文（可选）'),
      resolution: str('视频分辨率 480p / 720p / 1080p（可选，默认 720p）'),
      auto_pipeline: bool('建集后是否自动进入全自动流程（可选）'),
      auto_dub: bool('视频阶段结束后是否自动跑配音（可选）'),
    }, ['drama_id']),
    handler: args => callApi('POST', '/api/v1/episodes', { body: args }),
  },
  {
    name: 'update_episode',
    description: [
      '修改剧集字段：标题、原始内容（content，改完重跑 start_episode_automation 可增量补齐缺失阶段）、剧本（script_content）、状态、',
      '分辨率 480p/720p/1080p、原声模式 video_audio_mode（auto/native/ambient/silent）、BGM 地址、视频模式等。只传需要修改的字段。',
    ].join('\n'),
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      title: str('新标题（可选）'),
      content: str('新原始内容（可选）'),
      script_content: str('新剧本内容（可选）'),
      status: str('状态（可选）'),
      resolution: str('480p / 720p / 1080p（可选）'),
      video_audio_mode: str('auto / native / ambient / silent（可选）'),
      bgm_url: str('BGM 文件路径（可选）'),
      auto_dub: bool('视频后是否自动配音（可选）'),
    }, ['episode_id']),
    handler: ({ episode_id, ...rest }) => callApi('PUT', `/api/v1/episodes/${Number(episode_id)}`, { body: rest }),
  },
  {
    name: 'list_storyboards',
    description: '列出某集的全部分镜（含提示词、首帧图、视频地址、状态）。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/storyboards`),
  },
  {
    name: 'create_storyboard',
    description: [
      '在某集下手工新增一个分镜，可绑定场景、角色与道具。分镜一般由 start_episode_automation 自动拆分，此工具用于补镜头或手动建分镜。',
      '新建后用 update_storyboard 补提示词，再用 generate_image / generate_video 出图出片。',
    ].join('\n'),
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      storyboard_number: int('镜头序号（可选，默认 1）'),
      title: str('镜头标题（可选）'),
      description: str('镜头内容描述（可选）'),
      scene_id: int('绑定场景 ID（可选）'),
      character_ids: intArray('绑定角色 ID 列表（可选）'),
      prop_ids: intArray('绑定道具 ID 列表（可选）'),
      duration: int('时长秒数（可选，默认 10）'),
      transition: str('转场方式（可选）'),
    }, ['episode_id']),
    handler: args => callApi('POST', '/api/v1/storyboards', { body: args }),
  },
  {
    name: 'update_storyboard',
    description: [
      '优化/修订分镜：改视频提示词 video_prompt、图片提示词 image_prompt、镜头 shot_type/angle/movement、时长 duration、',
      '地点/时间/氛围、音效 sound_effect、配乐 bgm_prompt、转场 transition，或重新绑定场景/角色/道具。',
      '改完 video_prompt 后用 generate_video 重新出片。只传需要修改的字段。',
    ].join('\n'),
    inputSchema: obj({
      storyboard_id: int('分镜 ID'),
      title: str('镜头标题（可选）'),
      description: str('镜头描述（可选）'),
      video_prompt: str('视频提示词（可选）'),
      image_prompt: str('首帧图片提示词（可选）'),
      shot_type: str('景别（可选）'),
      angle: str('角度（可选）'),
      movement: str('运镜（可选）'),
      duration: int('时长秒数（可选）'),
      scene_id: int('绑定场景 ID（可选）'),
      location: str('地点（可选）'),
      time: str('时间（可选）'),
      atmosphere: str('氛围（可选）'),
      result: str('画面结果描述（可选）'),
      sound_effect: str('音效提示词（可选）'),
      bgm_prompt: str('配乐提示词（可选）'),
      transition: str('转场方式（可选）'),
      continuity: str('连贯性说明（可选）'),
      character_ids: intArray('重新绑定角色 ID 列表（可选，传空数组清空）'),
      prop_ids: intArray('重新绑定道具 ID 列表（可选，传空数组清空）'),
    }, ['storyboard_id']),
    handler: ({ storyboard_id, ...rest }) => callApi('PUT', `/api/v1/storyboards/${Number(storyboard_id)}`, { body: rest }),
  },
  {
    name: 'delete_storyboard',
    description: [
      '删除分镜。全自动流程的分镜拆分阶段会跳过已有分镜；想让 start_episode_automation 重新拆分该集，先删除旧分镜再启动。',
    ].join('\n'),
    inputSchema: obj({ storyboard_id: int('分镜 ID') }, ['storyboard_id']),
    handler: ({ storyboard_id }) => callApi('DELETE', `/api/v1/storyboards/${Number(storyboard_id)}`),
  },
  {
    name: 'list_characters',
    description: '列出某集涉及的角色资产。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/characters`),
  },
  {
    name: 'list_scenes',
    description: '列出某集涉及的场景资产。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/scenes`),
  },
  {
    name: 'list_props',
    description: '列出某集涉及的道具资产。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/props`),
  },
  {
    name: 'generate_image',
    description: '提交图片生成任务。prompt 必填；绑定 storyboard_id 时结果会回写该分镜首帧。返回任务 id。',
    inputSchema: obj({
      prompt: str('完整提示词'),
      storyboard_id: int('分镜 ID（可选）'),
      drama_id: int('项目 ID（可选）'),
      model: str('图片模型名（可选）'),
      config_id: int('AI 服务配置 ID（可选）'),
      size: str('分辨率，如 1920x1080（可选）'),
    }, ['prompt']),
    handler: args => callApi('POST', '/api/v1/tasks', { body: { ...args, type: 'image' } }),
  },
  {
    name: 'generate_video',
    description: '提交视频生成任务。通常传 storyboard_id，提示词从分镜读取；返回任务 id。',
    inputSchema: obj({
      storyboard_id: int('分镜 ID'),
      drama_id: int('项目 ID（可选）'),
      prompt: str('视频提示词（可选，不传则用分镜已存提示词）'),
      model: str('视频模型名（可选）'),
      config_id: int('AI 服务配置 ID（可选）'),
      duration: ({ type: 'integer', description: '时长秒数（可选）' } as Record<string, unknown>),
      force_new: bool('失败任务是否强制新建（会再次计费）'),
    }, ['storyboard_id']),
    handler: args => callApi('POST', '/api/v1/tasks', { body: { ...args, type: 'video' } }),
  },
  {
    name: 'list_tasks',
    description: '按条件列出生成任务（可按 type / drama_id / storyboard_id 过滤）。',
    inputSchema: obj({
      type: str('image 或 video'),
      drama_id: int('项目 ID'),
      storyboard_id: int('分镜 ID'),
    }),
    handler: args => callApi('GET', '/api/v1/tasks', { query: args }),
  },
  {
    name: 'get_task',
    description: '读取单个任务的状态、阶段与产物路径。',
    inputSchema: obj({ task_id: int('任务 ID') }, ['task_id']),
    handler: ({ task_id }) => callApi('GET', `/api/v1/tasks/${Number(task_id)}`),
  },
  {
    name: 'merge_episode',
    description: '把某集已生成的分镜视频拼接成片（不传 storyboard_ids 则按顺序拼全部）。',
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      storyboard_ids: { type: 'array', items: { type: 'integer' }, description: '指定分镜顺序（可选）' },
    }, ['episode_id']),
    handler: ({ episode_id, storyboard_ids }) => callApi('POST', `/api/v1/merge/episodes/${Number(episode_id)}/merge`, {
      body: storyboard_ids ? { storyboard_ids } : {},
    }),
  },
  {
    name: 'get_merge_status',
    description: '查询某集最近一次合并任务的状态与成片地址。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/merge/episodes/${Number(episode_id)}/merge`),
  },
  {
    name: 'list_style_presets',
    description: '列出风格预设（含 value、名称、提示词）。新建项目时 style 字段取其中的 value。',
    inputSchema: obj({ include_disabled: bool('是否包含已停用的预设') }),
    handler: ({ include_disabled }) => callApi('GET', '/api/v1/style-presets', { query: include_disabled ? { all: 1 } : {} }),
  },
  {
    name: 'analyze_style_from_images',
    description: '用视觉模型分析参考图片并生成新的风格预设（会写入风格库）。images 传 static/ 开头的相对路径。',
    inputSchema: obj({
      images: { type: 'array', items: { type: 'string' }, description: '参考图路径数组，1-4 张' },
      language: str('输出语言 zh/en/ja/ko，默认 zh'),
      config_id: int('视觉模型配置 ID（可选）'),
    }, ['images']),
    handler: args => callApi('POST', '/api/v1/style-presets/analyze', { body: args }),
  },
  {
    name: 'get_project_storage',
    description: '查看项目存储目录、各子目录占用与进行中任务数。',
    inputSchema: obj({ drama_id: int('项目 ID') }, ['drama_id']),
    handler: ({ drama_id }) => callApi('GET', `/api/v1/dramas/${Number(drama_id)}/storage`),
  },
  {
    name: 'upload_image',
    description: '把图片以 base64 上传到素材目录，返回 { url, path }。带 drama_id 时落到该项目的 uploads 子目录；只上传不绑定资产，要直接设为角色/场景/道具备图请用 set_asset_image。单文件上限 25MB。',
    inputSchema: obj({
      data_base64: str('图片内容 base64，可带 data:image/png;base64, 前缀'),
      filename: str('文件名（含扩展名，如 ref.png），缺省用 mcp-<时间>.png'),
      drama_id: int('项目 ID（可选，带则落项目目录）'),
    }, ['data_base64']),
    handler: args => callUpload('image', args),
  },
  {
    name: 'upload_video',
    description: '把视频以 base64 上传（.mp4/.mov/.webm/.m4v），返回 { url, path }。上限 25MB；更大的文件请在界面里上传。',
    inputSchema: obj({
      data_base64: str('视频内容 base64'),
      filename: str('文件名（含扩展名，如 ref.mp4）'),
      drama_id: int('项目 ID（可选）'),
    }, ['data_base64']),
    handler: args => callUpload('video', args),
  },
  {
    name: 'upload_audio',
    description: '把音频以 base64 上传（.mp3/.wav/.m4a/.aac），返回 { url, path, name }。上限 20MB，可用于角色音色或视频参考音频。',
    inputSchema: obj({
      data_base64: str('音频内容 base64'),
      filename: str('文件名（含扩展名，如 voice.mp3）'),
      drama_id: int('项目 ID（可选）'),
    }, ['data_base64']),
    handler: args => callUpload('audio', args),
  },
  {
    name: 'set_asset_image',
    description: '一步到位：把图片设为角色/场景/道具的成图。传 data_base64 会先上传到该项目 uploads 目录再回写资产；也可传已上传的 path 直接绑定。单文件上限 25MB。',
    inputSchema: obj({
      asset_type: str('资产类型：character / scene / prop'),
      asset_id: int('资产 ID'),
      data_base64: str('图片内容 base64（与 path 二选一），可带 data:image/png;base64, 前缀'),
      path: str('已上传的图片路径或 URL（与 data_base64 二选一），如 static/projects/1/uploads/x.png'),
      filename: str('文件名（仅 data_base64 时生效，缺省 mcp-<时间>.png）'),
      also_reference: bool('是否同时把这张图记为资产参考图（默认 false）'),
    }, ['asset_type', 'asset_id']),
    handler: args => setAssetImage(args),
  },
  {
    name: 'start_episode_automation',
    description: '启动某集的全自动流程：AI 改写 → 资产提取 → 资产生图 → 分镜拆分 → 视频提示词 → 视频生成。返回当前状态；已在运行则 already_running=true。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('POST', `/api/v1/episodes/${Number(episode_id)}/automation`, { body: {} }),
  },
  {
    name: 'get_episode_automation',
    description: '查询某集全自动流程的状态、当前阶段、进度（0-100）、阶段内说明与错误信息。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/automation`),
  },
  {
    name: 'stop_episode_automation',
    description: '停止某集的全自动流程（已完成的内容保留，可再次 start 继续）。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('POST', `/api/v1/episodes/${Number(episode_id)}/automation/stop`, { body: {} }),
  },
  {
    name: 'list_pipeline_rules',
    description: '列出流水线任务规则（AI 改写 / 资产提取 / 分镜拆分 / 视频提示词），含默认值与是否已自定义。',
    inputSchema: obj({}),
    handler: () => callApi('GET', '/api/v1/pipeline-rules'),
  },
  {
    name: 'update_pipeline_rule',
    description: '修改一条流水线任务规则（key 见 list_pipeline_rules）。传空字符串恢复默认。占位符如 {{videoModel}} 会在执行时替换。',
    inputSchema: obj({
      key: str('规则 key，如 rewrite / extract.characters / storyboards / video_prompts'),
      rule: str('规则全文；传空字符串表示恢复默认'),
    }, ['key', 'rule']),
    handler: ({ key, rule }) => callApi('PUT', `/api/v1/pipeline-rules/${encodeURIComponent(String(key))}`, { body: { rule } }),
  },
  {
    name: 'list_voice_profiles',
    description: '列出项目内所有角色音色与旁白音色：激活项、状态、声音提示词与试听地址。',
    inputSchema: obj({ drama_id: int('项目 ID') }, ['drama_id']),
    handler: ({ drama_id }) => callApi('GET', `/api/v1/voices?drama_id=${Number(drama_id)}`),
  },
  {
    name: 'generate_voice_profiles',
    description: '为一集里的角色批量生成声音提示词（中文 voice_prompt + 英文 design_instruct + 试听文本）。不传 character_ids 时处理本集全部角色。',
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      character_ids: { type: 'array', items: { type: 'number' }, description: '指定角色 ID（可选）' },
      force: bool('已有激活音色时是否覆盖（默认 false）'),
    }, ['episode_id']),
    handler: async ({ episode_id, character_ids, force }) => {
      const episodeId = Number(episode_id)
      let ids = Array.isArray(character_ids) ? character_ids.map(Number) : []
      if (!ids.length) {
        const characters = await callApi('GET', `/api/v1/episodes/${episodeId}/characters`)
        const list = Array.isArray(characters) ? characters : (characters?.items || [])
        ids = list.map((c: any) => Number(c.id)).filter(Boolean)
      }
      const results = []
      for (const id of ids) {
        try {
          results.push(await callApi('POST', `/api/v1/characters/${id}/voice-profile`, { body: { force: Boolean(force), episode_id: episodeId } }))
        } catch (error: any) {
          results.push({ character_id: id, error: String(error?.message || error) })
        }
      }
      return { total: ids.length, results }
    },
  },
  {
    name: 'synthesize_voice_sample',
    description: '生成一条试听音频。角色传 character_id；旁白传 scope="narrator" + drama_id，且不传 character_id。',
    inputSchema: obj({
      character_id: int('角色 ID（言白时省略）'),
      scope: str('character / narrator'),
      drama_id: int('项目 ID（旁白时必填）'),
      text: str('试听文本（可选，缺省用该角色第一句台词）'),
      seed: int('随机种子（可选）'),
    }),
    handler: async ({ character_id, scope, drama_id, text, seed }) => {
      if (scope === 'narrator' || !character_id) {
        if (!drama_id) throw new Error('旁白试听需要 drama_id')
        return callApi('POST', '/api/v1/voices/narrator/sample', { body: { drama_id: Number(drama_id), text } })
      }
      return callApi('POST', `/api/v1/characters/${Number(character_id)}/voice-sample`, {
        body: { text, seed: seed ? Number(seed) : undefined },
      })
    },
  },
  {
    name: 'clone_voice',
    description: '用本地参考音频克隆角色音色（3–20 秒，≤20MB）。会记录授权确认时间；建议先试听再激活。',
    inputSchema: obj({
      character_id: int('角色 ID'),
      file_path: str('本地音频绝对路径（mp3/wav/m4a/aac）'),
      ref_text: str('参考音频的文字内容（可选）'),
      x_vector_only: bool('只取音色向量、不依赖文本（可选）'),
    }, ['character_id', 'file_path']),
    handler: async ({ character_id, file_path, ref_text, x_vector_only }) => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const abs = path.resolve(String(file_path))
      const buffer = await fs.readFile(abs)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buffer)]), path.basename(abs))
      form.append('consent_confirmed', '1')
      if (ref_text) form.append('ref_text', String(ref_text))
      if (x_vector_only) form.append('x_vector_only', 'true')
      return callApiRaw('POST', `/api/v1/characters/${Number(character_id)}/voice-clone`, form)
    },
  },
  {
    name: 'list_storyboard_lines',
    description: '列出某集台词（含说话人、时间轴、音频地址、超长与待复核标记）。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/lines`),
  },
  {
    name: 'update_storyboard_line',
    description: '人工修订一句台词：改文本、说话人或绑定角色。改文本会清空该句音频并置为待合成。',
    inputSchema: obj({
      line_id: int('台词 ID'),
      text: str('新文本'),
      speaker_type: str('dialogue / narration / inner'),
      character_id: int('绑定角色 ID（0 表示清空）'),
      locked: bool('锁定后重抽不覆盖'),
    }, ['line_id']),
    handler: ({ line_id, text, speaker_type, character_id, locked }) => callApi('PUT', `/api/v1/lines/${Number(line_id)}`, {
      body: {
        ...(text !== undefined ? { text } : {}),
        ...(speaker_type !== undefined ? { speaker_type } : {}),
        ...(character_id !== undefined ? { character_id: Number(character_id) || null } : {}),
        ...(locked !== undefined ? { locked: Boolean(locked) } : {}),
      },
    }),
  },
  {
    name: 'start_episode_dubbing',
    description: '启动整集配音：确保合片 → 逐句合成 → 时间轴 → 字幕 → 混音。返回 job_id 与当前状态，之后用 get_episode_dubbing 轮询。',
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      subtitle_mode: str('soft / burn / none（默认 soft）'),
      original_audio: str('duck / keep / mute（默认 duck）'),
      bgm_url: str('BGM 文件路径（可选）'),
      force: bool('强制重新合成所有台词（默认 false）'),
    }, ['episode_id']),
    handler: ({ episode_id, subtitle_mode, original_audio, bgm_url, force }) => callApi('POST', `/api/v1/episodes/${Number(episode_id)}/dub`, {
      body: { subtitle_mode, original_audio, bgm_url, force: Boolean(force) },
    }),
  },
  {
    name: 'get_episode_dubbing',
    description: '查询整集配音进度、备注与成片/字幕地址。',
    inputSchema: obj({ episode_id: int('剧集 ID') }, ['episode_id']),
    handler: ({ episode_id }) => callApi('GET', `/api/v1/episodes/${Number(episode_id)}/dub`),
  },
  {
    name: 'render_motion_post',
    description: '视频失败时的图文动画兜底：用分镜图 + 缓慢推拉 + 已有配音轨拼出一集可交付版本。',
    inputSchema: obj({
      episode_id: int('剧集 ID'),
      bgm_url: str('BGM 路径（可选）'),
      set_as_video: bool('是否直接替换该集成片（默认 false，保留为新版本）'),
    }, ['episode_id']),
    handler: ({ episode_id, bgm_url, set_as_video }) => callApi('POST', `/api/v1/episodes/${Number(episode_id)}/motion-post`, {
      body: { bgm_url, set_as_video: Boolean(set_as_video) },
    }),
  },
  {
    name: 'generate_grid_sheet',
    description: '一次生成 rows×cols 宫格素材（角色/场景/道具），再按坐标切分，用于保持同风格一致性。',
    inputSchema: obj({
      drama_id: int('项目 ID'),
      kind: str('character / scene / prop'),
      rows: int('行数 1–5'),
      cols: int('列数 1–5'),
      prompt: str('补充提示词（可选）'),
      targets: { type: 'array', items: { type: 'string' }, description: '每格主体名称（可选）' },
      episode_id: int('关联集（可选）'),
    }, ['drama_id', 'kind']),
    handler: ({ drama_id, kind, rows, cols, prompt, targets, episode_id }) => callApi('POST', '/api/v1/grid', {
      body: { drama_id: Number(drama_id), kind, rows: Number(rows || 2), cols: Number(cols || 2), prompt, targets, episode_id },
    }),
  },
  {
    name: 'parse_script',
    description: '解析整本剧本（纯文本）：切分章节并给出拆集预览，不创建剧集。确认预览后可用 api_request 调用 /api/v1/dramas/{id}/script/commit 建集。',
    inputSchema: obj({
      drama_id: int('项目 ID'),
      text: str('剧本全文（与 filename 二选一）'),
      filename: str('文件名（可选，用于识别格式）'),
    }, ['drama_id']),
    handler: ({ drama_id, text, filename }) => callApi('POST', `/api/v1/dramas/${Number(drama_id)}/script/parse`, {
      body: { text, filename },
    }),
  },
  {
    name: 'import_novel_to_drama',
    description: '把小说按章节导入为短剧（默认 16:9、1200 字/集、规则生成背景）。target_words 为每集目标字数（600-5000，不是硬上限）；request_id 幂等，返回 import_id / drama_id / episode_count。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      title: str('短剧标题（默认《小说名》短剧）'),
      aspect_ratio: str('画幅 16:9 或 9:16（默认 16:9）'),
      target_words: int('每集目标字数（600-5000，目标值而非硬上限）'),
      chapter_range: str('章节范围，如 1-10 或 1,3,5；留空导入全部'),
      request_id: str('幂等键（可选）'),
    }, ['novel_id']),
    handler: async ({ novel_id, title, aspect_ratio, target_words, chapter_range, request_id }) => {
      const id = Number(novel_id)
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('novel_id 必须是正整数')
      const result = await commitNovelImport(id, {
        title: typeof title === 'string' ? title : undefined,
        aspect_ratio: typeof aspect_ratio === 'string' ? aspect_ratio : undefined,
        target_words: target_words === undefined || target_words === null ? undefined : Number(target_words),
        chapter_nos: parseChapterRange(chapter_range),
        request_id: typeof request_id === 'string' ? request_id : undefined,
      })
      return {
        import_id: result.import_id,
        drama_id: result.drama_id,
        episode_count: result.episode_count,
        existing: result.existing,
      }
    },
  },
  {
    name: 'list_novels',
    description: '列出小说（分页/关键字/状态过滤），返回列表与分页信息。',
    inputSchema: obj({
      keyword: str('标题或主题关键字'),
      status: str('状态过滤（draft / writing / completed 等）'),
      page: int('页码，从 1 开始'),
      page_size: int('每页数量'),
    }),
    handler: ({ keyword, status, page, page_size }) => callApi('GET', '/api/v1/novels', {
      query: { keyword, status, page, page_size },
    }),
  },
  {
    name: 'get_novel',
    description: '读取小说详情：全量章节正文、解析后的章节大纲、已导入短剧记录。',
    inputSchema: obj({ novel_id: int('小说 ID') }, ['novel_id']),
    handler: ({ novel_id }) => callApi('GET', `/api/v1/novels/${Number(novel_id)}`),
  },
  {
    name: 'list_novel_jobs',
    description: '列出某小说的生成任务（可按 status 过滤），含进度、结果与错误。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      status: str('任务状态过滤（running / done / failed / cancelled / interrupted）'),
    }, ['novel_id']),
    handler: ({ novel_id, status }) => callApi('GET', `/api/v1/novels/${Number(novel_id)}/jobs`, {
      query: { status },
    }),
  },
  {
    name: 'get_novel_job',
    description: '读取单个小说生成任务（含 result / partial / error）。',
    inputSchema: obj({ job_id: int('任务 ID') }, ['job_id']),
    handler: ({ job_id }) => callApi('GET', `/api/v1/novel-jobs/${Number(job_id)}`),
  },
  {
    name: 'list_novel_imports',
    description: '列出小说的导入记录（含 has_update、上次同步时间与摘要）。',
    inputSchema: obj({ novel_id: int('小说 ID') }, ['novel_id']),
    handler: ({ novel_id }) => callApi('GET', `/api/v1/novels/${Number(novel_id)}/imports`),
  },
  {
    name: 'get_novel_graph',
    description: '读取小说灵感罗盘图谱（graph_data 与 chapter_graphs，不含正文）。',
    inputSchema: obj({ novel_id: int('小说 ID') }, ['novel_id']),
    handler: ({ novel_id }) => callApi('GET', `/api/v1/novels/${Number(novel_id)}/graph`),
  },
  {
    name: 'create_novel',
    description: '新建小说。genre 传题材数组；background 传故事背景；writing_style 传 {key,name,prompt} 文风快照；章节数与单章字数会被后端限制在合法范围。',
    inputSchema: obj({
      title: str('小说标题'),
      topic: str('主题/一句话梗概'),
      genre: { type: 'array', items: { type: 'string' }, description: '题材列表，如 ["悬疑","推理"]' },
      background: str('故事背景（可空）'),
      writing_style: {
        type: 'object',
        description: '文风快照 {key,name,prompt}（可空）',
        properties: { key: str('预设 key'), name: str('文风名称'), prompt: str('文风提示词') },
      },
      number_of_chapters: int('计划章节数'),
      word_number: int('单章目标字数'),
      user_guidance: str('创作指导'),
    }, ['title']),
    handler: args => callApi('POST', '/api/v1/novels', { body: args }),
  },
  {
    name: 'update_novel',
    description: '更新小说白名单字段：标题/主题/题材/背景/文风/章数字数/指导/架构五件套与生成标记。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      title: str('标题'),
      topic: str('主题'),
      genre: { type: 'array', items: { type: 'string' }, description: '题材列表' },
      background: str('故事背景'),
      writing_style: {
        type: 'object',
        description: '文风快照 {key,name,prompt}；传 null 清除',
        properties: { key: str('预设 key'), name: str('文风名称'), prompt: str('文风提示词') },
      },
      number_of_chapters: int('计划章节数'),
      word_number: int('单章目标字数'),
      user_guidance: str('创作指导'),
      core_seed: str('核心种子'),
      character_dynamics: str('角色动力学'),
      character_state: str('角色状态'),
      world_building: str('世界观'),
      plot_architecture: str('情节架构'),
      chapter_blueprint: str('章节大纲原文'),
      global_summary: str('全局摘要'),
      graph_meta: str('图谱元信息（JSON 字符串）'),
      architecture_generated: bool('架构是否已生成'),
      blueprint_generated: bool('大纲是否已生成'),
    }, ['novel_id']),
    handler: ({ novel_id, ...patch }) => callApi('PUT', `/api/v1/novels/${Number(novel_id)}`, { body: patch }),
  },
  {
    name: 'delete_novel',
    description: '软删小说；已导入的短剧保留，导入映射由后端标记 orphaned。',
    inputSchema: obj({ novel_id: int('小说 ID') }, ['novel_id']),
    handler: ({ novel_id }) => callApi('DELETE', `/api/v1/novels/${Number(novel_id)}`),
  },
  {
    name: 'save_novel_chapter',
    description: '保存章节标题/正文/状态。base_updated_at 传当前 updated_at 做乐观锁，冲突返回 409。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      chapter_no: int('章节号'),
      title: str('章节标题'),
      content: str('章节正文'),
      status: str('章节状态（draft / final 等）'),
      base_updated_at: str('保存前读到的 updated_at，用于冲突检测'),
    }, ['novel_id', 'chapter_no']),
    handler: ({ novel_id, chapter_no, ...body }) => callApi(
      'PUT',
      `/api/v1/novels/${Number(novel_id)}/chapters/${Number(chapter_no)}`,
      { body },
    ),
  },
  {
    name: 'delete_novel_import',
    description: '删除小说到短剧的导入映射，保留短剧与已有剧集。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      import_id: int('导入记录 ID'),
    }, ['novel_id', 'import_id']),
    handler: ({ novel_id, import_id }) => callApi(
      'DELETE',
      `/api/v1/novels/${Number(novel_id)}/imports/${Number(import_id)}`,
    ),
  },
  {
    name: 'generate_novel_architecture',
    description: '启动五步架构生成任务（coreSeed→characterDynamics→characterState→worldBuilding→plotArchitecture），返回 job_id，用任务工具轮询。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      force: bool('已有架构时强制重生成'),
    }, ['novel_id']),
    handler: ({ novel_id, force }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/architecture/generate`,
      { body: { force: Boolean(force) } },
    ),
  },
  {
    name: 'generate_novel_blueprint',
    description: '启动章节大纲生成任务（按章节数分块），返回 job_id，用任务工具轮询。',
    inputSchema: obj({ novel_id: int('小说 ID') }, ['novel_id']),
    handler: ({ novel_id }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/blueprint/generate`,
      { body: {} },
    ),
  },
  {
    name: 'generate_novel_chapter',
    description: '启动章节草稿生成任务。章节已有正文且 force=false 返回 409；content 可作为改写依据。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      chapter_no: int('章节号'),
      force: bool('已有正文时强制覆盖'),
      content: str('改写依据（可选）'),
    }, ['novel_id', 'chapter_no']),
    handler: ({ novel_id, chapter_no, force, content }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/chapters/${Number(chapter_no)}/generate`,
      { body: { force: Boolean(force), content } },
    ),
  },
  {
    name: 'finalize_novel_chapter',
    description: '启动章节定稿任务，返回 job_id；content 可传当前修改稿。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      chapter_no: int('章节号'),
      content: str('待定稿正文（可选）'),
    }, ['novel_id', 'chapter_no']),
    handler: ({ novel_id, chapter_no, content }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/chapters/${Number(chapter_no)}/finalize`,
      { body: { content } },
    ),
  },
  {
    name: 'enrich_novel_chapter',
    description: '启动章节扩写/润色任务，返回 job_id；word_number 为目标字数。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      chapter_no: int('章节号'),
      content: str('待扩写正文（可选）'),
      word_number: int('目标字数'),
    }, ['novel_id', 'chapter_no']),
    handler: ({ novel_id, chapter_no, content, word_number }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/chapters/${Number(chapter_no)}/enrich`,
      { body: { content, word_number } },
    ),
  },
  {
    name: 'cancel_novel_job',
    description: '取消小说生成任务；已结束任务原样返回。',
    inputSchema: obj({ job_id: int('任务 ID') }, ['job_id']),
    handler: ({ job_id }) => callApi('POST', `/api/v1/novel-jobs/${Number(job_id)}/cancel`),
  },
  {
    name: 'preview_novel_import',
    description: '导入前预览：按章节范围与拆集模式给出集数、标题与正文字数，不创建短剧。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      title: str('短剧标题'),
      style: str('风格预设 value'),
      aspect_ratio: str('画幅 16:9 或 9:16'),
      chapter_nos: intArray('章节号数组，留空导入全部'),
      split_mode: str('拆集模式：legacy / words / chapter'),
      target_words: int('每集目标字数（600-5000，仅 words 模式生效）'),
      include_draft: bool('是否包含草稿章节'),
      background_mode: str('背景生成模式：rule / ai / none'),
      auto_extract: bool('导入后自动提取角色'),
      auto_pipeline: bool('导入后自动入队（需开启队列）'),
    }, ['novel_id']),
    handler: ({ novel_id, ...input }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/imports/preview`,
      { body: input },
    ),
  },
  {
    name: 'preview_novel_sync',
    description: '预览小说到短剧的同步差异：new/updated/conflict/missing/unchanged 与冲突原因，不写库。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      import_id: int('导入记录 ID'),
    }, ['novel_id', 'import_id']),
    handler: ({ novel_id, import_id }) => callApi(
      'GET',
      `/api/v1/novels/${Number(novel_id)}/imports/${Number(import_id)}/preview`,
    ),
  },
  {
    name: 'sync_novel_import',
    description: '应用小说到短剧的同步；默认跳过冲突，overwrite_conflicts=true 时覆盖正文并标记 source_stale。',
    inputSchema: obj({
      novel_id: int('小说 ID'),
      import_id: int('导入记录 ID'),
      items: {
        type: 'array',
        description: '逐条动作（可省略，省略时按预览默认应用）',
        items: {
          type: 'object',
          properties: {
            chapter_no: int('章节号'),
            part_no: int('部分号，默认 1'),
            action: str('create / update / overwrite / recreate / skip / orphan'),
          },
          required: ['chapter_no', 'action'],
          additionalProperties: false,
        },
      },
      overwrite_conflicts: bool('是否覆盖冲突项'),
    }, ['novel_id', 'import_id']),
    handler: ({ novel_id, import_id, ...input }) => callApi(
      'POST',
      `/api/v1/novels/${Number(novel_id)}/imports/${Number(import_id)}/sync`,
      { body: input },
    ),
  },
  {
    name: 'list_api_endpoints',
    description: '列出后端全部 REST 端点（可按路径关键字过滤）。配合 api_request 调用未封装成工具的能力。',
    inputSchema: obj({ keyword: str('路径关键字，如 storyboards / ai-configs') }),
    handler: async ({ keyword }) => {
      const routes = (mainApp?.routes || [])
        .filter(route => route.path.startsWith('/api/v1/'))
        .filter(route => !route.path.startsWith('/api/v1/mcp'))
        .filter(route => !keyword || route.path.toLowerCase().includes(String(keyword).toLowerCase()))
        .map(route => ({ method: route.method, path: route.path }))
      const seen = new Set<string>()
      const endpoints = routes.filter(r => {
        const key = `${r.method} ${r.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return { total: endpoints.length, endpoints }
    },
  },
  {
    name: 'api_request',
    description: '直接调用任意后端 REST 接口（万能兜底）。path 必须以 /api/v1/ 开头；先用 list_api_endpoints 查路径。',
    inputSchema: obj({
      method: str('GET / POST / PUT / DELETE'),
      path: str('接口路径，如 /api/v1/dramas'),
      query: { type: 'object', description: '查询参数对象（可选）', additionalProperties: true },
      body: { type: 'object', description: 'JSON 请求体（可选）', additionalProperties: true },
    }, ['method', 'path']),
    handler: ({ method, path, query, body }) => {
      const verb = String(method || '').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(verb)) throw new Error('method 仅支持 GET/POST/PUT/DELETE')
      const target = String(path || '')
      if (!target.startsWith('/api/v1/')) throw new Error('path 必须以 /api/v1/ 开头')
      if (target.includes('..')) throw new Error('path 不合法')
      // 不允许模型改 MCP 自身配置（关服务 / 换 token 会把自己锁死）
      if (target === '/api/v1/mcp' || target.startsWith('/api/v1/mcp/')) {
        throw new Error('MCP 自身配置不通过 MCP 暴露，请到设置页操作')
      }
      return callApi(verb, target, { query, body })
    },
  },
]

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: any
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function negotiateProtocol(requested?: unknown): string {
  const value = typeof requested === 'string' ? requested : ''
  return MCP_PROTOCOL_VERSIONS.includes(value) ? value : MCP_LATEST_PROTOCOL
}

async function handleRpc(payload: RpcRequest): Promise<object | null> {
  const { id, method, params } = payload || {}
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: '火宝短剧本地 API。优先使用语义化工具；未封装的能力用 list_api_endpoints 查路径后用 api_request 调用。',
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    case 'tools/call': {
      const name = String(params?.name || '')
      const tool = TOOLS.find(t => t.name === name)
      if (!tool) return rpcError(id, -32602, `未知工具：${name}`)
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      try {
        const data = await tool.handler(args)
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2)
        return rpcResult(id, { content: [{ type: 'text', text }] })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `不支持的方法：${method || '(空)'}`)
  }
}

function extractToken(c: Context): string {
  const header = c.req.header('authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return c.req.query('token') || ''
}

async function mcpHandler(c: Context): Promise<Response> {
  if (c.req.method === 'GET') {
    return c.text('MCP endpoint. Send JSON-RPC via POST with Authorization: Bearer <token>.', 405, { Allow: 'POST' })
  }
  if (c.req.method === 'DELETE') return c.body(null, 200)

  const expected = getMcpToken()
  const provided = extractToken(c)
  if (!expected || !tokenEquals(provided, expected)) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权：缺少或错误的访问 token' } }, 401)
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求体不是合法 JSON' } }, 400)
  }

  const batch = Array.isArray(payload)
  const items = (batch ? payload : [payload]) as RpcRequest[]
  const results: object[] = []
  for (const item of items) {
    const result = await handleRpc(item)
    if (result) results.push(result)
  }

  if (!results.length) return c.body(null, 202)
  return c.json(batch ? results : results[0])
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

async function stopServer(): Promise<void> {
  const server = mcpServer
  mcpServer = null
  runningPort = null
  if (!server) return
  await new Promise<void>(resolve => {
    try { server.close(() => resolve()) } catch { resolve() }
  })
}

async function startServer(port: number): Promise<void> {
  await stopServer()
  const { Hono } = await import('hono')
  const app = new Hono()
  app.all('/', mcpHandler)
  app.all('/*', mcpHandler)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const server = serve({ fetch: app.fetch, port, hostname: mcpHost() }, info => {
      if (settled) return
      settled = true
      runningPort = info.port
      resolve()
    }) as unknown as ServerTypeLike
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      try { server.close() } catch { /* ignore */ }
      reject(new Error(error?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : String(error?.message || error)))
    })
    mcpServer = server
  })
}

export interface McpConfigPatch {
  enabled?: boolean
  port?: number | string
}

/** 应用配置：开/关/改端口；返回最新状态（启动失败时 error 带回原因） */
export async function applyMcpConfig(patch: McpConfigPatch): Promise<McpStatus> {
  lastError = null
  const currentPort = Number(readSetting(KEY_PORT)) || DEFAULT_MCP_PORT
  let port = currentPort
  if (patch.port !== undefined) port = normalizePort(patch.port)

  const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : readSetting(KEY_ENABLED) === '1'

  if (!enabled) {
    await stopServer()
    writeSetting(KEY_ENABLED, '0')
    if (patch.port !== undefined) writeSetting(KEY_PORT, String(port))
    return getMcpStatus()
  }

  const token = ensureToken()
  if (!token) throw new Error('生成访问 token 失败，请重试')

  try {
    await startServer(port)
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    writeSetting(KEY_ENABLED, '0')
    if (patch.port !== undefined) writeSetting(KEY_PORT, String(port))
    return getMcpStatus()
  }

  writeSetting(KEY_ENABLED, '1')
  writeSetting(KEY_PORT, String(port))
  return getMcpStatus()
}

/** 启动时按已保存配置恢复（失败只记录，不影响主服务） */
export async function initMcp(): Promise<void> {
  if (readSetting(KEY_ENABLED) !== '1') return
  try {
    const port = Number(readSetting(KEY_PORT)) || DEFAULT_MCP_PORT
    if (!getMcpToken()) return
    await startServer(port)
    console.log(`🔌 MCP server on http://${mcpHost()}:${port}/mcp (${TOOLS.length} tools)`)
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.warn('[mcp] 启动失败：', lastError)
  }
}

export function getMcpToolNames(): string[] {
  return TOOLS.map(t => t.name)
}
