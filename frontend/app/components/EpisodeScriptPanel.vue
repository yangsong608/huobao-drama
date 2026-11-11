<template>
  <div v-if="step === 0" class="step-editor">
    <div class="step-toolbar">
      <div class="toolbar-left">
        <div class="step-indicator">
          <span class="step-num">01</span>
          <span class="step-name">{{ t('episode.script.raw') }}</span>
        </div>
      </div>
      <div class="toolbar-right">
        <span v-if="rawLen" class="char-count">{{ t('episode.script.charCount', { n: rawLen }) }}</span>
        <button class="btn btn-sm" @click="emit('save')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          {{ t('common.save') }}
        </button>
      </div>
    </div>
    <textarea
      class="fill-textarea"
      :value="raw"
      :placeholder="t('episode.script.rawPlaceholder')"
      @input="emit('update:raw', ($event.target as HTMLTextAreaElement).value)"
    />
  </div>

  <div v-else-if="step === 1" class="step-editor">
    <div class="step-toolbar">
      <div class="toolbar-left">
        <div class="step-indicator">
          <span class="step-num">02</span>
          <span class="step-name">{{ t('episode.script.rewrite') }}</span>
        </div>
      </div>
      <div class="toolbar-right">
        <span v-if="scriptLen" class="char-count">{{ t('episode.script.charCount', { n: scriptLen }) }}</span>
        <button v-if="hasRawContent" class="btn btn-sm" @click="emit('skip')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
          {{ t('episode.script.skipRewrite') }}
        </button>
        <button v-if="hasScriptContent" class="btn btn-sm" :disabled="busy" @click="emit('rewrite')">
          <Loader2 v-if="rewriting" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          {{ t('episode.script.rewriteAgain') }}
        </button>
      </div>
    </div>

    <div v-if="!hasScriptContent && !busy" class="step-empty">
      <div class="empty-visual">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
      </div>
      <div class="empty-title">{{ t('episode.script.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.script.emptyDesc') }}</div>
      <div class="step-empty-actions">
        <button class="btn btn-primary" :disabled="remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="emit('rewrite')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          {{ t('episode.script.startRewrite') }}
        </button>
        <button class="btn" @click="emit('skip')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
          {{ t('episode.script.skipRewrite') }}
        </button>
      </div>
    </div>
    <div v-else-if="rewriting" class="step-loading">
      <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
      <div class="loading-text">{{ t('episode.script.rewriting') }}</div>
    </div>
    <textarea
      v-else
      class="fill-textarea"
      :value="script"
      :placeholder="t('episode.script.scriptPlaceholder')"
      @input="emit('update:script', ($event.target as HTMLTextAreaElement).value)"
    />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'

defineProps<{
  step: number
  raw: string
  script: string
  rawLen: number
  scriptLen: number
  hasRawContent: boolean
  hasScriptContent: boolean
  busy: boolean
  rewriting: boolean
  remoteReadonly: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
  (e: 'skip'): void
  (e: 'rewrite'): void
  (e: 'update:raw', value: string): void
  (e: 'update:script', value: string): void
}>()

const { t } = useI18n()
</script>

<style scoped>
/* Toolbar */
.step-toolbar {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  background: var(--surface-raised); flex-shrink: 0;
}
.toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.step-indicator { display: flex; align-items: center; gap: 8px; }
.step-num {
  width: 26px; height: 26px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-bg);
  font-family: var(--font-mono); font-size: 10px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 12.5px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Editor Area */
.step-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.fill-textarea {
  flex: 1; border: none; border-radius: 0; padding: 26px 28px;
  font-size: 13.5px; line-height: 1.9; resize: none; outline: none;
  font-family: var(--font-body); background: var(--bg-input); color: var(--text-0);
}
.fill-textarea:focus { box-shadow: none; }

/* Step Empty State */
.step-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; min-height: 300px; gap: 10px; padding: 46px;
  animation: fadeIn 0.3s var(--ease-out);
}
.empty-visual {
  width: 72px; height: 72px; border-radius: 22px;
  background: var(--bg-1); color: var(--accent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.empty-title { font-size: 22px; font-weight: 700; font-family: var(--font-display); color: var(--text-0); }
.empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.8; }
.step-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Step Loading */
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }
</style>
