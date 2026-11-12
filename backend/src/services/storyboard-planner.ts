/**
 * 分镜拆分主算法（确定性）
 *
 * 顺序固定为：台词 → 场景 → 说话人 → 节拍 → 分镜。
 * - 台词：先识别格式化台词行与带说话提示的引号，台词是不可再分的原子；
 * - 场景：按场次头切块并绑定 canonical scene_id；无场次头时承接上一镜场景；
 * - 说话人：一个分镜只允许一个说话人，换人必须换镜；
 * - 节拍：每个动作句/台词行是一个节拍，长台词在标点处切开；
 * - 分镜：按 6-15 秒与台词容量组装，动作只做同镜衔接，不跨场/不跨说话人。
 *
 * 模型只负责补动作摘要、角色/道具和画面常量，不再决定拆分边界；
 * 保存工具会把 source_excerpt/duration/speech_segments 锁定为本算法的结果。
 */
import { findQuotedSpans } from './dialogue-lines.js'
import type { CanonicalSceneGroup } from './scene-canonical.js'
import { canonicalSceneKey } from './scene-canonical.js'
import { extractPlanSpeechSegments, type PlanSceneContract, type PlanShot, type PlanSpeechSegment } from './storyboard-plan-contract.js'

export interface PlannerPreviousShot {
  shotNumber: number
  sceneId: number | null
  location: string | null
  time?: string | null
  screenLeft?: string | null
  screenRight?: string | null
  axisSide?: string | null
  landmarkSide?: string | null
}

export interface StoryboardPlannerInput {
  script: string
  shotStart: number
  sceneGroups?: CanonicalSceneGroup[]
  previousShot?: PlannerPreviousShot | null
  sceneContracts?: Map<number, PlanSceneContract>
  minDuration?: number
  maxDuration?: number
}

export interface PlannedStoryboardShot extends PlanShot {
  storyboardNumber: number
  sceneLabel: string
  time: string | null
  titleHint: string
  summaryHint: string
  transition: string
  speaker: string | null
  segmentKind: 'dialogue' | 'action' | 'reaction'
  /** 本场第一个镜头且没有现成契约：由本镜建立画面常量 */
  establishesScene: boolean
}

export interface StoryboardPlanResult {
  shots: PlannedStoryboardShot[]
  coverage: number
  sceneCount: number
  sourceChars: number
}

interface SceneBlock {
  label: string
  sceneType: string
  location: string
  time: string
  sceneId: number | null
  bodyStart: number
  bodyEnd: number
}

interface RawBeat {
  start: number
  end: number
  text: string
  kind: 'dialogue' | 'action'
  speaker: string
  dialogueText: string
  sourceQuote: string
  contentStart: number
  contentEnd: number
  fragment: boolean
  paragraph: number
  scene: SceneBlock
}

interface DraftShot {
  beats: RawBeat[]
  scene: SceneBlock
}

const HEADER_RE = /^#{1,4}\s*(?:S\s*\d+|第\s*\d+\s*场|场景\s*[0-9一二三四五六七八九十百]+)\b.*$/i
const SCRIPT_SPEAKER_RE = /^\s*(?:@)?([\u4e00-\u9fa5A-Za-z0-9·（）()\-]{1,16})\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*(.+?)\s*$/
const META_SPEAKER_RE = /^(?:出场人物|场景|画面调度|画面左|画面右|过肩|背景地标|轴线|动作|动作起点|动作终点|时间帧|负面约束|负面调度|镜头|时长|转场|连续性|声音|BGM|环境声|音效|字幕|标题|注|说明|来源|原文|摘录|source|location|time|duration|transition|continuity|action|sound|negative|characters|scene|style|audio)$/i
const NARRATION_RE = /旁白|画外音|心声|内心独白|narration|voice[\s-]?over|inner\s+voice/i
const SPEECH_TAIL_RE = /(?:说|道|问|喊|答|叫|嚷|吼|骂|开口|低声|轻声|高声|沉声|冷声|怒声|嘟囔|吆喝|唱喝|笑道|急道|叹道|招呼)[^，。！？!?]{0,12}[：:]?\s*$/
const SPEAKER_TAIL_RE = /(?:^|[，,。；;])\s*(?:@)?([\u4e00-\u9fa5A-Za-z0-9·]{1,16})\s*(?:[（(][^）)]*[）)])?\s*(?:说|道|问|喊|答|叫|嚷|吼|骂|开口|低声|轻声|高声|沉声|冷声|怒声|嘟囔|吆喝|唱喝|笑道|急道|叹道|招呼)[^，。！？!?]{0,12}[：:]?\s*$/
const COLON_TAIL_RE = /(?:^|[，,。；;])\s*(?:@)?([\u4e00-\u9fa5A-Za-z0-9·]{1,16})\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*$/
const SIGNBOARD_RE = /(?:写|印|刻|绣|标|题|显示|上书|挂着|贴着)[^，。！？]{0,8}[：:]?\s*$/
const TERMINAL_RE = /[。！？!?…]/
const CLAUSE_RE = /[^，。！？；,.!?;]+[，。！？；,.!?;]?/g
const SENTENCE_RE = /[^。！？!?…\n]+[。！？!?…]*/g
const INTERNAL_ACTION_RE = /(心酸|失落|渐弱|愈发|自觉|无趣|吃味|得意|紧张|害怕|高兴|难过|愤怒|委屈|不甘|眼红|心里|心中|暗想|心想|盘算|寻思|琢磨)/
const INNER_MONOLOGUE_SPEAKER_RE = /(?:心里|心中|暗想|心想|盘算|寻思|琢磨|内心|心声|独白)/
const NARRATIVE_SPEAKER_RE = /[的了着这那他她它我你更也都就才又还却的是]/
const SPEECH_LEAD_IN_BEAT_RE = /(?:唱喝|唱喏|吆喝|叫卖|揽客|说道|问道|答道|喊道|叫道|嚷道|吼道|骂道|开口道|开口|急道|笑道|叹道|继续道|接道|道|说|问|喊|叫)\s*[。！？!?…]*$/
const INDOOR_ENTRY_RE = /(?:回|走进|走入|进了|进入)(?:了)?(?:店|屋|堂|里间|厨房|后院)(?:内|里)?/
const OUTDOOR_LOCATION_RE = /(街|市|广场|门外|巷|路)/

function nonWsLength(value: string) {
  return String(value || '').replace(/\s+/g, '').length
}

function effectiveChars(value: string) {
  return String(value || '').replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length
}

function speechSeconds(value: string) {
  return Math.max(1, Math.ceil(effectiveChars(value) / 4))
}

function actionSeconds(value: string) {
  return Math.max(1, Math.ceil(effectiveChars(value) * 0.12))
}

/** 与计划门禁 normalizeText 对齐：去舞台提示和空白，保留省略号/破折号原样 */
function normalizeDialogueText(raw: string) {
  return String(raw || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/@/g, '')
    .replace(/^[「『“"]|[」』”"]$/g, '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
}

function trimSpan(source: string, start: number, end: number): { start: number; end: number; text: string } {
  let a = Math.max(0, start)
  let b = Math.max(a, end)
  while (a < b && /\s/.test(source[a])) a += 1
  while (b > a && /\s/.test(source[b - 1])) b -= 1
  return { start: a, end: b, text: source.slice(a, b) }
}

function parseHeader(line: string): { label: string; sceneType: string; location: string; time: string } | null {
  const content = line.replace(/^#+\s*/, '').trim()
  if (!content) return null
  const parts = content.split(/[|｜]/).map(item => item.trim()).filter(Boolean)
  const label = parts[0]?.slice(0, 24) || '场次'
  if (parts.length >= 2) {
    const scene = parts[1]
    const pieces = scene.split(/[·・]/).map(item => item.trim()).filter(Boolean)
    const sceneType = pieces.length > 1 ? pieces[0] : ''
    const location = pieces.length > 1 ? pieces.slice(1).join('·') : scene
    return { label, sceneType, location, time: parts[2] || '' }
  }
  const rest = content.replace(/^(?:S\s*\d+|第\s*\d+\s*场|场景\s*[0-9一二三四五六七八九十百]+)\s*[:：]?\s*/i, '').trim()
  const head = rest.split(/\s+/).filter(Boolean)
  return { label, sceneType: '', location: head[0] || '', time: head[1] || '' }
}

/** 拆分器只做可信的场景绑定：精确匹配优先；内/外景过滤后按使用量选唯一 canonical，绝不把「大堂」错配成「门前」。 */
function resolvePlannerScene(location: string, sceneType: string, groups: CanonicalSceneGroup[]): CanonicalSceneGroup | null {
  const key = canonicalSceneKey(location)
  if (!key) return null
  const exact = groups.find(group => group.key === key)
  if (exact) return exact
  const candidates = groups.filter(group => group.key.startsWith(key) || key.startsWith(group.key))
  if (!candidates.length) return null
  const interior = /内景|日内|夜内|INT/i.test(sceneType)
  const outdoor = /外景|日外|夜外|EXT/i.test(sceneType)
  if (!interior && !outdoor) return null
  const outdoorSuffix = /(门前|门口|门外|街上|街头|街口|广场|巷|山|野外|码头|城外|院外)/
  const indoorSuffix = /(大堂|店内|柜台|内|堂|室|房|楼|厅|馆|铺|后院)/
  const filtered = candidates.filter(group => {
    if (interior) return !outdoorSuffix.test(group.key) && indoorSuffix.test(group.key)
    return outdoorSuffix.test(group.key) || !indoorSuffix.test(group.key)
  })
  if (!filtered.length) return null
  return [...filtered].sort((a, b) => b.usage - a.usage)[0] || null
}

function sceneBlocks(script: string, sceneGroups: CanonicalSceneGroup[], previousShot?: PlannerPreviousShot | null): SceneBlock[] {
  const headers: Array<{ start: number; end: number; info: NonNullable<ReturnType<typeof parseHeader>> }> = []
  for (const match of script.matchAll(/^.*$/gm)) {
    const line = match[0]
    if (!HEADER_RE.test(line.trim())) continue
    const info = parseHeader(line)
    if (!info) continue
    const start = match.index ?? 0
    headers.push({ start, end: start + line.length, info })
  }
  const previousScene: SceneBlock | null = previousShot?.sceneId != null ? {
    label: '承接上一场',
    sceneType: '',
    location: previousShot.location || '',
    time: previousShot.time || '',
    sceneId: previousShot.sceneId,
    bodyStart: 0,
    bodyEnd: script.length,
  } : null
  if (!headers.length) {
    return previousScene ? [previousScene] : [{
      label: '本段',
      sceneType: '',
      location: '',
      time: '',
      sceneId: null,
      bodyStart: 0,
      bodyEnd: script.length,
    }]
  }
  const blocks: SceneBlock[] = []
  const preambleEnd = headers[0].start
  if (preambleEnd > 0 && script.slice(0, preambleEnd).trim()) {
    // 分块可能从上一场中间开始：场次头之前的正文必须归入承接场景，不能丢。
    blocks.push(previousScene
      ? { ...previousScene, bodyStart: 0, bodyEnd: preambleEnd }
      : {
          label: '承接上一场',
          sceneType: '',
          location: '',
          time: '',
          sceneId: null,
          bodyStart: 0,
          bodyEnd: preambleEnd,
        })
  }
  headers.forEach((header, index) => {
    const bodyStart = header.end + (script[header.end] === '\n' ? 1 : 0)
    const bodyEnd = index + 1 < headers.length ? headers[index + 1].start : script.length
    const group = resolvePlannerScene(header.info.location, header.info.sceneType, sceneGroups)
    blocks.push({
      label: header.info.label,
      sceneType: header.info.sceneType,
      location: group?.name || header.info.location,
      time: header.info.time,
      sceneId: group?.canonicalId ?? null,
      bodyStart,
      bodyEnd,
    })
  })
  return blocks
}

function makeBeat(input: {
  start: number
  end: number
  text: string
  kind: 'dialogue' | 'action'
  speaker: string
  dialogueText: string
  sourceQuote: string
  contentStart: number
  contentEnd: number
  fragment: boolean
  paragraph: number
  scene: SceneBlock
}): RawBeat {
  return input
}

/** 从台词正文中带偏移地按标点切片；单片刻度超过上限时再硬切。 */
function splitDialogueContent(source: string, start: number, end: number, maxChars: number): Array<{ start: number; end: number; text: string }> {
  const pieces: Array<{ start: number; end: number; text: string }> = []
  const content = source.slice(start, end)
  let cursor = 0
  let bufferStart = 0
  let bufferChars = 0
  for (const match of content.matchAll(CLAUSE_RE)) {
    const clause = match[0]
    const clauseStart = match.index ?? cursor
    const clauseEnd = clauseStart + clause.length
    const chars = effectiveChars(clause)
    if (bufferChars > 0 && bufferChars + chars > maxChars) {
      const span = trimSpan(source, start + bufferStart, start + clauseStart)
      if (span.text) pieces.push(span)
      bufferStart = clauseStart
      bufferChars = 0
    }
    if (chars > maxChars) {
      const span = trimSpan(source, start + bufferStart, start + clauseStart)
      if (span.text) pieces.push(span)
      let localStart = clauseStart
      while (localStart < clauseEnd) {
        let localEnd = Math.min(clauseEnd, localStart + maxChars)
        while (localEnd > localStart && effectiveChars(source.slice(start + localStart, start + localEnd)) > maxChars) localEnd -= 1
        if (localEnd <= localStart) localEnd = Math.min(clauseEnd, localStart + maxChars)
        const hard = trimSpan(source, start + localStart, start + localEnd)
        if (hard.text) pieces.push(hard)
        localStart = localEnd
      }
      bufferStart = clauseEnd
      bufferChars = 0
      cursor = clauseEnd
      continue
    }
    bufferChars += chars
    cursor = clauseEnd
  }
  const tail = trimSpan(source, start + bufferStart, end)
  if (tail.text) pieces.push(tail)
  return pieces
}

function dialogueBeats(input: {
  source: string
  lineStart: number
  textStart: number
  textEnd: number
  contentStart: number
  contentEnd: number
  speaker: string
  paragraph: number
  scene: SceneBlock
  maxSpeechChars: number
}): RawBeat[] {
  const { source, contentStart, contentEnd, speaker, scene } = input
  const raw = source.slice(contentStart, contentEnd).trim()
  if (!raw) return []
  const dialogueText = normalizeDialogueText(raw)
  if (!effectiveChars(dialogueText)) return []
  if (effectiveChars(raw) <= input.maxSpeechChars) {
    const span = trimSpan(source, input.textStart, input.textEnd)
    return [makeBeat({
      start: span.start,
      end: span.end,
      text: span.text,
      kind: 'dialogue',
      speaker,
      dialogueText,
      sourceQuote: raw,
      contentStart,
      contentEnd,
      fragment: false,
      paragraph: input.paragraph,
      scene,
    })]
  }
  const pieces = splitDialogueContent(source, contentStart, contentEnd, input.maxSpeechChars)
  return pieces.map((piece, index) => {
    const start = index === 0 ? input.lineStart : piece.start
    const span = trimSpan(source, start, piece.end)
    return makeBeat({
      start: span.start,
      end: span.end,
      text: span.text,
      kind: 'dialogue',
      speaker,
      dialogueText: normalizeDialogueText(piece.text),
      sourceQuote: piece.text,
      contentStart: piece.start,
      contentEnd: piece.end,
      fragment: true,
      paragraph: input.paragraph,
      scene,
    })
  }).filter(beat => effectiveChars(beat.dialogueText) > 0)
}

function sentenceSpans(source: string, start: number, end: number): Array<{ start: number; end: number; text: string }> {
  const result: Array<{ start: number; end: number; text: string }> = []
  const text = source.slice(start, end)
  for (const match of text.matchAll(SENTENCE_RE)) {
    const span = trimSpan(source, start + (match.index ?? 0), start + (match.index ?? 0) + match[0].length)
    if (span.text) result.push(span)
  }
  return result
}

function speakerBefore(text: string): { speaker: string; spoken: boolean } {
  const tail = text.slice(-40)
  if (NARRATION_RE.test(tail)) return { speaker: '旁白', spoken: true }
  if (SIGNBOARD_RE.test(tail)) return { speaker: '', spoken: false }
  const speech = tail.match(SPEAKER_TAIL_RE)
  if (speech?.[1]) return { speaker: speech[1].replace(/^@/, ''), spoken: true }
  const colon = tail.match(COLON_TAIL_RE)
  if (colon?.[1]) return { speaker: colon[1].replace(/^@/, ''), spoken: true }
  if (SPEECH_TAIL_RE.test(tail)) return { speaker: '', spoken: true }
  return { speaker: '', spoken: false }
}

function inlineBeats(input: {
  source: string
  span: { start: number; end: number; text: string }
  paragraph: number
  scene: SceneBlock
  maxSpeechChars: number
}): RawBeat[] {
  const { source, span } = input
  const quotes = findQuotedSpans(span.text).filter(quote => {
    const before = span.text.slice(0, quote.start)
    const tail = before.slice(-40)
    if (SIGNBOARD_RE.test(tail)) return false
    const spoken = speakerBefore(before)
    const inner = String(quote.inner || '')
    if (NARRATION_RE.test(tail)) return inner.length > 0
    if (spoken.spoken) return inner.length > 0
    return inner.replace(/\s/g, '').length >= 3 && /[。！？!?…，,；;]/.test(inner)
  })
  if (!quotes.length) {
    return [makeBeat({
      start: span.start,
      end: span.end,
      text: span.text,
      kind: 'action',
      speaker: '',
      dialogueText: '',
      sourceQuote: '',
      contentStart: span.start,
      contentEnd: span.end,
      fragment: false,
      paragraph: input.paragraph,
      scene: input.scene,
    })]
  }
  const beats: RawBeat[] = []
  let cursor = 0
  for (const quote of quotes) {
    const prefix = trimSpan(source, span.start + cursor, span.start + quote.start)
    if (prefix.text) {
      beats.push(makeBeat({
        start: prefix.start,
        end: prefix.end,
        text: prefix.text,
        kind: 'action',
        speaker: '',
        dialogueText: '',
        sourceQuote: '',
        contentStart: prefix.start,
        contentEnd: prefix.end,
        fragment: false,
        paragraph: input.paragraph,
        scene: input.scene,
      }))
    }
    const before = span.text.slice(0, quote.start)
    const tail = before.slice(-40)
    const spoken = speakerBefore(before)
    const speaker = NARRATION_RE.test(tail) ? '旁白' : spoken.speaker
    const innerStart = span.start + quote.start + 1
    const innerEnd = span.start + quote.end - 1
    beats.push(...dialogueBeats({
      source,
      lineStart: span.start + quote.start,
      textStart: span.start + quote.start,
      textEnd: span.start + quote.end,
      contentStart: innerStart,
      contentEnd: innerEnd,
      speaker,
      paragraph: input.paragraph,
      scene: input.scene,
      maxSpeechChars: input.maxSpeechChars,
    }))
    cursor = quote.end
  }
  const suffix = trimSpan(source, span.start + cursor, span.end)
  if (suffix.text) {
    beats.push(makeBeat({
      start: suffix.start,
      end: suffix.end,
      text: suffix.text,
      kind: 'action',
      speaker: '',
      dialogueText: '',
      sourceQuote: '',
      contentStart: suffix.start,
      contentEnd: suffix.end,
      fragment: false,
      paragraph: input.paragraph,
      scene: input.scene,
    }))
  }
  return beats
}

function parseSceneBeats(script: string, scene: SceneBlock, maxSpeechChars: number): RawBeat[] {
  const beats: RawBeat[] = []
  let paragraph = 0
  const body = script.slice(scene.bodyStart, scene.bodyEnd)
  for (const lineMatch of body.matchAll(/^.*$/gm)) {
    const line = lineMatch[0]
    const lineStart = scene.bodyStart + (lineMatch.index ?? 0)
    if (!line.trim()) {
      paragraph += 1
      continue
    }
    const scriptMatch = line.match(SCRIPT_SPEAKER_RE)
    if (scriptMatch) {
      const speaker = scriptMatch[1].replace(/^@/, '').trim()
      const content = scriptMatch[2].trim()
      const narrativeColon = NARRATIVE_SPEAKER_RE.test(speaker) && !INNER_MONOLOGUE_SPEAKER_RE.test(speaker)
      if (!speaker || META_SPEAKER_RE.test(speaker) || narrativeColon || /^\d+(?:-\d+)?秒?$/.test(speaker) || !content) {
        // 继续按普通叙述处理；「更不对的是姿态：」这类冒号不是台词
      } else {
        const contentStart = lineStart + line.lastIndexOf(content)
        const contentEnd = contentStart + content.length
        beats.push(...dialogueBeats({
          source: script,
          lineStart,
          textStart: lineStart,
          textEnd: lineStart + line.length,
          contentStart,
          contentEnd,
          speaker: INNER_MONOLOGUE_SPEAKER_RE.test(speaker) || NARRATION_RE.test(speaker) ? '旁白' : speaker,
          paragraph,
          scene,
          maxSpeechChars,
        }))
        paragraph += 1
        continue
      }
    }
    for (const span of sentenceSpans(script, lineStart, lineStart + line.length)) {
      beats.push(...inlineBeats({ source: script, span, paragraph, scene, maxSpeechChars }))
    }
    paragraph += 1
  }
  return beats
}

function isSpeechCueText(text: string): boolean {
  const value = String(text || '').trim()
  return effectiveChars(value) <= 30 && SPEECH_LEAD_IN_BEAT_RE.test(value)
}

function isSpeechLeadInBeat(text: string): boolean {
  const value = String(text || '').trim()
  return effectiveChars(value) <= 12 && SPEECH_LEAD_IN_BEAT_RE.test(value)
}

function beatWeight(beat: RawBeat): number {
  if (beat.kind === 'dialogue') return speechSeconds(beat.dialogueText) + 0.5
  // “马伯急道。”这类开口提示是台词的同镜引子，不再按整句动作占时长。
  return isSpeechLeadInBeat(beat.text) ? 0.5 : actionSeconds(beat.text)
}

function shotWeight(beats: RawBeat[]): number {
  return beats.reduce((sum, beat) => sum + beatWeight(beat), 0)
}

function dialogueSpeakers(beats: RawBeat[]): string[] {
  return [...new Set(beats.filter(beat => beat.kind === 'dialogue').map(beat => beat.speaker))]
}

function canMergeShots(left: DraftShot, right: DraftShot, maxDuration: number): boolean {
  if (left.scene !== right.scene) return false
  if (shotWeight([...left.beats, ...right.beats]) > maxDuration) return false
  const leftSpeakers = dialogueSpeakers(left.beats)
  const rightSpeakers = dialogueSpeakers(right.beats)
  if (!leftSpeakers.length || !rightSpeakers.length) return true
  if (leftSpeakers.length > 1 || rightSpeakers.length > 1) return false
  return leftSpeakers[0] === rightSpeakers[0]
}

function groupShots(beats: RawBeat[], maxDuration: number): DraftShot[] {
  const shots: DraftShot[] = []
  let current: RawBeat[] = []
  let currentScene: SceneBlock | null = null
  const flush = () => {
    if (!current.length || !currentScene) return
    shots.push({ beats: current, scene: currentScene })
    current = []
    currentScene = null
  }
  const startNewShot = (beat: RawBeat) => {
    let carry: RawBeat[] = []
    if (beat.kind === 'dialogue' && current.length) {
      const tail = current[current.length - 1]
      // 开口提示归下一镜：无论当前镜是否已有台词，都不能把“唱喝/吆喝/说道”留在上一镜。
      if (tail.kind === 'action' && isSpeechCueText(tail.text)) {
        carry = [tail]
        current = current.slice(0, -1)
      }
    }
    flush()
    current = [...carry, beat]
    currentScene = beat.scene
  }
  let overrideSource: SceneBlock | null = null
  let overrideScene: SceneBlock | null = null
  for (let beat of beats) {
    if (overrideSource && beat.scene !== overrideSource) {
      overrideSource = null
      overrideScene = null
    }
    if (overrideScene && beat.scene === overrideSource) {
      beat = { ...beat, scene: overrideScene }
    } else if (beat.kind === 'action' && OUTDOOR_LOCATION_RE.test(beat.scene.location) && INDOOR_ENTRY_RE.test(beat.text)) {
      // 室外镜头里出现“回店里/走进店”等入口动作：从本动作起切成室内镜头，室内 scene_id 交给修补阶段绑定。
      flush()
      overrideSource = beat.scene
      overrideScene = { ...beat.scene, sceneId: null, location: '室内（待绑定）' }
      beat = { ...beat, scene: overrideScene }
      current = [beat]
      currentScene = overrideScene
      continue
    }
    if (!current.length) {
      current = [beat]
      currentScene = beat.scene
      continue
    }
    const sceneChanged = currentScene !== beat.scene
    const projected = shotWeight([...current, beat])
    const speakers = dialogueSpeakers(current)
    if (sceneChanged) {
      flush()
      current = [beat]
      currentScene = beat.scene
      continue
    }
    if (beat.kind === 'action') {
      const actionCount = current.filter(item => item.kind === 'action').length
      const limit = current.some(item => item.kind === 'dialogue') ? 2 : 3
      if (actionCount >= limit) {
        flush()
        current = [beat]
        currentScene = beat.scene
        continue
      }
    }
    if (beat.kind === 'dialogue' && speakers.length) {
      const tail = current[current.length - 1]
      const carrySpeechCue = tail?.kind === 'action'
        && current.some(item => item.kind === 'dialogue')
        && isSpeechCueText(tail.text)
      const sameSpeaker = speakers.length === 1 && beat.speaker && speakers[0] === beat.speaker
      if (carrySpeechCue || !sameSpeaker) {
        startNewShot(beat)
        continue
      }
    }
    if (projected > maxDuration) {
      if (beat.kind === 'dialogue') startNewShot(beat)
      else {
        flush()
        current = [beat]
        currentScene = beat.scene
      }
      continue
    }
    current.push(beat)
  }
  flush()

  // 短镜优先和相邻同场、同说话人的镜头合并；不跨说话人。
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < shots.length - 1; index += 1) {
      const left = shots[index]
      const right = shots[index + 1]
      if (!canMergeShots(left, right, maxDuration)) continue
      if (shotWeight(left.beats) >= 6 && shotWeight(right.beats) >= 6) continue
      shots[index] = { beats: [...left.beats, ...right.beats], scene: left.scene }
      shots.splice(index + 1, 1)
      changed = true
      break
    }
  }
  return shots
}

function visibleAction(value: string): string | null {
  const text = String(value || '').trim()
  if (!text || INTERNAL_ACTION_RE.test(text)) return null
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

function actionEndpoint(beats: RawBeat[], from: 'start' | 'end'): string | null {
  const actions = beats.filter(beat => beat.kind === 'action')
  if (!actions.length) return null
  // 台词前的动作用起点，台词后的动作用终点；只有一侧时两边共用。
  const ordered = from === 'start' ? actions : [...actions].reverse()
  for (const beat of ordered) {
    const value = visibleAction(beat.text)
    if (value) return value
  }
  return null
}

function speechSegmentsOf(beats: RawBeat[]): PlanSpeechSegment[] {
  return beats
    .filter(beat => beat.kind === 'dialogue' && beat.dialogueText)
    .map((beat, index) => ({
      speaker: beat.speaker,
      text: beat.dialogueText,
      sourceQuote: beat.sourceQuote,
      order: index + 1,
    }))
}

function sidesForScene(scene: SceneBlock, contracts?: Map<number, PlanSceneContract>): Pick<PlannedStoryboardShot,
  'screenLeft' | 'screenRight' | 'axisSide' | 'landmarkSide'> {
  const contract = scene.sceneId != null ? contracts?.get(scene.sceneId) : undefined
  if (!contract) return { screenLeft: null, screenRight: null, axisSide: null, landmarkSide: null }
  return {
    screenLeft: contract.screenLeft,
    screenRight: contract.screenRight,
    axisSide: contract.axisSide,
    landmarkSide: contract.landmarkSide,
  }
}

function titleOf(shot: DraftShot, speech: PlanSpeechSegment[]): string {
  if (speech.length) {
    const first = speech[0]
    return `${first.speaker || '对白'}：${first.text.slice(0, 14)}`
  }
  const action = shot.beats.find(beat => beat.kind === 'action')?.text || ''
  return action.replace(/\s+/g, ' ').slice(0, 18) || `第 ${shot.scene.label} 场`
}

function summaryOf(shot: DraftShot, speech: PlanSpeechSegment[]): string {
  if (speech.length) {
    const speaker = speech[0].speaker || '角色'
    const action = shot.beats.find(beat => beat.kind === 'action')?.text || ''
    return `${speaker}说话${action ? `；${action.replace(/\s+/g, ' ').slice(0, 28)}` : ''}`
  }
  return shot.beats.map(beat => beat.text).join(' ').replace(/\s+/g, ' ').slice(0, 40)
}

export function planStoryboardShots(input: StoryboardPlannerInput): StoryboardPlanResult {
  const script = String(input.script || '').replace(/\r\n?/g, '\n')
  if (!script.trim()) return { shots: [], coverage: 0, sceneCount: 0, sourceChars: 0 }
  const minDuration = Math.max(2, Math.min(15, input.minDuration ?? 6))
  const maxDuration = Math.max(minDuration, input.maxDuration ?? 15)
  const maxSpeechChars = Math.max(8, (maxDuration - 1) * 4)
  const scenes = sceneBlocks(script, input.sceneGroups || [], input.previousShot)
  const beats: RawBeat[] = []
  for (const scene of scenes) beats.push(...parseSceneBeats(script, scene, maxSpeechChars))
  if (!beats.length) return { shots: [], coverage: 0, sceneCount: scenes.length, sourceChars: nonWsLength(script) }
  const drafts = groupShots(beats, maxDuration)
  const shots: PlannedStoryboardShot[] = []
  let cursorShot = input.shotStart
  let previousSides: ReturnType<typeof sidesForScene> = input.previousShot ? {
    screenLeft: input.previousShot.screenLeft || null,
    screenRight: input.previousShot.screenRight || null,
    axisSide: input.previousShot.axisSide || null,
    landmarkSide: input.previousShot.landmarkSide || null,
  } : { screenLeft: null, screenRight: null, axisSide: null, landmarkSide: null }
  let previousSceneId: number | null = input.previousShot?.sceneId ?? null
  let previousLocation: string | null = input.previousShot?.location ?? null
  for (const draft of drafts) {
    const plannedSpeech = speechSegmentsOf(draft.beats)
    const first = draft.beats[0]
    const last = draft.beats[draft.beats.length - 1]
    const excerpt = trimSpan(script, first.start, last.end)
    const fragment = draft.beats.some(beat => beat.fragment)
    // 以门禁的提取结果为准，保证计划台词与摘录逐字一致；只有长台词切片段才保留拆分器台词。
    const extracted = extractPlanSpeechSegments(excerpt.text)
    const plannerSpeakerFor = (text: string) => (
      plannedSpeech.find(item => item.text.includes(text) || text.includes(item.text))?.speaker || ''
    )
    let speech: PlanSpeechSegment[]
    if (extracted.length) {
      const extras = fragment
        ? plannedSpeech.filter(item => (
            draft.beats.some(beat => beat.fragment && beat.dialogueText === item.text)
            && !extracted.some(source => source.text.includes(item.text) || item.text.includes(source.text))
          ))
        : []
      speech = [
        ...extracted.map((item, index) => ({
          ...item,
          speaker: item.speaker || plannerSpeakerFor(item.text),
          order: index + 1,
        })),
        ...extras.map((item, index) => ({ ...item, order: extracted.length + index + 1 })),
      ]
    } else if (fragment) {
      speech = plannedSpeech
    } else {
      speech = []
    }
    const speaker = speech.length ? [...new Set(speech.map(item => item.speaker).filter(Boolean))][0] || null : null
    const weight = shotWeight(draft.beats)
    const speechWeight = speech.reduce((sum, item) => sum + speechSeconds(item.text) + 1, 0)
    const duration = Math.min(maxDuration, Math.max(minDuration, Math.ceil(Math.max(weight, speechWeight))))
    const sceneSides = sidesForScene(draft.scene, input.sceneContracts)
    const sameScene = draft.scene.sceneId != null
      ? draft.scene.sceneId === previousSceneId
      : Boolean(previousLocation && draft.scene.location && draft.scene.location === previousLocation)
    const sides = (sameScene && (draft.scene.sceneId != null || previousLocation))
      ? {
          screenLeft: sceneSides.screenLeft || previousSides.screenLeft,
          screenRight: sceneSides.screenRight || previousSides.screenRight,
          axisSide: sceneSides.axisSide || previousSides.axisSide,
          landmarkSide: sceneSides.landmarkSide || previousSides.landmarkSide,
        }
      : sceneSides
    const establishesScene = !sameScene && !(sceneSides.screenLeft || sceneSides.screenRight || sceneSides.axisSide || sceneSides.landmarkSide)
    previousSides = sides
    previousSceneId = draft.scene.sceneId
    previousLocation = draft.scene.location || null
    shots.push({
      storyboardNumber: cursorShot,
      shotNumber: cursorShot,
      sceneId: draft.scene.sceneId,
      location: draft.scene.location || null,
      time: draft.scene.time || null,
      sourceExcerpt: excerpt.text,
      duration,
      actionStart: actionEndpoint(draft.beats, 'start'),
      actionEnd: actionEndpoint(draft.beats, 'end'),
      coverageType: speech.length ? 'dialogue' : 'action',
      speechSegments: speech,
      ...(fragment ? { speechSource: 'planner' as const } : {}),
      boundaryType: speech.length ? 'speech' : 'action',
      boundaryWord: null,
      ...sides,
      sceneLabel: draft.scene.label,
      titleHint: titleOf(draft, speech),
      summaryHint: summaryOf(draft, speech),
      transition: 'cut',
      speaker,
      segmentKind: speech.length ? 'dialogue' : 'action',
      establishesScene,
    })
    cursorShot += 1
  }
  const covered = shots.reduce((sum, shot) => sum + nonWsLength(shot.sourceExcerpt), 0)
  return {
    shots,
    coverage: nonWsLength(script) ? Math.min(1, covered / nonWsLength(script)) : 0,
    sceneCount: scenes.filter(scene => scene.bodyEnd > scene.bodyStart).length,
    sourceChars: nonWsLength(script),
  }
}

/** 给预拆消息用的锁定清单；模型只补语义字段，不改边界。 */
export function buildPlannedShotsBlock(shots: PlannedStoryboardShot[]): string {
  if (!shots.length) return ''
  const lines = [
    '### 系统预拆分结果（拆分主算法已锁定，必须逐条落地）',
    `本段固定 ${shots.length} 个骨架：下面每一行对应一个骨架，必须按原顺序调用 save_storyboard_skeletons 保存同样数量；禁止增删、合并、拆分或改边界。`,
    'source_excerpt、duration、台词由系统锁定；scene_id 已给出时必须沿用，显示“场景待绑定”的由模型补绑 canonical 场景；模型只补 action_summary、character_ids、prop_ids、title、transition、continuity、action_start/action_end 和画面常量。',
  ]
  for (const shot of shots) {
    const speech = shot.speechSegments.length
      ? shot.speechSegments.map(item => `${item.speaker || '角色'}「${item.text}」`).join('；')
      : '无'
    const sidesLine = (shot.screenLeft || shot.screenRight || shot.axisSide || shot.landmarkSide)
      ? `画面左 ${shot.screenLeft || '待定'}；画面右 ${shot.screenRight || '待定'}；轴线 ${shot.axisSide || '待定'}；地标 ${shot.landmarkSide || '待定'}`
      : (shot.establishesScene
          ? '建立镜：本镜必须补全画面左/右、轴线、地标，后续镜头逐字沿用'
          : '沿用本场建立镜：可留空，服务端按场景契约补齐；不得自行改写或翻转')
    lines.push([
      `- 第 ${shot.storyboardNumber} 镜｜${shot.sceneLabel}｜${shot.location || '场景待绑定'} / ${shot.time || '时间未写'}｜${shot.duration} 秒｜说话人：${shot.speaker || '无'}`,
      `  锁定摘录：${shot.sourceExcerpt.replace(/\s+/g, ' ').slice(0, 220)}`,
      `  锁定台词：${speech}`,
      `  画面常量：${sidesLine}`,
    ].join('\n'))
  }
  return lines.join('\n')
}
