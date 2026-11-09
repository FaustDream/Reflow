<template>
  <div class="log-pane">
    <!-- 工具条：级别 / 搜索 / 自动滚动 / 导出到文件 -->
    <div class="log-toolbar">
      <el-radio-group v-model="level" size="small" class="log-levels">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="info">信息以上</el-radio-button>
        <el-radio-button value="warn">警告以上</el-radio-button>
        <el-radio-button value="error">仅错误</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        size="small"
        placeholder="过滤：平台 / 关键词 / 错误信息"
        clearable
        class="log-search"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <span class="log-count">{{ filtered.length }} / {{ entries.length }} 条</span>
      <div class="spacer" />
      <el-switch v-model="autoScroll" size="small" active-text="跟随最新" />
      <el-button size="small" @click="copyVisible">复制</el-button>
      <el-button size="small" @click="openFolder">打开日志目录</el-button>
      <el-button size="small" :disabled="!entries.length" @click="clear">清空</el-button>
    </div>

    <div ref="scroller" class="log-list">
      <div
        v-for="e in visible"
        :key="e.id"
        class="log-row"
        :class="[`is-${e.level}`, { 'is-open': expanded.has(e.id) }]"
      >
        <span class="log-time">{{ clockOf(e.ts) }}</span>
        <span class="log-level">{{ LEVEL_LABEL[e.level] }}</span>
        <span class="log-scope">{{ e.scope }}</span>
        <span class="log-msg">{{ e.message }}</span>
        <button v-if="e.detail" class="log-toggle" @click="toggle(e.id)">
          {{ expanded.has(e.id) ? '收起' : '详情' }}
        </button>
        <pre v-if="e.detail && expanded.has(e.id)" class="log-detail">{{ pretty(e.detail) }}</pre>
      </div>
      <div v-if="!filtered.length" class="log-empty">
        {{ entries.length ? '没有匹配当前过滤条件的日志' : '还没有日志' }}
      </div>
    </div>

    <div class="log-foot">
      <span>日志文件：{{ filePath || '（未启用磁盘日志）' }}</span>
      <span class="log-foot-hint">级别：{{ LEVEL_HINT }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '../icons'
import type { LogEntry, LogLevel } from '@shared/types'

const MAX_RENDER = 800

const entries = ref<LogEntry[]>([])
const level = ref<'all' | 'info' | 'warn' | 'error'>('all')
const keyword = ref('')
const autoScroll = ref(true)
const filePath = ref('')
const expanded = ref<Set<number>>(new Set())
const scroller = ref<HTMLElement | null>(null)

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
const LEVEL_HINT = '调试=内部细节；信息=正常动作；警告=可恢复异常；错误=抓取/登录/导出失败'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const min = level.value === 'all' ? 0 : LEVEL_WEIGHT[level.value]
  return entries.value.filter((e) => {
    if (LEVEL_WEIGHT[e.level] < min) return false
    if (!kw) return true
    return (
      e.scope.toLowerCase().includes(kw) ||
      e.message.toLowerCase().includes(kw) ||
      (e.detail ?? '').toLowerCase().includes(kw)
    )
  })
})

/** 只渲染最近 MAX_RENDER 条：几千行全画出来滚动会明显卡 */
const visible = computed(() => filtered.value.slice(-MAX_RENDER))

function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function pretty(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  } catch {
    return detail
  }
}

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function scrollToBottom(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function push(entry: LogEntry): void {
  // 历史与实时可能重叠：按 id 去重
  if (entries.value.some((e) => e.id === entry.id)) return
  entries.value = [...entries.value, entry].slice(-3000)
  if (autoScroll.value) void nextTick(scrollToBottom)
}

async function load(): Promise<void> {
  try {
    const r = await window.api.logs.list()
    entries.value = Array.isArray(r.entries) ? r.entries.slice(-3000) : []
    filePath.value = r.filePath ?? ''
    await nextTick(scrollToBottom)
  } catch (e) {
    ElMessage.error(`读取日志失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function clear(): Promise<void> {
  try {
    await window.api.logs.clear()
    entries.value = []
    expanded.value = new Set()
    ElMessage.success('已清空（磁盘日志文件保留）')
  } catch {
    ElMessage.error('清空失败')
  }
}

async function openFolder(): Promise<void> {
  const r = await window.api.logs.openFolder().catch(() => ({ ok: false, error: '调用失败' }))
  if (!r.ok) ElMessage.error(r.error || '打开日志目录失败')
}

async function copyVisible(): Promise<void> {
  const text = filtered.value
    .map((e) => `${clockOf(e.ts)} ${e.level.toUpperCase()} ${e.scope} ${e.message}${e.detail ? ` ${e.detail}` : ''}`)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${filtered.value.length} 条日志`)
  } catch {
    ElMessage.error('复制失败（剪贴板不可用）')
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  void load()
  unsubscribe = window.api.logs.onEntry((entry) => push(entry))
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.log-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
}

.log-levels :deep(.el-radio-button__inner) {
  padding: 5px 10px;
  font-size: 12px;
}

.log-search {
  width: 240px;
}

.log-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.log-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-bg-color);
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.log-row {
  display: grid;
  grid-template-columns: 92px 40px 132px 1fr auto;
  gap: 8px;
  align-items: baseline;
  padding: 4px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  line-height: 1.5;
}

.log-row:hover {
  background: var(--el-fill-color-lighter);
}

.log-time {
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.log-level {
  font-weight: 600;
  text-align: center;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--el-text-color-secondary);
}

.log-row.is-info .log-level {
  color: var(--el-color-primary);
}
.log-row.is-warn {
  background: var(--el-color-warning-light-9);
}
.log-row.is-warn .log-level {
  color: var(--el-color-warning);
}
.log-row.is-error {
  background: var(--el-color-danger-light-9);
}
.log-row.is-error .log-level {
  color: var(--el-color-danger);
}

.log-scope {
  color: var(--el-color-success);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-msg {
  color: var(--el-text-color-primary);
  word-break: break-word;
}

.log-toggle {
  border: none;
  background: transparent;
  color: var(--el-color-primary);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
}

.log-detail {
  grid-column: 1 / -1;
  margin: 4px 0 2px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.5;
}

.log-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--el-text-color-placeholder);
}

.log-foot {
  flex: none;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.log-foot span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
