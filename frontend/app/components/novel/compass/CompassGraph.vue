<template>
  <div class="compass-graph">
    <div ref="containerRef" class="graph-canvas"></div>
    <div v-if="status === 'loading'" class="graph-state">{{ t('novels.compass.loading') }}</div>
    <div v-else-if="status === 'error'" class="graph-state is-error">{{ t('novels.compass.loadFailed') }}</div>
    <div v-else-if="status === 'ready' && !snapshot" class="graph-state">{{ t('novels.compass.noSnapshot') }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getFactionColorMap,
  toEChartsGraphData,
  type GraphSnapshot,
} from '~/utils/novel-graph'

const props = defineProps<{
  snapshot: GraphSnapshot | null
  dark?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  (event: 'node-click', nodeId: string): void
  (event: 'node-dblclick', nodeId: string): void
  (event: 'edge-click', payload: { id: string; x: number; y: number }): void
  (event: 'blank-click'): void
}>()

const { t } = useI18n()
const containerRef = ref<HTMLElement | null>(null)
const chart = shallowRef<any>(null)
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')

let echarts: typeof import('echarts') | null = null
let resizeObserver: ResizeObserver | null = null
let clickTimer: ReturnType<typeof setTimeout> | null = null
let fullGraphData: { nodes: any[]; links: any[]; categories: any[] } | null = null
let focused = false

function relationLabel(type: string): string {
  const key = `novels.compass.relations.${type}`
  const label = t(key)
  return label === key ? type : label
}

function render() {
  if (!chart.value || !echarts) return
  if (!props.snapshot) {
    chart.value.clear()
    fullGraphData = null
    focused = false
    return
  }

  const isDark = Boolean(props.dark)
  const factionColorMap = getFactionColorMap(props.snapshot.nodes || [])
  const { nodes, links, categories } = toEChartsGraphData(
    props.snapshot,
    isDark,
    factionColorMap,
    t('novels.compass.other'),
    props.compact ? 36 : 0,
  )
  fullGraphData = { nodes, links, categories }
  focused = false

  chart.value.setOption({
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          const raw = params.data?._raw
          if (!raw) return params.data?.name || ''
          const lines = [`<b>${escapeTooltip(raw.label)}</b>`]
          if (raw.bio) lines.push(escapeTooltip(raw.bio))
          if (raw.faction) lines.push(`${t('novels.compass.nodeTypes.faction')}: ${escapeTooltip(raw.faction)}`)
          return lines.join('<br/>')
        }
        if (params.dataType === 'edge') {
          const raw = params.data?._raw
          if (!raw) return ''
          return [
            escapeTooltip(raw.label || ''),
            `${relationLabel(raw.relationType)} · ${t('novels.compass.strength')} ${raw.strength || '-'}`,
          ].filter(Boolean).join('<br/>')
        }
        return ''
      },
    },
    legend: categories.length > 1
      ? [{
          data: categories.map((category: any) => category.name),
          textStyle: { color: isDark ? '#e2e8f0' : '#1f2937', fontSize: props.compact ? 10 : 12 },
          top: 8,
          right: 12,
          itemWidth: props.compact ? 10 : 14,
          itemHeight: props.compact ? 6 : 8,
        }]
      : [],
    animationDuration: props.compact ? 800 : 1200,
    animationEasingUpdate: 'quinticInOut',
    backgroundColor: 'transparent',
    series: [{
      type: 'graph',
      layout: 'force',
      data: nodes,
      links,
      categories,
      roam: true,
      draggable: true,
      label: {
        show: true,
        position: 'right',
        formatter: '{b}',
        color: isDark ? '#e2e8f0' : '#1e293b',
        fontSize: props.compact ? 10 : 12,
      },
      lineStyle: { curveness: 0.2 },
      emphasis: {
        focus: 'adjacency',
        lineStyle: { width: props.compact ? 4 : 6 },
      },
      force: {
        repulsion: props.compact ? 180 : 260,
        edgeLength: props.compact ? [60, 160] : [80, 220],
        gravity: 0.08,
        friction: 0.6,
      },
      scaleLimit: { min: 0.3, max: 3 },
    }],
  }, true)
}

function escapeTooltip(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function bindEvents() {
  if (!chart.value) return
  chart.value.on('click', (params: any) => {
    if (params.dataType === 'node') {
      const nodeId = String(params.data?.id ?? '')
      if (!nodeId) return
      if (clickTimer) {
        clearTimeout(clickTimer)
        clickTimer = null
        focused = true
        applyFocus(nodeId)
        emit('node-dblclick', nodeId)
        return
      }
      clickTimer = setTimeout(() => {
        clickTimer = null
        emit('node-click', nodeId)
      }, 260)
      return
    }
    if (params.dataType === 'edge') {
      const raw = params.data?._raw
      if (!raw?.id) return
      const rect = containerRef.value?.getBoundingClientRect()
      emit('edge-click', {
        id: String(raw.id),
        x: rect ? rect.left + rect.width / 2 - 150 : 0,
        y: rect ? rect.top + rect.height / 2 - 120 : 0,
      })
    }
  })

  chart.value.getZr().on('click', (event: any) => {
    if (event?.target) return
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
    if (focused) {
      focused = false
      clearFocus()
    }
    emit('blank-click')
  })
}

function applyFocus(nodeId: string) {
  if (!chart.value || !fullGraphData) return
  const neighbors = new Set<string>([nodeId])
  fullGraphData.links.forEach((link) => {
    if (link.source === nodeId) neighbors.add(String(link.target))
    if (link.target === nodeId) neighbors.add(String(link.source))
  })
  const nodes = fullGraphData.nodes.map((node) => ({
    ...node,
    itemStyle: {
      ...node.itemStyle,
      opacity: neighbors.has(String(node.id)) ? (node.itemStyle?.opacity ?? 1) : 0.1,
    },
    label: { ...node.label, show: neighbors.has(String(node.id)) },
  }))
  const links = fullGraphData.links.map((link) => ({
    ...link,
    lineStyle: {
      ...link.lineStyle,
      opacity: (neighbors.has(String(link.source)) && neighbors.has(String(link.target))) ? 0.6 : 0.05,
    },
  }))
  chart.value.setOption({ series: [{ data: nodes, links }] })
}

function clearFocus() {
  if (!chart.value || !fullGraphData) return
  chart.value.setOption({
    series: [{ data: fullGraphData.nodes, links: fullGraphData.links }],
  })
}

function resetView() {
  focused = false
  render()
}

function exportPng(): string | null {
  if (!chart.value) return null
  return chart.value.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: props.dark ? '#0f172a' : '#f8fafc',
  })
}

async function initChart() {
  if (!containerRef.value) return
  status.value = 'loading'
  try {
    if (!echarts) echarts = await import('echarts')
    chart.value?.dispose()
    chart.value = echarts.init(containerRef.value, props.dark ? 'dark' : undefined)
    bindEvents()
    status.value = 'ready'
    render()
  } catch {
    status.value = 'error'
  }
}

function reboot() {
  chart.value?.dispose()
  chart.value = null
  void nextTick(initChart)
}

watch(() => props.snapshot, () => {
  if (status.value === 'ready') render()
}, { deep: true })

watch(() => props.dark, () => {
  if (status.value === 'ready') reboot()
})

onMounted(async () => {
  await nextTick()
  await initChart()
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => chart.value?.resize())
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  if (clickTimer) clearTimeout(clickTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  chart.value?.dispose()
  chart.value = null
})

defineExpose({ exportPng, resetView })
</script>

<style scoped>
.compass-graph {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  border-radius: 12px;
  overflow: hidden;
}
.graph-canvas {
  width: 100%;
  height: 100%;
}
.graph-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 12.5px;
  pointer-events: none;
}
.graph-state.is-error {
  color: var(--error);
}
</style>
