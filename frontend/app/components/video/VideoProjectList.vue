<template>
  <aside class="project-rail">
    <div class="rail-head">
      <div class="rail-title-wrap">
        <span class="rail-eyebrow">{{ t('video.title') }}</span>
        <strong class="rail-title">{{ t('video.projects') }}</strong>
      </div>
      <button type="button" class="btn btn-primary btn-sm rail-create" @click="$emit('create')">
        <Plus :size="14" :stroke-width="2" />
        {{ t('video.create') }}
      </button>
    </div>

    <div v-if="loading" class="rail-loading">
      <div v-for="i in 4" :key="i" class="rail-skeleton"></div>
    </div>

    <div v-else-if="!projects.length" class="rail-empty">
      <Clapperboard :size="26" :stroke-width="1.4" />
      <p>{{ t('video.empty.title') }}</p>
      <button type="button" class="btn btn-sm" @click="$emit('create')">{{ t('video.empty.action') }}</button>
    </div>

    <div v-else class="rail-list">
      <div
        v-for="project in projects"
        :key="project.id"
        role="button"
        tabindex="0"
        class="rail-item"
        :class="{ active: project.id === activeId }"
        @click="$emit('select', project)"
        @keydown.enter.prevent="$emit('select', project)"
        @keydown.space.prevent="$emit('select', project)"
      >
        <span class="rail-thumb" :class="`mode-${project.mode}`">
          <ImageIcon v-if="!project.source_video_url" :size="15" :stroke-width="1.6" />
          <span v-else class="rail-thumb-initial">{{ initialOf(project) }}</span>
        </span>
        <span class="rail-main">
          <span class="rail-name">{{ project.title }}</span>
          <span class="rail-meta">
            <span class="mode-chip">{{ t(`video.mode.${project.mode}`) }}</span>
            <span>{{ t(`video.status.${project.status || 'draft'}`) }}</span>
          </span>
          <span class="rail-time">{{ t('video.card.updated', { time: formatTime(project.updated_at) }) }}</span>
        </span>
        <AppMenu placement="bottom-end" :min-width="140">
          <template #trigger>
            <span class="rail-more" :aria-label="t('common.more')" @click.stop>
              <MoreVertical :size="15" />
            </span>
          </template>
          <AppMenuItem @click="$emit('rename', project)">
            <Pencil :size="12" /> {{ t('video.menu.rename') }}
          </AppMenuItem>
          <AppMenuItem @click="$emit('duplicate', project)">
            <Copy :size="12" /> {{ t('video.menu.duplicate') }}
          </AppMenuItem>
          <AppMenuItem danger @click="$emit('delete', project)">
            <Trash2 :size="12" /> {{ t('video.menu.delete') }}
          </AppMenuItem>
        </AppMenu>
      </div>
    </div>

    <div class="rail-foot">
      <button type="button" class="rail-settings" @click="navigateTo('/settings?tab=ai')">
        <Settings :size="13" />
        {{ t('video.workbench.config') }}
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Clapperboard, Copy, Image as ImageIcon, MoreVertical, Pencil, Plus, Settings, Trash2 } from 'lucide-vue-next'
import AppMenu from '~/components/AppMenu.vue'
import AppMenuItem from '~/components/AppMenuItem.vue'

defineProps<{
  projects: any[]
  activeId?: number | null
  loading?: boolean
}>()
defineEmits<{
  create: []
  select: [project: any]
  rename: [project: any]
  duplicate: [project: any]
  delete: [project: any]
}>()

const { t } = useI18n()

function initialOf(project: any) {
  return String(project?.title || '视').trim().slice(0, 1)
}

function formatTime(raw: string | null | undefined) {
  if (!raw) return '—'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.project-rail {
  width: 272px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-base);
}
.rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 14px 12px;
}
.rail-title-wrap { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rail-eyebrow { font: 600 10px/1.3 var(--font-body); letter-spacing: .12em; text-transform: uppercase; color: var(--accent-text); }
.rail-title { font-size: 15px; color: var(--text-0); }
.rail-create { margin-left: auto; flex-shrink: 0; }
.rail-list { flex: 1; overflow-y: auto; min-height: 0; padding-bottom: 8px; }
.rail-loading { display: flex; flex-direction: column; gap: 8px; padding: 8px 14px; }
.rail-skeleton { height: 62px; border-radius: var(--radius); background: var(--bg-1); animation: pulse 1.5s ease-in-out infinite; }
.rail-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 18px; color: var(--text-3); font-size: 12px; text-align: center; }
.rail-empty p { margin: 0; }
.rail-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: calc(100% - 16px);
  margin: 2px 8px;
  padding: 9px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition: background .15s var(--ease-out), border-color .15s var(--ease-out);
}
.rail-item:hover { background: var(--bg-hover); }
.rail-item.active { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
.rail-thumb {
  width: 42px; height: 42px; flex-shrink: 0; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  color: var(--accent-text);
  background: radial-gradient(120% 120% at 0% 0%, var(--accent-bg) 0%, transparent 70%), var(--bg-1);
  border: 1px solid var(--border);
}
.rail-thumb-initial { font-size: 18px; font-weight: 650; opacity: .8; }
.rail-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.rail-name { font-size: 12.5px; font-weight: 600; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-meta { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-3); }
.mode-chip { padding: 0 5px; border: 1px solid var(--border); border-radius: 999px; font-size: 9.5px; line-height: 1.6; color: var(--text-2); }
.rail-time { font-size: 10px; color: var(--text-3); }
.rail-more { position: absolute; right: 5px; top: 6px; opacity: 0; color: var(--text-3); padding: 2px; }
.rail-item:hover .rail-more, .rail-item.active .rail-more { opacity: 1; }
.rail-foot { margin-top: auto; padding: 10px 14px 14px; }
.rail-settings { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; color: var(--text-3); font-size: 11px; cursor: pointer; padding: 4px 0; }
.rail-settings:hover { color: var(--accent-text); }
@media (max-width: 900px) {
  .project-rail { width: 100%; border-right: 0; }
}
</style>
