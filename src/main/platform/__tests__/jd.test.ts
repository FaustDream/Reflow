import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractJdOrderArray, jdAdapter, normalizeJdOrder } from '../jd'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/jd-order-list.json'), 'utf-8')
)
const report = (body: unknown): CaptureReport => ({
  kind: 'xhr',
  url: 'https://order.jd.com/center/list.action?d=1&page=1&__fetch__=1',
  method: 'GET',
  status: 200,
  body,
  ts: Date.now()
})

describe('京东适配器：路由', () => {
  it('__fetch__=1 的 list.action 命中；HTML 形态（不带标记）不命中', () => {
    const rule = jdAdapter.matchRules[0]
    const url = 'https://order.jd.com/center/list.action?d=1&page=2&__fetch__=1'
    expect(typeof rule.pattern === 'string' ? rule.pattern.includes('__fetch__=1') : false).toBe(true)
    expect(url).toContain('__fetch__=1')
    expect(jdAdapter.partition).toBe('persist:platform-jd')
    // 老版 thor+pin，新版只有 unick（昵称）→ any 模式覆盖两代
    expect(jdAdapter.login?.mode).toBe('any')
    expect(jdAdapter.login?.cookies.map((c) => c.name)).toEqual(['thor', 'pin', 'unick'])
  })

  it('extractJdOrderArray：裸数组与 data.orderList 包裹均可', () => {
    expect(extractJdOrderArray(fixture)).toHaveLength(2)
    expect(
      extractJdOrderArray({ data: { orderList: fixture } })
    ).toHaveLength(2)
    expect(extractJdOrderArray({ data: { data: { orderList: [fixture[0]] } } })).toHaveLength(1)
    expect(extractJdOrderArray({ html: '...' })).toEqual([])
  })
})

describe('京东适配器：解析', () => {
  const { orders } = jdAdapter.parse(report(fixture))

  it('一单一行，多商品标题连接、数量合计', () => {
    expect(orders).toHaveLength(2)
    const first = orders[0]
    expect(first.platform).toBe('jd')
    expect(first.orderId).toBe('123456789012')
    expect(first.createdAt).toBe('2026-09-01 10:20:30')
    expect(first.status).toBe('等待收货')
    expect(first.paidAmount).toBe('199.00')
    expect(first.shopName).toBe('合成测试旗舰店')
    expect(first.title).toBe('合成商品甲；合成商品乙（赠品）')
    expect(first.quantity).toBe(3)
    expect(first.imageUrl).toBe('https://img14.360buyimg.com/n1/jfs/t1/synthetic-a.jpg')
  })

  it('收货信息与扩展字段', () => {
    const first = orders[0]
    expect(first.receiverName).toBe('合成收货人')
    expect(first.receiverAddress).toBe('北京市朝阳区合成路1号')
    expect(first.receiverPhone).toBe('13800000001')
    expect(first.extra.payMethod).toBe('在线支付')
    expect(first.extra.itemCount).toBe('2')
    expect(first.extra.itemUrl).toBe('https://item.jd.com/100011.html')
  })

  it('毫秒时间戳与缺省店铺名（京东）', () => {
    expect(orders[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(orders[1].shopName).toBe('京东')
  })

  it('normalizeJdOrder 对畸形输入不抛错', () => {
    const o = normalizeJdOrder({})
    expect(o.orderId).toBe('')
    expect(o.title).toBe('')
    expect(o.quantity).toBeNull()
  })

  it('空响应抛错（登录跳转/验证页防护）', () => {
    expect(() => jdAdapter.parse(report({ html: '<html></html>' }))).toThrow(/未找到订单数组/)
  })
})

describe('京东适配器：虚拟/服务类订单（无 fistPrice、无 orderStateName）', () => {
  const virtual = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../testdata/jd-virtual-order.json'), 'utf-8')
  )

  it('金额兜底到 shouldPay/totalPrice/price —— 0 元单要给 "0" 而不是空串', () => {
    const o = normalizeJdOrder(virtual)
    // 页面显示「总额 ¥0.00」：0 是有效金额，不能因为假值判断丢掉
    expect(o.paidAmount).toBe('0')
  })

  it('orderState=18 兜底成「已完成」（同批响应里普通订单的 orderStateName 就是它）', () => {
    const o = normalizeJdOrder(virtual)
    expect(o.status).toBe('已完成')
  })

  it('普通订单仍以 fistPrice / orderStateName 为准（实付优先于商品总价）', () => {
    const o = normalizeJdOrder({
      orderId: '123456789012',
      itemPayInfo: { fistPrice: '4.00', price: 19, totalPrice: 19 },
      statusInfo: { orderState: 18, orderStateName: '已完成' }
    })
    expect(o.paidAmount).toBe('4.00')
    expect(o.status).toBe('已完成')
  })

  it('未核实的 orderState 不乱猜，留空', () => {
    const o = normalizeJdOrder({ orderId: '1', statusInfo: { orderState: 99 } })
    expect(o.status).toBe('')
  })
})
