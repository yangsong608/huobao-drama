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
export const NOVEL_WORKBENCH_LAYOUTS = ['tabs', 'split'] as const
export type NovelWorkbenchLayout = typeof NOVEL_WORKBENCH_LAYOUTS[number]

export interface NovelWritingStylePreset {
  key: string
  name: string
  prompt: string
}

export interface NovelWorkbenchSettings {
  layout: NovelWorkbenchLayout
  tree: boolean
}

export interface NovelAnnotationSettings {
  enabled: boolean
  anchorWindow: number
}

export interface NovelForeshadowSettings {
  enabled: boolean
  autoExtract: boolean
}

export interface NovelContextPackSettings {
  enabled: boolean
  includeAnnotations: boolean
  includeUnresolved: boolean
  maxChars: number
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
  workbench: NovelWorkbenchSettings
  annotations: NovelAnnotationSettings
  foreshadow: NovelForeshadowSettings
  contextPack: NovelContextPackSettings
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
  workbench: { layout: 'split', tree: true },
  annotations: { enabled: true, anchorWindow: 200 },
  foreshadow: { enabled: true, autoExtract: false },
  contextPack: { enabled: true, includeAnnotations: true, includeUnresolved: true, maxChars: 4000 },
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

/** 分组键同时兼容嵌套对象与落库后的 `group.key` 扁平键，嵌套优先 */
function novelGroupInput(input: Record<string, unknown>, group: string): Record<string, unknown> {
  const dotted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith(`${group}.`)) dotted[key.slice(group.length + 1)] = value
  }
  const nested = input[group]
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? { ...dotted, ...nested as Record<string, unknown> }
    : dotted
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
  const workbench = novelGroupInput(input, 'workbench')
  const annotations = novelGroupInput(input, 'annotations')
  const foreshadow = novelGroupInput(input, 'foreshadow')
  const contextPack = novelGroupInput(input, 'contextPack')
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
    workbench: {
      layout: (NOVEL_WORKBENCH_LAYOUTS as readonly string[]).includes(String(workbench.layout))
        ? workbench.layout as NovelWorkbenchLayout
        : NOVEL_SETTINGS_DEFAULTS.workbench.layout,
      tree: novelFlag(workbench.tree, NOVEL_SETTINGS_DEFAULTS.workbench.tree),
    },
    annotations: {
      enabled: novelFlag(annotations.enabled, NOVEL_SETTINGS_DEFAULTS.annotations.enabled),
      anchorWindow: novelNumber(annotations.anchorWindow, 20, 1000, NOVEL_SETTINGS_DEFAULTS.annotations.anchorWindow),
    },
    foreshadow: {
      enabled: novelFlag(foreshadow.enabled, NOVEL_SETTINGS_DEFAULTS.foreshadow.enabled),
      autoExtract: novelFlag(foreshadow.autoExtract, NOVEL_SETTINGS_DEFAULTS.foreshadow.autoExtract),
    },
    contextPack: {
      enabled: novelFlag(contextPack.enabled, NOVEL_SETTINGS_DEFAULTS.contextPack.enabled),
      includeAnnotations: novelFlag(contextPack.includeAnnotations, NOVEL_SETTINGS_DEFAULTS.contextPack.includeAnnotations),
      includeUnresolved: novelFlag(contextPack.includeUnresolved, NOVEL_SETTINGS_DEFAULTS.contextPack.includeUnresolved),
      maxChars: novelNumber(contextPack.maxChars, 500, 20000, NOVEL_SETTINGS_DEFAULTS.contextPack.maxChars),
    },
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

/** 只读落库值，不含环境变量覆盖；作为部分更新的合并基线，避免把覆盖值写回库里 */
function readPersistedNovelSettings(): NovelSettings {
  const raw = readNovelSettingsRaw()
  if (raw.stageModels) {
    try { raw.stageModels = JSON.parse(String(raw.stageModels)) } catch { raw.stageModels = {} }
  }
  return sanitizeNovelSettings(raw)
}

export function getNovelSettings(): NovelSettings {
  const persisted = readPersistedNovelSettings()
  const envLayout = envEnum('NOVEL_WORKBENCH_LAYOUT', NOVEL_WORKBENCH_LAYOUTS)
  const annotationsOff = envBoolOff('NOVEL_ANNOTATIONS')
  const foreshadowOff = envBoolOff('NOVEL_FORESHADOW')
  const contextPackOff = envBoolOff('NOVEL_CONTEXT_PACK')
  return {
    ...persisted,
    workbench: { ...persisted.workbench, ...(envLayout ? { layout: envLayout } : {}) },
    annotations: { ...persisted.annotations, ...(annotationsOff === false ? { enabled: false } : {}) },
    foreshadow: { ...persisted.foreshadow, ...(foreshadowOff === false ? { enabled: false } : {}) },
    contextPack: { ...persisted.contextPack, ...(contextPackOff === false ? { enabled: false } : {}) },
  }
}

/** 部分更新：stageModels 与四个分组对象按层合并，其余字段覆盖；非法类型抛 NovelSettingsValidationError */
export function setNovelSettings(patch: unknown): NovelSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new NovelSettingsValidationError('请求体必须是对象')
  }
  const input = patch as Record<string, unknown>
  const current = readPersistedNovelSettings()

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
    workbench: { ...current.workbench, ...sub(input.workbench) },
    annotations: { ...current.annotations, ...sub(input.annotations) },
    foreshadow: { ...current.foreshadow, ...sub(input.foreshadow) },
    contextPack: { ...current.contextPack, ...sub(input.contextPack) },
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
    'workbench.layout': next.workbench.layout,
    'workbench.tree': next.workbench.tree ? '1' : '0',
    'annotations.enabled': next.annotations.enabled ? '1' : '0',
    'annotations.anchorWindow': String(next.annotations.anchorWindow),
    'foreshadow.enabled': next.foreshadow.enabled ? '1' : '0',
    'foreshadow.autoExtract': next.foreshadow.autoExtract ? '1' : '0',
    'contextPack.enabled': next.contextPack.enabled ? '1' : '0',
    'contextPack.includeAnnotations': next.contextPack.includeAnnotations ? '1' : '0',
    'contextPack.includeUnresolved': next.contextPack.includeUnresolved ? '1' : '0',
    'contextPack.maxChars': String(next.contextPack.maxChars),
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

// ---------------------------------------------------------------------------
// B0 基础层四命名空间（ui / director / edit / agent）
// 每个命名空间整体存为一个 JSON 值；读取时叠加环境变量覆盖，环境变量值永不落库。
// ---------------------------------------------------------------------------

export class FoundationSettingsValidationError extends Error {}

/** 布尔：接受 true/false/1/0/on/off，其余回退默认 */
function foundationBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return fallback
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'on'].includes(v)) return true
    if (['false', '0', 'off'].includes(v)) return false
  }
  return fallback
}

function foundationNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function foundationEnum<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : fallback
}

function envBoolOff(name: string): boolean | null {
  const v = String(process.env[name] || '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return false
  if (v === 'on' || v === '1' || v === 'true') return true
  return null
}

function envEnum<T extends string>(name: string, list: readonly T[]): T | null {
  const v = String(process.env[name] || '').trim()
  return (list as readonly string[]).includes(v) ? v as T : null
}

function readNamespaceJson(key: string): Record<string, unknown> {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get()
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeNamespaceJson(key: string, value: unknown): void {
  db.insert(schema.appSettings)
    .values({ key, value: JSON.stringify(value), updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(value), updatedAt: now() },
    })
    .run()
}

function assertObjectBody(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new FoundationSettingsValidationError('请求体必须是对象')
  }
  return patch as Record<string, unknown>
}

// --- ui.*（6 键，页面视觉规格 §7） ---

export const UI_DENSITY_MODES = ['compact', 'comfortable'] as const
export const UI_MOTION_MODES = ['system', 'full', 'reduced'] as const
export const UI_READING_FONTS = ['serif', 'sans'] as const

export interface UiSettings {
  defaults: {
    density: typeof UI_DENSITY_MODES[number]
    motion: typeof UI_MOTION_MODES[number]
    readingFont: typeof UI_READING_FONTS[number]
    readingSize: number
    actionLabels: boolean
  }
  allowUserOverride: boolean
}

export const UI_SETTINGS_DEFAULTS: UiSettings = {
  defaults: {
    density: 'compact',
    motion: 'system',
    readingFont: 'serif',
    readingSize: 16,
    actionLabels: true,
  },
  allowUserOverride: true,
}

const UI_SETTINGS_KEY = 'ui.settings'

export function sanitizeUiSettings(raw: unknown): UiSettings {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const defaults = (input.defaults && typeof input.defaults === 'object' && !Array.isArray(input.defaults)
    ? input.defaults
    : {}) as Record<string, unknown>
  return {
    defaults: {
      density: foundationEnum(defaults.density, UI_DENSITY_MODES, UI_SETTINGS_DEFAULTS.defaults.density),
      motion: foundationEnum(defaults.motion, UI_MOTION_MODES, UI_SETTINGS_DEFAULTS.defaults.motion),
      readingFont: foundationEnum(defaults.readingFont, UI_READING_FONTS, UI_SETTINGS_DEFAULTS.defaults.readingFont),
      readingSize: foundationNumber(defaults.readingSize, 15, 18, UI_SETTINGS_DEFAULTS.defaults.readingSize),
      actionLabels: foundationBool(defaults.actionLabels, UI_SETTINGS_DEFAULTS.defaults.actionLabels),
    },
    allowUserOverride: foundationBool(input.allowUserOverride, UI_SETTINGS_DEFAULTS.allowUserOverride),
  }
}

export function getUiSettings(): UiSettings {
  const next = sanitizeUiSettings(readNamespaceJson(UI_SETTINGS_KEY))
  const envDensity = envEnum('UI_DEFAULTS_DENSITY', UI_DENSITY_MODES)
  const envMotion = envEnum('UI_DEFAULTS_MOTION', UI_MOTION_MODES)
  const envFont = envEnum('UI_DEFAULTS_READING_FONT', UI_READING_FONTS)
  const envSizeRaw = Number(process.env.UI_DEFAULTS_READING_SIZE)
  const envLabels = envBoolOff('UI_DEFAULTS_ACTION_LABELS')
  const envOverride = envBoolOff('UI_ALLOW_USER_OVERRIDE')
  return {
    defaults: {
      density: envDensity ?? next.defaults.density,
      motion: envMotion ?? next.defaults.motion,
      readingFont: envFont ?? next.defaults.readingFont,
      readingSize: Number.isFinite(envSizeRaw) && envSizeRaw >= 15 && envSizeRaw <= 18
        ? Math.round(envSizeRaw)
        : next.defaults.readingSize,
      actionLabels: envLabels ?? next.defaults.actionLabels,
    },
    allowUserOverride: envOverride ?? next.allowUserOverride,
  }
}

export function setUiSettings(patch: unknown): UiSettings {
  const input = assertObjectBody(patch)
  // 合并基线用落库态（不含环境变量覆盖），避免环境变量值经保存写入数据库
  const current = sanitizeUiSettings(readNamespaceJson(UI_SETTINGS_KEY))
  const next = sanitizeUiSettings({
    allowUserOverride: 'allowUserOverride' in input ? input.allowUserOverride : current.allowUserOverride,
    defaults: {
      ...current.defaults,
      ...(input.defaults && typeof input.defaults === 'object' && !Array.isArray(input.defaults)
        ? input.defaults
        : {}),
    },
  })
  writeNamespaceJson(UI_SETTINGS_KEY, next)
  return getUiSettings()
}

// --- director.*（11 键，导演台规格 §7） ---

export const DIRECTOR_MODES = ['off', 'readonly', 'on'] as const
export const DIRECTOR_VIEW_DEFAULTS = ['2d', '3d'] as const
export const DIRECTOR_APPLY_FIELDS = ['shot_type', 'angle', 'movement', 'duration'] as const
export const DIRECTOR_FPS_VALUES = ['24', '25', '30'] as const

export interface DirectorSettings {
  mode: typeof DIRECTOR_MODES[number]
  view: { default: typeof DIRECTOR_VIEW_DEFAULTS[number] }
  view3d: { enabled: boolean }
  apply: {
    fields: (typeof DIRECTOR_APPLY_FIELDS)[number][]
    promptAppend: boolean
    subshotSync: boolean
  }
  duration: { min: number; max: number; fps: string }
  stage: { maxShots: number }
  previs: { maxAssets: number }
}

export const DIRECTOR_SETTINGS_DEFAULTS: DirectorSettings = {
  mode: 'off',
  view: { default: '2d' },
  view3d: { enabled: true },
  apply: { fields: [...DIRECTOR_APPLY_FIELDS], promptAppend: false, subshotSync: false },
  duration: { min: 8, max: 15, fps: '24' },
  stage: { maxShots: 200 },
  previs: { maxAssets: 20 },
}

const DIRECTOR_SETTINGS_KEY = 'director.settings'

export class DirectorSettingsValidationError extends FoundationSettingsValidationError {}

function sanitizeApplyFields(value: unknown): (typeof DIRECTOR_APPLY_FIELDS)[number][] {
  if (!Array.isArray(value)) return [...DIRECTOR_SETTINGS_DEFAULTS.apply.fields]
  const filtered = value.filter((v): v is typeof DIRECTOR_APPLY_FIELDS[number] =>
    typeof v === 'string' && (DIRECTOR_APPLY_FIELDS as readonly string[]).includes(v))
  // 白名单子集；去重并保持规格顺序
  return DIRECTOR_APPLY_FIELDS.filter(f => filtered.includes(f))
}

export function sanitizeDirectorSettings(raw: unknown): DirectorSettings {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const view = (input.view && typeof input.view === 'object' && !Array.isArray(input.view)
    ? input.view
    : {}) as Record<string, unknown>
  const view3d = (input.view3d && typeof input.view3d === 'object' && !Array.isArray(input.view3d)
    ? input.view3d
    : {}) as Record<string, unknown>
  const apply = (input.apply && typeof input.apply === 'object' && !Array.isArray(input.apply)
    ? input.apply
    : {}) as Record<string, unknown>
  const duration = (input.duration && typeof input.duration === 'object' && !Array.isArray(input.duration)
    ? input.duration
    : {}) as Record<string, unknown>
  const stage = (input.stage && typeof input.stage === 'object' && !Array.isArray(input.stage)
    ? input.stage
    : {}) as Record<string, unknown>
  const previs = (input.previs && typeof input.previs === 'object' && !Array.isArray(input.previs)
    ? input.previs
    : {}) as Record<string, unknown>
  return {
    mode: foundationEnum(input.mode, DIRECTOR_MODES, DIRECTOR_SETTINGS_DEFAULTS.mode),
    view: { default: foundationEnum(view.default, DIRECTOR_VIEW_DEFAULTS, DIRECTOR_SETTINGS_DEFAULTS.view.default) },
    view3d: { enabled: foundationBool(view3d.enabled, DIRECTOR_SETTINGS_DEFAULTS.view3d.enabled) },
    apply: {
      fields: sanitizeApplyFields(apply.fields),
      promptAppend: foundationBool(apply.promptAppend, DIRECTOR_SETTINGS_DEFAULTS.apply.promptAppend),
      subshotSync: foundationBool(apply.subshotSync, DIRECTOR_SETTINGS_DEFAULTS.apply.subshotSync),
    },
    duration: {
      min: foundationNumber(duration.min, 6, 12, DIRECTOR_SETTINGS_DEFAULTS.duration.min),
      max: foundationNumber(duration.max, 12, 20, DIRECTOR_SETTINGS_DEFAULTS.duration.max),
      fps: foundationEnum(duration.fps, DIRECTOR_FPS_VALUES, DIRECTOR_SETTINGS_DEFAULTS.duration.fps),
    },
    stage: { maxShots: foundationNumber(stage.maxShots, 50, 500, DIRECTOR_SETTINGS_DEFAULTS.stage.maxShots) },
    previs: { maxAssets: foundationNumber(previs.maxAssets, 5, 50, DIRECTOR_SETTINGS_DEFAULTS.previs.maxAssets) },
  }
}

export function getDirectorSettings(): DirectorSettings {
  const next = sanitizeDirectorSettings(readNamespaceJson(DIRECTOR_SETTINGS_KEY))
  const envMode = envEnum('DIRECTOR_MODE', DIRECTOR_MODES)
  const env3d = envBoolOff('DIRECTOR_3D')
  return {
    ...next,
    mode: envMode ?? next.mode,
    view3d: { enabled: env3d === false ? false : next.view3d.enabled },
  }
}

export function setDirectorSettings(patch: unknown): DirectorSettings {
  const input = assertObjectBody(patch)
  const current = sanitizeDirectorSettings(readNamespaceJson(DIRECTOR_SETTINGS_KEY))
  // 子对象按键合并，避免部分更新把未提交的兄弟键重置回默认
  const next = sanitizeDirectorSettings({
    ...current,
    ...input,
    view: { ...current.view, ...sub(input.view) },
    view3d: { ...current.view3d, ...sub(input.view3d) },
    apply: { ...current.apply, ...sub(input.apply) },
    duration: { ...current.duration, ...sub(input.duration) },
    stage: { ...current.stage, ...sub(input.stage) },
    previs: { ...current.previs, ...sub(input.previs) },
  })
  // 跨字段校验基于钳制前的原始入值：min∈[6,12]、max∈[12,20] 钳制后会掩盖 min>max 的矛盾
  const rawDuration = input.duration && typeof input.duration === 'object' ? input.duration as Record<string, unknown> : {}
  const rawMin = Number(rawDuration.min)
  const rawMax = Number(rawDuration.max)
  const effMin = Number.isFinite(rawMin) ? rawMin : next.duration.min
  const effMax = Number.isFinite(rawMax) ? rawMax : next.duration.max
  if (effMin > effMax) {
    throw new DirectorSettingsValidationError('director.duration.min 不能大于 director.duration.max')
  }
  writeNamespaceJson(DIRECTOR_SETTINGS_KEY, next)
  return getDirectorSettings()
}

// --- edit.*（11 键，剪辑工作台规格 §7） ---

export const EDIT_EXPORT_PRESETS = ['auto', 'vertical-hd', 'horizontal-hd', 'vertical-high', 'square-hd'] as const
export const EDIT_SUBTITLE_MODES = ['soft', 'burn', 'none'] as const
export const EDIT_AUDIO_SOURCES = ['auto', 'mix', 'clip', 'silent'] as const

export interface EditSettings {
  export: {
    enabled: boolean
    defaultPreset: typeof EDIT_EXPORT_PRESETS[number]
    subtitleMode: typeof EDIT_SUBTITLE_MODES[number]
    audioSource: typeof EDIT_AUDIO_SOURCES[number]
    requireAlignedMix: boolean
    maxDurationSec: number
    concurrency: number
  }
  ux: {
    contextMenu: boolean
    markers: boolean
    subtitleStyles: boolean
  }
  filmSources: { enabled: boolean }
}

export const EDIT_SETTINGS_DEFAULTS: EditSettings = {
  export: {
    enabled: true,
    defaultPreset: 'auto',
    subtitleMode: 'soft',
    audioSource: 'auto',
    requireAlignedMix: false,
    maxDurationSec: 1800,
    concurrency: 1,
  },
  ux: { contextMenu: true, markers: true, subtitleStyles: true },
  filmSources: { enabled: false },
}

const EDIT_SETTINGS_KEY = 'edit.settings'

export function sanitizeEditSettings(raw: unknown): EditSettings {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const exp = (input.export && typeof input.export === 'object' && !Array.isArray(input.export)
    ? input.export
    : {}) as Record<string, unknown>
  const ux = (input.ux && typeof input.ux === 'object' && !Array.isArray(input.ux)
    ? input.ux
    : {}) as Record<string, unknown>
  const filmSources = (input.filmSources && typeof input.filmSources === 'object' && !Array.isArray(input.filmSources)
    ? input.filmSources
    : {}) as Record<string, unknown>
  return {
    export: {
      enabled: foundationBool(exp.enabled, EDIT_SETTINGS_DEFAULTS.export.enabled),
      defaultPreset: foundationEnum(exp.defaultPreset, EDIT_EXPORT_PRESETS, EDIT_SETTINGS_DEFAULTS.export.defaultPreset),
      subtitleMode: foundationEnum(exp.subtitleMode, EDIT_SUBTITLE_MODES, EDIT_SETTINGS_DEFAULTS.export.subtitleMode),
      audioSource: foundationEnum(exp.audioSource, EDIT_AUDIO_SOURCES, EDIT_SETTINGS_DEFAULTS.export.audioSource),
      requireAlignedMix: foundationBool(exp.requireAlignedMix, EDIT_SETTINGS_DEFAULTS.export.requireAlignedMix),
      maxDurationSec: foundationNumber(exp.maxDurationSec, 60, 7200, EDIT_SETTINGS_DEFAULTS.export.maxDurationSec),
      concurrency: foundationNumber(exp.concurrency, 1, 2, EDIT_SETTINGS_DEFAULTS.export.concurrency),
    },
    ux: {
      contextMenu: foundationBool(ux.contextMenu, EDIT_SETTINGS_DEFAULTS.ux.contextMenu),
      markers: foundationBool(ux.markers, EDIT_SETTINGS_DEFAULTS.ux.markers),
      subtitleStyles: foundationBool(ux.subtitleStyles, EDIT_SETTINGS_DEFAULTS.ux.subtitleStyles),
    },
    filmSources: { enabled: foundationBool(filmSources.enabled, EDIT_SETTINGS_DEFAULTS.filmSources.enabled) },
  }
}

export function getEditSettings(): EditSettings {
  const next = sanitizeEditSettings(readNamespaceJson(EDIT_SETTINGS_KEY))
  const envExport = envBoolOff('EDIT_EXPORT')
  const envFilmSources = envBoolOff('EDIT_FILM_SOURCES')
  return {
    export: { ...next.export, enabled: envExport === false ? false : next.export.enabled },
    ux: next.ux,
    filmSources: { enabled: envFilmSources === true ? true : next.filmSources.enabled },
  }
}

export function setEditSettings(patch: unknown): EditSettings {
  const input = assertObjectBody(patch)
  const current = sanitizeEditSettings(readNamespaceJson(EDIT_SETTINGS_KEY))
  // 子对象按键合并，避免部分更新把未提交的兄弟键重置回默认
  const next = sanitizeEditSettings({
    ...current,
    ...input,
    export: { ...current.export, ...sub(input.export) },
    ux: { ...current.ux, ...sub(input.ux) },
    filmSources: { ...current.filmSources, ...sub(input.filmSources) },
  })
  writeNamespaceJson(EDIT_SETTINGS_KEY, next)
  return getEditSettings()
}

// --- agent.*（18 键，智能体规格 §9） ---

export const AGENT_SCOPES = ['home', 'novel-library', 'novel', 'drama', 'episode', 'director', 'edit', 'mix', 'delivery'] as const
export const AGENT_PROPOSAL_TYPES = ['storyboard.update', 'asset.prompt.update', 'line.update'] as const
export const AGENT_SUGGESTION_ACTIONS = ['agent.run', 'page.open'] as const
export const AGENT_PAGE_ENTRIES = ['floating', 'topbar', 'stage'] as const
export const AGENT_PAGE_STAGES = ['script', 'assets', 'videos', 'dubbing', 'mix', 'delivery'] as const
export const AGENT_PRESETS = ['assistant', 'director'] as const
export const AGENT_EPISODE_ROUTE = '/drama/:id/episode/:episodeNumber'
export const AGENT_EDIT_ROUTE = '/drama/:id/episode/:episodeNumber/edit'
/** 只读工具白名单（智能体规格 §7.1） */
export const AGENT_READ_TOOLS = [
  'read_project_list',
  'read_project_overview',
  'read_episode_context',
  'read_script',
  'read_assets',
  'read_asset_detail',
  'read_storyboards',
  'read_storyboard_detail',
  'read_dubbing_status',
  'read_edit_state',
  'read_edit_clips',
  'read_mix_state',
  'read_mix_tracks',
  'read_delivery_status',
  'read_export_history',
  'read_novel_list',
  'read_novel_context',
  'read_novel_chapters',
  'read_novel_chapter_content',
  'read_novel_atlas',
  'read_director_plan',
] as const

export interface AgentPageBinding {
  route: string
  stage?: (typeof AGENT_PAGE_STAGES)[number]
  entries: (typeof AGENT_PAGE_ENTRIES)[number][]
  defaultPreset: (typeof AGENT_PRESETS)[number]
  quickPrompts: string[]
  allowedScopes?: (typeof AGENT_SCOPES)[number][]
  allowedTools?: string[]
}

export interface AgentPagesConfig {
  version: 1
  bindings: AgentPageBinding[]
}

export interface AgentSettings {
  dock: { enabled: boolean }
  pages: AgentPagesConfig
  director: { enabled: boolean; model: string }
  stream: { enabled: boolean }
  proposals: { enabled: boolean; types: (typeof AGENT_PROPOSAL_TYPES)[number][] }
  suggestions: { enabled: boolean; actions: (typeof AGENT_SUGGESTION_ACTIONS)[number][] }
  scope: { autoDetect: boolean }
  maxSteps: number
  timeoutSec: number
  context: { maxChars: number }
  message: { maxChars: number }
  tools: { maxResultChars: number }
  history: { maxMessages: number }
  session: { retentionDays: number }
  model: string
}

/** 内置页面嵌入矩阵（智能体规格 §4.4；导演台页签的 director 预设由页面适配器按 panel=director 判定，不走 stage 绑定） */
export const AGENT_PAGES_DEFAULTS: AgentPagesConfig = {
  version: 1,
  bindings: [
    { route: '/', entries: ['floating'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['home'] },
    { route: '/novels', entries: ['floating'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['novel-library'] },
    { route: '/novels/:id', entries: ['topbar', 'floating'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['novel'] },
    { route: '/drama/:id', entries: ['topbar', 'floating'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['drama'] },
    { route: AGENT_EPISODE_ROUTE, entries: ['floating', 'stage'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['episode'] },
    { route: AGENT_EPISODE_ROUTE, stage: 'mix', entries: ['stage'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['mix'] },
    { route: AGENT_EPISODE_ROUTE, stage: 'delivery', entries: ['stage'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['delivery'] },
    { route: AGENT_EDIT_ROUTE, entries: ['topbar', 'floating'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['edit'] },
  ],
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  dock: { enabled: true },
  pages: AGENT_PAGES_DEFAULTS,
  director: { enabled: true, model: '' },
  stream: { enabled: true },
  proposals: { enabled: true, types: [...AGENT_PROPOSAL_TYPES] },
  suggestions: { enabled: true, actions: [...AGENT_SUGGESTION_ACTIONS] },
  scope: { autoDetect: true },
  maxSteps: 8,
  timeoutSec: 120,
  context: { maxChars: 12000 },
  message: { maxChars: 4000 },
  tools: { maxResultChars: 6000 },
  history: { maxMessages: 20 },
  session: { retentionDays: 30 },
  model: '',
}

const AGENT_SETTINGS_KEY = 'agent.settings'

export class AgentSettingsValidationError extends FoundationSettingsValidationError {}

function whitelistSubset<T extends string>(value: unknown, list: readonly T[]): T[] | null {
  if (!Array.isArray(value)) return null
  const filtered = value.filter((v): v is T => typeof v === 'string' && (list as readonly string[]).includes(v))
  return [...new Set(filtered)]
}

/** allowedScopes/allowedTools：空数组非法，绑定作废；allowedTools 限只读工具白名单（提案/建议由作用域工具集注册，不走绑定） */
function sanitizeAllowedList(value: unknown, min: 1): string[] | null | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  if (value.length < min) return null
  const filtered = value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
  return filtered.length === value.length && filtered.length > 0 ? [...new Set(filtered)] : null
}

/** 作用域对应的页面路由（用于按页面绑定收窄作用域与只读工具） */
export function agentPageRouteForScope(scope: { kind: (typeof AGENT_SCOPES)[number]; stage?: string }): string | null {
  switch (scope.kind) {
    case 'home': return '/'
    case 'novel-library': return '/novels'
    case 'novel': return '/novels/:id'
    case 'drama': return '/drama/:id'
    case 'edit': return AGENT_EDIT_ROUTE
    case 'episode':
    case 'director':
    case 'mix':
    case 'delivery':
      return AGENT_EPISODE_ROUTE
    default:
      return null
  }
}

function bindingStageForScope(scope: { kind: (typeof AGENT_SCOPES)[number]; stage?: string }): string | undefined {
  if (scope.kind === 'episode') return scope.stage
  if (scope.kind === 'mix' || scope.kind === 'delivery') return scope.kind
  return undefined
}

/** 按最具体的 (route, stage) 命中；阶段未配置时继承路由默认绑定 */
export function resolveAgentPageBinding(
  scope: { kind: (typeof AGENT_SCOPES)[number]; stage?: string },
  pages: AgentPagesConfig = getAgentSettings().pages,
): AgentPageBinding | undefined {
  const route = agentPageRouteForScope(scope)
  if (!route) return undefined
  const stage = bindingStageForScope(scope)
  if (stage) {
    const exact = pages.bindings.find(b => b.route === route && b.stage === stage)
    if (exact) return exact
  }
  return pages.bindings.find(b => b.route === route && b.stage === undefined)
}

/** defaultPreset=director 只允许分集路由的默认绑定，且该绑定允许 director 作用域 */
export function canUseDirectorDefaultPreset(
  route: string,
  stage: string | undefined,
  allowedScopes: readonly string[] | undefined,
): boolean {
  if (route !== AGENT_EPISODE_ROUTE || stage !== undefined) return false
  return allowedScopes === undefined || allowedScopes.includes('director')
}

export function agentPageAllowsScope(
  scope: { kind: (typeof AGENT_SCOPES)[number]; stage?: string },
  pages: AgentPagesConfig = getAgentSettings().pages,
): boolean {
  const binding = resolveAgentPageBinding(scope, pages)
  if (!binding?.allowedScopes) return true
  // 导演台页签由适配器按 panel=director 判定，不写入 stage 绑定；分集路由始终允许导演作用域
  if (scope.kind === 'director') return binding.route === AGENT_EPISODE_ROUTE
  return (binding.allowedScopes as readonly string[]).includes(scope.kind)
}

export function sanitizeAgentPages(raw: unknown): AgentPagesConfig {
  if (raw === undefined || raw === null) return AGENT_PAGES_DEFAULTS
  const input = raw as Record<string, unknown>
  if (!input || typeof input !== 'object' || Array.isArray(input)) return AGENT_PAGES_DEFAULTS
  if (Number(input.version) !== 1 || !Array.isArray(input.bindings)) return AGENT_PAGES_DEFAULTS
  const bindings: AgentPageBinding[] = []
  const seen = new Set<string>()
  for (const item of input.bindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return AGENT_PAGES_DEFAULTS
    const b = item as Record<string, unknown>
    if (typeof b.route !== 'string' || b.route.length === 0 || b.route.length > 200 || !b.route.startsWith('/')) {
      return AGENT_PAGES_DEFAULTS
    }
    if (b.stage !== undefined && b.stage !== null && (typeof b.stage !== 'string' || !(AGENT_PAGE_STAGES as readonly string[]).includes(b.stage))) {
      return AGENT_PAGES_DEFAULTS
    }
    const stage = (typeof b.stage === 'string' && (AGENT_PAGE_STAGES as readonly string[]).includes(b.stage))
      ? b.stage as (typeof AGENT_PAGE_STAGES)[number]
      : undefined
    const key = `${b.route}|${stage ?? ''}`
    if (seen.has(key)) return AGENT_PAGES_DEFAULTS
    seen.add(key)
    const entries = whitelistSubset(b.entries, AGENT_PAGE_ENTRIES)
    // 空数组表示隐藏入口；但非数组、未知值或重复值视为非法结构。
    if (!entries || !Array.isArray(b.entries) || entries.length !== b.entries.length) return AGENT_PAGES_DEFAULTS
    const preset = foundationEnum(b.defaultPreset, AGENT_PRESETS, 'assistant')
    if (typeof b.defaultPreset === 'string' && !(AGENT_PRESETS as readonly string[]).includes(b.defaultPreset)) {
      return AGENT_PAGES_DEFAULTS
    }
    const quickPrompts = Array.isArray(b.quickPrompts)
      ? b.quickPrompts.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100).slice(0, 6)
      : []
    const allowedScopes = sanitizeAllowedList(b.allowedScopes, 1)
    if (allowedScopes === null) return AGENT_PAGES_DEFAULTS
    if (allowedScopes !== undefined) {
      const valid = allowedScopes.every(s => (AGENT_SCOPES as readonly string[]).includes(s))
      if (!valid) return AGENT_PAGES_DEFAULTS
    }
    const allowedTools = sanitizeAllowedList(b.allowedTools, 1)
    if (allowedTools === null) return AGENT_PAGES_DEFAULTS
    // 绑定只能从只读工具白名单中收窄；含未知或提案/建议工具视为非法结构
    if (allowedTools && !allowedTools.every(t => (AGENT_READ_TOOLS as readonly string[]).includes(t))) {
      return AGENT_PAGES_DEFAULTS
    }
    // 导演预设只属于导演台页签（分集路由默认绑定且允许 director 作用域）；其余回退 assistant
    const defaultPreset = preset === 'director' && !canUseDirectorDefaultPreset(b.route, stage, allowedScopes)
      ? 'assistant'
      : preset
    bindings.push({
      route: b.route,
      ...(stage ? { stage } : {}),
      entries: entries as AgentPageBinding['entries'],
      defaultPreset,
      quickPrompts,
      ...(allowedScopes ? { allowedScopes: allowedScopes as AgentPageBinding['allowedScopes'] } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    })
  }
  return { version: 1, bindings }
}

export function sanitizeAgentSettings(raw: unknown): AgentSettings {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const dock = sub(input.dock)
  const director = sub(input.director)
  const stream = sub(input.stream)
  const proposals = sub(input.proposals)
  const suggestions = sub(input.suggestions)
  const scope = sub(input.scope)
  const context = sub(input.context)
  const message = sub(input.message)
  const tools = sub(input.tools)
  const history = sub(input.history)
  const session = sub(input.session)
  const typesRaw = proposals.types === undefined ? undefined : whitelistSubset(proposals.types, AGENT_PROPOSAL_TYPES)
  const actionsRaw = suggestions.actions === undefined ? undefined : whitelistSubset(suggestions.actions, AGENT_SUGGESTION_ACTIONS)
  const types = typesRaw ?? [...AGENT_PROPOSAL_TYPES]
  const actions = actionsRaw ?? [...AGENT_SUGGESTION_ACTIONS]
  return {
    dock: { enabled: dock.enabled === undefined ? AGENT_SETTINGS_DEFAULTS.dock.enabled : foundationBool(dock.enabled, AGENT_SETTINGS_DEFAULTS.dock.enabled) },
    pages: sanitizeAgentPages(input.pages),
    director: {
      enabled: director.enabled === undefined ? AGENT_SETTINGS_DEFAULTS.director.enabled : foundationBool(director.enabled, AGENT_SETTINGS_DEFAULTS.director.enabled),
      model: typeof director.model === 'string' ? director.model.trim().slice(0, 200) : AGENT_SETTINGS_DEFAULTS.director.model,
    },
    stream: { enabled: stream.enabled === undefined ? AGENT_SETTINGS_DEFAULTS.stream.enabled : foundationBool(stream.enabled, AGENT_SETTINGS_DEFAULTS.stream.enabled) },
    proposals: {
      enabled: proposals.enabled === undefined ? AGENT_SETTINGS_DEFAULTS.proposals.enabled : foundationBool(proposals.enabled, AGENT_SETTINGS_DEFAULTS.proposals.enabled),
      types,
    },
    suggestions: {
      enabled: suggestions.enabled === undefined ? AGENT_SETTINGS_DEFAULTS.suggestions.enabled : foundationBool(suggestions.enabled, AGENT_SETTINGS_DEFAULTS.suggestions.enabled),
      actions,
    },
    scope: { autoDetect: scope.autoDetect === undefined ? AGENT_SETTINGS_DEFAULTS.scope.autoDetect : foundationBool(scope.autoDetect, AGENT_SETTINGS_DEFAULTS.scope.autoDetect) },
    maxSteps: foundationNumber(input.maxSteps, 4, 16, AGENT_SETTINGS_DEFAULTS.maxSteps),
    timeoutSec: foundationNumber(input.timeoutSec, 30, 600, AGENT_SETTINGS_DEFAULTS.timeoutSec),
    context: { maxChars: foundationNumber(context.maxChars, 4000, 32000, AGENT_SETTINGS_DEFAULTS.context.maxChars) },
    message: { maxChars: foundationNumber(message.maxChars, 500, 12000, AGENT_SETTINGS_DEFAULTS.message.maxChars) },
    tools: { maxResultChars: foundationNumber(tools.maxResultChars, 1000, 12000, AGENT_SETTINGS_DEFAULTS.tools.maxResultChars) },
    history: { maxMessages: foundationNumber(history.maxMessages, 5, 50, AGENT_SETTINGS_DEFAULTS.history.maxMessages) },
    session: { retentionDays: foundationNumber(session.retentionDays, 7, 365, AGENT_SETTINGS_DEFAULTS.session.retentionDays) },
    model: typeof input.model === 'string' ? input.model.trim().slice(0, 200) : AGENT_SETTINGS_DEFAULTS.model,
  }
}

function sub(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function getAgentSettings(): AgentSettings {
  const next = sanitizeAgentSettings(readNamespaceJson(AGENT_SETTINGS_KEY))
  const envOff = (name: string): boolean | null => {
    const v = envBoolOff(name)
    return v === false ? false : null
  }
  return {
    ...next,
    dock: { enabled: envOff('AGENT_DOCK') ?? next.dock.enabled },
    director: { ...next.director, enabled: envOff('AGENT_DIRECTOR') ?? next.director.enabled },
    stream: { enabled: envOff('AGENT_STREAM') ?? next.stream.enabled },
    proposals: { ...next.proposals, enabled: envOff('AGENT_PROPOSALS') ?? next.proposals.enabled },
    suggestions: { ...next.suggestions, enabled: envOff('AGENT_SUGGESTIONS') ?? next.suggestions.enabled },
  }
}

export function setAgentSettings(patch: unknown): AgentSettings {
  const input = assertObjectBody(patch)
  const current = sanitizeAgentSettings(readNamespaceJson(AGENT_SETTINGS_KEY))
  const next = sanitizeAgentSettings({
    ...current,
    ...input,
    dock: { ...current.dock, ...sub(input.dock) },
    director: { ...current.director, ...sub(input.director) },
    stream: { ...current.stream, ...sub(input.stream) },
    proposals: { ...current.proposals, ...sub(input.proposals) },
    suggestions: { ...current.suggestions, ...sub(input.suggestions) },
    scope: { ...current.scope, ...sub(input.scope) },
    context: { ...current.context, ...sub(input.context) },
    message: { ...current.message, ...sub(input.message) },
    tools: { ...current.tools, ...sub(input.tools) },
    history: { ...current.history, ...sub(input.history) },
    session: { ...current.session, ...sub(input.session) },
  })
  // 跨字段校验基于钳制前的原始入值，避免钳制掩盖 message > context 的矛盾
  const rawMsg = Number(sub(input.message).maxChars)
  const rawCtx = Number(sub(input.context).maxChars)
  const effMsg = Number.isFinite(rawMsg) ? rawMsg : next.message.maxChars
  const effCtx = Number.isFinite(rawCtx) ? rawCtx : next.context.maxChars
  if (effMsg > effCtx) {
    throw new AgentSettingsValidationError('agent.message.maxChars 不能大于 agent.context.maxChars')
  }
  writeNamespaceJson(AGENT_SETTINGS_KEY, next)
  return getAgentSettings()
}
