<template>
  <header class="header">
    <div class="header-left">
      <button class="brand" @click="navigateTo('/')">
        <div class="brand-mark">
          <img v-if="showBrandImage" :src="brandLogo" alt="火宝短剧" class="brand-logo" @error="showBrandImage = false" />
          <span v-else class="brand-fallback">火</span>
        </div>
        <div class="brand-text">
          <span class="brand-name">火宝短剧</span>
          <span class="brand-sub">Huobao Shorts</span>
        </div>
      </button>
    </div>

    <nav class="header-nav">
      <NuxtLink to="/" class="nav-link" :class="{ active: isDramaActive }" :title="t('layout.nav.projects')">
        <LayoutGrid :size="15" :stroke-width="1.8" />
        <span class="nav-label">{{ t('layout.nav.projects') }}</span>
      </NuxtLink>
      <NuxtLink to="/novels" class="nav-link" :class="{ active: isNovelActive }" :title="t('layout.nav.novels')">
        <BookOpen :size="15" :stroke-width="1.8" />
        <span class="nav-label">{{ t('layout.nav.novels') }}</span>
      </NuxtLink>
      <NuxtLink to="/settings" class="nav-link" :class="{ active: isSettingsActive }" :title="t('layout.nav.settings')">
        <Settings :size="15" :stroke-width="1.8" />
        <span class="nav-label">{{ t('layout.nav.settings') }}</span>
      </NuxtLink>
    </nav>

    <div class="header-right">
      <!-- PWA 安装入口：可捕获安装事件或 iOS 未安装时显示，独立窗口/已安装不出现 -->
      <button
        v-if="showInstallEntry"
        ref="installButtonRef"
        type="button"
        class="pwa-install"
        :aria-label="t('tablet.install')"
        :title="t('tablet.install')"
        @click="onInstallClick"
      >
        <Download :size="15" :stroke-width="1.8" />
        <span class="pwa-install-label">{{ t('tablet.install') }}</span>
      </button>
      <!-- iOS 无 beforeinstallprompt：改为说明「分享 → 添加到主屏幕」 -->
      <div
        v-if="installHintOpen && isIos && !isStandalone"
        ref="installHintRef"
        class="pwa-install-hint"
        role="status"
      >
        <span class="pwa-install-hint-text">{{ t('tablet.installHint') }}</span>
        <button
          type="button"
          class="pwa-install-hint-close"
          :aria-label="t('tablet.close')"
          :title="t('tablet.close')"
          @click="closeInstallHint"
        >
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <a
        class="github-link"
        href="https://github.com/chatfire-AI/huobao-drama"
        target="_blank"
        rel="noopener"
        aria-label="GitHub"
        title="GitHub"
      >
        <Github :size="15" :stroke-width="1.8" />
      </a>
      <ThemeToggle />
      <LocaleSwitcher />
    </div>
  </header>

  <!-- AI 服务未配置引导横幅(缺任一类型即提示) -->
  <div v-if="missingConfigLabels.length" class="config-banner">
    <TriangleAlert :size="14" :stroke-width="1.8" />
    <span>{{ t('layout.banner.missing', { types: missingConfigLabels.join(t('common.listJoin')) }) }}</span>
    <NuxtLink to="/settings" class="config-banner-link">{{ t('layout.banner.goSettings') }}</NuxtLink>
  </div>
</template>

<script setup>
import { BookOpen, LayoutGrid, Settings, TriangleAlert, Github, Download, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { aiConfigAPI } from '~/composables/useApi'
import { usePwa } from '~/composables/usePwa'
import brandLogo from '~/assets/brand-logo.png'

const { t, locale } = useI18n()
const route = useRoute()
const showBrandImage = ref(true)

const {
  canInstall,
  isStandalone,
  isIos,
  installHintOpen,
  promptInstall,
  toggleInstallHint,
} = usePwa()

const installButtonRef = ref(null)
const installHintRef = ref(null)

// 已安装/独立窗口隐藏；可捕获安装事件或 iOS 未安装时显示
const showInstallEntry = computed(() => !isStandalone.value && (canInstall.value || isIos.value))

function closeInstallHint() {
  if (installHintOpen.value) toggleInstallHint()
}

function onInstallClick() {
  // 有 beforeinstallprompt 时拉起系统安装面板；iOS 无该事件，改为切换说明浮层
  if (canInstall.value) {
    void promptInstall()
    return
  }
  toggleInstallHint()
}

function onDocumentPointerDown(event) {
  if (installHintRef.value?.contains(event.target)) return
  if (installButtonRef.value?.contains(event.target)) return
  closeInstallHint()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape') closeInstallHint()
}

function bindHintDismiss() {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
}

function unbindHintDismiss() {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
}

// iOS 说明浮层：点击外部与 Escape 关闭，关闭即解绑监听；
// installHintOpen 是模块级状态，布局重挂载时浮层可能仍打开，immediate 保证重新绑定
watch(installHintOpen, (open) => { open ? bindHintDismiss() : unbindHintDismiss() }, { immediate: true })
onBeforeUnmount(unbindHintDismiss)

const isDramaActive = computed(() => route.path === '/' || route.path.startsWith('/drama/'))
const isNovelActive = computed(() => route.path.startsWith('/novels'))
const isSettingsActive = computed(() => route.path === '/settings')

// 渲染时求值，语言切换即时生效（不能模块级常量固化）
const SERVICE_TYPE_LABELS = computed(() => ({
  text: t('common.serviceType.text'),
  image: t('common.serviceType.image'),
  video: t('common.serviceType.video'),
}))
const missingConfigLabels = ref([])

async function checkAiConfigs() {
  try {
    const configs = await aiConfigAPI.list()
    const labels = SERVICE_TYPE_LABELS.value
    missingConfigLabels.value = Object.entries(labels)
      .filter(([type]) => !configs.some(c => c.service_type === type && c.is_active))
      .map(([, label]) => label)
  } catch { /* 配置检查失败不阻塞页面 */ }
}

onMounted(checkAiConfigs)
// 设置页保存配置后返回时重新检查(布局跨页面复用,onMounted 只触发一次)
watch(() => route.path, checkAiConfigs)
// 切换界面语言时横幅中已拼接的类型文案需要重算
watch(locale, checkAiConfigs)
</script>

<style scoped>
.header {
  display: flex; align-items: center;
  height: 60px; flex-shrink: 0;
  padding: 0 24px;
  gap: 32px;
  background: var(--header-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 10;
}

.header-left { display: flex; align-items: center; }

.brand {
  display: flex; align-items: center; gap: 11px;
  background: transparent; border: none; cursor: pointer; padding: 4px 8px 4px 4px;
  text-decoration: none; border-radius: var(--radius);
  transition: background 0.18s var(--ease-out);
}
.brand:hover { background: var(--bg-hover); }
.brand:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.brand-mark {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 9px;
  overflow: hidden;
}
.brand-logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
  display: block;
}
.brand-fallback {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-0);
  line-height: 1;
}
.brand-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.brand-name {
  font-size: 15px; font-weight: 700;
  /* ChatFire 签名：品牌字标火焰橙渐变 */
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-top: 1px;
  letter-spacing: 0.04em;
}

/* Nav — pill segmented group */
.header-nav {
  display: flex; gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--overlay-track);
}

/* Header 右侧 — 语言切换器 */
.header-right {
  margin-left: auto;
  display: flex; align-items: center;
}
/* GitHub 入口 — 与 ThemeToggle 同款圆形图标按钮 */
.github-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  color: var(--text-2);
  transition: all 0.18s var(--ease-out);
  line-height: 1;
}
.github-link:hover { color: var(--text-0); background: var(--bg-hover); }
.github-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.nav-link {
  display: flex; align-items: center; gap: 6px;
  min-height: 32px;
  padding: 0 16px; border-radius: var(--radius-pill);
  font-size: 13px; font-weight: 600;
  color: var(--text-2); text-decoration: none;
  transition: all 0.18s var(--ease-out);
  border: none;
  line-height: 1;
}
.nav-link:hover { color: var(--text-0); }
.nav-link.active {
  background: var(--seg-active-bg);
  color: var(--text-0);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
.nav-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* Config banner — AI 服务未配置引导 */
.config-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 24px; flex-shrink: 0;
  font-size: 12.5px; color: var(--warn-text);
  background: var(--warn-bg);
  border-bottom: 1px solid var(--warn-border);
  position: relative; z-index: 9;
}
.config-banner-link {
  margin-left: auto;
  font-size: 12.5px; font-weight: 600;
  color: var(--warn-link); text-decoration: none;
  padding: 2px 10px; border-radius: var(--radius-pill);
  border: 1px solid var(--warn-border);
  transition: all 0.18s var(--ease-out);
  line-height: 1.6;
}
.config-banner-link:hover { background: var(--warn-link-hover-bg); color: var(--warn-text); }

/* 平板（<=1180）：保持单行不换行，品牌 + 三导航 + 主题/语言入口始终同排，
   导航与主题/语言命中区不小于 44px；桌面 1181 起不生效 */
@media (max-width: 1180px) {
  .header { flex-wrap: nowrap; }
  /* 品牌区不收缩 + 品牌名不折行，744-1180 单行由结构保证 */
  .header-left { flex-shrink: 0; }
  .brand-name { white-space: nowrap; }
  .header-nav { flex-shrink: 0; }
  .header-right { flex-shrink: 0; }
  .nav-link { min-height: 44px; }
  .header-right :deep(.theme-toggle),
  .header-right :deep(.locale-trigger) { min-height: 44px; }
  .header-right :deep(.theme-toggle) { min-width: 44px; }
}

/* 紧凑平板（<=900）：压缩间距并隐藏品牌副标题，品牌名/导航文字与图标保留 */
@media (max-width: 900px) {
  .header { padding: 0 16px; gap: 16px; }
  .brand-sub { display: none; }
  .nav-link { padding: 0 14px; }
}

/* 窄平板（<=743）：复用原 720 窄屏规则，隐藏品牌文字与导航文字并压缩 padding */
@media (max-width: 743px) {
  .header { padding: 0 12px; gap: 12px; }
  .brand-text { display: none; }
  .nav-link { padding: 0 10px; }
  .nav-label { display: none; }
}

/* PWA 安装入口：与 GitHub / ThemeToggle 同排，桌面显示图标 + 文字 */
.pwa-install {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px;
  padding: 0 12px;
  margin-right: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px; font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.pwa-install:hover { color: var(--text-0); background: var(--bg-hover); }
.pwa-install:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* iOS 安装说明浮层：挂在头部下方，不参与单行布局 */
.pwa-install-hint {
  position: absolute;
  top: calc(100% + 8px);
  right: 16px;
  z-index: 30;
  display: flex; align-items: center; gap: 8px;
  max-width: min(340px, calc(100vw - 24px));
  padding: 10px 8px 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text-1);
  box-shadow: var(--shadow-elevated);
  font-size: 12.5px; line-height: 1.55;
}
.pwa-install-hint-text { flex: 1; }
.pwa-install-hint-close {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; flex-shrink: 0;
  border: none; border-radius: var(--radius-pill);
  background: transparent; color: var(--text-2);
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.pwa-install-hint-close:hover { color: var(--text-0); background: var(--bg-hover); }
.pwa-install-hint-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* 平板：安装入口命中区不小于 44px，1181 起不生效 */
@media (max-width: 1180px) {
  .pwa-install { min-height: 44px; min-width: 44px; padding: 0 12px; }
}

/* 紧凑平板：隐藏安装入口文字，只留 44×44 图标 */
@media (max-width: 900px) {
  .pwa-install { width: 44px; height: 44px; padding: 0; }
  .pwa-install-label { display: none; }
}

/* 粗指针（含 1181+ 触屏设备）：安装入口与说明关闭按钮均不小于 44px */
@media (hover: none) and (pointer: coarse) {
  .pwa-install { min-width: 44px; min-height: 44px; }
  .pwa-install-hint { right: 8px; }
  .pwa-install-hint-close { width: 44px; height: 44px; }
}
</style>
