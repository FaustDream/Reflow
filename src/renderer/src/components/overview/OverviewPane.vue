<template>
  <div class="overview">
    <!-- 标题行：角色切换是这一页的「视角开关」 -->
    <header class="ov-head">
      <div class="ov-titles">
        <span class="ov-title">数据总览</span>
        <span class="ov-sub">{{ subtitle }}</span>
      </div>
      <div class="spacer" />
      <el-radio-group v-model="role" size="small" class="role-tabs">
        <el-radio-button value="spend">消费</el-radio-button>
        <el-radio-button value="reconcile">对账</el-radio-button>
        <el-radio-button value="structure">结构</el-radio-button>
      </el-radio-group>
    </header>

    <!-- 筛选条：只放三个「决定看哪批数据」的条件，状态靠点卡片选 -->
    <div class="ov-filter">
      <el-select v-model="range" size="small" class="f-range">
        <el-option label="全部时间" value="all" />
        <el-option label="今年" value="year" />
        <el-option label="近 90 天" value="90d" />
        <el-option label="近 30 天" value="30d" />
        <el-option label="近 7 天" value="7d" />
      </el-select>
      <el-select
        v-model="platformFilter"
        size="small"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="全部平台"
        class="f-platform"
      >
        <el-option v-for="p in platformOptions" :key="p.id" :label="p.displayName" :value="p.id" />
      </el-select>
      <span class="spacer" />
      <span v-if="activeFilterCount" class="filter-chip">已筛选 {{ activeFilterCount }} 项</span>
      <el-button v-if="activeFilterCount" link size="small" @click="resetFilter">重置</el-button>
    </div>

    <div class="ov-scroll">
      <el-empty v-if="!sourceOrders.length" :description="emptyText" :image-size="80" class="ov-empty" />

      <!-- 有数据但被筛选筛空了：必须给出口，否则用户面对的是一屏 0 -->
      <el-empty
        v-else-if="!baseOrders.length"
        description="当前筛选条件下没有订单"
        :image-size="70"
        class="ov-empty"
      >
        <el-button size="small" @click="resetFilter">清除筛选</el-button>
      </el-empty>

      <template v-else>
        <!-- 第一层：钱花成什么状态了。三个角色都从这里开始读 -->
        <StateFlow :slices="breakdown.slices" :active="states" @pick="toggleState" />

        <!-- 第二层：角色决定「往下看什么」 -->
        <div class="role-grid">
          <!-- 消费：时间和单笔 -->
          <section v-if="role === 'spend'" class="card role-main">
            <header class="card-head">
              <span>月度支出</span>
              <em>{{ trendWindowLabel }}</em>
              <div class="spacer" />
              <button v-if="month" class="lock-chip" @click="month = null">
                {{ month }} · 清除
              </button>
            </header>
            <LineChart
              :series="spendSeries"
              :labels="monthLabels"
              metric="amount"
              :active-label="month ?? ''"
              pickable
              :height="172"
              @pick="pickMonth"
            />
            <p class="card-note">
              点折线上的点可锁定该月：平台矩阵会收敛到这段时间，对账视角的待处理清单同理。
            </p>
          </section>

          <!-- 对账：钱卡在哪一笔 -->
          <section v-else-if="role === 'reconcile'" class="card role-main">
            <header class="card-head">
              <span>{{ attentionTitle }}</span>
              <em>{{ attentionHint }}</em>
              <div class="spacer" />
              <span class="count-chip">{{ attentionTotal }} 单</span>
            </header>
            <table v-if="attentionOrders.length" class="att-table">
              <thead>
                <tr>
                  <th class="col-state">状态</th>
                  <th>商品</th>
                  <th class="col-platform">平台</th>
                  <th class="col-date">下单</th>
                  <th class="num col-amount">金额</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in attentionOrders" :key="o.platform + o.orderId">
                  <td class="col-state">
                    <span class="state-tag" :class="`is-${orderStateOf(o)}`">
                      {{ ORDER_STATE_LABEL[orderStateOf(o)] }}
                    </span>
                  </td>
                  <td class="col-title" :title="o.title">{{ o.title || '（无商品名）' }}</td>
                  <td class="col-platform">{{ nameOf(o.platform) }}</td>
                  <td class="col-date">{{ (o.createdAt ?? '').slice(0, 10) || '—' }}</td>
                  <td class="num col-amount">¥{{ money(amountOf(o)) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="attentionTotal > attentionOrders.length" class="card-note">
              只列最该先处理的 {{ attentionOrders.length }} 单；完整明细在对应平台页。
            </p>
            <p v-else-if="!attentionOrders.length" class="card-note">
              当前筛选下没有进行中或退款中的订单 —— 钱没有卡在路上。
            </p>
          </section>

          <!-- 结构：花在哪 -->
          <section v-else class="card role-main">
            <header class="card-head">
              <span>平台结构</span>
              <em>按订单金额，外卖单归入母平台</em>
            </header>
            <DonutChart
              :items="platformDonut"
              metric="amount"
              :center-value="moneyW(breakdown.amount)"
              center-label="全部金额"
            />
          </section>

          <!-- 洞察：每个角色三条，只讲「这一屏看不出来的那句话」 -->
          <aside class="card insights">
            <header class="card-head"><span>值得注意</span></header>
            <ul class="insight-list">
              <li v-for="it in insights" :key="it.label" class="insight">
                <span class="insight-label">{{ it.label }}</span>
                <span class="insight-value" :class="it.tone ? `is-${it.tone}` : ''">{{ it.value }}</span>
                <span class="insight-note">{{ it.note }}</span>
              </li>
            </ul>
          </aside>
        </div>

        <!-- 第三层：把状态分布拆到平台，点行即按平台筛选 -->
        <section class="card matrix-card">
          <header class="card-head">
            <span>平台 × 状态</span>
            <em>金额单位：元；点某一行只看该平台</em>
          </header>
          <table class="matrix">
            <thead>
              <tr>
                <th class="col-name">平台</th>
                <th class="num col-count">单数</th>
                <th v-for="k in STATE_ORDER" :key="k" class="num col-state" :class="`is-${k}`">
                  {{ STATE_META[k].short }}
                </th>
                <th class="num col-total">合计</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in platformRows"
                :key="row.id"
                class="matrix-row"
                :class="{ 'is-picked': platformFilter.length === 1 && platformFilter[0] === row.id }"
                @click="pickPlatform(row.id)"
              >
                <td class="col-name">
                  <span class="row-name">{{ row.label }}</span>
                  <span class="row-share">{{ pct(row.share) }}</span>
                </td>
                <td class="num col-count">{{ row.count }}</td>
                <td
                  v-for="(v, i) in row.amounts"
                  :key="i"
                  class="num col-state"
                  :class="[`is-${STATE_ORDER[i]}`, { 'is-zero': v === 0 }]"
                >
                  {{ v ? moneyCell(v) : '—' }}
                </td>
                <td class="num col-total">{{ moneyCell(row.amount) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="matrix-foot">
            金额口径：占比分母为全部订单金额（含进行中 / 退款 / 关闭）；退款金额含「退款中」。
            交易成功才是真正花掉的钱。
          </p>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Order } from '@shared/types'
import LineChart, { type LineSeries } from './LineChart.vue'
import DonutChart from './DonutChart.vue'
import StateFlow from './StateFlow.vue'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import {
  amountOf,
  ORDER_STATE_LABEL,
  orderStateOf,
  type OrderState
} from '@renderer/utils/order-stats'
import {
  activeDaysOf,
  buildBreakdown,
  buildMonthlySeries,
  buildPlatformMatrix,
  dateRangeOf,
  emptyFilter,
  filterOverviewOrders,
  STATE_META,
  STATE_ORDER,
  type OverviewRole,
  type TimeRange
} from '@renderer/utils/overview-model'

/**
 * 数据总览 v2（2026-11-11 重做）。
 *
 * 一句话结构：**一条状态分布带 + 一个角色视角 + 一张平台矩阵**。
 *
 * 旧版把年度分布、月度分布、周内分布、热力日历、退款仪表、平台占比、状态列表
 * 七块图形铺满一屏，信息彼此平行、没有主次，用户看完不知道「所以呢」。
 * 新版只回答三个递进的问题：
 *   1. 钱花成什么状态了？（状态分布带，永远第一眼）
 *   2. 这个角色最该关心什么？（消费看时间、对账看卡单、结构看平台）
 *   3. 具体落在哪个平台？（平台 × 状态矩阵，点行即筛选）
 *
 * 联动约定：状态卡 / 矩阵行 / 柱形都能点，且都能再点一次取消 ——
 * 任何筛选都必须可逆，否则用户会困在自己制造的视图里。
 */
const props = defineProps<{
  /** 只统计这些平台（由侧栏传入当前显示的平台，下架平台不参与统计） */
  platformIds?: string[]
}>()

const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()

const role = ref<OverviewRole>('spend')
const range = ref<TimeRange>('all')
const platformFilter = ref<string[]>([])
const states = ref<OrderState[]>([])
/** 锁定的月份 `YYYY-MM`（点柱形切换） */
const month = ref<string | null>(null)

/** 固定住「现在」：一屏内所有相对时间用同一个基准，避免跨秒重算导致的抖动 */
const now = new Date()

function nameOf(platformId: string): string {
  return platformsStore.adapters.find((a) => a.id === platformId)?.displayName ?? platformId
}

/** 参与统计的全部订单（含外卖单，业务线靠筛选切） */
const sourceOrders = computed<Order[]>(() => {
  const allowed = props.platformIds ? new Set(props.platformIds) : null
  const out: Order[] = []
  for (const [id, list] of Object.entries(ordersStore.byPlatform)) {
    // 下架平台（如已移除的美团外卖）本地还留着历史缓存，但不能算进总览
    if (allowed && !allowed.has(id)) continue
    if (list?.length) out.push(...list)
  }
  return out
})

const platformOptions = computed(() =>
  platformsStore.adapters
    .filter((a) => !props.platformIds || props.platformIds.includes(a.id))
    .map((a) => ({ id: a.id, displayName: a.displayName }))
)

/** 第一层筛选：时间 + 业务线 + 平台。状态与月份只往下影响明细，不动这一层 */
const baseOrders = computed(() =>
  filterOverviewOrders(
    sourceOrders.value,
    {
      range: range.value,
      biz: 'all',
      platforms: platformFilter.value,
      states: [],
      month: null
    },
    now
  )
)

/** 第二层：叠加状态筛选（状态卡点击） */
const focusOrders = computed(() =>
  states.value.length
    ? filterOverviewOrders(
        sourceOrders.value,
        {
          range: range.value,
          biz: 'all',
          platforms: platformFilter.value,
          states: states.value,
          month: null
        },
        now
      )
    : baseOrders.value
)

/** 第三层：再叠加月份锁定（柱形点击） */
const detailOrders = computed(() =>
  month.value ? filterOverviewOrders(focusOrders.value, { ...emptyFilter(), month: month.value }, now) : focusOrders.value
)

/** 状态分布恒按 baseOrders 算：点状态卡时卡上的数字不能跳 */
const breakdown = computed(() => buildBreakdown(baseOrders.value))
/**
 * 角色区的口径：**跟随筛选**。
 * 一条规则比「有的数全局、有的数跟随」好解释 —— 状态卡是锚点（不变），
 * 往下所有数字都在回答「你现在看的这批订单」。
 */
const viewStats = computed(() => buildBreakdown(focusOrders.value))
const monthSeries = computed(() => buildMonthlySeries(focusOrders.value, 12, now))
const platformRows = computed(() => buildPlatformMatrix(detailOrders.value, nameOf))

/** 折线图的横轴标签用 `YYYY-MM`：LineChart 会把它渲染成「12月」「1月」，首月带年份 */
const monthLabels = computed(() => monthSeries.value.map((m) => m.key))

/**
 * 月度支出两条线：交易成功 / 退款（含退款中）。
 * 用折线而不是柱：12 个月看的是**走势**，柱形只能在两个月份之间做高低比较，
 * 连续涨跌的节奏看不出来；退款单独一条线也更容易看出「哪几个月退得多」。
 */
const spendSeries = computed<LineSeries[]>(() => [
  { name: '交易成功', points: monthSeries.value.map((m) => m.paidAmount) },
  { name: '退款', points: monthSeries.value.map((m) => m.refundAmount) }
])

/** 横轴只写「3月」，跨年时容易看错年份 —— 标题里交代清楚窗口 */
const trendWindowLabel = computed(() => {
  const s = monthSeries.value
  if (s.length < 2) return '交易成功 vs 退款（含退款中）'
  return `${s[0].fullLabel} ~ ${s[s.length - 1].fullLabel} · 交易成功 vs 退款（含退款中）`
})

const platformDonut = computed(() =>
  platformRows.value.map((r) => ({
    label: r.label,
    value: r.amount,
    count: r.count,
    amount: r.amount
  }))
)

// ---------------------------------------------------------------------------
// 副标题 / 空态 / 筛选摘要
// ---------------------------------------------------------------------------

const RANGE_LABEL: Record<TimeRange, string> = {
  all: '全部时间',
  year: '今年',
  '90d': '近 90 天',
  '30d': '近 30 天',
  '7d': '近 7 天'
}

const subtitle = computed(() => {
  const s = breakdown.value
  if (!s.count) return `${RANGE_LABEL[range.value]} · 暂无数据`
  // 成功/退款/在途的金额在下方状态带里已经有，这里只交代「看的是哪一段」
  const parts = [RANGE_LABEL[range.value]]
  parts.push(`${s.count.toLocaleString('zh-CN')} 单`)
  const { first, last } = dateRangeOf(baseOrders.value)
  if (first) parts.push(first === last ? first : `${first} ~ ${last}`)
  return parts.join(' · ')
})

const emptyText = computed(
  () => '还没有订单数据 —— 先在左侧选一个平台登录，抓到订单后这里就会出现图表'
)

const activeFilterCount = computed(() => {
  let n = 0
  if (range.value !== 'all') n += 1
  n += platformFilter.value.length ? 1 : 0
  n += states.value.length ? 1 : 0
  n += month.value ? 1 : 0
  return n
})

// ---------------------------------------------------------------------------
// 联动动作
// ---------------------------------------------------------------------------

function toggleState(key: OrderState): void {
  states.value = states.value.includes(key)
    ? states.value.filter((k) => k !== key)
    : [...states.value, key]
}

/** 点折线：同一个点再点一次取消锁定（label 已经是 `YYYY-MM`） */
function pickMonth(key: string): void {
  month.value = month.value === key ? null : key
}

/** 点矩阵行：只看该平台；再点一次恢复全部平台 */
function pickPlatform(id: string): void {
  platformFilter.value =
    platformFilter.value.length === 1 && platformFilter.value[0] === id ? [] : [id]
}

function resetFilter(): void {
  range.value = 'all'
  platformFilter.value = []
  states.value = []
  month.value = null
}

// 状态筛选变化后，锁定的月份仍然有效（两者是「与」关系），但换时间范围时
// 之前的月份很可能落在窗口外 —— 清掉，避免出现「有筛选却没数据」的困惑
watch(range, () => {
  month.value = null
})

// ---------------------------------------------------------------------------
// 角色内容：待处理清单
// ---------------------------------------------------------------------------

const ATTENTION_STATES: OrderState[] = ['refunding', 'pending']

/** 退款中排在进行中前面：钱正在退回、还来得及催，比单纯在途更值得先看 */
const ATTENTION_PRIORITY: Record<string, number> = {
  refunding: 0,
  pending: 1,
  refunded: 2,
  success: 3,
  closed: 4
}

const attentionList = computed(() => {
  const want = states.value.length ? states.value : ATTENTION_STATES
  return detailOrders.value
    .filter((o) => want.includes(orderStateOf(o)))
    .sort(
      (a, b) =>
        (ATTENTION_PRIORITY[orderStateOf(a)] ?? 9) - (ATTENTION_PRIORITY[orderStateOf(b)] ?? 9) ||
        amountOf(b) - amountOf(a)
    )
})

const attentionTotal = computed(() => attentionList.value.length)
const attentionOrders = computed(() => attentionList.value.slice(0, 8))

const attentionTitle = computed(() =>
  states.value.length
    ? `${states.value.map((k) => ORDER_STATE_LABEL[k]).join(' + ')}订单`
    : '待处理：进行中 / 退款中'
)

const attentionHint = computed(() => {
  const list = attentionList.value
  if (!list.length) return states.value.length ? '当前筛选下没有订单' : '暂无待处理'
  const amount = list.reduce((sum, o) => sum + amountOf(o), 0)
  const order = states.value.length ? '按金额排序' : '退款中优先，其次按金额'
  return `${order} · 合计 ¥${moneyW(amount)}`
})

// ---------------------------------------------------------------------------
// 角色内容：业务线拆分
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 洞察：每个角色三条，只讲图上看不出来的结论
// ---------------------------------------------------------------------------

interface Insight {
  label: string
  value: string
  note: string
  tone?: 'danger' | 'warning' | 'success'
}

const insights = computed<Insight[]>(() => {
  if (role.value === 'spend') return spendInsights()
  if (role.value === 'reconcile') return reconcileInsights()
  return structureInsights()
})

function spendInsights(): Insight[] {
  const series = monthSeries.value
  const cur = series[series.length - 1]
  const prev = series[series.length - 2]
  // 基数太小（上月只有几十块）时百分比会飙到几万，读起来像 bug —— 改为说绝对额
  const momBaseOk = !!prev && prev.paidAmount >= 100
  const mom = momBaseOk && prev ? (cur.paidAmount - prev.paidAmount) / prev.paidAmount : null

  const avg = viewStats.value.paidCount
    ? viewStats.value.paidAmount / viewStats.value.paidCount
    : 0

  let biggest: Order | null = null
  for (const o of focusOrders.value) {
    if (orderStateOf(o) !== 'success') continue
    if (!biggest || amountOf(o) > amountOf(biggest)) biggest = o
  }

  const days = activeDaysOf(focusOrders.value)
  return [
    {
      label: '本月支出',
      value: cur ? `¥${moneyW(cur.paidAmount)}` : '—',
      note: momNote(cur, prev, mom),
      tone: mom !== null && mom > 0.3 ? 'warning' : undefined
    },
    {
      label: '平均每单',
      value: avg ? `¥${money(avg)}` : '—',
      note: days
        ? `${days} 个下单日 · 日均 ¥${moneyW(viewStats.value.paidAmount / days)}`
        : '当前筛选下没有成功订单'
    },
    {
      label: '最大单笔',
      value: biggest ? `¥${moneyW(amountOf(biggest))}` : '—',
      note: biggest
        ? `${nameOf(biggest.platform)} · ${truncate(biggest.title || '（无商品名）', 16)}`
        : '暂无成功订单'
    }
  ]
}

/** 环比说明：基数够大说百分比，基数太小或变化过猛说绝对额 */
function momNote(
  cur: { paidAmount: number } | undefined,
  prev: { paidAmount: number } | undefined,
  mom: number | null
): string {
  if (!cur) return '暂无本月数据'
  if (!prev) return '不足两个月，无法对比'
  if (!prev.paidAmount) return '上月无成功支出'
  if (mom === null) return `上月 ¥${moneyW(prev.paidAmount)}，基数过小不做环比`
  const delta = cur.paidAmount - prev.paidAmount
  if (Math.abs(mom) > 2) {
    return `较上月 ${delta >= 0 ? '多花' : '少花'} ¥${moneyW(Math.abs(delta))}（上月 ¥${moneyW(prev.paidAmount)}）`
  }
  return `环比上月 ${delta >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(mom * 1000) / 10)}%`
}

function reconcileInsights(): Insight[] {
  const s = viewStats.value
  const refundSlice = s.slices.find((x) => x.key === 'refunding')
  const pendingSlice = s.slices.find((x) => x.key === 'pending')

  // 退款最集中的平台：只看退款中（钱正在退、还来得及催）
  const byPlatform = new Map<string, { amount: number; count: number }>()
  for (const o of focusOrders.value) {
    if (orderStateOf(o) !== 'refunding') continue
    const hit = byPlatform.get(o.platform) ?? { amount: 0, count: 0 }
    hit.amount += amountOf(o)
    hit.count += 1
    byPlatform.set(o.platform, hit)
  }
  const top = [...byPlatform.entries()].sort((a, b) => b[1].amount - a[1].amount)[0]

  return [
    {
      label: '在途金额',
      value: `¥${moneyW(s.inFlightAmount)}`,
      note: `进行中 ¥${moneyW(pendingSlice?.amount ?? 0)} · 退款中 ¥${moneyW(refundSlice?.amount ?? 0)}`,
      tone: s.inFlightAmount > 0 ? 'warning' : undefined
    },
    {
      label: '退款率',
      value: pct(s.refundRate),
      note: `已退 ¥${moneyW(s.refundedAmount)}（含退款中）· 净支出 ¥${moneyW(s.netSpend)}`,
      tone: s.refundRate > 0.15 ? 'danger' : undefined
    },
    {
      label: '最该催的平台',
      value: top ? nameOf(top[0]) : '—',
      note: top ? `退款中 ¥${moneyW(top[1].amount)} · ${top[1].count} 单` : '没有进行中的退款',
      tone: top && top[1].amount > 0 ? 'danger' : undefined
    }
  ]
}

function structureInsights(): Insight[] {
  const rows = platformRows.value
  const top = rows[0]
  const avgRows = rows
    .map((r) => {
      const paid = r.byState.success
      const amount = r.amounts[STATE_ORDER.indexOf('success')]
      return { label: r.label, avg: paid ? amount / paid : 0, amount, paid }
    })
    .filter((r) => r.avg > 0)
    .sort((a, b) => b.avg - a.avg)
  const bestAvg = avgRows[0]

  return [
    {
      label: '最大支出平台',
      value: top ? top.label : '—',
      note: top ? `占全部金额 ${pct(top.share)} · ¥${moneyW(top.amount)}` : '暂无数据'
    },
    {
      label: '客单价最高',
      value: bestAvg ? bestAvg.label : '—',
      note: bestAvg ? `¥${money(bestAvg.avg)} · ${bestAvg.paid} 单` : '暂无成功订单'
    }
  ]
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function money(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 大额用「万」，表里放得下，也不用数零 */
function moneyW(n: number): string {
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2).replace(/\.00$/, '')}万`
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

/** 矩阵单元格：整数元，万位压缩 */
function moneyCell(n: number): string {
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`
  return Math.round(n).toLocaleString('zh-CN')
}

function pct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%'
  const n = v * 100
  return `${n.toFixed(n < 1 ? 1 : 0)}%`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  // 商品名里常有 emoji：切在代理对中间会留下孤立高位，渲染成「�」
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${s.slice(0, end)}…`
}
</script>

<style scoped>
.overview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---- 头部 ---- */
.ov-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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

.spacer {
  flex: 1;
}

.role-tabs :deep(.el-radio-button__inner) {
  padding: 5px 14px;
  font-size: 12px;
}

/* ---- 筛选条 ---- */
.ov-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex: none;
  flex-wrap: wrap;
}

.f-range {
  width: 118px;
}

.f-platform {
  width: 190px;
}

.filter-chip {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  white-space: nowrap;
}

/* ---- 滚动区 ---- */
.ov-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
  padding-bottom: 4px;
}

.ov-empty {
  padding-top: 40px;
}

.card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  padding: 10px 12px 12px;
  min-width: 0;
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.card-head span {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.card-head em {
  font-style: normal;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-note {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  line-height: 1.5;
}

.lock-chip,
.count-chip {
  flex: none;
  font-size: 11px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  white-space: nowrap;
}

.lock-chip {
  border: 1px solid var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  cursor: pointer;
}

.count-chip {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

/* ---- 角色区 ---- */
.role-grid {
  display: grid;
  grid-template-columns: minmax(0, 2.2fr) minmax(240px, 1fr);
  gap: 10px;
  flex: none;
}

.role-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.role-main :deep(.donut) {
  flex: 1;
  gap: 22px;
}

/* 图例不要拉满整行：名称与数值拉太开，读数要横跨半张卡 */
.role-main :deep(.legend) {
  max-width: 320px;
}

/* ---- 待处理清单 ---- */
.att-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--el-text-color-regular);
  table-layout: fixed;
}

.att-table th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  padding: 0 8px 4px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.att-table td {
  padding: 5px 8px 5px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-table tr:last-child td {
  border-bottom: none;
}

.att-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.col-state {
  width: 66px;
}

.col-platform {
  width: 68px;
}

.col-date {
  width: 88px;
  color: var(--el-text-color-secondary);
}

.col-amount {
  width: 88px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.col-title {
  color: var(--el-text-color-primary);
}

.state-tag {
  display: inline-block;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 17px;
}

.state-tag.is-success {
  color: var(--el-color-success-dark-2);
  background: var(--el-color-success-light-9);
}

.state-tag.is-pending {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.state-tag.is-refunding {
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-9);
}

.state-tag.is-refunded {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}

.state-tag.is-closed {
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
}

/* ---- 洞察 ---- */
.insights {
  display: flex;
  flex-direction: column;
}

.insight-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex: 1;
  flex-direction: column;
  /* 三条洞察撑满与左侧主卡同高，避免卡片底部吊着一大块空白 */
  justify-content: space-between;
  gap: 10px;
}

.insight {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 9px;
  border-left: 2px solid var(--el-border-color-lighter);
}

.insight-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.insight-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}

.insight-value.is-warning {
  color: var(--el-color-warning-dark-2);
}

.insight-value.is-danger {
  color: var(--el-color-danger);
}

.insight-value.is-success {
  color: var(--el-color-success);
}

.insight-note {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  line-height: 1.4;
}

/* ---- 平台 × 状态矩阵 ---- */
.matrix-card {
  flex: none;
}

.matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}

.matrix th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  padding: 0 8px 5px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  white-space: nowrap;
}

.matrix td {
  padding: 6px 8px 6px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.matrix tbody tr:last-child td {
  border-bottom: none;
}

.matrix .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.col-name {
  width: 22%;
}

.col-count {
  width: 62px;
  color: var(--el-text-color-secondary);
}

.col-state {
  width: 86px;
}

.col-total {
  width: 100px;
  color: var(--el-text-color-primary);
  font-weight: 600;
}

/* 状态列的表头跟着状态色走：和上方堆叠条一一对应 */
.matrix th.col-state.is-success {
  color: var(--el-color-success);
}

.matrix th.col-state.is-pending {
  color: var(--el-color-primary);
}

.matrix th.col-state.is-refunding {
  color: var(--el-color-warning);
}

.matrix th.col-state.is-refunded {
  color: var(--el-color-danger);
}

.matrix th.col-state.is-closed {
  color: var(--el-text-color-secondary);
}

.matrix td.is-zero {
  color: var(--el-text-color-placeholder);
}

.row-name {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.row-share {
  margin-left: 8px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.matrix-row {
  cursor: pointer;
  transition: background 0.15s;
}

.matrix-row:hover {
  background: var(--el-fill-color-lighter);
}

.matrix-row.is-picked {
  background: var(--el-color-primary-light-9);
}

.matrix-row.is-picked .row-name {
  color: var(--el-color-primary);
}

.matrix-foot {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}

@media (max-width: 1080px) {
  .role-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
