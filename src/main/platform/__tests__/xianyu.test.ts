import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  compressXianyuImageUrl,
  isXianyuNextPage,
  normalizeXianyuItem,
  xianyuAdapter
} from '../xianyu'
import { CORE_EXPORT_COLUMNS } from '../../../shared/types/order'
import type { CaptureReport } from '../../../shared/types'

/**
 * 工单 006：解析器单测。
 * fixture 为真实快照 xy-order.json 的**脱敏合成版**（路径与类型逐一保留，
 * 含 nextPage 字符串 "true"、totalCount "0"、orderId/orderIdStr 双字段等真实形态）。
 */
const fixturePath = resolve(__dirname, '../../../../testdata/xianyu-bought-list.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

const report = (body: unknown, kind: CaptureReport['kind'] = 'xhr'): CaptureReport => ({
  kind,
  url: 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/?appKey=34839810',
  method: kind === 'jsonp' ? undefined : 'POST',
  status: 200,
  body,
  ts: Date.now()
})

describe('闲鱼适配器：路由声明', () => {
  it('覆盖 xhr/fetch 两形态，含页面脚本与独立分区', () => {
    expect(xianyuAdapter.id).toBe('xianyu')
    expect(xianyuAdapter.matchRules.map((r) => r.kind)).toEqual(['xhr', 'fetch'])
    expect(xianyuAdapter.pageScript).toContain('installXianyuPageScript')
    expect(xianyuAdapter.pageScript).toContain('function')
    expect(xianyuAdapter.partition).toBe('persist:platform-xianyu')
    expect(xianyuAdapter.homeUrl).toBe('https://www.goofish.com/bought')
  })

  it('导出列只含 extended columns，核心列由引擎附加', () => {
    for (const col of xianyuAdapter.columns) {
      expect(CORE_EXPORT_COLUMNS.some((c) => c.key === col.key)).toBe(false)
    }
    expect(xianyuAdapter.columns.map((c) => c.key)).toEqual([
      'itemId',
      'sellerId',
      'idleBizCode',
      'priceLabel'
    ])
  })
})

describe('闲鱼适配器：列表解析（附录 B.2 路径）', () => {
  const { orders, pageInfo } = xianyuAdapter.parse(report(fixture))

  it('多订单：全部解析且关键字段取值正确', () => {
    expect(orders).toHaveLength(3)
    const first = orders[0]
    expect(first.platform).toBe('xianyu')
    // orderId ← commonData.orderIdStr ?? orderId
    expect(first.orderId).toBe('990101202605100001')
    expect(first.createdAt).toBe('2026-05-10 12:30:00')
    expect(first.title).toBe('合成测试商品甲 95新')
    expect(first.paidAmount).toBe('320.00')
    expect(first.quantity).toBe(1)
    expect(first.status).toBe('交易成功')
    // 卖家昵称承载 core 店铺名列
    expect(first.shopName).toBe('测试卖家甲')
  })

  it('orderIdStr 缺失时回退 orderId', () => {
    expect(orders[1].orderId).toBe('990101202605110002')
    expect(orders[2].orderId).toBe('990101202605120003')
  })

  it('时间戳数字形态的时间可解析（第三单 createdAt 为毫秒值）', () => {
    expect(orders[2].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('extra 承载平台特有字段（商品ID/卖家ID/业务类型/价格标签）', () => {
    expect(orders[0].extra).toEqual({
      itemId: '88001001001',
      sellerId: '10001',
      idleBizCode: '6',
      priceLabel: '实付款'
    })
    // 第三单无 auctionPriceDesc → 不下发该键
    expect(orders[2].extra.priceLabel).toBeUndefined()
  })

  it('分页：nextPage 字符串 "true" → hasMore true，lastEndRow → cursor，totalCount "0" 不下发', () => {
    expect(pageInfo).toEqual({ hasMore: true, cursor: '30' })
  })

  it('空 items 合法：返回空订单与分页状态', () => {
    const r = xianyuAdapter.parse(
      report({ api: 'mtop.idle.web.trade.bought.list', data: { items: [], nextPage: 'false', totalCount: '0' }, ret: ['SUCCESS::调用成功'] })
    )
    expect(r.orders).toEqual([])
    expect(r.pageInfo).toEqual({ hasMore: false })
  })
})

describe('闲鱼适配器：异常防护', () => {
  it('会话过期（FAIL_SYS_SESSION_EXPIRED）抛出明确的登录提示', () => {
    expect(() =>
      xianyuAdapter.parse(
        report({ api: 'mtop.idle.web.trade.bought.list', data: {}, ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] })
      )
    ).toThrow(/未登录/)
  })

  it('mtop 令牌瞬时失败（含官方拼写 EXOIRED）静默返回空，不刷解析异常/不误报未登录', () => {
    for (const code of ['FAIL_SYS_TOKEN_EMPTY::令牌为空', 'FAIL_SYS_TOKEN_EXOIRED::令牌过期']) {
      const r = xianyuAdapter.parse(report({ data: {}, ret: [code] }))
      expect(r.orders).toEqual([])
    }
  })

  it('结构异常（缺 data.items）抛错且携带 ret，不静默', () => {
    expect(() => xianyuAdapter.parse(report({ data: {}, ret: ['FAIL::未知'] }))).toThrow(/结构异常.*FAIL::未知/s)
    expect(() => xianyuAdapter.parse(report(null))).toThrow(/结构异常/)
    expect(() => xianyuAdapter.parse(report('plain text'))).toThrow(/结构异常/)
  })

  it('items 元素为 null/畸形时不抛错，产出空壳订单（防御性）', () => {
    const o = normalizeXianyuItem(null)
    expect(o.orderId).toBe('')
    expect(o.platform).toBe('xianyu')
  })
})

describe('compressXianyuImageUrl（与原版 compressOrderImageUrl 一致）', () => {
  it('http→https、截断 ?#、补缩略图后缀', () => {
    expect(compressXianyuImageUrl('http://img.example.com/a.jpg?x=1#frag')).toBe(
      'https://img.example.com/a.jpg_220x10000Q90.jpg'
    )
  })

  it('已带后缀不重复追加；空值返回空串', () => {
    expect(compressXianyuImageUrl('https://img.example.com/a.jpg_220x10000Q90.jpg')).toBe(
      'https://img.example.com/a.jpg_220x10000Q90.jpg'
    )
    expect(compressXianyuImageUrl('')).toBe('')
    expect(compressXianyuImageUrl(undefined)).toBe('')
  })
})

describe('isXianyuNextPage（原版 isNextPage 语义）', () => {
  it('布尔与字符串 "true" 均为真，其余为假', () => {
    expect(isXianyuNextPage(true)).toBe(true)
    expect(isXianyuNextPage('true')).toBe(true)
    expect(isXianyuNextPage(false)).toBe(false)
    expect(isXianyuNextPage('false')).toBe(false)
    expect(isXianyuNextPage(undefined)).toBe(false)
    expect(isXianyuNextPage(1)).toBe(false)
  })
})
