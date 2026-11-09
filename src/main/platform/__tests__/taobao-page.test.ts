/**
 * 淘宝网页版订单（asyncBought）解析与补抓分页。
 *
 * 为什么单独测：mtop 协议树里没有外卖单也没有 bizType，外卖分栏全靠这条通道，
 * 一旦解析错，用户看到的就是「淘宝外卖永远是 0 单」。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isTaobaoAsyncBody, parseTaobaoAsyncOrders } from '../taobao-page'
import { fetchTaobaoAsyncOrders, taobaoAsyncUrl } from '../taobao-page-fetch'
import { taobaoAdapter } from '../taobao'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/taobao-async-bought.json'), 'utf-8')
)

const report = (body: unknown, url: string): CaptureReport => ({
  kind: 'xhr',
  url,
  method: 'GET',
  status: 200,
  body,
  ts: Date.now()
})

describe('淘宝网页版订单解析（工单 043）', () => {
  it('识别 asyncBought 响应，不误判 mtop 协议树', () => {
    expect(isTaobaoAsyncBody(fixture)).toBe(true)
    expect(isTaobaoAsyncBody({ data: { data: {} } })).toBe(false)
    expect(isTaobaoAsyncBody(null)).toBe(false)
  })

  it('mainOrders → Order：单号/时间/状态/标题/金额/店铺都对', () => {
    const orders = parseTaobaoAsyncOrders(fixture)
    expect(orders).toHaveLength(5)

    const first = orders[0]
    expect(first.platform).toBe('taobao')
    expect(first.orderId).toBe('4502266418004145311')
    expect(first.createdAt).toBe('2026-04-05 18:43:18')
    expect(first.status).toBe('交易成功')
    expect(first.shopName).toBe('有间日式关东煮食堂(市桥店)')
    expect(first.paidAmount).toBe('23.60')
    expect(first.imageUrl.startsWith('https://')).toBe(true)
    expect(first.quantity).toBeGreaterThan(0)
  })

  it('bizType 原样落到 extra：5000=外卖、200=购物、2700=阿里健康', () => {
    const orders = parseTaobaoAsyncOrders(fixture)
    const byType = new Map(orders.map((o) => [o.extra.bizType, o]))
    expect(byType.get('5000')?.shopName).toContain('店')
    expect(byType.get('200')?.title).not.toBe('')
    expect(byType.get('2700')?.shopName).toContain('阿里健康')
    // 单号、商品 ID、详情链接都要带出来（导出列会用到）
    expect(orders.every((o) => o.orderId && o.extra.itemCount)).toBe(true)
  })

  it('结构异常返回空数组，不抛错', () => {
    expect(parseTaobaoAsyncOrders({ error: 'x' })).toEqual([])
    expect(parseTaobaoAsyncOrders({ mainOrders: [{}, null] })).toEqual([])
  })

  it('适配器按 URL 路由到网页版解析器', () => {
    const routed = taobaoAdapter.matchRules.some((r) =>
      typeof r.pattern === 'string'
        ? r.pattern.includes('asyncBought')
        : r.pattern.test('https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm?pageNum=1')
    )
    expect(routed).toBe(true)

    const { orders } = taobaoAdapter.parse(
      report(fixture, 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm?pageNum=1')
    )
    expect(orders).toHaveLength(5)
  })
})

describe('淘宝网页版补抓分页', () => {
  const page = (n: number): { mainOrders: unknown[] } => ({
    mainOrders: Array.from({ length: n }, (_, i) => ({ orderInfo: { id: `p${i}` } }))
  })

  it('空页即停，返回页数与订单数', async () => {
    const rpc = {
      page: vi.fn(async (n: number) => (n <= 2 ? page(3) : { mainOrders: [] }))
    }
    const onPage = vi.fn()
    const r = await fetchTaobaoAsyncOrders(rpc, { delayMs: 0 }, { onPage })
    expect(r).toEqual({ pages: 2, orders: 6 })
    expect(onPage).toHaveBeenCalledTimes(2)
    expect(rpc.page).toHaveBeenCalledTimes(3)
  })

  it('增量：本页没有新单就收工', async () => {
    const rpc = { page: vi.fn(async () => page(2)) }
    const r = await fetchTaobaoAsyncOrders(
      rpc,
      { delayMs: 0 },
      { onPage: () => undefined, shouldStop: () => true }
    )
    expect(r.pages).toBe(1)
    expect(rpc.page).toHaveBeenCalledTimes(1)
  })

  it('maxPages 兜底，不死循环', async () => {
    const rpc = { page: vi.fn(async () => page(1)) }
    const r = await fetchTaobaoAsyncOrders(rpc, { maxPages: 3, delayMs: 0 }, { onPage: () => undefined })
    expect(r.pages).toBe(3)
  })

  it('URL 带上 tabCode=all 与页码（网页版只给这一组参数）', () => {
    const u = taobaoAsyncUrl(3)
    expect(u).toContain('/trade/itemlist/asyncBought.htm')
    expect(u).toContain('pageNum=3')
    expect(u).toContain('tabCode=all')
  })
})
