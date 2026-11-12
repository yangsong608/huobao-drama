/**
 * 视频提示词的声音分区（第四步产物）
 *
 * 声音是场景/剧情级设计：完整 BGM 主题、乐器、强度曲线只存在于声音计划；
 * 单镜提示词只写短增量（延续 / 本镜新增 / 淡出 / 静默），禁止逐镜重复完整风格。
 */
export interface SoundSection {
  bgm: string
  ambience: string
  sfx: string
  silence: string
}

type SoundLanguage = 'zh' | 'en' | 'ja' | 'ko'

const SOUND_LABELS: Record<SoundLanguage, { sound: string; bgm: string; ambience: string; sfx: string; silence: string; fallback: string }> = {
  zh: { sound: '声音', bgm: 'BGM', ambience: '环境声', sfx: '音效', silence: '静默', fallback: '延续上一镜声音' },
  en: { sound: 'Sound', bgm: 'BGM', ambience: 'Ambience', sfx: 'SFX', silence: 'Silence', fallback: 'continue previous sound' },
  ja: { sound: '音響', bgm: 'BGM', ambience: '環境音', sfx: '効果音', silence: '静寂', fallback: '前のカットの音響を継続' },
  ko: { sound: '사운드', bgm: 'BGM', ambience: '환경음', sfx: '효과음', silence: '정적', fallback: '이전 컷 사운드 계속' },
}

const SOUND_PHRASES: Record<SoundLanguage, {
  continueAmbience: string
  continueBgm: string
  bgmEnter: string
  noBgm: string
  noAmbience: string
  silence: string
}> = {
  zh: { continueAmbience: '延续当前环境声，不重启', continueBgm: '延续当前 BGM，不重启', bgmEnter: '本镜进入', noBgm: '无', noAmbience: '无', silence: '本镜静默' },
  en: { continueAmbience: 'continue current ambience, do not restart', continueBgm: 'continue current BGM, do not restart', bgmEnter: 'enters this shot', noBgm: 'none', noAmbience: 'none', silence: 'this shot is silent' },
  ja: { continueAmbience: '現在の環境音を継続、再開しない', continueBgm: '現在の BGM を継続、再開しない', bgmEnter: 'このカットから開始', noBgm: 'なし', noAmbience: 'なし', silence: 'このカットは静寂' },
  ko: { continueAmbience: '현재 환경음 계속, 재시작 없음', continueBgm: '현재 BGM 계속, 재시작 없음', bgmEnter: '이 샷에서 시작', noBgm: '없음', noAmbience: '없음', silence: '이 샷은 정적' },
}

function labelsFor(language?: string | null) {
  return SOUND_LABELS[(language as SoundLanguage) || 'zh'] || SOUND_LABELS.zh
}

const SOUND_LINE_RE = /^\s*(?:声音|Sound|音響|사운드)\s*[：:]\s*(.*)$/im
const BGM_RE = /(?:BGM|背景音乐|配乐|音楽|음악)\s*[：:]\s*([^；;\n]*)/i
const AMBIENCE_RE = /(?:环境声|环境音|环境声音|Ambience|Ambient|環境音|환경음)\s*[：:]\s*([^；;\n]*)/i
const SFX_RE = /(?:音效|画内音效|效果声|SFX|効果音|효과음)\s*[：:]\s*([^；;\n]*)/i
const SILENCE_RE = /(?:静默|安静|silence|静寂|정적)\s*[：:]\s*([^；;\n]*)/i
const NEGATIVE_RE = /^\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i

export function parseSoundSection(prompt: string | null | undefined): SoundSection | null {
  const text = String(prompt || '')
  const line = SOUND_LINE_RE.exec(text)
  if (!line) return null
  const body = line[1].trim()
  return {
    bgm: (BGM_RE.exec(body)?.[1] || '').trim(),
    ambience: (AMBIENCE_RE.exec(body)?.[1] || '').trim(),
    sfx: (SFX_RE.exec(body)?.[1] || '').trim(),
    silence: (SILENCE_RE.exec(body)?.[1] || '').trim(),
  }
}

export function buildSoundLine(section: Partial<SoundSection>, language?: string | null): string {
  const labels = labelsFor(language)
  const parts: string[] = []
  if (section.bgm?.trim()) parts.push(`${labels.bgm}：${section.bgm.trim()}`)
  if (section.ambience?.trim()) parts.push(`${labels.ambience}：${section.ambience.trim()}`)
  if (section.sfx?.trim()) parts.push(`${labels.sfx}：${section.sfx.trim()}`)
  if (section.silence?.trim()) parts.push(`${labels.silence}：${section.silence.trim()}`)
  return `${labels.sound}：${parts.length ? parts.join('；') : labels.fallback}`
}

/** 替换已有声音分区；没有时插到负面约束之前，永不生成第二条声音行 */
export function setSoundSection(prompt: string, section: Partial<SoundSection>, language?: string | null): string {
  const text = String(prompt || '')
  const line = buildSoundLine(section, language)
  if (SOUND_LINE_RE.test(text)) return text.replace(SOUND_LINE_RE, line)
  const lines = text.split(/\r?\n/)
  const negativeIndex = lines.findIndex(item => NEGATIVE_RE.test(item))
  if (negativeIndex >= 0) lines.splice(negativeIndex, 0, line)
  else lines.push(line)
  return lines.join('\n')
}

export function removeSoundSection(prompt: string): string {
  return String(prompt || '').replace(/^\s*(?:声音|Sound|音響|사운드)\s*[：:].*(?:\r?\n|$)/im, '')
}

export interface ShotSoundCue {
  kind: 'bgm' | 'ambience' | 'sfx' | 'silence'
  from_shot_number: number
  to_shot_number: number
  description: string
  intensity?: string | null
  entry?: string | null
  exit?: string | null
}

export interface ShotSoundDeltaInput {
  shotNumber: number
  delivery: 'native' | 'post'
  cues: ShotSoundCue[]
  language?: string | null
}

/** 由声音计划派生单镜短增量；不返回完整 BGM 风格 */
export function buildShotSoundDelta(input: ShotSoundDeltaInput): SoundSection {
  const phrases = SOUND_PHRASES[(input.language as SoundLanguage) || 'zh'] || SOUND_PHRASES.zh
  const cues = input.cues.filter(cue =>
    cue.from_shot_number <= input.shotNumber && cue.to_shot_number >= input.shotNumber)
  const bgm = cues.filter(cue => cue.kind === 'bgm')
  const ambience = cues.filter(cue => cue.kind === 'ambience')
  const sfx = cues.filter(cue => cue.kind === 'sfx')
  const silence = cues.filter(cue => cue.kind === 'silence')

  const section: SoundSection = { bgm: '', ambience: '', sfx: '', silence: '' }

  if (silence.length) {
    section.silence = silence.map(cue => cue.description).join('、') || phrases.silence
    if (input.delivery === 'native') section.bgm = phrases.noBgm
    return section
  }

  if (ambience.length) {
    const startsHere = ambience.some(cue => cue.from_shot_number === input.shotNumber)
    const text = (startsHere
      ? ambience.filter(cue => cue.from_shot_number === input.shotNumber)
      : ambience
    ).map(cue => cue.description).join('；')
    section.ambience = startsHere ? text : phrases.continueAmbience
  } else {
    section.ambience = phrases.noAmbience
  }

  if (input.delivery === 'native' && bgm.length) {
    const startsHere = bgm.some(cue => cue.from_shot_number === input.shotNumber)
    const text = bgm.map(cue => cue.description).join('；')
    if (startsHere) {
      section.bgm = `${phrases.bgmEnter}：${text}${bgm[0]?.entry ? `（${bgm[0].entry}）` : ''}`
    } else {
      section.bgm = phrases.continueBgm
    }
  } else if (input.delivery === 'native') {
    section.bgm = phrases.noBgm
  }

  if (sfx.length) section.sfx = sfx.map(cue => cue.description).join('；')
  return section
}
