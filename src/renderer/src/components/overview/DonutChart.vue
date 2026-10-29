<template>
  <div class="donut">
    <div class="donut-ring">
      <svg viewBox="0 0 160 160" class="ring-svg">
        <circle cx="80" cy="80" :r="R" fill="none" stroke="var(--el-fill-color-light)" :stroke-width="W" />
        <circle
          v-for="seg in segments"
          :key="seg.label"
          cx="80"
          cy="80"
          :r="R"
          fill="none"
          :stroke="seg.color"
          :stroke-width="W"
          :stroke-dasharray="seg.dash"
          :stroke-dashoffset="seg.offset"
          stroke-linecap="butt"
          transform="rotate(-90 80 80)"
        >
          <title>{{ seg.tip }}</title>
        </circle>
      </svg>
      <div class="ring-center">
        <span class="ring-total">{{ centerValue }}</span>
        <span class="ring-unit">{{ centerLabel }}</span>
      </div>
    </div>
    <ul class="legend">
      <li v-for="seg in segments" :key="seg.label" class="legend-item">
        <span class="dot" :style="{ background: seg.color }" />
        <span class="legend-name">{{ seg.label }}</span>
        <span class="legend-value">{{ seg.short }}</span>
        <span class="legend-pct">{{ seg.percent }}</span>
      </li>
      <li v-if="!segments.length" class="legend-empty">暂无数据</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface DonutItem {
  label: string
  value: number
  count: number
  amount: number
}

const props = withDefaults(
  defineProps<{
    items: DonutItem[]
    /** 中心大数字（已格式化） */
    centerValue?: string
    centerLabel?: string
    /** 图例数值形态 */
    metric?: 'count' | 'amount'
  }>(),
  { centerValue: '', centerLabel: '', metric: 'count' }
)

const R = 58
const W = 18
const CIRC = 2 * Math.PI * R

const PALETTE = [
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#8b7bf0',
  '#36cfc9',
  '#ff85c0',
  '#909399'
]

const segments = computed(() => {
  const total = props.items.reduce((sum, it) => sum + Math.max(it.value, 0), 0)
  if (!total) return []
  let acc = 0
  return props.items
    .filter((it) => it.value > 0)
    .map((it, i) => {
      const frac = it.value / total
      const len = Math.max(frac * CIRC - 1.5, 0.5)
      const seg = {
        label: it.label,
        color: PALETTE[i % PALETTE.length],
        dash: `${len} ${CIRC}`,
        offset: `${-acc * CIRC}`,
        percent: `${(frac * 100).toFixed(frac < 0.1 ? 1 : 0)}%`,
        short: props.metric === 'amount' ? moneyShort(it.amount) : `${it.count} 单`,
        tip: `${it.label}：${it.count} 单 · ${moneyFull(it.amount)}（${(frac * 100).toFixed(1)}%）`
      }
      acc += frac
      return seg
    })
})

function moneyFull(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function moneyShort(n: number): string {
  if (n >= 10000) return `¥${(n / 10000).toFixed(2)}万`
  return `¥${Math.round(n).toLocaleString('zh-CN')}`
}
</script>

<style scoped>
.donut {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 0;
}

.donut-ring {
  position: relative;
  flex: none;
  width: 132px;
  height: 132px;
}

.ring-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  pointer-events: none;
}

.ring-total {
  font-size: 19px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.ring-unit {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.legend {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 140px;
  overflow-y: auto;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--el-text-color-regular);
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 2px;
}

.legend-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend-value {
  flex: none;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.legend-pct {
  flex: none;
  width: 38px;
  text-align: right;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.legend-empty {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
