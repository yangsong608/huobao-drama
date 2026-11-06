/**
 * 应用级全局设置（app_settings key-value 表）
 * AI 内容语言：所有 Agent 产出（剧本/提取/分镜/提示词）统一使用的目标语言
 * 层次约束：本模块只依赖 db，严禁反向 import agents/*（agents/context.ts 会引用本模块）
 *
 * 注意：刻意做成同步 API（better-sqlite3 驱动的 .get()/.run()），
 * 供 agents/context.ts 的同步 buildAgentRequestContext 内部直接调用
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  MEDIA_FFMPEG_DIR_KEY,
  MediaPathValidationError,
  normalizeFfmpegDir,
} from '../utils/media-paths.js'

export const CONTENT_LANGUAGES = ['zh', 'en', 'ja', 'ko'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]

const CONTENT_LANGUAGE_KEY = 'content_language'

function isContentLanguage(v: unknown): v is ContentLanguage {
  return typeof v === 'string' && (CONTENT_LANGUAGES as readonly string[]).includes(v)
}

/** 读取全局内容语言；未设置或值非法时回退 'zh'（保持历史默认行为） */
export function getContentLanguage(): ContentLanguage {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONTENT_LANGUAGE_KEY))
    .get()
  return isContentLanguage(row?.value) ? row.value : 'zh'
}

/** 写入全局内容语言（upsert） */
export function setContentLanguage(lang: ContentLanguage): ContentLanguage {
  if (!isContentLanguage(lang)) throw new Error(`Invalid content language: ${lang}`)
  db.insert(schema.appSettings)
    .values({ key: CONTENT_LANGUAGE_KEY, value: lang, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: lang, updatedAt: now() },
    })
    .run()
  return lang
}

const TOURS_SEEN_KEY = 'tours_seen'
const MAX_TOURS_SEEN = 64

function sanitizeTourIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter(v => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, MAX_TOURS_SEEN)
}

/** 已看过的引导漫游 id 列表（JSON 数组存储）；桌面端端口随启动变化，localStorage 不可靠，故落库 */
export function getToursSeen(): string[] {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, TOURS_SEEN_KEY))
    .get()
  try { return sanitizeTourIds(JSON.parse(row?.value || '[]')) } catch { return [] }
}

/** 写入已看过的引导漫游 id 列表（upsert） */
export function setToursSeen(ids: unknown): string[] {
  const clean = sanitizeTourIds(ids)
  const value = JSON.stringify(clean)
  db.insert(schema.appSettings)
    .values({ key: TOURS_SEEN_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}

const DUBBING_ENABLED_KEY = 'dubbing.enabled'

/**
 * 配音功能开关：
 * - 显式设置过就按设置值走；
 * - 未设置时，只要存在启用的 audio 服务就视为开启（配好语音即可用，V1 无语音服务时仍关闭）。
 */
export function isDubbingEnabled(): boolean {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, DUBBING_ENABLED_KEY))
    .get()
  if (row) return row.value === '1' || row.value === 'true'
  return db.select({ id: schema.aiServiceConfigs.id, type: schema.aiServiceConfigs.serviceType, active: schema.aiServiceConfigs.isActive })
    .from(schema.aiServiceConfigs)
    .all()
    .some((r) => r.type === 'audio' && r.active)
}

/** 显式开关（设置页「配音」） */
export function setDubbingEnabled(enabled: boolean): boolean {
  const value = enabled ? '1' : '0'
  db.insert(schema.appSettings)
    .values({ key: DUBBING_ENABLED_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now() } })
    .run()
  return enabled
}

export const EDIT_WORKSPACE_MODES = ['off', 'readonly', 'on'] as const
export type EditWorkspaceMode = typeof EDIT_WORKSPACE_MODES[number]

const EDIT_WORKSPACE_KEY = 'edit_workspace'

function isEditWorkspaceMode(value: unknown): value is EditWorkspaceMode {
  return typeof value === 'string' && (EDIT_WORKSPACE_MODES as readonly string[]).includes(value)
}

/**
 * 剪辑工作台开关：环境变量 EDIT_WORKSPACE 优先（仅调试/紧急回滚），
 * 其次 app_settings，未设置时默认 readonly，保证 M1 不会写入任何计划。
 */
export function getEditWorkspaceMode(): EditWorkspaceMode {
  const fromEnv = String(process.env.EDIT_WORKSPACE || '').trim().toLowerCase()
  if (isEditWorkspaceMode(fromEnv)) return fromEnv
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, EDIT_WORKSPACE_KEY))
    .get()
  return isEditWorkspaceMode(row?.value) ? row.value : 'readonly'
}

export function setEditWorkspaceMode(mode: EditWorkspaceMode): EditWorkspaceMode {
  if (!isEditWorkspaceMode(mode)) throw new Error(`Invalid edit workspace mode: ${mode}`)
  db.insert(schema.appSettings)
    .values({ key: EDIT_WORKSPACE_KEY, value: mode, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: mode, updatedAt: now() },
    })
    .run()
  return mode
}

// ---------------------------------------------------------------------------
// 队列开关（V2 · M5）
// ---------------------------------------------------------------------------

const QUEUE_ENABLED_KEY = 'queue.enabled'
const QUEUE_MAX_CONCURRENT_KEY = 'queue.maxConcurrent'

/** 任务队列默认关闭：关闭时自动化仍走原内存路径，行为与 V1 一致 */
export function isQueueEnabled(): boolean {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, QUEUE_ENABLED_KEY)).get()
  return row?.value === '1' || row?.value === 'true'
}

export function setQueueEnabled(enabled: boolean): boolean {
  const value = enabled ? '1' : '0'
  db.insert(schema.appSettings)
    .values({ key: QUEUE_ENABLED_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now() } })
    .run()
  return enabled
}

export function getQueueConcurrency(): number {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, QUEUE_MAX_CONCURRENT_KEY)).get()
  const n = Number(row?.value)
  return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 1
}

export function setQueueConcurrency(n: number): number {
  const value = String(Math.max(1, Math.min(4, Math.round(n))))
  db.insert(schema.appSettings)
    .values({ key: QUEUE_MAX_CONCURRENT_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now() } })
    .run()
  return Number(value)
}

// ---------------------------------------------------------------------------
// 配音默认值（V2 · 设置「配音」）
// ---------------------------------------------------------------------------

export const DUBBING_SUBTITLE_MODES = ['soft', 'burn', 'none'] as const
export const DUBBING_ORIGINAL_AUDIO_MODES = ['duck', 'keep', 'mute'] as const
export const DUBBING_VOICE_LANGUAGES = ['', 'zh', 'en', 'ja', 'ko'] as const
/** 视频声音策略：auto 按模型 / native 保留原生 / ambient 只要环境声 / silent 关闭原声 */
export const VIDEO_AUDIO_MODES = ['auto', 'native', 'ambient', 'silent'] as const

export type DubbingSubtitleMode = typeof DUBBING_SUBTITLE_MODES[number]
export type DubbingOriginalAudio = typeof DUBBING_ORIGINAL_AUDIO_MODES[number]
export type DubbingVoiceLanguage = typeof DUBBING_VOICE_LANGUAGES[number]
export type VideoAudioMode = typeof VIDEO_AUDIO_MODES[number]

export interface DubbingDefaults {
  subtitleMode: DubbingSubtitleMode
  /** 烧录字号；null = 按画幅自动（9:16 54 / 16:9 46） */
  subtitleFontSize: number | null
  /** 烧录底边距；null = 按画幅自动（9:16 260 / 16:9 90） */
  subtitleMargin: number | null
  /** 旁白/心声字幕加前缀 */
  narratorPrefix: boolean
  originalAudio: DubbingOriginalAudio
  /** 原声压低强度，对应 sidechaincompress ratio（越大压得越狠） */
  duckingRatio: number
  targetLufs: number
  bgmVolume: number
  /** 素材阶段自动生成声音提示词 */
  autoPromptVoices: boolean
  /** 生成后自动合成试听 */
  autoPreviewVoices: boolean
  /** 默认语言：空 = 跟随语音服务配置 */
  voiceLanguage: DubbingVoiceLanguage
  voiceSpeed: number
  /** 新建剧集默认勾选自动配音 */
  autoDubForNewEpisodes: boolean
  /** 新建剧集默认视频声音策略（原生音频 vs 后期 TTS 的边界） */
  videoAudioModeForNewEpisodes: VideoAudioMode
}

const DUBBING_DEFAULTS_KEY = 'dubbing.defaults'

export const DUBBING_DEFAULTS: DubbingDefaults = {
  subtitleMode: 'soft',
  subtitleFontSize: null,
  subtitleMargin: null,
  narratorPrefix: false,
  originalAudio: 'duck',
  duckingRatio: 6,
  targetLufs: -16,
  bgmVolume: 0.18,
  autoPromptVoices: true,
  autoPreviewVoices: false,
  voiceLanguage: '',
  voiceSpeed: 1,
  autoDubForNewEpisodes: false,
  videoAudioModeForNewEpisodes: 'auto',
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.round(n)))
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : fallback
}

/** 非法字段逐项回退默认值，避免前端/手改配置把混音参数写坏 */
export function sanitizeDubbingDefaults(raw: unknown): DubbingDefaults {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    subtitleMode: oneOf(input.subtitleMode, DUBBING_SUBTITLE_MODES, DUBBING_DEFAULTS.subtitleMode),
    subtitleFontSize: optionalNumber(input.subtitleFontSize, 16, 120),
    subtitleMargin: optionalNumber(input.subtitleMargin, 0, 600),
    narratorPrefix: boolOr(input.narratorPrefix, DUBBING_DEFAULTS.narratorPrefix),
    originalAudio: oneOf(input.originalAudio, DUBBING_ORIGINAL_AUDIO_MODES, DUBBING_DEFAULTS.originalAudio),
    duckingRatio: clampNumber(input.duckingRatio, 1, 20, DUBBING_DEFAULTS.duckingRatio),
    targetLufs: clampNumber(input.targetLufs, -30, -8, DUBBING_DEFAULTS.targetLufs),
    bgmVolume: clampNumber(input.bgmVolume, 0, 1, DUBBING_DEFAULTS.bgmVolume),
    autoPromptVoices: boolOr(input.autoPromptVoices, DUBBING_DEFAULTS.autoPromptVoices),
    autoPreviewVoices: boolOr(input.autoPreviewVoices, DUBBING_DEFAULTS.autoPreviewVoices),
    voiceLanguage: oneOf(input.voiceLanguage, DUBBING_VOICE_LANGUAGES, DUBBING_DEFAULTS.voiceLanguage),
    voiceSpeed: clampNumber(input.voiceSpeed, 0.5, 1.5, DUBBING_DEFAULTS.voiceSpeed),
    autoDubForNewEpisodes: boolOr(input.autoDubForNewEpisodes, DUBBING_DEFAULTS.autoDubForNewEpisodes),
    videoAudioModeForNewEpisodes: oneOf(input.videoAudioModeForNewEpisodes, VIDEO_AUDIO_MODES, DUBBING_DEFAULTS.videoAudioModeForNewEpisodes),
  }
}

export function getDubbingDefaults(): DubbingDefaults {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, DUBBING_DEFAULTS_KEY))
    .get()
  try {
    return sanitizeDubbingDefaults(JSON.parse(row?.value || '{}'))
  } catch {
    return { ...DUBBING_DEFAULTS }
  }
}

/** 部分更新：只覆盖传入字段，读写时都做同样的钳制 */
export function setDubbingDefaults(patch: unknown): DubbingDefaults {
  const current = getDubbingDefaults()
  const input = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
  const next = sanitizeDubbingDefaults({ ...current, ...input })
  const value = JSON.stringify(next)
  db.insert(schema.appSettings)
    .values({ key: DUBBING_DEFAULTS_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now() } })
    .run()
  return next
}

const TTS_LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
}

/** 设置页语言代码 → 语音服务 language 字段 */
export function ttsLanguageOf(code: string | null | undefined): string | undefined {
  return TTS_LANGUAGE_NAMES[code || ''] || undefined
}

// ---------------------------------------------------------------------------
// 小说设置（V3 · flat novel.* keys，见设计 §8.6）
// ---------------------------------------------------------------------------

export const NOVEL_STAGE_KEYS = ['architecture', 'blueprint', 'chapter', 'finalize', 'enrich', 'compass'] as const
export type NovelStageKey = typeof NOVEL_STAGE_KEYS[number]
export const NOVEL_ASPECT_RATIOS = ['16:9', '9:16'] as const
export type NovelAspectRatio = typeof NOVEL_ASPECT_RATIOS[number]

export interface NovelWritingStylePreset {
  key: string
  name: string
  prompt: string
}

export interface NovelSettings {
  textConfigId: number | null
  stageModels: Partial<Record<NovelStageKey, number>>
  temperature: number
  maxTokens: number
  timeout: number
  autosaveMs: number
  importTargetWords: number
  importIncludeDraft: boolean
  importAutoExtract: boolean
  defaultAspectRatio: NovelAspectRatio
  promptVersion: string
  writingStyles: NovelWritingStylePreset[]
  defaultWritingStyleKey: string
}

export class NovelSettingsValidationError extends Error {}

const NOVEL_KEY_PREFIX = 'novel.'
const WRITING_STYLE_LIMIT = 30
const WRITING_STYLE_PROMPT_MAX = 4000

export const NOVEL_WRITING_STYLE_DEFAULTS: NovelWritingStylePreset[] = [
  {
    key: 'realism',
    name: '现实质感',
    prompt: '以克制的白描和生活化细节推进叙事，少用形容词堆砌，让情绪从动作、对话与环境细节中自然浮现；对白口语化，人物各有说话习惯。',
  },
  {
    key: 'suspense',
    name: '悬疑冷峻',
    prompt: '多用短句与留白制造压迫感，控制信息差，让读者比角色更早或更晚知道关键事实；环境描写服务于氛围与线索，避免直白解释。',
  },
  {
    key: 'classical',
    name: '古风典雅',
    prompt: '语言半文半白、凝练含蓄，讲究意象与对仗，称谓、器物、礼制符合古代背景；叙述节奏舒缓，情感表达克制而有余韵。',
  },
  {
    key: 'humor',
    name: '轻松诙谐',
    prompt: '语感轻快，善用反差、吐槽与误会制造笑点，对白机锋自然；即使推进矛盾也保持阅读愉悦度，避免沉重压抑的描写。',
  },
  {
    key: 'cinematic',
    name: '电影感',
    prompt: '按镜头调度组织场景：远景交代空间、中景推进动作、近景捕捉表情与细节；重视画面构图、声音与光线，段落衔接有剪辑感。',
  },
  {
    key: 'webnovel',
    name: '网文爽感',
    prompt: '开篇快速建立钩子，每章至少一次情绪释放或信息反转，节奏明快、少闲笔；主角行动果断，冲突升级清晰，章末留悬念。',
  },
]

function slugWritingStyleKey(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const slug = raw.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return slug || fallback
}

/** 预设来自设置页（可增删改）；缺省回落内置预设，显式传空数组表示全部删除 */
function parseWritingStyles(value: unknown): NovelWritingStylePreset[] {
  if (value === null || value === undefined || value === '') {
    return NOVEL_WRITING_STYLE_DEFAULTS.map((item) => ({ ...item }))
  }
  let list: unknown = value
  if (typeof value === 'string') {
    try { list = JSON.parse(value) } catch { return NOVEL_WRITING_STYLE_DEFAULTS.map((item) => ({ ...item })) }
  }
  if (!Array.isArray(list)) return NOVEL_WRITING_STYLE_DEFAULTS.map((item) => ({ ...item }))

  const result: NovelWritingStylePreset[] = []
  const seen = new Set<string>()
  list.slice(0, WRITING_STYLE_LIMIT).forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const record = item as Record<string, unknown>
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim().slice(0, WRITING_STYLE_PROMPT_MAX) : ''
    if (!prompt) return
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : ''
    const baseKey = slugWritingStyleKey(record.key, `style-${index + 1}`)
    let key = baseKey
    let suffix = 2
    while (seen.has(key)) {
      key = `${baseKey}-${suffix}`
      suffix += 1
    }
    seen.add(key)
    result.push({ key, name: name || key, prompt })
  })
  return result
}

function parseDefaultWritingStyleKey(value: unknown, styles: NovelWritingStylePreset[]): string {
  const key = typeof value === 'string' ? value.trim().slice(0, 80) : ''
  return styles.some((style) => style.key === key) ? key : ''
}

export const NOVEL_SETTINGS_DEFAULTS: NovelSettings = {
  textConfigId: null,
  stageModels: {},
  temperature: 0.7,
  maxTokens: 8192,
  timeout: 600,
  autosaveMs: 1500,
  importTargetWords: 1200,
  importIncludeDraft: true,
  importAutoExtract: false,
  defaultAspectRatio: '16:9',
  promptVersion: '1.0.0',
  writingStyles: NOVEL_WRITING_STYLE_DEFAULTS,
  defaultWritingStyleKey: '',
}

function novelNumber(value: unknown, min: number, max: number, fallback: number, integer = true): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const bounded = Math.max(min, Math.min(max, n))
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100
}

function novelFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return fallback
}

function novelTextConfigId(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 只保留已知阶段与正整数模型 id；传入非法类型返回 null 交给调用方报错 */
function parseNovelStageModels(value: unknown): Partial<Record<NovelStageKey, number>> | null {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const result: Partial<Record<NovelStageKey, number>> = {}
  for (const key of NOVEL_STAGE_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    if (raw === null || raw === undefined || raw === '') continue
    const n = Number(raw)
    if (Number.isSafeInteger(n) && n > 0) result[key] = n
  }
  return result
}

export function sanitizeNovelSettings(raw: unknown): NovelSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const stageModels = parseNovelStageModels(input.stageModels)
  const promptVersion = typeof input.promptVersion === 'string' ? input.promptVersion.trim().slice(0, 40) : ''
  const writingStyles = parseWritingStyles(input.writingStyles)
  return {
    textConfigId: novelTextConfigId(input.textConfigId),
    stageModels: stageModels ?? {},
    temperature: novelNumber(input.temperature, 0, 2, NOVEL_SETTINGS_DEFAULTS.temperature, false),
    maxTokens: novelNumber(input.maxTokens, 256, 32768, NOVEL_SETTINGS_DEFAULTS.maxTokens),
    timeout: novelNumber(input.timeout, 30, 3600, NOVEL_SETTINGS_DEFAULTS.timeout),
    autosaveMs: novelNumber(input.autosaveMs, 300, 10000, NOVEL_SETTINGS_DEFAULTS.autosaveMs),
    importTargetWords: novelNumber(input.importTargetWords, 600, 5000, NOVEL_SETTINGS_DEFAULTS.importTargetWords),
    importIncludeDraft: novelFlag(input.importIncludeDraft, NOVEL_SETTINGS_DEFAULTS.importIncludeDraft),
    importAutoExtract: novelFlag(input.importAutoExtract, NOVEL_SETTINGS_DEFAULTS.importAutoExtract),
    defaultAspectRatio: (NOVEL_ASPECT_RATIOS as readonly string[]).includes(String(input.defaultAspectRatio))
      ? input.defaultAspectRatio as NovelAspectRatio
      : NOVEL_SETTINGS_DEFAULTS.defaultAspectRatio,
    promptVersion: promptVersion || NOVEL_SETTINGS_DEFAULTS.promptVersion,
    writingStyles,
    defaultWritingStyleKey: parseDefaultWritingStyleKey(input.defaultWritingStyleKey, writingStyles),
  }
}

function readNovelSettingsRaw(): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  const rows = db.select().from(schema.appSettings).all()
  for (const row of rows) {
    if (!row.key.startsWith(NOVEL_KEY_PREFIX)) continue
    raw[row.key.slice(NOVEL_KEY_PREFIX.length)] = row.value
  }
  return raw
}

export function getNovelSettings(): NovelSettings {
  const raw = readNovelSettingsRaw()
  if (raw.stageModels) {
    try { raw.stageModels = JSON.parse(String(raw.stageModels)) } catch { raw.stageModels = {} }
  }
  return sanitizeNovelSettings(raw)
}

/** 部分更新：stageModels 递归合并，其余字段覆盖；非法类型抛 NovelSettingsValidationError */
export function setNovelSettings(patch: unknown): NovelSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new NovelSettingsValidationError('请求体必须是对象')
  }
  const input = patch as Record<string, unknown>
  const current = getNovelSettings()

  let stageModels = current.stageModels
  if ('stageModels' in input) {
    const parsed = parseNovelStageModels(input.stageModels)
    if (parsed === null) throw new NovelSettingsValidationError('stageModels 必须是对象')
    stageModels = { ...current.stageModels, ...parsed }
  }

  const next = sanitizeNovelSettings({
    ...current,
    ...input,
    stageModels,
  })

  const serialized: Record<string, string> = {
    textConfigId: next.textConfigId === null ? '' : String(next.textConfigId),
    stageModels: JSON.stringify(next.stageModels),
    temperature: String(next.temperature),
    maxTokens: String(next.maxTokens),
    timeout: String(next.timeout),
    autosaveMs: String(next.autosaveMs),
    importTargetWords: String(next.importTargetWords),
    importIncludeDraft: next.importIncludeDraft ? '1' : '0',
    importAutoExtract: next.importAutoExtract ? '1' : '0',
    defaultAspectRatio: next.defaultAspectRatio,
    promptVersion: next.promptVersion,
    writingStyles: JSON.stringify(next.writingStyles),
    defaultWritingStyleKey: next.defaultWritingStyleKey,
  }
  const ts = now()
  for (const [field, value] of Object.entries(serialized)) {
    const key = `${NOVEL_KEY_PREFIX}${field}`
    db.insert(schema.appSettings)
      .values({ key, value, updatedAt: ts })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: ts } })
      .run()
  }
  return next
}

// ---------------------------------------------------------------------------
// 媒体工具（设置「通用 → 媒体工具」）
// ---------------------------------------------------------------------------

export interface MediaSettings {
  /** 自定义 FFmpeg 目录；空 = 自动（环境变量 / 内置 / PATH） */
  ffmpegDir: string
}

export function getMediaSettings(): MediaSettings {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, MEDIA_FFMPEG_DIR_KEY))
    .get()
  try {
    return { ffmpegDir: normalizeFfmpegDir(row?.value ?? '') }
  } catch {
    return { ffmpegDir: '' }
  }
}

/** 部分更新；非法类型/相对路径抛 MediaPathValidationError，由路由转 400 */
export function setMediaSettings(patch: unknown): MediaSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new MediaPathValidationError('请求体必须是对象')
  }
  const input = patch as Record<string, unknown>
  if (!('ffmpegDir' in input)) return getMediaSettings()
  const ffmpegDir = normalizeFfmpegDir(input.ffmpegDir)
  db.insert(schema.appSettings)
    .values({ key: MEDIA_FFMPEG_DIR_KEY, value: ffmpegDir, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: ffmpegDir, updatedAt: now() },
    })
    .run()
  return { ffmpegDir }
}
