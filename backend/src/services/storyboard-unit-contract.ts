/**
 * 分镜单位与固定分区硬约束
 *
 * 设计：一个分镜 = 一个机位 + 一个主体 + 一个连续动作。
 * 同一机位内的连续运动可以写多个时间帧，但不能再出现【镜头N】这类子镜头编号。
 * 保存层用本文件校验；Agent 系统提示词末尾也注入同一段规则，覆盖旧方案里的段落制表述。
 */
import { parsePromptSections, parsePromptSegments } from './storyboard-audit-rules.js'
import { estimateActionTiming } from './action-timing.js'
import { DIALOGUE_CHARS_PER_SECOND } from './dialogue-timing.js'

export const STORYBOARD_UNIT_RULES = `### 分镜单位与提示词硬约束（最高优先级，覆盖之前任何相反表述）
- 一个分镜 = 一个机位 + 一个主体 + 一个连续动作。需要换机位、换主体、换动作/情绪节点时，必须新开分镜；不要在一个分镜里切镜。
- description 只能写一个连续镜头：直接写谁、动作、表情、站位/视线，不要写【镜头1】【镜头2】等任何编号。同一机位内的连续运动可写成多个时间帧，但那些时间帧不是子镜头。
- 每个分镜 2-15 秒（按内容决定，不补时长）；分镜内部时间帧每段 1-6 秒，连续不重叠，最后一段结束时间等于 duration。
- video_prompt 固定四区，顺序不可变：
  1. 第一行信息头「出场人物：@角色A、@角色B｜场景：@场景名」；
  2. 「画面调度：画面左：…；画面右：…；过…肩；窗/门/桌在…；动作起点：…；动作终点：…」；
  3. 从「0-3秒：」开始的时间帧，每段 1-6 秒；
  4. 「负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现与项目时代、地域和设定冲突的物品、服装、文字和标识」。
- 声音不是逐镜风格：BGM/环境声由第四步场景/剧情级声音设计统一分配。修补阶段不写完整 BGM 风格；声音区只在校验通过后写入本镜短增量（如「延续本单元环境声；BGM 继续，不重启；本镜新增：…」）。
- 有角色的分镜必须写动作起点和动作终点；空镜/纯环境镜头写「动作起点：无；动作终点：无」。
- 场景必须使用 canonical scene_id；同名场景只选一个主场景，不允许在 54/55/56 这类同名场景之间按时间或喜好另选。
- 同一场戏的屏幕左右、轴线、背景地标侧是场景级常量：先定一次，后续同场分镜必须沿用；禁止在后续镜头交换人物左右或门/窗侧。
- 画面调度只写本镜时间帧里实际入画的元素；同场左右/轴线常量可以沿用，但不要把上一镜的整段调度复制过来；调度里出现的道具、地标和动作必须在时间帧中可见，未入画就删掉。
- 画面调度必须写清画面左、画面右、过肩侧、背景地标、轴线和动作端点；没有过肩写「无过肩」，没有地标写「背景地标：无」，单人/空镜轴线写「轴线无」，双人及以上必须写「轴线A」或「轴线B」。
- 没有台词/旁白时直接省略该句，绝对不要写「旁白（画外音）：「无。」」或「@角色说：无。」这类占位台词。
- 多角色同框时只有当前台词角色张嘴；其他角色嘴唇闭合、不说话、不做说话动作。快速短对白可共镜：最多 3 个说话人、最多 3 句、每句不超过 24 字；长篇独白或长句仍按说话人拆镜。快速对白按每句分配时间帧，单帧至少按「去标点字数/4 + 1 秒」预留，不要把一句台词硬压进 2 秒帧。
- 一个分镜只允许一个简单运镜：固定 / 轻推 / 轻拉 / 轻摇 / 轻移 / 跟移 之一；movement 不得写“固定，尾段轻推”这类组合，视频提示词里最多出现一次运镜，后续时间帧不得重复或追加新的推拉摇移跟升降环绕变焦。movement=固定 时不得写任何镜头运动。
- 时间帧内只写同一个机位/主体的画面；台词按正常语速（最终以 TTS 音频为准）分配到时间帧，装不下就拆到相邻分镜，不能靠加快语速硬塞。
- 多余时长优先分配给有实际台词/动作的时间帧，不能默认堆到最后一帧；最后一帧不得用无台词空动作硬凑时长。`

/** 清理模型把“无”占位写成真实台词的情况；只删除占位句，不改真实台词 */
export function stripPlaceholderDialogue(text: string | null | undefined): string {
  if (!text) return text || ''
  const original = String(text)
  const placeholderRe = /(?:旁白（画外音）\s*[：:]\s*「?\s*无\s*。?」?)|(?:@?[^\s@，。；：:]+说\s*[：:]\s*「?\s*无\s*。?」?)/g
  if (!placeholderRe.test(original)) return original
  return original
    .replace(placeholderRe, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[；;]\s*([；;])/g, '$1')
    .trim()
}

export interface StoryboardUnitInput {
  description?: string | null
  videoPrompt?: string | null
  characterIds?: number[]
  duration?: number | null
  movement?: string | null
  shotLabel?: string
  /** 手工只改视频提示词时可关闭子镜数量检查；拆分保存始终开启 */
  checkSubshots?: boolean
  /** 新拆分必须关闭；旧数据编辑保持默认，不因历史【镜头N】标记阻断保存 */
  forbidShotMarkers?: boolean
}

const ACTION_START_RE = /(?:动作起点|动作开始|起始动作|起势|動作開始|동작\s*시작|action\s*start)\s*[：:]\s*([^；;。\n]+)/i
const ACTION_END_RE = /(?:动作终点|动作结束|结束动作|收势|動作終了|동작\s*끝|action\s*end)\s*[：:]\s*([^；;。\n]+)/i
const CAMERA_LABEL_RE = /(固定|轻推|推近|推进|推镜|轻拉|拉远|拉出|拉镜|轻摇|摇镜|横移|轻移|移镜|跟移|升起|降下|环绕|变焦)/g
const CAMERA_PHRASE_RE = /(?:镜头|机位)[^，。；：\n]{0,18}?(?:推近|推进|推镜|轻推|拉远|拉出|拉镜|轻拉|摇镜|轻摇|横移|移镜|跟移|升起|降下|环绕|变焦|固定)/g

function cameraLabels(value: string): string[] {
  return [...String(value || '').matchAll(CAMERA_LABEL_RE)].map(match => match[1])
}

function cameraPhrases(value: string): string[] {
  return [...String(value || '').matchAll(CAMERA_PHRASE_RE)].map(match => match[0])
}

function quotedChars(text: string): number {
  const quoted = [...String(text || '').matchAll(/「([^」]*)」/g)].map(match => match[1]).join('')
  return plainChars(quoted)
}

function plainChars(text: string): number {
  return String(text || '').replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length
}

/** 把超过单帧容量的一句台词按标点切块；单句过长时按字数硬切。 */
function splitQuoteContent(content: string, maxChars = 24): string[] {
  const tokens = String(content || '').match(/[^。！？；，、,.!?;]+[。！？；，、,.!?;]?/g) || [String(content || '')]
  const chunks: string[] = []
  let buffer = ''
  const flush = () => {
    if (plainChars(buffer)) chunks.push(buffer)
    buffer = ''
  }
  for (const token of tokens) {
    if (plainChars(buffer + token) <= maxChars) {
      buffer += token
      continue
    }
    flush()
    let rest = token
    while (plainChars(rest) > maxChars) {
      let count = 0
      let cut = 0
      for (const char of rest) {
        if (plainChars(char)) count += 1
        cut += char.length
        if (count >= maxChars) break
      }
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    buffer = rest
  }
  flush()
  return chunks
}

const SPEAKER_LABEL_RE = /((?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]|(?:@?[^，。；：\s]{1,20})\s*(?:说|道|问|喊|答)?\s*[：:])\s*$/

/** 单帧台词超 24 字时拆成多帧；运镜/画面只留首帧，台词标记在后续帧重复。 */
function splitOverlongSegment(text: string): string[] {
  const quotes = [...String(text || '').matchAll(/「([^」]*)」/g)]
  if (quotes.length !== 1 || plainChars(quotes[0][1]) <= 24) return [text]
  const quote = quotes[0]
  const prefix = text.slice(0, quote.index)
  const suffix = text.slice(Number(quote.index) + quote[0].length)
  const chunks = splitQuoteContent(quote[1])
  if (chunks.length <= 1) return [text]
  const label = prefix.match(SPEAKER_LABEL_RE)?.[1] || ''
  return chunks.map((chunk, index) => {
    const lead = index === 0 ? prefix : label
    const tail = index === chunks.length - 1 ? suffix : ''
    return `${lead}「${chunk}」${tail}`
  })
}

const TIMELINE_MARK_RE = /(?:^|\n)[ \t]*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[：:]?/gi

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function quoteSpeakers(text: string): Set<string> {
  return new Set([...String(text || '').matchAll(/([^\s，。；：]{1,12})\s*(?:说|问|答|道)?\s*[：:]\s*「/g)].map(match => match[1]))
}

function frameRequired(text: string): number {
  return Math.max(1, Math.min(6, Math.ceil(quotedChars(text) / DIALOGUE_CHARS_PER_SECOND * 10) / 10))
}

/** 同一说话人的相邻小帧可以合并；合并后仍要满足单帧容量。 */
function mergeSmallFrames(segments: { text: string }[], duration: number): { text: string }[] | null {
  const current = segments.map(segment => ({ ...segment }))
  let total = current.reduce((sum, segment) => sum + frameRequired(segment.text), 0)
  while (total > duration + 0.01) {
    let best = -1
    let bestReduction = 0
    let bestLength = Infinity
    for (let index = 0; index < current.length - 1; index += 1) {
      const left = current[index].text
      const right = current[index + 1].text
      const leftSpeakers = quoteSpeakers(left)
      const rightSpeakers = quoteSpeakers(right)
      if (leftSpeakers.size && rightSpeakers.size
        && [...leftSpeakers].some(speaker => !rightSpeakers.has(speaker))) continue
      const merged = `${left} ${right}`.trim()
      if (frameRequired(merged) > 6) continue
      const reduction = frameRequired(left) + frameRequired(right) - frameRequired(merged)
      if (reduction <= 0) continue
      const length = plainChars(left) + plainChars(right)
      if (reduction > bestReduction || (reduction === bestReduction && length < bestLength)) {
        best = index
        bestReduction = reduction
        bestLength = length
      }
    }
    if (best < 0) return null
    current[best] = { text: `${current[best].text} ${current[best + 1].text}`.trim() }
    current.splice(best + 1, 1)
    total = current.reduce((sum, segment) => sum + frameRequired(segment.text), 0)
  }
  return current
}

/** 按每段台词容量重排时间帧边界；单帧超容量时按台词标点拆成相邻帧。 */
export function rebalancePromptTimeline(videoPrompt: string | null | undefined, duration: number): string {
  const prompt = String(videoPrompt || '')
  if (!prompt || !(duration > 0)) return prompt
  const negativeStart = prompt.search(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)
  const region = negativeStart >= 0 ? prompt.slice(0, negativeStart) : prompt
  const marks: { index: number; bodyStart: number }[] = []
  const re = new RegExp(TIMELINE_MARK_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(region))) {
    marks.push({ index: match.index, bodyStart: match.index + match[0].length })
  }
  if (!marks.length) return prompt
  const segments = marks.flatMap((mark, index) => {
    const text = region.slice(mark.bodyStart, index + 1 < marks.length ? marks[index + 1].index : region.length).trim()
    return splitOverlongSegment(text).map(item => ({ text: item }))
  })
  let framesSegments = segments
  let required = framesSegments.map(segment => frameRequired(segment.text))
  let total = required.reduce((sum, value) => sum + value, 0)
  if (total > duration + 0.01) {
    const merged = mergeSmallFrames(framesSegments, duration)
    if (!merged) return prompt
    framesSegments = merged
    required = framesSegments.map(segment => frameRequired(segment.text))
    total = required.reduce((sum, value) => sum + value, 0)
    if (total > duration + 0.01) return prompt
  }
  let extra = duration - total
  const actionWeights = framesSegments.map(segment => Math.max(0.1, estimateActionTiming(segment.text.replace(/「[^」]*」/g, '')).seconds))
  const frames = framesSegments.map((segment, index) => ({ text: segment.text, seconds: required[index] }))
  // 多余时长按动作事件分配，不按字数、不默认堆到末帧，也不设固定节拍秒数。
  while (extra >= 1 - 1e-9) {
    let best = -1
    let bestScore = -1
    for (let index = 0; index < frames.length; index += 1) {
      if (frames[index].seconds >= 6 - 1e-9) continue
      const score = actionWeights[index] / (1 + frames[index].seconds - required[index])
      if (score > bestScore) {
        bestScore = score
        best = index
      }
    }
    if (best < 0) break
    frames[best].seconds += 1
    extra -= 1
  }
  if (extra > 0.01) {
    const target = frames.find(frame => frame.seconds + extra <= 6)
    if (target) {
      target.seconds += extra
      extra = 0
    }
  }
  if (extra > 0.01) {
    const last = frames[frames.length - 1]
    const add = Math.min(6 - last.seconds, extra)
    last.seconds += add
    extra -= add
  }
  // 不添加“动作延续”填充帧；剩余时长交给 fitPromptTimeline 按内容裁掉。
  let cursor = 0
  const lines = frames.map(frame => {
    const start = cursor
    cursor += frame.seconds
    return `${formatSeconds(start)}-${formatSeconds(cursor)}秒：${frame.text}`
  })
  const prefix = region.slice(0, marks[0].index).replace(/\s+$/, '')
  const suffix = negativeStart >= 0 ? prompt.slice(negativeStart).trimStart() : ''
  return [prefix, ...lines, suffix].filter(Boolean).join('\n')
}

/** 按内容事件裁掉多余时长；没有内容的尾巴直接裁掉，不延长、不补时长。 */
export function fitPromptTimeline(
  videoPrompt: string | null | undefined,
  currentDuration: number,
  maxDuration = 15,
): { prompt: string; duration: number } {
  const prompt = String(videoPrompt || '')
  if (!prompt.trim() || !(currentDuration > 0)) return { prompt, duration: currentDuration }
  const negativeStart = prompt.search(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)
  const region = negativeStart >= 0 ? prompt.slice(0, negativeStart) : prompt
  const marks: { index: number; bodyStart: number }[] = []
  const re = new RegExp(TIMELINE_MARK_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(region))) {
    marks.push({ index: match.index, bodyStart: match.index + match[0].length })
  }
  if (!marks.length) return { prompt, duration: currentDuration }
  const segments = marks.flatMap((mark, index) => {
    const text = region.slice(mark.bodyStart, index + 1 < marks.length ? marks[index + 1].index : region.length).trim()
    return splitOverlongSegment(text).map(item => ({ text: item }))
  })
  const targets = segments.map(segment => Math.max(
    1,
    Math.ceil(quotedChars(segment.text) / DIALOGUE_CHARS_PER_SECOND * 10) / 10,
    estimateActionTiming(segment.text).seconds,
  ))
  let total = targets.reduce((sum, value) => sum + value, 0)
  // 只裁掉多余时长，不为画面描述反推更长镜头；内容需要更长时由 planner/拆镜处理。
  if (total > currentDuration + 0.01 || !targets.length) return { prompt, duration: currentDuration }
  const duration = Math.max(2, Math.min(currentDuration, maxDuration, Math.ceil(total)))
  let remainder = duration - total
  if (remainder > 0.01) {
    let best = 0
    for (let index = 1; index < targets.length; index += 1) {
      if (targets[index] > targets[best]) best = index
    }
    targets[best] += remainder
  }
  let cursor = 0
  const lines = segments.map((segment, index) => {
    const start = cursor
    cursor += targets[index]
    return `${formatSeconds(start)}-${formatSeconds(cursor)}秒：${segment.text}`
  })
  const prefix = region.slice(0, marks[0].index).replace(/\s+$/, '')
  const suffix = negativeStart >= 0 ? prompt.slice(negativeStart).trimStart() : ''
  return { prompt: [prefix, ...lines, suffix].filter(Boolean).join('\n'), duration }
}

/** 用时间帧和轴线纠正画面左右写反；只交换左右子句，不改时间帧内容。 */
export function alignScreenSidesToFrames(videoPrompt: string | null | undefined): string {
  const prompt = String(videoPrompt || '')
  const header = /出场人物\s*[：:]\s*([^\n]+)/.exec(prompt)?.[1] || ''
  const names = header.split(/[｜|]/)[0].split(/[、，,]/).map(item => item.replace(/^@/, '').trim()).filter(Boolean)
  if (names.length < 2) return prompt
  const leftMatch = /画面左\s*[：:]\s*([^；;\n]+)/.exec(prompt)
  const rightMatch = /画面右\s*[：:]\s*([^；;\n]+)/.exec(prompt)
  if (!leftMatch || !rightMatch) return prompt
  const primary = (text: string) => names
    .map(name => ({ name, index: text.indexOf(name) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0]?.name || ''
  const blockingLeft = primary(leftMatch[1])
  const blockingRight = primary(rightMatch[1])
  const axis = /轴线\s*[AB]?\s*[：:]\s*([^；;\n]+)/.exec(prompt)?.[1] || ''
  const axisLeft = names.find(name => new RegExp(`${name}\s*在左`).test(axis)) || ''
  const axisRight = names.find(name => new RegExp(`${name}\s*在右`).test(axis)) || ''
  const counts = { left: new Map<string, number>(), right: new Map<string, number>() }
  const body = prompt.split(/\n\s*(?:负面约束|Negative constraints)\s*[：:]/i)[0].replace(/^画面调度.*$/m, '')
  for (const match of body.matchAll(/画面左[^\n]{0,8}?@?([^\s，。；：]{2,12})/g)) {
    const name = names.find(item => match[1].startsWith(item) || item.startsWith(match[1]))
    if (name) counts.left.set(name, (counts.left.get(name) || 0) + 1)
  }
  for (const match of body.matchAll(/画面右[^\n]{0,8}?@?([^\s，。；：]{2,12})/g)) {
    const name = names.find(item => match[1].startsWith(item) || item.startsWith(match[1]))
    if (name) counts.right.set(name, (counts.right.get(name) || 0) + 1)
  }
  const frameLeft = [...counts.left.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const frameRight = [...counts.right.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const desiredLeft = axisLeft || frameLeft
  const desiredRight = axisRight || frameRight
  if (!desiredLeft || !desiredRight || desiredLeft === desiredRight) return prompt
  if (blockingLeft === desiredRight && blockingRight === desiredLeft) {
    return prompt
      .replace(leftMatch[0], `画面左：${rightMatch[1]}`)
      .replace(rightMatch[0], `画面右：${leftMatch[1]}`)
  }
  return prompt
}

function hasMarker(re: RegExp, text: string): boolean {
  const match = re.exec(text)
  return Boolean(match && match[1].trim())
}

function blockingPhraseContent(value: string): string {
  return String(value || '')
    .replace(/@/g, '')
    .replace(/(?:画面左|画面右|在左|在右|左侧|右侧|左后|右后|前景|后景|过肩|无过肩|轴线[AB]?|轴线无|站位|视线|人物|角色|位置)/g, '')
    .replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '')
}

function frameSupportsPhrase(content: string, frameText: string): boolean {
  const normalized = blockingPhraseContent(content)
  if (normalized.length < 3) return true
  for (let length = Math.min(8, normalized.length); length >= 3; length -= 1) {
    for (let index = 0; index + length <= normalized.length; index += 1) {
      if (frameText.includes(normalized.slice(index, index + length))) return true
    }
  }
  return false
}

function blockingFrameIssues(blocking: string, videoPrompt: string, label: string): string[] {
  const frameText = parsePromptSegments(videoPrompt).map(segment => segment.text).join('\n')
  if (!frameText) return []
  const issues: string[] = []
  for (const [name, clauseName] of [['left', '画面左'], ['right', '画面右'], ['background', '背景地标']] as const) {
    const match = new RegExp(`${clauseName}\\s*[：:]\\s*([^；;。\\n]+)`).exec(blocking)
    if (!match) continue
    const clauses = match[1].split(/[、，,；;与和/]/).map(item => item.trim()).filter(Boolean)
    if (!clauses.length || clauses.every(item => /^(?:无|none|なし|없음)$/i.test(item))) continue
    const meaningful = clauses.filter(item => blockingPhraseContent(item).length >= 3)
    if (!meaningful.length) continue
    if (!meaningful.some(item => frameSupportsPhrase(item, frameText))) {
      issues.push(`${label}画面调度「${clauseName}：${match[1].slice(0, 28)}」在本镜时间帧里没有对应内容；请删掉未入画元素或把它写进时间帧。`)
    }
  }
  return issues
}

function headerCharacterNames(videoPrompt: string): string[] {
  const header = /出场人物\s*[：:]\s*([^\n]+)/.exec(videoPrompt)?.[1] || ''
  return header.split(/[｜|]/)[0].split(/[、，,]/).map(item => item.replace(/^@/, '').trim()).filter(Boolean)
}

/** 只保留本镜时间帧真正出现的调度元素；左右失效时保留该侧角色名，背景失效写“无”。 */
export function alignBlockingToFrames(videoPrompt: string | null | undefined): string {
  const prompt = String(videoPrompt || '')
  const sections = parsePromptSections(prompt)
  if (!sections.hasBlockingMarker || !sections.blocking) return prompt
  const frameText = parsePromptSegments(prompt).map(segment => segment.text).join('\n')
  if (!frameText) return prompt
  const names = headerCharacterNames(prompt)
  let blocking = sections.blocking
  for (const [clauseName, side] of [['画面左', 'left'], ['画面右', 'right'], ['背景地标', 'background']] as const) {
    const match = new RegExp(`(${clauseName}\\s*[：:]\\s*)([^；;。\\n]+)`).exec(blocking)
    if (!match) continue
    const raw = match[2].trim()
    if (!raw || /^(?:无|none|なし|없음)$/i.test(raw)) continue
    const phrases = raw.split(/[、，,；;与和/]/).map(item => item.trim()).filter(Boolean)
    const supported = phrases.filter(item => frameSupportsPhrase(item, frameText))
    const usedNames = names.filter(name => raw.includes(name))
    let next = supported.join('、')
    if (next && usedNames.length && !usedNames.some(name => next.includes(name))) {
      next = `${usedNames[0]}${next}`
    }
    if (!next) {
      if (side === 'background') next = '无'
      else next = usedNames.length ? usedNames.join('、') : '无'
    }
    blocking = blocking.replace(match[0], `${match[1]}${next}`)
  }
  const axisMatch = /(轴线\s*([AB]))\s*(?:[：:]\s*([^；;\n]+))?/.exec(blocking)
  if (axisMatch && axisMatch[3]) {
    const leftText = /画面左\s*[：:]\s*([^；;\n]+)/.exec(blocking)?.[1] || ''
    const rightText = /画面右\s*[：:]\s*([^；;\n]+)/.exec(blocking)?.[1] || ''
    const primaryName = (text: string) => names
      .map(name => ({ name, index: text.indexOf(name) }))
      .filter(item => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.name.length - a.name.length)[0]?.name || ''
    const leftName = primaryName(leftText)
    const rightName = primaryName(rightText)
    const mapping = leftName && rightName
      ? `：${leftName}在左、${rightName}在右`
      : ''
    blocking = blocking.replace(axisMatch[0], `${axisMatch[1]}${mapping}`)
  }
  if (blocking === sections.blocking) return prompt
  return prompt.replace(sections.blocking, blocking)
}

/** 返回中文错误列表；空数组表示通过 */
export function validateStoryboardUnit(input: StoryboardUnitInput): string[] {
  const errors: string[] = []
  const label = input.shotLabel || '本分镜'
  const description = String(input.description || '')
  const duration = Number(input.duration || 0)
  if (duration > 0 && (duration < 2 || duration > 15)) {
    errors.push(`${label}时长 ${duration} 秒，必须在 2-15 秒（按内容决定，不补时长）之间。`)
  }
  const prompt = String(input.videoPrompt || '')
  const subshots = [...description.matchAll(/【镜头\s*\d+】/g)].length
  if (input.checkSubshots !== false) {
    if (input.forbidShotMarkers && subshots > 0) {
      errors.push(`${label}description 出现了 ${subshots} 个【镜头N】编号；一个分镜就是一个连续镜头，请去掉编号直接写画面。`)
    } else if (subshots > 1) {
      errors.push(`${label}有 ${subshots} 个子镜头；一个分镜只能一个机位/一个主体/一个连续动作，请拆成独立分镜。`)
    }
  }
  const sections = parsePromptSections(prompt)
  if (!sections.hasBlockingMarker || !sections.blocking.trim()) {
    errors.push(`${label}缺少「画面调度」；请补屏幕左右、过肩、背景地标、动作起点/终点。`)
  }
  if (!sections.hasNegativeMarker || !sections.negative.trim()) {
    errors.push(`${label}缺少「负面约束」；请补固定负面约束行。`)
  }
  const blocking = sections.blocking
  if (blocking) {
    if (!/(?:画面左|screen\s*left|화면\s*왼쪽)\s*[：:]/i.test(blocking) || !/(?:画面右|screen\s*right|화면\s*오른쪽)\s*[：:]/i.test(blocking)) {
      errors.push(`${label}画面调度缺少「画面左/画面右」。`)
    }
    const bgMatch = /(?:背景地标|background\s*landmarks?|背景地標|배경\s*지표)\s*[：:]\s*([^；;。\n]+)/i.exec(blocking)
    if (!bgMatch) {
      errors.push(`${label}画面调度缺少「背景地标：」；没有地标写「背景地标：无」。`)
    } else {
      const bg = bgMatch[1].trim()
      if (bg && !/^(?:无|none|なし|없음)$/i.test(bg) && !/(?:左|右|上方|下方|中央|中间|前景|后景|left|right|top|bottom|center|middle|foreground|background|왼쪽|오른쪽|위|아래|중앙)/i.test(bg)) {
        errors.push(`${label}背景地标缺少屏幕位置；写成「背景地标：窗在左后、门在右后」「背景地标：唐记招牌位于画面上方」或「背景地标：无」。`)
      }
    }
    if ((input.characterIds?.length || 0) >= 2 && !/(?:轴线|axis|軸線|축선)\s*[：:]?\s*[AB](?![A-Za-z])/i.test(blocking)) {
      errors.push(`${label}有多个画内角色但缺少「轴线A」或「轴线B」。`)
    }
    if (!hasMarker(ACTION_START_RE, blocking)) errors.push(`${label}缺少动作起点；空镜写「动作起点：无」。`)
    if (!hasMarker(ACTION_END_RE, blocking)) errors.push(`${label}缺少动作终点；空镜写「动作终点：无」。`)
  }
  const promptBody = prompt.split(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)[0]
  if (blocking) errors.push(...blockingFrameIssues(blocking, promptBody, label))
  const movement = String(input.movement || '').trim()
  const phrases = cameraPhrases(promptBody)
  if (phrases.length > 1) {
    errors.push(`${label}video_prompt 出现 ${phrases.length} 次运镜（${phrases.join('；')}）；一个分镜只能保留一次运镜描述。`)
  }
  if (movement) {
    const labels = cameraLabels(movement)
    if (labels.length > 1) {
      errors.push(`${label}运镜「${movement}」包含多个动作；一个分镜只能从固定/轻推/轻拉/轻摇/轻移/跟移中选一个。`)
    }
    if (labels.includes('固定') && phrases.length > 0) {
      errors.push(`${label}movement 是固定，但 video_prompt 仍写了镜头运动（${phrases.join('；')}）；固定镜头不得写推拉摇移跟升降环绕变焦。`)
    }
  }
  const segments = parsePromptSegments(promptBody)
  const spokenText = segments
    .flatMap(segment => [...String(segment.text || '').matchAll(/「([^」]*)」/g)].map(match => match[1]))
    .join('')
  const spokenChars = spokenText.replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:\"\'()\[\]]/g, '').length
  if (duration > 0 && spokenChars > Math.max(0, duration - 0.25) * DIALOGUE_CHARS_PER_SECOND) {
    errors.push(`${label}台词+旁白约 ${spokenChars} 字，按正常语速（最终以 TTS 为准）需要约 ${(spokenChars / DIALOGUE_CHARS_PER_SECOND).toFixed(1)} 秒，镜头只有 ${duration} 秒；请拆到相邻分镜或延长时长。`)
  }
  for (const segment of segments) {
    const segmentText = [...String(segment.text || '').matchAll(/「([^」]*)」/g)].map(match => match[1]).join('')
    const segmentChars = segmentText.replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:\"\'()\[\]]/g, '').length
    const segmentSeconds = Math.max(0, Math.round((segment.endSec - segment.startSec) * 10) / 10)
    if (segmentChars > segmentSeconds * DIALOGUE_CHARS_PER_SECOND) {
      errors.push(`${label}第 ${segment.index} 段时间帧台词约 ${segmentChars} 字，${segmentSeconds} 秒最多容纳 ${Math.floor(segmentSeconds * DIALOGUE_CHARS_PER_SECOND)} 字；请把台词拆到相邻时间帧或相邻分镜，不要压在一个时间帧里。`)
    }
  }
  if (!segments.length) {
    errors.push(`${label}没有时间帧；请从 0 秒开始按 1-6 秒连续分段。`)
  } else {
    if (Math.abs(segments[0].startSec) > 0.01) errors.push(`${label}第一段时间帧必须从 0 秒开始。`)
    for (const segment of segments) {
      const length = segment.endSec - segment.startSec
      const roundedLength = Math.round(length * 10) / 10
      if (roundedLength < 1 || roundedLength > 6) errors.push(`${label}第 ${segment.index} 段时间帧 ${roundedLength} 秒，必须在 1-6 秒之间。`)
    }
    for (let i = 1; i < segments.length; i += 1) {
      if (Math.abs(segments[i].startSec - segments[i - 1].endSec) > 0.01) {
        errors.push(`${label}第 ${i + 1} 段时间帧与上一段不连续。`)
        break
      }
    }
    if (duration > 0 && Math.abs(segments[segments.length - 1].endSec - duration) > 0.2) {
      errors.push(`${label}最后一段结束时间 ${segments[segments.length - 1].endSec} 秒与 duration ${duration} 秒不一致。`)
    }
  }
  return errors
}
