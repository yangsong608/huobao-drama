<template>
  <div class="studio-fullscreen">
    <slot />
  </div>
</template>

<style scoped>
.studio-fullscreen {
  height: 100vh;
  height: 100dvh;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  display: flex; flex-direction: column;
  overflow: hidden;
  /* 工作台内部滚动不外溢到页面（触控回弹不带动整页） */
  overscroll-behavior: contain;
  background: var(--bg-base);
}
</style>
