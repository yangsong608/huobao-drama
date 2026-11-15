<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog" style="width: min(560px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('video.createDialog.title')">
      <div class="dialog-head">
        <div>
          <h2 class="dialog-title">
            <Clapperboard :size="16" :stroke-width="1.8" />
            {{ t('video.createDialog.title') }}
          </h2>
          <p class="dialog-sub">{{ t('video.createDialog.subtitle') }}</p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :aria-label="t('common.close')" @click="close">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>

      <form class="dialog-form" @submit.prevent="submit">
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">{{ t('video.createDialog.titleLabel') }}</span>
            <input
              ref="titleInput"
              v-model.trim="title"
              class="input"
              :placeholder="t('video.createDialog.titlePlaceholder')"
              maxlength="120"
            />
          </label>

          <div class="field">
            <span class="field-label">{{ t('video.createDialog.modeLabel') }}</span>
            <div class="mode-grid">
              <button
                v-for="item in modes"
                :key="item.value"
                type="button"
                class="mode-card"
                :class="{ on: mode === item.value }"
                @click="mode = item.value"
              >
                <span class="mode-card-title">{{ item.label }}</span>
                <span class="mode-card-desc">{{ item.desc }}</span>
                <span class="mode-card-route">{{ t('video.createDialog.routeUsing') }} · {{ routeText(item.value) }}</span>
              </button>
            </div>
          </div>

          <div class="field">
            <span class="field-label">{{ t('video.createDialog.configLabel') }}</span>
            <BaseSelect
              v-if="configOptions.length"
              :model-value="configId ?? ''"
              :options="configOptions"
              :placeholder="t('video.createDialog.configPlaceholder')"
              :searchable="false"
              @update:model-value="changeConfig"
            />
            <p v-else class="config-empty">{{ t('video.createDialog.configMissing') }}</p>
          </div>

          <div class="model-help">
            <span class="model-help-title">{{ t('video.createDialog.modelHelpTitle') }}</span>
            <p><b>H3 FaceSwap</b> · {{ t('video.createDialog.h3FaceSwapDesc') }}</p>
            <p><b>FaceFusion</b> · {{ t('video.createDialog.facefusionDesc') }}</p>
            <p><b>h3-recast / h3-recast-relay</b> · {{ t('video.createDialog.characterDesc') }}</p>
          </div>

          <p v-if="errorText" class="form-error">{{ errorText }}</p>
        </div>

        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="saving" @click="close">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            <Loader2 v-if="saving" :size="13" class="animate-spin" />
            {{ saving ? t('video.createDialog.submitting') : t('video.createDialog.submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clapperboard, Loader2, X } from 'lucide-vue-next'
import { aiConfigAPI, videoAPI } from '~/composables/useApi'
import { useOverlayHistory } from '~/composables/useOverlayHistory'
import { toastError } from '~/composables/useToast'
import { videoSwapRouteText } from '~/utils/video-swap-route'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; created: [project: any] }>()
const { t } = useI18n()

const title = ref('')
const mode = ref<'face' | 'character'>('face')
const saving = ref(false)
const errorText = ref('')
const titleInput = ref<HTMLInputElement>()
const configs = ref<any[]>([])
const configId = ref<number | null>(null)
const route = ref<any>(null)

const modes = computed(() => [
  { value: 'face' as const, label: t('video.mode.face'), desc: t('video.faceIntro') },
  { value: 'character' as const, label: t('video.mode.character'), desc: t('video.characterIntro') },
])
const configOptions = computed(() => configs.value.map(item => ({
  label: item.name || `${item.provider} · ${item.id}`,
  value: item.id,
})))

function routeText(value: 'face' | 'character') {
  if (!configId.value) return t('video.createDialog.routeNoConfig')
  return videoSwapRouteText(t as any, value, route.value?.[value] ?? null)
}

async function loadConfigs() {
  try {
    const list = await aiConfigAPI.list('video-swap')
    configs.value = Array.isArray(list) ? list : []
  } catch {
    configs.value = []
  }
  configId.value = configs.value.find(item => item.is_active !== false)?.id ?? configs.value[0]?.id ?? null
  await loadRoute()
}

async function loadRoute() {
  if (!configId.value) {
    route.value = null
    return
  }
  try {
    route.value = await videoAPI.routePreview(configId.value)
  } catch {
    route.value = null
  }
}

async function changeConfig(value: number | string) {
  configId.value = Number(value) || null
  await loadRoute()
}

const overlay = useOverlayHistory(() => close())

function close() {
  if (saving.value) return
  emit('update:open', false)
  overlay.close()
}

watch(() => props.open, async (open) => {
  if (!open) return
  title.value = ''
  mode.value = 'face'
  errorText.value = ''
  configs.value = []
  configId.value = null
  route.value = null
  overlay.open()
  void loadConfigs()
  await nextTick()
  titleInput.value?.focus()
})

async function submit() {
  if (!title.value.trim()) {
    errorText.value = t('video.createDialog.titleRequired')
    return
  }
  saving.value = true
  errorText.value = ''
  try {
    const project = await videoAPI.create({
      title: title.value.trim(),
      mode: mode.value,
      config_id: configId.value ?? undefined,
    })
    emit('created', project)
    close()
  } catch (error) {
    toastError(error)
    errorText.value = (error as any)?.message || t('video.createDialog.failed')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mode-card {
  display: flex; flex-direction: column; gap: 5px; text-align: left;
  padding: 12px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-1); color: var(--text-2); cursor: pointer;
}
.mode-card:hover { border-color: var(--border-strong); }
.mode-card.on { border-color: var(--accent); background: var(--accent-bg); color: var(--text-0); }
.mode-card-title { font-size: 12.5px; font-weight: 650; color: var(--text-0); }
.mode-card-desc { font-size: 11px; line-height: 1.55; color: var(--text-3); }
.mode-card-route { margin-top: 2px; font-size: 10.5px; line-height: 1.5; color: var(--accent); }
.config-empty { margin: 0; font-size: 11px; color: var(--action-danger); }
.model-help {
  display: grid; gap: 5px; padding: 10px 12px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-0);
}
.model-help-title { font-size: 11.5px; font-weight: 650; color: var(--text-1); }
.model-help p { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--text-3); }
.model-help b { color: var(--text-2); font-weight: 600; }
.dialog-body { max-height: min(68vh, 620px); overflow-y: auto; }
.form-error { margin: 0; color: var(--action-danger); font-size: 12px; }
@media (max-width: 600px) { .mode-grid { grid-template-columns: 1fr; } }
</style>
