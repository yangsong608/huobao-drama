/** V2 设置：覆盖预设选择与创作验收清单，存 app_settings，数据库是唯一事实来源。 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  DEFAULT_V2_COVERAGE_PRESET,
  V2_COVERAGE_PRESETS,
  findV2CoveragePreset,
  type V2CoveragePreset,
} from './storyboard-v2-presets.js'

const ACTIVE_PRESET_KEY = 'storyboard_v2.coverage_preset'
const REVIEW_CHECKLIST_KEY = 'storyboard_v2.review_checklist'
const PRODUCTION_ENABLED_KEY = 'storyboard_v2.production_enabled'

export interface V2ReviewChecklistItem {
  key: string
  label: string
  prompt: string
  enabled: boolean
}

const REVIEW_CHECKLIST_ITEMS: Omit<V2ReviewChecklistItem, 'enabled'>[] = [
  {
    key: 'hook',
    label: '开场钩子',
    prompt: '开场第一镜是否给出冲突、异常或明确问题，而不是只做环境铺陈？',
  },
  {
    key: 'reaction',
    label: '反应镜',
    prompt: '每个反应镜是否带来新的判断、情绪或关系变化？',
  },
  {
    key: 'rhythm',
    label: '镜头节奏',
    prompt: '整体平均时长是否接近项目节奏目标，且没有为凑时长保留的镜头？',
  },
  {
    key: 'closeup',
    label: '近景占比',
    prompt: '近景是否服务于信息和情绪，而不是机械覆盖所有台词？',
  },
  {
    key: 'no_info',
    label: '无信息镜头',
    prompt: '是否存在没有台词、动作信息或视觉必要的镜头？',
  },
  {
    key: 'coverage',
    label: '覆盖多样性',
    prompt: 'Master/反打/反应/插入是否按空间和信息变化使用，而不是机械轮换？',
  },
  {
    key: 'transition',
    label: '转场',
    prompt: '场景变化是否有明确切点或中性镜，而不是靠文字硬转？',
  },
  {
    key: 'dialogue',
    label: '台词完整',
    prompt: '台词是否逐字完整，声音事件是否进入时间轴？',
  },
]

function readSetting(key: string): string | null {
  const row = db.select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get()
  return row?.value ?? null
}

function writeSetting(key: string, value: string) {
  const timestamp = now()
  db.insert(schema.appSettings)
    .values({ key, value, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: timestamp },
    })
    .run()
}

export function getV2CoveragePresets(): V2CoveragePreset[] {
  return V2_COVERAGE_PRESETS.map(preset => ({ ...preset, guidance: [...preset.guidance] }))
}

export function getActiveV2CoveragePreset(): V2CoveragePreset {
  return findV2CoveragePreset(readSetting(ACTIVE_PRESET_KEY)) || DEFAULT_V2_COVERAGE_PRESET
}

export function setActiveV2CoveragePreset(key: unknown): V2CoveragePreset {
  const preset = findV2CoveragePreset(typeof key === 'string' ? key : '')
  if (!preset) throw new Error('覆盖预设不存在')
  writeSetting(ACTIVE_PRESET_KEY, preset.key)
  return preset
}

export function resolveV2CoveragePreset(key?: string | null): V2CoveragePreset {
  if (!key) return getActiveV2CoveragePreset()
  const preset = findV2CoveragePreset(key)
  if (!preset) throw new Error('覆盖预设不存在')
  return preset
}

function normalizeEnabledKeys(raw: unknown): string[] {
  const known = new Set(REVIEW_CHECKLIST_ITEMS.map(item => item.key))
  if (!Array.isArray(raw)) return REVIEW_CHECKLIST_ITEMS.map(item => item.key)
  return [...new Set(raw.filter((item): item is string => typeof item === 'string' && known.has(item)))]
}

export function getV2ReviewChecklist(): { items: V2ReviewChecklistItem[]; enabled: string[] } {
  let enabled = REVIEW_CHECKLIST_ITEMS.map(item => item.key)
  const raw = readSetting(REVIEW_CHECKLIST_KEY)
  if (raw) {
    try { enabled = normalizeEnabledKeys(JSON.parse(raw)) } catch { /* 保持默认 */ }
  }
  const enabledSet = new Set(enabled)
  return {
    enabled,
    items: REVIEW_CHECKLIST_ITEMS.map(item => ({ ...item, enabled: enabledSet.has(item.key) })),
  }
}

export function setV2ReviewChecklist(raw: unknown): { items: V2ReviewChecklistItem[]; enabled: string[] } {
  const enabled = normalizeEnabledKeys(raw)
  writeSetting(REVIEW_CHECKLIST_KEY, JSON.stringify(enabled))
  const enabledSet = new Set(enabled)
  return {
    enabled,
    items: REVIEW_CHECKLIST_ITEMS.map(item => ({ ...item, enabled: enabledSet.has(item.key) })),
  }
}

export function isStoryboardV2ProductionEnabled(): boolean {
  return readSetting(PRODUCTION_ENABLED_KEY) === '1'
}

export function setStoryboardV2ProductionEnabled(enabled: unknown): boolean {
  const value = enabled === true || enabled === '1' || enabled === 'true'
  writeSetting(PRODUCTION_ENABLED_KEY, value ? '1' : '0')
  return value
}

export function getV2ConfigSnapshot() {
  return {
    active_preset_key: getActiveV2CoveragePreset().key,
    production_enabled: isStoryboardV2ProductionEnabled(),
    presets: getV2CoveragePresets(),
    review_checklist: getV2ReviewChecklist(),
  }
}