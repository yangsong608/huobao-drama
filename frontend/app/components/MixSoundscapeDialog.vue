<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog ss-dialog" role="dialog" aria-modal="true" :aria-label="t('mix.soundscape.title')">
        <div class="dialog-head">
          <div class="ss-head-text">
            <h2 class="dialog-title">{{ t('mix.soundscape.title') }}</h2>
            <p class="ss-sub">{{ t('mix.soundscape.subtitle') }}</p>
          </div>
          <button class="ss-close" type="button" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="15" />
          </button>
        </div>

        <div class="dialog-body ss-body">
          <section class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.modeLabel') }}</span>
            <div class="ss-seg">
              <button
                v-for="mode in MODES"
                :key="mode.value"
                type="button"
                :class="{ on: form.mode === mode.value }"
                @click="form.mode = mode.value"
              >
                {{ t(`mix.soundscape.mode.${mode.key}`) }}
              </button>
            </div>
            <p class="ss-hint">{{ t(`mix.soundscape.modeHint.${modeKey(form.mode)}`) }}</p>
          </section>

          <section class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.categoriesLabel') }}</span>
            <div class="ss-checks">
              <label
                v-for="category in CATEGORIES"
                :key="category"
                class="ss-check"
                :class="{ on: form.categories.includes(category) }"
              >
                <input
                  type="checkbox"
                  :checked="form.categories.includes(category)"
                  @change="toggleCategory(category)"
                />
                <span class="ss-dot" :style="{ background: CATEGORY_COLORS[category] }" />
                {{ t(`mix.soundscape.categories.${category}`) }}
              </label>
            </div>
            <p v-if="!form.categories.length" class="ss-hint is-warn">
              {{ t('mix.soundscape.categoryRequired') }}
            </p>
          </section>

          <section v-if="form.categories.includes('crowd')" class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.crowdModeLabel') }}</span>
            <div class="ss-seg">
              <button
                type="button"
                :class="{ on: form.crowdMode === 'walla' }"
                @click="form.crowdMode = 'walla'"
              >
                {{ t('mix.soundscape.crowdMode.walla') }}
              </button>
              <button
                type="button"
                :class="{ on: form.crowdMode === 'lines' }"
                @click="form.crowdMode = 'lines'"
              >
                {{ t('mix.soundscape.crowdMode.lines') }}
              </button>
            </div>
            <p class="ss-hint">{{ t(`mix.soundscape.crowdModeHint.${form.crowdMode}`) }}</p>
          </section>

          <section v-if="hintCategories.length" class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.hints.label') }}</span>
            <p class="ss-hint">{{ t('mix.soundscape.hints.hint') }}</p>
            <div v-for="category in hintCategories" :key="category" class="ss-hint-row">
              <span class="ss-hint-name">
                <span class="ss-dot" :style="{ background: CATEGORY_COLORS[category] }" />
                {{ t(`mix.soundscape.categories.${category}`) }}
              </span>
              <textarea
                v-model="hintDraft[category]"
                rows="2"
                spellcheck="false"
                maxlength="2000"
                :placeholder="t(`mix.soundscape.hints.placeholder.${category}`)"
              />
            </div>
          </section>

          <section class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.secondsLabel') }}</span>
            <p class="ss-hint">{{ t('mix.soundscape.secondsHint') }}</p>
            <div class="ss-duration-grid">
              <label v-for="category in form.categories" :key="category" class="ss-duration">
                <span class="ss-hint-name">
                  <span class="ss-dot" :style="{ background: CATEGORY_COLORS[category] }" />
                  {{ t(`mix.soundscape.categories.${category}`) }}
                </span>
                <span class="ss-duration-input">
                  <input
                    v-model.number="durationDraft[category]"
                    type="number"
                    :min="DURATION_RANGES[category][0]"
                    :max="DURATION_RANGES[category][1]"
                    step="1"
                    :disabled="!preview"
                  />
                  <i>s</i>
                </span>
              </label>
            </div>
          </section>

          <section v-if="form.mode === 'scenes'" class="ss-section">
            <div class="ss-row">
              <span class="ss-label">{{ t('mix.soundscape.sceneScope') }}</span>
              <label class="ss-switch">
                <input v-model="allScenes" type="checkbox" />
                <span>{{ t('mix.soundscape.allScenes') }}</span>
              </label>
            </div>
            <div v-if="!allScenes" class="ss-scenes">
              <label
                v-for="(scene, index) in scenes"
                :key="scene.id"
                class="ss-scene"
                :class="{ on: form.sceneIds.includes(scene.id) }"
              >
                <input v-model="form.sceneIds" type="checkbox" :value="scene.id" />
                <b>{{ t('mix.soundscape.sceneLabel', { n: index + 1 }) }}</b>
                <span>{{ scene.location || '-' }} · {{ scene.time || '-' }}</span>
              </label>
              <p v-if="sceneLoading" class="ss-hint">{{ t('common.loading') }}</p>
              <p v-else-if="!scenes.length" class="ss-hint is-warn">{{ t('mix.soundscape.noScenes') }}</p>
            </div>
            <p v-if="!allScenes && !form.sceneIds.length" class="ss-hint is-warn">
              {{ t('mix.soundscape.sceneRequired') }}
            </p>
          </section>

          <section class="ss-section ss-row">
            <div>
              <span class="ss-label">{{ t('mix.soundscape.overwrite') }}</span>
              <p class="ss-hint">{{ t('mix.soundscape.overwriteHint') }}</p>
            </div>
            <label class="ss-switch">
              <input v-model="form.overwrite" type="checkbox" />
            </label>
          </section>

          <section v-if="preview" class="ss-preview">
            <div class="ss-preview-head">
              <b>{{ t('mix.soundscape.previewTitle') }}</b>
              <span>
                {{ t('mix.soundscape.previewCount', { n: preview.counts.total }) }}
                · {{ t('mix.soundscape.estimated', { s: preview.estimatedSeconds }) }}
              </span>
            </div>
            <p v-if="preview.degraded" class="ss-warn">{{ t('mix.soundscape.degraded') }}</p>
            <ul v-if="preview.warnings.length" class="ss-warn-list">
              <li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li>
            </ul>
            <details class="ss-prompts">
              <summary>{{ t('mix.soundscape.prompts', { n: preview.items.length }) }}</summary>
              <div v-for="item in preview.items" :key="item.itemId" class="ss-prompt">
                <div class="ss-prompt-head">
                  <b>{{ t(`mix.soundscape.categories.${item.category}`) }} · {{ itemLabel(item) }}</b>
                  <span>{{ item.seconds }}s</span>
                </div>
                <textarea
                  v-if="item.source === 'generate'"
                  v-model="promptDraft[item.itemId]"
                  rows="2"
                  spellcheck="false"
                  maxlength="2000"
                  :placeholder="t('mix.soundscape.promptPlaceholder')"
                  @input="promptDirty[item.itemId] = true"
                />
                <p v-else class="ss-hint">{{ t('mix.soundscape.reuseLine') }}</p>
                <p v-if="item.degraded" class="ss-hint is-warn">{{ t('mix.soundscape.itemDegraded') }}</p>
              </div>
            </details>
          </section>

          <p v-if="error" ref="errorRef" class="ss-error">{{ error }}</p>
        </div>

        <div class="dialog-foot">
          <button class="btn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button class="btn" type="button" :disabled="!canSubmit || previewing || starting" @click="onPreview">
            <Loader2 v-if="previewing" :size="13" class="animate-spin" />
            {{ t('mix.soundscape.preview') }}
          </button>
          <button class="btn btn-primary" type="button" :disabled="!canSubmit || starting" @click="onStart">
            <Loader2 v-if="starting" :size="13" class="animate-spin" />
            {{ t('mix.soundscape.start') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Loader2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import {
  episodeAPI,
  type SoundscapeCategory,
  type SoundscapeCrowdMode,
  type SoundscapeMode,
  type SoundscapeOverride,
  type SoundscapePreview,
  type SoundscapeRequest,
} from '~/composables/useApi'

interface SceneRow {
  id: number
  location?: string | null
  time?: string | null
}

const props = defineProps<{
  open: boolean
  episodeId: number | null
  preview: SoundscapePreview | null
  previewing: boolean
  starting: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  preview: [request: SoundscapeRequest]
  start: [request: SoundscapeRequest]
}>()
const { t } = useI18n()

const MODES: Array<{ value: SoundscapeMode; key: string }> = [
  { value: 'scenes', key: 'scenes' },
  { value: 'episode-bed', key: 'episodeBed' },
  { value: 'assets-only', key: 'assetsOnly' },
]
const CATEGORIES: SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']
const CATEGORY_COLORS: Record<SoundscapeCategory, string> = {
  ambience: '#0ea5e9',
  sfx: '#a78bfa',
  crowd: '#f59e0b',
  bgm: '#22c55e',
}
const DURATION_DEFAULTS: Record<SoundscapeCategory, number> = {
  ambience: 45,
  sfx: 5,
  crowd: 30,
  bgm: 45,
}
const DURATION_RANGES: Record<SoundscapeCategory, readonly [number, number]> = {
  ambience: [30, 45],
  sfx: [2, 10],
  crowd: [20, 45],
  bgm: [30, 45],
}

const form = reactive({
  mode: 'scenes' as SoundscapeMode,
  categories: ['ambience', 'sfx', 'crowd'] as SoundscapeCategory[],
  crowdMode: 'walla' as SoundscapeCrowdMode,
  sceneIds: [] as number[],
  overwrite: false,
})
const allScenes = ref(true)
const scenes = ref<SceneRow[]>([])
const sceneLoading = ref(false)
const promptDraft = reactive<Record<string, string>>({})
// 只有用户改过的提示词才作为覆盖项发送：未编辑的预览草稿必须保持请求不变，
// 否则预览与启动的缓存键不同，Start 会重新编译全部提示词
const promptDirty = reactive<Record<string, boolean>>({})
// 预览前的分类补充描述：直接进入请求，不依赖预览
const hintDraft = reactive<Record<string, string>>({})
// 每类声音的生成时长（秒）：与默认一致时不发送覆盖项，避免破坏预览/启动的缓存键
const durationDraft = reactive<Record<SoundscapeCategory, number>>({ ...DURATION_DEFAULTS })
const errorRef = ref<HTMLElement | null>(null)

const canSubmit = computed(() => (
  form.categories.length > 0
  && (form.mode !== 'scenes' || allScenes.value || form.sceneIds.length > 0)
))

// 群众声台词化模式下由台词编排，无需描述
const hintCategories = computed(() => form.categories.filter((category) => (
  category !== 'crowd' || form.crowdMode === 'walla'
)))

const sceneOrdinal = computed(() => {
  const map = new Map<number, number>()
  scenes.value.forEach((scene, index) => map.set(scene.id, index + 1))
  return map
})

function modeKey(mode: SoundscapeMode): string {
  return MODES.find((item) => item.value === mode)?.key ?? 'scenes'
}

function toggleCategory(category: SoundscapeCategory) {
  const index = form.categories.indexOf(category)
  if (index >= 0) form.categories.splice(index, 1)
  else form.categories.push(category)
}

function resetDrafts() {
  for (const key of Object.keys(promptDraft)) delete promptDraft[key]
  for (const key of Object.keys(promptDirty)) delete promptDirty[key]
}

function syncDrafts(preview: SoundscapePreview | null) {
  if (!preview) {
    resetDrafts()
    return
  }
  const present = new Set(preview.items.map((item) => item.itemId))
  for (const key of Object.keys(promptDraft)) {
    if (!present.has(key)) delete promptDraft[key]
  }
  for (const key of Object.keys(promptDirty)) {
    if (!present.has(key)) delete promptDirty[key]
  }
  for (const item of preview.items) {
    // 用户编辑过的提示词不被新预览覆盖；清空输入视为恢复默认
    if (!promptDirty[item.itemId] || !(promptDraft[item.itemId] ?? '').trim()) {
      delete promptDirty[item.itemId]
      promptDraft[item.itemId] = item.prompt
    }
  }
}

function resetDurations() {
  for (const category of CATEGORIES) durationDraft[category] = DURATION_DEFAULTS[category]
}

// 输入被清空时 v-model.number 会得到 ''，越界值也不可信：统一归一到合法区间
function clampDuration(category: SoundscapeCategory): number {
  const [min, max] = DURATION_RANGES[category]
  const value = Number(durationDraft[category])
  if (!Number.isFinite(value) || value <= 0) return DURATION_DEFAULTS[category]
  return Math.min(max, Math.max(min, Math.round(value)))
}

function resetForm() {
  form.mode = 'scenes'
  form.categories = ['ambience', 'sfx', 'crowd']
  form.crowdMode = 'walla'
  form.sceneIds = []
  form.overwrite = false
  allScenes.value = true
  resetDrafts()
  resetDurations()
  for (const key of Object.keys(hintDraft)) delete hintDraft[key]
  syncDrafts(props.preview)
  void loadScenes()
}

async function loadScenes() {
  if (!props.episodeId) {
    scenes.value = []
    return
  }
  sceneLoading.value = true
  try {
    const rows = await episodeAPI.scenes(props.episodeId)
    scenes.value = (Array.isArray(rows) ? rows : [])
      .slice()
      .sort((a: SceneRow, b: SceneRow) => a.id - b.id)
  } catch {
    scenes.value = []
  } finally {
    sceneLoading.value = false
  }
}

function itemLabel(item: SoundscapePreview['items'][number]): string {
  if (item.sceneId == null) return t('mix.soundscape.wholeEpisode')
  const n = sceneOrdinal.value.get(item.sceneId) ?? item.sceneId
  return t('mix.soundscape.sceneLabel', { n })
}

function buildHints(): Partial<Record<SoundscapeCategory, string>> {
  const hints: Partial<Record<SoundscapeCategory, string>> = {}
  for (const category of hintCategories.value) {
    const text = (hintDraft[category] ?? '').trim()
    if (text) hints[category] = text
  }
  return hints
}

function buildRequest(): SoundscapeRequest {
  const overrides: SoundscapeOverride[] = []
  for (const item of props.preview?.items ?? []) {
    if (item.source !== 'generate') continue
    const prompt = (promptDraft[item.itemId] ?? '').trim()
    // 清空输入表示使用默认提示词：只取消 dirty，不伪造文本
    if (!prompt) {
      delete promptDirty[item.itemId]
      continue
    }
    // 只发送用户编辑过的提示词：未编辑的草稿与预览一致，不需要覆盖项
    if (!promptDirty[item.itemId]) continue
    overrides.push({ itemId: item.itemId, prompt })
  }
  // 与默认一致的时长不发送：保持与提示词覆盖相同的“改了才发”策略
  for (const item of props.preview?.items ?? []) {
    if (item.source !== 'generate') continue
    const seconds = clampDuration(item.category)
    if (seconds === DURATION_DEFAULTS[item.category]) continue
    const existing = overrides.find((override) => override.itemId === item.itemId)
    if (existing) existing.seconds = seconds
    else overrides.push({ itemId: item.itemId, seconds })
  }
  return {
    mode: form.mode,
    categories: [...form.categories],
    crowdMode: form.crowdMode,
    sceneIds: form.mode === 'scenes' && !allScenes.value ? [...form.sceneIds] : [],
    overwrite: form.overwrite,
    overrides,
    categoryHints: buildHints(),
  }
}

function onPreview() {
  if (!canSubmit.value) return
  emit('preview', buildRequest())
}

function onStart() {
  if (!canSubmit.value) return
  emit('start', buildRequest())
}

watch(() => props.open, (open) => {
  if (open) resetForm()
})

watch(() => props.episodeId, () => {
  if (props.open) void loadScenes()
})

watch(() => props.preview, (value) => syncDrafts(value), { immediate: true })

// 错误位于可滚动的主体底部，折叠的提示词列表会把它挤出可视区
watch(() => props.error, async (value) => {
  if (!value) return
  await nextTick()
  errorRef.value?.scrollIntoView({ block: 'nearest' })
})
</script>

<style scoped>
.ss-dialog { width: 640px; max-width: calc(100vw - 48px); }
.ss-head-text { min-width: 0; }
.ss-sub { margin: 2px 0 0; font-size: 11px; color: var(--text-3); }
.ss-close {
  margin-left: auto; display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-2); cursor: pointer;
}
.ss-close:hover { background: var(--bg-3); color: var(--text-0); }
.ss-body { display: flex; flex-direction: column; gap: 18px; max-height: 62vh; }
.ss-section { display: flex; flex-direction: column; gap: 8px; }
.ss-row { flex-direction: row; align-items: center; justify-content: space-between; }
.ss-label { font-size: 11.5px; font-weight: 700; color: var(--text-1); }
.ss-hint { margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--text-3); }
.ss-hint.is-warn { color: var(--warning); }
.ss-error { margin: 0; font-size: 11px; color: var(--action-danger); }
.ss-seg {
  display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px;
  background: var(--bg-3); width: fit-content;
}
.ss-seg button {
  padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--text-2); font-size: 11px;
}
.ss-seg button.on { background: var(--surface-raised); color: var(--text-0); box-shadow: var(--shadow-xs); }
.ss-checks { display: flex; flex-wrap: wrap; gap: 6px; }
.ss-check {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  font-size: 11px; color: var(--text-2); background: var(--bg-2);
}
.ss-check.on { border-color: var(--accent); color: var(--text-0); background: var(--accent-bg); }
.ss-check input { display: none; }
.ss-dot { width: 7px; height: 7px; border-radius: 50%; }
.ss-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); cursor: pointer; }
.ss-switch input { accent-color: var(--accent); }
.ss-scenes {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px; max-height: 180px; overflow-y: auto; padding: 2px;
}
.ss-scene {
  display: flex; flex-direction: column; gap: 2px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  background: var(--bg-2); font-size: 10.5px; color: var(--text-2);
}
.ss-scene.on { border-color: var(--accent); background: var(--accent-bg); color: var(--text-0); }
.ss-scene input { display: none; }
.ss-scene b { font-size: 11px; }
.ss-scene span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-preview {
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2);
}
.ss-preview-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11px; }
.ss-preview-head span { color: var(--text-3); }
.ss-warn { margin: 0; font-size: 10.5px; color: var(--warning); }
.ss-warn-list { margin: 0; padding-left: 16px; font-size: 10.5px; color: var(--warning); }
.ss-prompts summary { cursor: pointer; font-size: 10.5px; color: var(--text-2); }
.ss-prompt { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.ss-prompt:last-child { border-bottom: none; }
.ss-prompt-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 10.5px; }
.ss-prompt-head span { color: var(--text-3); }
.ss-prompt textarea {
  width: 100%; resize: vertical; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-1); color: var(--text-1);
  font-size: 10.5px; line-height: 1.5; font-family: inherit;
}
.ss-hint-row { display: flex; flex-direction: column; gap: 4px; }
.ss-hint-name { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
.ss-hint-row textarea {
  width: 100%; resize: vertical; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-1); color: var(--text-1);
  font-size: 10.5px; line-height: 1.5; font-family: inherit;
}
.ss-duration-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.ss-duration {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2);
}
.ss-duration-input { display: inline-flex; align-items: center; gap: 4px; }
.ss-duration-input input {
  width: 64px; padding: 4px 6px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-1); color: var(--text-1);
  font-size: 11px; font-family: inherit;
}
.ss-duration-input i { font-style: normal; font-size: 10px; color: var(--text-3); }
</style>
