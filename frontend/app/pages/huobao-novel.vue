<template>
  <section class="legacy-page">
    <div class="legacy-card">
      <div class="legacy-mark">小</div>
      <h1>{{ t('novels.legacy.title') }}</h1>
      <p>{{ t('novels.legacy.desc') }}</p>
      <NuxtLink to="/novels" replace class="legacy-action">{{ t('novels.legacy.action') }}</NuxtLink>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

definePageMeta({ layout: 'default' })
const { t } = useI18n()

onMounted(() => {
  navigateTo('/novels', { replace: true })
})
</script>

<style scoped>
.legacy-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  color: var(--text-0);
}
.legacy-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  padding: 36px 32px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
  text-align: center;
}
.legacy-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 22px;
  font-weight: 650;
}
.legacy-card h1 {
  margin: 4px 0 0;
  font-size: 17px;
  font-weight: 600;
}
.legacy-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.legacy-action {
  margin-top: 6px;
  padding: 7px 18px;
  border-radius: var(--radius-pill);
  background: var(--accent-gradient);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
</style>
