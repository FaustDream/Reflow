import { describe, expect, it } from 'vitest'
import type { Order } from '@shared/types'
import {
  activeDaysOf,
  buildBreakdown,
  buildMonthlySeries,
  buildPlatformMatrix,
  dateRangeOf,
  emptyFilter,
  filterOverviewOrders,
  matchOrder,
  monthKeyOf,
  type OverviewFilter
} from '../overview-model'

/** 只填模型用得到的字段 */
function order(patch: Partial<Order> & { platform: string; orderId: string }): Order {
  return {
    platform: patch.platform,
    account: '',
    orderId: patch.orderId,
    createdAt: patch.createdAt ?? null,
    title: patch.title ?? '',
    imageUrl: '',
    unitPrice: '',
    paidAmount: patch.paidAmount ?? '',
    quantity: null,
    status: patch.status ?? '',
    shopName: patch.shopName ?? '',
    receiverName: '',
    receiverAddress: '',
    receiverPhone: '',
    logisticsCompany: '',
    trackingNo: '',
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    extra: patch.extra ?? {}
  }
}

const NOW = new Date('2026-11-11T12:00:00')

describe('buildBreakdown：五态金额分布', () => {
  const orders = [
    order({ platform: 'jd', orderId: '1', status: '已完成', paidAmount: '100', createdAt: '2026-11-01 10:00:00' }),
    order({ platform: 'jd', orderId: '2', status: '已完成', paidAmount: '100', createdAt: '2026-11-02 10:00:00' }),
    order({ platform: 'tb', orderId: '3', status: '待发货', paidAmount: '50', createdAt: '2026-11-03 10:00:00' }),
    order({ platform: 'tb', orderId: '4', status: '退款中', paidAmount: '30', createdAt: '2026-11-04 10:00:00' }),
    order({ platform: 'tb', orderId: '5', status: '退款成功', paidAmount: '20', createdAt: '2026-11-05 10:00:00' }),
    order({ platform: 'pdd', orderId: '6', status: '已取消', paidAmount: '0', createdAt: '2026-11-06 10:00:00' })
  ]

  it('每个状态都有单数、金额、两种占比', () => {
    const b = buildBreakdown(orders)
    const get = (k: string): (typeof b.slices)[number] => b.slices.find((s) => s.key === k)!
    expect(get('success').count).toBe(2)
    expect(get('success').amount).toBe(200)
    expect(get('pending').amount).toBe(50)
    expect(get('refunding').amount).toBe(30)
    expect(get('refunded').amount).toBe(20)
    expect(get('closed').count).toBe(1)
    // 占比分母 = 全部订单金额 300（含进行中 / 退款 / 关闭）
    expect(get('success').amountShare).toBeCloseTo(200 / 300, 5)
    expect(get('success').countShare).toBeCloseTo(2 / 6, 5)
    expect(b.amount).toBe(300)
    expect(b.count).toBe(6)
  })

  it('派生口径：在途、已退款含退款中、净支出、退款率', () => {
    const b = buildBreakdown(orders)
    expect(b.paidAmount).toBe(200)
    expect(b.inFlightAmount).toBe(80) // 进行中 50 + 退款中 30
    expect(b.refundedAmount).toBe(50) // 退款中 30 + 已退款 20
    expect(b.netSpend).toBe(150) // 200 - 50
    expect(b.refundRate).toBeCloseTo(50 / 250, 5)
  })

  it('空集合不产生 NaN', () => {
    const b = buildBreakdown([])
    expect(b.amount).toBe(0)
    expect(b.refundRate).toBe(0)
    expect(b.slices.every((s) => Number.isFinite(s.amountShare) && Number.isFinite(s.countShare))).toBe(
      true
    )
    expect(b.slices).toHaveLength(5)
  })

  it('金额为字符串带符号时也能算', () => {
    const b = buildBreakdown([
      order({ platform: 'jd', orderId: 'x', status: '已完成', paidAmount: '¥1,299.50' })
    ])
    expect(b.paidAmount).toBe(1299.5)
  })
})

describe('筛选：时间 / 业务线 / 平台 / 状态 / 月份', () => {
  const localOrder = order({
    platform: 'jd',
    orderId: 'jd-local',
    title: '黄焖鸡米饭',
    status: '已完成',
    paidAmount: '25',
    createdAt: '2026-11-10 12:00:00'
  })
  const shopOrder = order({
    platform: 'jd',
    orderId: 'jd-shop',
    title: '机械键盘',
    status: '已完成',
    paidAmount: '399',
    createdAt: '2026-03-10 12:00:00',
    extra: { itemUrl: 'https://item.jd.com/1.html' }
  })
  const refunded = order({
    platform: 'taobao',
    orderId: 'tb-refund',
    status: '退款成功',
    paidAmount: '88',
    createdAt: '2025-12-31 23:00:00'
  })

  const base: OverviewFilter = emptyFilter()

  it('默认全通过', () => {
    expect(matchOrder(shopOrder, base, NOW)).toBe(true)
  })

  it('业务线：外卖只命中外卖单', () => {
    expect(matchOrder(localOrder, { ...base, biz: 'local' }, NOW)).toBe(true)
    expect(matchOrder(shopOrder, { ...base, biz: 'local' }, NOW)).toBe(false)
    expect(matchOrder(shopOrder, { ...base, biz: 'shopping' }, NOW)).toBe(true)
  })

  it('平台白名单', () => {
    expect(matchOrder(refunded, { ...base, platforms: ['jd'] }, NOW)).toBe(false)
    expect(matchOrder(refunded, { ...base, platforms: ['taobao'] }, NOW)).toBe(true)
  })

  it('状态多选', () => {
    expect(matchOrder(refunded, { ...base, states: ['refunded'] }, NOW)).toBe(true)
    expect(matchOrder(refunded, { ...base, states: ['success'] }, NOW)).toBe(false)
  })

  it('今年：跨年订单被排除', () => {
    expect(matchOrder(refunded, { ...base, range: 'year' }, NOW)).toBe(false)
    expect(matchOrder(shopOrder, { ...base, range: 'year' }, NOW)).toBe(true)
  })

  it('近 7 天：更早的和无时间的都排除', () => {
    const noDate = order({ platform: 'jd', orderId: 'no-date', status: '已完成' })
    expect(matchOrder(localOrder, { ...base, range: '7d' }, NOW)).toBe(true)
    expect(matchOrder(shopOrder, { ...base, range: '7d' }, NOW)).toBe(false)
    expect(matchOrder(noDate, { ...base, range: '7d' }, NOW)).toBe(false)
    // 但「全部时间」下无时间订单仍然算
    expect(matchOrder(noDate, base, NOW)).toBe(true)
  })

  it('月份锁定', () => {
    expect(monthKeyOf(shopOrder)).toBe('2026-03')
    expect(matchOrder(shopOrder, { ...base, month: '2026-03' }, NOW)).toBe(true)
    expect(matchOrder(shopOrder, { ...base, month: '2026-04' }, NOW)).toBe(false)
  })

  it('组合筛选：时间 + 平台 + 状态', () => {
    const picked = filterOverviewOrders(
      [localOrder, shopOrder, refunded],
      { ...base, range: 'year', platforms: ['jd'], states: ['success'] },
      NOW
    )
    expect(picked.map((o) => o.orderId)).toEqual(['jd-local', 'jd-shop'])
  })
})

describe('buildMonthlySeries：近 N 个月', () => {
  const orders = [
    order({ platform: 'jd', orderId: 'a', status: '已完成', paidAmount: '100', createdAt: '2026-11-01 10:00:00' }),
    order({ platform: 'jd', orderId: 'b', status: '退款成功', paidAmount: '40', createdAt: '2025-12-20 10:00:00' }),
    order({ platform: 'jd', orderId: 'c', status: '待发货', paidAmount: '60', createdAt: '2026-11-02 10:00:00' })
  ]

  it('12 个月窗口跨年、空月补零、标签连续', () => {
    const series = buildMonthlySeries(orders, 12, NOW)
    expect(series).toHaveLength(12)
    expect(series[0].key).toBe('2025-12')
    expect(series[11].key).toBe('2026-11')
    expect(series.map((s) => s.label)).toEqual([
      '12月',
      '1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月',
      '11月'
    ])

    const dec = series[0]
    expect(dec.refundAmount).toBe(40)
    expect(dec.refundCount).toBe(1)

    const nov = series[11]
    expect(nov.paidAmount).toBe(100)
    expect(nov.pendingAmount).toBe(60)
    expect(nov.count).toBe(2)

    // 窗口外的订单不进趋势
    const short = buildMonthlySeries(orders, 1, NOW)
    expect(short).toHaveLength(1)
    expect(short[0].paidAmount).toBe(100)
  })
})

describe('buildPlatformMatrix：平台 × 状态', () => {
  const orders = [
    order({ platform: 'jd', orderId: '1', status: '已完成', paidAmount: '300' }),
    order({ platform: 'jd', orderId: '2', status: '退款成功', paidAmount: '100' }),
    order({ platform: 'taobao', orderId: '3', status: '待发货', paidAmount: '200' })
  ]
  const nameOf = (id: string): string => ({ jd: '京东', taobao: '淘宝' })[id] ?? id

  it('按平台聚合并按金额降序', () => {
    const rows = buildPlatformMatrix(orders, nameOf)
    expect(rows.map((r) => r.id)).toEqual(['jd', 'taobao'])
    expect(rows[0].label).toBe('京东')
    expect(rows[0].count).toBe(2)
    expect(rows[0].amount).toBe(400)
    expect(rows[0].share).toBeCloseTo(400 / 600, 5)
    expect(rows[0].byState.success).toBe(1)
    expect(rows[0].byState.refunded).toBe(1)
    // amounts 顺序 = STATE_ORDER（成功 / 进行中 / 退款中 / 已退款 / 关闭）
    expect(rows[0].amounts).toEqual([300, 0, 0, 100, 0])
    expect(rows[1].amounts).toEqual([0, 200, 0, 0, 0])
  })
})

describe('辅助：覆盖天数与日期区间', () => {
  const orders = [
    order({ platform: 'jd', orderId: '1', createdAt: '2026-03-05 10:00:00' }),
    order({ platform: 'jd', orderId: '2', createdAt: '2026-03-05 22:00:00' }),
    order({ platform: 'jd', orderId: '3', createdAt: '2026-01-20 10:00:00' }),
    order({ platform: 'jd', orderId: '4', createdAt: null })
  ]

  it('同一天多单只算一天，无时间订单不计', () => {
    expect(activeDaysOf(orders)).toBe(2)
    expect(dateRangeOf(orders)).toEqual({ first: '2026-01-20', last: '2026-03-05' })
  })
})
