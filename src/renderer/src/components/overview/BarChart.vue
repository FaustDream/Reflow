<template>
  <div class="bar-chart">
    <div class="bars" :style="{ height: `${height}px` }">
      <div
        v-for="it in items"
        :key="it.label"
        class="bar-col"
        :class="{ active: it.label === activeLabel, empty: totalValue(it) === 0 }"
        :title="tipOf(it)"
        @click="emit('pick', it.label)"
      >
        <span v-if="showValue" class="bar-value">{{ compactOf(totalValue(it)) }}</span>
        <div class="bar-track">
          <div class="bar-stack" :style="{ height: percentOf(it) }">
            <div class="bar-seg refunded" :style="{ height: refundHeightOf(it) }" />
            <div class="bar-seg paid" />
          </div>
        </div>
        <span class="bar-label">{{ it.label }}</span>
      </div>
    </div>
    <div v-if="showLegend" class="bar-legend">
      <span class="chip paid" />支付成功
      <span class="chip refunded" />退款
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/** 与 utils/order-stats 的 Bucket 结构兼容（只取画图要用的字段） */
interface BarItem {
  label: string
  paidCount: number
  paidAmount: number
  refundCount: number
  refundAmount: number
}

const props = withDefaults(
  defineProps<{
    items: BarItem[]
    /** 取值维度 */
    metric?: 'count' | 'amount'
    /** 高亮的标签（如当前统计年份） */
    activeLabel?: string
    /** 柱顶显示数值 */
    showValue?: boolean
    /** 底部图例（支付成功 / 退款） */
    showLegend?: boolean
    /** 绘图区高度（不含标签行） */
    height?: number
  }>(),
  { metric: 'count', activeLabel: '', showValue: false, showLegend: true, height: 148 }
)

const emit = defineEmits<{ pick: [label: string] }>()

function paidValue(item: BarItem): number {
  return props.metric === 'amount' ? item.paidAmount : item.paidCount
}

function refundValue(item: BarItem): number {
  return props.metric === 'amount' ? item.refundAmount : item.refundCount
}

function totalValue(item: BarItem): number {
  return paidValue(item) + refundValue(item)
}

const max = computed(() => {
  const top = Math.max(0, ...props.items.map((it) => totalValue(it)))
  return top || 1
})

/** 非零值至少给 2% 高度，否则「1 单」看起来像没有 */
function percentOf(item: BarItem): string {
  const v = totalValue(item)
  if (v <= 0) return '0%'
  return `${Math.max((v / max.value) * 100, 2)}%`
}

/** 退款段在整根柱子里的占比；极小值给 1.5% 保底，不然退款看不见 */
function refundHeightOf(item: BarItem): string {
  const total = totalValue(item)
  if (total <= 0) return '0%'
  const ratio = refundValue(item) / total
  if (ratio <= 0) return '0%'
  return `${Math.max(ratio * 100, 1.5)}%`
}

function money(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function compactOf(n: number): string {
  if (props.metric !== 'amount') return String(n)
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(Math.round(n))
}

function tipOf(item: BarItem): string {
  return [
    `${item.label}`,
    `支付成功 ${item.paidCount} 单 · ${money(item.paidAmount)}`,
    `退款 ${item.refundCount} 单 · ${money(item.refundAmount)}`
  ].join('\n')
}
</script>

<style scoped>
.bar-chart {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 4px 2px 0;
}

.bar-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: default;
  border-radius: 4px;
  transition: background 0.15s;
}

.bar-col:not(.empty):hover {
  background: var(--el-fill-color-light);
}

.bar-value {
  flex: none;
  font-size: 10px;
  line-height: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.bar-track {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bar-stack {
  width: 62%;
  max-width: 34px;
  min-height: 2px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
  transition: height 0.35s ease;
}

.bar-seg {
  width: 100%;
  flex: none;
}

.bar-seg.paid {
  flex: 1 1 auto;
  min-height: 0;
  background: linear-gradient(180deg, var(--el-color-primary-light-3), var(--el-color-primary));
}

.bar-seg.refunded {
  background: var(--el-color-danger-light-3);
}

.bar-col.empty .bar-stack {
  min-height: 0;
  background: var(--el-border-color-lighter);
}

.bar-col.active .bar-seg.paid {
  background: linear-gradient(180deg, var(--el-color-warning-light-3), var(--el-color-warning));
}

.bar-col:hover .bar-stack {
  filter: brightness(1.06);
}

.bar-label {
  flex: none;
  font-size: 10px;
  line-height: 14px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.bar-col.active .bar-label {
  color: var(--el-color-warning-dark-2);
  font-weight: 600;
}

.bar-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
}

.chip {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-left: 6px;
}

.chip.paid {
  background: var(--el-color-primary);
}

.chip.refunded {
  background: var(--el-color-danger-light-3);
}
</style>
