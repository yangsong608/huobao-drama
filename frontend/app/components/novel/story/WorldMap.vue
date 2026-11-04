<template>
  <section class="world-map" :class="{ compact }">
    <header class="world-map-head">
      <h3>{{ t('novels.worldMap.title') }}</h3>
      <div class="world-map-actions">
        <span v-if="mapData?.places?.length" class="world-map-count">
          {{ t('novels.worldMap.placeCount', { count: mapData.places.length }) }}
        </span>
        <button v-if="editable" type="button" class="btn btn-ghost btn-sm" @click="addPlace">
          {{ t('novels.worldMap.addPlace') }}
        </button>
      </div>
    </header>
    <div ref="containerRef" class="world-map-canvas"></div>
    <p v-if="!mapData?.places?.length" class="story-empty">{{ t('novels.worldMap.empty') }}</p>

    <aside v-if="selected" class="world-map-detail">
      <header class="world-map-detail-head">
        <h4>{{ selected.name }}</h4>
        <button type="button" class="btn btn-ghost btn-sm" @click="selectedId = null">{{ t('common.close') }}</button>
      </header>

      <template v-if="editable">
        <label class="field">
          <span class="field-label">{{ t('novels.worldMap.fields.name') }}</span>
          <input
            type="text"
            class="input"
            :value="selected.name"
            @input="updateSelected({ name: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('novels.worldMap.fields.region') }}</span>
            <BaseSelect
              :model-value="selected.regionId || ''"
              :options="regionOptions"
              :searchable="false"
              @update:model-value="updateSelected({ regionId: $event || undefined })"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.worldMap.fields.faction') }}</span>
            <BaseSelect
              :model-value="selected.factionId || ''"
              :options="factionOptions"
              :searchable="false"
              @update:model-value="updateSelected({ factionId: $event || undefined })"
            />
          </label>
        </div>
        <label class="field">
          <span class="field-label">{{ t('novels.worldMap.fields.description') }}</span>
          <textarea
            class="textarea"
            rows="3"
            :value="selected.description || ''"
            @input="updateSelected({ description: ($event.target as HTMLTextAreaElement).value })"
          ></textarea>
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('novels.worldMap.fields.x') }}</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              class="input"
              :value="selected.x"
              @input="updateSelected({ x: clamp01(($event.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.worldMap.fields.y') }}</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              class="input"
              :value="selected.y"
              @input="updateSelected({ y: clamp01(($event.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
        <button type="button" class="btn btn-ghost btn-sm world-map-remove" @click="removePlace(selected.id)">
          {{ t('novels.worldMap.removePlace') }}
        </button>
      </template>

      <template v-else>
        <p v-if="selected.description" class="world-map-description">{{ selected.description }}</p>
        <p v-if="regionName(selected.regionId)" class="world-map-meta">
          {{ t('novels.worldMap.fields.region') }}：{{ regionName(selected.regionId) }}
        </p>
        <p v-if="factionName(selected.factionId)" class="world-map-meta">
          {{ t('novels.worldMap.fields.faction') }}：{{ factionName(selected.factionId) }}
        </p>
        <p class="world-map-meta">
          {{ t('novels.worldMap.fields.x') }} {{ selected.x.toFixed(2) }} ·
          {{ t('novels.worldMap.fields.y') }} {{ selected.y.toFixed(2) }}
        </p>
      </template>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseSelect from '~/components/BaseSelect.vue'
import { buildMapGraphOption, eventPlaceIds } from '~/utils/novel-atlas'

const props = defineProps<{
  mapData: any
  events?: any[]
  chapterNo?: number
  editable?: boolean
  dark?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{ (event: 'update:mapData', value: any): void; (event: 'select-place', value: any): void }>()
const { t } = useI18n()

const containerRef = ref<HTMLElement | null>(null)
const chartRef = shallowRef<any>(null)
let echarts: typeof import('echarts') | null = null
let resizeObserver: ResizeObserver | null = null
const selectedId = ref<string | null>(null)
const highlightIds = computed(() => eventPlaceIds(props.events || [], props.chapterNo || 0))
const selected = computed(() => props.mapData?.places?.find((place: any) => place.id === selectedId.value) || null)
const regionOptions = computed(() => [
  { label: t('novels.worldMap.noRegion'), value: '' },
  ...(props.mapData?.regions || []).map((region: any) => ({ label: region.name, value: region.id })),
])
const factionOptions = computed(() => [
  { label: t('novels.worldMap.noFaction'), value: '' },
  ...(props.mapData?.factions || []).map((faction: any) => ({ label: faction.name, value: faction.id })),
])

function clamp01(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, Math.round(number * 1000) / 1000))
}

function regionName(id?: string) {
  return (props.mapData?.regions || []).find((region: any) => region.id === id)?.name || ''
}

function factionName(id?: string) {
  return (props.mapData?.factions || []).find((faction: any) => faction.id === id)?.name || ''
}

async function ensureChart() {
  if (!echarts) echarts = await import('echarts')
  if (!chartRef.value && containerRef.value) {
    chartRef.value = echarts.init(containerRef.value, props.dark ? 'dark' : undefined)
    chartRef.value.on('click', (params: any) => {
      if (params.dataType === 'node') {
        selectedId.value = params.data.id
        emit('select-place', params.data._raw)
      }
    })
    chartRef.value.on('mouseup', () => {
      if (!props.editable) return
      const option = chartRef.value?.getOption()
      const nodes = option?.series?.[0]?.data || []
      const places = (props.mapData?.places || []).map((place: any) => {
        const node = nodes.find((item: any) => item.id === place.id)
        return node ? { ...place, x: clamp01(Number(node.x) / 1000), y: clamp01(Number(node.y) / 600) } : place
      })
      emit('update:mapData', { ...props.mapData, places })
    })
  }
}

function render() {
  const chart = chartRef.value
  if (!chart) return
  chart.setOption(buildMapGraphOption(props.mapData, {
    highlightIds: highlightIds.value,
    dark: props.dark,
  }), true)
}

function baseMap() {
  return props.mapData || { version: 1, generatedAt: null, regions: [], factions: [], places: [], routes: [] }
}

function updateSelected(patch: Record<string, unknown>) {
  if (!selected.value) return
  emit('update:mapData', {
    ...props.mapData,
    places: props.mapData.places.map((place: any) =>
      place.id === selected.value.id ? { ...place, ...patch } : place),
  })
}

function addPlace() {
  const id = `place-${Date.now()}`
  const map = baseMap()
  const next = {
    ...map,
    places: [...(map.places || []), { id, name: t('novels.worldMap.newPlace'), x: 0.5, y: 0.5, importance: 3 }],
  }
  emit('update:mapData', next)
  selectedId.value = id
}

function removePlace(id: string) {
  if (!window.confirm(String(t('novels.worldMap.removeConfirm')))) return
  const map = baseMap()
  emit('update:mapData', {
    ...map,
    places: (map.places || []).filter((place: any) => place.id !== id),
    routes: (map.routes || []).filter((route: any) => route.from !== id && route.to !== id),
  })
  if (selectedId.value === id) selectedId.value = null
}

onMounted(async () => {
  await nextTick()
  await ensureChart()
  render()
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => chartRef.value?.resize())
    resizeObserver.observe(containerRef.value)
  }
})

watch(() => [props.mapData, props.chapterNo, props.dark], render, { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chartRef.value?.dispose()
  chartRef.value = null
})
</script>

<style scoped>
.world-map {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
}
.world-map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.world-map-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.world-map-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.world-map-count {
  color: var(--text-3);
  font-size: 11.5px;
}
.world-map-canvas {
  width: 100%;
  height: 420px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-1);
}
.world-map.compact .world-map-canvas {
  height: 260px;
}
.story-empty {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
  text-align: center;
}
.world-map-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-1);
}
.world-map-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.world-map-detail-head h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.world-map-description,
.world-map-meta {
  margin: 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.65;
}
.world-map-remove {
  align-self: flex-start;
  color: var(--error);
}
</style>
