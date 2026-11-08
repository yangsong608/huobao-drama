<template>
  <Teleport to="body">
    <div v-if="open" class="ed-tr-mask" @click.self="$emit('close')">
      <section class="ed-tr-picker" role="dialog" :aria-label="t('edit.transitionPickerTitle')">
        <header>
          <b>{{ t('edit.transitionPickerTitle') }}</b>
          <button type="button" class="ed-close" @click="$emit('close')">×</button>
        </header>
        <p class="ed-hint">{{ blocked || t('edit.transitionPickerHint') }}</p>
        <div class="ed-tr-cats" role="tablist">
          <button
            v-for="cat in TRANSITION_CATEGORIES"
            :key="cat.value"
            type="button"
            role="tab"
            :class="{ 'is-on': activeCategory === cat.value }"
            :disabled="Boolean(blocked)"
            @click="activeCategory = cat.value"
          >{{ t(cat.labelKey) }}<i>{{ countOf(cat.value) }}</i></button>
        </div>
        <div class="ed-tr-grid" :class="{ 'is-blocked': Boolean(blocked) }">
          <button
            v-for="option in visibleOptions"
            :key="option.value"
            type="button"
            class="ed-tr-card"
            :class="{ 'is-on': option.value === currentType }"
            :disabled="Boolean(blocked)"
            @click="pick(option.value)"
            @mouseenter="playDemo(option.value)"
            @mouseleave="stopDemo"
            @focus="playDemo(option.value)"
            @blur="stopDemo"
          >
            <span class="ed-tr-demo">
              <span class="ed-tr-b">{{ t('edit.transitionAfter') }}</span>
              <span class="ed-tr-a" :style="demoStyle(option.value)">{{ t('edit.transitionBefore') }}</span>
              <span
                v-if="demo === option.value && demoFlash > 0"
                class="ed-tr-flashline"
                :class="{ 'is-dark': demoType === 'black' }"
                :style="{ opacity: demoFlash }"
              ></span>
            </span>
            <span class="ed-tr-label">{{ t(option.labelKey) }}</span>
          </button>
        </div>
        <footer>
          <span class="ed-tr-dur-label">{{ t('edit.transitionDuration') }}</span>
          <button
            v-for="preset in DURATION_PRESETS"
            :key="preset"
            type="button"
            class="ed-tr-preset"
            :class="{ 'is-on': duration === preset }"
            :disabled="Boolean(blocked)"
            @click="duration = preset"
          >{{ preset / 1000 }}s</button>
          <input
            v-model.number="duration"
            type="range" min="100" max="2000" step="50" :disabled="Boolean(blocked)"
            :aria-label="t('edit.transitionDuration')"
          />
          <b>{{ duration }}ms</b>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import {
  TRANSITION_CATEGORIES,
  transitionsByCategory,
  transitionTypeOption,
  DEFAULT_TRANSITION_MS,
} from '~/utils/edit-transition-types'
import {
  outgoingTransitionStyle,
  whiteFlashOpacity,
  blackFlashOpacity,
} from '~/utils/edit-preview-transition'

// 转场库选择器：分类卡片 + 悬停动效演示 + 时长档。
// 点击卡片只 emit('apply')，目标交界与命令由 EditWorkbench 负责。
const props = defineProps({
  open: { type: Boolean, default: false },
  currentType: { type: String, default: '' },
  durationMs: { type: Number, default: DEFAULT_TRANSITION_MS },
  blocked: { type: String, default: '' },
})
const emit = defineEmits(['apply', 'close'])
const { t } = useI18n()

const DURATION_PRESETS = [500, 1000, 1500, 2000]
const activeCategory = ref('basic')
const duration = ref(DEFAULT_TRANSITION_MS)
const demo = ref('')
const demoType = ref('')
const demoProgress = ref(0)
let demoRaf = 0

watch(() => props.open, (value) => {
  if (!value) {
    stopDemo()
    return
  }
  duration.value = Number(props.durationMs) || DEFAULT_TRANSITION_MS
  const current = transitionTypeOption(props.currentType)
  activeCategory.value = current?.category ?? 'basic'
})

watch(() => props.durationMs, (value) => {
  if (props.open) duration.value = Number(value) || DEFAULT_TRANSITION_MS
})

const visibleOptions = computed(() => transitionsByCategory(activeCategory.value))
function countOf(category) {
  return transitionsByCategory(category).length
}

function pick(type) {
  if (props.blocked) return
  emit('apply', { type, durationMs: Number(duration.value) || DEFAULT_TRANSITION_MS })
}

function playDemo(type) {
  demoType.value = type
  demoProgress.value = 0
  demo.value = type
  cancelAnimationFrame(demoRaf)
  const start = performance.now()
  const step = (now) => {
    if (demo.value !== type) return
    demoProgress.value = Math.min(1, (now - start) / 1100)
    if (demoProgress.value < 1) demoRaf = requestAnimationFrame(step)
  }
  demoRaf = requestAnimationFrame(step)
}

function stopDemo() {
  cancelAnimationFrame(demoRaf)
  demoRaf = 0
  demo.value = ''
  demoType.value = ''
  demoProgress.value = 0
}

function demoStyle(type) {
  if (demo.value !== type) return outgoingTransitionStyle(type, 0)
  return outgoingTransitionStyle(type, demoProgress.value)
}

const demoFlash = computed(() => {
  if (!demo.value) return 0
  const white = whiteFlashOpacity(demoType.value, demoProgress.value)
  if (white > 0) return white
  return blackFlashOpacity(demoType.value, demoProgress.value)
})
</script>

<style scoped>
.ed-tr-mask {
  position: fixed; inset: 0; z-index: 65; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-tr-picker {
  width: 760px; max-width: 100%; max-height: 82vh; overflow: hidden;
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-1); box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-tr-picker header { display: flex; align-items: center; gap: 10px; }
.ed-tr-picker header b { flex: 1; font-size: 13px; }
.ed-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.ed-close {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-close:hover { background: var(--bg-hover); }
.ed-tr-cats { display: flex; flex-wrap: wrap; gap: 6px; }
.ed-tr-cats button {
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 13px;
  background: var(--bg-2); color: var(--text-2); font-size: 11px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
}
.ed-tr-cats button.is-on { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-2)); }
.ed-tr-cats button i { font-style: normal; font-size: 10px; color: var(--text-3); }
.ed-tr-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 10px;
  align-content: start;
}
.ed-tr-grid.is-blocked { opacity: .45; pointer-events: none; }
.ed-tr-card {
  display: flex; flex-direction: column; gap: 5px; padding: 6px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-2);
  cursor: pointer; text-align: left;
}
.ed-tr-card:hover { border-color: var(--accent); }
.ed-tr-card.is-on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-tr-demo {
  position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden;
  display: block;
}
.ed-tr-b, .ed-tr-a {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #fff; pointer-events: none;
}
.ed-tr-b { background: linear-gradient(135deg, #2c6e8f, #1d3f57); }
.ed-tr-a { background: linear-gradient(135deg, #7a4b8f, #3c2457); }
.ed-tr-flashline { position: absolute; inset: 0; background: #fff; pointer-events: none; }
.ed-tr-flashline.is-dark { background: #000; }
.ed-tr-label {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--text-2);
}
.ed-tr-picker footer { display: flex; align-items: center; gap: 8px; }
.ed-tr-dur-label { font-size: 11px; color: var(--text-2); white-space: nowrap; }
.ed-tr-preset {
  height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-2); color: var(--text-2); font-size: 11px; cursor: pointer;
}
.ed-tr-preset.is-on { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-2)); }
.ed-tr-picker footer input[type="range"] { flex: 1; }
.ed-tr-picker footer b { font-size: 11px; color: var(--text-1); min-width: 52px; text-align: right; }
</style>
