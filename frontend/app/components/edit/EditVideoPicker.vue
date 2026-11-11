<template>
  <Teleport to="body">
    <div v-if="open" class="ed-vid-mask" @click.self="$emit('close')">
      <section class="ed-vid-picker" role="dialog" :aria-label="t('edit.videoPickerTitle')">
        <header>
          <b>{{ t('edit.videoPickerTitle') }}</b>
          <label class="ed-upload">
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v"
              :disabled="uploading || probeBlocked"
              hidden
              @change="onUpload"
            />
            <span>{{ uploading ? t('edit.uploading') : t('edit.uploadVideo') }}</span>
          </label>
          <button v-if="uploading" type="button" class="ed-cancel" @click="cancelUpload">{{ t('common.cancel') }}</button>
          <button type="button" class="ed-close" @click="$emit('close')">×</button>
        </header>
        <MediaCapabilityNotice v-if="probeBlocked" action="probe" mode="inline" />
        <p v-if="uploading" class="ed-progress" role="status">{{ uploadProgress }}%</p>
        <p class="ed-hint">{{ t('edit.insertVideoNote') }}</p>
        <p v-if="error" class="ed-error">{{ error }}</p>
        <div class="ed-vid-grid">
          <button
            v-for="item in items"
            :key="item.key"
            type="button"
            class="ed-vid-cell"
            :title="item.label"
            @click="emit('insert', item)"
          >
            <span class="ed-vid-thumb">
              <img v-if="item.thumbnail" :src="mediaUrl(item.thumbnail)" :alt="item.label" loading="lazy" />
              <Film v-else :size="20" />
              <i v-if="item.durationMs">{{ formatPrecise(item.durationMs) }}</i>
            </span>
            <span class="ed-vid-label">{{ item.label }}</span>
          </button>
        </div>
        <p v-if="!loading && !items.length" class="ed-empty">{{ t('edit.videoPickerEmpty') }}</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Film } from 'lucide-vue-next'
import { editAPI } from '~/composables/useApi'
import { mediaUrl } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'
import { checkUploadFile, uploadErrorKey } from '~/utils/upload-guard'
import MediaCapabilityNotice from '~/components/MediaCapabilityNotice.vue'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'

// 视频选择器：分镜视频 + 项目 edit/assets 已上传视频。
// 点击只 emit('insert')，插入位置与命令由 EditWorkbench 负责。
const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  projectId: { type: Number, default: 0 },
})
const emit = defineEmits(['insert', 'close'])
const { t } = useI18n()

const storyboards = ref([])
const videos = ref([])
const loading = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const error = ref('')
const mediaCaps = useMediaCapabilities()
const probeBlocked = computed(() => !mediaCaps.probeReady.value)
let uploadAbort = null

const items = computed(() => {
  const fromStoryboards = storyboards.value
    .filter((row) => row?.playable && row?.source)
    .map((row) => ({
      key: `sb-${row.id}`,
      label: row.title || row.source.label || `#${row.number}`,
      thumbnail: row.thumbnail_url || '',
      durationMs: Number(row.source.durationMs) || 0,
      source: row.source,
    }))
  const fromUploads = videos.value
    .filter((row) => row?.source)
    .map((row) => ({
      key: `up-${row.url}`,
      label: row.label || row.source.label || row.url,
      thumbnail: '',
      durationMs: Number(row.source.durationMs) || 0,
      source: row.source,
    }))
  return [...fromStoryboards, ...fromUploads]
})

async function loadSources() {
  loading.value = true
  error.value = ''
  try {
    const media = await editAPI.media(props.episodeId)
    storyboards.value = media?.storyboards ?? []
    videos.value = media?.videos ?? []
  } catch (cause) {
    error.value = cause?.message || t('edit.actionFailed')
    storyboards.value = []
    videos.value = []
  } finally {
    loading.value = false
  }
}

async function onUpload(event) {
  if (probeBlocked.value) {
    error.value = t('media.capability.probeDisabled')
    return
  }
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    error.value = t('tablet.status.needServer')
    return
  }
  const check = checkUploadFile(file, 'video')
  if (!check.ok) {
    error.value = t(uploadErrorKey(check, 'video'))
    return
  }
  uploading.value = true
  uploadProgress.value = 0
  error.value = ''
  const controller = new AbortController()
  uploadAbort = controller
  try {
    await editAPI.uploadVideo(props.episodeId, file, {
      signal: controller.signal,
      onProgress: (percent) => { uploadProgress.value = percent },
    })
    await loadSources()
  } catch (cause) {
    // 用户取消是正常路径，保持静默
    if (cause?.name !== 'AbortError') error.value = cause?.message || t('edit.actionFailed')
  } finally {
    uploadAbort = null
    uploading.value = false
    uploadProgress.value = 0
  }
}

function cancelUpload() {
  uploadAbort?.abort()
}

watch(() => props.open, (value) => {
  if (value) void loadSources()
})
</script>

<style scoped>
.ed-vid-mask {
  position: fixed; inset: 0; z-index: 65; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-vid-picker {
  width: 680px; max-width: 100%; max-height: 78vh; overflow: hidden;
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-1); box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-vid-picker header { display: flex; align-items: center; gap: 10px; }
.ed-vid-picker header b { flex: 1; font-size: 13px; }
.ed-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.ed-close {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-close:hover { background: var(--bg-hover); }
.ed-upload {
  height: 28px; padding: 0 10px; display: inline-flex; align-items: center;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2);
  color: var(--text-1); font-size: 11px; cursor: pointer; white-space: nowrap;
}
.ed-upload:hover { border-color: var(--accent); }
.ed-upload:has(input:disabled) { opacity: .5; cursor: wait; }
.ed-error {
  margin: 0; padding: 6px 9px; border-radius: 7px; font-size: 11px;
  background: color-mix(in srgb, var(--action-danger) 10%, var(--bg-1)); color: var(--action-danger);
}
.ed-progress { margin: 0; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ed-cancel {
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-1); font-size: 11px; cursor: pointer; white-space: nowrap;
}
.ed-vid-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px;
}
.ed-vid-cell {
  display: flex; flex-direction: column; gap: 5px; padding: 6px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-2);
  cursor: pointer; text-align: left;
}
.ed-vid-cell:hover { border-color: var(--accent); }
.ed-vid-thumb {
  position: relative; width: 100%; aspect-ratio: 16 / 9; display: flex;
  align-items: center; justify-content: center; border-radius: 6px;
  background: var(--bg-base); color: var(--text-3); overflow: hidden;
}
.ed-vid-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ed-vid-thumb i {
  position: absolute; right: 5px; bottom: 4px; padding: 1px 5px; border-radius: 4px;
  background: rgba(0, 0, 0, .6); color: #fff; font-size: 10px; font-style: normal;
}
.ed-vid-label {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--text-2);
}
.ed-empty { margin: 0; padding: 18px 0; text-align: center; font-size: 11px; color: var(--text-3); }

/* 平板：上传/取消/关闭至少 44×44，避免误触 */
@media (max-width: 1180px) {
  .ed-upload,
  .ed-cancel { height: 44px; min-width: 44px; padding: 0 14px; }
  .ed-close { width: 44px; height: 44px; }
}
</style>