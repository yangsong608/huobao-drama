<script setup lang="ts">
import { AudioWaveform, Loader2, Play, Trash2, Plus, Upload } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { checkUploadFile, uploadErrorKey } from '~/utils/upload-guard'

const props = defineProps<{
  separation: { status?: string; progress?: number; step?: string; error?: string } | null
  assets: { id: number; kind: string; durationMs?: number; url?: string; metadataJson?: string | null }[]
  busy?: boolean
}>()
const emit = defineEmits<{
  (e: 'separate', force: boolean): void
  (e: 'cancel-separation'): void
  (e: 'insert-asset', asset: any): void
  (e: 'remove-asset', asset: any): void
  (e: 'preview-asset', asset: any): void
  (e: 'import-audio', file: File): void
}>()
const { t } = useI18n()
const importInput = ref<HTMLInputElement | null>(null)

const SOUNDSCAPE_CATEGORY_KEYS: Record<string, string> = {
  ambience: 'SoundscapeAmbience',
  sfx: 'SoundscapeSfx',
  crowd: 'SoundscapeCrowd',
  bgm: 'SoundscapeBgm',
}

function soundscapeMeta(asset: { kind: string; metadataJson?: string | null }): Record<string, unknown> | null {
  if (asset.kind !== 'soundscape') return null
  try { return JSON.parse(asset.metadataJson || '{}') } catch { return null }
}

function assetLabel(asset: { kind: string; metadataJson?: string | null }): string {
  if (asset.kind === 'soundscape') {
    const category = soundscapeMeta(asset)?.category
    const key = typeof category === 'string' ? SOUNDSCAPE_CATEGORY_KEYS[category] : undefined
    return key ? t(`mix.assetKind${key}`) : t('mix.assetKindSoundscape')
  }
  if (asset.kind !== 'import') return t(`mix.assetKind${asset.kind}`)
  try {
    const name = JSON.parse(asset.metadataJson || '{}')?.name
    if (typeof name === 'string' && name) return name
  } catch {}
  return t('mix.assetKindImport')
}

function assetTitle(asset: { kind: string; metadataJson?: string | null }): string {
  const prompt = soundscapeMeta(asset)?.prompt
  return typeof prompt === 'string' && prompt ? prompt : assetLabel(asset)
}

const PAGE_SIZE = 8
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(props.assets.length / PAGE_SIZE)))
const pagedAssets = computed(() => props.assets.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
watch(() => props.assets.length, () => {
  if (page.value > pageCount.value) page.value = pageCount.value
})

function openImportPicker() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    toast.error(t('tablet.status.needServer'))
    return
  }
  importInput.value?.click()
}

function onImportChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const check = checkUploadFile(file, 'audio')
  if (!check.ok) {
    toast.error(t(uploadErrorKey(check, 'audio')))
    return
  }
  emit('import-audio', file)
}
</script>

<template>
  <section class="mx-card stem-library">
    <div class="mx-card-head">
      <span class="mx-chip">{{ t('mix.stems.title') }}</span>
      <span class="mx-muted">{{ assets.length }}</span>
    </div>
    <!-- 文案锚点：提取声音素材；提取不会自动改变当前混音 -->
    <p class="mx-hint">{{ t('mix.stems.intro') }}</p>
    <div v-if="separation?.status === 'running'" class="mx-stem-progress">
      <div class="mx-mini-bar"><span :style="{ width: `${separation.progress || 0}%` }" /></div>
      <span>{{ separation.step || t('mix.separationPreparing') }} · {{ separation.progress || 0 }}%</span>
      <button class="mx-btn is-plain" type="button" @click="emit('cancel-separation')">{{ t('mix.separationCancel') }}</button>
    </div>
    <p v-else-if="separation?.status === 'failed'" class="mx-note is-danger">
      {{ separation.error || t('mix.separationFailedHint') }}
    </p>
    <button class="mx-btn" type="button" :disabled="busy || separation?.status === 'running'" @click="emit('separate', Boolean(assets.length))">
      <AudioWaveform :size="12" />
      {{ t('mix.stems.extract') }}
    </button>
    <button class="mx-btn is-plain" type="button" :disabled="busy" @click="openImportPicker">
      <Upload :size="12" />
      {{ t('mix.stems.importAudio') }}
    </button>
    <input ref="importInput" type="file" accept=".mp3,.wav,.m4a,.aac" class="mx-import-input" @change="onImportChange">
    <ul v-if="assets.length" class="mx-stem-list">
      <li v-for="asset in pagedAssets" :key="asset.id">
        <span :title="assetTitle(asset)">{{ assetLabel(asset) }}</span>
        <span class="mx-muted">{{ Math.round((asset.durationMs || 0) / 1000) }}s</span>
        <button class="mx-icon" type="button" @click="emit('preview-asset', asset)"><Play :size="12" /></button>
        <button class="mx-icon" type="button" @click="emit('insert-asset', asset)"><Plus :size="12" /></button>
        <button class="mx-icon is-danger" type="button" @click="emit('remove-asset', asset)"><Trash2 :size="12" /></button>
      </li>
    </ul>
    <div v-if="pageCount > 1" class="mx-stem-pager">
      <button class="mx-icon" type="button" :disabled="page <= 1" @click="page -= 1">{{ t('mix.stems.prevPage') }}</button>
      <span class="mx-muted">{{ t('mix.stems.pageInfo', { x: page, y: pageCount }) }}</span>
      <button class="mx-icon" type="button" :disabled="page >= pageCount" @click="page += 1">{{ t('mix.stems.nextPage') }}</button>
    </div>
  </section>
</template>

<style scoped>
/* 样式复用检查器的 .mx-* 视觉语言；插槽内容取不到检查器 scoped 样式，这里按同值复制 */
.mx-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-0); }
.mx-card-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.mx-chip { padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 9px; line-height: 15px; color: var(--text-2); white-space: nowrap; }
.mx-muted { margin-left: auto; font-size: 9.5px; color: var(--text-3); }
.mx-mini-bar { height: 4px; border-radius: 2px; background: var(--bg-3); overflow: hidden; flex: 1; min-width: 60px; }
.mx-mini-bar span { display: block; height: 100%; background: var(--accent); transition: width .2s ease; }
.mx-note { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 10px; line-height: 1.5; }
.mx-note.is-danger { background: var(--action-danger-bg); color: var(--action-danger); }
.mx-hint { margin: 0; font-size: 9.5px; line-height: 1.5; color: var(--text-3); }
.mx-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 1px solid var(--accent); border-radius: 5px; background: var(--accent); color: var(--action-primary-text); font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; }
.mx-btn.is-plain { border-color: var(--border); background: var(--bg-1); color: var(--text-1); }
.mx-btn.is-plain:hover { border-color: var(--accent); color: var(--accent-text); }
.mx-btn:disabled { opacity: .45; cursor: default; }
.mx-icon { display: inline-flex; align-items: center; justify-content: center; width: 21px; height: 21px; padding: 0; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); color: var(--text-2); cursor: pointer; }
.mx-icon:hover { color: var(--accent-text); border-color: var(--accent); }
.mx-icon.is-danger { color: var(--action-danger); }
/* 新增类仅做布局 */
.mx-stem-progress { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 9.5px; color: var(--text-2); }
.mx-stem-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mx-stem-list li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); font-size: 10px; color: var(--text-1); }
.mx-stem-list li > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mx-stem-pager { display: flex; align-items: center; gap: 6px; font-size: 9.5px; }
.mx-stem-pager .mx-icon { width: auto; padding: 0 6px; height: 20px; font-size: 9.5px; }
.mx-stem-pager .mx-muted { margin-left: 0; }
.mx-import-input { display: none; }
</style>
