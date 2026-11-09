import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractTaobaoOrders, taobaoAdapter } from '../taobao'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/taobao-bought-list.json'), 'utf-8')
)
const report = (body: unknown, url?: string): CaptureReport => ({
  kind: 'xhr',
  url:
    url ??
    'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2/1.0/?jsv=2.7.2',
  method: 'POST',
  status: 200,
  body,
  ts: Date.now()
})

describe('淘宝适配器：声明', () => {
  it('匹配 queryboughtlistV2（大小写不敏感）与小写变体', () => {
    expect(taobaoAdapter.id).toBe('taobao')
    expect(taobaoAdapter.partition).toBe('persist:platform-taobao')
    expect(taobaoAdapter.login?.cookies[0].name).toBe('unb')
  })
})

describe('淘宝适配器：hierarchy 树解析', () => {
  const orders = extractTaobaoOrders(fixture)

  it('两个店铺订单，标题/金额/状态/时间正确', () => {
    expect(orders).toHaveLength(2)
    const first = orders[0]
    expect(first.orderId).toBe('3001112223334445')
    expect(first.createdAt).toBe('2026-08-15 14:22:33')
    expect(first.status).toBe('交易成功')
    expect(first.paidAmount).toBe('190.00')
    expect(first.shopName).toBe('合成店铺甲')
    expect(first.title).toBe('合成淘宝商品甲；合成淘宝商品乙')
    expect(first.quantity).toBe(3)
    expect(first.imageUrl).toBe('https://img.alicdn.com/synthetic/a.jpg')
  })

  it('卖家 ID（shop 域名）、商品 ID、规格、运费、件数进 extra', () => {
    const extra = orders[0].extra
    expect(extra.sellerId).toBe('123456')
    expect(extra.itemIds).toBe('6001,6002')
    expect(extra.skuText).toBe('颜色：红色；尺码：L；规格：标配')
    expect(extra.freight).toBe('10.00')
    expect(extra.itemCount).toBe('2')
    expect(extra.detailUrl).toContain('tradeSnap.htm')
  })

  it('第二单：user_number_id 参数解析卖家 ID + 毫秒时间戳', () => {
    const second = orders[1]
    expect(second.extra.sellerId).toBe('987654')
    expect(second.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(second.paidAmount).toBe('88.00')
  })

  it('parse 包装：返回订单与分页', () => {
    const r = taobaoAdapter.parse(report(fixture))
    expect(r.orders).toHaveLength(2)
    expect(r.pageInfo?.hasMore).toBe(false)
    expect(r.pageInfo?.cursor).toBe('1')
  })
})

describe('淘宝适配器：异常防护', () => {
  it('FAIL_SYS_USER_VALIDATE 抛人工验证提示', () => {
    expect(() =>
      taobaoAdapter.parse(report({ ret: ['FAIL_SYS_USER_VALIDATE::...'], data: {} }))
    ).toThrow(/验证/)
  })

  it('空节点树抛错且不静默', () => {
    expect(() => taobaoAdapter.parse(report({ ret: ['SUCCESS::x'], data: {} }))).toThrow(/节点树解析为空/)
  })
})
