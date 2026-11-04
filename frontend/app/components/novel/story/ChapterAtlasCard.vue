<template>
  <section class="chapter-atlas card">
    <header class="chapter-atlas-head">
      <h3>{{ t('novels.writer.atlas.title') }}</h3>
      <span v-if="disabled" class="tag">{{ t('novels.writer.atlas.locked') }}</span>
    </header>

    <div class="chapter-atlas-block">
      <div class="chapter-atlas-label">
        <span>{{ t('novels.writer.atlas.narration') }}</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="editNarration">
          {{ t('common.edit') }}
        </button>
      </div>
      <p class="chapter-atlas-text">{{ narration || t('novels.blueprint.narrationEmpty') }}</p>
    </div>

    <div class="chapter-atlas-block">
      <StoryTimeline
        :events="chapterEvents"
        :chapter-no="chapterNo"
        :editable="!disabled"
        :max-chapter="maxChapter"
        @update:events="saveEvents"
      />
    </div>

    <div class="chapter-atlas-block">
      <WorldMap
        :map-data="mapData"
        :events="events"
        :chapter-no="chapterNo"
        :editable="false"
        :dark="dark"
        compact
        @select-place="() => {}"
      />
      <button type="button" class="btn btn-ghost btn-sm chapter-atlas-open" @click="mapOpen = true">
        {{ t('novels.writer.atlas.openMap') }}
      </button>
    </div>

    <div v-if="mapOpen" class="overlay" @click.self="mapOpen = false">
      <div class="dialog chapter-atlas-dialog">
        <div class="dialog-head">
          <h3 class="dialog-title">{{ t('novels.writer.atlas.mapTitle') }}</h3>
          <button type="button" class="btn btn-ghost btn-sm" @click="mapOpen = false">
            {{ t('common.close') }}
          </button>
        </div>
        <div class="dialog-body">
          <WorldMap
            :map-data="mapData"
            :events="events"
            :chapter-no="chapterNo"
            :dark="dark"
            @select-place="() => {}"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StoryTimeline from './StoryTimeline.vue'
import WorldMap from './WorldMap.vue'

const props = defineProps<{
  chapterNo: number
  narration: string
  events: any[]
  mapData: any
  maxChapter?: number
  disabled?: boolean
  dark?: boolean
}>()
const emit = defineEmits<{
  (event: 'save-events', value: any[]): void
  (event: 'save-narration', value: string): void
}>()
const { t } = useI18n()
const mapOpen = ref(false)
const chapterEvents = computed(() => props.events.filter((event) => event.chapterNo === props.chapterNo))

function saveEvents(nextChapterEvents: any[]) {
  const others = props.events.filter((event) => event.chapterNo !== props.chapterNo)
  emit('save-events', [...others, ...nextChapterEvents].sort((a, b) => a.chapterNo - b.chapterNo))
}

function editNarration() {
  if (props.disabled) return
  const next = window.prompt(String(t('novels.blueprint.narrationDialogTitle', { n: props.chapterNo })), props.narration)
  if (next === null) return
  emit('save-narration', next.trim())
}
</script>

<style scoped>
.chapter-atlas {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 18px;
}
.chapter-atlas-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.chapter-atlas-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.chapter-atlas-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.chapter-atlas-block:first-of-type {
  padding-top: 0;
  border-top: none;
}
.chapter-atlas-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.chapter-atlas-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}
.chapter-atlas-open {
  align-self: flex-start;
}
.chapter-atlas-dialog {
  width: min(880px, calc(100vw - 48px));
}
</style>
