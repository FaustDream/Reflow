import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePddOrder, pddAdapter } from '../pdd'
import { matchRuleMatches } from '../adapter'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/pdd-order-list.json'), 'utf-8')
)
const report = (body: unknown): CaptureReport => ({
  kind: 'xhr',
  url: 'https://mobile.yangkeduo.com/proxy/api/api/order_list/v1?page=1&size=20',
  method: 'GET',
  status: 200,
  body,
  ts: Date.now()
})

describe('拼多多适配器：声明', () => {
  it('域为 yangkeduo，登录靠 PDDAccessToken', () => {
    expect(pddAdapter.id).toBe('pdd')
    expect(pddAdapter.partition).toBe('persist:platform-pdd')
    expect(pddAdapter.login?.cookies[0].name).toBe('PDDAccessToken')
    expect(pddAdapter.homeUrl).toContain('yangkeduo.com')
  })

  it('匹配覆盖新旧订单端点', () => {
    const legacy = 'https://mobile.yangkeduo.com/proxy/api/api/order_list/v1?page=1&size=20'
    // 实测主接口（orders.html）
    const v4 =
      'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?pdduid=10001'
    const matches = (url: string): boolean =>
      pddAdapter.matchRules.some((r) => matchRuleMatches(r, url, 'GET', 'xhr'))
    expect(matches(legacy)).toBe(true)
    expect(matches(v4)).toBe(true)
    // 非订单端点不应命中（避免把 yangkeduo 全量流量当订单解析）
    expect(matches('https://mobile.yangkeduo.com/proxy/api/api/goods/v1/detail')).toBe(false)
  })

  it('入口是 orders.html（order.html 会 302 过去）', () => {
    expect(pddAdapter.homeUrl).toBe('https://mobile.yangkeduo.com/orders.html')
  })
})

describe('拼多多适配器：解析（候选契约，D-1 观察法）', () => {
  const { orders, pageInfo } = pddAdapter.parse(report(fixture))

  it('两单：订单号 YYMMDD-15位、标题、金额、数量', () => {
    expect(orders).toHaveLength(2)
    const first = orders[0]
    expect(first.platform).toBe('pdd')
    expect(first.orderId).toBe('261001-086088167827991')
    expect(first.title).toBe('合成PDD商品甲；合成PDD商品乙')
    expect(first.paidAmount).toBe('129.90')
    expect(first.quantity).toBe(3)
    expect(first.status).toBe('已发货')
    expect(first.shopName).toBe('合成PDD旗舰店')
    expect(first.createdAt).toBe('2026-10-01 09:12:30')
  })

  it('收货与物流 core 字段', () => {
    const first = orders[0]
    expect(first.receiverName).toBe('合成收货人')
    expect(first.receiverAddress).toBe('上海市浦东新区合成大道100号')
    expect(first.receiverPhone).toBe('13900000002')
    expect(first.logisticsCompany).toBe('合成快递')
    expect(first.trackingNo).toBe('SF1234567890')
    expect(first.paidAt).toBe('2026-10-01 09:13:01')
    expect(first.shippedAt).toBe('2026-10-02 18:00:00')
  })

  it('25 列扩展字段：规格/店ID/商品ID/支付方式/备注/运费/快递状态/链接', () => {
    const extra = orders[0].extra
    expect(extra.mallId).toBe('900001')
    expect(extra.goodsId).toBe('11001')
    expect(extra.skuSpec).toBe('规格：蓝色；规格：白色')
    expect(extra.payMethod).toBe('微信支付')
    expect(extra.remark).toBe('尽快发货')
    expect(extra.freight).toBe('0.00')
    expect(extra.trackingStatus).toBe('运输中')
    expect(extra.itemUrl).toContain('goods_id=11001')
  })

  it('第二单：total_amount 别名、confirm_time→成交时间、备选图片字段 thumb_url', () => {
    const second = orders[1]
    expect(second.paidAmount).toBe('59.00')
    expect(second.imageUrl).toBe('https://t00img.yangkeduo.com/goods/images/synthetic-c.jpg')
    expect(second.completedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('分页 totalCount/hasMore', () => {
    expect(pageInfo).toEqual({ hasMore: false, totalCount: 2 })
  })

  it('normalizePddOrder 对空对象不抛错', () => {
    const o = normalizePddOrder({})
    expect(o.orderId).toBe('')
    expect(o.title).toBe('')
  })

  it('空数组响应抛「未登录」提示', () => {
    expect(() => pddAdapter.parse(report({ result: { error_msg: '未登录' } }))).toThrow(/未登录/)
  })

  it('非订单接口的空响应静默忽略（不刷诊断噪音）', () => {
    const r = pddAdapter.parse({
      kind: 'xhr',
      url: 'https://mobile.yangkeduo.com/proxy/api/api/caterham/v3/query/my_order_group?pdduid=1',
      method: 'GET',
      status: 200,
      body: {},
      ts: Date.now()
    })
    expect(r.orders).toEqual([])
  })
})

/**
 * 2026-10-26 真机响应（`order_list_v4`）——「只有订单号」问题的回归测试。
 *
 * 旧实现按扁平 `order_sn/goods_list/pay_amount` 取值，真实响应里一个都没有，
 * 于是只剩订单号、其余全空。这里按真实结构断言每个字段都取到。
 */
describe('拼多多适配器：order_list_v4 真机结构', () => {
  const v4 = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../testdata/pdd-order-list-v4.json'), 'utf-8')
  )
  const { orders, pageInfo } = pddAdapter.parse({
    kind: 'xhr',
    url: 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?pdduid=10001',
    method: 'GET',
    status: 200,
    body: v4,
    ts: Date.now()
  })

  it('两种形态都解析：普通订单（order_goods 在父级）与多多买菜（在子订单里）', () => {
    expect(orders).toHaveLength(2)
    // 形态 A：type=1，商品直接挂在订单上
    const normal = orders[0]
    expect(normal.orderId).toBe('261010-481055239712433')
    expect(normal.title).toBe('合成普通订单商品 浴室拖鞋')
    expect(normal.status).toBe('已收货')
    expect(normal.shopName).toBe('合成普通店铺乙')
    expect(normal.imageUrl).toBe('https://img.pddpic.com/open-gw/synthetic-pdd.jpg')
    // 形态 B：type=2，商品在 orders[].order_goods
    const grocery = orders[1]
    expect(grocery.orderId).toBe('PO-261023-224505382432433')
    expect(grocery.title).toBe('合成PDD商品甲 2.5kg/袋；合成PDD商品乙 500g/袋')
    expect(grocery.status).toBe('待评价')
    expect(grocery.shopName).toBe('合成PDD店铺甲')
  })

  it('金额是「分」，转元后写入实付与单价', () => {
    // 1580 → 15.8；goods_price 2080 → 20.8
    expect(orders[0].paidAmount).toBe('15.8')
    expect(orders[0].unitPrice).toBe('20.8')
    expect(orders[0].quantity).toBe(2)
    // 2897 → 28.97；1699 → 16.99
    expect(orders[1].paidAmount).toBe('28.97')
    expect(orders[1].unitPrice).toBe('16.99')
    expect(orders[1].quantity).toBe(3)
  })

  it('普通订单用 order_time / shipping_time / receive_time / tracking_number', () => {
    expect(orders[0].createdAt).toBe('2026-10-10 11:43:41')
    expect(orders[0].shippedAt).toBe('2026-10-10 13:53:24')
    expect(orders[0].completedAt).toBe('2026-10-13 11:06:54')
    expect(orders[0].trackingNo).toBe('JT5534678129090')
    // 多多买菜没有这些字段，靠 sort_id 推下单时间
    expect(orders[1].createdAt).toBe('2026-10-23 20:33:43')
    expect(orders[1].shippedAt).toBeNull()
    expect(orders[1].trackingNo).toBe('')
  })

  it('扩展列：商品ID / 店ID / 规格 / 站内链接补全 / 子单号', () => {
    expect(orders[0].extra.goodsId).toBe('995765803267')
    expect(orders[0].extra.mallId).toBe('900003')
    expect(orders[0].extra.itemUrl).toBe(
      'https://mobile.yangkeduo.com/order.html?order_sn=261010-481055239712433&page_from=1&main_orders=1'
    )
    expect(orders[1].extra.mallId).toBe('900002')
    expect(orders[1].extra.skuSpec).toBe('500g±50g/袋')
    expect(orders[1].extra.subOrderIds).toBe('261023-396304074272433')
    expect(orders[1].extra.itemUrl).toBe(
      'https://mobile.yangkeduo.com/ywgnpxpt.html?_t_timestamp=mobile-vegetables&_p_page=vgt_mall_list'
    )
  })

  it('列表接口不含收货人字段时留空，不抛错', () => {
    expect(orders[0].receiverName).toBe('')
    expect(orders[1].receiverName).toBe('')
    expect(pageInfo).toBeUndefined()
  })
})
