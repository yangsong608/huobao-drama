<template>
  <Teleport to="body">
    <div v-if="open" class="ed-sub-list" role="dialog" :aria-label="t('edit.subtitleListTitle')">
      <header>
        <h3>{{ t('edit.subtitleListTitle') }}</h3>
        <input
          v-model="search"
          class="ed-sub-search"
          type="search"
          :placeholder="t('edit.search')"
          @click.stop
        />
        <button type="button" :title="t('common.close')" @click="$emit('close')">×</button>
      </header>
      <ul>
        <li
          v-for="cue in filtered"
          :key="cue.id"
          :class="{ 'is-selected': cue.id === selectedCueId }"
          @click="$emit('select', cue.id)"
        >
          <span class="ed-sub-time">{{ formatClockMs(cue.startMs) }} – {{ formatClockMs(cue.endMs) }}</span>
          <span class="ed-sub-text">{{ cue.text || t('edit.subtitleEmpty') }}</span>
          <span v-if="cue.role" class="ed-sub-role">{{ cue.role }}</span>
          <span v-if="cue.follow" class="ed-sub-follow">{{ t('edit.following') }}</span>
        </li>
        <li v-if="!filtered.length" class="is-empty">{{ t('edit.subtitleEmpty') }}</li>
      </ul>
      <footer>
        <button type="button" @click="$emit('add')">{{ t('edit.addSubtitle') }}</button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { formatClockMs } from '~/utils/edit-timecode'

const props = defineProps({
  open: { type: Boolean, default: false },
  cues: { type: Array, default: () => [] },
  selectedCueId: { type: String, default: '' },
})
defineEmits(['close', 'select', 'add'])
const { t } = useI18n()
const search = ref('')

// 关键字同时匹配文本、角色名，空格分隔多个关键字时取交集。
const filtered = computed(() => {
  const keywords = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const cues = [...props.cues].sort((a, b) => a.startMs - b.startMs)
  if (!keywords.length) return cues
  return cues.filter((cue) => {
    const haystack = `${cue.text ?? ''} ${cue.role ?? ''}`.toLowerCase()
    return keywords.every((keyword) => haystack.includes(keyword))
  })
})

watch(() => props.open, (value) => {
  if (value) search.value = ''
})
</script>

<style scoped>
.ed-sub-list {
  position: fixed; right: 16px; top: 64px; bottom: 16px; width: 320px; z-index: 70;
  display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-1); box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-sub-list header {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.ed-sub-list header h3 { flex: 0 0 auto; margin: 0; font-size: 12px; }
.ed-sub-search {
  flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 7px; background: var(--bg-2); color: var(--text-0); font-size: 11px;
}
.ed-sub-list header button {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 16px; cursor: pointer;
}
.ed-sub-list header button:hover { background: var(--bg-hover); }
.ed-sub-list ul { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 6px; list-style: none; }
.ed-sub-list li {
  display: flex; align-items: baseline; gap: 6px; padding: 6px 8px; border-radius: 7px;
  font-size: 11px; color: var(--text-1); cursor: pointer;
}
.ed-sub-list li:hover { background: var(--bg-hover); }
.ed-sub-list li.is-selected { background: var(--accent-bg); }
.ed-sub-list li.is-empty { color: var(--text-3); cursor: default; }
.ed-sub-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--text-3); font-size: 10px; }
.ed-sub-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-sub-role { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-sub-follow { flex: 0 0 auto; font-size: 9px; color: var(--accent-text); }
.ed-sub-list footer { padding: 10px 12px; border-top: 1px solid var(--border); }
.ed-sub-list footer button {
  width: 100%; height: 28px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; cursor: pointer;
}
.ed-sub-list footer button:hover { border-color: var(--accent); }
</style>
