<template>
  <div class="overview">
    <div class="ov-head">
      <div class="ov-titles">
        <span class="ov-title">数据总览</span>
        <span class="ov-sub">{{ subtitle }}</span>
      </div>
      <div class="spacer" />
      <el-radio-group v-model="scope" size="small">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="shopping">网购</el-radio-button>
        <el-radio-button value="local">外卖</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="metric" size="small">
        <el-radio-button value="count">按单量</el-radio-button>
        <el-radio-button value="amount">按金额</el-radio-button>
      </el-radio-group>
      <el-select v-model="year" size="small" class="ov-year" placeholder="年份">
        <el-option v-for="y in years" :key="y" :label="`${y} 年`" :value="y" />
      </el-select>
    </div>

    <div class="ov-scroll">
      <el-empty
        v-if="!stats.totalCount"
        :description="emptyText"
        :image-size="80"
        class="ov-empty"
      />

      <template v-else>
        <div class="kpi-row">
          <div v-for="k in kpis" :key="k.label" class="kpi">
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-value">
              {{ k.value }}<small v-if="k.unit">{{ k.unit }}</small>
            </span>
            <span class="kpi-hint">{{ k.hint }}</span>
          </div>
        </div>

        <div class="ov-grid">
          <section class="card span2">
            <header class="card-head">
              <span>年度分布</span>
              <em>点柱形可切换统计年份</em>
            </header>
            <BarChart
              :items="stats.years"
              :metric="metric"
              :active-label="String(activeYear)"
              show-value
              :height="142"
              @pick="onPickYear"
            />
          </section>

          <section class="card">
            <header class="card-head"><span>平台占比</span><em>按支付成功</em></header>
            <DonutChart
              :items="donutItems"
              :metric="metric"
              :center-value="donutCenter"
              :center-label="metric === 'count' ? '支付单量' : '支付金额'"
            />
          </section>

          <section class="card span2">
            <header class="card-head">
              <span>{{ activeYear }} 年月度分布</span>
              <em>
                支付 {{ stats.year.paidCount }} 单 · ¥{{ money(stats.year.paidAmount) }} / 退款
                {{ stats.year.refundCount }} 单 · ¥{{ money(stats.year.refundAmount) }}
              </em>
            </header>
            <BarChart :items="stats.months" :metric="metric" show-value :height="142" />
          </section>

          <section class="card">
            <header class="card-head"><span>退款仪表</span></header>
            <GaugeChart
              :value="yearRefundRate"
              :display="pct(yearRefundRate)"
              :label="`${activeYear} 年退款率`"
              hint="退款金额 /（支付成功 + 退款）"
              color="#f56c6c"
            />
          </section>

          <section class="card span2">
            <header class="card-head">
              <span>{{ activeYear }} 年每日热力</span>
              <em>按支付成功单量着色，退款不计入</em>
            </header>
            <HeatCalendar :days="stats.days" :year="activeYear" />
          </section>

          <section class="card">
            <header class="card-head">
              <span>周内分布</span>
              <em>按周一至周日</em>
            </header>
            <BarChart :items="stats.weekdays" :metric="metric" show-value :height="118" />
          </section>

          <section class="card span2">
            <header class="card-head"><span>平台明细</span><em>支付与退款分开统计</em></header>
            <table class="mini-table">
              <thead>
                <tr>
                  <th>平台</th>
                  <th class="num">订单</th>
                  <th class="num">支付成功</th>
                  <th class="num col-refund">退款</th>
                  <th class="col-share">金额占比</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in stats.platforms" :key="p.key">
                  <td class="cell-name">{{ p.label }}</td>
                  <td class="num">{{ p.count }}</td>
                  <td class="num">¥{{ money(p.paidAmount) }}</td>
                  <td class="num col-refund" :class="{ refund: p.refundCount > 0 }">
                    {{ p.refundCount > 0 ? `¥${money(p.refundAmount)}` : '—' }}
                  </td>
                  <td class="share-cell">
                    <div class="share-wrap">
                      <span class="share-bar"><i :style="{ width: shareWidth(p.paidAmount) }" /></span>
                      <span class="share-pct">{{ pct(shareOf(p.paidAmount)) }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="card">
            <header class="card-head"><span>订单状态</span></header>
            <ul class="status-list">
              <li v-for="s in stats.statuses" :key="s.key">
                <span class="status-name" :title="s.label">{{ s.label }}</span>
                <span class="status-count">{{ s.count }}</span>
                <span class="status-bar" :class="outcomeClass(s.key)">
                  <i :style="{ width: statusWidth(s.count) }" />
                </span>
              </li>
              <li v-if="!stats.statuses.length" class="status-empty">暂无状态字段</li>
            </ul>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Order } from '@shared/types'
import BarChart from './BarChart.vue'
import DonutChart from './DonutChart.vue'
import GaugeChart from './GaugeChart.vue'
import HeatCalendar from './HeatCalendar.vue'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import {
  buildOverviewStats,
  filterByScope,
  groupByPlatform,
  outcomeOfStatus,
  parseYmd,
  platformKeyOf,
  splitLocalLife
} from '@renderer/utils/order-stats'

const props = defineProps<{
  /** 只统计这些平台（由侧栏传入当前显示的平台，下架平台不参与统计） */
  platformIds?: string[]
}>()

const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()

/** 图表的取值维度：单量 / 金额 */
const metric = ref<'count' | 'amount'>('count')
/** 统计口径：全部 / 只看网购 / 只看外卖 */
const scope = ref<'all' | 'shopping' | 'local'>('all')

/** 平台 id → 展示名（适配器没注册时退回 id，总比空着好） */
function nameOf(platformId: string): string {
  return platformsStore.adapters.find((a) => a.id === platformId)?.displayName ?? platformId
}

/** 按业务线拆好的全部分组：网购平台在前，外卖平台在后 */
const splitGroups = computed(() => {
  const allowed = props.platformIds ? new Set(props.platformIds) : null
  const source: Record<string, Order[]> = {}
  for (const [id, list] of Object.entries(ordersStore.byPlatform)) {
    // 下架平台（如已移除的美团外卖）本地还留着历史缓存，但不能算进总览
    if (allowed && !allowed.has(platformKeyOf(id))) continue
    source[id] = list
  }
  // 京东/淘宝里的外卖单独立成「京东外卖 / 淘宝外卖」，和购物分开统计
  return splitLocalLife(groupByPlatform(source, nameOf))
})

const groups = computed(() => filterByScope(splitGroups.value, scope.value))

const years = computed(() => {
  const set = new Set<number>()
  for (const g of groups.value) {
    for (const o of g.orders) {
      const y = parseYmd(o.createdAt)?.y
      if (y) set.add(y)
    }
  }
  return [...set].sort((a, b) => b - a)
})

const year = ref<number | null>(null)
watch(
  years,
  (list) => {
    if (!list.length) return
    if (year.value === null || !list.includes(year.value)) year.value = list[0]
  },
  { immediate: true }
)

const activeYear = computed(() => year.value ?? years.value[0] ?? new Date().getFullYear())
const stats = computed(() => buildOverviewStats(groups.value, activeYear.value))

const emptyText = computed(() =>
  scope.value === 'local'
    ? '没有外卖订单 —— 外卖单从京东/淘宝的订单里自动识别，抓到后就会出现在这里'
    : '还没有订单数据 —— 先在左侧选一个平台登录，抓到订单后这里就会出现图表'
)

const subtitle = computed(() => {
  const s = stats.value
  const scopeText = scope.value === 'local' ? '外卖' : scope.value === 'shopping' ? '网购' : '全部'
  if (!s.totalCount) return `${scopeText} · 暂无数据`
  const range = s.firstDate ? `${s.firstDate} 至 ${s.lastDate}` : '无下单时间'
  return `${scopeText} · ${s.platforms.length} 个平台 · 支付成功 ${s.paidCount} 单 / 退款 ${s.refundCount} 单 · ${range}`
})

// ---- 格式化 ----
function money(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function moneyShort(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`
  return n.toFixed(2)
}

/** 环形图中心用：更短，别把圆撑破 */
function compactMoney(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return n.toFixed(0)
}

function pct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%'
  return `${(v * 100).toFixed(v < 0.01 ? 1 : 0)}%`
}

/** 状态条按交易结果上色：退款红、关闭灰 */
function outcomeClass(status: string): string {
  const kind = outcomeOfStatus(status)
  return kind === 'refunded' ? 'is-refund' : kind === 'closed' ? 'is-closed' : 'is-paid'
}

// ---- KPI ----
const kpis = computed(() => {
  const s = stats.value
  return [
    {
      label: '总订单',
      value: s.totalCount.toLocaleString('zh-CN'),
      unit: '单',
      hint: `${s.platforms.length} 个平台 · 另有 ${s.closedCount} 单关闭/取消`
    },
    {
      label: '支付成功',
      value: `¥${moneyShort(s.paidAmount)}`,
      unit: '',
      hint: `${s.paidCount} 单 · 平均每单 ¥${money(s.avgPaid)}`
    },
    {
      label: '已退款',
      value: `¥${moneyShort(s.refundAmount)}`,
      unit: '',
      hint: `${s.refundCount} 单 · 退款率 ${pct(s.refundRate)}`
    },
    {
      label: '覆盖天数',
      value: String(s.activeDays),
      unit: '天',
      hint: s.firstDate ? `${s.firstDate} ~ ${s.lastDate}` : '暂无下单时间'
    },
    {
      label: `${s.monthYear} 年支付`,
      value: `¥${moneyShort(s.year.paidAmount)}`,
      unit: '',
      hint: `${s.year.paidCount} 单 · 退款 ${s.year.refundCount} 单`
    }
  ]
})

// ---- 图表数据 ----
const donutItems = computed(() =>
  stats.value.platforms.map((p) => ({
    label: p.label,
    value: metric.value === 'count' ? p.paidCount : p.paidAmount,
    count: p.paidCount,
    amount: p.paidAmount
  }))
)

const donutCenter = computed(() =>
  metric.value === 'count'
    ? stats.value.paidCount.toLocaleString('zh-CN')
    : `¥${compactMoney(stats.value.paidAmount)}`
)

/** 当前年份的退款率（仪表盘） */
const yearRefundRate = computed(() => {
  const y = stats.value.year
  const denom = y.paidAmount + y.refundAmount
  return denom ? y.refundAmount / denom : 0
})

function onPickYear(label: string): void {
  const n = Number(label)
  if (Number.isFinite(n) && n > 0) year.value = n
}

// ---- 平台明细 / 状态条 ----
const maxPlatformPaid = computed(() =>
  stats.value.platforms.reduce((top, p) => Math.max(top, p.paidAmount), 0)
)

function shareOf(amount: number): number {
  const total = stats.value.paidAmount
  return total ? amount / total : 0
}

function shareWidth(amount: number): string {
  const top = maxPlatformPaid.value
  if (!top) return '0%'
  return `${Math.max((amount / top) * 100, amount > 0 ? 2 : 0)}%`
}

const maxStatusCount = computed(() =>
  stats.value.statuses.reduce((top, s) => Math.max(top, s.count), 0)
)

function statusWidth(count: number): string {
  const top = maxStatusCount.value
  if (!top) return '0%'
  return `${Math.max((count / top) * 100, 2)}%`
}
</script>

<style scoped>
.overview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ov-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex: none;
}

.ov-titles {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.ov-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.ov-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-year {
  width: 104px;
  flex: none;
}

.spacer {
  flex: 1;
}

.ov-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.ov-empty {
  padding-top: 40px;
}

/* ---- KPI ---- */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  min-width: 0;
}

.kpi-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.kpi-value {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-value small {
  margin-left: 3px;
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.kpi-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 卡片网格 ---- */
.ov-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding-bottom: 4px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  min-width: 0;
}

.span2 {
  grid-column: span 2;
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: none;
}

.card-head span {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.card-head em {
  font-size: 11px;
  font-style: normal;
  color: var(--el-text-color-placeholder);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 环形图撑满卡片剩余高度，避免同一行里它比旁边的柱状图矮一截、底部留空 */
.card :deep(.donut) {
  flex: 1;
}

/* ---- 平台明细 ---- */
.mini-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.mini-table th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  padding: 0 8px 4px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.mini-table td {
  padding: 5px 8px 5px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}

.mini-table tr:last-child td {
  border-bottom: none;
}

.mini-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mini-table .refund {
  color: var(--el-color-danger);
}

/* 退款列固定宽度：内容只有「—」时列会被挤窄，表头贴到「金额占比」上 */
.col-refund {
  width: 96px;
  padding-right: 14px !important;
}

.cell-name {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.col-share {
  width: 30%;
  text-align: left;
  padding-left: 14px !important;
}

/* td 不能直接 display:flex —— 会脱离表格列宽，表头与单元格对不上 */
.share-cell {
  width: 30%;
}

.share-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.share-bar {
  flex: 1;
  min-width: 30px;
  height: 5px;
  border-radius: 3px;
  background: var(--el-fill-color-light);
  overflow: hidden;
}

.share-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--el-color-primary);
}

.share-pct {
  flex: none;
  width: 40px;
  text-align: right;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---- 状态列表 ---- */
.status-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}

.status-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px 64px;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--el-text-color-regular);
}

.status-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-count {
  text-align: right;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.status-bar {
  height: 5px;
  border-radius: 3px;
  background: var(--el-fill-color-light);
  overflow: hidden;
}

.status-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--el-color-success);
}

.status-bar.is-refund i {
  background: var(--el-color-danger);
}

.status-bar.is-closed i {
  background: var(--el-text-color-placeholder);
}

.status-empty {
  display: block !important;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

@media (max-width: 1100px) {
  .kpi-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
