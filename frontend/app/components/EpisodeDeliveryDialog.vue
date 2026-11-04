<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog delivery-dialog">
      <div class="dialog-head">
        <div class="dialog-head-copy">
          <div class="dialog-title">{{ t('delivery.title') }}</div>
          <div class="dialog-desc">{{ t('delivery.desc') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto dialog-close" @click="close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="dialog-body">
        <div class="delivery-toolbar">
          <button class="btn" :disabled="loading" @click="load">{{ loading ? t('common.loading') : t('delivery.refresh') }}</button>
          <button class="btn btn-primary" :disabled="rendering" @click="renderMotion">
            {{ rendering ? t('delivery.rendering') : t('delivery.renderMotion') }}
          </button>
          <span class="field-hint">{{ t('delivery.renderHint') }}</span>
        </div>

        <p v-if="!loading && !versions.length" class="delivery-empty">{{ t('delivery.empty') }}</p>

        <div v-else class="delivery-list">
          <article v-for="v in versions" :key="v.id" :class="['delivery-item', { 'is-current': isCurrent(v) }]">
            <div class="delivery-item-head">
              <span :class="['tag', kindClass(v.kind)]">{{ kindLabel(v.kind) }}</span>
              <span class="delivery-name">{{ versionName(v) }}</span>
              <span v-if="isCurrent(v)" class="tag tag-accent">{{ t('delivery.current') }}</span>
              <span v-if="v.status && v.status !== 'completed'" class="tag">{{ v.status }}</span>
            </div>
            <div class="delivery-item-meta mono">
              <span v-if="v.duration">{{ v.duration }}s</span>
              <span v-if="v.createdAt || v.created_at">{{ formatTime(v.createdAt || v.created_at) }}</span>
              <span v-if="v.subtitleUrl || v.subtitle_url">{{ t('delivery.withSubtitle') }}</span>
            </div>
            <div class="delivery-item-actions">
              <a v-if="v.mergedUrl || v.merged_url" class="btn btn-sm" :href="urlOf(v.mergedUrl || v.merged_url)" target="_blank" rel="noreferrer">{{ t('delivery.play') }}</a>
              <a v-if="v.mergedUrl || v.merged_url" class="btn btn-sm" :href="urlOf(v.mergedUrl || v.merged_url)" :download="downloadName(v)">{{ t('delivery.download') }}</a>
              <a v-if="v.subtitleUrl || v.subtitle_url" class="btn btn-sm" :href="urlOf(v.subtitleUrl || v.subtitle_url)" target="_blank" rel="noreferrer">SRT</a>
              <a v-if="assUrlOf(v)" class="btn btn-sm" :href="urlOf(assUrlOf(v))" target="_blank" rel="noreferrer">ASS</a>
              <button v-if="!isCurrent(v)" class="btn btn-sm" :disabled="switching === v.id" @click="setCurrent(v)">
                {{ switching === v.id ? t('delivery.switching') : t('delivery.setCurrent') }}
              </button>
            </div>
          </article>
        </div>
      </div>

      <div class="dialog-foot">
        <span class="dialog-foot-copy">{{ t('delivery.foot') }}</span>
        <button class="btn" @click="close">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { mergeAPI, dubbingAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps<{
  open: boolean
  episodeId: number | null
  currentVideo?: string | null
}>()
const emit = defineEmits<{ close: []; updated: [] }>()
const { t } = useI18n()

const loading = ref(false)
const rendering = ref(false)
const switching = ref<number | null>(null)
const versions = ref<any[]>([])

watch(() => props.open, (value) => { if (value) load() })

function urlOf(raw: string | null | undefined) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}
/** ASS 路径记录在 mix_options JSON 里（兼容后端直出的 subtitleAssUrl 字段） */
function assUrlOf(v: any): string | null {
  const direct = v?.subtitleAssUrl || v?.subtitle_ass_url
  if (direct) return direct
  const raw = v?.mixOptions || v?.mix_options
  if (!raw) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed?.subtitleAssUrl || parsed?.subtitle_ass_url || null
  } catch {
    return null
  }
}
function kindLabel(kind: string) {
  const map: Record<string, string> = {
    concat: t('delivery.kindConcat'),
    mix: t('delivery.kindMix'),
    motion: t('delivery.kindMotion'),
  }
  return map[kind] || t('delivery.kindConcat')
}
function kindClass(kind: string) {
  return kind === 'mix' ? 'tag-accent' : kind === 'motion' ? 'tag-warn' : ''
}
function versionName(v: any) {
  const raw = v.createdAt || v.created_at || ''
  return raw ? formatTime(raw) : `#${v.id}`
}
function formatTime(raw: string) {
  if (!raw) return ''
  const date = new Date(String(raw).includes('T') ? raw : String(raw).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return raw
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function isCurrent(v: any) {
  const url = v.mergedUrl || v.merged_url
  return Boolean(url && props.currentVideo && String(props.currentVideo).replace(/^\//, '') === String(url).replace(/^\//, ''))
}
function downloadName(v: any) {
  return `episode-${props.episodeId}-${v.kind || 'video'}-${v.id}.mp4`
}

async function load() {
  if (!props.episodeId) return
  loading.value = true
  try {
    const list = await mergeAPI.list(props.episodeId)
    versions.value = Array.isArray(list) ? list : []
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

async function renderMotion() {
  if (!props.episodeId || rendering.value) return
  if (!window.confirm(t('delivery.renderConfirm'))) return
  rendering.value = true
  try {
    await dubbingAPI.motionPost(props.episodeId, {})
    toast.success(t('delivery.renderDone'))
    await load()
    emit('updated')
  } catch (error) {
    toastError(error)
  } finally {
    rendering.value = false
  }
}

async function setCurrent(v: any) {
  if (!props.episodeId) return
  switching.value = v.id
  try {
    await dubbingAPI.setVersion(props.episodeId, v.id)
    toast.success(t('delivery.switched'))
    emit('updated')
    await load()
  } catch (error) {
    toastError(error)
  } finally {
    switching.value = null
  }
}

function close() { emit('close') }
</script>

<style scoped>
.delivery-dialog { width: min(860px, 94vw); max-height: 88vh; }
.delivery-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.delivery-empty { color: var(--text-3); font-size: 12px; padding: 24px; text-align: center; }
.delivery-list { display: flex; flex-direction: column; gap: 10px; }
.delivery-item { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.delivery-item.is-current { border-color: var(--action-primary); background: color-mix(in srgb, var(--action-primary) 5%, transparent); }
.delivery-item-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.delivery-name { font-size: 12px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.delivery-item-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-3); }
.delivery-item-actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
