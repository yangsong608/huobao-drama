/**
 * 镜头合同解析与落库
 *
 * 合同字段的一部分可以从固定分区视频提示词确定性解析：
 * - 信息头 → 画内人物；
 * - 画面调度 → 屏幕左右、过肩；
 * - 时间帧 → segment_plan；
 * - 负面约束 → negative_constraints。
 * 解析失败或旧格式不阻断保存；contract_version=0 表示未解析，1 表示已解析。
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parsePromptSections, parsePromptSegments } from './storyboard-audit-rules.js'

export interface ContractSegment {
  start: number
  end: number
  text: string
}

export interface ParsedContract {
  castOnScreen: number[]
  castOffScreen: number[]
  screenLeft: string[]
  screenRight: string[]
  foregroundShoulder: string | null
  axisSide: string | null
  backgroundLandmarks: Array<{ name: string; side: string }>
  negativeConstraints: string | null
  actionStart: string | null
  actionEnd: string | null
  segments: ContractSegment[]
  contractVersion: number
}

export interface ContractCharacter {
  id: number
  name: string
}

/** 从视频提示词信息头解析画内人物名；没有信息头或解析失败返回空 */
export function parsePromptCastNames(videoPrompt: string | null | undefined): string[] {
  const first = String(videoPrompt || '').split(/\r?\n/, 1)[0]?.trim() || ''
  const match = /^(?:出场人物|登场人物|登場人物|人物|characters?|인물|등장인물)\s*[：:]\s*(.*?)(?:[｜|]\s*(?:场景|scene|シーン|장면)\s*[：:]|$)/i.exec(first)
  if (!match) return []
  return match[1]
    .split(/[、，,；;｜|／/]+/)
    .map(name => name.trim().replace(/^@+/, '').trim())
    .filter(Boolean)
}

function parseNames(text: string): string[] {
  if (!text) return []
  return text
    .split(/[、，,；;和与及]/)
    .map(name => name.trim().replace(/^@+/, '').replace(/[。；;，,]+$/, '').trim())
    .filter(Boolean)
    .filter(name => !/^(?:画面|左侧|右侧|左边|右边|前景|背景|中景|无)$/.test(name))
}

function extractSideNames(blocking: string, side: '左' | '右'): string[] {
  if (!blocking) return []
  const sideKey = side === '左' ? '(?:画面左|screen\\s*left|화면\\s*왼쪽)' : '(?:画面右|screen\\s*right|화면\\s*오른쪽)'
  const shortKey = side === '左' ? '(?:左|left|왼쪽)' : '(?:右|right|오른쪽)'
  const patterns = [
    new RegExp(`${sideKey}[：:]\\s*([^；;。\\n]+)`, 'i'),
    new RegExp(`(?:^|[；;。\\n])\\s*${shortKey}[：:]\\s*([^；;。\\n]+)`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(blocking)
    if (match) return parseNames(match[1])
  }
  return []
}

function normalizeSideNames(names: string[], characters: ContractCharacter[]): string[] {
  const result: string[] = []
  for (const raw of names) {
    const text = raw.trim()
    if (!text) continue
    const hit = [...characters]
      .sort((a, b) => b.name.length - a.name.length)
      .find(character => text === character.name || text.includes(character.name))
    const name = hit?.name || text
    if (!result.includes(name)) result.push(name)
  }
  return result
}

function normalizeLandmarkSide(value: string): string {
  if (/左/.test(value)) return 'left'
  if (/右/.test(value)) return 'right'
  if (/中|正/.test(value)) return 'center'
  if (/后/.test(value)) return 'back'
  if (/前/.test(value)) return 'front'
  return 'unknown'
}

function extractBackgroundLandmarks(blocking: string): Array<{ name: string; side: string }> {
  if (!blocking) return []
  const found: Array<{ name: string; side: string }> = []
  const re = /(炊饼摊|摊子|高灶|灶台|长队|队列|窗子|桌子|摊|灶|窗|门|桌|柜台|入口|匾|招牌|墙|柱)(?:在|位于)?(?:画面)?(左后|右后|左前|右前|左侧|右侧|左边|右边|左方|右方|中间|正中|中央|后景|前景)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(blocking))) {
    found.push({ name: match[1], side: normalizeLandmarkSide(match[2]) })
  }
  const unique = new Map<string, { name: string; side: string }>()
  for (const item of found) {
    if (!unique.has(item.name)) unique.set(item.name, item)
  }
  return [...unique.values()]
}

function extractAxisSide(blocking: string): string | null {
  if (!blocking) return null
  const match = /(?:主?轴线|axis|軸線|축선)\s*[：:]?\s*([AB])(?![A-Za-z])/i.exec(blocking)
    || /(?:^|[；;。\s])([AB])\s*侧/.exec(blocking)
  return match ? match[1].toUpperCase() : null
}

function extractShoulder(blocking: string): string | null {
  if (!blocking) return null
  const match = /过\s*@?([^，。；;\n\s]+?)\s*肩/.exec(blocking)
  if (match) return match[1].replace(/^@+/, '').replace(/[左右]$/, '').trim()
  const english = /over\s+([^,.;\n]+?)(?:'s)?\s+shoulder/i.exec(blocking)
  return english ? english[1].trim() : null
}

/** 动作起点/终点：画面调度里显式写「动作起点：… / 动作终点：…」，供同场动作匹配 */
function extractActionPoint(blocking: string, point: 'start' | 'end'): string | null {
  if (!blocking) return null
  const labels = point === 'start'
    ? ['动作起点', '动作开始', '起始动作', '起势', '動作開始', '동작\\s*시작', 'action\\s*start']
    : ['动作终点', '动作结束', '结束动作', '收势', '動作終了', '동작\\s*끝', 'action\\s*end']
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[：:]\\s*([^；;。\\n]+)`, 'i')
  const match = pattern.exec(blocking)
  return match ? match[1].trim().replace(/^[，,、]+|[，,、]+$/g, '') || null : null
}

function matchCharacterIds(names: string[], characters: ContractCharacter[]): number[] {
  const ids: number[] = []
  for (const name of names) {
    const hit = characters.find(character =>
      character.name === name
      || character.name.includes(name)
      || name.includes(character.name),
    )
    if (hit && !ids.includes(hit.id)) ids.push(hit.id)
  }
  return ids
}

/** 纯函数：从提示词解析合同；boundCharacterIds 用于计算画外人物 */
export function parseContractFromPrompt(
  videoPrompt: string | null | undefined,
  characters: ContractCharacter[],
  boundCharacterIds: number[] = [],
): ParsedContract {
  const prompt = String(videoPrompt || '')
  const sections = parsePromptSections(prompt)
  const segmentList = parsePromptSegments(prompt).map(segment => ({
    start: segment.startSec,
    end: segment.endSec,
    text: segment.text,
  }))
  const castNames = parsePromptCastNames(prompt)
  const castOnScreen = matchCharacterIds(castNames, characters)
  const bound = [...new Set(boundCharacterIds.filter(Boolean))]
  const castOffScreen = bound.filter(id => !castOnScreen.includes(id))
  const screenLeft = normalizeSideNames(extractSideNames(sections.blocking, '左'), characters)
  const screenRight = normalizeSideNames(extractSideNames(sections.blocking, '右'), characters)
  const actionStart = extractActionPoint(sections.blocking, 'start')
  const actionEnd = extractActionPoint(sections.blocking, 'end')
  // 固定合同必须同时有画面调度、负面约束、时间帧和动作端点；只有时间帧的旧提示词不再算完整合同
  const hasFixedContract = sections.hasBlockingMarker
    && Boolean(sections.blocking.trim())
    && sections.hasNegativeMarker
    && Boolean(sections.negative.trim())
    && segmentList.length > 0
    && Boolean(actionStart)
    && Boolean(actionEnd)
  return {
    castOnScreen,
    castOffScreen,
    screenLeft,
    screenRight,
    foregroundShoulder: extractShoulder(sections.blocking),
    axisSide: extractAxisSide(sections.blocking),
    backgroundLandmarks: extractBackgroundLandmarks(sections.blocking),
    negativeConstraints: sections.negative || null,
    actionStart,
    actionEnd,
    segments: segmentList,
    contractVersion: hasFixedContract ? 1 : 0,
  }
}

function jsonArray(value: unknown): string | null {
  return Array.isArray(value) ? JSON.stringify(value) : null
}

/** 重新解析并写回分镜合同字段；失败不抛给保存链路 */
export async function syncStoryboardContract(storyboardId: number): Promise<void> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!storyboard) return
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const boundIds = links.map(link => link.characterId)
  const characters = boundIds.length
    ? await db.select({ id: schema.characters.id, name: schema.characters.name })
      .from(schema.characters)
      .where(and(inArray(schema.characters.id, boundIds), isNull(schema.characters.deletedAt)))
    : []
  const parsed = parseContractFromPrompt(storyboard.videoPrompt, characters, boundIds)
  const [geography] = storyboard.sceneId
    ? await db.select({ id: schema.sceneGeographies.id })
      .from(schema.sceneGeographies)
      .where(eq(schema.sceneGeographies.sceneId, storyboard.sceneId))
      .orderBy(desc(schema.sceneGeographies.version), desc(schema.sceneGeographies.id))
      .limit(1)
    : []
  await db.update(schema.storyboards).set({
    castOnScreen: jsonArray(parsed.castOnScreen),
    castOffScreen: jsonArray(parsed.castOffScreen),
    screenLeft: jsonArray(parsed.screenLeft),
    screenRight: jsonArray(parsed.screenRight),
    foregroundShoulder: parsed.foregroundShoulder,
    axisSide: parsed.axisSide,
    backgroundLandmarks: jsonArray(parsed.backgroundLandmarks),
    negativeConstraints: parsed.negativeConstraints,
    actionStart: parsed.actionStart,
    actionEnd: parsed.actionEnd,
    segmentPlan: jsonArray(parsed.segments),
    sceneGeographyId: geography?.id ?? null,
    contractVersion: parsed.contractVersion,
    updatedAt: storyboard.updatedAt,
  }).where(eq(schema.storyboards.id, storyboardId))
}

/** 回填一集所有存活分镜的合同字段；幂等，用于升级旧数据 */
export async function syncEpisodeContracts(episodeId: number): Promise<number> {
  const rows = await db.select({ id: schema.storyboards.id })
    .from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
  let changed = 0
  for (const row of rows) {
    try {
      await syncStoryboardContract(row.id)
      changed += 1
    } catch {
      // 单行失败不影响其他分镜
    }
  }
  return changed
}

function parseJsonArray(value: string | null | undefined): string[] | number[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function getStoryboardContract(storyboardId: number) {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!storyboard) return null
  const characterIds = [
    ...parseJsonArray(storyboard.castOnScreen),
    ...parseJsonArray(storyboard.castOffScreen),
  ].filter((id): id is number => typeof id === 'number')
  const characters = characterIds.length
    ? await db.select({ id: schema.characters.id, name: schema.characters.name })
      .from(schema.characters)
      .where(inArray(schema.characters.id, characterIds))
    : []
  const names = new Map(characters.map(character => [character.id, character.name]))
  return {
    storyboard_id: storyboard.id,
    storyboard_number: storyboard.storyboardNumber,
    contract_version: storyboard.contractVersion || 0,
    cast_on_screen: (parseJsonArray(storyboard.castOnScreen) as number[]).map(id => ({ id, name: names.get(id) || '' })),
    cast_off_screen: (parseJsonArray(storyboard.castOffScreen) as number[]).map(id => ({ id, name: names.get(id) || '' })),
    screen_left: parseJsonArray(storyboard.screenLeft),
    screen_right: parseJsonArray(storyboard.screenRight),
    foreground_shoulder: storyboard.foregroundShoulder || null,
    background_landmarks: parseJsonArray(storyboard.backgroundLandmarks),
    negative_constraints: storyboard.negativeConstraints || null,
    segment_plan: storyboard.segmentPlan ? JSON.parse(storyboard.segmentPlan) : [],
    coverage_type: storyboard.coverageType || null,
    axis_side: storyboard.axisSide || null,
    blocking_start: storyboard.blockingStart || null,
    blocking_end: storyboard.blockingEnd || null,
    action_start: storyboard.actionStart || null,
    action_end: storyboard.actionEnd || null,
    gaze_target: storyboard.gazeTarget || null,
    camera_side: storyboard.cameraSide || null,
    scene_geography_id: storyboard.sceneGeographyId || null,
    plan_unit_id: storyboard.planUnitId || null,
  }
}
