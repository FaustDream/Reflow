<template>
  <div class="titlebar">
    <div class="brand">
      <span class="brand-name">Reflow</span>
    </div>
    <div class="spacer" />
  </div>
</template>

<script setup lang="ts">
// 标题栏只留品牌名，无版本/副标题
</script>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 16px;
  user-select: none;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.brand-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  letter-spacing: 0.06em;
}

.spacer {
  flex: 1;
}

.meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
