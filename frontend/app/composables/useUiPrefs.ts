/**
 * 界面偏好（模块级单例）
 * - 与 useTheme 同构：模块顶层同步读 localStorage 并写根节点属性，先于首帧
 * - 优先级：设备偏好 > 部署默认（GET /settings/ui）> 内置默认
 * - ui.allowUserOverride=false 时忽略设备偏好，但不删除本地存储
 */
import { computed, readonly, ref, type ComputedRef } from 'vue'
import { settingsAPI } from './useApi'

export const UI_PREFS_STORAGE_KEY = 'huobao:ui-prefs'
export const UI_DEFAULTS_STORAGE_KEY = 'huobao:ui-defaults'

export const UI_DENSITIES = ['compact', 'comfortable'] as const
export const UI_MOTIONS = ['system', 'full', 'reduced'] as const
export const UI_READING_FONTS = ['serif', 'sans'] as const
export const UI_READING_SIZES = [15, 16, 17, 18] as const
export const UI_READING_WIDTHS = [60, 68, 76] as const

export type UiDensity = typeof UI_DENSITIES[number]
export type UiMotion = typeof UI_MOTIONS[number]
export type UiReadingFont = typeof UI_READING_FONTS[number]
export type UiReadingSize = typeof UI_READING_SIZES[number]
export type UiReadingWidth = typeof UI_READING_WIDTHS[number]

export interface UiPrefs {
  density?: UiDensity
  motion?: UiMotion
  readingFont?: UiReadingFont
  readingSize?: UiReadingSize
  readingWidth?: UiReadingWidth
  actionLabels?: boolean
}

export interface EffectiveUiPrefs {
  density: UiDensity
  motion: UiMotion
  readingFont: UiReadingFont
  readingSize: UiReadingSize
  readingWidth: UiReadingWidth
  actionLabels: boolean
}

export interface UiDefaultsPayload {
  defaults: {
    density: UiDensity
    motion: UiMotion
    readingFont: UiReadingFont
    readingSize: UiReadingSize
    actionLabels: boolean
  }
  allowUserOverride: boolean
}

export const BUILTIN_UI_DEFAULTS: UiDefaultsPayload = {
  defaults: {
    density: 'compact',
    motion: 'system',
    readingFont: 'serif',
    readingSize: 16,
    actionLabels: true,
  },
  allowUserOverride: true,
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined
}

function pickReadingSize(value: unknown): UiReadingSize | undefined {
  const n = Number(value)
  return (UI_READING_SIZES as readonly number[]).includes(n) ? n as UiReadingSize : undefined
}

function pickReadingWidth(value: unknown): UiReadingWidth | undefined {
  const n = Number(value)
  return (UI_READING_WIDTHS as readonly number[]).includes(n) ? n as UiReadingWidth : undefined
}

function pickBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function sanitizeUiPrefs(raw: unknown): UiPrefs {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const next: UiPrefs = {}
  const density = pickEnum(input.density, UI_DENSITIES)
  const motion = pickEnum(input.motion, UI_MOTIONS)
  const readingFont = pickEnum(input.readingFont, UI_READING_FONTS)
  const readingSize = pickReadingSize(input.readingSize)
  const readingWidth = pickReadingWidth(input.readingWidth)
  const actionLabels = pickBool(input.actionLabels)
  if (density) next.density = density
  if (motion) next.motion = motion
  if (readingFont) next.readingFont = readingFont
  if (readingSize) next.readingSize = readingSize
  if (readingWidth) next.readingWidth = readingWidth
  if (actionLabels !== undefined) next.actionLabels = actionLabels
  return next
}

export function sanitizeUiDefaults(raw: unknown): UiDefaultsPayload {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const defaults = input.defaults && typeof input.defaults === 'object' && !Array.isArray(input.defaults)
    ? input.defaults as Record<string, unknown>
    : {}
  return {
    defaults: {
      density: pickEnum(defaults.density, UI_DENSITIES) ?? BUILTIN_UI_DEFAULTS.defaults.density,
      motion: pickEnum(defaults.motion, UI_MOTIONS) ?? BUILTIN_UI_DEFAULTS.defaults.motion,
      readingFont: pickEnum(defaults.readingFont, UI_READING_FONTS) ?? BUILTIN_UI_DEFAULTS.defaults.readingFont,
      readingSize: pickReadingSize(defaults.readingSize) ?? BUILTIN_UI_DEFAULTS.defaults.readingSize,
      actionLabels: pickBool(defaults.actionLabels) ?? BUILTIN_UI_DEFAULTS.defaults.actionLabels,
    },
    allowUserOverride: pickBool(input.allowUserOverride) ?? BUILTIN_UI_DEFAULTS.allowUserOverride,
  }
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 忽略持久化失败 */ }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key)
  } catch { /* 忽略持久化失败 */ }
}

const storedPrefs = ref<UiPrefs>({})
const deployment = ref<UiDefaultsPayload>(BUILTIN_UI_DEFAULTS)
const loading = ref(false)
const error = ref('')
const loaded = ref(false)
let inflight: Promise<UiDefaultsPayload | null> | null = null

if (typeof window !== 'undefined') {
  storedPrefs.value = sanitizeUiPrefs(readJson(UI_PREFS_STORAGE_KEY))
  deployment.value = sanitizeUiDefaults(readJson(UI_DEFAULTS_STORAGE_KEY))
}

export const allowUserOverride: ComputedRef<boolean> = computed(() => deployment.value.allowUserOverride)

export const effectiveUiPrefs: ComputedRef<EffectiveUiPrefs> = computed(() => {
  const base: EffectiveUiPrefs = {
    ...deployment.value.defaults,
    readingWidth: 68,
  }
  if (!allowUserOverride.value) return base
  return { ...base, ...storedPrefs.value }
})

function applyUiPrefs() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const next = effectiveUiPrefs.value
  root.dataset.density = next.density
  root.dataset.motion = next.motion
  root.style.setProperty('--text-reading', `${next.readingSize}px`)
  root.style.setProperty('--reading-measure', `${next.readingWidth}ch`)
  if (next.readingFont === 'sans') {
    root.style.setProperty('--font-reading', 'var(--font-body)')
  } else {
    root.style.removeProperty('--font-reading')
  }
}

if (typeof window !== 'undefined') applyUiPrefs()

function persistDeployment() {
  writeJson(UI_DEFAULTS_STORAGE_KEY, deployment.value)
}

export function setUiPrefs(patch: Partial<UiPrefs>): EffectiveUiPrefs {
  storedPrefs.value = sanitizeUiPrefs({ ...storedPrefs.value, ...patch })
  writeJson(UI_PREFS_STORAGE_KEY, storedPrefs.value)
  applyUiPrefs()
  return effectiveUiPrefs.value
}

export function resetUiPrefs(): EffectiveUiPrefs {
  storedPrefs.value = {}
  removeStored(UI_PREFS_STORAGE_KEY)
  applyUiPrefs()
  return effectiveUiPrefs.value
}

export function loadUiSettings(force = false): Promise<UiDefaultsPayload | null> {
  if (loaded.value && !force) return Promise.resolve(deployment.value)
  if (inflight) return inflight
  loading.value = true
  error.value = ''
  inflight = settingsAPI.ui()
    .then((res) => {
      deployment.value = sanitizeUiDefaults(res?.settings)
      loaded.value = true
      persistDeployment()
      applyUiPrefs()
      return deployment.value
    })
    .catch((err: any) => {
      error.value = err?.message || String(err)
      return null
    })
    .finally(() => {
      loading.value = false
      inflight = null
    })
  return inflight
}

export function useUiPrefs() {
  return {
    prefs: readonly(storedPrefs),
    defaults: computed(() => deployment.value.defaults),
    allowUserOverride,
    effective: effectiveUiPrefs,
    loading: readonly(loading),
    error: readonly(error),
    load: loadUiSettings,
    setPrefs: setUiPrefs,
    resetPrefs: resetUiPrefs,
  }
}
