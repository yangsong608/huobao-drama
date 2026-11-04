export interface TimelineEventLike {
  id: string
  chapterNo: number
  title: string
  placeId?: string
  status?: string
  [key: string]: any
}

export interface WorldMapLike {
  version: number
  generatedAt: string | null
  regions: Array<{ id: string; name: string; color?: string }>
  factions: Array<{ id: string; name: string; color?: string }>
  places: Array<{ id: string; name: string; regionId?: string; factionId?: string; x: number; y: number; importance: number; description?: string }>
  routes: Array<{ id: string; from: string; to: string; type: string; label?: string }>
}

export function filterTimelineEvents<T extends TimelineEventLike>(
  events: T[],
  options: { chapterNo?: number; scope?: 'all' | 'chapter' | 'confirmed' } = {},
): T[] {
  const { chapterNo = 0, scope = 'all' } = options
  return events.filter((event) => {
    if (scope === 'chapter') return event.chapterNo === chapterNo
    if (scope === 'confirmed') return event.status === 'confirmed'
    return true
  })
}

export function eventPlaceIds(events: TimelineEventLike[], chapterNo: number): Set<string> {
  return new Set(events
    .filter((event) => event.chapterNo === chapterNo && event.placeId)
    .map((event) => event.placeId as string))
}

export function buildMapGraphOption(
  mapData: WorldMapLike | null | undefined,
  options: { highlightIds?: Set<string>; dark?: boolean } = {},
) {
  const highlight = options.highlightIds || new Set<string>()
  const dark = Boolean(options.dark)
  const factionColors = new Map((mapData?.factions || []).map((faction) => [faction.id, faction.color]))
  const regionColors = new Map((mapData?.regions || []).map((region) => [region.id, region.color]))
  const data = (mapData?.places || []).map((place) => ({
    id: place.id,
    name: place.name,
    x: place.x * 1000,
    y: place.y * 600,
    symbolSize: 10 + place.importance * 4,
    itemStyle: {
      color: (place.factionId && factionColors.get(place.factionId))
        || (place.regionId && regionColors.get(place.regionId))
        || (dark ? '#8a94a6' : '#6b7280'),
      borderColor: highlight.has(place.id) ? '#f5a524' : 'transparent',
      borderWidth: highlight.has(place.id) ? 3 : 0,
    },
    label: { show: true, color: dark ? '#e5e7eb' : '#1f2937', fontSize: 11 },
    _raw: place,
  }))
  const links = (mapData?.routes || []).map((route) => ({
    source: route.from,
    target: route.to,
    label: { show: Boolean(route.label), formatter: route.label || '' },
    lineStyle: {
      type: route.type === 'sea' || route.type === 'air' ? 'dashed' : 'solid',
      color: dark ? '#6b7280' : '#9ca3af',
      curveness: 0.12,
    },
    _raw: route,
  }))
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', confine: true },
    series: [{
      type: 'graph',
      layout: 'none',
      roam: true,
      draggable: true,
      data,
      links,
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 6,
      lineStyle: { color: dark ? '#6b7280' : '#9ca3af' },
    }],
  }
}
