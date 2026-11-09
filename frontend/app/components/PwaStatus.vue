<template>
  <!-- 离线 / 新版本提示：全局单例，浮在页面内容之上但不拦截整页点击 -->
  <div
    v-if="offline || (updateReady && !updateDismissed)"
    class="pwa-status"
    role="status"
    aria-live="polite"
  >
    <WifiOff v-if="offline" :size="14" :stroke-width="1.8" class="pwa-status-icon" />
    <RefreshCw v-else :size="14" :stroke-width="1.8" class="pwa-status-icon" />
    <span class="pwa-status-text">
      {{ offline ? t('tablet.status.offlineHint') : t('tablet.status.updateReady') }}
    </span>
    <button
      v-if="!offline"
      type="button"
      class="pwa-status-close"
      :aria-label="t('tablet.close')"
      :title="t('tablet.close')"
      @click="dismissUpdate"
    >
      <X :size="13" :stroke-width="2" />
    </button>
  </div>
</template>

<script setup>
import { RefreshCw, WifiOff, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { usePwa } from '~/composables/usePwa'

const { t } = useI18n()
const { offline, updateReady, updateDismissed, dismissUpdate } = usePwa()
</script>

<style scoped>
/* 顶部安全区下方居中；离线优先于更新提示；只在对应状态出现，不常驻占位 */
.pwa-status {
  position: fixed;
  top: calc(var(--safe-top) + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: calc(var(--z-menu) + 200);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 24px);
  padding: 8px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-1);
  box-shadow: var(--shadow-elevated);
  font-size: 12.5px;
  line-height: 1.4;
  /* 条状提示不挡页面交互：只有关闭按钮恢复点击 */
  pointer-events: none;
}
.pwa-status-icon { flex-shrink: 0; color: var(--text-2); }
.pwa-status-text { white-space: normal; }
.pwa-status-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  pointer-events: auto;
  transition: all 0.18s var(--ease-out);
}
.pwa-status-close:hover { color: var(--text-0); background: var(--bg-hover); }
.pwa-status-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* 粗指针：关闭按钮 44×44 命中区 */
@media (hover: none) and (pointer: coarse) {
  .pwa-status { padding: 6px 8px 6px 12px; }
  .pwa-status-close { width: 44px; height: 44px; margin-right: -4px; }
}
</style>
