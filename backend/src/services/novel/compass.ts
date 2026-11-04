/**
 * 灵感罗盘：图谱归一化、增量快照、逻辑审计与持久化。
 *
 * 数据形态：
 * - `novels.graph_meta`：version / generatedAt / audit / graphGenerated
 * - `novel_graph_snapshots`：按章快照（基线 chapter_no=0）
 * - `novel_chapter_graphs`：单章独立关系图
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { getNovel } from '../novels.js'
import { compassPrompts } from './prompts/index.js'

export class CompassDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompassDataError'
  }
}

export interface GraphNode {
  id: string
  label: string
  type: string
  importance?: number
  faction?: string | null
  status?: string
  bio?: string
  traits?: string[]
  firstAppearance?: number
  [key: string]: unknown
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  relationType: string
  label?: string
  strength?: number
  description?: string
  events?: string[]
  [key: string]: unknown
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphAuditItem {
  type: string
  severity: 'error' | 'warning' | 'info'
  nodeIds: string[]
  edgeIds: string[]
  chapters: number[]
  message: string
}

export interface GraphAudit {
  inconsistencies: GraphAuditItem[]
  lastAuditAt: string | null
}

export interface NovelGraphMeta {
  version: number
  generatedAt: string | null
  audit: GraphAudit
  graphGenerated: boolean
}

export interface NovelGraphData extends NovelGraphMeta {
  snapshots: Record<string, GraphSnapshot>
}

export interface NovelGraphResult {
  graphData: NovelGraphData
  chapterGraphs: Record<string, GraphSnapshot>
}

export interface CompassNovelContext {
  characterDynamics?: string | null
  characterState?: string | null
  worldBuilding?: string | null
  plotArchitecture?: string | null
  chapterBlueprint?: string | null
  chapters?: Array<{ chapterNo: number; content?: string | null }>
}

export type CompassGenerate = (prompt: string) => Promise<string>

const NODE_TYPES = new Set(['character', 'faction', 'location', 'item'])
const NODE_STATUSES = new Set(['active', 'deceased', 'offline'])
const RELATION_TYPES = new Set(['hostile', 'romantic', 'alliance', 'neutral', 'family', 'mentor'])
const SEVERITIES = new Set(['error', 'warning', 'info'])
const DELTA_KEYS = ['newNodes', 'updatedNodes', 'removedNodeIds', 'newEdges', 'updatedEdges', 'removedEdgeIds']

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parseCompassJson(value: unknown): Record<string, any> | null {
  if (typeof value !== 'string') return asRecord(value)
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return asRecord(JSON.parse(match[0]))
    } catch {
      return null
    }
  }
}

export function normalizeNode(value: unknown): GraphNode | null {
  const raw = asRecord(value)
  if (!raw) return null
  const id = text(raw.id)
  if (!id) return null
  const type = text(raw.type, 'character')
  const status = text(raw.status, 'active')
  return {
    ...raw,
    id,
    label: text(raw.label, id),
    type: NODE_TYPES.has(type) ? type : 'character',
    importance: numberInRange(raw.importance, 5, 1, 10),
    faction: text(raw.faction) || null,
    status: NODE_STATUSES.has(status) ? status : 'active',
    bio: text(raw.bio),
    traits: stringList(raw.traits),
    firstAppearance: numberInRange(raw.firstAppearance, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

export function normalizeEdge(value: unknown, index: number): GraphEdge | null {
  const raw = asRecord(value)
  if (!raw) return null
  const source = text(raw.source)
  const target = text(raw.target)
  if (!source || !target) return null
  const relationType = text(raw.relationType, 'neutral')
  return {
    ...raw,
    id: text(raw.id) || `edge_${source}_${target}_${index}`,
    source,
    target,
    relationType: RELATION_TYPES.has(relationType) ? relationType : 'neutral',
    label: text(raw.label),
    strength: numberInRange(raw.strength, 3, 1, 10),
    description: text(raw.description),
    events: stringList(raw.events),
  }
}

export function normalizeSnapshot(value: unknown): GraphSnapshot {
  const raw = asRecord(value)
  if (!raw) throw new CompassDataError('图谱数据格式不正确')
  if (!Array.isArray(raw.nodes)) throw new CompassDataError('图谱节点必须是数组')

  const nodeIds = new Set<string>()
  const nodes: GraphNode[] = []
  for (const item of raw.nodes) {
    const node = normalizeNode(item)
    if (!node || nodeIds.has(node.id)) continue
    nodeIds.add(node.id)
    nodes.push(node)
  }

  const edgeIds = new Set<string>()
  const edges: GraphEdge[] = []
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  rawEdges.forEach((item, index) => {
    const edge = normalizeEdge(item, index)
    if (!edge || edgeIds.has(edge.id)) return
    edgeIds.add(edge.id)
    edges.push(edge)
  })

  return { nodes, edges }
}

export function applyDelta(snapshot: GraphSnapshot, delta: unknown): GraphSnapshot {
  const base = normalizeSnapshot(snapshot)
  const raw = asRecord(delta) || {}
  const nodes = base.nodes.map((node) => ({ ...node }))
  const edges = base.edges.map((edge) => ({ ...edge }))

  const newNodes = Array.isArray(raw.newNodes) ? raw.newNodes : []
  newNodes.forEach((item) => {
    const node = normalizeNode(item)
    if (node && !nodes.some((existing) => existing.id === node.id)) nodes.push(node)
  })

  const updatedNodes = Array.isArray(raw.updatedNodes) ? raw.updatedNodes : []
  for (const item of updatedNodes) {
    const update = asRecord(item)
    if (!update) continue
    const id = text(update.id)
    const index = nodes.findIndex((node) => node.id === id)
    if (index < 0) continue
    const changes = asRecord(update.changes) || {}
    nodes[index] = normalizeNode({ ...nodes[index], ...changes, id }) || nodes[index]
  }

  for (const id of stringList(raw.removedNodeIds)) {
    const index = nodes.findIndex((node) => node.id === id)
    if (index >= 0) nodes.splice(index, 1)
  }

  const newEdges = Array.isArray(raw.newEdges) ? raw.newEdges : []
  newEdges.forEach((item, index) => {
    const edge = normalizeEdge(item, nodes.length + index)
    if (edge && !edges.some((existing) => existing.id === edge.id)) edges.push(edge)
  })

  const updatedEdges = Array.isArray(raw.updatedEdges) ? raw.updatedEdges : []
  for (const item of updatedEdges) {
    const update = asRecord(item)
    if (!update) continue
    const id = text(update.id)
    const index = edges.findIndex((edge) => edge.id === id)
    if (index < 0) continue
    const changes = asRecord(update.changes) || {}
    const previousEvents = edges[index].events || []
    const nextEvents = stringList(changes.events)
    const merged = {
      ...edges[index],
      ...changes,
      id,
      events: nextEvents.length ? [...previousEvents, ...nextEvents] : previousEvents,
    }
    edges[index] = normalizeEdge(merged, index) || edges[index]
  }

  for (const id of stringList(raw.removedEdgeIds)) {
    const index = edges.findIndex((edge) => edge.id === id)
    if (index >= 0) edges.splice(index, 1)
  }

  return { nodes, edges }
}

export function getSnapshotForChapter(
  snapshots: Record<string, GraphSnapshot>,
  chapterNo: number,
): GraphSnapshot | null {
  const keys = Object.keys(snapshots).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  let best: number | null = null
  for (const key of keys) {
    if (key <= chapterNo) best = key
    else break
  }
  return best === null ? null : snapshots[String(best)] || null
}

export function getSnapshotChapters(snapshots: Record<string, GraphSnapshot>): number[] {
  return Object.keys(snapshots).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

function normalizeAudit(value: unknown): GraphAudit {
  const raw = asRecord(value)
  const items = Array.isArray(raw?.inconsistencies) ? raw!.inconsistencies : []
  const inconsistencies: GraphAuditItem[] = []
  for (const item of items) {
    const row = asRecord(item)
    if (!row) continue
    const severity = text(row.severity, 'info')
    inconsistencies.push({
      type: text(row.type, 'unknown'),
      severity: SEVERITIES.has(severity) ? severity as GraphAuditItem['severity'] : 'info',
      nodeIds: stringList(row.nodeIds),
      edgeIds: stringList(row.edgeIds),
      chapters: Array.isArray(row.chapters)
        ? row.chapters.map(Number).filter((chapter) => Number.isSafeInteger(chapter) && chapter >= 0)
        : [],
      message: text(row.message),
    })
  }
  return {
    inconsistencies,
    lastAuditAt: typeof raw?.lastAuditAt === 'string' && raw.lastAuditAt ? raw.lastAuditAt : null,
  }
}

function parseGraphMeta(raw: string | null | undefined): NovelGraphMeta {
  const parsed = parseCompassJson(raw || '')
  if (!parsed) {
    return {
      version: 1,
      generatedAt: null,
      audit: { inconsistencies: [], lastAuditAt: null },
      graphGenerated: false,
    }
  }
  return {
    version: Number.isSafeInteger(Number(parsed.version)) ? Number(parsed.version) : 1,
    generatedAt: typeof parsed.generatedAt === 'string' && parsed.generatedAt ? parsed.generatedAt : null,
    audit: normalizeAudit(parsed.audit),
    graphGenerated: Boolean(parsed.graphGenerated),
  }
}

function readSnapshots(novelId: number): Record<string, GraphSnapshot> {
  const rows = db.select().from(schema.novelGraphSnapshots)
    .where(eq(schema.novelGraphSnapshots.novelId, novelId))
    .orderBy(schema.novelGraphSnapshots.chapterNo)
    .all()
  const snapshots: Record<string, GraphSnapshot> = {}
  for (const row of rows) {
    try {
      snapshots[String(row.chapterNo)] = normalizeSnapshot({
        nodes: parseJsonArray(row.nodes),
        edges: parseJsonArray(row.edges),
      })
    } catch {
      // 损坏的行跳过，避免整页图谱不可用
    }
  }
  return snapshots
}

function readChapterGraphs(novelId: number): Record<string, GraphSnapshot> {
  const rows = db.select().from(schema.novelChapterGraphs)
    .where(eq(schema.novelChapterGraphs.novelId, novelId))
    .orderBy(schema.novelChapterGraphs.chapterNo)
    .all()
  const graphs: Record<string, GraphSnapshot> = {}
  for (const row of rows) {
    try {
      graphs[String(row.chapterNo)] = normalizeSnapshot({
        nodes: parseJsonArray(row.nodes),
        edges: parseJsonArray(row.edges),
      })
    } catch {
      // 同上
    }
  }
  return graphs
}

function writeMeta(novelId: number, meta: NovelGraphMeta) {
  db.update(schema.novels)
    .set({ graphMeta: JSON.stringify(meta) })
    .where(eq(schema.novels.id, novelId))
    .run()
}

function mergeMeta(novelId: number, patch: Partial<NovelGraphMeta>) {
  const novel = getNovel(novelId)
  if (!novel) return
  const current = parseGraphMeta(novel.graphMeta)
  writeMeta(novelId, {
    ...current,
    ...patch,
    audit: patch.audit ?? current.audit,
  })
}

export function getNovelGraph(novelId: number): NovelGraphResult | null {
  const novel = getNovel(novelId)
  if (!novel) return null
  const meta = parseGraphMeta(novel.graphMeta)
  const snapshots = readSnapshots(novelId)
  return {
    graphData: {
      ...meta,
      graphGenerated: Object.keys(snapshots).length > 0,
      snapshots,
    },
    chapterGraphs: readChapterGraphs(novelId),
  }
}

function upsertSnapshot(novelId: number, chapterNo: number, snapshot: GraphSnapshot, ts: string) {
  const existing = db.select().from(schema.novelGraphSnapshots)
    .where(and(
      eq(schema.novelGraphSnapshots.novelId, novelId),
      eq(schema.novelGraphSnapshots.chapterNo, chapterNo),
    ))
    .get()
  const values = {
    nodes: JSON.stringify(snapshot.nodes),
    edges: JSON.stringify(snapshot.edges),
    updatedAt: ts,
  }
  if (existing) {
    db.update(schema.novelGraphSnapshots)
      .set(values)
      .where(eq(schema.novelGraphSnapshots.id, existing.id))
      .run()
  } else {
    db.insert(schema.novelGraphSnapshots)
      .values({ novelId, chapterNo, ...values, createdAt: ts })
      .run()
  }
}

function upsertChapterGraph(novelId: number, chapterNo: number, snapshot: GraphSnapshot, ts: string) {
  const existing = db.select().from(schema.novelChapterGraphs)
    .where(and(
      eq(schema.novelChapterGraphs.novelId, novelId),
      eq(schema.novelChapterGraphs.chapterNo, chapterNo),
    ))
    .get()
  const values = {
    nodes: JSON.stringify(snapshot.nodes),
    edges: JSON.stringify(snapshot.edges),
    updatedAt: ts,
  }
  if (existing) {
    db.update(schema.novelChapterGraphs)
      .set(values)
      .where(eq(schema.novelChapterGraphs.id, existing.id))
      .run()
  } else {
    db.insert(schema.novelChapterGraphs)
      .values({ novelId, chapterNo, ...values, createdAt: ts })
      .run()
  }
}

export function saveSnapshot(novelId: number, chapterNo: number, snapshot: GraphSnapshot) {
  const normalized = normalizeSnapshot(snapshot)
  const ts = now()
  upsertSnapshot(novelId, chapterNo, normalized, ts)
  mergeMeta(novelId, { generatedAt: ts, graphGenerated: true })
  return normalized
}

export function replaceBaseGraph(novelId: number, snapshot: GraphSnapshot) {
  const normalized = normalizeSnapshot(snapshot)
  const ts = now()
  db.transaction((tx) => {
    tx.delete(schema.novelGraphSnapshots)
      .where(eq(schema.novelGraphSnapshots.novelId, novelId))
      .run()
    tx.insert(schema.novelGraphSnapshots).values({
      novelId,
      chapterNo: 0,
      nodes: JSON.stringify(normalized.nodes),
      edges: JSON.stringify(normalized.edges),
      createdAt: ts,
      updatedAt: ts,
    }).run()
    tx.update(schema.novels)
      .set({
        graphMeta: JSON.stringify({
          version: 1,
          generatedAt: ts,
          audit: { inconsistencies: [], lastAuditAt: null },
          graphGenerated: true,
        } satisfies NovelGraphMeta),
      })
      .where(eq(schema.novels.id, novelId))
      .run()
  })
  return normalized
}

export function saveGraphAudit(novelId: number, audit: GraphAudit) {
  const normalized = normalizeAudit(audit)
  mergeMeta(novelId, { audit: normalized })
  return normalized
}

export function saveChapterGraph(novelId: number, chapterNo: number, snapshot: GraphSnapshot) {
  if (!Number.isSafeInteger(chapterNo) || chapterNo < 1) {
    throw new CompassDataError('章节号必须是正整数')
  }
  const normalized = normalizeSnapshot(snapshot)
  upsertChapterGraph(novelId, chapterNo, normalized, now())
  return normalized
}

function parseSnapshotRecord(raw: unknown, minChapterNo: number): Record<string, GraphSnapshot> {
  if (raw === undefined || raw === null) return {}
  const record = asRecord(raw)
  if (!record) throw new CompassDataError('图谱快照必须是对象')
  const result: Record<string, GraphSnapshot> = {}
  for (const [key, value] of Object.entries(record)) {
    const chapterNo = Number(key)
    if (!Number.isSafeInteger(chapterNo) || chapterNo < minChapterNo) {
      throw new CompassDataError(`图谱章节号无效：${key}`)
    }
    result[String(chapterNo)] = normalizeSnapshot(value)
  }
  return result
}

export function saveNovelGraph(
  novelId: number,
  input: { graphData?: unknown; chapterGraphs?: unknown },
): NovelGraphResult | null {
  const novel = getNovel(novelId)
  if (!novel) return null

  const hasGraph = input.graphData !== undefined && input.graphData !== null
  const hasChapterGraphs = input.chapterGraphs !== undefined && input.chapterGraphs !== null
  if (!hasGraph && !hasChapterGraphs) return getNovelGraph(novelId)

  const ts = now()
  let meta: NovelGraphMeta | null = null
  let snapshots: Record<string, GraphSnapshot> | null = null
  let chapterGraphs: Record<string, GraphSnapshot> | null = null

  if (hasGraph) {
    const raw = asRecord(input.graphData)
    if (!raw) throw new CompassDataError('graph_data 必须是对象')
    snapshots = parseSnapshotRecord(raw.snapshots ?? {}, 0)
    meta = {
      version: Number.isSafeInteger(Number(raw.version)) ? Number(raw.version) : 1,
      generatedAt: typeof raw.generatedAt === 'string' && raw.generatedAt ? raw.generatedAt : null,
      audit: normalizeAudit(raw.audit),
      graphGenerated: raw.graphGenerated !== undefined
        ? Boolean(raw.graphGenerated)
        : Object.keys(snapshots).length > 0,
    }
  }
  if (hasChapterGraphs) {
    chapterGraphs = parseSnapshotRecord(input.chapterGraphs, 1)
  }

  db.transaction((tx) => {
    if (meta && snapshots) {
      tx.update(schema.novels)
        .set({ graphMeta: JSON.stringify(meta) })
        .where(eq(schema.novels.id, novelId))
        .run()
      tx.delete(schema.novelGraphSnapshots)
        .where(eq(schema.novelGraphSnapshots.novelId, novelId))
        .run()
      for (const [key, snapshot] of Object.entries(snapshots)) {
        tx.insert(schema.novelGraphSnapshots).values({
          novelId,
          chapterNo: Number(key),
          nodes: JSON.stringify(snapshot.nodes),
          edges: JSON.stringify(snapshot.edges),
          createdAt: ts,
          updatedAt: ts,
        }).run()
      }
    }
    if (chapterGraphs) {
      tx.delete(schema.novelChapterGraphs)
        .where(eq(schema.novelChapterGraphs.novelId, novelId))
        .run()
      for (const [key, snapshot] of Object.entries(chapterGraphs)) {
        tx.insert(schema.novelChapterGraphs).values({
          novelId,
          chapterNo: Number(key),
          nodes: JSON.stringify(snapshot.nodes),
          edges: JSON.stringify(snapshot.edges),
          createdAt: ts,
          updatedAt: ts,
        }).run()
      }
    }
  })

  return getNovelGraph(novelId)
}

function requireNodeSnapshot(parsed: Record<string, any> | null, message: string): GraphSnapshot {
  if (!parsed || !Array.isArray(parsed.nodes)) throw new CompassDataError(message)
  const snapshot = normalizeSnapshot(parsed)
  if (!snapshot.nodes.length) throw new CompassDataError(message)
  return snapshot
}

export async function generateBaseGraph(
  novel: CompassNovelContext,
  generate: CompassGenerate,
): Promise<{ snapshot: GraphSnapshot; graphData: NovelGraphData }> {
  const prompt = compassPrompts.extractGraph({
    characterDynamics: novel.characterDynamics,
    characterState: novel.characterState,
    worldBuilding: novel.worldBuilding,
    plotArchitecture: novel.plotArchitecture,
  })
  const snapshot = requireNodeSnapshot(
    parseCompassJson(await generate(prompt)),
    '图谱提取失败：模型返回的数据格式不正确',
  )
  const ts = now()
  return {
    snapshot,
    graphData: {
      version: 1,
      generatedAt: ts,
      snapshots: { '0': snapshot },
      audit: { inconsistencies: [], lastAuditAt: null },
      graphGenerated: true,
    },
  }
}

export interface SnapshotProgressEvent {
  phase: 'start' | 'done'
  current: number
  total: number
  chapterNo: number
}

export interface GenerateSnapshotsOptions {
  snapshots: Record<string, GraphSnapshot>
  chapters: Array<{ chapterNo: number; content?: string | null }>
  generate: CompassGenerate
  onProgress?: (event: SnapshotProgressEvent) => void
  onSnapshot?: (chapterNo: number, snapshot: GraphSnapshot) => void
}

export interface GenerateSnapshotsResult {
  snapshots: Record<string, GraphSnapshot>
  pending: number
  generated: number
  failed: number
  skipped: number
}

export async function generateChapterSnapshots(
  options: GenerateSnapshotsOptions,
): Promise<GenerateSnapshotsResult> {
  const snapshots: Record<string, GraphSnapshot> = { ...options.snapshots }
  if (!snapshots['0']) throw new CompassDataError('请先生成基线图谱')

  const pending = options.chapters
    .filter((chapter) => Number.isSafeInteger(chapter.chapterNo)
      && chapter.chapterNo > 0
      && Boolean(chapter.content?.trim())
      && !snapshots[String(chapter.chapterNo)])
    .sort((a, b) => a.chapterNo - b.chapterNo)

  let generated = 0
  let failed = 0
  let skipped = 0

  for (let index = 0; index < pending.length; index += 1) {
    const chapter = pending[index]
    const chapterNo = chapter.chapterNo
    options.onProgress?.({ phase: 'start', current: index, total: pending.length, chapterNo })

    const current = getSnapshotForChapter(snapshots, chapterNo - 1)
    if (!current) {
      skipped += 1
      options.onProgress?.({ phase: 'done', current: index + 1, total: pending.length, chapterNo })
      continue
    }

    const prompt = compassPrompts.extractChapterDelta({
      currentNodes: current.nodes,
      currentEdges: current.edges,
      chapterNumber: chapterNo,
      chapterText: chapter.content,
    })
    const delta = parseCompassJson(await options.generate(prompt))
    if (!delta) {
      failed += 1
      options.onProgress?.({ phase: 'done', current: index + 1, total: pending.length, chapterNo })
      continue
    }

    const hasDelta = DELTA_KEYS.some((key) => Array.isArray(delta[key]) && delta[key].length > 0)
    if (!hasDelta) {
      skipped += 1
      options.onProgress?.({ phase: 'done', current: index + 1, total: pending.length, chapterNo })
      continue
    }

    const next = applyDelta(current, delta)
    snapshots[String(chapterNo)] = next
    options.onSnapshot?.(chapterNo, next)
    generated += 1
    options.onProgress?.({ phase: 'done', current: index + 1, total: pending.length, chapterNo })
  }

  return { snapshots, pending: pending.length, generated, failed, skipped }
}

export function buildSnapshotsText(snapshots: Record<string, GraphSnapshot>): string {
  return getSnapshotChapters(snapshots)
    .map((chapterNo) => {
      const snapshot = snapshots[String(chapterNo)]
      return `--- 第 ${chapterNo} 章快照 ---\n节点: ${snapshot.nodes.map((node) => `${node.label}(${node.status || 'active'})`).join(', ')}\n关系: ${snapshot.edges.map((edge) => `${edge.source}-[${edge.relationType}]-${edge.target}`).join(', ')}`
    })
    .join('\n\n')
}

export async function auditNovelGraph(options: {
  graphData: NovelGraphData
  chapterBlueprint?: string | null
  generate: CompassGenerate
}): Promise<GraphAudit> {
  const chapters = getSnapshotChapters(options.graphData.snapshots)
  if (!options.graphData.graphGenerated || !chapters.length) {
    throw new CompassDataError('请先生成图谱')
  }
  const prompt = compassPrompts.auditGraph({
    chapterBlueprint: options.chapterBlueprint || '(暂无大纲)',
    snapshotsText: buildSnapshotsText(options.graphData.snapshots),
  })
  const parsed = parseCompassJson(await options.generate(prompt))
  if (!parsed || !Array.isArray(parsed.inconsistencies)) {
    throw new CompassDataError('逻辑审计失败：模型返回的数据格式不正确')
  }
  return normalizeAudit({ ...parsed, lastAuditAt: now() })
}

export async function generateChapterGraph(options: {
  chapterNo: number
  content: string
  characterState?: string | null
  generate: CompassGenerate
}): Promise<GraphSnapshot> {
  const prompt = compassPrompts.extractChapterGraph({
    chapterNumber: options.chapterNo,
    chapterText: options.content,
    characterState: options.characterState,
  })
  return requireNodeSnapshot(
    parseCompassJson(await options.generate(prompt)),
    '本章关系提取失败：模型返回的数据格式不正确',
  )
}
