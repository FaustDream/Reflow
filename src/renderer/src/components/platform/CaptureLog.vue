<template>
  <div class="capture-log">
    <div class="log-head">
      <span>捕获记录（{{ store.count }}）</span>
      <el-button size="small" text @click="store.clear()">清空</el-button>
    </div>

    <el-alert
      v-if="store.lastError"
      class="log-alert"
      type="error"
      :closable="false"
      :title="`注入/加载故障：${store.lastError.stage}`"
      :description="describeError(store.lastError)"
    />

    <el-table :data="store.events" size="small" height="100%" empty-text="尚无捕获 — 在左侧加载一个页面">
      <el-table-column prop="kind" label="形态" width="64">
        <template #default="{ row }">
          <el-tag size="small" :type="kindTag(row.kind)">{{ row.kind }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="method" label="方法" width="64" />
      <el-table-column prop="status" label="状态" width="60" />
      <el-table-column label="URL" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.url }}</template>
      </el-table-column>
      <el-table-column label="响应摘要" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ summarize(row.body) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { useCaptureStore } from '@renderer/stores/capture'
import type { CaptureErrorEvent } from '@shared/types'

const store = useCaptureStore()

function kindTag(kind: string): 'success' | 'info' | 'warning' {
  if (kind === 'xhr') return 'success'
  if (kind === 'fetch') return 'info'
  return 'warning'
}

function summarize(body: unknown): string {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') return body.slice(0, 80)
  try {
    return JSON.stringify(body).slice(0, 80)
  } catch {
    return '[无法序列化]'
  }
}

function describeError(e: CaptureErrorEvent): string {
  if (e.stage === 'did-fail-load') return `${e.errorCode} ${e.errorDescription} @ ${e.url}`
  if (e.stage === 'render-process-gone') return `渲染进程退出：${e.reason}`
  return e.message ?? '未知错误'
}
</script>

<style scoped>
.capture-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
}

.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.log-alert {
  flex: none;
}
</style>
