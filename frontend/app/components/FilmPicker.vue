<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal } from 'naive-ui'
import { Ellipsis } from 'lucide-vue-next'
import { filmAPI, type FilmSummary } from '~/composables/useApi'
import { useLongPress } from '~/composables/useLongPress'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

const props = withDefaults(defineProps<{
  show: boolean
  episodeId: number | null
  modelValue: number | null
  mode?: 'mix' | 'edit' | 'list'
}>(), { mode: 'list' })

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:modelValue', value: number | null): void
  (e: 'select', film: FilmSummary): void
  (e: 'set-current', film: FilmSummary): void
  (e: 'open-mix', film: FilmSummary): void
  (e: 'open-edit', film: FilmSummary): void
  (e: 'rename', film: FilmSummary): void
  (e: 'delete', film: FilmSummary): void
}>()

const { t, te } = useI18n()

// locale 缺失时回退中文，保证四语言包同步前界面不空
function label(key: string, fallback: string) {
  return te(key) ? t(key) : fallback
}

const KIND_FALLBACK: Record<string, string> = {
  concat: '拼接成片',
  mix: '混音成片',
  edit: '剪辑成片',
  import: '导入成片',
}
function kindLabel(kind: string) {
  return label(`films.kind.${kind}`, KIND_FALLBACK[kind] || kind)
}

const loading = ref(false)
const films = ref<FilmSummary[]>([])
const currentFilmId = ref<number | null>(null)
const menuShow = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuFilm = ref<FilmSummary | null>(null)

// 局部时长格式化（仓库无共享时长工具，ExportStage/TakeInspector 均为局部实现）
function formatDuration(ms: number) {
  if (!ms || ms <= 0) return '--'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

function formatCreatedAt(value: string) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  if (!props.episodeId) return
  loading.value = true
  try {
    const data = await filmAPI.list(props.episodeId)
    films.value = data?.films || []
    currentFilmId.value = data?.current_film_id ?? null
  } catch {
    films.value = []
    currentFilmId.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.show, (show) => {
  if (show) void load()
  else {
    menuShow.value = false
    cancelFilmLongPress()
  }
})
watch(() => props.episodeId, () => {
  if (props.show) void load()
})

function choose(film: FilmSummary) {
  emit('update:modelValue', film.id)
  emit('select', film)
  emit('update:show', false)
}

function onContextMenu(event: MouseEvent, film: FilmSummary) {
  event.preventDefault()
  menuFilm.value = film
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuShow.value = true
}

function openFilmMenuAt(x: number, y: number, film: FilmSummary) {
  menuFilm.value = film
  menuX.value = x
  menuY.value = y
  menuShow.value = true
}

function openFilmMenu(event: MouseEvent, film: FilmSummary) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openFilmMenuAt(rect.left, rect.bottom + 4, film)
}

const { onPointerDown: onFilmLongPressDown, cancel: cancelFilmLongPress } = useLongPress<FilmSummary>({
  onTrigger: (film, event) => openFilmMenuAt(event.clientX, event.clientY, film),
})

function onFilmPointerDown(event: PointerEvent, film: FilmSummary) {
  onFilmLongPressDown(event, film)
}

// 模式主按钮：混音=更换源成片，剪辑=在剪辑中打开，列表=普通选择
const primaryLabel = computed(() => {
  if (props.mode === 'mix') return label('films.changeSource', '更换源成片')
  if (props.mode === 'edit') return label('films.openInEdit', '在剪辑中打开')
  return label('common.confirm', '确认')
})

const menuItems = computed<MenuItem[]>(() => {
  const film = menuFilm.value
  if (!film) return []
  return [
    { key: 'select', label: primaryLabel.value, action: () => choose(film) },
    {
      key: 'set-current',
      label: label('films.setCurrent', '设为当前'),
      disabled: film.is_current,
      action: () => emit('set-current', film),
    },
    { key: 'open-mix', label: label('films.openMix', '在混音中打开'), action: () => emit('open-mix', film) },
    { key: 'open-edit', label: label('films.openEdit', '在剪辑中打开'), action: () => emit('open-edit', film) },
    { key: 'separator', label: '', separator: true, action: undefined },
    { key: 'rename', label: label('films.rename', '重命名'), action: () => emit('rename', film) },
    {
      key: 'delete',
      label: label('films.delete', '删除'),
      danger: true,
      disabled: film.is_current,
      reason: label('films.deleteCurrentBlocked', '当前成片不可删除，请先把其他成片设为当前'),
      action: () => emit('delete', film),
    },
  ]
})
</script>

<template>
  <NModal
    :show="props.show"
    @update:show="$emit('update:show', $event)"
  >
    <div class="film-picker">
      <div class="picker-head">
        <span class="picker-title">{{ label('films.title', '选择成片') }}</span>
        <button class="picker-close" type="button" @click="$emit('update:show', false)">×</button>
      </div>
      <div v-if="loading" class="picker-empty">{{ t('common.loading') }}</div>
      <div v-else-if="!films.length" class="picker-empty">
        {{ label('films.empty', '本集还没有成片，先去拼接导出一版吧') }}
      </div>
      <div v-else class="picker-list">
        <div
          v-for="film in films"
          :key="film.id"
          :class="['film-card', { selected: film.id === props.modelValue, current: film.is_current }]"
          data-long-press
          @pointerdown="onFilmPointerDown($event, film)"
          @click="choose(film)"
          @contextmenu="onContextMenu($event, film)"
        >
          <div class="film-card-head">
            <span class="film-title" :title="film.title">{{ film.title }}</span>
            <span class="film-kind">{{ kindLabel(film.kind) }}</span>
            <button
              class="film-more"
              type="button"
              :title="t('tablet.more')"
              :aria-label="t('tablet.more')"
              @pointerdown.stop
              @click.stop="openFilmMenu($event, film)"
            >
              <Ellipsis :size="14" />
            </button>
          </div>
          <div class="film-card-meta">
            <span v-if="film.is_current" class="badge badge-current">{{ label('films.current', '当前') }}</span>
            <span v-if="film.edit_project_id" class="badge badge-edited">{{ label('films.edited', '已剪辑') }}</span>
            <span class="film-duration">{{ formatDuration(film.duration_ms) }}</span>
            <span class="film-time">{{ formatCreatedAt(film.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </NModal>
  <ContextMenu
    v-model:show="menuShow"
    :x="menuX"
    :y="menuY"
    :items="menuItems"
  />
</template>

<style scoped>
.film-picker {
  width: 560px;
  max-width: 90vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--bg, #fff);
  border-radius: 10px;
  overflow: hidden;
}
.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #e0e0e0);
}
.picker-title { font-size: 14px; font-weight: 600; }
.picker-close {
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-dim, #888);
}
.picker-list { overflow-y: auto; padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.picker-empty { padding: 32px 16px; text-align: center; font-size: 12px; color: var(--text-dim, #888); }
.film-card {
  padding: 10px 12px;
  border: 1px solid var(--border, #e0e0e0);
  border-radius: 8px;
  cursor: pointer;
}
.film-card:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.04)); }
.film-card.selected { border-color: var(--primary, #4f7cff); }
.film-card.current { border-color: var(--primary, #4f7cff); background: var(--primary-soft, rgba(79, 124, 255, 0.06)); }
.film-card-head { display: flex; align-items: center; gap: 8px; }
.film-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.film-kind {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.06));
  color: var(--text-dim, #666);
}
.film-card-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--text-dim, #888); }
.badge { padding: 0 6px; border-radius: 4px; line-height: 18px; }
.badge-current { background: var(--primary, #4f7cff); color: #fff; }
.badge-edited { background: var(--success-soft, rgba(76, 175, 80, 0.14)); color: var(--success, #3d9a41); }
.film-time { margin-left: auto; }
.film-more { display: none; }
@media (hover: none) and (pointer: coarse) {
  .film-card { min-height: 44px; }
  .film-more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 1px solid var(--border, #e0e0e0);
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim, #666);
    cursor: pointer;
  }
}
</style>
