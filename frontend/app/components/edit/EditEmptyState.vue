<template>
  <div class="ed-empty">
    <Clapperboard :size="34" />
    <h2>{{ t('edit.emptyTitle') }}</h2>
    <p>{{ readonly ? t('edit.emptyHint') : t('edit.emptyEditableHint') }}</p>
    <div class="ed-empty-actions">
      <button
        v-if="!readonly && roughCutAvailable"
        class="ed-empty-btn is-primary"
        type="button"
        :disabled="busy"
        @click="$emit('rough-cut')"
      >
        <Wand2 :size="14" />
        {{ busy ? t('edit.roughCutRunning') : t('edit.roughCut') }}
      </button>
      <button class="ed-empty-btn" type="button" @click="$emit('back')">
        {{ t('edit.back') }}
      </button>
    </div>
    <p v-if="!readonly && !roughCutAvailable" class="ed-empty-note">
      {{ t('edit.emptyLibraryHint') }}
    </p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Clapperboard, Wand2 } from 'lucide-vue-next'

defineProps({
  readonly: { type: Boolean, default: false },
  roughCutAvailable: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})
defineEmits(['back', 'rough-cut'])
const { t } = useI18n()
</script>

<style scoped>
.ed-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px; color: var(--text-3); text-align: center;
}
.ed-empty h2 { margin: 0; font-size: 18px; color: var(--text-0); }
.ed-empty p { margin: 0; max-width: 460px; line-height: 1.6; color: var(--text-2); }
.ed-empty-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.ed-empty-btn {
  height: 34px; padding: 0 16px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-1);
  color: var(--text-0); cursor: pointer;
}
.ed-empty-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ed-empty-btn:disabled { opacity: .45; cursor: not-allowed; }
.ed-empty-note { font-size: 11px; color: var(--text-3); }
</style>
