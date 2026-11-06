<template>
  <Teleport to="body">
    <div v-if="open" class="ed-img-mask" @click.self="$emit('close')">
      <section class="ed-img-picker" role="dialog" :aria-label="t('edit.imagePickerTitle')">
        <header>
          <b>{{ t('edit.imagePickerTitle') }}</b>
          <label class="ed-upload">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              :disabled="uploading"
              hidden
              @change="onUpload"
            />
            <span>{{ uploading ? t('edit.uploading') : t('edit.uploadImage') }}</span>
          </label>
          <button type="button" class="ed-close" @click="$emit('close')">×</button>
        </header>
        <p v-if="error" class="ed-error">{{ error }}</p>
        <div class="ed-img-grid">
          <button
            v-for="img in images"
            :key="img.url"
            type="button"
            class="ed-img-cell"
            :title="img.label"
            @click="emit('insert', img)"
          >
            <img :src="mediaUrl(img.url)" :alt="img.label" loading="lazy" />
            <span>{{ img.label }}</span>
          </button>
        </div>
        <p v-if="!loading && !images.length" class="ed-empty">{{ t('edit.imagePickerEmpty') }}</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { editAPI } from '~/composables/useApi'
import { mediaUrl } from '~/utils/edit-plan'

// 图片选择器：素材来自 GET /edit/media 的 images（上传图片 + 分镜首帧/合成图，后端合并去重）。
// 点击图片只 emit('insert')，插入计划由 EditWorkbench 的命令层负责。
const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  projectId: { type: Number, default: 0 },
})
const emit = defineEmits(['insert', 'close'])
const { t } = useI18n()

const images = ref([])
const loading = ref(false)
const uploading = ref(false)
const error = ref('')

async function loadImages() {
  loading.value = true
  error.value = ''
  try {
    const media = await editAPI.media(props.episodeId)
    images.value = media?.images ?? []
  } catch (cause) {
    error.value = cause?.message || t('edit.actionFailed')
    images.value = []
  } finally {
    loading.value = false
  }
}

async function onUpload(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file) return
  uploading.value = true
  error.value = ''
  try {
    await editAPI.uploadImage(props.episodeId, file)
    await loadImages()
  } catch (cause) {
    error.value = cause?.message || t('edit.actionFailed')
  } finally {
    uploading.value = false
  }
}

watch(() => props.open, (value) => {
  if (value) void loadImages()
})
</script>

<style scoped>
.ed-img-mask {
  position: fixed; inset: 0; z-index: 65; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-img-picker {
  width: 640px; max-width: 100%; max-height: 78vh; overflow: hidden;
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-1); box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-img-picker header { display: flex; align-items: center; gap: 10px; }
.ed-img-picker header b { flex: 1; font-size: 13px; }
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
.ed-img-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px;
}
.ed-img-cell {
  display: flex; flex-direction: column; gap: 5px; padding: 6px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-2);
  cursor: pointer; text-align: left;
}
.ed-img-cell:hover { border-color: var(--accent); }
.ed-img-cell img {
  width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--bg-base);
}
.ed-img-cell span {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--text-2);
}
.ed-empty { margin: 0; padding: 18px 0; text-align: center; font-size: 11px; color: var(--text-3); }
</style>
