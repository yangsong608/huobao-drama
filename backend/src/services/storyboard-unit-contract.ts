/**
 * 分镜单位与固定分区硬约束
 *
 * 设计：一个分镜 = 一个机位 + 一个主体 + 一个连续动作。
 * 同一机位内的连续运动可以写多个时间帧，但不能再出现【镜头N】这类子镜头编号。
 * 保存层用本文件校验；Agent 系统提示词末尾也注入同一段规则，覆盖旧方案里的段落制表述。
 */
import { parsePromptSections, parsePromptSegments } from './storyboard-audit-rules.js'

export const STORYBOARD_UNIT_RULES = `### 分镜单位与提示词硬约束（最高优先级，覆盖之前任何相反表述）
- 一个分镜 = 一个机位 + 一个主体 + 一个连续动作。需要换机位、换主体、换动作/情绪节点时，必须新开分镜；不要在一个分镜里切镜。
- description 只能写一个连续镜头：直接写谁、动作、表情、站位/视线，不要写【镜头1】【镜头2】等任何编号。同一机位内的连续运动可写成多个时间帧，但那些时间帧不是子镜头。
- 每个分镜 6-15 秒；分镜内部时间帧每段 1-6 秒，连续不重叠，最后一段结束时间等于 duration。
- video_prompt 固定四区，顺序不可变：
  1. 第一行信息头「出场人物：@角色A、@角色B｜场景：@场景名」；
  2. 「画面调度：画面左：…；画面右：…；过…肩；窗/门/桌在…；动作起点：…；动作终点：…」；
  3. 从「0-3秒：」开始的时间帧，每段 1-6 秒；
  4. 「负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品」。
- 声音不是逐镜风格：BGM/环境声由第四步场景/剧情级声音设计统一分配。修补阶段不写完整 BGM 风格；声音区只在校验通过后写入本镜短增量（如「延续本单元环境声；BGM 继续，不重启；本镜新增：…」）。
- 有角色的分镜必须写动作起点和动作终点；空镜/纯环境镜头写「动作起点：无；动作终点：无」。
- 场景必须使用 canonical scene_id；同名场景只选一个主场景，不允许在 54/55/56 这类同名场景之间按时间或喜好另选。
- 同一场戏的屏幕左右、轴线、背景地标侧是场景级常量：先定一次，后续同场分镜必须沿用；禁止在后续镜头交换人物左右或门/窗侧。
- 画面调度必须写清画面左、画面右、过肩侧、背景地标、轴线和动作端点；没有过肩写「无过肩」，没有地标写「背景地标：无」，单人/空镜轴线写「轴线无」，双人及以上必须写「轴线A」或「轴线B」。
- 没有台词/旁白时直接省略该句，绝对不要写「旁白（画外音）：「无。」」或「@角色说：无。」这类占位台词。
- 时间帧内只写同一个机位/主体的画面；台词按 4 字/秒容量分配到时间帧，装不下就拆到相邻分镜，不能靠加快语速硬塞。`

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
  shotLabel?: string
  /** 手工只改视频提示词时可关闭子镜数量检查；拆分保存始终开启 */
  checkSubshots?: boolean
  /** 新拆分必须关闭；旧数据编辑保持默认，不因历史【镜头N】标记阻断保存 */
  forbidShotMarkers?: boolean
}

const ACTION_START_RE = /(?:动作起点|动作开始|起始动作|起势|動作開始|동작\s*시작|action\s*start)\s*[：:]\s*([^；;。\n]+)/i
const ACTION_END_RE = /(?:动作终点|动作结束|结束动作|收势|動作終了|동작\s*끝|action\s*end)\s*[：:]\s*([^；;。\n]+)/i

function hasMarker(re: RegExp, text: string): boolean {
  const match = re.exec(text)
  return Boolean(match && match[1].trim())
}

/** 返回中文错误列表；空数组表示通过 */
export function validateStoryboardUnit(input: StoryboardUnitInput): string[] {
  const errors: string[] = []
  const label = input.shotLabel || '本分镜'
  const description = String(input.description || '')
  const duration = Number(input.duration || 0)
  if (duration > 0 && (duration < 6 || duration > 15)) {
    errors.push(`${label}时长 ${duration} 秒，必须在 6-15 秒之间。`)
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
      if (bg && !/^(?:无|none|なし|없음)$/i.test(bg) && !/(?:左|右|left|right|왼쪽|오른쪽)/i.test(bg)) {
        errors.push(`${label}背景地标缺少屏幕侧；写成「背景地标：窗在左后、门在右后」或「背景地标：无」。`)
      }
    }
    if ((input.characterIds?.length || 0) >= 2 && !/(?:轴线|axis|軸線|축선)\s*[：:]?\s*[AB](?![A-Za-z])/i.test(blocking)) {
      errors.push(`${label}有多个画内角色但缺少「轴线A」或「轴线B」。`)
    }
    if (!hasMarker(ACTION_START_RE, blocking)) errors.push(`${label}缺少动作起点；空镜写「动作起点：无」。`)
    if (!hasMarker(ACTION_END_RE, blocking)) errors.push(`${label}缺少动作终点；空镜写「动作终点：无」。`)
  }
  const promptBody = prompt.split(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)[0]
  const segments = parsePromptSegments(promptBody)
  const spokenText = segments
    .flatMap(segment => [...String(segment.text || '').matchAll(/「([^」]*)」/g)].map(match => match[1]))
    .join('')
  const spokenChars = spokenText.replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:\"\'()\[\]]/g, '').length
  if (duration > 0 && spokenChars > Math.max(0, duration - 1) * 4) {
    errors.push(`${label}台词+旁白约 ${spokenChars} 字，按 4 字/秒 + 1 秒气口需要约 ${(spokenChars / 4 + 1).toFixed(1)} 秒，镜头只有 ${duration} 秒；请拆到相邻分镜或延长时长。`)
  }
  if (!segments.length) {
    errors.push(`${label}没有时间帧；请从 0 秒开始按 1-6 秒连续分段。`)
  } else {
    if (Math.abs(segments[0].startSec) > 0.01) errors.push(`${label}第一段时间帧必须从 0 秒开始。`)
    for (const segment of segments) {
      const length = segment.endSec - segment.startSec
      if (length < 1 || length > 6) errors.push(`${label}第 ${segment.index} 段时间帧 ${length} 秒，必须在 1-6 秒之间。`)
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
