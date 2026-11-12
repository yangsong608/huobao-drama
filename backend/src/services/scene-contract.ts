/**
 * 场景地理契约（SceneContract）
 *
 * 同场建立镜确定画面左/右、轴线、地标侧与固定陈设，后续镜头只读沿用。
 * 目前来源固定为同场第一个带画面常量的骨架；表结构预留 manual 编辑。
 * 拆分、修补、生成前门禁都读同一份契约，禁止按说话人变化翻转左右。
 */
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { PlanShot } from './storyboard-plan-contract.js'

export interface SceneContractSideValues {
  screenLeft: string | null
  screenRight: string | null
  axisSide: string | null
  landmarkSide: string | null
}

export interface SceneGeographyLandmark {
  name: string
  side: string
  note?: string
}

export interface ScenePropAnchor {
  name: string
  side: string
  state: string
}

export interface SceneGeography {
  layout: string
  landmarks: SceneGeographyLandmark[]
  entrances: string[]
  fixedProps: string[]
  propAnchors: ScenePropAnchor[]
  light: string
  weather: string
  ambientSound: string
  depth: {
    foreground: string
    midground: string
    background: string
  }
  notes: string
}

export interface SceneContractView extends SceneContractSideValues {
  id: number
  dramaId: number
  sceneId: number
  sceneName: string
  location: string
  time: string
  geography: SceneGeography
  sourceType: string
  sourceJobId: number | null
  sourceEpisodeId: number | null
  sourceShotNumber: number | null
  version: number
  status: string
  updatedAt: string
}

export interface SceneContractSyncInput {
  dramaId: number
  episodeId: number
  jobId: number
  plans: PlanShot[]
}

const FIXTURE_RE = /(柜台|灶台|灶|蒸笼|锅|案板|桌|椅|凳|门|窗|帘|屏风|书架|牌匾|摊|碗|筷|壶|杯)/g
const ENTRANCE_RE = /(店门|门口|门外|门内|里间|厨房|后院|楼梯|窗边|街口)/g
const SIDE_RE = /(画面左|画面右|左侧|右侧|前景|中景|后景|左|右)/

function text(value: string | null | undefined): string {
  return String(value || '').trim()
}

function unique(values: string[], limit = 12): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const item = text(value)
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => text(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

export function parseSceneGeography(value: string | null | undefined): SceneGeography {
  const fallback: SceneGeography = {
    layout: '',
    landmarks: [],
    entrances: [],
    fixedProps: [],
    propAnchors: [],
    light: '',
    weather: '',
    ambientSound: '',
    depth: { foreground: '', midground: '', background: '' },
    notes: '',
  }
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    const depth = parsed.depth && typeof parsed.depth === 'object' ? parsed.depth : {}
    return {
      layout: text(parsed.layout),
      landmarks: Array.isArray(parsed.landmarks)
        ? parsed.landmarks.map((item: any) => ({
            name: text(item?.name),
            side: text(item?.side),
            ...(text(item?.note) ? { note: text(item.note) } : {}),
          })).filter((item: SceneGeographyLandmark) => item.name)
        : [],
      entrances: Array.isArray(parsed.entrances) ? unique(parsed.entrances.map((item: any) => text(item))) : [],
      fixedProps: Array.isArray(parsed.fixedProps) ? unique(parsed.fixedProps.map((item: any) => text(item))) : [],
      propAnchors: Array.isArray(parsed.propAnchors)
        ? parsed.propAnchors.map((item: any) => ({
            name: text(item?.name),
            side: text(item?.side),
            state: text(item?.state),
          })).filter((item: ScenePropAnchor) => item.name)
        : [],
      light: text(parsed.light),
      weather: text(parsed.weather),
      ambientSound: text(parsed.ambientSound),
      depth: {
        foreground: text(depth.foreground),
        midground: text(depth.midground),
        background: text(depth.background),
      },
      notes: text(parsed.notes),
    }
  } catch {
    return fallback
  }
}

function landmarksFromSide(landmarkSide: string): SceneGeographyLandmark[] {
  const source = text(landmarkSide)
  if (!source) return []
  const result: SceneGeographyLandmark[] = []
  for (const chunk of source.split(/[，,；;、]/)) {
    const item = text(chunk)
    if (!item) continue
    const side = item.match(SIDE_RE)?.[1] || ''
    const name = text(item.replace(SIDE_RE, '').replace(/(?:在|位于|摆放在|放着|是|：|:)/g, ''))
    if (name) result.push({ name, side })
  }
  return result.slice(0, 10)
}

function fixturesFromSource(source: string): string[] {
  return unique([...source.matchAll(FIXTURE_RE)].map(match => match[1]), 8)
}

function entrancesFromSource(source: string, landmarks: SceneGeographyLandmark[]): string[] {
  const matches = unique([...source.matchAll(ENTRANCE_RE)].map(match => match[1]), 6)
  return matches.map(name => {
    const landmark = landmarks.find(item => item.name.includes(name) || name.includes(item.name))
    return landmark?.side ? `${name}（${landmark.side}）` : name
  })
}

export function deriveSceneGeography(plan: PlanShot, sides?: SceneContractSideValues | null): SceneGeography {
  const source = `${plan.actionStart || ''} ${plan.actionEnd || ''} ${plan.sourceExcerpt || ''}`
  const left = text(sides?.screenLeft ?? plan.screenLeft)
  const right = text(sides?.screenRight ?? plan.screenRight)
  const axis = text(sides?.axisSide ?? plan.axisSide)
  const landmarkSide = text(sides?.landmarkSide ?? plan.landmarkSide)
  const landmarks = landmarksFromSide(landmarkSide)
  const depth = { foreground: '', midground: '', background: '' }
  for (const item of landmarks) {
    if (/前景/.test(item.side)) depth.foreground = item.name
    else if (/中景/.test(item.side)) depth.midground = item.name
    else if (/后景/.test(item.side)) depth.background = item.name
  }
  const location = text(plan.location)
  const fixedProps = fixturesFromSource(source)
  const propAnchors = fixedProps.map(name => {
    const landmark = landmarks.find(item => item.name.includes(name) || name.includes(item.name))
    return { name, side: landmark?.side || '', state: '' }
  })
  const weather = source.match(/(晴天|阴天|雨天|下雨|暴雨|大雪|下雪|雾|大风|刮风)/)?.[1] || ''
  const ambientSound = /(店|铺|堂|馆|楼)/.test(location)
    ? '店内环境底噪（碗筷/人声/灶火），随镜头延续'
    : ''
  return {
    layout: [
      `${location || '本场'}`,
      `画面左=${left || '待定'}`,
      `画面右=${right || '待定'}`,
      `轴线=${axis || '待定'}`,
      `地标=${landmarkSide || '待定'}`,
    ].join('；'),
    landmarks,
    entrances: entrancesFromSource(source, landmarks),
    fixedProps,
    propAnchors,
    light: text(plan.time),
    weather,
    ambientSound,
    depth,
    notes: '由同场建立镜自动生成；后续镜头沿用，不因说话人变化翻转。',
  }
}

function contractView(row: typeof schema.sceneContracts.$inferSelect): SceneContractView {
  return {
    id: row.id,
    dramaId: row.dramaId,
    sceneId: row.sceneId,
    sceneName: row.sceneName || '',
    location: row.location || '',
    time: row.time || '',
    screenLeft: row.screenLeft,
    screenRight: row.screenRight,
    axisSide: row.axisSide,
    landmarkSide: row.landmarkSide,
    geography: parseSceneGeography(row.geographyJson),
    sourceType: row.sourceType || 'establishing_shot',
    sourceJobId: row.sourceJobId ?? null,
    sourceEpisodeId: row.sourceEpisodeId ?? null,
    sourceShotNumber: row.sourceShotNumber ?? null,
    version: row.version || 1,
    status: row.status || 'draft',
    updatedAt: row.updatedAt,
  }
}

export async function listSceneContracts(dramaId: number): Promise<SceneContractView[]> {
  const rows = await db.select().from(schema.sceneContracts)
    .where(eq(schema.sceneContracts.dramaId, dramaId))
    .orderBy(schema.sceneContracts.sceneId)
  return rows.map(contractView)
}

export async function getSceneContractMap(dramaId: number): Promise<Map<number, SceneContractView>> {
  const rows = await listSceneContracts(dramaId)
  return new Map(rows.map(row => [row.sceneId, row]))
}

export function sceneContractSides(contract: SceneContractView | null | undefined): SceneContractSideValues | null {
  if (!contract) return null
  if (!contract.screenLeft && !contract.screenRight && !contract.axisSide && !contract.landmarkSide) return null
  return {
    screenLeft: contract.screenLeft,
    screenRight: contract.screenRight,
    axisSide: contract.axisSide,
    landmarkSide: contract.landmarkSide,
  }
}

/** 场景契约 → 计划镜头：缺失常量从契约补齐，已有值保留交给门禁判断冲突 */
export function applySceneContractToPlan(plan: PlanShot, contract: SceneContractView | null | undefined): PlanShot {
  const sides = sceneContractSides(contract)
  if (!sides) return plan
  const axisAllowed = (plan.characterCount ?? 2) >= 2
  return {
    ...plan,
    screenLeft: plan.screenLeft || sides.screenLeft,
    screenRight: plan.screenRight || sides.screenRight,
    axisSide: axisAllowed ? (plan.axisSide || sides.axisSide) : null,
    landmarkSide: plan.landmarkSide || sides.landmarkSide,
  }
}

export function buildSceneContractBlock(contracts: SceneContractView[]): string {
  if (!contracts.length) return ''
  const lines = [
    '### 场景地理契约（同场建立镜，硬约束）',
    '下面每个场景的画面左/右、轴线、地标侧和固定陈设来自同场建立镜；后续镜头逐字沿用，禁止因说话人变化翻转左右或改布局。',
  ]
  for (const contract of contracts) {
    const sides = [
      `画面左=${contract.screenLeft || '待定'}`,
      `画面右=${contract.screenRight || '待定'}`,
      `轴线=${contract.axisSide || '待定'}`,
      `地标=${contract.landmarkSide || '待定'}`,
    ].join('；')
    const geo = contract.geography
    const details = [
      geo.entrances.length ? `出入口=${geo.entrances.join('/')}` : '',
      geo.fixedProps.length ? `固定道具=${geo.fixedProps.join('/')}` : '',
      geo.propAnchors.length ? `道具锚点=${geo.propAnchors.map(item => `${item.name}${item.side ? `(${item.side})` : ''}${item.state ? `[${item.state}]` : ''}`).join('/')}` : '',
      geo.light ? `建立镜光线=${geo.light}（本镜时间以 time 为准）` : '',
      geo.weather ? `天气=${geo.weather}` : '',
      geo.ambientSound ? `环境声=${geo.ambientSound}` : '',
    ].filter(Boolean).join('；')
    lines.push(`- ${contract.sceneName || contract.location || `场景${contract.sceneId}`}（scene_id=${contract.sceneId}，建立镜第 ${contract.sourceShotNumber || '?'} 镜）：${sides}${details ? `；${details}` : ''}`)
  }
  return lines.join('\n')
}

/** 拆完一段后把「同场第一个带画面常量的镜头」固化为场景契约；已有契约只补空缺，不改写建立镜常量。 */
export async function syncSceneContractsFromPlans(input: SceneContractSyncInput): Promise<Map<number, SceneContractView>> {
  const existing = await getSceneContractMap(input.dramaId)
  const ts = now()
  for (const plan of input.plans) {
    if (plan.sceneId == null) continue
    const sceneId = Number(plan.sceneId)
    const current = existing.get(sceneId)
    // 单人或空镜只建立地标/左右，不建立人物轴线。
    const axisAllowed = (plan.characterCount ?? 2) >= 2
    const planAxis = axisAllowed ? plan.axisSide : null
    const hasSides = Boolean(plan.screenLeft || plan.screenRight || planAxis || plan.landmarkSide)
    const sides = {
      screenLeft: current?.screenLeft || plan.screenLeft || null,
      screenRight: current?.screenRight || plan.screenRight || null,
      axisSide: current?.axisSide || planAxis || null,
      landmarkSide: current?.landmarkSide || plan.landmarkSide || null,
    }
    const geoSides = (current && sceneContractSides(current)) || (hasSides ? sides : null)
    const geography = deriveSceneGeography(plan, geoSides)
    if (!current) {
      const sourceShotNumber = plan.shotNumber
      const insertedId = getInsertId(db.insert(schema.sceneContracts).values({
        dramaId: input.dramaId,
        sceneId,
        sceneName: plan.location || null,
        location: plan.location || null,
        time: plan.time || null,
        ...sides,
        geographyJson: JSON.stringify(geography),
        sourceType: 'establishing_shot',
        sourceJobId: input.jobId,
        sourceEpisodeId: input.episodeId,
        sourceShotNumber,
        version: 1,
        status: hasSides ? 'active' : 'draft',
        createdAt: ts,
        updatedAt: ts,
      }).run())
      const inserted = db.select().from(schema.sceneContracts)
        .where(eq(schema.sceneContracts.id, insertedId))
        .get()
      if (inserted) existing.set(sceneId, contractView(inserted))
      continue
    }
    const gainedSides = !current.screenLeft && !current.screenRight && hasSides
    if (!gainedSides && current.geography.layout) continue
    db.update(schema.sceneContracts).set({
      ...sides,
      location: current.location || plan.location || null,
      sceneName: current.sceneName || plan.location || null,
      time: current.time || plan.time || null,
      geographyJson: JSON.stringify(geography),
      status: gainedSides ? 'active' : current.status,
      sourceShotNumber: gainedSides ? plan.shotNumber : current.sourceShotNumber,
      updatedAt: ts,
    }).where(eq(schema.sceneContracts.id, current.id)).run()
    const updated = db.select().from(schema.sceneContracts)
      .where(eq(schema.sceneContracts.id, current.id))
      .get()
    if (updated) existing.set(sceneId, contractView(updated))
  }
  return getSceneContractMap(input.dramaId)
}
