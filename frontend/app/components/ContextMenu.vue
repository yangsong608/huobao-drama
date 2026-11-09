<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface MenuItem {
  key: string
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  reason?: string
  separator?: boolean
  action?: () => void | Promise<void>
}

const props = defineProps<{ show: boolean; x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()
const root = ref<HTMLElement | null>(null)
const active = ref(0)

// 视口夹取：x/y 靠近屏幕边缘时菜单会被推出屏幕外，渲染后按实际尺寸往回收（Task 6 遗留裁决）
const posX = ref(props.x)
const posY = ref(props.y)
const VIEWPORT_MARGIN = 8

async function clampPosition() {
  posX.value = props.x
  posY.value = props.y
  if (!props.show) return
  await nextTick()
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
  posX.value = Math.min(Math.max(props.x, VIEWPORT_MARGIN), maxX)
  posY.value = Math.min(Math.max(props.y, VIEWPORT_MARGIN), maxY)
}

watch(() => [props.show, props.x, props.y] as const, clampPosition)
onMounted(clampPosition)

function close() { emit('update:show', false) }
function run(item: MenuItem) {
  if (item.disabled || !item.action) return
  close()
  void item.action()
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') return close()
  if (event.key === 'ArrowDown') { event.preventDefault(); active.value = (active.value + 1) % props.items.length }
  if (event.key === 'ArrowUp') { event.preventDefault(); active.value = (active.value - 1 + props.items.length) % props.items.length }
  if (event.key === 'Enter') { event.preventDefault(); const item = props.items[active.value]; if (item) run(item) }
}
function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
})
watch(() => props.show, async (show) => {
  if (show) { active.value = 0; await nextTick() }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="show" ref="root" class="context-menu" :style="{ left: `${posX}px`, top: `${posY}px` }" role="menu">
      <template v-for="(item, index) in items" :key="item.key">
        <div v-if="item.separator" class="separator" />
        <button
          v-else
          type="button"
          class="item"
          :class="{ danger: item.danger, active: index === active, disabled: item.disabled }"
          :title="item.disabled ? item.reason : ''"
          :disabled="item.disabled"
          @mouseenter="active = index"
          @click="run(item)"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 150px;
  padding: 4px;
  background: var(--bg-elev, #fff);
  border: 1px solid var(--border, #e0e0e0);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text, #333);
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.item.active { background: var(--bg-hover, rgba(0, 0, 0, 0.06)); }
.item.danger { color: #e5484d; }
.item.disabled { opacity: 0.45; cursor: not-allowed; }
.shortcut { font-size: 11px; color: var(--text-dim, #999); }
.separator { height: 1px; margin: 4px 6px; background: var(--border, #e0e0e0); }

/* 粗指针：限制在可视视口内滚动，菜单项放大到可触控尺寸；桌面默认分支不变 */
@media (hover: none) and (pointer: coarse) {
  .context-menu {
    max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .item {
    min-height: 44px;
    padding: 10px 14px;
    font-size: 14px;
  }
  .shortcut {
    display: none;
  }
}
</style>
