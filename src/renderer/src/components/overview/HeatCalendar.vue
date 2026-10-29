<template>
  <div class="heat">
    <div class="month-row">
      <span v-for="(label, ci) in monthSlots" :key="`m${ci}`" class="month-slot">{{ label }}</span>
    </div>
    <div class="heat-body">
      <span v-for="(col, ci) in columns" :key="ci" class="heat-col">
        <span
          v-for="(cell, ri) in col"
          :key="ri"
          class="heat-cell"
          :class="cell ? `lv-${levelOf(cell)}` : 'lv-blank'"
          :title="cell ? tipOf(cell) : ''"
        />
      </span>
    </div>
    <div class="heat-foot">
      <span class="foot-stat">
        全年支付 <b>{{ yearTotal }}</b> 单 · 退款 <b>{{ yearRefund }}</b> 单 · 有单
        {{ activeDays }} 天
      </span>
      <div class="spacer" />
      <span class="legend-text">少</span>
      <span v-for="lv in [0, 1, 2, 3, 4]" :key="lv" class="heat-cell legend-cell" :class="`lv-${lv}`" />
      <span class="legend-text">多</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Bucket } from '@renderer/utils/order-stats'

const props = defineProps<{
  /** 该年份的每一天（无单的日子 count = 0） */
  days: Bucket[]
  year: number
}>()

/** 每列一周（周一在上、周日在下） */
const columns = computed<(Bucket | null)[][]>(() => {
  const cells: (Bucket | null)[] = []
  const lead = (new Date(props.year, 0, 1).getDay() + 6) % 7
  for (let i = 0; i < lead; i++) cells.push(null)
  cells.push(...props.days)
  while (cells.length % 7 !== 0) cells.push(null)
  const cols: (Bucket | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7))
  return cols
})

/** 每月 1 号所在列 → 月份，用来在顶部标月 */
const monthMarks = computed(() => {
  const marks = new Map<number, number>()
  columns.value.forEach((col, ci) => {
    for (const cell of col) {
      if (!cell) continue
      if (cell.key.slice(8, 10) === '01') marks.set(ci, Number(cell.key.slice(5, 7)))
    }
  })
  return marks
})

/** 顶部月份标签：按列对齐（每列一周），只有 1 号所在列才标月份 */
const monthSlots = computed(() =>
  columns.value.map((_, ci) => {
    const month = monthMarks.value.get(ci)
    return month ? `${month}月` : ''
  })
)

// 热力按**支付成功**单量着色：退款单不该把格子染深
const maxCount = computed(() => props.days.reduce((top, d) => Math.max(top, d.paidCount), 0))
const yearTotal = computed(() => props.days.reduce((sum, d) => sum + d.paidCount, 0))
const yearRefund = computed(() => props.days.reduce((sum, d) => sum + d.refundCount, 0))
const activeDays = computed(() => props.days.filter((d) => d.paidCount > 0).length)

function levelOf(day: Bucket): number {
  if (day.paidCount <= 0) return 0
  if (maxCount.value <= 0) return 0
  return Math.max(1, Math.ceil((day.paidCount / maxCount.value) * 4))
}

function tipOf(day: Bucket): string {
  const lines = [`${day.key}：支付成功 ${day.paidCount} 单 · ${money(day.paidAmount)}`]
  if (day.refundCount > 0) lines.push(`退款 ${day.refundCount} 单 · ${money(day.refundAmount)}`)
  return lines.join('\n')
}

function money(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
</script>

<style scoped>
.heat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.month-row,
.heat-body {
  display: flex;
  gap: 2px;
}

.month-slot {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  line-height: 12px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
  overflow: visible;
}

.heat-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.heat-cell {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 2px;
  background: var(--el-fill-color-light);
  transition: transform 0.1s;
}

.heat-cell:hover:not(.lv-blank) {
  transform: scale(1.25);
  outline: 1px solid var(--el-color-primary);
}

.lv-blank {
  background: transparent;
}

.lv-0 {
  background: var(--el-fill-color-light);
}

.lv-1 {
  background: #c6e2ff;
}

.lv-2 {
  background: #79bbff;
}

.lv-3 {
  background: #409eff;
}

.lv-4 {
  background: #1f6fd0;
}

.heat-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.foot-stat b {
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.spacer {
  flex: 1;
}

.legend-text {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}

.legend-cell {
  width: 10px;
  height: 10px;
  aspect-ratio: auto;
  flex: none;
}
</style>
