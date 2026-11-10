/**
 * 分镜动作检验 · 过渡分镜插入
 *
 * 语义检查 2 判定断点需要过渡时，由修复层调用本模块：
 * - 只按数据库 ID 定位断点两侧分镜，插入真实分镜行；
 * - 插入后按 ID 顺序重排整集镜头号，并同步改写 @镜头N末帧 引用与末帧资产；
 * - 原断点的视频过渡行失活，回滚时按批次逆向还原编号、引用与过渡。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  computeAuditShotFingerprint,
  type AuditEpisodeContext,
  type AuditContextShot,
} from './storyboard-audit-context.js'
import {
  AUDIT_TRANSITION_KINDS,
  type AuditIssue,
  type TransitionSuggestion,
} from './storyboard-audit-rules.js'

export const TRANSITION_TOKEN_RE = /@镜头(\d+)末帧/g
/** continuity 里常见的「承接段17」「承接第 17 镜」「为第 19 镜」引用 */
const SEGMENT_REFERENCE_RE = /承接段(\d+)/g
const SHOT_REFERENCE_RE = /(承接第|为第)(\s*)(\d+)(\s*)镜/g

const REWRITE_FIELDS = ['description', 'videoPrompt', 'result', 'continuity', 'imagePrompt'] as const
export type TransitionRewriteField = (typeof REWRITE_FIELDS)[number]

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface TransitionInsertionPlan {
  issueId: string
  anchorStoryboardId: number
  anchorStoryboardNumber: number
  from: AuditContextShot
  to: AuditContextShot
  kind: TransitionSuggestion
  sceneId: number
  sceneName: string
  location: string
  time: string | null
  text: string | null
}

export type TransitionInsertionResolution =
  | { plan: TransitionInsertionPlan }
  | { reason: string }

export interface TransitionInsertionLayoutEntry {
  type: 'shot' | 'insertion'
  number: number
  shot?: AuditContextShot
  plan?: TransitionInsertionPlan
}

export interface TransitionInsertionLayout {
  entries: TransitionInsertionLayoutEntry[]
  numberById: Map<number, number>
  insertedNumbers: Map<string, number>
  shiftedIds: number[]
  textPatches: Map<number, Record<string, string>>
  changedIds: number[]
}

export interface AppliedTransitionInsertion {
  plan: TransitionInsertionPlan
  insertedId: number
  insertedNumber: number
  insertedFingerprint: string
}

export interface AppliedTransitionBatch {
  insertions: AppliedTransitionInsertion[]
  numberById: Record<string, number>
  transitionBackups: { id: number; enabled: boolean }[]
}

function boundaryKey(leftId: number, rightId: number): string {
  return leftId < rightId ? `${leftId}:${rightId}` : `${rightId}:${leftId}`
}

export function transitionBoundaryKey(leftId: number, rightId: number): string {
  return boundaryKey(leftId, rightId)
}

function sceneForBoundary(
  context: AuditEpisodeContext,
  from: AuditContextShot,
  to: AuditContextShot,
): { sceneId: number; sceneName: string } | null {
  for (const sceneId of [to.sceneId, from.sceneId]) {
    if (sceneId == null) continue
    const scene = context.assets.scenes.find((item) => (
      item.id === sceneId && item.dramaId === context.dramaId && !item.deletedAt
    ))
    if (scene) return { sceneId, sceneName: scene.name }
  }
  return null
}

/** 找出问题所指断点、两侧分镜与可用场景；所有判断只依赖库 ID 与稳定排序。 */
export function resolveTransitionInsertion(
  context: AuditEpisodeContext,
  issue: AuditIssue,
  options: {
    autoInsertTransition: boolean
    maxInsertedTransitions: number
    appliedInsertions: number
    appliedBoundaries: Set<string>;
  },
): TransitionInsertionResolution {
  if (!options.autoInsertTransition) return { reason: '策略已关闭自动插入过渡分镜' }
  if (options.appliedInsertions >= options.maxInsertedTransitions) {
    return { reason: `单任务最多自动插入 ${options.maxInsertedTransitions} 个过渡分镜` }
  }
  if (issue.suggestedTransition == null) return { reason: '该问题没有给出过渡类型建议' }
  if (!AUDIT_TRANSITION_KINDS.includes(issue.suggestedTransition)) {
    return { reason: `过渡类型 ${String(issue.suggestedTransition)} 不合法` }
  }

  const ordered = context.shots
  const anchorIndex = ordered.findIndex((shot) => shot.id === issue.storyboardId)
  if (anchorIndex < 0) return { reason: '问题所属分镜不存在或已删除，不能插入过渡分镜' }
  const anchor = ordered[anchorIndex]
  if (anchor.transitionKind != null) {
    return { reason: '问题所属分镜本身是过渡分镜，不能作为插卡锚点' }
  }
  const relatedIds = [...new Set(issue.relatedStoryboardIds ?? [])]
    .filter((id) => Number.isFinite(id) && id !== anchor.id)
  const relatedShots = relatedIds
    .map((id) => ordered.find((shot) => shot.id === id))
    .filter((shot): shot is AuditContextShot => shot != null)
  if (relatedShots.some((shot) => shot.transitionKind != null)) {
    return { reason: '断点相关镜头包含已存在的过渡分镜，不能重复插入过渡分镜' }
  }

  let from: AuditContextShot | null = null
  let to: AuditContextShot | null = null
  for (const related of relatedShots) {
    const relatedIndex = ordered.findIndex((shot) => shot.id === related.id)
    if (relatedIndex === anchorIndex - 1) {
      from = related
      to = anchor
      break
    }
    if (relatedIndex === anchorIndex + 1) {
      from = anchor
      to = related
      break
    }
  }
  if (!from || !to) {
    if (relatedIds.length) {
      return { reason: '相关分镜与问题分镜不相邻，找不到可插入的过渡断点' }
    }
    if (anchorIndex > 0) {
      from = ordered[anchorIndex - 1]
      to = anchor
    } else if (anchorIndex + 1 < ordered.length) {
      from = anchor
      to = ordered[anchorIndex + 1]
    } else {
      return { reason: '该集只有一个分镜，无法插入过渡分镜' }
    }
  }

  if (from.transitionKind != null || to.transitionKind != null) {
    return { reason: '断点两侧已存在过渡分镜，不能重复插入' }
  }
  const key = boundaryKey(from.id, to.id)
  if (options.appliedBoundaries.has(key)) {
    return { reason: '该断点已经插入过过渡分镜，不能重复插入' }
  }

  const scene = sceneForBoundary(context, from, to)
  if (!scene) return { reason: '断点两侧没有可用的场景资产，不能自动插入过渡分镜' }

  return {
    plan: {
      issueId: issue.id,
      anchorStoryboardId: anchor.id,
      anchorStoryboardNumber: anchor.storyboardNumber,
      from,
      to,
      kind: issue.suggestedTransition,
      sceneId: scene.sceneId,
      sceneName: scene.sceneName,
      location: (to.location || from.location || scene.sceneName).trim(),
      time: to.time || from.time || null,
      text: to.time || from.time || null,
    },
  }
}

function rewriteTokens(
  text: string,
  numberMap: Map<number, number>,
  referenceMap: Map<number, number> = numberMap,
): string {
  return text
    .replace(TRANSITION_TOKEN_RE, (match, raw: string) => {
      const current = Number(raw)
      const next = numberMap.get(current)
      if (next == null || next === current) return match
      return `@镜头${next}末帧`
    })
    .replace(SEGMENT_REFERENCE_RE, (match, raw: string) => {
      const current = Number(raw)
      const next = referenceMap.get(current)
      if (next == null || next === current) return match
      return `承接段${next}`
    })
    .replace(SHOT_REFERENCE_RE, (match, prefix: string, lead: string, raw: string, tail: string) => {
      const current = Number(raw)
      const next = referenceMap.get(current)
      if (next == null || next === current) return match
      return `${prefix}${lead}${next}${tail}镜`
    })
}

/** 断点后方那一镜的「承接…」应改指向插入卡；其余引用仍按原编号映射 */
function buildReferenceMap(
  entries: TransitionInsertionLayoutEntry[],
  numberMap: Map<number, number>,
): Map<number, number> {
  const referenceMap = new Map(numberMap)
  for (const entry of entries) {
    if (entry.type !== 'insertion' || !entry.plan) continue
    referenceMap.set(entry.plan.from.storyboardNumber, entry.number)
  }
  return referenceMap
}

function buildTextPatches(
  shots: AuditContextShot[],
  numberMap: Map<number, number>,
  referenceMap: Map<number, number>,
): { patches: Map<number, Record<string, string>>; changedIds: number[] } {
  const patches = new Map<number, Record<string, string>>()
  const changedIds: number[] = []
  for (const shot of shots) {
    const patch: Record<string, string> = {}
    for (const field of REWRITE_FIELDS) {
      const before = shot[field]
      if (typeof before !== 'string' || !before) continue
      const after = rewriteTokens(before, numberMap, referenceMap)
      if (after !== before) patch[field] = after
    }
    if (Object.keys(patch).length) {
      patches.set(shot.id, patch)
      changedIds.push(shot.id)
    }
  }
  return { patches, changedIds }
}

/** 按原顺序把插入镜放到断点后方，并一次性算出新镜头号、文本补丁与受影响分镜。 */
export function buildTransitionInsertionLayout(
  context: AuditEpisodeContext,
  plans: TransitionInsertionPlan[],
): TransitionInsertionLayout {
  const plansByFrom = new Map<number, TransitionInsertionPlan[]>()
  for (const plan of plans) {
    const list = plansByFrom.get(plan.from.id) || []
    list.push(plan)
    plansByFrom.set(plan.from.id, list)
  }

  const entries: TransitionInsertionLayoutEntry[] = []
  const numberById = new Map<number, number>()
  const insertedNumbers = new Map<string, number>()
  const shiftedIds: number[] = []
  let number = 0
  for (const shot of context.shots) {
    number += 1
    numberById.set(shot.id, number)
    if (number !== shot.storyboardNumber) shiftedIds.push(shot.id)
    entries.push({ type: 'shot', shot, number })
    for (const plan of plansByFrom.get(shot.id) || []) {
      number += 1
      insertedNumbers.set(plan.issueId, number)
      entries.push({ type: 'insertion', plan, number })
    }
  }

  const oldToNew = new Map<number, number>()
  for (const shot of context.shots) {
    oldToNew.set(shot.storyboardNumber, numberById.get(shot.id) as number)
  }
  const { patches, changedIds } = buildTextPatches(
    context.shots,
    oldToNew,
    buildReferenceMap(entries, oldToNew),
  )

  return {
    entries,
    numberById,
    insertedNumbers,
    shiftedIds,
    textPatches: patches,
    changedIds: [...new Set([...shiftedIds, ...changedIds])],
  }
}

interface TransitionCopyFlavor {
  title: string
  shotType: string
  angle: string
  movement: string
  atmosphere: string
  result: string
  description: string
  visual: string
}

/**
 * 空镜过渡的四种拍法：按断点前镜编号轮换，避免一集所有断点都是同一种空镜。
 * 编号只决定拍法，不改变类型与时长。
 */
const EMPTY_TRANSITION_FLAVORS: TransitionCopyFlavor[] = [
  {
    title: '过渡空镜',
    shotType: '全景',
    angle: '平视',
    movement: '缓慢横移',
    atmosphere: '环境空镜过渡',
    result: '缓冲前后动作断点',
    description: '环境全景轻微横移，交代空间与光线',
    visual: '环境空镜，镜头缓慢横移，展示空间与光线',
  },
  {
    title: '过渡空镜·光影',
    shotType: '中景',
    angle: '侧逆光',
    movement: '固定机位',
    atmosphere: '光影细节过渡',
    result: '用光影变化衔接情绪',
    description: '固定机位捕捉光斑、浮尘或雨丝的细微变化，画面保持轻微呼吸感',
    visual: '光影细节空镜，固定机位，捕捉光斑与浮尘的细微变化',
  },
  {
    title: '过渡空镜·细节',
    shotType: '特写',
    angle: '俯拍',
    movement: '缓慢推近',
    atmosphere: '道具细节过渡',
    result: '用道具细节承接动作余韵',
    description: '缓慢推近断点附近的道具或环境细节（门把手、杯中水汽、衣角），暗示动作余韵',
    visual: '道具细节空镜，镜头缓慢推近门把手、杯中水汽或衣角等细节',
  },
  {
    title: '过渡空镜·氛围',
    shotType: '远景',
    angle: '平视',
    movement: '缓慢拉远',
    atmosphere: '天气氛围过渡',
    result: '拉开空间完成情绪转换',
    description: '从场景局部缓慢拉远到远景，让天气与天色变化接管画面',
    visual: '天气氛围空镜，镜头缓慢拉远，表现风雨或天色变化',
  },
]

/** 场景过渡的三种拍法：定场、细节、环视，按断点前镜编号轮换 */
const SCENE_TRANSITION_FLAVORS: TransitionCopyFlavor[] = [
  {
    title: '过渡场景',
    shotType: '远景',
    angle: '平视',
    movement: '缓慢推近',
    atmosphere: '环境定场过渡',
    result: '交代新场景空间',
    description: '以全景展示空间与光线，画面稳定后切入下一镜',
    visual: '全景环境展示，交代空间与时间',
  },
  {
    title: '过渡场景·细节',
    shotType: '中景',
    angle: '侧拍',
    movement: '缓慢横移',
    atmosphere: '场景细节过渡',
    result: '用场景细节补足地点信息',
    description: '以中景横移展示场景里的标志物与光线',
    visual: '场景标志物中景，镜头缓慢横移',
  },
  {
    title: '过渡场景·环视',
    shotType: '远景',
    angle: '低角度',
    movement: '缓慢摇移',
    atmosphere: '场景环视过渡',
    result: '环视空间完成地点转换',
    description: '低角度环视空间，从一侧缓慢摇到另一侧',
    visual: '低角度环境环视，镜头缓慢摇移',
  },
]

function pickTransitionFlavor(kind: 'empty' | 'scene', fromNumber: number): TransitionCopyFlavor {
  const flavors = kind === 'scene' ? SCENE_TRANSITION_FLAVORS : EMPTY_TRANSITION_FLAVORS
  const index = (Math.max(1, fromNumber) - 1) % flavors.length
  return flavors[index]
}

export function insertionCopy(plan: TransitionInsertionPlan, number: number, fromNumber: number, toNumber: number) {
  const continuity = `承接第 ${fromNumber} 镜的尾画面，为第 ${toNumber} 镜的入场留出空间。`
  if (plan.kind === 'text') {
    const text = (plan.text || '').trim() || '与此同时'
    return {
      title: '文字过渡',
      shotType: '特写',
      angle: '平视',
      movement: '固定',
      result: '完成文字转场',
      atmosphere: '黑场文字过渡',
      description: `文字过渡：黑底画面中央出现「${text}」文字卡，停留后淡出，衔接前后场景。`,
      videoPrompt: `出场人物：无｜场景：@${plan.sceneName}\n0-3秒：黑底画面中央出现「${text}」文字卡，停留片刻后淡出。`,
      continuity,
      transition: 'fade',
      transitionText: text,
      transitionSubtitle: plan.location,
      transitionKind: plan.kind,
      storyboardNumber: number,
    }
  }
  const flavor = pickTransitionFlavor(plan.kind, fromNumber)
  if (plan.kind === 'scene') {
    return {
      title: flavor.title,
      shotType: flavor.shotType,
      angle: flavor.angle,
      movement: flavor.movement,
      result: flavor.result,
      atmosphere: flavor.atmosphere,
      description: `${flavor.title}：${flavor.description}，画面稳定后切入下一镜。`,
      videoPrompt: `出场人物：无｜场景：@${plan.sceneName}\n0-3秒：${plan.location}的${flavor.visual}，交代空间与时间，无人物入画。`,
      continuity,
      transition: 'cut',
      transitionText: null,
      transitionSubtitle: null,
      transitionKind: plan.kind,
      storyboardNumber: number,
    }
  }
  return {
    title: flavor.title,
    shotType: flavor.shotType,
    angle: flavor.angle,
    movement: flavor.movement,
    result: flavor.result,
    atmosphere: flavor.atmosphere,
    description: `${flavor.title}：${plan.location}的${flavor.description}，无人物入镜，用于缓冲前后动作。`,
    videoPrompt: `出场人物：无｜场景：@${plan.sceneName}\n0-3秒：${plan.location}的${flavor.visual}，无人物入镜，用于承接前后场景。`,
    continuity,
    transition: 'cut',
    transitionText: null,
    transitionSubtitle: null,
    transitionKind: plan.kind,
    storyboardNumber: number,
  }
}

/** 事务内落库：插入真实分镜、按 ID 重排编号、改写引用、同步末帧资产并失活旧过渡行。 */
export function applyTransitionInsertions(
  tx: Tx,
  context: AuditEpisodeContext,
  layout: TransitionInsertionLayout,
  ts: string,
): AppliedTransitionBatch {
  const numberById: Record<string, number> = {}
  for (const shot of context.shots) numberById[String(shot.id)] = shot.storyboardNumber

  const insertions: AppliedTransitionInsertion[] = []
  for (const entry of layout.entries) {
    if (entry.type !== 'insertion' || !entry.plan) continue
    const plan = entry.plan
    const fromNumber = layout.numberById.get(plan.from.id) ?? plan.from.storyboardNumber
    const toNumber = layout.numberById.get(plan.to.id) ?? plan.to.storyboardNumber
    const copy = insertionCopy(plan, entry.number, fromNumber, toNumber)
    const row = tx.insert(schema.storyboards).values({
      episodeId: context.episodeId,
      sceneId: plan.sceneId,
      storyboardNumber: copy.storyboardNumber,
      title: copy.title,
      location: plan.location,
      time: plan.time,
      shotType: copy.shotType,
      angle: copy.angle,
      movement: copy.movement,
      result: copy.result,
      atmosphere: copy.atmosphere,
      description: copy.description,
      videoPrompt: copy.videoPrompt,
      transition: copy.transition,
      continuity: copy.continuity,
      duration: 3,
      transitionKind: copy.transitionKind,
      transitionText: copy.transitionText,
      transitionSubtitle: copy.transitionSubtitle,
      createdAt: ts,
      updatedAt: ts,
    }).returning().get()
    insertions.push({
      plan,
      insertedId: row.id,
      insertedNumber: entry.number,
      insertedFingerprint: '',
    })
  }

  const oldToNew = new Map<number, number>()
  for (const shot of context.shots) {
    oldToNew.set(shot.storyboardNumber, layout.numberById.get(shot.id) ?? shot.storyboardNumber)
  }
  const referenceMap = buildReferenceMap(layout.entries, oldToNew)
  for (const entry of layout.entries) {
    if (entry.type !== 'shot' || !entry.shot) continue
    const shot = entry.shot
    const fresh = tx.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, shot.id)).get()
    const patch: Record<string, string | number> = {}
    if (entry.number !== shot.storyboardNumber) patch.storyboardNumber = entry.number
    // 以事务内的最新行改写引用，避免覆盖同批次刚提交的字段修复
    if (fresh) {
      for (const field of REWRITE_FIELDS) {
        const before = fresh[field]
        if (typeof before !== 'string' || !before) continue
        const after = rewriteTokens(before, oldToNew, referenceMap)
        if (after !== before) patch[field] = after
      }
    }
    if (!Object.keys(patch).length) continue
    tx.update(schema.storyboards).set({ ...patch, updatedAt: ts } as never)
      .where(eq(schema.storyboards.id, shot.id)).run()
  }

  if (layout.shiftedIds.length) {
    const frameAssets = tx.select().from(schema.assets)
      .where(and(
        eq(schema.assets.category, 'storyboard_frame'),
        isNull(schema.assets.deletedAt),
        inArray(schema.assets.storyboardId, layout.shiftedIds),
      ))
      .all()
    for (const asset of frameAssets) {
      if (asset.storyboardId == null) continue
      const nextNumber = layout.numberById.get(asset.storyboardId)
      if (nextNumber == null || nextNumber === asset.storyboardNum) continue
      const matched = /^镜头(\d+)末帧$/.exec(asset.name || '')
      const nextName = matched && Number(matched[1]) === (asset.storyboardNum ?? Number(matched[1]))
        ? `镜头${nextNumber}末帧`
        : asset.name
      tx.update(schema.assets).set({
        storyboardNum: nextNumber,
        ...(nextName !== asset.name ? { name: nextName } : {}),
        updatedAt: ts,
      } as never).where(eq(schema.assets.id, asset.id)).run()
    }
  }

  const transitionBackups: { id: number; enabled: boolean }[] = []
  for (const insertion of insertions) {
    const rows = tx.select().from(schema.videoTransitions)
      .where(and(
        eq(schema.videoTransitions.fromStoryboardId, insertion.plan.from.id),
        eq(schema.videoTransitions.toStoryboardId, insertion.plan.to.id),
      ))
      .all()
    for (const row of rows) {
      if (!row.enabled) continue
      transitionBackups.push({ id: row.id, enabled: true })
      tx.update(schema.videoTransitions).set({ enabled: false, updatedAt: ts })
        .where(eq(schema.videoTransitions.id, row.id)).run()
    }
    const fresh = tx.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, insertion.insertedId)).get()
    if (fresh) {
      insertion.insertedFingerprint = computeInsertedFingerprint(fresh)
    }
  }

  return { insertions, numberById, transitionBackups }
}

function computeInsertedFingerprint(shot: typeof schema.storyboards.$inferSelect): string {
  return computeAuditShotFingerprint({
    ...shot,
    characterIds: [],
    propIds: [],
  })
}

/**
 * 回滚一批插入：删除插入行，按批次记录的原编号还原全部既有分镜，
 * 同步把 @镜头N末帧、末帧资产和断点过渡恢复到插入前。
 */
export function restoreTransitionBatch(
  tx: Tx,
  entry: {
    insertedIds: number[]
    numberById: Record<string, number>
    transitionBackups: { id: number; enabled: boolean }[]
    /** 插入卡编号 → 断点 from 原编号：回滚时把「承接插入卡」的引用还原 */
    insertionReferences?: { insertedNumber: number; originalFromNumber: number }[]
  },
  ts: string,
): void {
  for (const insertedId of entry.insertedIds) {
    tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, insertedId)).run()
    tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, insertedId)).run()
    tx.delete(schema.storyboards).where(eq(schema.storyboards.id, insertedId)).run()
  }

  const live = tx.select().from(schema.storyboards)
    .where(isNull(schema.storyboards.deletedAt))
    .all()
  const wanted = new Map<number, number>()
  for (const [rawId, rawNumber] of Object.entries(entry.numberById)) {
    const id = Number(rawId)
    const number = Number(rawNumber)
    if (Number.isFinite(id) && Number.isFinite(number) && number > 0) wanted.set(id, number)
  }
  const currentToOriginal = new Map<number, number>()
  const numberPatches = new Map<number, number>()
  for (const row of live) {
    const original = wanted.get(row.id)
    if (original == null) continue
    if (row.storyboardNumber !== original) {
      currentToOriginal.set(row.storyboardNumber, original)
      numberPatches.set(row.id, original)
    }
  }
  const referenceMap = new Map(currentToOriginal)
  for (const reference of entry.insertionReferences || []) {
    if (reference.insertedNumber > 0 && reference.originalFromNumber > 0) {
      referenceMap.set(reference.insertedNumber, reference.originalFromNumber)
    }
  }

  const assetRows = live.filter((row) => numberPatches.has(row.id))
  for (const row of live) {
    const patch: Record<string, string | number> = {}
    const nextNumber = numberPatches.get(row.id)
    if (nextNumber != null) patch.storyboardNumber = nextNumber
    for (const field of REWRITE_FIELDS) {
      const before = row[field]
      if (typeof before !== 'string' || !before) continue
      const after = rewriteTokens(before, currentToOriginal, referenceMap)
      if (after !== before) patch[field] = after
    }
    if (!Object.keys(patch).length) continue
    tx.update(schema.storyboards).set({ ...patch, updatedAt: ts } as never)
      .where(eq(schema.storyboards.id, row.id)).run()
  }

  if (assetRows.length) {
    const frameAssets = tx.select().from(schema.assets)
      .where(and(
        eq(schema.assets.category, 'storyboard_frame'),
        isNull(schema.assets.deletedAt),
        inArray(schema.assets.storyboardId, assetRows.map((row) => row.id)),
      ))
      .all()
    const originalById = new Map(assetRows.map((row) => [row.id, wanted.get(row.id) as number]))
    for (const asset of frameAssets) {
      if (asset.storyboardId == null) continue
      const nextNumber = originalById.get(asset.storyboardId)
      if (nextNumber == null || nextNumber === asset.storyboardNum) continue
      const matched = /^镜头(\d+)末帧$/.exec(asset.name || '')
      const nextName = matched && Number(matched[1]) === (asset.storyboardNum ?? Number(matched[1]))
        ? `镜头${nextNumber}末帧`
        : asset.name
      tx.update(schema.assets).set({
        storyboardNum: nextNumber,
        ...(nextName !== asset.name ? { name: nextName } : {}),
        updatedAt: ts,
      } as never).where(eq(schema.assets.id, asset.id)).run()
    }
  }

  for (const backup of entry.transitionBackups) {
    tx.update(schema.videoTransitions).set({ enabled: backup.enabled, updatedAt: ts })
      .where(eq(schema.videoTransitions.id, backup.id)).run()
  }
}
