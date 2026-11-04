<template>
  <transition name="fade">
    <div
      v-if="visible && edge"
      class="relation-popover"
      :style="{ left: `${x}px`, top: `${y}px` }"
      @click.stop
    >
      <header class="popover-head">
        <div class="relation-title">
          <span class="node-name">{{ sourceNode?.label || edge.source }}</span>
          <span class="relation-chip" :style="{ background: relationColor }">{{ relationLabel(edge.relationType) }}</span>
          <span class="node-name">{{ targetNode?.label || edge.target }}</span>
        </div>
        <button type="button" class="close-btn" :aria-label="t('novels.compass.sidebar.close')" @click="emit('close')">
          <X :size="14" />
        </button>
      </header>

      <div class="popover-body">
        <p class="relation-strength">{{ t('novels.compass.relationStrength', { n: edge.strength || '-' }) }}</p>
        <p v-if="edge.description" class="relation-desc">{{ edge.description }}</p>
        <div v-if="edge.events?.length" class="relation-events">
          <h4>{{ t('novels.compass.popover.events') }}</h4>
          <ul>
            <li v-for="(event, index) in edge.events" :key="index">
              <span class="event-dot" :style="{ background: relationColor }"></span>
              <span>{{ event }}</span>
            </li>
          </ul>
        </div>
      </div>

      <footer class="popover-foot">{{ t('novels.compass.popover.closeHint') }}</footer>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { RELATION_COLORS, type GraphEdge, type GraphNode } from '~/utils/novel-graph'

const props = defineProps<{
  edge: GraphEdge | null
  allNodes: GraphNode[]
  visible: boolean
  x: number
  y: number
}>()

const emit = defineEmits<{ (event: 'close'): void }>()

const { t } = useI18n()

const sourceNode = computed(() => props.allNodes.find((node) => node.id === props.edge?.source))
const targetNode = computed(() => props.allNodes.find((node) => node.id === props.edge?.target))
const relationColor = computed(() => RELATION_COLORS[props.edge?.relationType || ''] || '#9ca3af')

function relationLabel(type: string): string {
  const key = `novels.compass.relations.${type}`
  const label = t(key)
  return label === key ? type : label
}
</script>

<style scoped>
.relation-popover {
  position: fixed;
  z-index: 60;
  width: 300px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-raised);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.popover-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.relation-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.node-name {
  font-weight: 600;
}
.relation-chip {
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--on-accent);
  font-size: 10.5px;
}
.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.close-btn:hover {
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
  color: var(--text-0);
}
.popover-body {
  padding: 10px 12px;
}
.relation-strength {
  margin: 0 0 6px;
  font-size: 10.5px;
  color: var(--text-3);
}
.relation-desc {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-1);
}
.relation-events h4 {
  margin: 0 0 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
}
.relation-events ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.relation-events li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-1);
}
.event-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-top: 6px;
  flex-shrink: 0;
}
.popover-foot {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-hover);
  font-size: 10px;
  color: var(--text-3);
  text-align: center;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
