<template>
  <Teleport to="body">
    <template v-if="visible">
      <button
        v-if="showFloatingEntry && !open"
        type="button"
        class="agent-dock-trigger"
        :aria-label="t('assistant.title')"
        @click="openAgentDock"
      >
        <Sparkles :size="16" />
        <span>{{ t('assistant.trigger') }}</span>
      </button>

      <aside
        v-if="open"
        class="agent-dock"
        :class="{ resizing }"
        :style="{ width: `${dockWidth}px` }"
        role="complementary"
        :aria-label="t('assistant.title')"
      >
        <div
          class="agent-dock-resize"
          role="separator"
          aria-orientation="vertical"
          :title="t('assistant.resize')"
          @pointerdown="beginResize"
        />

        <header class="agent-dock-head">
          <div class="agent-dock-title">
            <span class="agent-dock-mark"><Sparkles :size="14" /></span>
            <div class="agent-dock-title-copy">
              <div class="agent-dock-title-text">{{ session?.title || t('assistant.newChat') }}</div>
              <div class="agent-dock-sub">
                <span class="tag">{{ presetLabel }}</span>
                <span v-if="session?.status === 'archived'" class="tag">{{ t('assistant.archived') }}</span>
              </div>
            </div>
          </div>
          <div class="agent-dock-actions">
            <div class="agent-history-wrap">
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-sm"
                :title="t('assistant.history')"
                :aria-label="t('assistant.history')"
                @click="toggleHistory"
              >
                <History :size="14" />
              </button>
              <div v-if="historyOpen" class="agent-history-panel">
                <div class="agent-history-head">
                  <span>{{ t('assistant.history') }}</span>
                  <button type="button" class="btn btn-ghost btn-sm" :disabled="!scope" @click="createNewSession">
                    <Plus :size="12" /> {{ t('assistant.newChat') }}
                  </button>
                </div>
                <div v-if="threadsLoading && !threads.length" class="agent-history-empty">
                  <Loader2 :size="14" class="animate-spin" />
                </div>
                <div v-else-if="!threads.length" class="agent-history-empty dim">{{ t('assistant.historyEmpty') }}</div>
                <template v-else>
                  <button
                    v-for="thread in threads"
                    :key="thread.id"
                    type="button"
                    :class="['agent-history-item', { active: thread.id === session?.id }]"
                    @click="selectThread(thread.id)"
                  >
                    <span class="agent-history-item-title">{{ thread.title || t('assistant.newChat') }}</span>
                    <span class="agent-history-item-meta">
                      <span v-if="thread.id === session?.id" class="tag tag-success">{{ t('assistant.current') }}</span>
                      <span v-else-if="thread.status === 'archived'" class="tag">{{ t('assistant.archived') }}</span>
                      <span class="dim">{{ formatTime(thread.last_message_at || thread.updated_at) }}</span>
                    </span>
                  </button>
                  <button
                    v-if="threadsHasMore"
                    type="button"
                    class="btn btn-ghost btn-sm agent-history-more"
                    :disabled="threadsLoading"
                    @click="loadMoreThreads"
                  >
                    <Loader2 v-if="threadsLoading" :size="12" class="animate-spin" />
                    {{ t('assistant.historyLoadMore') }}
                  </button>
                </template>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-sm"
              :title="t('assistant.newChat')"
              :aria-label="t('assistant.newChat')"
              :disabled="!scope"
              @click="createNewSession"
            >
              <Plus :size="14" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-sm"
              :title="t('assistant.close')"
              :aria-label="t('assistant.close')"
              @click="closeAgentDock"
            >
              <X :size="14" />
            </button>
          </div>
        </header>

        <div v-if="scope" class="agent-scope-bar" :title="autoDetect ? t('assistant.scopeLocked') : t('assistant.scopeSelect')">
          <Lock v-if="autoDetect" :size="11" />
          <span class="agent-scope-kind">{{ scopeLabel }}</span>
          <code class="agent-scope-key">{{ scope.workspace_key }}</code>
          <select v-if="!autoDetect" v-model="manualScopeKind" class="agent-scope-select" :aria-label="t('assistant.scopeSelect')">
            <option :value="null" disabled>{{ t('assistant.scopeSelect') }}</option>
            <option v-for="item in supportedScopes" :key="item" :value="item">
              {{ t(`assistant.scopeKinds.${scopeKindKeys[item]}`) }}
            </option>
          </select>
          <span v-else class="agent-scope-auto dim">{{ t('assistant.scopeAuto') }}</span>
        </div>

        <div v-if="error" class="agent-dock-error" :title="errorDetail || undefined">{{ errorText }}</div>
        <div v-if="streamState === 'reconnecting'" class="agent-dock-reconnect">
          <Loader2 :size="12" class="animate-spin" /> {{ t('assistant.reconnecting') }}
        </div>

        <div ref="listEl" class="agent-messages" @scroll="onScroll">
          <button
            v-if="hasMore"
            type="button"
            class="btn btn-ghost btn-sm agent-load-earlier"
            :disabled="loadingMore"
            @click="loadEarlier"
          >
            <Loader2 v-if="loadingMore" :size="12" class="animate-spin" />
            {{ t('assistant.loadEarlier') }}
          </button>

          <div v-if="loadingSession && !messages.length" class="agent-loading">
            <Loader2 :size="16" class="animate-spin" />
          </div>

          <div v-else-if="!messages.length" class="agent-empty">
            <div class="agent-empty-icon"><Sparkles :size="22" /></div>
            <div class="agent-empty-title">{{ t('assistant.emptyTitle') }}</div>
            <div class="agent-empty-desc">{{ t('assistant.emptyDesc') }}</div>
            <div v-if="quickPrompts.length" class="agent-empty-prompts">
              <div class="agent-empty-prompts-label dim">{{ t('assistant.emptyPrompts') }}</div>
              <button
                v-for="prompt in quickPrompts"
                :key="prompt"
                type="button"
                class="agent-quick-prompt"
                @click="useQuickPrompt(prompt)"
              >
                {{ prompt }}
              </button>
            </div>
          </div>

          <div
            v-for="message in messages"
            :key="message.id"
            :class="['agent-message', `agent-message-${message.role}`]"
          >
            <div class="agent-message-meta">
              <span class="agent-message-author">
                {{ message.role === 'user' ? t('assistant.you') : t('assistant.assistantName') }}
              </span>
              <span v-if="messageScopeLabel(message)" class="tag agent-message-scope">
                {{ messageScopeLabel(message) }}
              </span>
              <span v-if="message.role === 'assistant' && message.status === 'cancelled'" class="tag">
                {{ t('assistant.statusCancelled') }}
              </span>
              <span v-if="message.role === 'assistant' && message.status === 'interrupted'" class="tag">
                {{ t('assistant.statusInterrupted') }}
              </span>
              <span v-if="message.role === 'assistant' && message.model" class="dim agent-message-model">
                {{ message.model }}
              </span>
            </div>

            <div v-if="message.role === 'user'" class="agent-user-bubble">{{ message.content }}</div>
            <div v-else class="agent-assistant-body">
              <div v-if="message.status === 'running' && !message.content" class="agent-thinking">
                <Loader2 :size="12" class="animate-spin" />
                {{ t('assistant.thinking') }}
              </div>
              <AgentMarkdown v-if="message.content" :content="message.content" />
              <span v-if="message.status === 'running' && message.content" class="agent-cursor" />

              <details
                v-if="runningTools(message).length || finishedTools(message).length"
                class="agent-tools"
              >
                <summary>{{ t('assistant.tools') }} ({{ runningTools(message).length + finishedTools(message).length }})</summary>
                <div v-for="(tool, index) in runningTools(message)" :key="`run-${index}`" class="agent-tool-item">
                  <div class="agent-tool-name">
                    <span>{{ tool.name }}</span>
                    <span class="dim">{{ t('assistant.toolRunning') }}</span>
                  </div>
                  <div v-if="tool.summary" class="agent-tool-summary">{{ tool.summary }}</div>
                  <pre v-if="tool.argsText" class="agent-tool-args">{{ tool.argsText }}</pre>
                </div>
                <div v-for="(tool, index) in finishedTools(message)" :key="`done-${index}`" class="agent-tool-item">
                  <div class="agent-tool-name">
                    <span>{{ tool.name }}</span>
                    <span :class="tool.status === 'failed' ? 'agent-tool-failed' : 'dim'">
                      {{ tool.status === 'failed' ? t('assistant.toolFailed') : t('assistant.toolDone') }}
                    </span>
                  </div>
                  <pre v-if="tool.argsText" class="agent-tool-args">{{ tool.argsText }}</pre>
                  <pre v-if="tool.text" class="agent-tool-result">{{ tool.text }}</pre>
                </div>
              </details>

              <div
                v-if="message.status === 'failed' || message.status === 'interrupted'"
                class="agent-message-status"
              >
                {{ message.status === 'interrupted' ? t('assistant.statusInterrupted') : t('assistant.statusFailed') }}
                <span v-if="message.error" class="agent-message-error" :title="message.error">{{ localizedAssistantError(message.error_code, message.error) }}</span>
              </div>
            </div>
          </div>
        </div>

        <footer class="agent-dock-foot">
          <textarea
            ref="inputEl"
            v-model="draft"
            class="textarea agent-input"
            rows="3"
            :maxlength="messageLimit"
            :placeholder="canSend ? t('assistant.inputPlaceholder') : t('assistant.inputDisabled')"
            :disabled="!session"
            @keydown="onInputKeydown"
          />
          <div class="agent-foot-row">
            <span class="dim agent-char-count">{{ t('assistant.charCount', { count: draft.length, max: messageLimit }) }}</span>
            <button
              v-if="streaming"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="cancelling"
              @click="cancel"
            >
              <Loader2 v-if="cancelling" :size="12" class="animate-spin" />
              <Square v-else :size="12" />
              {{ t('assistant.stop') }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!sendReady || !draft.trim()"
              @click="sendDraft"
            >
              <Send :size="12" />
              {{ t('assistant.send') }}
            </button>
          </div>
        </footer>
      </aside>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { History, Loader2, Lock, Plus, Send, Sparkles, Square, X } from 'lucide-vue-next'
import AgentMarkdown from './AgentMarkdown.vue'
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  closeAgentDock,
  findAgentPageAdapter,
  openAgentDock,
  setAgentDockWidth,
  useAgentDockRegistry,
  type AgentScopeKind,
} from '~/composables/useAgentPageAdapter'
import { useAgentSettings } from '~/composables/useAgentSettings'
import { sanitizeErrorText, useAssistant, type AssistantMessage } from '~/composables/useAssistant'

const { t } = useI18n()
const route = useRoute()

const { dockOpen, dockWidth } = useAgentDockRegistry()
const { loadAgentSettings, dockEnabled, agentSettings, agentSettingsError } = useAgentSettings()

const activeAdapter = computed(() => findAgentPageAdapter(route.name as string | null, route.path))
const scope = computed(() => activeAdapter.value?.scope() ?? null)
const visible = computed(() => dockEnabled.value && Boolean(activeAdapter.value) && Boolean(scope.value))
const open = computed(() => dockOpen.value && visible.value)
const showFloatingEntry = computed(() => {
  const entries = activeAdapter.value?.entries ?? []
  return visible.value && entries.includes('floating')
})
const quickPrompts = computed(() => activeAdapter.value?.quickPrompts() ?? [])
const messageLimit = computed(() => agentSettings.value?.message.maxChars ?? 4000)
const autoDetect = computed(() => agentSettings.value?.scope.autoDetect !== false)
const settingsSettled = computed(() => agentSettings.value !== null || Boolean(agentSettingsError.value))
const supportedScopes = computed(() => activeAdapter.value?.supportedScopes ?? [])
const manualScopeKind = ref<AgentScopeKind | null>(null)
const effectiveScope = computed(() => {
  if (!scope.value) return null
  if (autoDetect.value) return scope.value
  if (!manualScopeKind.value || !supportedScopes.value.includes(manualScopeKind.value)) return null
  return { ...scope.value, kind: manualScopeKind.value }
})

watch(autoDetect, enabled => {
  if (enabled) manualScopeKind.value = null
})
watch(() => activeAdapter.value?.id, () => {
  manualScopeKind.value = null
})

const scopeKindKeys: Record<AgentScopeKind, string> = {
  home: 'home',
  'novel-library': 'novelLibrary',
  novel: 'novel',
  drama: 'drama',
  episode: 'episode',
  director: 'director',
  edit: 'edit',
  mix: 'mix',
  delivery: 'delivery',
}
const scopeLabel = computed(() => {
  const kind = effectiveScope.value?.kind ?? scope.value?.kind
  return kind ? t(`assistant.scopeKinds.${scopeKindKeys[kind]}`) : ''
})
function messageScopeLabel(message: AssistantMessage): string {
  const kind = message.scope?.kind
  if (!kind || !(kind in scopeKindKeys)) return ''
  return t(`assistant.scopeKinds.${scopeKindKeys[kind as AgentScopeKind]}`)
}

const {
  session,
  messages,
  hasMore,
  loadingSession,
  loadingMore,
  streamState,
  threads,
  threadsHasMore,
  threadsLoading,
  streaming,
  cancelling,
  canSend,
  error,
  errorCode,
  resolve,
  newSession,
  loadEarlier,
  refreshThreads,
  loadMoreThreads,
  switchSession,
  send,
  cancel,
} = useAssistant()

const sendReady = computed(() => canSend.value && Boolean(effectiveScope.value))
const presetLabel = computed(() => t(`assistant.preset.${session.value?.preset === 'director' ? 'director' : 'assistant'}`))

const ASSISTANT_ERROR_CODES = [
  'AGENT_DISABLED',
  'AGENT_INTERNAL',
  'AGENT_MESSAGE_NOT_FOUND',
  'AGENT_SCOPE_FORBIDDEN',
  'AGENT_SCOPE_GONE',
  'AGENT_SCOPE_INVALID',
  'AGENT_SCOPE_NOT_FOUND',
  'AGENT_SESSION_CONFLICT',
  'AGENT_SESSION_INVALID',
  'AGENT_SESSION_NOT_FOUND',
  'assistant_failed',
  'interrupted',
] as const
function localizedAssistantError(code: string | null | undefined, fallback: string): string {
  if (code && (ASSISTANT_ERROR_CODES as readonly string[]).includes(code)) {
    return t(`assistant.errors.${code}`)
  }
  return sanitizeErrorText(fallback)
}
const errorText = computed(() => localizedAssistantError(errorCode.value, error.value))
const errorDetail = computed(() => (errorText.value === error.value ? '' : error.value))

const draft = ref('')
const historyOpen = ref(false)
const resizing = ref(false)
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
let stickToBottom = true

onMounted(() => {
  void loadAgentSettings()
})

watch(
  () => [visible.value, settingsSettled.value, scope.value?.workspace_key ?? ''] as const,
  async ([isVisible, settingsReady, workspaceKey]) => {
    if (!isVisible || !settingsReady || !workspaceKey || !scope.value) return
    await resolve(scope.value)
    if (!open.value) return
    stickToBottom = true
    await nextTick()
    scrollToBottom(true)
  },
  { immediate: true },
)

watch(open, async (isOpen) => {
  if (!isOpen) return
  stickToBottom = true
  await nextTick()
  scrollToBottom(true)
})

watch(
  () => [messages.value.length, messages.value[messages.value.length - 1]?.content, messages.value[messages.value.length - 1]?.status] as const,
  async () => {
    if (!stickToBottom) return
    await nextTick()
    scrollToBottom(true)
  },
)

function scrollToBottom(force = false): void {
  const el = listEl.value
  if (!el) return
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function sendDraft(): Promise<void> {
  const text = draft.value.trim()
  const target = effectiveScope.value
  if (!text || !target || !sendReady.value) return
  draft.value = ''
  stickToBottom = true
  await send(text, target)
  await nextTick()
  scrollToBottom(true)
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void sendDraft()
}

function useQuickPrompt(prompt: string): void {
  draft.value = prompt
  inputEl.value?.focus()
}

async function createNewSession(): Promise<void> {
  if (!scope.value) return
  historyOpen.value = false
  draft.value = ''
  await newSession(scope.value)
}

async function toggleHistory(): Promise<void> {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) await refreshThreads()
}

async function selectThread(sessionId: number): Promise<void> {
  historyOpen.value = false
  await switchSession(sessionId)
}

function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function runningTools(message: AssistantMessage) {
  return (message.tool_calls ?? [])
    .filter(call => (call.status ?? 'done') === 'running')
    .map(call => ({
      name: call.name || call.toolName || 'tool',
      summary: call.summary || '',
      argsText: call.args === undefined || call.args === null ? '' : plainToolText(call.args),
    }))
}

function finishedTools(message: AssistantMessage) {
  return (message.tool_results ?? []).map(result => {
    const name = result.toolName || result.name || 'tool'
    const call = [...(message.tool_calls ?? [])]
      .reverse()
      .find(item => (item.name || item.toolName) === name && item.args !== undefined && item.args !== null)
    return {
      name,
      status: result.status === 'failed' ? 'failed' : 'done',
      argsText: call ? plainToolText(call.args) : '',
      text: plainToolText(result.result),
    }
  })
}

function plainToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function beginResize(event: PointerEvent): void {
  event.preventDefault()
  resizing.value = true
  const startX = event.clientX
  const startWidth = dockWidth.value
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture?.(event.pointerId)
  const onMove = (moveEvent: PointerEvent) => {
    const width = startWidth + (startX - moveEvent.clientX)
    setAgentDockWidth(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, width)))
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>

<style scoped>
.agent-dock-trigger {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 900;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  background: var(--surface-raised);
  color: var(--text-0);
  font: 600 12.5px var(--font-body);
  box-shadow: var(--shadow-elevated);
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.agent-dock-trigger:hover {
  transform: translateY(-1px);
  border-color: var(--accent);
}
.agent-dock-trigger svg { color: var(--accent); }

.agent-dock {
  position: fixed;
  top: 72px;
  right: 16px;
  bottom: 16px;
  z-index: 910;
  min-width: 360px;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--shadow-elevated);
  overflow: hidden;
}
.agent-dock.resizing { user-select: none; cursor: ew-resize; }

.agent-dock-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 2;
}
.agent-dock-resize:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }

.agent-dock-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 8px 16px;
  border-bottom: 1px solid var(--border);
}
.agent-dock-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.agent-dock-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--accent-gradient);
  color: var(--on-accent);
  flex-shrink: 0;
}
.agent-dock-title-copy { min-width: 0; }
.agent-dock-title-text {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-dock-sub { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.agent-dock-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.agent-history-wrap { position: relative; }

.agent-history-panel {
  position: absolute;
  right: 0;
  top: 36px;
  width: 300px;
  max-height: 380px;
  overflow-y: auto;
  padding: 8px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  box-shadow: var(--shadow-elevated);
  z-index: 5;
}
.agent-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 8px;
  font-size: 12px;
  font-weight: 600;
}
.agent-history-empty { padding: 16px 4px; text-align: center; font-size: 12px; }
.agent-history-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
}
.agent-history-item:hover { background: var(--surface-hover, rgba(127, 127, 127, 0.08)); }
.agent-history-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.agent-history-item-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-history-item-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.agent-history-more { width: 100%; margin-top: 4px; }

.agent-scope-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-sunken, var(--bg-base));
}
.agent-scope-kind { font-weight: 600; color: var(--text-1); }
.agent-scope-key { font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: var(--surface-raised); }
.agent-scope-auto { margin-left: auto; }
.agent-scope-select {
  margin-left: auto;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-1);
  font-size: 11px;
}

.agent-dock-error {
  margin: 8px 14px 0;
  padding: 6px 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
  color: var(--danger, #ef4444);
  font-size: 11.5px;
}
.agent-dock-reconnect {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 14px 0;
  padding: 5px 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text-2);
  font-size: 11.5px;
}

.agent-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.agent-load-earlier { align-self: center; }
.agent-loading { display: flex; justify-content: center; padding: 24px 0; color: var(--text-2); }

.agent-empty { margin: auto 0; padding: 8px 4px; text-align: center; }
.agent-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: 10px;
  border-radius: 14px;
  background: var(--accent-gradient);
  color: var(--on-accent);
}
.agent-empty-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.agent-empty-desc { margin: 6px auto 0; max-width: 280px; font-size: 12px; line-height: 1.6; color: var(--text-2); }
.agent-empty-prompts { margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
.agent-empty-prompts-label { font-size: 11px; margin-bottom: 2px; }
.agent-quick-prompt {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-raised);
  color: var(--text-1);
  font: 400 12px/1.5 var(--font-body);
  text-align: left;
  cursor: pointer;
}
.agent-quick-prompt:hover { border-color: var(--accent); color: var(--text-0); }

.agent-message { display: flex; flex-direction: column; gap: 4px; }
.agent-message-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); }
.agent-message-author { font-weight: 600; color: var(--text-2); }
.agent-message-model { margin-left: auto; font-size: 10px; }
.agent-user-bubble {
  align-self: flex-end;
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px 12px 4px 12px;
  background: var(--accent-gradient);
  color: var(--on-accent);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-message-user .agent-message-meta { justify-content: flex-end; }
.agent-assistant-body { min-width: 0; }
.agent-thinking { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.agent-cursor {
  display: inline-block;
  width: 7px;
  height: 13px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: agent-blink 1s step-end infinite;
}
@keyframes agent-blink { 50% { opacity: 0; } }

.agent-tools {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-sunken, var(--bg-base));
  font-size: 11.5px;
}
.agent-tools summary { cursor: pointer; color: var(--text-2); font-weight: 600; }
.agent-tool-item { margin-top: 6px; }
.agent-tool-name { display: flex; justify-content: space-between; gap: 8px; color: var(--text-1); }
.agent-tool-summary { color: var(--text-2); overflow-wrap: anywhere; }
.agent-tool-args {
  margin: 4px 0 0;
  max-height: 120px;
  overflow: auto;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-tool-result {
  margin: 4px 0 0;
  max-height: 180px;
  overflow: auto;
  padding: 6px 7px;
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-2);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-tool-failed { color: var(--danger, #ef4444); }

.agent-message-status {
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
  color: var(--danger, #ef4444);
  font-size: 11.5px;
}
.agent-message-error { display: block; margin-top: 2px; color: var(--text-2); overflow-wrap: anywhere; }

.agent-dock-foot {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
}
.agent-input {
  width: 100%;
  resize: none;
  font-size: 12.5px;
  line-height: 1.6;
}
.agent-foot-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.agent-char-count { font-size: 10.5px; }
.agent-foot-row .btn:last-child { margin-left: auto; }

@media (max-width: 640px) {
  .agent-dock {
    top: 64px;
    right: 8px;
    left: 8px;
    width: auto !important;
    min-width: 0;
    max-width: none;
  }
  .agent-dock-trigger { right: 16px; bottom: 16px; }
}
</style>
