import { describe, expect, it } from 'vitest'
import { jdOrderListOf, jdYearCode, resolveYearRanges } from '../jd-api-fetch'

describe('工单 040：京东年份码', () => {
  it('今年=2，往年=YYYY（d 参数语义）', () => {
    expect(jdYearCode('current', 2026)).toBe(2)
    expect(jdYearCode(2026, 2026)).toBe(2)
    expect(jdYearCode(2025, 2026)).toBe(2025)
    expect(jdYearCode(2019, 2026)).toBe(2019)
  })

  it('range=all 展开：今年 + 往年逐年', () => {
    expect(resolveYearRanges('all', 3, 2026)).toEqual(['current', 2025, 2024])
    expect(resolveYearRanges('current', undefined, 2026)).toEqual(['current'])
  })
})

describe('工单 040：pcorder_center_list 响应取订单数组', () => {
  it('两种包裹形态：data.orderList 与 data.data.orderList', () => {
    const a = { data: { orderList: [{ orderId: '1' }] } }
    const b = { data: { data: { orderList: [{ orderId: '2' }] } } }
    expect(jdOrderListOf(a)).toEqual([{ orderId: '1' }])
    expect(jdOrderListOf(b)).toEqual([{ orderId: '2' }])
    expect(jdOrderListOf(null)).toEqual([])
    expect(jdOrderListOf({})).toEqual([])
  })
})
