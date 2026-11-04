/**
 * 集视频分辨率的唯一口径（项目页与制作页共用）
 *
 * 内部统一存 480p / 720p / 1080p 三档（episodes.resolution 只接受这三值），
 * 界面按「当前集选中的视频模型」展示厂商原生档位：
 *   Seedance 2.0 标准版 480p/720p/1080p、mini/fast 最高 720p、Seedance 1.x 三档、
 *   MiniMax H3 768P/2K、H3-Highspeed 768P、H3-Lite/Max 480P/768P、
 *   Wan 3.0/2.x 480P/720P/1080P、ComfyUI 工作流三档
 *
 * 两端（项目详情页的「新建集 / 集卡片」，制作页顶栏）必须都走这里，
 * 否则同一条集会在两个页面显示成两个不同的分辨率。
 */

import {
  videoModelCapabilities,
  videoResolutionTier as capabilityTier,
  type VideoCapabilityOptions,
  type VideoResolutionTier,
} from './model-capabilities'

export type VideoResolutionKey = VideoResolutionTier

const TIER_ORDER: VideoResolutionKey[] = ['480p', '720p', '1080p']
const TIER_NAME_KEY: Record<VideoResolutionKey, string> = { '480p': 'smooth', '720p': 'hd', '1080p': 'uhd' }

/** 本地 MiniMax 兼容层（mm-shim）：只有它能渲染官方档位之外的 480P 画布 */
export function isLocalMinimaxBaseUrl(baseUrl?: string | null): boolean {
  const raw = String(baseUrl || '').trim()
  if (!raw) return true
  for (const candidate of [raw, `http://${raw}`]) {
    try {
      const url = new URL(candidate)
      if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return true
      if (url.port === '8190') return true
    } catch {
      // 继续尝试下一种写法
    }
  }
  return false
}

/** 从配置推导能力选项：仅 minimax + 本地地址时开放 480p */
export function videoCapabilityOptions(
  config?: { provider?: string | null; baseUrl?: string | null; base_url?: string | null } | null,
): VideoCapabilityOptions {
  if (!config || String(config.provider || '').toLowerCase() !== 'minimax') return {}
  return { localShim: isLocalMinimaxBaseUrl(config.base_url ?? config.baseUrl) }
}

/** 厂商未知时按 Seedance 档位兜底（历史行为） */
export function videoResolutionProvider(provider?: string | null): string {
  const key = String(provider || '').toLowerCase()
  return ['volcengine', 'minimax', 'aliyun', 'comfyui'].includes(key) ? key : 'volcengine'
}

/** 归一化任意写法（含厂商原生值）到内部档位；无法识别返回 '' */
export function videoResolutionKey(value?: string | null): VideoResolutionKey | '' {
  return capabilityTier(value)
}

/** 读集上的分辨率（非法/空值按 720p） */
export function episodeResolutionKey(value?: string | null): VideoResolutionKey {
  return videoResolutionKey(value) || '720p'
}

/** 某模型可选档位；当前集已存的值即使不在档位内也保留，避免下拉框显示成别的值 */
export function videoResolutionTiers(
  provider?: string | null,
  current?: string | null,
  model?: string | null,
  options: VideoCapabilityOptions = {},
): VideoResolutionKey[] {
  const capability = videoModelCapabilities(videoResolutionProvider(provider), model, options)
  const list = [...capability.resolutions]
  const cur = videoResolutionKey(current)
  if (cur && !list.includes(cur)) list.push(cur)
  return list.sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b))
}

/** 厂商原生档位（用于提示，如 720p → 768P） */
export function videoResolutionVendor(
  provider: string | null | undefined,
  key: string,
  model?: string | null,
  options: VideoCapabilityOptions = {},
): string {
  const tier = videoResolutionKey(key)
  if (!tier) return key
  const capability = videoModelCapabilities(videoResolutionProvider(provider), model, options)
  return capability.vendorResolutions[tier] || tier
}

/**
 * 选项文案：`720p · 高清（768P）`
 * 厂商档位与内部档位一致时不加括号（如 Wan 3.0 的 1080P）。
 */
export function videoResolutionLabel(
  provider: string | null | undefined,
  key: string,
  t: (key: string) => string,
  model?: string | null,
  options: VideoCapabilityOptions = {},
): string {
  const tier = videoResolutionKey(key) || '720p'
  const name = t(`episode.resolution.${TIER_NAME_KEY[tier]}`)
  const vendor = videoResolutionVendor(provider, tier, model, options)
  const suffix = vendor.toLowerCase() === tier ? '' : `（${vendor}）`
  return `${tier} · ${name}${suffix}`
}

export interface VideoResolutionOption { label: string; value: VideoResolutionKey }

/** 下拉选项（BaseSelect 用）：同一集在项目页和制作页渲染结果完全一致 */
export function videoResolutionOptions(
  provider: string | null | undefined,
  current: string | null | undefined,
  t: (key: string) => string,
  model?: string | null,
  options: VideoCapabilityOptions = {},
): VideoResolutionOption[] {
  return videoResolutionTiers(provider, current, model, options).map(key => ({
    label: videoResolutionLabel(provider, key, t, model, options),
    value: key,
  }))
}
