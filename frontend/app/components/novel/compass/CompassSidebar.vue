<template>
  <transition name="slide-right">
    <aside v-if="visible && node" class="compass-sidebar">
      <header class="sidebar-head">
        <div class="node-title">
          <component :is="typeIcon(node.type)" :size="16" />
          <span class="node-label">{{ node.label }}</span>
          <span class="type-chip">{{ typeLabel(node.type) }}</span>
        </div>
        <button type="button" class="close-btn" :aria-label="t('novels.compass.sidebar.close')" @click="emit('close')">
          <X :size="15" />
        </button>
      </header>

      <div class="sidebar-body">
        <div class="node-tags">
          <span v-if="node.status" class="status-chip" :class="`is-${node.status}`">{{ statusLabel(node.status) }}</span>
          <span v-if="node.faction" class="faction-chip">{{ node.faction }}</span>
          <span class="importance">{{ t('novels.compass.importance', { n: node.importance || 0 }) }}</span>
        </div>

        <p v-if="node.bio" class="node-bio">{{ node.bio }}</p>

        <div v-if="node.traits?.length" class="node-traits">
          <span v-for="trait in node.traits" :key="trait">{{ trait }}</span>
        </div>

        <section class="sidebar-section">
          <h3>{{ t('novels.compass.sidebar.relations') }}</h3>
          <p v-if="!relatedEdges.length" class="section-empty">{{ t('novels.compass.sidebar.noRelations') }}</p>
          <ul v-else class="relation-list">
            <li v-for="edge in relatedEdges" :key="edge.id">
              <span class="relation-dot" :style="{ background: relationColor(edge.relationType) }"></span>
              <span class="relation-name">{{ otherNode(edge)?.label || t('novels.compass.sidebar.unknown') }}</span>
              <span class="relation-type">{{ relationLabel(edge.relationType) }}</span>
              <p v-if="edge.description || edge.label" class="relation-desc">{{ edge.description || edge.label }}</p>
            </li>
          </ul>
        </section>

        <section class="sidebar-section">
          <h3>{{ t('novels.compass.sidebar.chapters') }}</h3>
          <p v-if="!chaptersWithNode.length" class="section-empty">{{ t('novels.compass.sidebar.noChapters') }}</p>
          <div v-else class="chapter-list">
            <button
              v-for="chapter in chaptersWithNode"
              :key="chapter"
              type="button"
              class="chapter-btn"
              @click="emit('locate-chapter', chapter)"
            >
              {{ t('novels.compass.timeline.chapter', { n: chapter }) }}
            </button>
          </div>
        </section>
      </div>

      <footer class="sidebar-foot">
        <button type="button" class="delete-btn" @click="emit('delete-node', node.id)">
          <Trash2 :size="13" />
          {{ t('novels.compass.sidebar.delete') }}
        </button>
      </footer>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Boxes, MapPin, PersonStanding, Shield, Trash2, X } from 'lucide-vue-next'
import {
  RELATION_COLORS,
  type GraphEdge,
  type GraphNode,
} from '~/utils/novel-graph'

const props = defineProps<{
  node: GraphNode | null
  edges: GraphEdge[]
  allNodes: GraphNode[]
  visible: boolean
  chaptersWithNode?: number[]
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'delete-node', nodeId: string): void
  (event: 'locate-chapter', chapter: number): void
}>()

const { t } = useI18n()

const relatedEdges = computed(() => {
  if (!props.node) return []
  return props.edges.filter((edge) => edge.source === props.node!.id || edge.target === props.node!.id)
})

const chaptersWithNode = computed(() => props.chaptersWithNode || [])

const typeIcons: Record<string, any> = {
  character: PersonStanding,
  faction: Shield,
  location: MapPin,
  item: Boxes,
}

function typeIcon(type: string) {
  return typeIcons[type] || PersonStanding
}

function typeLabel(type: string): string {
  const key = `novels.compass.nodeTypes.${type}`
  const label = t(key)
  return label === key ? type : label
}

function statusLabel(status: string): string {
  const key = `novels.compass.status.${status}`
  const label = t(key)
  return label === key ? status : label
}

function relationLabel(type: string): string {
  const key = `novels.compass.relations.${type}`
  const label = t(key)
  return label === key ? type : label
}

function relationColor(type: string): string {
  return RELATION_COLORS[type] || '#9ca3af'
}

function otherNode(edge: GraphEdge): GraphNode | undefined {
  if (!props.node) return undefined
  const otherId = edge.source === props.node.id ? edge.target : edge.source
  return props.allNodes.find((item) => item.id === otherId)
}
</script>

<style scoped>
.compass-sidebar {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-hover);
  overflow: hidden;
}
.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.node-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--novel-accent);
}
.node-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type-chip {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
  color: var(--text-2);
  font-size: 10px;
  white-space: nowrap;
}
.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
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
.sidebar-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.node-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.status-chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
  color: var(--text-2);
  font-size: 10.5px;
}
.status-chip.is-active {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}
.status-chip.is-deceased {
  color: var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
}
.status-chip.is-offline {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.faction-chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 10.5px;
  color: var(--text-2);
}
.importance {
  font-size: 10.5px;
  color: var(--text-3);
}
.node-bio {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-1);
  word-break: break-word;
}
.node-traits {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.node-traits span {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
  color: var(--text-2);
  font-size: 10.5px;
}
.sidebar-section h3 {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}
.section-empty {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.relation-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.relation-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  font-size: 11.5px;
}
.relation-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.relation-name {
  color: var(--text-0);
  font-weight: 500;
}
.relation-type {
  margin-left: auto;
  color: var(--text-3);
  font-size: 10.5px;
}
.relation-desc {
  flex-basis: 100%;
  margin: 0;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}
.chapter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chapter-btn {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}
.chapter-btn:hover {
  color: var(--novel-accent);
  border-color: var(--novel-accent);
}
.sidebar-foot {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
.delete-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: transparent;
  color: var(--error);
  font-size: 11.5px;
  cursor: pointer;
}
.delete-btn:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(16px);
  opacity: 0;
}
@media (max-width: 760px) {
  .compass-sidebar {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
</style>
