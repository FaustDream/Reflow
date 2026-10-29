import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { xianyuSoldAdapter } from '../xianyu-sold'
import { normalizeXianyuItem } from '../xianyu'
import { matchRuleMatches } from '../adapter'
import type { CaptureReport } from '../../../shared/types'

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/xianyu-sold-list.json'), 'utf-8')
)
const report = (body: unknown): CaptureReport => ({
  kind: 'xhr',
  url: 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.sold.list/1.0/',
  method: 'POST',
  status: 200,
  body,
  ts: Date.now()
})

describe('工单 011：闲鱼卖家适配器', () => {
  it('声明：supportsSeller、sold 接口匹配、与买家共用分区', () => {
    expect(xianyuSoldAdapter.id).toBe('xianyu-sold')
    expect(xianyuSoldAdapter.displayName).toBe('闲鱼卖家')
    expect(xianyuSoldAdapter.supportsSeller).toBe(true)
    expect(xianyuSoldAdapter.partition).toBe('persist:platform-xianyu')
    expect(
      matchRuleMatches(
        xianyuSoldAdapter.matchRules[0],
        'https://h5api.m.goofish.com/h5/mtop.taobao.idle.trade.sold.get/1.0/',
        'POST',
        'xhr'
      )
    ).toBe(true)
    expect(
      matchRuleMatches(
        xianyuSoldAdapter.matchRules[0],
        'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.sold.list/1.0/',
        'POST',
        'xhr'
      )
    ).toBe(true)
    // 买家接口不得被卖家适配器匹配（否则买卖混表）
    expect(
      matchRuleMatches(
        xianyuSoldAdapter.matchRules[0],
        'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/',
        'POST',
        'xhr'
      )
    ).toBe(false)
  })

  it('解析：platform=xianyu-sold，与买家订单天然分表', () => {
    const { orders } = xianyuSoldAdapter.parse(report(fixture))
    expect(orders).toHaveLength(2)
    for (const o of orders) expect(o.platform).toBe('xianyu-sold')
    expect(orders[0].orderId).toBe('880000000000000001')
    expect(orders[0].shopName).toBe('合成买家甲')
    expect(orders[0].title).toBe('我卖出的合成商品甲')
    expect(orders[0].status).toBe('等待买家收货')
    expect(orders[0].extra.idleBizCode).toBe('6')
    expect(orders[0].extra.sellerId).toBe('7700001')
  })

  it('分页 nextPage 字符串与 totalCount', () => {
    const { pageInfo } = xianyuSoldAdapter.parse(report(fixture))
    expect(pageInfo?.hasMore).toBe(true)
    expect(pageInfo?.totalCount).toBe(2)
    expect(pageInfo?.cursor).toBe('50')
  })

  it('复用解析器第二参数：同一 item 买家/卖家视角 platform 不同', () => {
    const item = fixture.data.items[0]
    const buyer = normalizeXianyuItem(item, 'xianyu')
    const seller = normalizeXianyuItem(item, 'xianyu-sold')
    expect(buyer.platform).toBe('xianyu')
    expect(seller.platform).toBe('xianyu-sold')
    // 引擎去重键含 platform，同单号两角色可共存不互相覆盖
    expect(buyer.orderId).toBe(seller.orderId)
  })

  it('会话过期抛错', () => {
    expect(() =>
      xianyuSoldAdapter.parse(report({ ret: ['FAIL_SYS_SESSION_EXPIRED::x'], data: {} }))
    ).toThrow(/会话已过期/)
  })
})
