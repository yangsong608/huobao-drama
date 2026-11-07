<template>
  <div class="character-roster">
    <p class="roster-note">{{ t('novels.workbench.characters.sourceNote') }}</p>

    <StudioEmptyState
      v-if="!characters.length"
      icon="👤"
      :title="t('novels.workbench.characters.emptyTitle')"
      :description="t('novels.workbench.characters.emptyDesc')"
      :action-label="t('novels.workbench.characters.editArchitecture')"
      @action="emit('edit-architecture')"
    />

    <template v-else>
      <ul class="roster-list">
        <li v-for="character in characters" :key="character.name" class="roster-item">
          <button
            type="button"
            class="roster-head"
            :aria-expanded="expanded === character.name"
            :title="expanded === character.name
              ? t('novels.workbench.characters.collapse', { name: character.name })
              : t('novels.workbench.characters.expand', { name: character.name })"
            @click="toggle(character.name)"
          >
            <span class="roster-name">{{ character.name }}</span>
            <span class="roster-meta">
              {{ t('novels.workbench.characters.appearances', { n: character.count }) }}
            </span>
            <ChevronDown :size="14" :class="['roster-chevron', { open: expanded === character.name }]" />
          </button>
          <div v-if="expanded === character.name" class="roster-body">
            <p v-if="character.relationship" class="roster-relationship">{{ character.relationship }}</p>
            <div class="roster-actions">
              <span class="roster-meta">
                {{ character.last_chapter_no
                  ? t('novels.workbench.characters.lastChapter', { n: character.last_chapter_no })
                  : t('novels.workbench.characters.noChapter') }}
              </span>
              <button
                v-if="character.last_chapter_no"
                type="button"
                class="btn btn-ghost btn-sm"
                @click="emit('jump', character.last_chapter_no)"
              >
                {{ t('novels.workbench.characters.jump', { n: character.last_chapter_no }) }}
              </button>
            </div>
          </div>
        </li>
      </ul>
      <button type="button" class="btn btn-ghost btn-sm roster-edit" @click="emit('edit-architecture')">
        {{ t('novels.workbench.characters.editArchitecture') }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

interface WorkbenchCharacter {
  name: string
  count: number
  last_chapter_no: number | null
  relationship: string
}

defineProps<{ characters: WorkbenchCharacter[] }>()
const emit = defineEmits<{
  (event: 'jump', chapterNo: number): void
  (event: 'edit-architecture'): void
}>()
const { t } = useI18n()
const expanded = ref<string | null>(null)

function toggle(name: string) {
  expanded.value = expanded.value === name ? null : name
}
</script>

<style scoped>
.character-roster {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px;
  overflow-y: auto;
}
.roster-note {
  margin: 0;
  color: var(--text-3);
  font-size: 11.5px;
}
.roster-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.roster-item {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-base);
}
.roster-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: transparent;
  color: var(--text-0);
  text-align: left;
  cursor: pointer;
}
.roster-head:hover {
  background: var(--bg-hover);
}
.roster-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--button-focus);
}
.roster-name {
  font-size: 13px;
  font-weight: 600;
}
.roster-head .roster-meta {
  margin-left: auto;
}
.roster-meta {
  color: var(--text-3);
  font-size: 11.5px;
}
.roster-chevron {
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform 0.16s var(--ease-out);
}
.roster-chevron.open {
  transform: rotate(180deg);
}
.roster-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 10px 10px;
}
.roster-relationship {
  margin: 0;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.roster-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.roster-edit {
  align-self: flex-start;
}
</style>
