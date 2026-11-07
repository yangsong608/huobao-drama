<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkbenchChapter } from '~/composables/useNovelWorkbench'

const props = withDefaults(defineProps<{
  chapters?: WorkbenchChapter[]
  currentChapter?: number
  loading?: boolean
}>(), {
  chapters: () => [],
  currentChapter: 1,
  loading: false,
})

const emit = defineEmits<{ (event: 'select', chapterNo: number): void }>()

const { t } = useI18n()
const keyword = ref('')
const itemRefs: Record<number, HTMLElement | null> = {}

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return props.chapters
  return props.chapters.filter((chapter) =>
    chapter.title.toLowerCase().includes(query) || chapter.summary.toLowerCase().includes(query),
  )
})

watch(
  () => [props.currentChapter, filtered.value.length],
  async () => {
    await nextTick()
    itemRefs[props.currentChapter]?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

function setItemRef(chapterNo: number, element: unknown) {
  itemRefs[chapterNo] = element instanceof HTMLElement ? element : null
}
</script>

<template>
  <div class="novel-chapter-tree">
    <div class="chapter-tree-head">
      <span class="chapter-tree-title">{{ t('novels.workbench.treeEmptyTitle') }}</span>
      <span class="chapter-tree-count">{{ t('novels.workbench.chaptersCount', { n: chapters.length }) }}</span>
    </div>
    <input
      v-model="keyword"
      class="input chapter-tree-search"
      type="search"
      :placeholder="t('novels.workbench.searchPlaceholder')"
      :aria-label="t('novels.workbench.searchPlaceholder')"
    >
    <div v-if="loading && !chapters.length" class="chapter-tree-state">{{ t('common.loading') }}</div>
    <StudioEmptyState
      v-else-if="!chapters.length"
      compact
      icon="📖"
      :title="t('novels.workbench.treeEmptyTitle')"
      :description="t('novels.workbench.treeEmptyDesc')"
    />
    <p v-else-if="!filtered.length" class="chapter-tree-state">{{ t('novels.workbench.noMatch') }}</p>
    <div v-else class="chapter-tree-list">
      <button
        v-for="chapter in filtered"
        :key="chapter.chapter_no"
        :ref="(element) => setItemRef(chapter.chapter_no, element)"
        type="button"
        class="chapter-item"
        :class="{ on: chapter.chapter_no === currentChapter }"
        :title="chapter.title"
        @click="emit('select', chapter.chapter_no)"
      >
        <span class="chapter-no mono">{{ chapter.chapter_no }}</span>
        <span class="chapter-main">
          <span class="chapter-title">{{ chapter.title }}</span>
          <span class="chapter-meta">
            <span class="chapter-status" :class="chapter.status">
              {{ t(`novels.chapterStatus.${chapter.status === 'final' ? 'final' : 'draft'}`) }}
            </span>
            <span>{{ t('novels.writer.wordCount', { n: chapter.word_count }) }}</span>
          </span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.novel-chapter-tree {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 10px;
  gap: 8px;
}
.chapter-tree-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.chapter-tree-title {
  font-size: var(--text-label);
  font-weight: 650;
  color: var(--text-0);
}
.chapter-tree-count {
  font-size: var(--text-meta);
  color: var(--text-2);
}
.chapter-tree-search {
  height: var(--control-sm);
  font-size: var(--text-label);
}
.chapter-tree-state {
  padding: 12px 8px;
  font-size: var(--text-meta);
  color: var(--text-2);
}
.chapter-tree-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chapter-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-0);
  text-align: left;
  cursor: pointer;
}
.chapter-item:hover {
  background: var(--bg-hover);
}
.chapter-item.on {
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--accent);
}
.chapter-no {
  min-width: 20px;
  padding-top: 1px;
  font-size: var(--text-meta);
  color: var(--text-2);
}
.chapter-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.chapter-title {
  overflow: hidden;
  font-size: var(--text-label);
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chapter-meta {
  display: flex;
  gap: 8px;
  font-size: var(--text-meta);
  color: var(--text-2);
}
.chapter-status.final {
  color: var(--success, #16a34a);
  font-weight: 600;
}
</style>
