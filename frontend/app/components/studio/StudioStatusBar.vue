<template>
  <footer class="studio-statusbar">
    <div class="studio-statusbar-side studio-statusbar-left">
      <slot name="left" />
    </div>
    <div class="studio-statusbar-side studio-statusbar-right">
      <slot name="right" />
    </div>
  </footer>
</template>

<style scoped>
.studio-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--statusbar-h);
  min-height: var(--statusbar-h);
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--panel-bg);
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--text-2);
}
.studio-statusbar-side {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.studio-statusbar-right {
  flex-shrink: 0;
  justify-content: flex-end;
}
</style>
