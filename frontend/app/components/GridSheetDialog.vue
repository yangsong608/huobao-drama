<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog grid-dialog">
      <div class="dialog-head">
        <div class="dialog-head-copy">
          <div class="dialog-title">{{ t('grid.title') }}</div>
          <div class="dialog-desc">{{ t('grid.desc') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto dialog-close" @click="close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="dialog-body grid-body">
        <div class="grid-form">
          <label class="field">
            <span class="field-label">{{ t('grid.kind') }}</span>
            <BaseSelect v-model="kind" :options="kindOptions" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('grid.layout') }}</span>
            <div class="grid-layout-row">
              <BaseSelect v-model="rows" :options="rowOptions" />
              <span class="dim">×</span>
              <BaseSelect v-model="cols" :options="colOptions" />
            </div>
          </label>
          <label class="field">
            <span class="field-label">{{ t('grid.inset') }}</span>
            <input v-model.number="inset" class="input" type="number" min="0" max="0.2" step="0.005" />
            <span class="field-hint">{{ t('grid.insetHint') }}</span>
          </label>
          <label class="field grid-span-2">
            <span class="field-label">{{ t('grid.targets') }} <span class="field-optional">{{ currentTargets.length }}</span></span>
            <div class="grid-targets">
              <label v-for="item in currentTargets" :key="item.id" class="grid-target">
                <input v-model="selectedTargets" type="checkbox" :value="item.name" />
                <span>{{ item.name }}</span>
              </label>
              <span v-if="!currentTargets.length" class="field-hint">{{ t('grid.noTargets') }}</span>
            </div>
            <span class="field-hint">{{ t('grid.targetsHint') }}</span>
          </label>
          <label class="field grid-span-2">
            <span class="field-label">{{ t('grid.prompt') }}</span>
            <textarea v-model="prompt" class="textarea" rows="3" maxlength="600" :placeholder="t('grid.promptPlaceholder')" />
          </label>
          <div class="grid-actions grid-span-2">
            <button class="btn btn-primary" :disabled="creating" @click="create">
              {{ creating ? t('grid.creating') : sheet ? t('grid.regenerate') : t('grid.generate') }}
            </button>
            <span v-if="sheet" class="field-hint">{{ statusLabel }}</span>
          </div>
        </div>

        <div v-if="sheet" class="grid-result">
          <div class="grid-origin">
            <img v-if="sheet.imageUrl" :src="urlOf(sheet.imageUrl)" :alt="t('grid.title')" />
            <div v-else class="grid-placeholder">
              <span v-if="sheet.status === 'processing'" class="ring-spinner"></span>
              <span>{{ statusLabel }}</span>
            </div>
          </div>

          <div v-if="cells.length" class="grid-cells">
            <div v-for="cell in cells" :key="`${cell.row}-${cell.col}`" class="grid-cell">
              <img :src="urlOf(cell.url)" :alt="`${cell.row}-${cell.col}`" />
              <div class="grid-cell-meta">
                <span class="mono">R{{ cell.row + 1 }} C{{ cell.col + 1 }}</span>
                <button class="btn btn-sm" :disabled="applyingKey === cellKey(cell)" @click="applyCell(cell)">
                  {{ applyingKey === cellKey(cell) ? t('grid.applying') : t('grid.apply') }}
                </button>
              </div>
              <div class="grid-cell-target">
                <BaseSelect v-model="cellTargets[cellKey(cell)]" :options="targetOptions" :placeholder="t('grid.pickTarget')" />
              </div>
            </div>
          </div>

          <div v-if="cells.length" class="grid-rect">
            <div class="grid-rect-head">
              <span>{{ t('grid.rectTitle') }}</span>
              <button class="btn btn-sm" :disabled="splitting || outputBlocked" :title="outputBlocked ? t('media.capability.actionDisabled') : undefined" @click="resplit">
                {{ splitting ? t('grid.splitting') : t('grid.resplit') }}
              </button>
              <MediaCapabilityNotice v-if="outputBlocked" action="output" mode="inline" />
            </div>
            <p class="field-hint">{{ t('grid.rectHint') }}</p>
            <div v-for="rect in rects" :key="`${rect.row}-${rect.col}`" class="grid-rect-row">
              <span class="mono">R{{ rect.row + 1 }} C{{ rect.col + 1 }}</span>
              <label v-for="key in ['x', 'y', 'w', 'h']" :key="key" class="grid-rect-field">
                <span>{{ key.toUpperCase() }}</span>
                <input v-model.number="rect[key]" type="number" min="0" max="1" step="0.01" class="input" />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="dialog-foot">
        <span class="dialog-foot-copy">{{ t('grid.foot') }}</span>
        <button class="btn" @click="close">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import BaseSelect from '~/components/BaseSelect.vue'
import { gridAPI, characterAPI, sceneAPI, propAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import MediaCapabilityNotice from '~/components/MediaCapabilityNotice.vue'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'

const props = defineProps<{
  open: boolean
  dramaId: number
  episodeId?: number | null
  kind: string
  targets: { id: number; name: string; kindKey: string }[]
}>()
const emit = defineEmits<{ close: []; applied: [] }>()
const { t } = useI18n()
const mediaCaps = useMediaCapabilities()
const outputBlocked = computed(() => !mediaCaps.outputReady.value)

const kind = ref(props.kind || 'character')
const rows = ref(2)
const cols = ref(2)
const inset = ref(0.015)
const prompt = ref('')
const selectedTargets = ref<string[]>([])
const creating = ref(false)
const splitting = ref(false)
const sheet = ref<any>(null)
const cells = ref<any[]>([])
const rects = ref<any[]>([])
const cellTargets = ref<Record<string, number | null>>({})
const applyingKey = ref('')

const kindOptions = computed(() => [
  { label: t('common.role'), value: 'character' },
  { label: t('common.scene'), value: 'scene' },
  { label: t('common.prop'), value: 'prop' },
])
const rowOptions = [1, 2, 3, 4, 5].map(n => ({ label: String(n), value: n }))
const colOptions = [1, 2, 3, 4, 5].map(n => ({ label: String(n), value: n }))
const currentTargets = computed(() => (props.targets || []).filter(x => x.kindKey === kind.value))
const targetOptions = computed(() => [
  { label: t('grid.noTarget'), value: 0 },
  ...currentTargets.value.map(x => ({ label: x.name, value: x.id })),
])
const statusLabel = computed(() => {
  const map: Record<string, string> = {
    processing: t('grid.statusProcessing'),
    generated: t('grid.statusGenerated'),
    split: t('grid.statusSplit'),
    failed: t('grid.statusFailed'),
  }
  return map[sheet.value?.status] || sheet.value?.status || ''
})

watch(() => props.kind, (value) => { if (value) kind.value = value })
watch(kind, () => { selectedTargets.value = []; cells.value = []; sheet.value = null })

function cellKey(cell: any) { return `${cell.row}-${cell.col}` }
function urlOf(raw: string | null | undefined) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

// 宫格生成 3s 轮询：attempts 跨轮累计（上限 80 次），隐藏暂停、卸载必停
let attempts = 0
let pollId = 0
const gridPoll = useVisibilityPolling(async () => {
  if (!pollId) return
  const id = pollId
  attempts += 1
  try {
    const data = await gridAPI.get(id)
    // 迟到响应：期间已关闭或已切到新 sheet 时，不得写状态、停新轮询或对新 id 切图
    if (id !== pollId || !gridPoll.isRunning()) return
    sheet.value = { ...sheet.value, ...data }
    if (data.status === 'generated') {
      stopPoll()
      await split(id)
    } else if (data.status === 'failed' || attempts > 80) {
      stopPoll()
      if (data.status === 'failed') toast.error(t('grid.statusFailed'))
    }
  } catch {
    if (id === pollId && attempts > 80) stopPoll()
  }
}, 3000)
function stopPoll() { gridPoll.stop() }

function poll(id: number) {
  stopPoll()
  attempts = 0
  pollId = id
  gridPoll.start()
}

async function create() {
  if (creating.value) return
  creating.value = true
  try {
    const result = await gridAPI.create({
      drama_id: props.dramaId,
      episode_id: props.episodeId || undefined,
      kind: kind.value,
      rows: rows.value,
      cols: cols.value,
      prompt: prompt.value.trim() || undefined,
      targets: selectedTargets.value,
      inset: inset.value,
    })
    sheet.value = { id: result.id, status: result.status, imageUrl: null, taskId: result.taskId }
    cells.value = []
    toast.success(t('grid.created'))
    poll(result.id)
  } catch (error) {
    toastError(error)
  } finally {
    creating.value = false
  }
}

async function split(id: number, rectOverride?: any[]) {
  if (outputBlocked.value) {
    toastError(t('media.capability.actionDisabled'))
    return
  }
  splitting.value = true
  try {
    const result = await gridAPI.split(id, rectOverride?.length ? { inset: inset.value, cells: rectOverride } : { inset: inset.value })
    cells.value = result?.cells || []
    rects.value = cells.value.map((cell: any, index: number) => ({
      row: cell.row,
      col: cell.col,
      x: Number((cell.col / Math.max(1, cols.value)).toFixed(3)),
      y: Number((cell.row / Math.max(1, rows.value)).toFixed(3)),
      w: Number((1 / Math.max(1, cols.value)).toFixed(3)),
      h: Number((1 / Math.max(1, rows.value)).toFixed(3)),
      ...(rectOverride?.[index] || {}),
    }))
    sheet.value = { ...sheet.value, status: 'split' }
  } catch (error) {
    toastError(error)
  } finally {
    splitting.value = false
  }
}

async function resplit() {
  if (!sheet.value?.id) return
  const payload = rects.value.map(r => ({
    row: r.row, col: r.col,
    x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
  }))
  await gridAPI.updateCells(sheet.value.id, payload, inset.value)
  await split(sheet.value.id, payload)
  toast.success(t('grid.rectSaved'))
}

async function applyCell(cell: any) {
  const targetId = cellTargets.value[cellKey(cell)]
  if (!targetId) { toast.warning(t('grid.pickTargetFirst')); return }
  applyingKey.value = cellKey(cell)
  try {
    const payload = { image_url: cell.url, local_path: cell.url }
    if (kind.value === 'character') await characterAPI.update(targetId, payload)
    else if (kind.value === 'scene') await sceneAPI.update(targetId, payload)
    else await propAPI.update(targetId, payload)
    toast.success(t('grid.applied'))
    emit('applied')
  } catch (error) {
    toastError(error)
  } finally {
    applyingKey.value = ''
  }
}

function close() {
  stopPoll()
  emit('close')
}

onBeforeUnmount(stopPoll)
</script>

<style scoped>
.grid-dialog { width: min(980px, 94vw); max-height: 90vh; }
.grid-body { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 18px; overflow: auto; }
.grid-form { display: flex; flex-direction: column; gap: 12px; }
.grid-form .grid-span-2 { grid-column: span 1; }
.grid-layout-row { display: flex; align-items: center; gap: 8px; }
.grid-targets { display: flex; flex-wrap: wrap; gap: 6px 12px; max-height: 120px; overflow: auto; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.grid-target { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); }
.grid-actions { display: flex; align-items: center; gap: 10px; }
.grid-result { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.grid-origin { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-2, rgba(127,127,127,0.06)); min-height: 160px; display: flex; align-items: center; justify-content: center; }
.grid-origin img { width: 100%; max-height: 320px; object-fit: contain; display: block; }
.grid-placeholder { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; padding: 28px; }
.grid-cells { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.grid-cell { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.grid-cell img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
.grid-cell-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; font-size: 11px; color: var(--text-2); }
.grid-cell-target { padding: 0 6px 6px; }
.grid-rect { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.grid-rect-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-1); }
.grid-rect-row { display: grid; grid-template-columns: 64px repeat(4, 1fr); gap: 6px; align-items: center; font-size: 11px; color: var(--text-2); }
.grid-rect-field { display: flex; align-items: center; gap: 4px; }
.grid-rect-field .input { padding: 3px 6px; font-size: 11px; }
.dim { color: var(--text-3); }
@media (max-width: 760px) {
  .grid-body { grid-template-columns: 1fr; }
}
</style>
