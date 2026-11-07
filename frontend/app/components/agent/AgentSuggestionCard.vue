<template>
  <section class="suggestion-card">
    <header class="suggestion-head">
      <div class="suggestion-head-main">
        <Sparkles :size="13" class="suggestion-icon" />
        <span class="suggestion-title">{{ t('assistant.suggestion.title') }}</span>
        <span class="tag">{{ actionLabel }}</span>
      </div>
      <span class="suggestion-target">{{ targetLabel }}</span>
    </header>

    <div class="suggestion-label-text">{{ suggestion.label }}</div>

    <div class="suggestion-block">
      <div class="suggestion-label">{{ t('assistant.suggestion.reason') }}</div>
      <p class="suggestion-text">{{ suggestion.reason }}</p>
    </div>
    <div class="suggestion-block">
      <div class="suggestion-label">{{ t('assistant.suggestion.impact') }}</div>
      <p class="suggestion-text">{{ suggestion.impact }}</p>
    </div>

    <footer class="suggestion-actions">
      <span class="suggestion-hint">{{ t('assistant.suggestion.noAutoRun') }}</span>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="disabled"
        @click="emit('open', suggestion)"
      >
        <ArrowUpRight :size="12" />
        {{ actionButton }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, Sparkles } from 'lucide-vue-next'
import type { AgentSuggestion } from '~/composables/useAgentPageAdapter'

const props = defineProps<{
  suggestion: AgentSuggestion
  disabled?: boolean
}>()

const emit = defineEmits<{ open: [suggestion: AgentSuggestion] }>()

const { t } = useI18n()

const AGENT_KEYS = [
  'script_rewriter',
  'extractor',
  'storyboard_breaker',
  'prompt_generator',
  'voice_designer',
] as const
const PAGE_KEYS = [
  'script',
  'assets',
  'videos',
  'dubbing',
  'edit',
  'director',
  'mix',
  'delivery',
] as const

const actionLabel = computed(() => (
  props.suggestion.action === 'agent.run'
    ? t('assistant.suggestion.actions.agentRun')
    : t('assistant.suggestion.actions.pageOpen')
))
const actionButton = computed(() => (
  props.suggestion.action === 'agent.run'
    ? t('assistant.suggestion.openAgent')
    : t('assistant.suggestion.openPage')
))
const targetLabel = computed(() => {
  const target = props.suggestion.target
  if (props.suggestion.action === 'agent.run' && (AGENT_KEYS as readonly string[]).includes(target)) {
    return t(`assistant.suggestion.targets.agents.${target}`)
  }
  if ((PAGE_KEYS as readonly string[]).includes(target)) {
    return t(`assistant.suggestion.targets.pages.${target}`)
  }
  return target
})
</script>

<style scoped>
.suggestion-card {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: var(--radius-md, 10px);
  background: var(--surface);
  font-size: 12.5px;
}
.suggestion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.suggestion-head-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.suggestion-icon { color: var(--accent); flex-shrink: 0; }
.suggestion-title { font-weight: 700; }
.suggestion-target {
  font-size: 11.5px;
  color: var(--text-2);
  font-family: var(--font-mono, monospace);
}
.suggestion-label-text {
  margin-top: 8px;
  font-weight: 600;
  color: var(--text-1);
}
.suggestion-block { margin-top: 8px; }
.suggestion-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 2px;
}
.suggestion-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-1);
  line-height: 1.5;
}
.suggestion-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.suggestion-hint {
  font-size: 11px;
  color: var(--text-2);
}
</style>
