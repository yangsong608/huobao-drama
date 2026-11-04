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
  [key: string]: any
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
  [key: string]: any
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

export interface NovelGraphData {
  version: number
  generatedAt: string | null
  snapshots: Record<string, GraphSnapshot>
  audit: GraphAudit
  graphGenerated: boolean
}

export const RELATION_COLORS: Record<string, string> = {
  hostile: '#ef4444',
  romantic: '#ec4899',
  alliance: '#f59e0b',
  neutral: '#9ca3af',
  family: '#3b82f6',
  mentor: '#22c55e',
}

export const NODE_SHAPES: Record<string, string> = {
  character: 'circle',
  faction: 'diamond',
  location: 'rect',
  item: 'triangle',
}

const FACTION_PALETTE = [
  '#f97316', '#f59e0b', '#06b6d4', '#14b8a6',
  '#3b82f6', '#ef4444', '#ec4899', '#84cc16',
]

export function getFactionColorMap(nodes: GraphNode[]): Record<string, string> {
  const factions = [...new Set(nodes.filter((node) => node.faction).map((node) => node.faction as string))]
  const map: Record<string, string> = {}
  factions.forEach((faction, index) => {
    map[faction] = FACTION_PALETTE[index % FACTION_PALETTE.length]
  })
  return map
}

export function getSnapshotForChapter(
  snapshots: Record<string, GraphSnapshot> | null | undefined,
  chapterNo: number,
): GraphSnapshot | null {
  if (!snapshots) return null
  const keys = Object.keys(snapshots).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  let best: number | null = null
  for (const key of keys) {
    if (key <= chapterNo) best = key
    else break
  }
  return best === null ? null : snapshots[String(best)] || null
}

export function getSnapshotChapters(snapshots: Record<string, GraphSnapshot> | null | undefined): number[] {
  if (!snapshots) return []
  return Object.keys(snapshots).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

export function toEChartsGraphData(
  snapshot: GraphSnapshot | null | undefined,
  isDark = false,
  factionColorMap: Record<string, string> = {},
  otherLabel = '其他',
  labelMinSize = 0,
) {
  if (!snapshot) return { nodes: [], links: [], categories: [] }

  const categorySet = new Set<string>()
  snapshot.nodes.forEach((node) => {
    if (node.faction) categorySet.add(node.faction)
  })
  const categoryList = [...categorySet]
  const categories = categoryList.map((name) => ({
    name,
    itemStyle: { color: factionColorMap[name] || '#f97316' },
  }))
  categories.push({ name: otherLabel, itemStyle: { color: isDark ? '#ffb076' : '#f97316' } })

  const nodes = snapshot.nodes.map((node) => {
    const deceased = node.status === 'deceased'
    const offline = node.status === 'offline'
    const size = 20 + (node.importance || 5) * 4
    const category = node.faction ? categoryList.indexOf(node.faction) : categories.length - 1
    return {
      id: node.id,
      name: node.label,
      symbol: NODE_SHAPES[node.type] || 'circle',
      symbolSize: size,
      category,
      value: node.importance || 5,
      ...(labelMinSize > 0 ? { label: { show: size >= labelMinSize } } : {}),
      itemStyle: {
        opacity: deceased ? 0.35 : offline ? 0.6 : 1,
        ...(deceased ? { color: '#6b7280' } : {}),
      },
      _raw: node,
    }
  })

  const links = snapshot.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    value: edge.strength || 3,
    lineStyle: {
      color: RELATION_COLORS[edge.relationType] || '#9ca3af',
      width: Math.max(1, (edge.strength || 3) / 3),
      opacity: 0.6,
    },
    _raw: edge,
  }))

  return { nodes, links, categories }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildCompassExportHtml(
  graphData: NovelGraphData,
  title: string,
  labels: { subtitle: string; other: string },
): string {
  const snapshot = getSnapshotForChapter(graphData.snapshots, Number.POSITIVE_INFINITY)
  if (!snapshot) return ''
  const factionColorMap = getFactionColorMap(snapshot.nodes)
  const { nodes, links, categories } = toEChartsGraphData(snapshot, true, factionColorMap, labels.other)
  const dataJson = JSON.stringify({ nodes, links, categories }).replace(/</g, '\\u003c')
  const safeTitle = escapeHtml(title)
  const safeSubtitle = escapeHtml(labels.subtitle)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} - ${safeSubtitle}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js" integrity="sha384-C2iskrW/uPW46KzOjrvJIQo4YkV8lkD+QS0CrDN18IIPIpT/g2USu8bTP3nvmIAD" crossorigin="anonymous"><\/script>
<style>
  body { margin: 0; background: #0f172a; font-family: system-ui, sans-serif; overflow: hidden; }
  #graph { width: 100vw; height: 100vh; }
  .title { position: fixed; top: 16px; left: 16px; color: #e2e8f0; font-size: 18px; z-index: 10; text-shadow: 0 0 10px rgba(99,102,241,0.5); }
  .title small { display: block; margin-top: 4px; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="title">${safeTitle}<small>${safeSubtitle}</small></div>
<div id="graph"></div>
<script>
var data = ${dataJson};
var chart = echarts.init(document.getElementById('graph'));
chart.setOption({
  tooltip: {},
  legend: [{ data: data.categories.map(function (item) { return item.name; }), textStyle: { color: '#e2e8f0' }, top: 20, right: 20 }],
  animationDuration: 1500,
  animationEasingUpdate: 'quinticInOut',
  series: [{
    type: 'graph',
    layout: 'force',
    data: data.nodes,
    links: data.links,
    categories: data.categories,
    roam: true,
    label: { position: 'right', formatter: '{b}', color: '#e2e8f0' },
    lineStyle: { curveness: 0.2 },
    emphasis: { focus: 'adjacency', lineStyle: { width: 6 } },
    force: { repulsion: 200, edgeLength: [80, 200], gravity: 0.1 }
  }]
});
window.addEventListener('resize', function () { chart.resize(); });
<\/script>
</body>
</html>`
}

export function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}
