/**
 * 模型级能力表 — 分辨率、时长、参考素材、原生音频、视觉理解
 *
 * 厂商文档的档位粒度并不一致（Seedance 2.0 mini 最高 720p、H3 只有 768P/2K、
 * Wan 3.0 三档齐全），按 provider 声明会隐藏模型真实能力或把不支持的档位
 * 静默降级。这里以模型为键给出能力，适配器与 UI（frontend/app/utils/
 * model-capabilities.ts）共用同一套规则；未知模型按厂商默认能力兜底。
 */

export type VideoResolutionTier = '480p' | '720p' | '1080p'

const TIER_ORDER: VideoResolutionTier[] = ['480p', '720p', '1080p']

export interface VideoModelCapabilities {
  /** 展示用模型族名 */
  family: string
  /** 内部三档中模型支持的档位 */
  resolutions: VideoResolutionTier[]
  /** 内部档位 → 厂商原生档位（用于展示与请求） */
  vendorResolutions: Partial<Record<VideoResolutionTier, string>>
  minDuration: number
  maxDuration: number
  /** 参考图数量上限，0 表示不支持 */
  referenceImages: number
  referenceVideos: number
  referenceAudios: number
  /** 该模型是否输出原生音频 */
  nativeAudio: boolean
}

export interface VideoCapabilityOptions {
  /** 本地 MiniMax shim 可在 768P/2K 之外自行渲染 480P，云端不认这一档 */
  localShim?: boolean
}

/** 任意写法（内部档位或厂商原生值）归一化到内部三档 */
export function videoResolutionTier(value?: string | null): VideoResolutionTier | '' {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === '480p' || raw === '512p') return '480p'
  if (raw === '720p' || raw === '768p') return '720p'
  if (raw === '1080p' || raw === '2k') return '1080p'
  return ''
}

function sortTiers(tiers: VideoResolutionTier[]): VideoResolutionTier[] {
  return [...new Set(tiers)].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b))
}

function build(
  family: string,
  resolutions: VideoResolutionTier[],
  vendorResolutions: Partial<Record<VideoResolutionTier, string>>,
  options: Partial<Pick<VideoModelCapabilities, 'minDuration' | 'maxDuration' | 'referenceImages' | 'referenceVideos' | 'referenceAudios' | 'nativeAudio'>> = {},
): VideoModelCapabilities {
  return {
    family,
    resolutions: sortTiers(resolutions),
    vendorResolutions,
    minDuration: options.minDuration ?? 2,
    maxDuration: options.maxDuration ?? 15,
    referenceImages: options.referenceImages ?? 0,
    referenceVideos: options.referenceVideos ?? 0,
    referenceAudios: options.referenceAudios ?? 0,
    nativeAudio: options.nativeAudio ?? false,
  }
}

function seedanceCapability(model: string): VideoModelCapabilities {
  const lower = model.toLowerCase()
  const isSeedance2 = lower.startsWith('doubao-seedance-2-')
  if (isSeedance2) {
    const limited = lower.includes('-mini-') || lower.includes('-fast-')
    return build(
      limited ? 'seedance-2.0-fast' : 'seedance-2.0',
      limited ? ['480p', '720p'] : ['480p', '720p', '1080p'],
      { '480p': '480p', '720p': '720p', '1080p': '1080p' },
      { minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true },
    )
  }
  // Seedance 1.x：仅文生视频/首尾帧，单张图，无参考视频/音频与原生音频
  const isI2v = lower.includes('-i2v-')
  return build(
    'seedance-1.x',
    ['480p', '720p', '1080p'],
    { '480p': '480p', '720p': '720p', '1080p': '1080p' },
    { minDuration: 2, maxDuration: 12, referenceImages: isI2v ? 1 : 0, nativeAudio: false },
  )
}

function minimaxCapability(model: string, options: VideoCapabilityOptions = {}): VideoModelCapabilities {
  const lower = model.toLowerCase()
  if (lower.includes('highspeed')) {
    return build('h3-highspeed', ['720p'], { '720p': '768P' }, {
      minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true,
    })
  }
  // 不能直接 includes('max')：MiniMax 品牌名会误命中 H3-Max
  const isLiteOrMax = lower.includes('h3-lite') || lower.includes('h3-max')
    || lower.includes('-lite') || lower.includes('-max')
  if (isLiteOrMax) {
    return build('h3-lite', ['480p', '720p'], { '480p': '480P', '720p': '768P' }, {
      minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true,
    })
  }
  // 本地 shim 有完整 480P 画布，标准 H3 在本地也可选 480p；云端仍只认 768P/2K
  // 音频/视频参考尚未接入 shim，声明为 0，避免任务创建后素材被静默丢弃
  if (options.localShim) {
    return build('h3', ['480p', '720p', '1080p'], { '480p': '480P', '720p': '768P', '1080p': '2K' }, {
      minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 0, referenceAudios: 0, nativeAudio: true,
    })
  }
  return build('h3', ['720p', '1080p'], { '720p': '768P', '1080p': '2K' }, {
    minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true,
  })
}

function aliyunCapability(model: string): VideoModelCapabilities {
  const lower = model.toLowerCase()
  if (lower.startsWith('wan3.0')) {
    return build('wan3.0', ['480p', '720p', '1080p'], { '480p': '480P', '720p': '720P', '1080p': '1080P' }, {
      minDuration: 2, maxDuration: 30, referenceImages: 10, referenceVideos: 5, referenceAudios: 5, nativeAudio: false,
    })
  }
  // Wan 2.x：文生视频无参考图；i2v 仅首帧
  const isI2v = lower.includes('-i2v')
  return build('wan2.x', ['480p', '720p', '1080p'], { '480p': '480P', '720p': '720P', '1080p': '1080P' }, {
    minDuration: 5, maxDuration: 10, referenceImages: isI2v ? 1 : 0, nativeAudio: false,
  })
}

/** 模型级视频能力；模型为空时按厂商默认（宽松）能力返回 */
export function videoModelCapabilities(
  provider?: string | null,
  model?: string | null,
  options: VideoCapabilityOptions = {},
): VideoModelCapabilities {
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim()
  if (providerKey === 'volcengine') {
    return modelKey ? seedanceCapability(modelKey) : build('seedance', ['480p', '720p', '1080p'],
      { '480p': '480p', '720p': '720p', '1080p': '1080p' },
      { minDuration: 2, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true })
  }
  if (providerKey === 'minimax') {
    return modelKey ? minimaxCapability(modelKey, options) : minimaxCapability('MiniMax-H3', options)
  }
  if (providerKey === 'aliyun') {
    return modelKey ? aliyunCapability(modelKey) : aliyunCapability('wan3.0-video')
  }
  return build('comfyui', ['480p', '720p', '1080p'], { '480p': '480p', '720p': '720p', '1080p': '1080p' },
    { minDuration: 2, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: false })
}

/**
 * 选中模型支持的视频分辨率档位（内部三档）。
 * 传入 current 且当前值不在档位内时保留它，避免下拉框把已存值显示成别的档。
 */
export function videoResolutionTiers(
  provider?: string | null,
  model?: string | null,
  current?: string | null,
  options: VideoCapabilityOptions = {},
): VideoResolutionTier[] {
  const capability = videoModelCapabilities(provider, model, options)
  const list = [...capability.resolutions]
  const cur = videoResolutionTier(current)
  if (cur && !list.includes(cur)) list.push(cur)
  return sortTiers(list)
}

/** 厂商原生档位展示名（如 720p → 768P） */
export function videoResolutionVendor(
  provider: string | null | undefined,
  model: string | null | undefined,
  tier: string,
  options: VideoCapabilityOptions = {},
): string {
  const capability = videoModelCapabilities(provider, model, options)
  const key = videoResolutionTier(tier) || '720p'
  return capability.vendorResolutions[key] || key
}

/** 模型不支持请求档位时返回可操作错误；supported 为空表示不做模型级限制 */
export function resolutionSupportError(
  provider: string | null | undefined,
  model: string | null | undefined,
  requested?: string | null,
  options: VideoCapabilityOptions = {},
): string | null {
  const capability = videoModelCapabilities(provider, model, options)
  const tier = videoResolutionTier(requested)
  if (!tier || capability.resolutions.includes(tier)) return null
  const choices = capability.resolutions
    .map(item => capability.vendorResolutions[item] || item)
    .join(' / ')
  return `模型 ${model || capability.family} 不支持 ${requested} 分辨率，可选：${choices}`
}

/** 图片模型是否支持参考图（阿里云仅 *edit* 系列支持，最多 3 张） */
export function imageModelSupportsReferenceImages(provider?: string | null, model?: string | null): boolean {
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim().toLowerCase()
  if (providerKey === 'aliyun') return modelKey.includes('edit')
  // 只排除已知不支持参考图的 DALL·E；自定义/本地兼容端点使用其他模型名时放行
  if (providerKey === 'openai') return !/dall-e|dall·e/.test(modelKey)
  if (providerKey === 'gemini') return modelKey.includes('image')
  if (providerKey === 'volcengine') return modelKey.includes('seedream')
  if (providerKey === 'comfyui') return true
  return true
}

export function imageReferenceLimit(provider?: string | null, model?: string | null): number {
  if (!imageModelSupportsReferenceImages(provider, model)) return 0
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim().toLowerCase()
  if (providerKey === 'aliyun') return 3
  return 9
}

/**
 * 文本模型是否具备视觉理解能力（风格分析用）。
 * 图像生成模型不返回文字，永远不参与风格分析；
 * 已知纯文本模型（deepseek）显式排除；未知自定义模型默认可用，避免误伤本地视觉模型。
 */
export function textModelSupportsVision(provider?: string | null, model?: string | null): boolean {
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim().toLowerCase()
  if (!modelKey) return false
  if (/(image|dall-e|seedream|qwen-image|t2i|video)/.test(modelKey)) return false
  if (/(vision|\bvl\b|qwen.*vl|omni|multimodal)/.test(modelKey)) return true
  if (/(deepseek|yi-)/.test(modelKey)) return false
  if (providerKey === 'gemini') return true
  if (/gpt-(4o|4\.1|5|5\.)|gpt-5/.test(modelKey)) return true
  if (/doubao.*(vision|seed-1[.-]6)/.test(modelKey)) return true
  if (/glm-4(\.\d)?v/.test(modelKey)) return true
  return true
}
