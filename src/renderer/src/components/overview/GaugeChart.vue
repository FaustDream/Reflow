<template>
  <div class="gauge">
    <svg viewBox="0 0 180 138" class="gauge-svg">
      <!-- 刻度：240° 弧上均分 9 档，纯装饰，用来读「大致在哪个量级」 -->
      <line
        v-for="t in ticks"
        :key="t.key"
        :x1="t.x1"
        :y1="t.y1"
        :x2="t.x2"
        :y2="t.y2"
        stroke="var(--el-border-color)"
        stroke-width="1"
        stroke-linecap="round"
      />
      <path :d="trackPath" fill="none" stroke="var(--el-fill-color)" :stroke-width="SW" stroke-linecap="round" />
      <path
        :d="valuePath"
        fill="none"
        :stroke="color"
        :stroke-width="SW"
        stroke-linecap="round"
        class="gauge-value-arc"
      />
      <circle :cx="knob.x" :cy="knob.y" r="4.5" :fill="color" stroke="#fff" stroke-width="2" />
      <text x="90" y="84" text-anchor="middle" class="gauge-num">{{ display }}</text>
      <text x="90" y="104" text-anchor="middle" class="gauge-label">{{ label }}</text>
    </svg>
    <p v-if="hint" class="gauge-hint">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 0–1 */
    value: number
    /** 弧中央数字（已格式化，如 `38%`） */
    display: string
    label?: string
    hint?: string
    color?: string
  }>(),
  { label: '', hint: '', color: '#409eff' }
)

const CX = 90
const CY = 90
const R = 64
const SW = 14
const START = 150
const SWEEP = 240

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) }
}

function arcPath(fromDeg: number, toDeg: number): string {
  const a = polar(fromDeg, R)
  const b = polar(toDeg, R)
  const large = toDeg - fromDeg > 180 ? 1 : 0
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

const ratio = computed(() => Math.min(Math.max(props.value, 0), 1))
const trackPath = computed(() => arcPath(START, START + SWEEP))
const valuePath = computed(() => {
  // 极小值也画一小段，避免弧长为 0 时圆头端点退化成圆点
  const deg = Math.max(SWEEP * ratio.value, 1.2)
  return arcPath(START, START + deg)
})

const knob = computed(() => polar(START + SWEEP * ratio.value, R))

const ticks = computed(() =>
  Array.from({ length: 9 }, (_, i) => {
    const deg = START + (SWEEP / 8) * i
    const inner = polar(deg, R - SW / 2 - 3)
    const outer = polar(deg, R - SW / 2 - 9)
    return { key: i, x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y }
  })
)
</script>

<style scoped>
.gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 100%;
}

.gauge-svg {
  width: 100%;
  max-width: 210px;
  display: block;
}

.gauge-value-arc {
  transition: stroke-dasharray 0.4s ease;
}

.gauge-num {
  font-size: 25px;
  font-weight: 600;
  fill: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.gauge-label {
  font-size: 11px;
  fill: var(--el-text-color-secondary);
}

.gauge-hint {
  margin: 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
</style>
