<template>
  <aside class="ed-media">
    <header class="ed-media-head">
      <b>{{ t('edit.mediaLibrary') }}</b>
      <button class="ed-media-icon" type="button" :title="t('edit.retry')" @click="$emit('retry')">
        <RefreshCw :size="13" />
      </button>
    </header>

    <div class="ed-media-tabs">
      <button type="button" :class="{ 'is-on': tab === 'storyboards' }" @click="tab = 'storyboards'">
        {{ t('edit.mediaStoryboards') }}
      </button>
      <button type="button" :class="{ 'is-on': tab === 'lines' }" @click="tab = 'lines'">
        {{ t('edit.mediaLines') }}
      </button>
      <button type="button" :class="{ 'is-on': tab === 'takes' }" @click="tab = 'takes'">
        {{ t('edit.mediaTakes') }}
      </button>
    </div>

    <input v-model="query" class="ed-media-search" type="search" :placeholder="t('edit.searchMedia')" />

    <div class="ed-media-body">
      <p v-if="loading" class="ed-media-state">{{ t('edit.mediaLoading') }}</p>
      <div v-else-if="error" class="ed-media-state">
        <span>{{ error }}</span>
        <button type="button" @click="$emit('retry')">{{ t('edit.retry') }}</button>
      </div>

      <template v-else-if="tab === 'storyboards'">
        <article v-for="item in filteredStoryboards" :key="item.id" class="ed-media-row">
          <div class="ed-media-thumb">
            <img v-if="item.thumbnail_url" :src="mediaUrl(item.thumbnail_url)" :alt="item.title || ''" />
            <Film v-else :size="16" />
          </div>
          <div class="ed-media-info">
            <b>{{ t('edit.storyboardN', { n: item.number }) }}</b>
            <span>{{ item.title || t('edit.untitled') }}</span>
            <small>
              <template v-if="item.playable">{{ formatClock(item.source?.durationMs || 0) }}</template>
              <template v-else>{{ item.error || t('edit.mediaUnavailable') }}</template>
            </small>
          </div>
          <button
            class="ed-media-add"
            type="button"
            :title="usedStoryboardIds.includes(item.id) ? t('edit.alreadyAdded') : t('edit.addToTimeline')"
            :disabled="readonly || !item.playable || usedStoryboardIds.includes(item.id)"
            @click="$emit('add-storyboard', item)"
          >
            <Check v-if="usedStoryboardIds.includes(item.id)" :size="13" />
            <Plus v-else :size="13" />
          </button>
        </article>
        <p v-if="!filteredStoryboards.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>

      <template v-else-if="tab === 'lines'">
        <article v-for="line in filteredLines" :key="line.id" class="ed-media-row is-line">
          <div class="ed-media-info">
            <b>{{ line.speaker_name || t('edit.narration') }}</b>
            <span>{{ line.text }}</span>
            <small>{{ line.status }} · {{ formatClock(line.duration_ms || 0) }}</small>
          </div>
        </article>
        <p v-if="!filteredLines.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>

      <template v-else>
        <article v-for="take in filteredTakes" :key="take.id" class="ed-media-row is-line">
          <div class="ed-media-info">
            <b>{{ take.speaker_name || t('edit.narration') }} · v{{ take.take_no }}</b>
            <span>{{ take.text }}</span>
            <small>{{ formatClock(take.duration_ms || 0) }}</small>
          </div>
        </article>
        <p v-if="!filteredTakes.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>
    </div>

    <footer class="ed-media-foot">
      <p v-if="!media?.import_enabled" class="ed-media-note">{{ t('edit.importDisabled') }}</p>
      <div class="ed-media-actions">
        <button
          class="ed-media-btn is-primary"
          type="button"
          :disabled="readonly || !playableUnused.length"
          @click="$emit('add-all')"
        >
          {{ t('edit.addAll') }}
        </button>
        <button
          class="ed-media-btn"
          type="button"
          :disabled="readonly || !roughCutAvailable"
          @click="$emit('rough-cut')"
        >
          {{ t('edit.roughCut') }}
        </button>
      </div>
    </footer>
  </aside>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Check, Film, Plus, RefreshCw } from 'lucide-vue-next'
import { formatClock, mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  media: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  usedStoryboardIds: { type: Array, default: () => [] },
  roughCutAvailable: { type: Boolean, default: false },
})
defineEmits(['add-storyboard', 'add-all', 'rough-cut', 'retry'])
const { t } = useI18n()
const tab = ref('storyboards')
const query = ref('')

function match(value) {
  const text = String(value || '').toLowerCase()
  return !query.value.trim() || text.includes(query.value.trim().toLowerCase())
}

const filteredStoryboards = computed(() => (props.media?.storyboards ?? []).filter(
  (item) => match(item.title) || match(item.number),
))
const filteredLines = computed(() => (props.media?.lines ?? []).filter(
  (item) => match(item.text) || match(item.speaker_name),
))
const filteredTakes = computed(() => (props.media?.video_takes ?? []).filter(
  (item) => match(item.text) || match(item.speaker_name),
))
const playableUnused = computed(() => (props.media?.storyboards ?? []).filter(
  (item) => item.playable && !props.usedStoryboardIds.includes(item.id),
))
</script>

<style scoped>
.ed-media {
  min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  border-right: 1px solid var(--border); background: var(--bg-1);
}
.ed-media-head {
  flex: 0 0 auto; height: 42px; padding: 0 12px; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid var(--border);
}
.ed-media-head b { font-size: 12px; color: var(--text-0); }
.ed-media-icon {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); color: var(--text-2); cursor: pointer;
}
.ed-media-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 10px; }
.ed-media-tabs button {
  flex: 1; height: 26px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--text-3); font-size: 10px; cursor: pointer;
}
.ed-media-tabs button.is-on { background: var(--bg-2); color: var(--text-0); border-color: var(--border); }
.ed-media-search {
  flex: 0 0 auto; margin: 0 10px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); color: var(--text-0); font-size: 11px;
}
.ed-media-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px; display: flex; flex-direction: column; gap: 6px; }
.ed-media-row {
  display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 8px;
  border: 1px solid transparent; background: var(--bg-2);
}
.ed-media-row:hover { border-color: var(--border); }
.ed-media-row.is-line { align-items: flex-start; }
.ed-media-thumb {
  flex: 0 0 42px; height: 32px; display: flex; align-items: center; justify-content: center;
  overflow: hidden; border-radius: 5px; background: var(--bg-0); color: var(--text-3);
}
.ed-media-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ed-media-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ed-media-info b { font-size: 10px; color: var(--text-0); }
.ed-media-info span {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-2);
}
.ed-media-info small { font-size: 9px; color: var(--text-3); }
.ed-media-add {
  flex: 0 0 24px; width: 24px; height: 24px; display: inline-flex; align-items: center;
  justify-content: center; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer;
}
.ed-media-add:disabled { opacity: .4; cursor: not-allowed; }
.ed-media-state {
  margin: 8px 0; padding: 12px 4px; display: flex; flex-direction: column; gap: 6px;
  align-items: center; justify-content: center; text-align: center; color: var(--text-3); font-size: 10px;
}
.ed-media-state button {
  height: 24px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer; font-size: 10px;
}
.ed-media-foot { flex: 0 0 auto; padding: 8px 10px 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.ed-media-note { margin: 0; font-size: 9px; color: var(--text-3); }
.ed-media-actions { display: flex; gap: 6px; }
.ed-media-btn {
  flex: 1; height: 28px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-1); font-size: 10px; cursor: pointer;
}
.ed-media-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ed-media-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
