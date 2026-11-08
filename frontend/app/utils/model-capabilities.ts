/**
 * 模型级能力表（前端）— 与 backend/src/services/model-capabilities.ts 保持同一套规则。
 *
 * 分辨率档位必须按「当前选中模型」而不是「厂商」生成：
 * Seedance 2.0 mini/fast 最高 720p、标准版支持 1080p；H3 为 768P/2K，
 * H3-Lite/Max 为 480P/768P。未知模型按厂商默认能力兜底。
 */

export type VideoResolutionTier = '480p' | '720p' | '1080p'

const TIER_ORDER: VideoResolutionTier[] = ['480p', '720p', '1080p']

export interface VideoModelCapabilities {
  family: string
  resolutions: VideoResolutionTier[]
  vendorResolutions: Partial<Record<VideoResolutionTier, string>>
  minDuration: number
  maxDuration: number
  maxDurationByResolution?: Partial<Record<VideoResolutionTier, number>>
  referenceImages: number
  referenceVideos: number
  referenceAudios: number
  nativeAudio: boolean
  firstLastFrame: boolean
}

export interface VideoCapabilityOptions {
  /** 本地 MiniMax shim 可在 768P/2K 之外自行渲染 480P，云端不认这一档 */
  localShim?: boolean
}

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
  options: Partial<Pick<VideoModelCapabilities, 'minDuration' | 'maxDuration' | 'maxDurationByResolution' | 'referenceImages' | 'referenceVideos' | 'referenceAudios' | 'nativeAudio' | 'firstLastFrame'>> = {},
): VideoModelCapabilities {
  return {
    family,
    resolutions: sortTiers(resolutions),
    vendorResolutions,
    minDuration: options.minDuration ?? 2,
    maxDuration: options.maxDuration ?? 15,
    maxDurationByResolution: options.maxDurationByResolution,
    referenceImages: options.referenceImages ?? 0,
    referenceVideos: options.referenceVideos ?? 0,
    referenceAudios: options.referenceAudios ?? 0,
    nativeAudio: options.nativeAudio ?? false,
    firstLastFrame: options.firstLastFrame ?? false,
  }
}

function seedanceCapability(model: string): VideoModelCapabilities {
  const lower = model.toLowerCase()
  if (lower.startsWith('doubao-seedance-2-')) {
    const limited = lower.includes('-mini-') || lower.includes('-fast-')
    return build(
      limited ? 'seedance-2.0-fast' : 'seedance-2.0',
      limited ? ['480p', '720p'] : ['480p', '720p', '1080p'],
      { '480p': '480p', '720p': '720p', '1080p': '1080p' },
      { minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true, firstLastFrame: true },
    )
  }
  const isI2v = lower.includes('-i2v-')
  return build(
    'seedance-1.x',
    ['480p', '720p', '1080p'],
    { '480p': '480p', '720p': '720p', '1080p': '1080p' },
    { minDuration: 2, maxDuration: 12, referenceImages: isI2v ? 1 : 0, nativeAudio: false, firstLastFrame: isI2v },
  )
}

function minimaxCapability(model: string, options: VideoCapabilityOptions = {}): VideoModelCapabilities {
  const lower = model.toLowerCase()
  if (lower.includes('highspeed')) {
    return build('h3-highspeed', ['720p'], { '720p': '768P' }, {
      minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true, firstLastFrame: true,
    })
  }
  // 不能直接 includes('max')：MiniMax 品牌名会误命中 H3-Max
  const isLiteOrMax = lower.includes('h3-lite') || lower.includes('h3-max')
    || lower.includes('-lite') || lower.includes('-max')
  if (isLiteOrMax) {
    return build('h3-lite', ['480p', '720p'], { '480p': '480P', '720p': '768P' }, {
      minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true, firstLastFrame: true,
    })
  }
  // 本地 shim 有完整 480P 画布，标准 H3 在本地也可选 480p；云端仍只认 768P/2K
  // 音频/视频参考尚未接入 shim，声明为 0，避免 UI 让用户绑定后被后端拒绝
  // 24GB 单卡：720p 稳定上限 ~8s（209 帧），1080p 长时长必 OOM，直接不开档
  if (options.localShim) {
    return build('h3', ['480p', '720p'], { '480p': '480P', '720p': '768P' }, {
      minDuration: 4, maxDuration: 15, maxDurationByResolution: { '720p': 8 },
      referenceImages: 9, referenceVideos: 0, referenceAudios: 0, nativeAudio: true, firstLastFrame: true,
    })
  }
  return build('h3', ['720p', '1080p'], { '720p': '768P', '1080p': '2K' }, {
    minDuration: 4, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true, firstLastFrame: true,
  })
}

function aliyunCapability(model: string): VideoModelCapabilities {
  const lower = model.toLowerCase()
  if (lower.startsWith('wan3.0')) {
    return build('wan3.0', ['480p', '720p', '1080p'], { '480p': '480P', '720p': '720P', '1080p': '1080P' }, {
      minDuration: 2, maxDuration: 30, referenceImages: 10, referenceVideos: 5, referenceAudios: 5, nativeAudio: true, firstLastFrame: true,
    })
  }
  const isI2v = lower.includes('-i2v')
  return build('wan2.x', ['480p', '720p', '1080p'], { '480p': '480P', '720p': '720P', '1080p': '1080P' }, {
    minDuration: 5, maxDuration: 10, referenceImages: isI2v ? 1 : 0, nativeAudio: false, firstLastFrame: false,
  })
}

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
      { minDuration: 2, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: true, firstLastFrame: true })
  }
  if (providerKey === 'minimax') {
    return modelKey ? minimaxCapability(modelKey, options) : minimaxCapability('MiniMax-H3', options)
  }
  if (providerKey === 'aliyun') {
    return modelKey ? aliyunCapability(modelKey) : aliyunCapability('wan3.0-video')
  }
  return build('comfyui', ['480p', '720p', '1080p'], { '480p': '480p', '720p': '720p', '1080p': '1080p' },
    { minDuration: 2, maxDuration: 15, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, nativeAudio: false, firstLastFrame: true })
}

/** 当前分辨率下的时长上限（无按分辨率限制时回退模型全局上限） */
export function videoMaxDuration(
  provider?: string | null,
  model?: string | null,
  resolution?: string | null,
  options: VideoCapabilityOptions = {},
): number {
  const capability = videoModelCapabilities(provider, model, options)
  const tier = videoResolutionTier(resolution)
  if (tier) {
    const limit = capability.maxDurationByResolution?.[tier]
    if (limit != null) return limit
  }
  return capability.maxDuration
}

/** 文本模型是否具备视觉理解能力（风格分析下拉过滤用） */
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

/** 图片模型是否支持参考图（用于设置页提示，提交前由后端再次校验） */
export function imageModelSupportsReferenceImages(provider?: string | null, model?: string | null): boolean {
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim().toLowerCase()
  if (providerKey === 'aliyun') return modelKey.includes('edit')
  // 只排除已知不支持参考图的 DALL·E；自定义/本地兼容端点使用其他模型名时放行
  if (providerKey === 'openai') return !/dall-e|dall·e/.test(modelKey)
  if (providerKey === 'gemini') return modelKey.includes('image')
  if (providerKey === 'volcengine') return modelKey.includes('seedream')
  return true
}
