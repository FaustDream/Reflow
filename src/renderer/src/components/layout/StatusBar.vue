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
    <!-- 作者水印：软件可自由使用，但来源要看得见 -->
    <span class="item watermark" title="作者 · 点击打开项目主页" @click="openHome">
      Reflow · {{ AUTHOR }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AUTHOR, REPO_URL } from '@shared/app-meta'
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

/** 外链走系统浏览器（主进程的 setWindowOpenHandler 已统一处理） */
function openHome(): void {
  window.open(REPO_URL, '_blank')
}
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

/* 作者水印：弱化但不隐藏，鼠标悬停才变主色 */
.watermark {
  margin-left: 16px;
  margin-right: 0;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  letter-spacing: 0.2px;
  transition: color 0.15s;
}

.watermark:hover {
  color: var(--el-color-primary);
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
