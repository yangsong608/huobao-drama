/** V2 覆盖预设的纯定义：不依赖数据库，计划引擎和设置接口共用。 */
export type V2DialogueCoverage = 'continuous' | 'speaker_cut'
export type V2ReactionCoverage = 'information' | 'minimal' | 'always'
export type V2ActionSubjectPolicy = 'cut' | 'follow'
export type V2CloseUpBias = 'low' | 'balanced' | 'high'

export interface V2CoveragePreset {
  key: string
  name: string
  description: string
  dialogueCoverage: V2DialogueCoverage
  reactionCoverage: V2ReactionCoverage
  actionSubject: V2ActionSubjectPolicy
  closeUpBias: V2CloseUpBias
  /** 只用于验收提示，不是每镜时长配额。 */
  targetAverageSeconds: number
  guidance: string[]
  builtin: boolean
}

const BALANCED: V2CoveragePreset = {
  key: 'balanced',
  name: '平衡覆盖',
  description: 'Master 先建立空间，反打只给信息变化；反应镜只在改变判断/关系时切，动作跟随主体。',
  dialogueCoverage: 'continuous',
  reactionCoverage: 'information',
  actionSubject: 'cut',
  closeUpBias: 'balanced',
  targetAverageSeconds: 5,
  guidance: [
    '同一场先给 Master，空间和轴线一次建立，不靠每个说话人重新交代。',
    '换说话人不自动切；只有问题/解释、机位必须变化或时间容量超限时才切。',
    '反应镜必须有新的判断、情绪或关系信息，不能只做无信息的点头/看一眼。',
    '动作镜跟随主体；主体变化才另起，同一个人的连续动作留在同一镜。',
    '平均时长只做验收参考，不能为了接近目标值拉长或压缩任何一镜。',
  ],
  builtin: true,
}

const FAST: V2CoveragePreset = {
  key: 'fast',
  name: '短剧快节奏',
  description: '冲突优先、近景偏多；反应只保留改变关系的一瞬，开场尽快给问题。',
  dialogueCoverage: 'continuous',
  reactionCoverage: 'information',
  actionSubject: 'cut',
  closeUpBias: 'high',
  targetAverageSeconds: 4.5,
  guidance: [
    '开场先给冲突、异常或明确问题，不用环境铺陈占掉第一个节拍。',
    'Master 只负责建立必要空间，信息变化后优先反打或近景。',
    '反应镜只保留能改变关系、判断或情绪的瞬间；普通倾听不单独成镜。',
    '连续快问快答可以共镜，不按句数切；长台词按语义和容量决定是否另起。',
    '平均时长偏短，但不能牺牲原文动作/台词覆盖；没有内容的镜头直接删除。',
  ],
  builtin: true,
}

const DIALOGUE: V2CoveragePreset = {
  key: 'dialogue',
  name: '对话覆盖优先',
  description: '长对话保持 Master 稳定，反打少而准；动作不打断说话节拍。',
  dialogueCoverage: 'continuous',
  reactionCoverage: 'minimal',
  actionSubject: 'follow',
  closeUpBias: 'balanced',
  targetAverageSeconds: 6,
  guidance: [
    '对话戏优先保持 Master，让观众听清信息和关系变化。',
    '只在问题/解释、权力关系变化或空间必须重定位时切反打。',
    '听者的小动作尽量留在当前镜；只有形成独立信息时才单独成镜。',
    '动作跟随当前说话主体，不因背景人物经过而打断对话。',
    '长对话按语义节拍和真实音频容量拆，不按固定句数/字数拆。',
  ],
  builtin: true,
}

const REACTION: V2CoveragePreset = {
  key: 'reaction',
  name: '反应强调',
  description: '关系戏/群像戏强调听者反应；每个反应形成独立信息时切，近景比例高。',
  dialogueCoverage: 'continuous',
  reactionCoverage: 'always',
  actionSubject: 'cut',
  closeUpBias: 'high',
  targetAverageSeconds: 4.5,
  guidance: [
    '对话仍以信息为主，但每个听者反应都要判断是否带来新的关系信息。',
    '反应镜独立成镜时必须有明确主体和动作端点，不能只写“看了一眼”。',
    '群像场景先建立空间，再按反应主体切换，避免无依据左右翻转。',
    '连续反应属于同一主体/同一情绪节拍时可以共镜，不为每句都切。',
    '近景服务情绪和信息，不能机械覆盖所有台词。',
  ],
  builtin: true,
}

export const V2_COVERAGE_PRESETS: V2CoveragePreset[] = [BALANCED, FAST, DIALOGUE, REACTION]

export const DEFAULT_V2_COVERAGE_PRESET = BALANCED

export function findV2CoveragePreset(key: string | null | undefined): V2CoveragePreset | null {
  const normalized = String(key || '').trim()
  if (!normalized) return null
  return V2_COVERAGE_PRESETS.find(preset => preset.key === normalized) || null
}

export function isV2CoveragePresetKey(value: unknown): value is string {
  return typeof value === 'string' && V2_COVERAGE_PRESETS.some(preset => preset.key === value)
}