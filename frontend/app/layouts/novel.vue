<template>
  <div class="novel-shell">
    <AppHeader />
    <div class="novel-scope">
      <n-config-provider :theme="theme" :theme-overrides="themeOverrides">
        <slot />
      </n-config-provider>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NConfigProvider, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import { resolvedTheme } from '~/composables/useTheme'

const theme = computed(() => (resolvedTheme.value === 'dark' ? darkTheme : undefined))

const LIGHT_ACCENT = {
  primaryColor: '#f97316',
  primaryColorHover: '#ea580c',
  primaryColorPressed: '#c2410c',
  primaryColorSuppl: '#ea580c',
}

const DARK_ACCENT = {
  primaryColor: '#ffb076',
  primaryColorHover: '#ffc08f',
  primaryColorPressed: '#f5934e',
  primaryColorSuppl: '#ffc08f',
}

const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    ...(resolvedTheme.value === 'dark' ? DARK_ACCENT : LIGHT_ACCENT),
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontFamily: 'var(--font-body)',
  },
  Card: { borderRadius: '14px' },
  Button: {
    borderRadiusTiny: '6px',
    borderRadiusSmall: '8px',
    borderRadiusMedium: '10px',
  },
  Tabs: { tabBorderRadius: '10px' },
  Input: { borderRadius: '10px' },
}))
</script>

<style scoped>
.novel-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}

.novel-scope {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.novel-scope :deep(.n-config-provider) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
