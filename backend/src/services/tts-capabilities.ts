/**
 * TTS 通道能力声明（设计 7.3.4）：前端据此隐藏不支持字段，后端生成时按 ignored 裁剪。
 */
import { isQwen191BaseModel, isQwen191Model } from './adapters/qwen-tts.js'
import { getAudioConfig, ttsTextLimit, type AudioConfig } from './tts.js'

export interface TtsCapability {
  provider: string
  model: string | null
  voicePrompt: boolean
  designInstruct: boolean
  emotion: boolean
  speed: boolean
  seed: boolean
  refAudio: boolean
  maxInputChars: number
  maxAuditionChars: number
  maxSpeechChars: number
  ignored: string[]
  note: string | null
}

export function capabilitiesFor(config: AudioConfig | null): TtsCapability {
  if (!config) {
    return {
      provider: 'none', model: null,
      voicePrompt: false, designInstruct: false, emotion: false, speed: false, seed: false, refAudio: false,
      maxInputChars: 0, maxAuditionChars: 300, maxSpeechChars: 2000,
      ignored: [], note: '未配置语音服务',
    }
  }
  const model = config.model || null
  const maxInputChars = ttsTextLimit(config.provider, config.model || '')
  if (config.provider === 'qwen3-tts') {
    const qwen191 = isQwen191Model(config.model || '')
    const base191 = isQwen191BaseModel(config.model || '')
    return {
      provider: config.provider,
      model,
      voicePrompt: !base191,
      designInstruct: !base191,
      emotion: true,
      speed: !qwen191,
      seed: qwen191,
      refAudio: !qwen191,
      maxInputChars,
      maxAuditionChars: 300,
      maxSpeechChars: 2000,
      ignored: qwen191 ? ['speed', 'emotion'] : base191 ? ['designInstruct', 'voicePrompt', 'refAudio'] : [],
      note: qwen191 ? '191 通道忽略 speed 与参考音频，情绪通过 instruct 表达' : null,
    }
  }
  return {
    provider: config.provider,
    model,
    voicePrompt: false,
    designInstruct: false,
    emotion: true,
    speed: true,
    seed: false,
    refAudio: false,
    maxInputChars,
    maxAuditionChars: 300,
    maxSpeechChars: 2000,
    ignored: ['voicePrompt', 'designInstruct', 'seed', 'refAudio'],
    note: '云语音以 external_voice_id 为主',
  }
}

export async function getTtsCapabilities(): Promise<TtsCapability> {
  return capabilitiesFor(await getAudioConfig())
}
