<template>
  <aside class="ed-media" :aria-label="t('edit.mediaLibrary')">
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
          <div class="ed-media-row-actions">
            <button
              class="ed-media-icon is-add"
              type="button"
              :title="addTitle(item)"
              :disabled="readonly || !item.playable || usedStoryboardIds.includes(item.id)"
              @click="$emit('add-storyboard', item)"
            >
              <Check v-if="usedStoryboardIds.includes(item.id)" :size="13" />
              <Plus v-else :size="13" />
            </button>
            <button
              class="ed-media-icon is-replace"
              type="button"
              :title="replaceTitle(item)"
              :disabled="readonly || !item.playable || !canReplace"
              @click="$emit('replace-clip', item)"
            >
              <Replace :size="13" />
            </button>
          </div>
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
      <p v-if="replaceHint" class="ed-media-note">{{ replaceHint }}</p>
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
import { Check, Film, Plus, Replace } from 'lucide-vue-next'
import { formatClock, mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  media: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  usedStoryboardIds: { type: Array, default: () => [] },
  roughCutAvailable: { type: Boolean, default: false },
  canReplace: { type: Boolean, default: false },
  replaceReason: { type: String, default: '' },
})
defineEmits(['add-storyboard', 'add-all', 'replace-clip', 'rough-cut', 'retry'])
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
const replaceHint = computed(() => {
  if (props.readonly || props.canReplace) return ''
  return props.replaceReason || t('edit.replaceSelectFirst')
})

function addTitle(item) {
  if (props.usedStoryboardIds.includes(item.id)) return t('edit.alreadyAdded')
  if (!item.playable) return item.error || t('edit.mediaUnavailable')
  return t('edit.addToTimeline')
}

function replaceTitle(item) {
  if (props.readonly) return t('edit.readonlyEdit')
  if (!item.playable) return item.error || t('edit.mediaUnavailable')
  if (!props.canReplace) return props.replaceReason || t('edit.replaceSelectFirst')
  return t('edit.replaceSelected')
}
</script>

<style scoped>
.ed-media {
  min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  border-right: 1px solid var(--border); background: var(--bg-1); overflow: hidden;
}
.ed-media-icon {
  width: var(--control-xs); height: var(--control-xs); display: inline-flex; align-items: center;
  justify-content: center; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-2); cursor: pointer;
}
.ed-media-icon:disabled { opacity: .4; cursor: not-allowed; }
.ed-media-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 8px 10px 0; }
.ed-media-tabs button {
  flex: 1; height: var(--control-xs); border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--text-3); font-size: var(--text-micro); cursor: pointer;
}
.ed-media-tabs button.is-on { background: var(--bg-2); color: var(--text-0); border-color: var(--border); }
.ed-media-search {
  flex: 0 0 auto; margin: 0 10px; height: var(--control-sm); padding: 0 8px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2);
  color: var(--text-0); font-size: var(--text-micro);
}
.ed-media-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px;
  display: flex; flex-direction: column; gap: 6px;
}
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
.ed-media-info b { font-size: var(--text-micro); color: var(--text-0); }
.ed-media-info span {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-micro); color: var(--text-2);
}
.ed-media-info small { font-size: var(--text-micro); color: var(--text-3); }
.ed-media-row-actions { flex: 0 0 auto; display: flex; flex-direction: column; gap: 4px; }
.ed-media-icon.is-add { color: var(--text-1); }
.ed-media-icon.is-replace { color: var(--accent-text); }
.ed-media-state {
  margin: 8px 0; padding: 12px 4px; display: flex; flex-direction: column; gap: 6px;
  align-items: center; justify-content: center; text-align: center;
  color: var(--text-3); font-size: var(--text-micro);
}
.ed-media-state button {
  height: var(--control-xs); padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer; font-size: var(--text-micro);
}
.ed-media-foot {
  flex: 0 0 auto; padding: 8px 10px 10px; border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.ed-media-note { margin: 0; font-size: var(--text-micro); color: var(--text-3); line-height: 1.45; }
.ed-media-actions { display: flex; gap: 6px; }
.ed-media-btn {
  flex: 1; height: var(--control-sm); border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-1); font-size: var(--text-micro); cursor: pointer;
}
.ed-media-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ed-media-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
