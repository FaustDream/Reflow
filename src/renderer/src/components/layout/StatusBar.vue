<template>
  <div class="statusbar">
    <!--
      状态由工单 004/005 提供：注入桥接入状态、已注册适配器摘要。
      025 诊断面板将扩展为各平台最近捕获时间。
    -->
    <span class="item">
      <span class="dot" :class="bridgeReady ? 'dot-ok' : 'dot-idle'" />
      注入桥：{{ bridgeReady ? '已接入' : '未接入' }}
    </span>
    <span class="item">
      <span class="dot" :class="adapters.length ? 'dot-ok' : 'dot-idle'" />
      平台适配器：{{ adapters.length }} 个已注册<template v-if="adapters.length">（{{ names }}）</template>
    </span>
    <div class="spacer" />
    <el-tooltip placement="top">
      <template #content>
        Electron {{ runtime.electron }} · Chromium {{ runtime.chrome }} · Node {{ runtime.node }} ·
        {{ runtime.platform }}/{{ runtime.arch }} · v{{ runtime.version }}
      </template>
      <span class="item muted">v{{ runtime.version }}</span>
    </el-tooltip>
    <span class="item muted">数据仅存本机 · 不上传</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AdapterSummary } from '@shared/types'
import { isHiddenPlatform } from '@shared/platform-visibility'

const bridgeReady = ref(false)
const adapters = ref<AdapterSummary[]>([])
const names = computed(() => adapters.value.map((a) => a.displayName).join('、'))

const runtime = ref({
  version: '—',
  electron: '—',
  chrome: '—',
  node: '—',
  platform: '—',
  arch: '—'
})

onMounted(async () => {
  // 已停用/仅验证用的适配器不参与展示（与侧栏同一份判断）
  adapters.value = (await window.api.getAdapters()).filter((a) => !isHiddenPlatform(a.id))
  // 工单 004：注入桥随应用常驻（webviewTag + 强制 preload），有适配器即视为可用
  bridgeReady.value = adapters.value.length > 0
  runtime.value = await window.api.getAppInfo()
})
</script>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  user-select: none;
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 16px;
}

.spacer {
  flex: 1;
}

.muted {
  margin-right: 0;
  color: var(--el-text-color-placeholder);
}

/* 版本号与「数据仅存本机」之间留出间隔（两者都去掉了右外边距） */
.item.muted + .item.muted {
  margin-left: 16px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.dot-idle {
  background: var(--el-color-info-light-5);
}

.dot-ok {
  background: var(--el-color-success);
}
</style>
