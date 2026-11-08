<template>
  <div v-if="conflict" class="ed-conflict-mask">
    <section class="ed-conflict">
      <header>
        <b>{{ t('edit.conflictTitle') }}</b>
        <code>EDIT_VERSION_CONFLICT</code>
      </header>
      <p>{{ t('edit.conflictHint', { version: conflict.current_version }) }}</p>
      <dl>
        <div><dt>{{ t('edit.serverVersion') }}</dt><dd>{{ conflict.current_version }}</dd></div>
        <div><dt>{{ t('edit.updatedAt') }}</dt><dd>{{ formatTime(conflict.updated_at) }}</dd></div>
        <div><dt>{{ t('edit.serverClips') }}</dt><dd>{{ conflict.current_plan?.clips?.length ?? 0 }}</dd></div>
      </dl>
      <div class="ed-conflict-actions">
        <button type="button" :disabled="loading" @click="$emit('reload')">{{ t('edit.conflictReload') }}</button>
        <button type="button" :disabled="loading" @click="$emit('overwrite')">{{ t('edit.conflictOverwrite') }}</button>
        <button type="button" :disabled="loading" @click="$emit('copy')">{{ t('edit.conflictCopy') }}</button>
      </div>
      <p class="ed-conflict-note">{{ t('edit.conflictCopyHint') }}</p>
    </section>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  conflict: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})
defineEmits(['reload', 'overwrite', 'copy'])
const { t } = useI18n()

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.ed-conflict-mask {
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0, 0, 0, .55);
}
.ed-conflict {
  width: 440px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-conflict header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ed-conflict header b { font-size: 14px; color: var(--text-0); }
.ed-conflict header code { font-size: var(--text-micro); color: var(--warning); }
.ed-conflict p { margin: 0; font-size: 11px; color: var(--text-2); line-height: 1.6; }
.ed-conflict dl { display: flex; flex-direction: column; gap: 4px; margin: 0; }
.ed-conflict dl div { display: flex; justify-content: space-between; gap: 10px; font-size: var(--text-micro); }
.ed-conflict dt { color: var(--text-3); }
.ed-conflict dd { margin: 0; color: var(--text-1); }
.ed-conflict-actions { display: flex; gap: 8px; margin-top: 4px; }
.ed-conflict-actions button {
  flex: 1; height: 32px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; cursor: pointer;
}
.ed-conflict-actions button:first-child { border-color: var(--accent); background: var(--accent); color: #fff; }
.ed-conflict-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-conflict-note { font-size: var(--text-micro); color: var(--text-3); }
</style>
