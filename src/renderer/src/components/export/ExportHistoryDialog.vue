<template>
  <el-dialog v-model="visible" title="导出记录" width="720px" @open="load">
    <div v-if="entries.length" class="hint">
      最近 {{ entries.length }} 次导出（只记录文件信息，不含订单内容）
    </div>
    <el-table v-if="entries.length" :data="entries" size="small" max-height="360" class="table">
      <el-table-column label="时间" width="132">
        <template #default="{ row }">{{ formatTime(row.at) }}</template>
      </el-table-column>
      <el-table-column label="文件" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="file-name">{{ row.fileName }}</span>
        </template>
      </el-table-column>
      <el-table-column label="范围" width="96">
        <template #default="{ row }">
          {{ row.platforms.length === 1 ? platformName(row.platforms[0]) : `${row.platforms.length} 个平台` }}
        </template>
      </el-table-column>
      <el-table-column label="行数" width="56" align="right" prop="rowCount" />
      <el-table-column label="格式" width="84">
        <template #default="{ row }">
          {{ row.format === 'csv' ? 'CSV' : row.layout === 'multi-sheet' ? 'Excel 多表' : 'Excel 单表' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="104" align="right">
        <template #default="{ row }">
          <el-button link size="small" @click="openFile(row)">打开</el-button>
          <el-button link size="small" @click="locate(row)">定位</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="还没有导出过文件" :image-size="70" />

    <template #footer>
      <el-button v-if="entries.length" text type="danger" @click="clear">清空记录</el-button>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 工单 031：导出记录。
 *
 * 工单 022 的验收项里有「导出历史最近 N 次，可一键重开文件」，
 * 之前的实现只做了导出本身。这里补上：记录由主进程维护（最多 20 条），
 * 本组件只读展示 + 打开/定位；清空只清记录，不动文件。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ExportHistoryEntry } from '@shared/types'

const visible = defineModel<boolean>({ required: true })
const entries = ref<ExportHistoryEntry[]>([])

/** 平台 id → 中文名（导出记录里存的是 id，展示要给人看） */
const nameMap = ref<Record<string, string>>({})

async function load(): Promise<void> {
  try {
    entries.value = await window.api.getExportHistory()
  } catch {
    entries.value = []
  }
  try {
    const adapters = await window.api.getAdapters()
    nameMap.value = Object.fromEntries(adapters.map((a) => [a.id, a.displayName]))
  } catch {
    /* 名称解析失败时回退显示 id */
  }
}

function platformName(id: string): string {
  return nameMap.value[id] ?? id
}

function formatTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function openFile(row: { path?: unknown }): void {
  if (typeof row.path === 'string') void window.api.openPath(row.path)
}

function locate(row: { path?: unknown }): void {
  if (typeof row.path === 'string') void window.api.showInFolder(row.path)
}

async function clear(): Promise<void> {
  await window.api.clearExportHistory()
  entries.value = []
  ElMessage.success('已清空导出记录（文件本身未删除）')
}
</script>

<style scoped>
.hint {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.file-name {
  font-size: 12px;
}
</style>
