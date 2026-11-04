<template>
  <section class="novel-panel compass-panel">
    <header class="panel-head">
      <div>
        <h2>{{ t('novels.compass.title') }}</h2>
        <p>{{ t('novels.compass.subtitle') }}</p>
      </div>
    </header>

    <CompassToolbar
      :running="Boolean(running)"
      :graph-generated="graphGenerated"
      :has-chapters="hasChapters"
      :can-generate-base="hasArchitecture"
      :audit-count="auditCount"
      :audit-visible="auditVisible"
      @generate="startBase"
      @snapshots="startSnapshots"
      @audit="startAudit"
      @toggle-audit="toggleAudit"
      @export-png="exportPng"
      @export-html="exportHtml"
      @reset-view="resetView"
      @cancel="cancel"
    />

    <p v-if="error" class="panel-error">{{ error }}</p>

    <div v-if="running" class="panel-progress">
      <div class="progress-meta">
        <span>{{ stage?.label || runningLabel }}</span>
        <span v-if="stage && stage.total">{{ stage.current }}/{{ stage.total }}</span>
      </div>
      <div class="progress"><i :style="{ width: `${percent}%` }"></i></div>
    </div>

    <div class="seg compass-views">
      <button
        v-for="item in viewOptions"
        :key="item.value"
        type="button"
        :class="['seg-item', { on: view === item.value }]"
        @click="view = item.value"
      >
        {{ t(`novels.compass.views.${item.label}`) }}
      </button>
    </div>

    <div v-if="view !== 'relations'" class="atlas-actions">
      <button type="button" class="btn btn-primary btn-sm" :disabled="Boolean(running)" @click="startAtlas(false)">
        {{ t('novels.compass.atlas.generateMissing') }}
      </button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="Boolean(running)" @click="startAtlas(true)">
        {{ t('novels.compass.atlas.regenerate') }}
      </button>
    </div>

    <div v-if="loading && view === 'relations'" class="compass-loading">{{ t('novels.compass.loading') }}</div>

    <template v-else-if="view === 'relations' && graphGenerated">
      <div class="card compass-main">
        <div class="graph-wrap">
          <CompassGraph
            ref="graphRef"
            :snapshot="currentSnapshot"
            :dark="isDark"
            @node-click="selectNode"
            @node-dblclick="selectNode"
            @edge-click="selectEdge"
            @blank-click="clearSelection"
          />
          <div v-if="selectedNode" class="focus-hint">{{ t('novels.compass.focusHint') }}</div>
          <div v-if="!currentSnapshot" class="graph-empty-overlay">
            <p>{{ t('novels.compass.noSnapshot') }}</p>
            <p class="graph-empty-hint">{{ t('novels.compass.noSnapshotHint') }}</p>
          </div>
        </div>

        <CompassSidebar
          :node="selectedNode"
          :edges="edges"
          :all-nodes="nodes"
          :visible="sidebarVisible"
          :chapters-with-node="chaptersWithNode"
          @close="selectedNodeId = null"
          @delete-node="deleteNode"
          @locate-chapter="setChapter"
        />

        <AuditPanel
          :audit="audit"
          :visible="auditVisible"
          @locate="locateAudit"
          @close="auditVisible = false"
        />
      </div>

      <CompassTimeline
        :snapshots="snapshots"
        :max-chapter="maxChapter"
        :model-value="currentChapter"
        @update:model-value="setChapter"
      />
    </template>

    <template v-else-if="view === 'relations'">
      <div class="compass-empty">
        <p class="empty-title">{{ t('novels.compass.emptyTitle') }}</p>
        <p class="empty-hint">{{ hasArchitecture ? t('novels.compass.emptyAction') : t('novels.compass.emptyArchitecture') }}</p>
      </div>
    </template>

    <template v-else-if="view === 'timeline'">
      <StoryTimeline
        :events="novel.timelineEvents || []"
        :chapter-no="currentChapter"
        :editable="!running"
        :max-chapter="maxChapter"
        @update:events="saveTimeline"
        @select-chapter="setChapter"
      />
      <CompassTimeline
        :snapshots="snapshots"
        :max-chapter="maxChapter"
        :model-value="currentChapter"
        @update:model-value="setChapter"
      />
    </template>

    <template v-else>
      <WorldMap
        :map-data="novel.worldMap"
        :events="novel.timelineEvents || []"
        :chapter-no="currentChapter"
        :editable="false"
        :dark="isDark"
        @select-place="() => {}"
      />
      <CompassTimeline
        :snapshots="snapshots"
        :max-chapter="maxChapter"
        :model-value="currentChapter"
        @update:model-value="setChapter"
      />
    </template>

    <RelationPopover
      :edge="selectedEdge"
      :all-nodes="nodes"
      :visible="Boolean(selectedEdge)"
      :x="popoverPos.x"
      :y="popoverPos.y"
      @close="selectedEdgeId = null"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { camelizeKeys, useNovelStore } from '~/stores/novel'
import { novelAPI } from '~/composables/useNovelApi'
import { novelErrorText, useNovelJobStream } from '~/composables/useNovelJobStream'
import { useTheme } from '~/composables/useTheme'
import { mapError } from '~/composables/useToast'
import {
  buildCompassExportHtml,
  downloadDataUrl,
  downloadTextFile,
  getSnapshotChapters,
  getSnapshotForChapter,
  type GraphAuditItem,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type NovelGraphData,
} from '~/utils/novel-graph'
import CompassGraph from './CompassGraph.vue'
import CompassToolbar from './CompassToolbar.vue'
import CompassTimeline from './CompassTimeline.vue'
import CompassSidebar from './CompassSidebar.vue'
import AuditPanel from './AuditPanel.vue'
import RelationPopover from './RelationPopover.vue'
import StoryTimeline from '../story/StoryTimeline.vue'
import WorldMap from '../story/WorldMap.vue'

type JobKind = 'base' | 'snapshots' | 'audit' | 'atlas'

const RUNNING_TYPES: Record<string, JobKind> = {
  graph_base: 'base',
  graph_snapshots: 'snapshots',
  graph_audit: 'audit',
}

const props = defineProps<{ novel: any }>()
const emit = defineEmits<{ (event: 'refresh'): void }>()

const { t } = useI18n()
const store = useNovelStore()
const { resolvedTheme } = useTheme()
const { watch: watchJob, stop } = useNovelJobStream()

const viewOptions = [
  { value: 'relations', label: 'relations' },
  { value: 'timeline', label: 'timeline' },
  { value: 'map', label: 'map' },
] as const

const view = ref<'relations' | 'timeline' | 'map'>('relations')

const graphRef = ref<any>(null)
const loading = ref(true)
const running = ref<JobKind | null>(null)
const jobId = ref<number | null>(null)
const stage = ref<{ label: string; current: number; total: number } | null>(null)
const error = ref('')
const currentChapter = ref(0)
const selectedNodeId = ref<string | null>(null)
const selectedEdgeId = ref<string | null>(null)
const popoverPos = ref({ x: 0, y: 0 })
const auditVisible = ref(false)

const graphData = computed<NovelGraphData | null>(() => store.graph)
const snapshots = computed<Record<string, GraphSnapshot>>(() => graphData.value?.snapshots || {})
const snapshotChapters = computed(() => getSnapshotChapters(snapshots.value))
const graphGenerated = computed(() => Boolean(graphData.value?.graphGenerated) && snapshotChapters.value.length > 0)
const isDark = computed(() => resolvedTheme.value === 'dark')
const hasChapters = computed(() => (props.novel?.chapters || []).some((chapter: any) => String(chapter.content || '').trim()))
const hasArchitecture = computed(() => Boolean(
  props.novel?.architectureGenerated
  || props.novel?.coreSeed
  || props.novel?.worldBuilding
  || props.novel?.plotArchitecture,
))
const maxChapter = computed(() => Number(props.novel?.numberOfChapters) || 0)

const currentSnapshot = computed<GraphSnapshot | null>(() =>
  getSnapshotForChapter(snapshots.value, currentChapter.value),
)
const nodes = computed<GraphNode[]>(() => currentSnapshot.value?.nodes || [])
const edges = computed<GraphEdge[]>(() => currentSnapshot.value?.edges || [])
const selectedNode = computed<GraphNode | null>(() => {
  if (!selectedNodeId.value) return null
  return nodes.value.find((node) => node.id === selectedNodeId.value) || null
})
const selectedEdge = computed<GraphEdge | null>(() => {
  if (!selectedEdgeId.value) return null
  return edges.value.find((edge) => edge.id === selectedEdgeId.value) || null
})
const sidebarVisible = computed(() => Boolean(selectedNode.value) && !auditVisible.value)
const chaptersWithNode = computed(() => {
  if (!selectedNodeId.value) return []
  return snapshotChapters.value.filter((chapter) => {
    const snapshot = snapshots.value[String(chapter)]
    return Boolean(snapshot?.nodes.some((node) => node.id === selectedNodeId.value))
  })
})
const audit = computed(() => graphData.value?.audit || { inconsistencies: [], lastAuditAt: null })
const auditCount = computed(() => audit.value.inconsistencies?.length || 0)

const runningLabel = computed(() => {
  if (running.value === 'base') return t('novels.compass.runningBase')
  if (running.value === 'snapshots') return t('novels.compass.runningSnapshots')
  if (running.value === 'audit') return t('novels.compass.runningAudit')
  if (running.value === 'atlas') return t('novels.compass.runningAtlas')
  return ''
})
const percent = computed(() => {
  if (!stage.value || !stage.value.total) return running.value ? 8 : 0
  return Math.max(0, Math.min(100, Math.round((stage.value.current / stage.value.total) * 100)))
})

function handlers(kind: JobKind) {
  let settled = false
  return {
    onSnapshot(snapshot: any) {
      jobId.value = snapshot.jobId
      if (snapshot.status === 'running') {
        running.value = kind
        stage.value = {
          label: snapshot.message || '',
          current: snapshot.progress || 0,
          total: snapshot.total || 0,
        }
      }
    },
    onStage(next: any) {
      const label = next.stage === 'worldMap' || next.stage === 'timeline'
        ? t('novels.architecture.structuredRunning')
        : next.label
      stage.value = { label, current: next.current, total: next.total }
    },
    onDone() {
      if (settled) return
      settled = true
      running.value = null
      stage.value = null
      jobId.value = null
      void afterDone(kind)
    },
    onError(failure: any) {
      if (settled) return
      settled = true
      running.value = null
      stage.value = null
      jobId.value = null
      error.value = novelErrorText(t, failure.code, failure.message)
    },
  }
}

async function afterDone(kind: JobKind) {
  if (kind === 'atlas') {
    emit('refresh')
    toast.success(t('novels.compass.success.atlas'))
    return
  }
  await load()
  if (kind === 'base') currentChapter.value = 0
  if (kind === 'audit') auditVisible.value = true
  toast.success(t(`novels.compass.success.${kind}`))
}

async function load() {
  try {
    await store.fetchGraph(props.novel.id)
  } catch (err: any) {
    error.value = mapError(err, { fallback: 'novels.compass.loadFailed' })
  } finally {
    loading.value = false
  }
}

async function start(kind: JobKind, starter: () => Promise<any>) {
  if (running.value) return
  if (kind === 'base' && graphGenerated.value && !window.confirm(String(t('novels.compass.baseConfirm')))) return
  error.value = ''
  stage.value = null
  running.value = kind
  try {
    const data: any = await starter()
    const id = Number(data?.job_id ?? data?.jobId)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(String(t('novels.errors.protocol')))
    jobId.value = id
    await watchJob(id, handlers(kind))
  } catch (err: any) {
    running.value = null
    stage.value = null
    if (!error.value) error.value = mapError(err, { fallback: 'novels.errors.protocol' })
  }
}

function startBase() {
  void start('base', () => novelAPI.startGraphBase(props.novel.id))
}

function startSnapshots() {
  void start('snapshots', () => novelAPI.startGraphSnapshots(props.novel.id))
}

function startAudit() {
  void start('audit', () => novelAPI.startGraphAudit(props.novel.id))
}

async function startAtlas(force: boolean) {
  if (running.value) return
  if (force && !window.confirm(String(t('novels.compass.atlas.regenerateConfirm')))) return
  error.value = ''
  stage.value = null
  running.value = 'atlas'
  try {
    const data: any = await novelAPI.startStoryAtlas(props.novel.id, force)
    const id = Number(data?.job_id ?? data?.jobId)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(String(t('novels.errors.protocol')))
    jobId.value = id
    await watchJob(id, handlers('atlas'))
  } catch (err: any) {
    running.value = null
    stage.value = null
    error.value = mapError(err, { fallback: 'novels.errors.protocol' })
  }
}

async function saveTimeline(events: any[]) {
  error.value = ''
  try {
    await store.saveStoryAtlas(props.novel.id, {
      timeline_events: events,
      base_updated_at: props.novel.updatedAt,
    })
    emit('refresh')
  } catch (err: any) {
    error.value = mapError(err, { fallback: 'novels.errors.protocol' })
  }
}

async function cancel() {
  if (jobId.value) {
    try {
      await novelAPI.cancelJob(jobId.value)
    } catch {
      // 取消失败也停止本地订阅
    }
  }
  stop()
  running.value = null
  stage.value = null
  jobId.value = null
}

function selectNode(nodeId: string) {
  selectedNodeId.value = nodeId
  selectedEdgeId.value = null
  auditVisible.value = false
}

function selectEdge(payload: { id: string; x: number; y: number }) {
  selectedEdgeId.value = payload.id
  selectedNodeId.value = null
  popoverPos.value = { x: payload.x, y: payload.y }
}

function clearSelection() {
  selectedNodeId.value = null
  selectedEdgeId.value = null
}

function setChapter(chapter: number) {
  currentChapter.value = Number(chapter) || 0
  selectedEdgeId.value = null
}

function toggleAudit() {
  auditVisible.value = !auditVisible.value
  if (auditVisible.value) selectedEdgeId.value = null
}

function locateAudit(item: GraphAuditItem) {
  const chapter = Number((item.chapters || [])[0])
  if (Number.isFinite(chapter) && chapter >= 0) currentChapter.value = chapter
  const nodeId = String((item.nodeIds || [])[0] || '')
  const snapshot = getSnapshotForChapter(snapshots.value, currentChapter.value)
  const exists = Boolean(nodeId) && Boolean(snapshot?.nodes.some((node) => node.id === nodeId))
  if (exists) {
    selectedNodeId.value = nodeId
    auditVisible.value = false
  }
}

async function deleteNode(nodeId: string) {
  const node = nodes.value.find((item) => item.id === nodeId)
  const data = graphData.value
  if (!node || !data) return
  if (!window.confirm(String(t('novels.compass.deleteConfirm', { name: node.label })))) return

  const nextSnapshots: Record<string, GraphSnapshot> = {}
  for (const [key, snapshot] of Object.entries(data.snapshots || {})) {
    nextSnapshots[key] = {
      nodes: snapshot.nodes.filter((item) => item.id !== nodeId),
      edges: snapshot.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    }
  }
  selectedNodeId.value = null
  try {
    await store.saveGraph(props.novel.id, {
      graphData: {
        ...data,
        snapshots: nextSnapshots,
        graphGenerated: Object.keys(nextSnapshots).length > 0,
      },
    })
    toast.success(t('novels.compass.saved'))
  } catch (err: any) {
    toast.error(mapError(err, { fallback: 'novels.compass.saveFailed' }))
  }
}

function exportPng() {
  const dataUrl = graphRef.value?.exportPng()
  if (!dataUrl) {
    toast.warning(t('novels.compass.exportEmpty'))
    return
  }
  downloadDataUrl(`${props.novel.title}-${t('novels.compass.graphName')}.png`, dataUrl)
  toast.success(t('novels.compass.exportPngDone'))
}

function exportHtml() {
  if (!graphData.value) {
    toast.warning(t('novels.compass.exportEmpty'))
    return
  }
  const html = buildCompassExportHtml(graphData.value, props.novel.title, {
    subtitle: t('novels.compass.graphName'),
    other: t('novels.compass.other'),
  })
  if (!html) {
    toast.warning(t('novels.compass.exportEmpty'))
    return
  }
  downloadTextFile(`${props.novel.title}-${t('novels.compass.graphName')}.html`, html, 'text/html;charset=utf-8')
  toast.success(t('novels.compass.exportHtmlDone'))
}

function resetView() {
  clearSelection()
  auditVisible.value = false
  graphRef.value?.resetView()
}

async function recoverRunning() {
  try {
    const data: any = await novelAPI.jobs(props.novel.id, 'running')
    const items = Array.isArray(data?.items) ? data.items : []
    const job = items
      .map((item: any) => camelizeKeys<any>(item))
      .find((item: any) => RUNNING_TYPES[item.type] || item.type === 'atlas')
    if (!job) return
    const kind: JobKind = job.type === 'atlas' ? 'atlas' : RUNNING_TYPES[job.type]
    running.value = kind
    jobId.value = job.id
    await watchJob(job.id, handlers(kind))
  } catch {
    // 恢复进度失败不阻塞面板
  }
}

watch(currentChapter, () => {
  if (selectedNodeId.value && !nodes.value.some((node) => node.id === selectedNodeId.value)) {
    selectedNodeId.value = null
  }
})

onMounted(async () => {
  await load()
  await recoverRunning()
})

onBeforeUnmount(stop)
</script>

<style scoped>
.compass-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
.panel-head p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.panel-error {
  margin: 0;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: var(--error-bg);
  color: var(--error);
  font-size: 12.5px;
}
.panel-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
}
.compass-loading {
  padding: 60px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}
.compass-views {
  align-self: flex-start;
}
.atlas-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.compass-main {
  display: flex;
  height: 560px;
  overflow: hidden;
}
.graph-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.focus-hint {
  position: absolute;
  top: 10px;
  left: 10px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-2);
  font-size: 10.5px;
  pointer-events: none;
}
.graph-empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
}
.graph-empty-overlay p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.graph-empty-hint {
  color: var(--text-3) !important;
  font-size: 11.5px !important;
}
.compass-empty {
  padding: 56px 20px;
  border-radius: 14px;
  border: 1px dashed var(--border);
  background: var(--bg-hover);
  text-align: center;
}
.empty-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
}
.empty-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-2);
}
@media (max-width: 860px) {
  .compass-main {
    flex-direction: column;
    height: auto;
  }
  .graph-wrap {
    height: 420px;
  }
}
</style>
