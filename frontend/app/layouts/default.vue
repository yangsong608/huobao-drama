<template>
  <div class="shell">
    <AppHeader />
    <main class="content">
      <slot />
    </main>
    <MobileTabBar />
  </div>
</template>

<style scoped>
.shell {
  display: flex; flex-direction: column;
  height: 100vh;
  height: 100dvh;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  overflow: hidden;
  background: var(--bg-base);
}

.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
</style>
