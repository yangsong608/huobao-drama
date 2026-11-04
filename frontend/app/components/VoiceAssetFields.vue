<template>
  <div class="voice-fields" :aria-busy="busy ? 'true' : 'false'">
    <label class="voice-field">
      <span>{{ t('episode.voice.voiceName') }}</span>
      <input v-model="draft.name" class="voice-input" />
    </label>
    <label class="voice-field">
      <span>{{ t('episode.voice.prompt') }}</span>
      <textarea
        v-model="draft.voicePrompt"
        class="voice-textarea"
        rows="5"
        :placeholder="t('episode.voice.promptPlaceholder')"
      />
      <small class="voice-hint">{{ t('episode.voice.promptHint') }}</small>
    </label>
    <div class="voice-meta">
      <span v-if="voice.gender" class="voice-meta-item">{{ t('episode.voice.gender') }} {{ voice.gender }}</span>
      <span v-if="voice.ageRange" class="voice-meta-item">{{ t('episode.voice.age') }} {{ voice.ageRange }}</span>
      <label class="voice-meta-item">
        {{ t('episode.voice.speed') }}
        <input v-model.number="draft.speed" class="voice-input is-short" type="number" step="0.05" min="0.5" max="2" />
      </label>
      <label class="voice-meta-item">
        {{ t('episode.voice.emotion') }}
        <input v-model="draft.emotion" class="voice-input is-short" />
      </label>
    </div>
    <details class="voice-details">
      <summary>{{ t('episode.voice.designInstruct') }}</summary>
      <textarea
        v-model="draft.designInstruct"
        class="voice-textarea"
        rows="3"
        :placeholder="t('episode.voice.designInstructHint')"
      />
      <small class="voice-hint">{{ t('episode.voice.designInstructAdvancedHint') }}</small>
    </details>
    <label class="voice-field">
      <span>{{ t('voiceProfile.externalVoiceId') }}</span>
      <input v-model="draft.externalVoiceId" class="voice-input" :placeholder="t('voiceProfile.externalVoiceIdPlaceholder')" />
      <small class="voice-hint">{{ t('voiceProfile.externalVoiceIdHint') }}</small>
    </label>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { VoiceProfile } from '~/composables/useApi'
import type { VoiceDraft } from '~/composables/useVoiceProfiles'

defineProps<{
  voice: VoiceProfile
  draft: VoiceDraft
  busy?: boolean
}>()

const { t } = useI18n()
</script>

<style scoped>
.voice-fields { display: flex; flex-direction: column; gap: 8px; }
.voice-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-3); }
.voice-input, .voice-textarea {
  width: 100%;
  font: inherit;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-2, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 7px;
  box-sizing: border-box;
}
.voice-input.is-short { width: 74px; }
.voice-textarea { resize: vertical; min-height: 56px; line-height: 1.5; }
.voice-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--text-3); }
.voice-meta-item { display: inline-flex; align-items: center; gap: 5px; }
.voice-details summary { cursor: pointer; font-size: 11px; color: var(--text-3); margin-bottom: 5px; }
.voice-hint { font-size: 10px; line-height: 1.5; color: var(--text-3); }
</style>
