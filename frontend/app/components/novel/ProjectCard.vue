<template>
  <article
    class="card project-card"
    tabindex="0"
    role="button"
    :aria-label="t('novels.card.open', { title: project.title })"
    @click="emit('open', project)"
    @keydown.enter.prevent="emit('open', project)"
    @keydown.space.prevent="emit('open', project)"
  >
    <div class="project-cover">
      <span class="cover-initial">{{ initial }}</span>

      <div class="status-wrap">
        <span class="cover-badge status-badge">
          <span class="status-dot" :class="`is-${project.status || 'draft'}`"></span>
          {{ t(`novels.status.${project.status || 'draft'}`) }}
        </span>
      </div>

      <div v-if="project.architectureGenerated || project.blueprintGenerated || project.hasImport" class="badge-row">
        <span v-if="project.architectureGenerated" class="cover-badge">{{ t('novels.badges.architecture') }}</span>
        <span v-if="project.blueprintGenerated" class="cover-badge">{{ t('novels.badges.blueprint') }}</span>
        <span v-if="project.hasImport" class="cover-badge">
          {{ t('novels.badges.imported') }}
          <i v-if="project.hasUpdate" class="update-dot" :title="t('novels.badges.update')"></i>
        </span>
      </div>

      <div class="more-wrap">
        <button
          type="button"
          class="btn btn-icon btn-sm cover-more"
          :title="t('common.delete')"
          :aria-label="t('common.delete')"
          @click.stop="emit('delete', project)"
        >
          <Trash2 :size="14" :stroke-width="1.8" />
        </button>
      </div>
    </div>

    <div class="project-body">
      <h3 class="project-name truncate">{{ project.title }}</h3>
      <p v-if="project.topic" class="project-topic">{{ project.topic }}</p>

      <div class="project-meta">
        <div class="meta-tags">
          <span v-for="tag in (project.genre || []).slice(0, 2)" :key="tag" class="tag">{{ tag }}</span>
        </div>
        <span class="meta-text">
          {{ t('novels.card.chapters', { written: project.writtenChapters ?? 0, total: project.numberOfChapters ?? 0 }) }}
        </span>
        <span class="meta-text">{{ t('novels.card.wordsPerChapter', { n: project.wordNumber ?? 0 }) }}</span>
      </div>

      <div class="progress" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: `${progress}%` }"></i>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2 } from 'lucide-vue-next'

const props = defineProps<{ project: any }>()
const emit = defineEmits<{ open: [project: any]; delete: [project: any] }>()
const { t } = useI18n()

const initial = computed(() => String(props.project?.title || '書').trim().slice(0, 1))
const progress = computed(() => {
  const total = Number(props.project?.numberOfChapters) || 0
  const written = Number(props.project?.writtenChapters) || 0
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round((written / total) * 100)))
})
</script>

<style scoped>
.project-card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.16s var(--ease-out), border-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.project-card:hover,
.project-card:focus-visible {
  transform: translateY(-2px);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lift);
  outline: none;
}
.project-cover {
  position: relative;
  aspect-ratio: 2.1 / 1;
  display: flex;
  align-items: flex-end;
  padding: 12px 14px;
  background:
    radial-gradient(120% 120% at 0% 0%, var(--accent-bg) 0%, transparent 62%),
    var(--bg-1);
  border-bottom: 1px solid var(--border);
}
.cover-initial {
  font-size: 30px;
  font-weight: 650;
  line-height: 1;
  color: var(--accent-text);
  opacity: 0.55;
}
.status-wrap {
  position: absolute;
  top: 10px;
  left: 10px;
}
.cover-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-0);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}
.status-badge {
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(6px);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}
.status-dot.is-writing {
  background: var(--accent);
}
.status-dot.is-completed {
  background: var(--success);
}
.badge-row {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.update-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--error);
}
.more-wrap {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  transition: opacity 0.16s var(--ease-out);
}
.project-card:hover .more-wrap,
.project-card:focus-visible .more-wrap,
.more-wrap:focus-within {
  opacity: 1;
}
.cover-more {
  color: var(--text-2);
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(6px);
}
.cover-more:hover {
  color: var(--error);
  border-color: var(--error);
}
.project-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 7px;
  padding: 12px 14px 14px;
}
.project-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0);
}
.project-topic {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.project-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: auto;
  font-size: 11.5px;
  color: var(--text-3);
}
.meta-tags {
  display: flex;
  gap: 4px;
}
.meta-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
