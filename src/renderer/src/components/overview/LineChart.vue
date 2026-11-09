<template>
  <div ref="wrap" class="line-chart" :style="{ height: `${height}px` }">
    <svg
      v-if="width > 0 && hasData"
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      @mousemove="onMove"
      @mouseleave="hoverIndex = -1"
    >
      <!-- 横向网格线 + Y 轴刻度 -->
      <g v-for="(gv, gi) in gridLines" :key="gi">
        <line
          :x1="padL"
          :x2="width - padR"
          :y1="yOf(gv)"
          :y2="yOf(gv)"
          class="grid-line"
        />
        <text :x="padL - 6" :y="yOf(gv) + 3" class="axis-text" text-anchor="end">
          {{ compactOf(gv) }}
        </text>
      </g>

      <!-- 序列折线 + 数据点 -->
      <g v-for="(s, si) in series" :key="s.name">
        <polyline
          :points="s.points.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ')"
          :class="`line seg-${si}`"
          fill="none"
        />
        <circle
          v-for="(v, i) in s.points"
          :key="i"
          :cx="xOf(i)"
          :cy="yOf(v)"
          :r="hoverIndex === i ? 4 : 2.5"
          :class="`dot seg-${si}`"
        >
          <title>{{ tipOf(s, i) }}</title>
        </circle>
      </g>

      <!-- hover 竖线 -->
      <line
        v-if="hoverIndex >= 0"
        :x1="xOf(hoverIndex)"
        :x2="xOf(hoverIndex)"
        :y1="padT"
        :y2="height - padB"
        class="hover-line"
      />

      <!-- X 轴标签（点多时隔一显示，避免挤成叠字） -->
      <text
        v-for="(lb, i) in labels"
        v-show="labelStep <= 1 || i % labelStep === 0"
        :key="lb"
        :x="xOf(i)"
        :y="height - 6"
        class="axis-text"
        text-anchor="middle"
      >
        {{ shortLabel(lb) }}
      </text>
    </svg>
    <div v-else class="line-empty">暂无趋势数据</div>
    <div v-if="showLegend && hasData" class="line-legend">
      <span v-for="(s, si) in series" :key="s.name" class="legend-item">
        <i :class="`chip seg-${si}`" />{{ s.name }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 通用多序列折线图（SVG 手绘，与 BarChart/DonutChart 同风格，不引第三方图表库）。
 *
 * 用途：趋势仪表盘的月度金额/单量走势（双序列）、平台对比的各平台月度曲线（多序列）。
 * 宽度用 ResizeObserver 跟随容器 —— viewBox 固定会被 preserveAspectRatio 拉变形，文字会糊。
 */
export interface LineSeries {
  /** 图例名（如「交易成功」「淘宝」） */
  name: string
  /** 与 labels 一一对应的数值（0 允许，空数据点暂不支持） */
  points: number[]
}

const props = withDefaults(
  defineProps<{
    series: LineSeries[]
    labels: string[]
    /** 取值维度：金额时 Y 轴按万紧凑显示 */
    metric?: 'count' | 'amount'
    height?: number
    showLegend?: boolean
  }>(),
  { metric: 'amount', height: 190, showLegend: true }
)

const wrap = ref<HTMLElement | null>(null)
const width = ref(0)
let ro: ResizeObserver | null = null

onMounted(() => {
  const el = wrap.value
  if (!el) return
  // 初始宽度主动量一次：规范说 observe 会立即回调一次，但实测个别环境（内嵌浏览器）
  // 不发初始通知 —— 不能把首帧押在 RO 上
  width.value = Math.floor(el.clientWidth)
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? el.clientWidth
    width.value = Math.floor(w)
  })
  ro.observe(el)
})
onBeforeUnmount(() => ro?.disconnect())

const padL = 52
const padR = 14
const padT = 14
const padB = 26

const hasData = computed(() => props.labels.length >= 2 && props.series.some((s) => s.points.length === props.labels.length))

/** x 轴点间距（首尾留 padding，点落在格心） */
function xOf(i: number): number {
  const inner = width.value - padL - padR
  const step = props.labels.length > 1 ? inner / (props.labels.length - 1) : inner
  return padL + i * step
}

const maxVal = computed(() => {
  let top = 0
  for (const s of props.series) for (const v of s.points) if (v > top) top = v
  return top || 1
})

/** Y 轴网格：4 段，刻度取「好看」的整数（1/2/5×10^k） */
const yMax = computed(() => {
  const raw = maxVal.value
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) {
    const v = m * exp
    if (v >= raw) return v
  }
  return raw
})

const gridLines = computed(() => [0, 0.25, 0.5, 0.75, 1].map((r) => yMax.value * r))

function yOf(v: number): number {
  const h = props.height - padT - padB
  return padT + h * (1 - v / yMax.value)
}

/** x 标签抽稀：至少 42px 一个标签 */
const labelStep = computed(() => {
  if (width.value <= 0) return 1
  const inner = width.value - padL - padR
  const step = props.labels.length > 1 ? inner / (props.labels.length - 1) : inner
  return Math.max(1, Math.ceil(42 / Math.max(step, 1)))
})

function shortLabel(lb: string): string {
  // `2026-01` → `1月`（同年）或 `26/1`（跨年首月）：趋势图横轴只需要月份感
  const m = /^(\d{4})-(\d{1,2})$/.exec(lb)
  if (!m) return lb
  return props.labels[0] === lb ? `${m[1].slice(2)}/${m[2]}` : `${Number(m[2])}月`
}

function compactOf(n: number): string {
  if (props.metric !== 'amount') return String(Math.round(n))
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(Math.round(n))
}

function money(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function valueOf(v: number): string {
  return props.metric === 'amount' ? money(v) : `${v} 单`
}

function tipOf(s: LineSeries, i: number): string {
  return `${props.labels[i]} · ${s.name}：${valueOf(s.points[i] ?? 0)}`
}

// hover：竖线跟随鼠标吸附最近的数据点；圆点上挂原生 <title> 提示数值
const hoverIndex = ref(-1)

function onMove(e: MouseEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const x = e.clientX - rect.left
  const inner = width.value - padL - padR
  const step = props.labels.length > 1 ? inner / (props.labels.length - 1) : inner
  const i = Math.round((x - padL) / step)
  hoverIndex.value = i >= 0 && i < props.labels.length ? i : -1
}
</script>

<style scoped>
.line-chart {
  width: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.line-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.grid-line {
  stroke: var(--el-border-color-lighter);
  stroke-width: 1;
}

.axis-text {
  fill: var(--el-text-color-secondary);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.line {
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.dot {
  stroke: var(--el-bg-color);
  stroke-width: 1.5;
}

.hover-line {
  stroke: var(--el-border-color);
  stroke-dasharray: 3 3;
}

/* 序列配色：与 BarChart 的 paid/refunded 色一致，更多序列顺延 Element Plus 色板 */
.line.seg-0,
.dot.seg-0 {
  stroke: var(--el-color-primary);
}
.dot.seg-0 {
  fill: var(--el-color-primary);
}
.line.seg-1,
.dot.seg-1 {
  stroke: var(--el-color-danger);
}
.dot.seg-1 {
  fill: var(--el-color-danger);
}
.line.seg-2,
.dot.seg-2 {
  stroke: var(--el-color-success);
}
.dot.seg-2 {
  fill: var(--el-color-success);
}
.line.seg-3,
.dot.seg-3 {
  stroke: var(--el-color-warning);
}
.dot.seg-3 {
  fill: var(--el-color-warning);
}
.line.seg-4,
.dot.seg-4 {
  stroke: var(--el-color-info);
}
.dot.seg-4 {
  fill: var(--el-color-info);
}

.line-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chip {
  width: 10px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}

.chip.seg-0 {
  background: var(--el-color-primary);
}
.chip.seg-1 {
  background: var(--el-color-danger);
}
.chip.seg-2 {
  background: var(--el-color-success);
}
.chip.seg-3 {
  background: var(--el-color-warning);
}
.chip.seg-4 {
  background: var(--el-color-info);
}
</style>
