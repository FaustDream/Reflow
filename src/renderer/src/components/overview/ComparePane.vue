<template>
  <div class="compare">
    <div class="pane-head">
      <div class="pane-titles">
        <span class="pane-title">平台对比</span>
        <span class="pane-sub">{{ subtitle }}</span>
      </div>
      <div class="spacer" />
      <el-radio-group v-model="metric" size="small">
        <el-radio-button value="amount">按金额</el-radio-button>
        <el-radio-button value="count">按单量</el-radio-button>
      </el-radio-group>
      <el-button size="small" :loading="exporting" @click="onExportStats">
        <el-icon v-if="!exporting"><Download /></el-icon>
        导出统计报表
      </el-button>
    </div>

    <el-empty v-if="!platformBuckets.length" description="暂无订单数据" :image-size="80" />

    <template v-else>
      <div class="kpi-row">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <span class="kpi-label">{{ k.label }}</span>
          <span class="kpi-value">{{ k.value }}<small v-if="k.unit">{{ k.unit }}</small></span>
          <span class="kpi-hint">{{ k.hint }}</span>
        </div>
      </div>

      <div class="pane-grid">
        <section class="card span2">
          <header class="card-head">
            <span>各平台月度走势（近 12 个月）</span>
            <em>折线悬停可看每月数值</em>
          </header>
          <LineChart :series="platformSeries" :labels="platformLabels" :metric="metric" :height="220" />
        </section>

        <section class="card">
          <header class="card-head"><span>金额占比</span><em>按交易成功金额</em></header>
          <DonutChart
            :items="donutItems"
            :center-label="metric === 'count' ? '成功单量' : '成功金额'"
          />
        </section>

        <section class="card span3">
          <header class="card-head"><span>平台指标矩阵</span><em>金额口径 = 交易成功（2026-11-08）</em></header>
          <table class="matrix">
            <thead>
              <tr>
                <th>平台</th>
                <th class="num">订单总数</th>
                <th class="num">交易成功</th>
                <th class="num">已完成金额</th>
                <th class="num">客单价</th>
                <th class="num">退款金额</th>
                <th class="num">退款率</th>
                <th class="bar-col">金额占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in platformRows" :key="p.label">
                <td class="p-name">{{ p.label }}</td>
                <td class="num">{{ p.count }}</td>
                <td class="num">{{ p.paidCount }}</td>
                <td class="num">¥{{ money(p.paidAmount) }}</td>
                <td class="num">{{ p.avgPaid ? `¥${money(p.avgPaid)}` : '—' }}</td>
                <td class="num">{{ p.refundAmount ? `¥${money(p.refundAmount)}` : '—' }}</td>
                <td class="num">{{ p.refundRate ? pct(p.refundRate) : '—' }}</td>
                <td class="bar-col">
                  <span class="share-bar"><i :style="{ width: sharePct(p.paidAmount) }" /></span>
                  <span class="share-num">{{ sharePct(p.paidAmount) }}</span>
                </td>
              </tr>
              <tr class="total-row">
                <td>合计</td>
                <td class="num">{{ totalRow.count }}</td>
                <td class="num">{{ totalRow.paidCount }}</td>
                <td class="num">¥{{ money(totalRow.paidAmount) }}</td>
                <td class="num">¥{{ money(totalRow.avgPaid) }}</td>
                <td class="num">¥{{ money(totalRow.refundAmount) }}</td>
                <td class="num">{{ totalRow.refundRate ? pct(totalRow.refundRate) : '—' }}</td>
                <td class="bar-col">100%</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import type { Order } from '@shared/types'
import {
  buildMonthlyTrend,
  buildOverviewStats,
  groupByPlatform,
} from '@renderer/utils/order-stats'
import LineChart, { type LineSeries } from './LineChart.vue'
import DonutChart from './DonutChart.vue'

/**
 * 平台对比仪表盘（2026-11-08）：平台维度的第三个总览视图。
 * 各平台月度走势折线（多序列）+ 金额占比环图 + 关键指标矩阵
 * （单量 / 已完成金额 / 客单价 / 退款率），一键导出统计报表 Excel。
 */
const props = defineProps<{
  platformIds?: string[]
}>()

const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()
const metric = ref<'count' | 'amount'>('amount')
const exporting = ref(false)

function nameOf(platformId: string): string {
  return platformsStore.adapters.find((a) => a.id === platformId)?.displayName ?? platformId
}

/** 与数据总览同源：外卖独立成组（京东外卖/淘宝外卖），对比才有意义 */
const groups = computed(() => {
  const allowed = props.platformIds ? new Set(props.platformIds) : null
  const source: Record<string, Order[]> = {}
  for (const [id, list] of Object.entries(ordersStore.byPlatform)) {
    if (allowed && !allowed.has(id)) continue
    source[id] = list
  }
  return groupByPlatform(source, nameOf)
})

const stats = computed(() => buildOverviewStats(groups.value, null))
const platformBuckets = computed(() => stats.value.platforms)

const donutItems = computed(() =>
  platformBuckets.value.map((p) => ({
    label: p.label,
    value: metric.value === 'count' ? p.paidCount : p.paidAmount,
    count: p.paidCount,
    amount: p.paidAmount
  }))
)

/** 各平台近 12 个月序列（多序列折线：一个平台一条线） */
const platformTrend = computed(() => buildMonthlyTrend(groups.value, 12))
const platformLabels = computed(() => platformTrend.value.map((b) => b.label))
const platformSeries = computed<LineSeries[]>(() => {
  const labels = platformLabels.value
  if (!labels.length) return []
  // 逐分组单独跑趋势（同一起始月），再按月份标签对齐成每平台的点列
  return groups.value.map((g) => {
    const byKey = new Map(buildMonthlyTrend([g], labels.length).map((b) => [b.label, b]))
    return {
      name: g.name,
      points: labels.map((lb) => {
        const b = byKey.get(lb)
        return b ? (metric.value === 'amount' ? b.paidAmount : b.paidCount) : 0
      })
    }
  })
})

const platformRows = computed(() =>
  platformBuckets.value.map((p) => ({
    label: p.label,
    count: p.count,
    paidCount: p.paidCount,
    paidAmount: p.paidAmount,
    avgPaid: p.paidCount ? p.paidAmount / p.paidCount : 0,
    refundCount: p.refundCount,
    refundAmount: p.refundAmount,
    refundRate:
      p.paidAmount + p.refundAmount > 0 ? p.refundAmount / (p.paidAmount + p.refundAmount) : 0
  }))
)

const totalRow = computed(() => ({
  count: stats.value.totalCount,
  paidCount: stats.value.paidCount,
  paidAmount: stats.value.paidAmount,
  avgPaid: stats.value.paidCount ? stats.value.paidAmount / stats.value.paidCount : 0,
  refundAmount: stats.value.refundAmount,
  refundRate:
    stats.value.paidAmount + stats.value.refundAmount > 0
      ? stats.value.refundAmount / (stats.value.paidAmount + stats.value.refundAmount)
      : 0
}))

function sharePct(amount: number): string {
  const denom = stats.value.paidAmount
  if (!denom) return '0%'
  return `${Math.round((amount / denom) * 1000) / 10}%`
}

function pct(n: number): string {
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`
}

function money(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const subtitle = computed(() => `${platformBuckets.value.length} 个平台分组 · 交易成功 ${stats.value.paidCount.toLocaleString('zh-CN')} 单`)

const kpis = computed(() => {
  const top = platformBuckets.value[0]
  const rates = platformRows.value.filter((p) => p.refundRate > 0)
  const riskiest = rates.reduce<(typeof platformRows.value)[number] | null>(
    (best, p) => (!best || p.refundRate > best.refundRate ? p : best),
    null
  )
  const bestAvg = platformRows.value
    .filter((p) => p.avgPaid > 0)
    .reduce<(typeof platformRows.value)[number] | null>(
      (best, p) => (!best || p.avgPaid > best.avgPaid ? p : best),
      null
    )
  return [
    {
      label: '平台分组数',
      value: String(platformBuckets.value.length),
      unit: '个',
      hint: top ? `金额最高：${top.label}` : '暂无'
    },
    {
      label: '已完成总额',
      value: `¥${wan(stats.value.paidAmount)}`,
      unit: '',
      hint: `平均客单价 ¥${money(stats.value.paidCount ? stats.value.paidAmount / stats.value.paidCount : 0)}`
    },
    {
      label: '客单价最高',
      value: bestAvg ? `¥${money(bestAvg.avgPaid)}` : '—',
      unit: '',
      hint: bestAvg ? bestAvg.label : '暂无'
    },
    {
      label: '退款率最高',
      value: riskiest ? pct(riskiest.refundRate) : '—',
      unit: '',
      hint: riskiest ? `${riskiest.label} · ¥${money(riskiest.refundAmount)}` : '暂无退款'
    }
  ]
})

function wan(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

async function onExportStats(): Promise<void> {
  exporting.value = true
  try {
    const res = await window.api.exportStatsExcel({
      fileName: `Reflow_平台对比_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets: [
        {
          name: '平台指标',
          headers: ['平台', '订单总数', '交易成功单数', '已完成金额', '客单价', '退款单数', '退款金额', '退款率'],
          rows: [
            ...platformRows.value.map((p) => [
              p.label,
              p.count,
              p.paidCount,
              Math.round(p.paidAmount * 100) / 100,
              Math.round(p.avgPaid * 100) / 100,
              p.refundCount,
              Math.round(p.refundAmount * 100) / 100,
              pct(p.refundRate)
            ]),
            [
              '合计',
              totalRow.value.count,
              totalRow.value.paidCount,
              Math.round(totalRow.value.paidAmount * 100) / 100,
              Math.round(totalRow.value.avgPaid * 100) / 100,
              stats.value.refundCount,
              Math.round(totalRow.value.refundAmount * 100) / 100,
              pct(totalRow.value.refundRate)
            ]
          ],
          boldLast: true
        },
        {
          name: '月度走势',
          headers: ['月份', ...platformBuckets.value.map((p) => p.label)],
          rows: buildPerPlatformMonthlyRows(),
          boldLast: false
        }
      ]
    })
    if (res.ok) ElMessage.success(`统计报表已导出：${res.path}`)
    else if (!res.cancelled) ElMessage.warning(res.message ?? '导出失败')
  } catch (err) {
    ElMessage.warning(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    exporting.value = false
  }
}

/** 每平台单独跑一次月度趋势，按月份标签对齐成矩阵行（行=月，列=平台） */
function buildPerPlatformMonthlyRows(): Array<Array<string | number>> {
  const per = new Map<string, Map<string, number>>()
  const labels = platformLabels.value
  for (const g of groups.value) {
    const t = buildMonthlyTrend([g], 12)
    const m = new Map<string, number>()
    t.forEach((b, i) => m.set(labels[i] ?? b.label, metric.value === 'amount' ? b.paidAmount : b.paidCount))
    per.set(g.name, m)
  }
  return labels.map((lb) => [lb, ...platformBuckets.value.map((p) => per.get(p.label)?.get(lb) ?? 0)])
}
</script>

<style scoped>
.compare {
  height: 100%;
  overflow-y: auto;
  padding: 14px 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pane-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}

.pane-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pane-title {
  font-size: 16px;
  font-weight: 600;
}

.pane-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.spacer {
  flex: 1;
}

.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  flex: none;
}

.kpi {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.kpi-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.kpi-value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.kpi-value small {
  font-size: 11px;
  font-weight: 400;
  margin-left: 2px;
  color: var(--el-text-color-secondary);
}

.kpi-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.pane-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px 12px;
  min-width: 0;
}

.card.span2 {
  grid-column: span 2;
}

.card.span3 {
  grid-column: span 3;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.card-head span {
  font-size: 13px;
  font-weight: 600;
}

.card-head em {
  font-style: normal;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.matrix th,
.matrix td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  text-align: left;
  white-space: nowrap;
}

.matrix th {
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.matrix .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.matrix .p-name {
  font-weight: 600;
}

.matrix tbody tr:last-child td {
  border-bottom: none;
}

.total-row td {
  font-weight: 600;
  border-top: 1px solid var(--el-border-color) !important;
}

.bar-col {
  min-width: 120px;
}

.share-bar {
  display: inline-block;
  width: 90px;
  height: 6px;
  border-radius: 3px;
  background: var(--el-fill-color-light);
  overflow: hidden;
  vertical-align: middle;
  margin-right: 6px;
}

.share-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--el-color-primary-light-3), var(--el-color-primary));
}

.share-num {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
</style>
