<template>
  <div class="shell">
    <AppHeader />
    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
  background: var(--bg-base);
}

.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
</style>
