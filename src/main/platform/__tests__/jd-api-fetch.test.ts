import { describe, expect, it } from 'vitest'
import {
  classifyJdPage,
  isJdEmptyPageShell,
  jdOrderListOf,
  jdYearCode,
  resolveYearRanges
} from '../jd-api-fetch'

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

/** 2026-11-11 用户实际抓到的越界页响应，原样使用 */
const PAGE_OVERFLOW_SHELL = {
  revision: 2,
  success: true,
  traceId: '9379447.86251.17943779341034347',
  requestId: '10105284940-128614-1794377934094',
  recycleType: 0
}

describe('页码越界空壳：{success:true} 且无 data', () => {
  it('识别越界空壳', () => {
    expect(isJdEmptyPageShell(PAGE_OVERFLOW_SHELL)).toBe(true)
  })

  it('正常响应、失败响应都不算空壳', () => {
    expect(isJdEmptyPageShell({ data: { orderList: [] } })).toBe(false)
    expect(isJdEmptyPageShell({ success: false, msg: '未登录' })).toBe(false)
    expect(isJdEmptyPageShell({ success: true, code: '3', message: '风控' })).toBe(false)
    expect(isJdEmptyPageShell({})).toBe(false)
    expect(isJdEmptyPageShell(null)).toBe(false)
  })

  it('已取到过数据的抓取：空壳 = 该年到底', () => {
    // 2024 年共 120 单 = 6 个整页，第 7 页越界
    expect(classifyJdPage(PAGE_OVERFLOW_SHELL, 16, JSON.stringify(PAGE_OVERFLOW_SHELL))).toBe(
      'year-end'
    )
  })

  it('首屏就是空壳仍按异常上报（防「静默 0 单」）', () => {
    expect(classifyJdPage(PAGE_OVERFLOW_SHELL, 0, JSON.stringify(PAGE_OVERFLOW_SHELL))).toBe(
      'error'
    )
  })

  it('登录失效优先于到底判定，交给续期重试', () => {
    const text = '{"code":1,"msg":"请先登录"}'
    expect(classifyJdPage(JSON.parse(text), 5, text)).toBe('login')
  })

  it('正常页不改判', () => {
    const text = '{"data":{"orderList":[]}}'
    expect(classifyJdPage(JSON.parse(text), 0, text)).toBe('ok')
  })
})
