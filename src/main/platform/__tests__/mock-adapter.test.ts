import { describe, expect, it } from 'vitest'
import { CORE_EXPORT_COLUMNS } from '../../../shared/types/order'
import { MOCK_PLATFORM_ORIGIN, mockAdapter } from '../mock-adapter'

const report = (body: unknown) => ({
  kind: 'xhr' as const,
  url: `${MOCK_PLATFORM_ORIGIN}/api/orders-xhr?page=1`,
  method: 'GET',
  status: 200,
  body,
  ts: Date.now()
})

describe('mockAdapter：接口完备性样例（003 验收）', () => {
  it('实现 PlatformAdapter 全部必填成员', () => {
    expect(typeof mockAdapter.id).toBe('string')
    expect(typeof mockAdapter.displayName).toBe('string')
    expect(typeof mockAdapter.homeUrl).toBe('string')
    expect(Array.isArray(mockAdapter.matchRules)).toBe(true)
    expect(mockAdapter.matchRules.length).toBeGreaterThan(0)
    expect(typeof mockAdapter.parse).toBe('function')
    expect(Array.isArray(mockAdapter.columns)).toBe(true)
    expect(typeof mockAdapter.supportsSeller).toBe('boolean')
  })

  it('声明 XHR / fetch / JSONP 三种形态的匹配规则（005 依赖）', () => {
    const kinds = mockAdapter.matchRules.map((r) => r.kind)
    expect(kinds).toContain('xhr')
    expect(kinds).toContain('fetch')
    expect(kinds).toContain('jsonp')
  })

  it('导出列只含 extended columns，核心列由引擎附加', () => {
    for (const col of mockAdapter.columns) {
      expect(CORE_EXPORT_COLUMNS.some((c) => c.key === col.key)).toBe(false)
    }
  })
})

describe('mockAdapter.parse', () => {
  it('合法响应 → 统一 Order[]（含 extra 扩展字段与时间规整）', () => {
    const { orders, account, pageInfo } = mockAdapter.parse(
      report({
        orders: [
          {
            orderId: 'M20261013001',
            title: '测试商品 A',
            paidAmount: '12.50',
            unitPrice: '6.25',
            quantity: 2,
            status: '已发货',
            createdAt: 1760340000000,
            shopName: 'mock 旗舰店',
            mockRemark: '扩展字段'
          }
        ],
        account: { userId: 'u-1', nickname: '测试账号' },
        pageInfo: { hasMore: 'true', totalCount: 100, cursor: 'row-10' }
      })
    )

    expect(orders).toHaveLength(1)
    const o = orders[0]
    expect(o.platform).toBe('mock')
    expect(o.account).toBe('u-1')
    expect(o.orderId).toBe('M20261013001')
    expect(o.title).toBe('测试商品 A')
    expect(o.paidAmount).toBe('12.50')
    expect(o.quantity).toBe(2)
    expect(o.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(o.extra.mockRemark).toBe('扩展字段')
    expect(account).toEqual({ userId: 'u-1', nickname: '测试账号' })
    expect(pageInfo).toEqual({ hasMore: true, totalCount: 100, cursor: 'row-10' })
  })

  it('结构异常时抛错（不静默）', () => {
    expect(() => mockAdapter.parse(report({ foo: 1 }))).toThrow(/结构异常/)
    expect(() => mockAdapter.parse(report(null))).toThrow(/结构异常/)
    expect(() => mockAdapter.parse(report('str'))).toThrow(/结构异常/)
  })

  it('空 orders 数组合法，返回空结果', () => {
    const r = mockAdapter.parse(report({ orders: [] }))
    expect(r.orders).toEqual([])
  })
})
