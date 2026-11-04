export type NarrativePerson = 'first' | 'third_limited' | 'third_omniscient'
export type TimelineSource = 'architecture' | 'chapter' | 'manual'
export type TimelineStatus = 'planned' | 'confirmed'

export const NARRATIVE_PERSONS: NarrativePerson[] = ['first', 'third_limited', 'third_omniscient']
export const DEFAULT_NARRATIVE_PERSON: NarrativePerson = 'first'
export const LEGACY_NARRATIVE_PERSON: NarrativePerson = 'third_limited'

export const NARRATIVE_PERSON_LABELS: Record<NarrativePerson, string> = {
  first: '第一人称',
  third_limited: '第三人称限知',
  third_omniscient: '第三人称全知',
}

export const NARRATIVE_PERSON_RULES: Record<NarrativePerson, string> = {
  first: '第一人称（「我」）叙述。只写视角人物能看到、听到、知道和想到的内容；不进入其他角色内心，不写视角人物不在场的场景。',
  third_limited: '第三人称限知叙述。围绕视角人物展开，只呈现视角人物可知的信息；不进入其他角色内心。',
  third_omniscient: '第三人称全知叙述。可进入不同角色的内心并交代全局信息，但不得破坏章节悬念与叙事连贯。',
}

export class StoryAtlasValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoryAtlasValidationError'
  }
}

export function normalizeNarrativePerson(
  value: unknown,
  fallback: NarrativePerson = LEGACY_NARRATIVE_PERSON,
): NarrativePerson {
  return typeof value === 'string' && (NARRATIVE_PERSONS as string[]).includes(value)
    ? value as NarrativePerson
    : fallback
}

export function narrativePersonLabel(person: NarrativePerson): string {
  return NARRATIVE_PERSON_LABELS[person]
}

export interface TimelineEvent {
  id: string
  chapterNo: number
  timeLabel: string
  title: string
  summary: string
  placeId?: string
  placeName?: string
  characters?: string[]
  importance: 1 | 2 | 3 | 4 | 5
  source: TimelineSource
  status: TimelineStatus
}

export interface NormalizeTimelineOptions {
  maxChapter?: number
  strict?: boolean
  defaultSource?: TimelineSource
  defaultStatus?: TimelineStatus
  idPrefix?: string
  placeIds?: Iterable<string>
  fixedChapterNo?: number
  maxEvents?: number
}

const TIMELINE_ID = /^[A-Za-z0-9_-]{1,64}$/
const TIMELINE_SOURCES: TimelineSource[] = ['architecture', 'chapter', 'manual']
const TIMELINE_STATUSES: TimelineStatus[] = ['planned', 'confirmed']

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

function clampImportance(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(Number(value))
  return (Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 3) as 1 | 2 | 3 | 4 | 5
}

function parseInput(input: unknown, strict: boolean): unknown[] {
  if (input === null || input === undefined) return []
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      if (strict) throw new StoryAtlasValidationError('时间线 JSON 格式不正确')
      return []
    }
  }
  if (!Array.isArray(input)) {
    if (strict) throw new StoryAtlasValidationError('timeline_events 必须是数组')
    return []
  }
  return input
}

export function normalizeTimelineEvents(
  input: unknown,
  options: NormalizeTimelineOptions = {},
): { events: TimelineEvent[]; warnings: string[] } {
  const {
    maxChapter = Number.MAX_SAFE_INTEGER,
    strict = false,
    defaultSource = 'manual',
    defaultStatus = 'planned',
    idPrefix = 'evt',
    fixedChapterNo,
  } = options
  const maxEvents = Math.max(1, options.maxEvents ?? 2000)
  const placeIds = options.placeIds ? new Set(options.placeIds) : null
  const warnings: string[] = []
  const events: TimelineEvent[] = []
  const usedIds = new Set<string>()

  const rawList = parseInput(input, strict)
  if (rawList.length > maxEvents) {
    if (strict) throw new StoryAtlasValidationError(`时间线事件不能超过 ${maxEvents} 条`)
    warnings.push(`时间线事件超过 ${maxEvents} 条，已截断`)
  }

  for (const raw of rawList.slice(0, maxEvents)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (strict) throw new StoryAtlasValidationError('时间线事件必须是对象')
      warnings.push('丢弃非对象时间线事件')
      continue
    }
    const item = raw as Record<string, unknown>
    const chapterNo = fixedChapterNo ?? Math.round(Number(item.chapterNo))
    if (!Number.isInteger(chapterNo) || chapterNo < 1 || chapterNo > maxChapter) {
      if (strict) throw new StoryAtlasValidationError(`时间线章节号必须在 1..${maxChapter} 之间`)
      warnings.push(`丢弃越界事件：chapterNo=${String(item.chapterNo)}`)
      continue
    }
    const title = cleanText(item.title, 80)
    if (!title) {
      if (strict) throw new StoryAtlasValidationError('时间线事件标题不能为空')
      warnings.push(`丢弃缺少标题的事件：chapterNo=${chapterNo}`)
      continue
    }
    const timeLabel = cleanText(item.timeLabel, 60)
    const summary = cleanText(item.summary, 500)
    const importance = clampImportance(item.importance)
    const source = TIMELINE_SOURCES.includes(item.source as TimelineSource)
      ? item.source as TimelineSource
      : defaultSource
    const status = TIMELINE_STATUSES.includes(item.status as TimelineStatus)
      ? item.status as TimelineStatus
      : defaultStatus

    let placeId: string | undefined
    const rawPlaceId = typeof item.placeId === 'string' ? item.placeId.trim() : ''
    if (rawPlaceId && TIMELINE_ID.test(rawPlaceId) && (!placeIds || placeIds.has(rawPlaceId))) {
      placeId = rawPlaceId
    } else if (rawPlaceId && placeIds) {
      warnings.push(`地点 ${rawPlaceId} 不存在，已清空 placeId（保留 placeName）`)
    }
    const placeName = cleanText(item.placeName, 80) || undefined
    const characters = Array.isArray(item.characters)
      ? item.characters
          .filter((name): name is string => typeof name === 'string')
          .map((name) => cleanText(name, 40))
          .filter(Boolean)
          .slice(0, 20)
      : undefined

    let id = typeof item.id === 'string' && TIMELINE_ID.test(item.id) ? item.id : ''
    if (!id || usedIds.has(id)) {
      const base = `${idPrefix}-${chapterNo}`
      let suffix = 1
      while (usedIds.has(`${base}-${suffix}`)) suffix += 1
      id = `${base}-${suffix}`
    }
    usedIds.add(id)

    const event: TimelineEvent = {
      id,
      chapterNo,
      timeLabel,
      title,
      summary,
      importance,
      source,
      status,
    }
    if (placeId) event.placeId = placeId
    if (placeName) event.placeName = placeName
    if (characters?.length) event.characters = characters
    events.push(event)
  }

  events.sort((a, b) => a.chapterNo - b.chapterNo)
  return { events, warnings }
}

export function parseTimelineEvents(raw: unknown): TimelineEvent[] {
  if (raw === null || raw === undefined || raw === '') return []
  try {
    return normalizeTimelineEvents(raw).events
  } catch {
    console.warn('[story-atlas] 时间线 JSON 损坏，已降级为空')
    return []
  }
}

export function serializeTimelineEvents(events: TimelineEvent[]): string {
  return JSON.stringify(events)
}

export function mergeChapterTimeline(
  existing: TimelineEvent[],
  chapterNo: number,
  incoming: unknown,
): TimelineEvent[] {
  const next = normalizeTimelineEvents(incoming, {
    fixedChapterNo: chapterNo,
    defaultSource: 'chapter',
    defaultStatus: 'planned',
    idPrefix: `ch${String(chapterNo).padStart(3, '0')}`,
  }).events
  const kept = existing.filter((event) => event.chapterNo !== chapterNo)
  return normalizeTimelineEvents([...kept, ...next], { maxChapter: Number.MAX_SAFE_INTEGER }).events
}

export function buildTimelineContext(
  events: TimelineEvent[],
  chapterNo: number,
  options: { radius?: number; limit?: number } = {},
): string {
  const radius = Math.max(0, options.radius ?? 1)
  const limit = Math.max(1, options.limit ?? 12)
  return events
    .filter((event) => Math.abs(event.chapterNo - chapterNo) <= radius)
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .slice(0, limit)
    .map((event) => {
      const time = event.timeLabel ? `${event.timeLabel}：` : ''
      const summary = event.summary ? `：${event.summary}` : ''
      return `- 第${event.chapterNo}章 ${time}${event.title}${summary}`
    })
    .join('\n')
}

export interface WorldMapRegion {
  id: string
  name: string
  description?: string
  color?: string
}

export interface WorldMapFaction {
  id: string
  name: string
  color?: string
}

export interface WorldMapPlace {
  id: string
  name: string
  regionId?: string
  factionId?: string
  x: number
  y: number
  description?: string
  importance: 1 | 2 | 3 | 4 | 5
}

export type WorldMapRouteType = 'road' | 'sea' | 'air' | 'portal' | 'other'

export interface WorldMapRoute {
  id: string
  from: string
  to: string
  type: WorldMapRouteType
  label?: string
  description?: string
}

export interface WorldMapData {
  version: 1
  generatedAt: string | null
  regions: WorldMapRegion[]
  factions: WorldMapFaction[]
  places: WorldMapPlace[]
  routes: WorldMapRoute[]
}

const ROUTE_TYPES: WorldMapRouteType[] = ['road', 'sea', 'air', 'portal', 'other']

function uniqueId(raw: unknown, prefix: string, index: number, used: Set<string>): string {
  const candidate = typeof raw === 'string' && TIMELINE_ID.test(raw) ? raw : `${prefix}-${index + 1}`
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let suffix = 2
  while (used.has(`${candidate}-${suffix}`)) suffix += 1
  const next = `${candidate}-${suffix}`
  used.add(next)
  return next
}

function arrayOf(value: unknown, strict: boolean, field: string): unknown[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    if (strict) throw new StoryAtlasValidationError(`${field} 必须是数组`)
    return []
  }
  return value
}

export function normalizeWorldMap(
  input: unknown,
  options: { strict?: boolean } = {},
): { data: WorldMapData | null; warnings: string[] } {
  const strict = Boolean(options.strict)
  const warnings: string[] = []
  if (input === null || input === undefined) {
    if (strict) throw new StoryAtlasValidationError('world_map 不能为空')
    return { data: null, warnings }
  }
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      if (strict) throw new StoryAtlasValidationError('世界地图 JSON 格式不正确')
      return { data: null, warnings: ['世界地图 JSON 损坏，已降级为空'] }
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new StoryAtlasValidationError('world_map 必须是对象')
    return { data: null, warnings: ['世界地图不是对象，已降级为空'] }
  }
  const root = input as Record<string, unknown>

  const regionIds = new Set<string>()
  const regions = arrayOf(root.regions, strict, 'regions')
    .slice(0, 30)
    .map((raw, index) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const name = cleanText(item.name, 80)
      if (!name) return null
      const region: WorldMapRegion = { id: uniqueId(item.id, 'region', index, regionIds), name }
      const description = cleanText(item.description, 300)
      const color = cleanText(item.color, 32)
      if (description) region.description = description
      if (color) region.color = color
      return region
    })
    .filter((region): region is WorldMapRegion => Boolean(region))
  if (arrayOf(root.regions, strict, 'regions').length > 30) warnings.push('区域超过 30 个，已截断')

  const factionIds = new Set<string>()
  const factions = arrayOf(root.factions, strict, 'factions')
    .slice(0, 30)
    .map((raw, index) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const name = cleanText(item.name, 80)
      if (!name) return null
      const faction: WorldMapFaction = { id: uniqueId(item.id, 'faction', index, factionIds), name }
      const color = cleanText(item.color, 32)
      if (color) faction.color = color
      return faction
    })
    .filter((faction): faction is WorldMapFaction => Boolean(faction))
  if (arrayOf(root.factions, strict, 'factions').length > 30) warnings.push('势力超过 30 个，已截断')

  const rawPlaces = arrayOf(root.places, strict, 'places').slice(0, 200)
  if (arrayOf(root.places, strict, 'places').length > 200) warnings.push('地点超过 200 个，已截断')
  const placeIds = new Set<string>()
  const validPlaces = rawPlaces.map((raw, index) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = cleanText(item.name, 80)
    if (!name) return null
    return { item, name, id: uniqueId(item.id, 'place', index, placeIds) }
  }).filter((value): value is { item: Record<string, unknown>; name: string; id: string } => Boolean(value))
  const columns = Math.max(1, Math.ceil(Math.sqrt(validPlaces.length || 1)))
  const rows = Math.max(1, Math.ceil(validPlaces.length / columns))
  const places = validPlaces.map(({ item, name, id }, index) => {
    const rawX = Number(item.x)
    const rawY = Number(item.y)
    const fallbackX = (index % columns + 0.5) / columns
    const fallbackY = (Math.floor(index / columns) + 0.5) / rows
    const x = Number.isFinite(rawX) ? Math.max(0, Math.min(1, rawX)) : fallbackX
    const y = Number.isFinite(rawY) ? Math.max(0, Math.min(1, rawY)) : fallbackY
    const place: WorldMapPlace = {
      id,
      name,
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      importance: clampImportance(item.importance),
    }
    const regionId = typeof item.regionId === 'string' ? item.regionId : ''
    if (regionId && regionIds.has(regionId)) place.regionId = regionId
    else if (regionId) warnings.push(`地点 ${id} 的区域 ${regionId} 不存在，已清空`)
    const factionId = typeof item.factionId === 'string' ? item.factionId : ''
    if (factionId && factionIds.has(factionId)) place.factionId = factionId
    else if (factionId) warnings.push(`地点 ${id} 的势力 ${factionId} 不存在，已清空`)
    const description = cleanText(item.description, 300)
    if (description) place.description = description
    return place
  })

  const routeIds = new Set<string>()
  const routeKeys = new Set<string>()
  const rawRoutes = arrayOf(root.routes, strict, 'routes').slice(0, 100)
  if (arrayOf(root.routes, strict, 'routes').length > 100) warnings.push('路线超过 100 条，已截断')
  const routes: WorldMapRoute[] = []
  rawRoutes.forEach((raw, index) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const from = typeof item.from === 'string' ? item.from : ''
    const to = typeof item.to === 'string' ? item.to : ''
    if (!placeIds.has(from) || !placeIds.has(to) || from === to) {
      warnings.push(`丢弃无效路线：${from || '?'} → ${to || '?'}`)
      return
    }
    const key = `${from}|${to}`
    if (routeKeys.has(key)) {
      warnings.push(`丢弃重复路线：${from} → ${to}`)
      return
    }
    routeKeys.add(key)
    const route: WorldMapRoute = {
      id: uniqueId(item.id, 'route', index, routeIds),
      from,
      to,
      type: ROUTE_TYPES.includes(item.type as WorldMapRouteType) ? item.type as WorldMapRouteType : 'other',
    }
    const label = cleanText(item.label, 80)
    const description = cleanText(item.description, 300)
    if (label) route.label = label
    if (description) route.description = description
    routes.push(route)
  })

  const generatedAt = typeof root.generatedAt === 'string' && !Number.isNaN(Date.parse(root.generatedAt))
    ? root.generatedAt
    : null
  return {
    data: { version: 1, generatedAt, regions, factions, places, routes },
    warnings,
  }
}

export function parseWorldMap(raw: unknown): WorldMapData | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    return normalizeWorldMap(raw).data
  } catch {
    console.warn('[story-atlas] 世界地图 JSON 损坏，已降级为空')
    return null
  }
}

export function serializeWorldMap(map: WorldMapData): string {
  return JSON.stringify(map)
}

export function buildMapContext(
  map: WorldMapData | null,
  events: TimelineEvent[],
  chapterNo: number,
  options: { limit?: number } = {},
): string {
  if (!map || !map.places.length) return ''
  const limit = Math.max(1, options.limit ?? 8)
  const regionNames = new Map(map.regions.map((region) => [region.id, region.name]))
  const eventPlaceIds = new Set(
    events.filter((event) => event.chapterNo === chapterNo && event.placeId).map((event) => event.placeId as string),
  )
  let selected = map.places.filter((place) => eventPlaceIds.has(place.id))
  if (!selected.length) {
    selected = [...map.places].sort((a, b) => b.importance - a.importance)
  }
  return selected.slice(0, limit)
    .map((place) => {
      const region = place.regionId ? regionNames.get(place.regionId) : ''
      const prefix = region ? `${place.name}（${region}）` : place.name
      return `- ${prefix}${place.description ? `：${place.description}` : ''}`
    })
    .join('\n')
}

export function parseModelJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new StoryAtlasValidationError('模型返回的 JSON 格式不正确')
  try {
    return JSON.parse(stripped.slice(start, end + 1))
  } catch {
    throw new StoryAtlasValidationError('模型返回的 JSON 格式不正确')
  }
}

export function readStoryAtlas(novel: {
  timelineEvents?: unknown
  worldMap?: unknown
}): { timelineEvents: TimelineEvent[]; worldMap: WorldMapData | null } {
  return {
    timelineEvents: parseTimelineEvents(novel.timelineEvents),
    worldMap: parseWorldMap(novel.worldMap),
  }
}
