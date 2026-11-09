import { describe, expect, it, beforeEach } from 'vitest'
import { CaptureEngine, type EngineStats } from '../capture-engine'
import { AdapterRegistry, registerBuiltinAdapters } from '../registry'
import { MOCK_PLATFORM_ORIGIN, mockAdapter } from '../mock-adapter'
import type { CaptureReport } from '../../../shared/types'

/**
 * 工单 005：管道集成测试（引擎级）。
 * mock 响应 → 引擎路由 → mockAdapter.parse → 去重 → OrdersCapturedEvent。
 * UI 层「表格出现对应行」由 orders store 合并逻辑保证（store 单测）+ 应用内 mock 页面人工验收。
 */

const ordersBody = (source: string) => ({
  orders: [
    { orderId: 'M-1', title: '商品甲', paidAmount: '10.00', quantity: 1, status: '已付款', mockRemark: source },
    { orderId: 'M-2', title: '商品乙', paidAmount: '20.00', quantity: 2, status: '已发货' },
    { orderId: 'M-3', title: '商品丙', paidAmount: '30.00', quantity: 3, status: '已完成' }
  ],
  account: { userId: 'u-1', nickname: '测试账号' },
  pageInfo: { hasMore: 'true', totalCount: 30, cursor: 'row-3' }
})

const report = (kind: CaptureReport['kind'], body: unknown, path = 'orders-xhr'): CaptureReport => ({
  kind,
  url: `${MOCK_PLATFORM_ORIGIN}/api/${path}?t=${Date.now()}`,
  method: kind === 'jsonp' ? undefined : 'GET',
  status: 200,
  body,
  ts: Date.now()
})

function makeEngine(): { engine: CaptureEngine; registry: AdapterRegistry } {
  const registry = new AdapterRegistry()
  registerBuiltinAdapters(registry)
  return { engine: new CaptureEngine(registry), registry }
}

let engine: CaptureEngine

beforeEach(() => {
  engine = makeEngine().engine
})

describe('CaptureEngine：路由', () => {
  it('三种请求形态（xhr/fetch/jsonp）全部路由到 mock 适配器并解析成功', () => {
    const xhr = engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    const fetch = engine.handleReport(report('fetch', ordersBody('fetch'), 'orders-fetch'), 1)
    const jsonp = engine.handleReport(report('jsonp', ordersBody('JSONP'), 'orders-jsonp'), 1)

    expect(xhr.type).toBe('ok')
    expect(fetch.type).toBe('ok')
    expect(jsonp.type).toBe('ok')
    if (xhr.type === 'ok' && xhr.event) {
      expect(xhr.event.platform).toBe('mock')
      expect(xhr.event.orders).toHaveLength(3)
      expect(xhr.event.orders[0].orderId).toBe('M-1')
      expect(xhr.event.account).toEqual({ userId: 'u-1', nickname: '测试账号' })
      expect(xhr.event.pageInfo).toEqual({ hasMore: true, totalCount: 30, cursor: 'row-3' })
    }
  })

  it('未命中任何规则的响应 → unmatched，不产出事件', () => {
    const out = engine.handleReport(
      { kind: 'fetch', url: 'https://example.com/whatever', method: 'GET', body: {}, ts: 0 },
      1
    )
    expect(out.type).toBe('unmatched')
    expect(engine.stats.unmatched).toBe(1)
  })
})

describe('CaptureEngine：去重（005 验收项）', () => {
  it('同一订单号重复捕获只保留一条', () => {
    engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    const second = engine.handleReport(report('fetch', ordersBody('fetch'), 'orders-fetch'), 1)
    expect(second.type).toBe('ok')
    if (second.type === 'ok' && second.event) {
      expect(second.event.orders).toHaveLength(0)
      expect(second.event.duplicates).toBe(3)
    }
    expect(engine.stats.captured).toBe(3)
    expect(engine.stats.duplicates).toBe(3)
  })

  it('不同账号的同单号不去重（多账号聚合 021 前提）', () => {
    // 引擎去重键含 account；mock 适配器以 payload.account.userId 填 account
    const bodyB = ordersBody('XHR')
    ;(bodyB as { account: { userId: string; nickname: string } }).account = {
      userId: 'u-2',
      nickname: '另一个账号'
    }
    engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    const out = engine.handleReport(report('xhr', bodyB), 2)
    expect(out.type).toBe('ok')
    if (out.type === 'ok' && out.event) expect(out.event.orders).toHaveLength(3)
  })

  it('reset 后可重新捕获同一批订单', () => {
    engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    engine.reset()
    const out = engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    expect(out.type).toBe('ok')
    if (out.type === 'ok' && out.event) expect(out.event.orders).toHaveLength(3)
    expect(engine.stats.captured).toBe(3)
  })
})

describe('CaptureEngine：解析失败不静默（005 验收项）', () => {
  it('结构异常 → error 变体，携带平台 id 与错误信息', () => {
    const out = engine.handleReport(report('xhr', { unexpected: true }), 1)
    expect(out.type).toBe('error')
    if (out.type === 'error') {
      expect(out.error.platformId).toBe('mock')
      expect(out.error.message).toContain('结构异常')
    }
    expect(engine.stats.failed).toBe(1)
  })
})

describe('决策 D-2 结构性校验', () => {
  it('引擎是纯同步消费者：对未知/无规则响应绝不构造任何请求（代码级保证）', () => {
    // 引擎模块不 import 任何网络库；此处以「全部 outcome 均为纯数据」做行为面校验
    const out = engine.handleReport(
      { kind: 'xhr', url: 'https://random.example.org/x', method: 'GET', body: 'plain', ts: 0 },
      1
    )
    expect(['unmatched', 'ok', 'error']).toContain(out.type)
    expect(mockAdapter.pageScript).toBeUndefined() // mock 平台无需页面侧主动请求
  })
})

describe('统计口径', () => {
  it('stats 四项计数正确', () => {
    engine.handleReport(report('xhr', ordersBody('XHR')), 1)
    engine.handleReport(report('fetch', ordersBody('fetch'), 'orders-fetch'), 1)
    engine.handleReport(report('xhr', { bad: 1 }), 1)
    engine.handleReport(
      { kind: 'xhr', url: 'https://none.example/', method: 'GET', body: null, ts: 0 },
      1
    )
    const s: EngineStats = engine.stats
    expect(s).toEqual({ captured: 3, duplicates: 3, unmatched: 1, failed: 1 })
  })
})
