<template>
  <template v-for="(token, index) in tokens" :key="index">
    <strong v-if="token.type === 'strong'">{{ token.text }}</strong>
    <em v-else-if="token.type === 'em'">{{ token.text }}</em>
    <del v-else-if="token.type === 'del'">{{ token.text }}</del>
    <code v-else-if="token.type === 'code'">{{ token.text }}</code>
    <a v-else-if="token.type === 'link'" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a>
    <template v-else>{{ token.text }}</template>
  </template>
</template>

<script setup lang="ts">
defineProps<{
  tokens: Array<{ type: string; text: string; href?: string }>
}>()
</script>
