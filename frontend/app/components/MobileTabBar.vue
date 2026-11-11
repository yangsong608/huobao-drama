<template>
  <nav
    class="mobile-tabbar"
    :class="{ 'is-keyboard': keyboardOpen, 'is-hidden': hiddenPage }"
    :aria-label="t('mobileNav.label')"
  >
    <NuxtLink
      v-for="item in items"
      :key="item.id"
      :to="item.to"
      class="mobile-tab"
      :class="{ active: isActive(item.id) }"
      :aria-current="isActive(item.id) ? 'page' : undefined"
    >
      <component :is="item.icon" :size="20" :stroke-width="1.9" />
      <span class="mobile-tab-label">{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

<script setup>
import { BookOpen, LayoutGrid, ListOrdered, User } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const route = useRoute()
const keyboardOpen = ref(false)

const items = computed(() => [
  { id: 'projects', to: '/', label: t('mobileNav.projects'), icon: LayoutGrid },
  { id: 'tasks', to: '/tasks', label: t('mobileNav.tasks'), icon: ListOrdered },
  { id: 'novels', to: '/novels', label: t('mobileNav.novels'), icon: BookOpen },
  { id: 'me', to: '/settings', label: t('mobileNav.me'), icon: User },
])

const hiddenPage = computed(() => route.path.startsWith('/pair'))

function isActive(id) {
  if (id === 'projects') return route.path === '/' || route.path.startsWith('/drama')
  if (id === 'tasks') return route.path.startsWith('/tasks')
  if (id === 'novels') return route.path.startsWith('/novels') || route.path.startsWith('/huobao-novel')
  return route.path.startsWith('/settings')
}

const KEYBOARD_INPUT_TYPES = new Set(['text', 'search', 'email', 'number', 'password', 'tel', 'url'])

function opensKeyboard(element) {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element.tagName === 'TEXTAREA') return true
  if (element.tagName !== 'INPUT') return false
  const type = (element.getAttribute('type') || 'text').toLowerCase()
  return KEYBOARD_INPUT_TYPES.has(type)
}

function hasFocusedEditor() {
  return typeof document !== 'undefined' && opensKeyboard(document.activeElement)
}

function onFocusIn(event) {
  if (opensKeyboard(event.target)) keyboardOpen.value = true
}

function onFocusOut(event) {
  if (!opensKeyboard(event.target)) return
  window.setTimeout(() => { keyboardOpen.value = hasFocusedEditor() }, 0)
}

onMounted(() => {
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('focusout', onFocusOut)
})
</script>

<style scoped>
.mobile-tabbar {
  display: flex;
  flex-shrink: 0;
  height: 56px;
  border-top: 1px solid var(--border);
  background: var(--header-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  position: relative;
  z-index: 12;
}

.mobile-tabbar.is-hidden,
.mobile-tabbar.is-keyboard {
  display: none;
}

.mobile-tab {
  flex: 1;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 2px;
  color: var(--text-3);
  text-decoration: none;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.1;
  transition: color 0.16s var(--ease-out);
}

.mobile-tab:hover { color: var(--text-1); }
.mobile-tab.active { color: var(--accent); }
.mobile-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--button-focus);
  border-radius: 10px;
}

.mobile-tab-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (min-width: 744px) {
  .mobile-tabbar { display: none; }
}
</style>
