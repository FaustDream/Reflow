<template>
  <div class="trends">
    <div class="pane-head">
      <div class="pane-titles">
        <span class="pane-title">趋势分析</span>
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

    <el-empty v-if="!totalCount" description="暂无订单数据，先去各平台抓取订单" :image-size="80" />

    <template v-else>
      <!-- KPI：近 12 个月的表现与同比 -->
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
            <span>月度趋势（近 24 个月）</span>
            <em>折线上悬停可看每月明细</em>
          </header>
          <LineChart :series="trendSeries" :labels="trendLabels" :metric="metric" :height="220" />
        </section>

        <section class="card">
          <header class="card-head"><span>年度对比</span><em>点柱形查看该年</em></header>
          <BarChart :items="yearBuckets" :metric="metric" show-value :height="176" />
        </section>

        <section class="card span2">
          <header class="card-head"><span>近 12 个月明细</span><em>金额口径 = 交易成功（2026-11-08）</em></header>
          <table class="mini-table">
            <thead>
              <tr><th>月份</th><th class="num">成功</th><th class="num">已完成金额</th><th class="num">退款</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in recent12" :key="m.label">
                <td>{{ m.label }}</td>
                <td class="num">{{ m.paidCount }}</td>
                <td class="num">¥{{ money(m.paidAmount) }}</td>
                <td class="num">{{ m.refundAmount ? `¥${money(m.refundAmount)}` : '—' }}</td>
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
  type Bucket
} from '@renderer/utils/order-stats'
import LineChart, { type LineSeries } from './LineChart.vue'
import BarChart from './BarChart.vue'

/**
 * 趋势仪表盘（2026-11-08）：时间维度的第二个总览视图。
 * 与数据总览分工：总览看「现状构成」，这里看「随时间怎么走」——
 * 月度折线（金额/单量切换）+ 年度对比 + 近 12 月明细，并支持整份统计导出 Excel。
 */
const props = defineProps<{
  /** 只统计这些平台（侧栏传入，下架平台不参与） */
  platformIds?: string[]
}>()

const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()
const metric = ref<'count' | 'amount'>('amount')
const exporting = ref(false)

function nameOf(platformId: string): string {
  return platformsStore.adapters.find((a) => a.id === platformId)?.displayName ?? platformId
}

const groups = computed(() => {
  const allowed = props.platformIds ? new Set(props.platformIds) : null
  const source: Record<string, Order[]> = {}
  for (const [id, list] of Object.entries(ordersStore.byPlatform)) {
    if (allowed && !allowed.has(id)) continue
    source[id] = list
  }
  return groupByPlatform(source, nameOf)
})

const totalCount = computed(() => groups.value.reduce((sum, g) => sum + g.orders.length, 0))

const trend = computed(() => buildMonthlyTrend(groups.value, 24))
const trendLabels = computed(() => trend.value.map((b) => b.label))
const trendSeries = computed<LineSeries[]>(() => [
  { name: '交易成功', points: trend.value.map((b) => (metric.value === 'amount' ? b.paidAmount : b.paidCount)) },
  { name: '退款', points: trend.value.map((b) => (metric.value === 'amount' ? b.refundAmount : b.refundCount)) }
])

const recent12 = computed(() => trend.value.slice(-12))
const prev12 = computed(() => trend.value.slice(0, 12))

function sumBuckets(
  list: Bucket[],
  key: 'paidAmount' | 'paidCount' | 'refundCount' | 'refundAmount'
): number {
  return list.reduce((sum, b) => sum + b[key], 0)
}

const kpis = computed(() => {
  const curAmount = sumBuckets(recent12.value, 'paidAmount')
  const curCount = sumBuckets(recent12.value, 'paidCount')
  const prevAmount = sumBuckets(prev12.value, 'paidAmount')
  const growth =
    prevAmount > 0 ? ((curAmount - prevAmount) / prevAmount) * 100 : curAmount > 0 ? 100 : 0
  const growthText = prevAmount > 0 ? `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%` : '—'
  const peak = recent12.value.reduce<Bucket | null>((best, b) => (!best || b.paidAmount > best.paidAmount ? b : best), null)
  const months = recent12.value.filter((b) => b.paidCount > 0).length
  return [
    {
      label: '近 12 个月已完成',
      value: `¥${wan(curAmount)}`,
      unit: '',
      hint: `${curCount.toLocaleString('zh-CN')} 单 · 月均 ¥${wan(months ? curAmount / months : 0)}`
    },
    {
      label: '较前 12 个月',
      value: growthText,
      unit: '',
      hint: prevAmount > 0 ? `前 12 个月 ¥${wan(prevAmount)}` : '无可比数据'
    },
    {
      label: '最高单月',
      value: peak ? `¥${wan(peak.paidAmount)}` : '—',
      unit: '',
      hint: peak ? peak.label : '暂无'
    },
    {
      label: '统计范围',
      value: trendLabels.value.length ? `${trendLabels.value[0]} ~` : '—',
      unit: '',
      hint: trendLabels.value.length ? trendLabels.value[trendLabels.value.length - 1] : '暂无'
    }
  ]
})

function wan(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function money(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const subtitle = computed(() => {
  const s = buildOverviewStats(groups.value, null)
  return `共 ${s.totalCount.toLocaleString('zh-CN')} 单 · 交易成功 ${s.paidCount.toLocaleString('zh-CN')} 单 / 退款 ${s.refundCount} 单`
})

/** 年度对比（复用总览的年度桶） */
const yearBuckets = computed(() => buildOverviewStats(groups.value, null).years)

/** 统计报表导出：渲染层按页面口径算好区块，主进程只排版落盘 */
async function onExportStats(): Promise<void> {
  exporting.value = true
  try {
    const yearStats = buildOverviewStats(groups.value, null)
    const res = await window.api.exportStatsExcel({
      fileName: `Reflow_统计报表_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets: [
        {
          name: '月度趋势',
          headers: ['月份', '交易成功单数', '已完成金额', '退款单数', '退款金额'],
          rows: trend.value.map((b) => [b.label, b.paidCount, b.paidAmount, b.refundCount, b.refundAmount]),
          boldLast: false
        },
        {
          name: '年度对比',
          headers: ['年份', '交易成功单数', '已完成金额', '退款单数', '退款金额'],
          rows: [
            ...yearBuckets.value.map((b) => [b.label, b.paidCount, b.paidAmount, b.refundCount, b.refundAmount]),
            [
              '合计',
              sumBuckets(yearBuckets.value, 'paidCount'),
              Math.round(sumBuckets(yearBuckets.value, 'paidAmount') * 100) / 100,
              sumBuckets(yearBuckets.value, 'refundCount'),
              Math.round(sumBuckets(yearBuckets.value, 'refundAmount') * 100) / 100
            ]
          ],
          boldLast: true
        },
        {
          name: '平台汇总',
          headers: ['平台', '订单总数', '交易成功单数', '已完成金额', '客单价', '退款单数', '退款金额'],
          rows: [
            ...yearStats.platforms.map((p) => [
              p.label,
              p.count,
              p.paidCount,
              p.paidAmount,
              p.paidCount ? Math.round((p.paidAmount / p.paidCount) * 100) / 100 : 0,
              p.refundCount,
              p.refundAmount
            ]),
            [
              '合计',
              yearStats.totalCount,
              yearStats.paidCount,
              yearStats.paidAmount,
              yearStats.paidCount ? Math.round((yearStats.paidAmount / yearStats.paidCount) * 100) / 100 : 0,
              yearStats.refundCount,
              yearStats.refundAmount
            ]
          ],
          boldLast: true
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
</script>

<style scoped>
.trends {
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

.mini-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.mini-table th,
.mini-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  text-align: left;
}

.mini-table th {
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.mini-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mini-table tbody tr:last-child td {
  border-bottom: none;
}
</style>
