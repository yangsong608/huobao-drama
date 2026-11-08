<template>
  <aside class="ed-sidebar">
    <div class="ed-sidebar-head">
      <span class="ed-sidebar-title">{{ t('edit.filmsPanelTitle') }}</span>
      <button class="ed-side-btn" type="button" @click="$emit('new-concat')">{{ t('edit.newConcat') }}</button>
      <button class="ed-side-icon" type="button" :title="t('edit.refresh')" @click="$emit('refresh')">
        <RefreshCw :size="14" />
      </button>
    </div>
    <div v-if="loading" class="ed-side-state"><Loader2 :size="18" class="is-spin" /></div>
    <p v-else-if="!films.length" class="ed-side-state">{{ t('films.empty') }}</p>
    <ul v-else class="ed-film-list">
      <li v-for="film in films" :key="film.id">
        <button
          type="button"
          class="ed-film-card"
          :class="{ 'is-active': film.id === activeFilmId, 'is-current': film.id === currentFilmId }"
          :title="film.title"
          @click="$emit('open', film)"
          @contextmenu.prevent="openMenu(film, $event)"
        >
          <span class="ed-film-title">{{ film.title }}</span>
          <span class="ed-film-meta">
            <span :class="['ed-film-kind', `is-${film.kind}`]">{{ t(`films.kind.${film.kind}`) }}</span>
            <span>{{ formatDuration(film.duration_ms) }}</span>
            <span v-if="film.id === currentFilmId" class="ed-film-flag">{{ t('films.current') }}</span>
            <span v-if="film.edit_project_id" class="ed-film-flag is-edited">{{ t('films.edited') }}</span>
          </span>
        </button>
      </li>
    </ul>
    <ContextMenu
      v-model:show="menuShow"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
    />
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw } from 'lucide-vue-next'
import ContextMenu from '~/components/ContextMenu.vue'

const props = defineProps({
  films: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  currentFilmId: { type: Number, default: 0 },
  activeFilmId: { type: Number, default: 0 },
  canEdit: { type: Boolean, default: false },
})
const emit = defineEmits([
  'open', 'refresh', 'rename', 'remove', 'set-current', 'open-mix', 'open-exports', 'new-concat',
])
const { t } = useI18n()

const menuShow = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuFilm = ref(null)

function openMenu(film, event) {
  menuFilm.value = film
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuShow.value = true
}
const menuItems = computed(() => {
  const film = menuFilm.value
  if (!film) return []
  const isCurrent = film.id === props.currentFilmId
  return [
    { key: 'open', label: t('edit.openEdit'), action: () => emit('open', film) },
    { key: 'sep1', separator: true },
    {
      key: 'current', label: t('films.setCurrent'),
      disabled: !props.canEdit, reason: t('edit.readonly'),
      action: () => emit('set-current', film),
    },
    { key: 'mix', label: t('films.openMix'), action: () => emit('open-mix', film) },
    { key: 'sep2', separator: true },
    {
      key: 'rename', label: t('films.rename'),
      disabled: !props.canEdit, reason: t('edit.readonly'),
      action: () => {
        const title = window.prompt(t('films.rename'), film.title)
        if (title && title.trim() && title !== film.title) emit('rename', film, title.trim())
      },
    },
    { key: 'exports', label: t('edit.exportLog'), action: () => emit('open-exports') },
    { key: 'sep3', separator: true },
    {
      key: 'remove', label: t('films.delete'), danger: true,
      disabled: isCurrent || !props.canEdit,
      reason: isCurrent ? t('edit.deleteBlocked') : t('edit.readonly'),
      action: () => { if (window.confirm(t('films.deleteConfirm'))) emit('remove', film) },
    },
  ]
})

function formatDuration(ms) {
  if (!ms || ms <= 0) return '--:--'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
</script>

<style scoped>
.ed-sidebar {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-1); border-right: 1px solid var(--border); overflow: hidden;
}
.ed-sidebar-head {
  flex: 0 0 auto; height: 40px; padding: 0 10px; display: flex; align-items: center;
  gap: 6px; border-bottom: 1px solid var(--border);
}
.ed-sidebar-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 650; color: var(--text-0); }
.ed-side-btn {
  height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-2); color: var(--text-1); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-side-btn:hover { border-color: var(--accent); color: var(--text-0); }
.ed-side-icon {
  width: 24px; height: 24px; flex: 0 0 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--text-1); cursor: pointer;
}
.ed-side-icon:hover { background: var(--bg-hover); }
.ed-side-state {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 20px 12px; color: var(--text-3); font-size: 11px; text-align: center;
}
.is-spin { animation: ed-side-spin 1s linear infinite; }
@keyframes ed-side-spin { to { transform: rotate(360deg); } }
.ed-film-list {
  flex: 1; min-height: 0; margin: 0; padding: 8px; overflow-y: auto;
  list-style: none; display: flex; flex-direction: column; gap: 6px;
}
.ed-film-card {
  width: 100%; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2);
  color: var(--text-0); text-align: left; cursor: pointer;
}
.ed-film-card:hover { background: var(--bg-hover); }
.ed-film-card.is-current { border-color: var(--accent); }
.ed-film-card.is-active { background: var(--accent-bg); border-color: var(--accent); }
.ed-film-title {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 600;
}
.ed-film-meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--text-3); }
.ed-film-kind {
  padding: 0 5px; border-radius: 4px; background: var(--bg-hover);
  color: var(--text-2); white-space: nowrap;
}
.ed-film-kind.is-mix { background: var(--accent-bg); color: var(--accent-text); }
.ed-film-kind.is-edit { background: var(--success-bg); color: var(--success); }
.ed-film-flag {
  padding: 0 5px; border-radius: 4px; background: var(--accent-bg);
  color: var(--accent-text); white-space: nowrap;
}
.ed-film-flag.is-edited { background: var(--warning-bg); color: var(--warning); }
</style>
