<template>
  <div v-if="open" class="ed-drawer-mask" @click.self="$emit('close')">
    <aside class="ed-drawer">
      <header class="ed-drawer-head">
        <b>{{ t('edit.versionTitle') }}</b>
        <button type="button" :title="t('edit.close')" @click="$emit('close')">×</button>
      </header>

      <div class="ed-drawer-create">
        <input v-model="note" type="text" :placeholder="t('edit.versionNote')" :disabled="!canEdit" />
        <button type="button" :disabled="!canEdit || creating" @click="submitCreate">
          {{ creating ? t('edit.saving') : t('edit.versionCreate') }}
        </button>
      </div>
      <p v-if="draftDirty" class="ed-drawer-dirty">{{ t('edit.versionDirty') }}</p>

      <div class="ed-drawer-body">
        <p v-if="loading" class="ed-drawer-state">{{ t('edit.loading') }}</p>
        <p v-else-if="!revisions.length" class="ed-drawer-state">{{ t('edit.versionEmpty') }}</p>
        <article
          v-for="revision in revisions"
          :key="revision.id"
          class="ed-revision"
          :class="{ 'is-current': revision.is_current }"
        >
          <div class="ed-revision-head">
            <b>v{{ revision.revision_no }}</b>
            <span v-if="revision.is_current" class="ed-revision-badge">{{ t('edit.versionCurrent') }}</span>
            <small>{{ formatTime(revision.created_at) }}</small>
          </div>
          <p class="ed-revision-note">{{ revision.note || t('edit.untitled') }}</p>
          <div class="ed-revision-meta">
            <span>{{ t('edit.clipCount', { n: revision.clip_count ?? 0 }) }}</span>
            <span>{{ formatClock(revision.duration_ms || 0) }}</span>
          </div>
          <button
            class="ed-revision-restore"
            type="button"
            :disabled="!canEdit || revision.is_current || restoringId === revision.id"
            @click="restore(revision)"
          >
            {{ restoringId === revision.id ? t('edit.saving') : t('edit.versionRestore') }}
          </button>
        </article>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { formatClock } from '~/utils/edit-plan'

const props = defineProps({
  open: { type: Boolean, default: false },
  revisions: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  draftDirty: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'refresh', 'create', 'restore'])
const { t } = useI18n()
const note = ref('')
const creating = ref(false)
const restoringId = ref(0)

async function submitCreate() {
  if (!props.canEdit || creating.value) return
  creating.value = true
  try {
    emit('create', note.value.trim())
    note.value = ''
  } finally {
    creating.value = false
  }
}

function restore(revision) {
  if (!props.canEdit || restoringId.value) return
  restoringId.value = revision.id
  try {
    emit('restore', revision)
  } finally {
    restoringId.value = 0
  }
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

watch(
  () => props.open,
  (value) => {
    if (value) emit('refresh')
  },
)
</script>

<style scoped>
.ed-drawer-mask {
  position: fixed; inset: 0; z-index: 40; display: flex; justify-content: flex-end;
  background: rgba(0, 0, 0, .4);
}
.ed-drawer {
  width: 340px; max-width: 88vw; height: 100%; display: flex; flex-direction: column;
  background: var(--bg-1); border-left: 1px solid var(--border);
}
.ed-drawer-head {
  flex: 0 0 auto; height: 46px; padding: 0 12px; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid var(--border);
}
.ed-drawer-head b { font-size: 12px; }
.ed-drawer-head button {
  width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-drawer-create { flex: 0 0 auto; display: flex; gap: 6px; padding: 10px 12px 6px; }
.ed-drawer-create input {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-2); color: var(--text-0); font-size: var(--text-micro);
}
.ed-drawer-create button {
  flex: 0 0 auto; height: 28px; padding: 0 10px; border: 1px solid var(--accent);
  border-radius: 6px; background: var(--accent); color: #fff; font-size: var(--text-micro); cursor: pointer;
}
.ed-drawer-create button:disabled { opacity: .45; cursor: not-allowed; }
.ed-drawer-dirty { margin: 0; padding: 0 12px 6px; font-size: var(--text-micro); color: var(--warning); }
.ed-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.ed-drawer-state { margin: 12px 0; text-align: center; font-size: var(--text-micro); color: var(--text-3); }
.ed-revision {
  display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-2);
}
.ed-revision.is-current { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.ed-revision-head { display: flex; align-items: center; gap: 6px; }
.ed-revision-head b { font-size: 11px; }
.ed-revision-head small { margin-left: auto; font-size: 8px; color: var(--text-3); }
.ed-revision-badge {
  padding: 1px 5px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-size: 8px;
}
.ed-revision-note { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-micro); color: var(--text-1); }
.ed-revision-meta { display: flex; gap: 10px; font-size: var(--text-micro); color: var(--text-3); }
.ed-revision-restore {
  align-self: flex-start; height: 22px; margin-top: 2px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1);
  color: var(--text-1); font-size: var(--text-micro); cursor: pointer;
}
.ed-revision-restore:hover { border-color: var(--accent); }
.ed-revision-restore:disabled { opacity: .45; cursor: not-allowed; }
</style>
