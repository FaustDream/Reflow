import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractMeituanOrders, meituanAdapter, normalizeMeituanOrder } from '../meituan'
import { matchRuleMatches } from '../adapter'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/meituan-order-list.json'), 'utf-8')
)
const report = (body: unknown): CaptureReport => ({
  kind: 'xhr',
  url: 'https://wx.waimai.meituan.com/api/order/list?page=1',
  method: 'POST',
  status: 200,
  body,
  ts: Date.now()
})

describe('美团适配器：声明', () => {
  it('id/分区/入口', () => {
    expect(meituanAdapter.id).toBe('meituan')
    expect(meituanAdapter.partition).toBe('persist:platform-meituan')
    // 入口是 C 端 H5 订单页（wx.waimai 是小程序 API 网关，浏览器打不开）
    expect(meituanAdapter.homeUrl).toContain('h5.waimai.meituan.com')
  })

  it('域为宽匹配（结构由 digestlist 判定）', () => {
    const rule = meituanAdapter.matchRules[0]
    expect(
      matchRuleMatches(rule, 'https://wx.waimai.meituan.com/api/order/list', 'POST', 'xhr')
    ).toBe(true)
    expect(
      matchRuleMatches(rule, 'https://other.meituan.com/api/order/list', 'POST', 'xhr')
    ).toBe(false)
  })

  it('同域非订单响应静默忽略（不刷解析错误）', () => {
    const r = meituanAdapter.parse(report({ data: { somethingElse: [] } }))
    expect(r.orders).toEqual([])
  })
})

describe('美团适配器：解析', () => {
  const { orders, account } = meituanAdapter.parse(report(fixture))

  it('两单：订单号取 wm_order_id、门店名、状态', () => {
    expect(orders).toHaveLength(2)
    const first = orders[0]
    expect(first.platform).toBe('meituan')
    expect(first.orderId).toBe('2100000000000001')
    expect(first.shopName).toBe('合成羊肉炉店（示例）')
    expect(first.status).toBe('已完成')
    expect(orders[1].orderId).toBe('2100000000000002')
    expect(orders[1].shopName).toBe('合成快餐店')
  })

  it('餐品摘要按原版规则拼接（数量 >1 追加 xN）', () => {
    expect(orders[0].title).toBe('合成羊杂粉 合成小菜 x2')
    expect(orders[1].title).toBe('合成套餐')
  })

  it('金额为元：total 22.8 原样，缺失时回退 product_total', () => {
    expect(orders[0].paidAmount).toBe('22.8')
    expect(orders[0].quantity).toBe(3)
    // 22.8 / 3 = 7.6
    expect(orders[0].unitPrice).toBe('7.6')
    expect(orders[1].paidAmount).toBe('15')
    expect(orders[1].quantity).toBe(1)
    expect(orders[1].unitPrice).toBe('15')
  })

  it('order_time 为秒时间戳 → 可读字符串', () => {
    expect(orders[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 1750260311 秒 ≈ 2025-06-19
    expect(orders[0].createdAt).toContain('2025-06-')
    // 第二单是毫秒时间戳，同样可解析
    expect(orders[1].createdAt).toContain('2025-09-')
  })

  it('商品图取首个 product_pic，http→https，协议相对补全', () => {
    expect(orders[0].imageUrl).toBe('https://p0.meituan.net/xianfu/synthetic-a.png')
    // //p0.meituan.net/... 协议相对
    expect(orders[1].imageUrl).toBe('https://p0.meituan.net/xianfu/synthetic-c.png')
  })

  it('账号取自根级 userId/userName（不在 data 内）', () => {
    expect(account).toEqual({ userId: '880000001', nickname: '合成美团用户' })
    expect(orders[0].account).toBe('880000001')
  })

  it('本地生活扩展列：配送状态/自取/预计送达', () => {
    const first = orders[0]
    expect(first.extra.deliveryStatus).toBe('已送达')
    expect(first.extra.isSelfPick).toBe('配送')
    expect(first.extra.estimateArrival).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(orders[1].extra.deliveryStatus).toBe('配送中')
    expect(orders[1].extra.isSelfPick).toBe('自取')
    // 外卖无快递字段
    expect(first.logisticsCompany).toBe('')
    expect(first.trackingNo).toBe('')
  })

  it('userId 缺失时仍然入库（单账号模式不依赖它；H5 响应就不带）', () => {
    const noUser = { data: { digestlist: [{ wm_order_id: 1 }] }, status: 200 }
    const result = meituanAdapter.parse(report(noUser))
    expect(result.orders).toHaveLength(1)
    expect(result.account).toBeUndefined()
  })

  it('19 位订单号：字符串形式原样保留，数字形式已丢精度（对照）', () => {
    // 真实链路：注入 Hook 的 protectBigInts 会先把超长整数转成字符串（见 hook-source 测试）
    const asString = {
      data: { digestlist: [{ wm_order_id: '2100000000000000001', status_description: '已完成' }] },
      userId: 'U1',
      status: 200
    }
    expect(meituanAdapter.parse(report(asString)).orders[0].orderId).toBe('2100000000000000001')

    // 对照：若上游没做保护（数字字面量），解析结果必然不等于原单号 —— 这正是要防护的场景
    const asNumber = { data: { digestlist: [{ wm_order_id: 2100000000000000001 }] }, userId: 'U1' }
    const raw = meituanAdapter.parse(report(asNumber)).orders[0].orderId
    expect(raw).not.toBe('2100000000000000001')
  })

  it('空 digestlist 是合法结果', () => {
    const r = meituanAdapter.parse(report({ data: { digestlist: [] }, userId: 'X' }))
    expect(r.orders).toEqual([])
    expect(r.pageInfo).toEqual({ hasMore: false })
  })

  it('extractMeituanOrders：digestlist 为主，兼容 H5 的几种包裹', () => {
    expect(extractMeituanOrders({ data: { digestlist: [{ order_id: 1 }] } })).toHaveLength(1)
    // H5 openh5/order/list 结构未定，兼容 list / orderList / 顶层数组
    expect(extractMeituanOrders({ data: { list: [{ order_id: 1 }] } })).toHaveLength(1)
    expect(extractMeituanOrders({ data: { orderList: [{ order_id: 1 }] } })).toHaveLength(1)
    expect(extractMeituanOrders({ orderList: [{ order_id: 1 }] })).toHaveLength(1)
    expect(extractMeituanOrders({})).toEqual([])
    expect(extractMeituanOrders({ data: { other: 1 } })).toEqual([])
  })

  it('normalizeMeituanOrder 对空对象不抛错', () => {
    const o = normalizeMeituanOrder({})
    expect(o.orderId).toBe('')
    expect(o.title).toBe('')
    expect(o.paidAmount).toBe('')
  })
})

/**
 * 2026-10-26 真机响应（`i.waimai.meituan.com/openh5/order/list`）。
 *
 * 旧实现按小程序的 `wm_order_id / poi_name / status_description` 取值，
 * H5 全是别的字段名 → 订单号空串 → 渲染层按空单号去重互相覆盖 →
 * 界面「只有 2 单且全空」（用户实测故障）。这里锁死 H5 字段映射。
 */
describe('美团适配器：H5 openh5/order/list 真机结构', () => {
  const h5 = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../testdata/meituan-order-list-h5.json'), 'utf-8')
  )
  const parsed = meituanAdapter.parse({
    kind: 'xhr',
    url: 'https://i.waimai.meituan.com/openh5/order/list?_=1793005032653&yodaReady=h5',
    method: 'GET',
    status: 200,
    body: h5,
    ts: Date.now()
  })
  const [first, second] = parsed.orders

  it('订单号取 orderId（19 位字符串原样）', () => {
    expect(parsed.orders).toHaveLength(2)
    expect(first.orderId).toBe('2600000000000000001')
    expect(second.orderId).toBe('2600000000000000002')
  })

  it('门店/状态/金额取 H5 字段名', () => {
    expect(first.shopName).toBe('合成药房（十六分店）')
    expect(first.status).toBe('已完成')
    // totalPrice 是字符串「元」，不改写精度
    expect(first.paidAmount).toBe('70.44')
    expect(second.paidAmount).toBe('25.8')
  })

  it('餐品来自 productList，数量汇总 → 单价', () => {
    expect(first.title).toBe('合成药片 10mg*50片/盒 x2')
    expect(first.quantity).toBe(2)
    expect(first.unitPrice).toBe('35.22')
    // 两个商品各 1 份
    expect(second.title).toBe('合成烤鸭单人套餐 合成可乐')
    expect(second.quantity).toBe(2)
  })

  it('时间：orderTimeSec 优先，其次 orderTime（无秒补 00）', () => {
    expect(first.createdAt).toBe('2026-03-02 18:00:31')
    expect(second.createdAt).toBe('2025-12-13 11:06:28')
    // 只有 orderTime（`YYYY-MM-DD HH:mm`）时也能解析
    const onlyText = meituanAdapter.parse({
      kind: 'xhr',
      url: 'https://i.waimai.meituan.com/openh5/order/list?_=1',
      method: 'GET',
      status: 200,
      body: { data: { orderList: [{ orderId: 'X1', orderTime: '2026-01-02 03:04' }] } },
      ts: Date.now()
    })
    expect(onlyText.orders[0].createdAt).toBe('2026-01-02 03:04:00')
  })

  it('图片 http→https、协议相对补全', () => {
    expect(first.imageUrl).toBe('https://p0.meituan.net/business/synthetic-a.png')
    expect(second.imageUrl).toBe('https://p0.meituan.net/business/synthetic-b.png')
  })

  it('详情深链与门店 poi 进扩展列', () => {
    expect(first.extra.orderDetailUrl).toContain('h5.waimai.meituan.com')
    expect(first.extra.poiId).toBe('SYNTH_POI_0001')
  })

  it('分页：isEnd=false → hasMore，cursor 透传', () => {
    expect(parsed.pageInfo?.hasMore).toBe(true)
    expect(parsed.pageInfo?.cursor).toContain('order_time')
  })
})
