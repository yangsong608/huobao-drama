<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  treeVisible?: boolean
}>(), {
  treeVisible: true,
})

const { t } = useI18n()
const railWidth = ref(240)
const inspectorCollapsed = ref(false)
const mobileInspectorOpen = ref(false)

const gridStyle = computed(() => ({
  '--rail-width': `${railWidth.value}px`,
}))

function startResize(event: MouseEvent) {
  const startX = event.clientX
  const startWidth = railWidth.value
  const onMove = (moveEvent: MouseEvent) => {
    railWidth.value = Math.max(200, Math.min(320, startWidth + moveEvent.clientX - startX))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div
    class="novel-workbench"
    :class="{
      'tree-collapsed': !props.treeVisible,
      'inspector-collapsed': inspectorCollapsed,
      'mobile-inspector-open': mobileInspectorOpen,
    }"
    :style="gridStyle"
  >
    <aside v-if="props.treeVisible" class="novel-workbench-rail" aria-label="chapter-tree">
      <slot name="tree" />
      <div
        class="rail-resizer"
        role="separator"
        aria-orientation="vertical"
        @mousedown.prevent="startResize"
      />
    </aside>
    <div class="novel-workbench-main">
      <slot />
    </div>
    <aside class="novel-workbench-inspector" aria-label="inspector">
      <button
        v-if="inspectorCollapsed"
        type="button"
        class="inspector-tab"
        :title="t('novels.workbench.inspectorEmptyTitle')"
        @click="inspectorCollapsed = false"
      >{{ t('novels.workbench.inspectorEmptyTitle') }}</button>
      <template v-else>
        <button
          type="button"
          class="inspector-collapse"
          :aria-label="t('novels.workbench.collapseInspector')"
          :title="t('novels.workbench.collapseInspector')"
          @click="inspectorCollapsed = true"
        >›</button>
        <slot name="inspector" />
      </template>
    </aside>
    <button
      type="button"
      class="mobile-inspector-toggle"
      @click="mobileInspectorOpen = !mobileInspectorOpen"
    >{{ t('novels.workbench.inspectorEmptyTitle') }}</button>
  </div>
</template>

<style scoped>
.novel-workbench {
  position: relative;
  display: grid;
  grid-template-columns: var(--rail-width, 240px) minmax(0, 1fr) var(--inspector-w, 320px);
  min-height: calc(100vh - 280px);
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.novel-workbench.tree-collapsed {
  grid-template-columns: minmax(0, 1fr) var(--inspector-w, 320px);
}
.novel-workbench.inspector-collapsed {
  grid-template-columns: var(--rail-width, 240px) minmax(0, 1fr) 40px;
}
.novel-workbench.tree-collapsed.inspector-collapsed {
  grid-template-columns: minmax(0, 1fr) 40px;
}
.novel-workbench-rail {
  position: relative;
  min-width: 0;
  overflow: auto;
  border-right: 1px solid var(--surface-outline);
}
.rail-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
}
.rail-resizer:hover {
  background: var(--accent-bg);
}
.novel-workbench-main {
  min-width: 0;
}
.novel-workbench-inspector {
  position: relative;
  min-width: 0;
  overflow: auto;
  border-left: 1px solid var(--surface-outline);
}
.inspector-collapse {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.inspector-collapse:hover {
  background: var(--bg-hover);
  color: var(--text-0);
}
.inspector-tab {
  width: 100%;
  height: 100%;
  padding: 12px 0;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: var(--text-meta);
  writing-mode: vertical-rl;
  cursor: pointer;
}
.inspector-tab:hover {
  background: var(--bg-hover);
  color: var(--text-0);
}
.mobile-inspector-toggle {
  display: none;
}
@media (max-width: 960px) {
  .novel-workbench,
  .novel-workbench.tree-collapsed,
  .novel-workbench.inspector-collapsed,
  .novel-workbench.tree-collapsed.inspector-collapsed {
    grid-template-columns: minmax(0, 1fr) var(--inspector-w, 320px);
  }
  .novel-workbench-rail {
    display: none;
  }
}
@media (max-width: 720px) {
  .novel-workbench,
  .novel-workbench.tree-collapsed,
  .novel-workbench.inspector-collapsed,
  .novel-workbench.tree-collapsed.inspector-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .novel-workbench-inspector {
    position: fixed;
    top: var(--topbar-h, 44px);
    right: 0;
    bottom: var(--statusbar-h, 24px);
    z-index: 30;
    width: min(320px, 88vw);
    background: var(--surface-raised);
    transform: translateX(100%);
    transition: transform var(--motion-base, 180ms) var(--ease-out, ease);
  }
  .novel-workbench.mobile-inspector-open .novel-workbench-inspector {
    transform: translateX(0);
  }
  .inspector-collapse {
    display: none;
  }
  .mobile-inspector-toggle {
    display: block;
    position: fixed;
    right: 16px;
    bottom: 40px;
    z-index: 31;
    height: var(--control-sm);
    padding: 0 14px;
    border: 1px solid var(--surface-outline);
    border-radius: var(--radius-pill);
    background: var(--surface-raised);
    color: var(--text-0);
    font-size: var(--text-meta);
    cursor: pointer;
  }
}
</style>
