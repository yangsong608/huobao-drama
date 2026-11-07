<template>
  <div class="novel-inspector">
    <div class="novel-inspector-head">
      <button
        v-if="annotationsEnabled"
        type="button"
        :class="['inspector-tab', { on: currentSection === 'annotations' }]"
        @click="emit('update:section', 'annotations')"
      >
        {{ t('novels.workbench.annotations.title') }}
        <span v-if="chapterAnnotations.length" class="inspector-tab-count">{{ chapterAnnotations.length }}</span>
      </button>
      <button
        v-if="foreshadowEnabled"
        type="button"
        :class="['inspector-tab', { on: currentSection === 'foreshadows' }]"
        @click="emit('update:section', 'foreshadows')"
      >
        {{ t('novels.workbench.foreshadow.title') }}
        <span v-if="relatedForeshadows.length" class="inspector-tab-count">{{ relatedForeshadows.length }}</span>
      </button>
      <button
        type="button"
        :class="['inspector-tab', { on: currentSection === 'characters' }]"
        @click="emit('update:section', 'characters')"
      >
        {{ t('novels.workbench.characters.title') }}
        <span v-if="characters.length" class="inspector-tab-count">{{ characters.length }}</span>
      </button>
    </div>
    <div class="novel-inspector-body">
      <NovelAnnotationList
        v-if="currentSection === 'annotations'"
        :novel-id="novelId"
        :chapter-no="chapterNo"
        :annotations="chapterAnnotations"
        :selection="selection"
        :active-id="activeId"
        :draft-nonce="draftNonce"
        @changed="emit('changed')"
        @locate="emit('locate', $event)"
        @active="emit('active', $event)"
      />
      <NovelForeshadowBoard
        v-else-if="currentSection === 'foreshadows'"
        :novel-id="novelId"
        :chapter-no="chapterNo"
        :chapter-count="chapterCount"
        :foreshadows="foreshadows"
        :auto-extract="autoExtract"
        :active-id="activeForeshadowId"
        @changed="emit('changed')"
        @jump="emit('jump', $event)"
        @active="emit('foreshadow-active', $event)"
      />
      <NovelCharacterRoster
        v-else
        :characters="characters"
        @jump="emit('jump', $event)"
        @edit-architecture="emit('edit-architecture')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NovelSelection, WorkbenchAnnotation } from '~/composables/useNovelWorkbench'
import NovelAnnotationList from './NovelAnnotationList.vue'
import NovelForeshadowBoard from './NovelForeshadowBoard.vue'
import NovelCharacterRoster from './NovelCharacterRoster.vue'

const props = defineProps<{
  novelId: number
  chapterNo: number
  chapterCount: number
  annotations: WorkbenchAnnotation[]
  foreshadows: any[]
  characters: any[]
  selection: NovelSelection | null
  activeId: number | null
  activeForeshadowId: number | null
  draftNonce: number
  annotationsEnabled: boolean
  foreshadowEnabled: boolean
  autoExtract: boolean
  section: 'annotations' | 'foreshadows' | 'characters'
}>()
const emit = defineEmits<{
  (event: 'changed'): void
  (event: 'locate', annotation: WorkbenchAnnotation): void
  (event: 'active', annotationId: number | null): void
  (event: 'foreshadow-active', foreshadowId: number | null): void
  (event: 'jump', chapterNo: number): void
  (event: 'edit-architecture'): void
  (event: 'update:section', section: 'annotations' | 'foreshadows' | 'characters'): void
}>()

const { t } = useI18n()
const chapterAnnotations = computed(() =>
  props.annotations.filter((annotation) => annotation.chapter_no === props.chapterNo),
)
const relatedForeshadows = computed(() =>
  props.foreshadows.filter((item) =>
    Number(item.setup_chapter) === props.chapterNo || Number(item.payoff_chapter) === props.chapterNo,
  ),
)
const currentSection = computed<'annotations' | 'foreshadows' | 'characters'>(() => {
  if (props.section === 'characters') return 'characters'
  if (props.section === 'foreshadows' && props.foreshadowEnabled) return 'foreshadows'
  if (props.annotationsEnabled) return 'annotations'
  if (props.foreshadowEnabled) return 'foreshadows'
  return 'characters'
})
</script>

<style scoped>
.novel-inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.novel-inspector-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  min-height: 40px;
  padding: 0 8px;
  border-bottom: 1px solid var(--surface-outline);
}
.inspector-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.inspector-tab:hover {
  background: var(--bg-2);
  color: var(--text-0);
}
.inspector-tab.on {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.inspector-tab-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 9.5px;
  font-weight: 700;
  text-align: center;
}
.novel-inspector-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
