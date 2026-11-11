/**
 * 数据总览 v2 模型（2026-11-11）：状态金额分布 + 角色视角聚合。
 *
 * 设计取舍（与旧版 buildOverviewStats 的区别）：
 *
 * 1. **状态是主角**。旧版把「交易成功 / 退款」压成二元口径，进行中和退款中
 *    被折进合计之外，用户看不到「钱卡在哪」。这里保留五态
 *    （success / pending / refunding / refunded / closed），每态都同时给
 *    金额、单数、金额占比、单量占比 —— 一条堆叠带就能说清结构。
 * 2. **占比分母是「全部订单金额」**。不是「成功金额」，否则退款/进行中的占比
 *    永远加起来不到 100%，看起来像算错。
 * 3. **筛选分层**：`baseOrders`（时间 + 业务线 + 平台）决定状态分布与矩阵；
 *    叠加 `states` / `month` 只影响「往下看」的明细与趋势高亮。
 *    这样点状态卡时，卡片上的数字不会跟着变 —— 数字跳动是总览页最忌讳的事。
 *
 * 纯函数，不依赖 Vue / Element Plus，见 __tests__/overview-model.test.ts。
 */
import type { Order } from '@shared/types'
import {
  amountOf,
  bizLineOf,
  orderStateOf,
  parseYmd,
  type BizLine,
  type OrderState
} from './order-stats'

// ---------------------------------------------------------------------------
// 状态的展示口径
// ---------------------------------------------------------------------------

export interface StateMeta {
  key: OrderState
  /** 完整名（表头、图例） */
  label: string
  /** 短名（卡片标题，窄屏也不折行） */
  short: string
  /** 主色：直接写 CSS 变量，跟随主题 */
  color: string
  /** 同色系的浅底（卡片激活态） */
  softColor: string
  /** Element Plus 标签类型 */
  tagType: 'success' | 'primary' | 'warning' | 'danger' | 'info'
  /** 口径提示：这些状态的钱算不算「已花掉」 */
  hint: string
}

/**
 * 展示顺序 = 用户关心的顺序：钱花成了 → 还在路上 → 正在退 → 已退回 → 没成交。
 * 改动这里等于改动整页的叙事，慎改。
 */
export const STATE_ORDER: OrderState[] = [
  'success',
  'pending',
  'refunding',
  'refunded',
  'closed'
]

export const STATE_META: Record<OrderState, StateMeta> = {
  success: {
    key: 'success',
    label: '交易成功',
    short: '成功',
    color: 'var(--el-color-success)',
    softColor: 'var(--el-color-success-light-9)',
    tagType: 'success',
    hint: '已完成、钱确实花掉的订单'
  },
  pending: {
    key: 'pending',
    label: '进行中',
    short: '进行中',
    color: 'var(--el-color-primary)',
    softColor: 'var(--el-color-primary-light-9)',
    tagType: 'primary',
    hint: '待付款 / 待发货 / 运输中，交易尚未完成'
  },
  refunding: {
    key: 'refunding',
    label: '退款中',
    short: '退款中',
    color: 'var(--el-color-warning)',
    softColor: 'var(--el-color-warning-light-9)',
    tagType: 'warning',
    hint: '退款已发起、钱还没回到账上'
  },
  refunded: {
    key: 'refunded',
    label: '已退款',
    short: '已退款',
    color: 'var(--el-color-danger)',
    softColor: 'var(--el-color-danger-light-9)',
    tagType: 'danger',
    hint: '钱已退回，订单未成交'
  },
  closed: {
    key: 'closed',
    label: '已关闭',
    short: '已关闭',
    color: 'var(--el-color-info)',
    softColor: 'var(--el-color-info-light-9)',
    tagType: 'info',
    hint: '取消 / 超时未付款等未成交订单'
  }
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export type TimeRange = 'all' | 'year' | '90d' | '30d' | '7d'
export type BizScope = 'all' | BizLine
/** 三个视角：消费（花了多少）/ 对账（钱卡在哪）/ 结构（花在哪） */
export type OverviewRole = 'spend' | 'reconcile' | 'structure'

export interface OverviewFilter {
  range: TimeRange
  biz: BizScope
  /** 平台 id 白名单（空数组 = 不限） */
  platforms: string[]
  /** 归一状态（空数组 = 不限） */
  states: OrderState[]
  /** 锁定月份 `YYYY-MM`（点月度柱形进入），null = 不限 */
  month: string | null
}

export function emptyFilter(): OverviewFilter {
  return { range: 'all', biz: 'all', platforms: [], states: [], month: null }
}

/** `YYYY-MM-DD HH:mm:ss` → 毫秒；无时间返回 null（不让它落进任何时间区间） */
export function timeOfOrder(order: Order): number | null {
  if (!order.createdAt) return null
  const t = Date.parse(order.createdAt.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

/** `YYYY-MM` 月键 */
export function monthKeyOf(order: Order): string | null {
  const ymd = parseYmd(order.createdAt)
  return ymd ? `${ymd.y}-${String(ymd.m).padStart(2, '0')}` : null
}

const DAY_MS = 86_400_000

/**
 * 单条订单是否落在筛选内。
 *
 * @param now 计算相对时间（近 N 天 / 今年）的基准，注入以便测试
 */
export function matchOrder(
  order: Order,
  filter: OverviewFilter,
  now: Date = new Date()
): boolean {
  if (filter.biz !== 'all' && bizLineOf(order) !== filter.biz) return false
  if (filter.platforms.length && !filter.platforms.includes(order.platform)) return false
  if (filter.states.length && !filter.states.includes(orderStateOf(order))) return false

  if (filter.range !== 'all') {
    const t = timeOfOrder(order)
    // 无下单时间：无法判断落在哪个区间，一律不算命中（宁可少算，不要算错区间）
    if (t === null) return false
    if (filter.range === 'year') {
      if (new Date(t).getFullYear() !== now.getFullYear()) return false
    } else {
      const days = filter.range === '7d' ? 7 : filter.range === '30d' ? 30 : 90
      if (t < now.getTime() - days * DAY_MS) return false
    }
  }

  if (filter.month && monthKeyOf(order) !== filter.month) return false
  return true
}

/** 过滤订单（一次遍历） */
export function filterOverviewOrders(
  orders: Order[],
  filter: OverviewFilter,
  now: Date = new Date()
): Order[] {
  return orders.filter((o) => matchOrder(o, filter, now))
}

// ---------------------------------------------------------------------------
// 状态分布
// ---------------------------------------------------------------------------

export interface StateSlice {
  key: OrderState
  meta: StateMeta
  count: number
  amount: number
  /** 金额占「全部订单金额」的比例 0–1 */
  amountShare: number
  /** 单量占比 0–1 */
  countShare: number
  /** 该状态的平均单笔 */
  avg: number
}

export interface Breakdown {
  slices: StateSlice[]
  /** 全部订单单数 */
  count: number
  /** 全部订单金额（五态金额之和 = 占比分母） */
  amount: number
  /** 交易成功金额（唯一「钱真的花掉了」的口径） */
  paidAmount: number
  paidCount: number
  /** 在途金额：进行中 + 退款中 */
  inFlightAmount: number
  /** 已退款金额（含退款中，与主进程导出/平台头部口径一致） */
  refundedAmount: number
  /** 净支出 = 成功 - 已退款（含退款中） */
  netSpend: number
  /** 退款率 =（退款中 + 已退款）/（成功 + 退款中 + 已退款） */
  refundRate: number
}

/** 五态金额/单量分布 + 派生指标 */
export function buildBreakdown(orders: Order[]): Breakdown {
  const acc = new Map<OrderState, { count: number; amount: number }>()
  for (const key of STATE_ORDER) acc.set(key, { count: 0, amount: 0 })

  for (const o of orders) {
    const state = orderStateOf(o)
    const bucket = acc.get(state)
    if (!bucket) continue
    bucket.count += 1
    bucket.amount += amountOf(o)
  }

  let count = 0
  let amount = 0
  for (const v of acc.values()) {
    count += v.count
    amount += v.amount
  }

  const slices = STATE_ORDER.map<StateSlice>((key) => {
    const v = acc.get(key) ?? { count: 0, amount: 0 }
    return {
      key,
      meta: STATE_META[key],
      count: v.count,
      amount: round2(v.amount),
      // 分母为 0 时占比给 0，不要 NaN（NaN 会渲染成 "NaN%"）
      amountShare: amount > 0 ? v.amount / amount : 0,
      countShare: count > 0 ? v.count / count : 0,
      avg: v.count > 0 ? round2(v.amount / v.count) : 0
    }
  })

  const at = (k: OrderState): StateSlice => slices.find((s) => s.key === k) as StateSlice
  const paidAmount = at('success').amount
  const refundedAmount = round2(at('refunding').amount + at('refunded').amount)
  const inFlightAmount = round2(at('pending').amount + at('refunding').amount)
  const denom = paidAmount + refundedAmount

  return {
    slices,
    count,
    amount: round2(amount),
    paidAmount,
    paidCount: at('success').count,
    inFlightAmount,
    refundedAmount,
    netSpend: round2(paidAmount - refundedAmount),
    refundRate: denom > 0 ? refundedAmount / denom : 0
  }
}

// ---------------------------------------------------------------------------
// 月度走势
// ---------------------------------------------------------------------------

export interface MonthPoint {
  /** `YYYY-MM` */
  key: string
  /** 横轴标签：`3月` */
  label: string
  /** 悬停里的完整标签：`2026-03` */
  fullLabel: string
  count: number
  paidCount: number
  paidAmount: number
  refundCount: number
  refundAmount: number
  pendingAmount: number
  closedAmount: number
}

/**
 * 近 N 个月按月聚合（跨年，空月补零保证横轴连续）。
 *
 * @param monthsCount 窗口长度，含当月
 */
export function buildMonthlySeries(
  orders: Order[],
  monthsCount: number,
  now: Date = new Date()
): MonthPoint[] {
  const n = Math.max(1, Math.floor(monthsCount))
  const start = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1)
  const buckets = new Map<string, MonthPoint>()

  for (let i = 0; i < n; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const key = `${y}-${String(m).padStart(2, '0')}`
    buckets.set(key, {
      key,
      label: `${m}月`,
      fullLabel: key,
      count: 0,
      paidCount: 0,
      paidAmount: 0,
      refundCount: 0,
      refundAmount: 0,
      pendingAmount: 0,
      closedAmount: 0
    })
  }

  for (const o of orders) {
    const key = monthKeyOf(o)
    if (!key) continue
    const b = buckets.get(key)
    if (!b) continue // 窗口外的订单不进趋势
    const amount = amountOf(o)
    b.count += 1
    const state = orderStateOf(o)
    if (state === 'success') {
      b.paidCount += 1
      b.paidAmount += amount
    } else if (state === 'refunding' || state === 'refunded') {
      b.refundCount += 1
      b.refundAmount += amount
    } else if (state === 'pending') {
      b.pendingAmount += amount
    } else {
      b.closedAmount += amount
    }
  }

  return [...buckets.values()].map((b) => ({
    ...b,
    paidAmount: round2(b.paidAmount),
    refundAmount: round2(b.refundAmount),
    pendingAmount: round2(b.pendingAmount),
    closedAmount: round2(b.closedAmount)
  }))
}

// ---------------------------------------------------------------------------
// 平台 × 状态矩阵
// ---------------------------------------------------------------------------

export interface PlatformStateRow {
  /** 平台 id（真实适配器 id，不是 `jd-local` 这类伪 id） */
  id: string
  label: string
  count: number
  amount: number
  /** 该平台金额占全部平台金额的比例 0–1 */
  share: number
  byState: Record<OrderState, number>
  /** 每个状态的金额，顺序与 STATE_ORDER 一致（表格直接 v-for） */
  amounts: number[]
}

/**
 * 平台 × 状态金额矩阵，按金额降序。
 *
 * 外卖单不单独成行 —— 它们属于母平台（京东/淘宝）。业务线切换靠顶部筛选，
 * 矩阵行一旦按业务线拆开，用户会以为「京东外卖」是另一个平台。
 */
export function buildPlatformMatrix(
  orders: Order[],
  nameOf: (platformId: string) => string
): PlatformStateRow[] {
  const map = new Map<string, PlatformStateRow>()
  let total = 0

  for (const o of orders) {
    const amount = amountOf(o)
    total += amount
    let row = map.get(o.platform)
    if (!row) {
      row = {
        id: o.platform,
        label: nameOf(o.platform) || o.platform,
        count: 0,
        amount: 0,
        share: 0,
        byState: { success: 0, pending: 0, refunding: 0, refunded: 0, closed: 0 },
        amounts: STATE_ORDER.map(() => 0)
      }
      map.set(o.platform, row)
    }
    const state = orderStateOf(o)
    row.count += 1
    row.amount += amount
    row.byState[state] += 1
    row.amounts[STATE_ORDER.indexOf(state)] += amount
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      amount: round2(row.amount),
      amounts: row.amounts.map(round2),
      share: total > 0 ? row.amount / total : 0
    }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 覆盖天数（含首尾），用于「日均支出」 */
export function activeDaysOf(orders: Order[]): number {
  const days = new Set<string>()
  for (const o of orders) {
    const ymd = parseYmd(o.createdAt)
    if (ymd) days.add(`${ymd.y}-${ymd.m}-${ymd.d}`)
  }
  return days.size
}

/** 最早 / 最晚下单单据的日期（`YYYY-MM-DD`，无数据返回空串） */
export function dateRangeOf(orders: Order[]): { first: string; last: string } {
  let first = ''
  let last = ''
  for (const o of orders) {
    const ymd = parseYmd(o.createdAt)
    if (!ymd) continue
    const date = `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`
    if (!first || date < first) first = date
    if (!last || date > last) last = date
  }
  return { first, last }
}
