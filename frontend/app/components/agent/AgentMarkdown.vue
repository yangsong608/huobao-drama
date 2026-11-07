<template>
  <div class="agent-md">
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="`h${block.level}`" v-if="block.type === 'heading'" class="agent-md-heading">
        <AgentInline :tokens="block.inlines" />
      </component>
      <pre v-else-if="block.type === 'code'" class="agent-md-code"><code>{{ block.text }}</code></pre>
      <hr v-else-if="block.type === 'hr'" class="agent-md-hr" />
      <blockquote v-else-if="block.type === 'quote'" class="agent-md-quote">
        <template v-for="(line, lineIndex) in block.lines" :key="lineIndex">
          <br v-if="lineIndex > 0" />
          <AgentInline :tokens="line" />
        </template>
      </blockquote>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" class="agent-md-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <AgentInline :tokens="item" />
        </li>
      </component>
      <p v-else class="agent-md-paragraph">
        <template v-for="(line, lineIndex) in block.lines" :key="lineIndex">
          <br v-if="lineIndex > 0" />
          <AgentInline :tokens="line" />
        </template>
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AgentInline from './AgentInline.vue'
import { parseAgentMarkdown } from '~/utils/agent-markdown.js'

const props = defineProps<{ content: string }>()
const blocks = computed(() => parseAgentMarkdown(props.content))
</script>

<style scoped>
.agent-md {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
  overflow-wrap: anywhere;
}
.agent-md > :first-child { margin-top: 0; }
.agent-md > :last-child { margin-bottom: 0; }
.agent-md-paragraph { margin: 0 0 8px; white-space: normal; }
.agent-md-heading { margin: 12px 0 6px; font-size: 14px; font-weight: 700; color: var(--text-0); }
.agent-md-list { margin: 0 0 8px; padding-left: 20px; }
.agent-md-list li { margin: 2px 0; }
.agent-md-quote {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 2px solid var(--border-strong, var(--border));
  color: var(--text-2);
}
.agent-md-code {
  margin: 0 0 8px;
  padding: 8px 10px;
  background: var(--bg-sunken, var(--bg-base));
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-md-hr { margin: 10px 0; border: none; border-top: 1px solid var(--border); }
.agent-md :deep(code) {
  padding: 1px 4px;
  background: var(--bg-sunken, var(--bg-base));
  border-radius: 4px;
  font-size: 12px;
}
.agent-md :deep(a) { color: var(--accent); text-decoration: underline; }
</style>
