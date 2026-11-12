<template>
  <Teleport to="body">
    <div v-if="open" class="geo-overlay" @click.self="$emit('close')">
      <div class="geo-dialog" role="dialog" aria-modal="true" aria-label="场景地理卡">
        <header class="geo-head">
          <div>
            <strong>场景地理卡</strong>
            <span>{{ scene?.location || '未命名场景' }}</span>
          </div>
          <button type="button" class="btn btn-icon btn-sm" @click="$emit('close')">×</button>
        </header>

        <div class="geo-body">
          <p class="geo-hint">用一句话写清桌/窗/门/柜台/入口的位置，以及 A/B 机位和轴线。所有镜头按这张卡拍。</p>

          <label class="field">
            <span class="field-label">俯视布局</span>
            <textarea v-model="form.layout" class="textarea" rows="3" placeholder="例：窗在左墙，门在右墙，长桌居中，柜台在后墙右侧" />
          </label>

          <div class="geo-section">
            <div class="geo-section-head">
              <span class="field-label">地标与屏幕侧</span>
              <button type="button" class="btn btn-sm" @click="addLandmark">添加地标</button>
            </div>
            <div v-for="(landmark, index) in form.landmarks" :key="index" class="geo-landmark-row">
              <input v-model="landmark.name" class="input" placeholder="窗 / 门 / 长桌 / 柜台" />
              <select v-model="landmark.screen_side" class="input">
                <option value="left">画面左</option>
                <option value="right">画面右</option>
                <option value="back">后景</option>
                <option value="center">居中</option>
              </select>
              <button type="button" class="btn btn-sm" @click="removeLandmark(index)">×</button>
            </div>
          </div>

          <div class="geo-grid">
            <label class="field">
              <span class="field-label">机位 A（谁能看到什么）</span>
              <input v-model="form.cameraA" class="input" placeholder="例：过唐奕肩看范仲淹；窗在左" />
            </label>
            <label class="field">
              <span class="field-label">机位 B</span>
              <input v-model="form.cameraB" class="input" placeholder="例：过范仲淹肩看唐奕；匾在右" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">主轴线</span>
            <input v-model="form.axisLine" class="input" placeholder="例：唐奕 ↔ 范仲淹" />
          </label>

          <p v-if="error" class="geo-error">{{ error }}</p>
        </div>

        <footer class="geo-foot">
          <button type="button" class="btn" @click="$emit('close')">取消</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
            <span v-if="saving">保存中…</span>
            <span v-else>保存地理卡</span>
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { planningAPI } from '~/composables/useApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  scene: { type: Object, default: null },
  geography: { type: Object, default: null },
})
const emit = defineEmits(['close', 'saved'])

const form = reactive({
  layout: '',
  axisLine: '',
  cameraA: '',
  cameraB: '',
  landmarks: [],
})
const saving = ref(false)
const error = ref('')

function parseArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function splitNames(value) {
  return String(value || '')
    .split(/[、，,；;]+/)
    .map(name => name.trim())
    .filter(Boolean)
}

function hydrate(geography) {
  form.layout = geography?.layout || ''
  form.axisLine = geography?.axis_line || geography?.axisLine || ''
  const camera = geography?.camera_sides || geography?.cameraSides || {}
  form.cameraA = Array.isArray(camera.A) ? camera.A.join('、') : ''
  form.cameraB = Array.isArray(camera.B) ? camera.B.join('、') : ''
  const landmarks = parseArray(geography?.landmarks)
  form.landmarks = landmarks.length
    ? landmarks.map(item => ({ name: item.name || '', screen_side: item.screen_side || item.screenSide || 'left' }))
    : [
      { name: '窗', screen_side: 'left' },
      { name: '门', screen_side: 'right' },
    ]
  error.value = ''
}

watch(() => [props.open, props.geography], () => {
  if (props.open) hydrate(props.geography)
}, { immediate: true })

function addLandmark() {
  form.landmarks.push({ name: '', screen_side: 'left' })
}
function removeLandmark(index) {
  form.landmarks.splice(index, 1)
}

async function save() {
  if (!props.scene?.id || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const result = await planningAPI.saveSceneGeography(props.scene.id, {
      layout: form.layout,
      landmarks: form.landmarks.filter(item => item.name.trim()),
      camera_sides: { A: splitNames(form.cameraA), B: splitNames(form.cameraB) },
      axis_line: form.axisLine,
    })
    emit('saved', result?.geography || null)
    emit('close')
  } catch (e) {
    error.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.geo-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog, 900);
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, .32);
}
.geo-dialog {
  width: min(620px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.geo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.geo-head div { flex: 1; display: flex; flex-direction: column; }
.geo-head strong { font-size: 13px; }
.geo-head span { font-size: 11px; color: var(--text-3); }
.geo-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  overflow: auto;
}
.geo-hint { margin: 0; font-size: 10.5px; color: var(--text-3); line-height: 1.5; }
.geo-section { display: flex; flex-direction: column; gap: 6px; }
.geo-section-head { display: flex; align-items: center; gap: 8px; }
.geo-section-head .field-label { flex: 1; }
.geo-landmark-row { display: grid; grid-template-columns: minmax(0, 1fr) 108px 28px; gap: 6px; }
.geo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.geo-error { margin: 0; font-size: 11px; color: var(--danger); }
.geo-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
@media (max-width: 560px) {
  .geo-grid { grid-template-columns: 1fr; }
  .geo-landmark-row { grid-template-columns: minmax(0, 1fr) 92px 28px; }
}
</style>
