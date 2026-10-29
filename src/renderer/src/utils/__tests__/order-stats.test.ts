import { describe, expect, it } from 'vitest'
import type { Order } from '@shared/types'
import {
  amountOf,
  bizLineOf,
  buildOverviewStats,
  filterByScope,
  groupByPlatform,
  outcomeOfStatus,
  parseYmd,
  platformKeyOf,
  splitLocalLife
} from '../order-stats'

/** 只填统计用得到的字段，其余用空订单补齐 */
function order(patch: Partial<Order> & { platform: string; orderId: string }): Order {
  return {
    platform: patch.platform,
    account: '',
    orderId: patch.orderId,
    createdAt: patch.createdAt ?? null,
    title: patch.title ?? '',
    imageUrl: '',
    unitPrice: '',
    paidAmount: patch.paidAmount ?? '',
    quantity: null,
    status: patch.status ?? '',
    shopName: patch.shopName ?? '',
    receiverName: '',
    receiverAddress: '',
    receiverPhone: '',
    logisticsCompany: '',
    trackingNo: '',
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    extra: patch.extra ?? {}
  }
}

describe('parseYmd', () => {
  it('解析标准时间字符串，忽略时分秒', () => {
    expect(parseYmd('2026-10-29 16:39:26')).toEqual({ y: 2026, m: 10, d: 29 })
  })

  it('兼容斜杠与单位数月日', () => {
    expect(parseYmd('2026/1/5 08:00:00')).toEqual({ y: 2026, m: 1, d: 5 })
  })

  it('空值 / 非法值返回 null', () => {
    expect(parseYmd(null)).toBeNull()
    expect(parseYmd('')).toBeNull()
    expect(parseYmd('昨天')).toBeNull()
    expect(parseYmd('2026-13-01 00:00:00')).toBeNull()
  })
})

describe('amountOf', () => {
  it('清洗货币符号与千分位', () => {
    expect(amountOf(order({ platform: 'jd', orderId: '1', paidAmount: '¥1,234.00' }))).toBe(1234)
    expect(amountOf(order({ platform: 'jd', orderId: '2', paidAmount: '￥9.40' }))).toBe(9.4)
  })

  it('0 元订单是真实值，不能当成缺失', () => {
    expect(amountOf(order({ platform: 'jd', orderId: '3', paidAmount: '0' }))).toBe(0)
  })

  it('对象被 String 化成 [object Object] 时按 0 计（淘宝外卖单的历史坑）', () => {
    expect(amountOf(order({ platform: 'taobao', orderId: '4', paidAmount: '[object Object]' }))).toBe(
      0
    )
  })
})

describe('outcomeOfStatus（退款 / 支付成功 / 关闭 三分）', () => {
  it('退款类状态归 refunded', () => {
    expect(outcomeOfStatus('退款成功')).toBe('refunded')
    expect(outcomeOfStatus('退款中')).toBe('refunded')
    expect(outcomeOfStatus('已退货')).toBe('refunded')
  })

  it('关闭 / 取消 / 未付款归 closed', () => {
    expect(outcomeOfStatus('交易关闭')).toBe('closed')
    expect(outcomeOfStatus('交易已取消')).toBe('closed')
    expect(outcomeOfStatus('待付款')).toBe('closed')
  })

  it('成交类状态归 paid（含已评价、已提货、充值成功）', () => {
    expect(outcomeOfStatus('交易成功')).toBe('paid')
    expect(outcomeOfStatus('已完成')).toBe('paid')
    expect(outcomeOfStatus('已评价')).toBe('paid')
    expect(outcomeOfStatus('已提货')).toBe('paid')
    expect(outcomeOfStatus('充值成功')).toBe('paid')
  })

  it('空状态按 paid 计（京东虚拟单会缺 orderStateName）', () => {
    expect(outcomeOfStatus('')).toBe('paid')
  })

  it('先判退款再判关闭：退款关闭不会掉进 closed', () => {
    expect(outcomeOfStatus('退款关闭')).toBe('refunded')
  })
})

describe('bizLineOf（外卖 / 购物 拆分）', () => {
  it('淘宝按官方 bizType：5000 是本地生活，200 是实物', () => {
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'a', extra: { bizType: '5000' } }))
    ).toBe('local')
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'b', extra: { bizType: '200' } }))
    ).toBe('shopping')
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'c', extra: { bizType: '2700' } }))
    ).toBe('shopping')
  })

  it('bizType 优先于标题特征', () => {
    expect(
      bizLineOf(
        order({
          platform: 'taobao',
          orderId: 'd',
          title: '苦瓜炒蛋饭+青菜-默认',
          extra: { bizType: '200' }
        })
      )
    ).toBe('shopping')
  })

  it('淘宝老缓存无 bizType 时按标题 / 门店特征兜底', () => {
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'e', title: '苦瓜炒蛋饭+青菜-默认' }))
    ).toBe('local')
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'f', shopName: '海记美食坊(龙美店)' }))
    ).toBe('local')
    expect(
      bizLineOf(order({ platform: 'taobao', orderId: 'g', title: '烟酰胺美白洗面奶' }))
    ).toBe('shopping')
  })

  it('京东：无商品链接 + 餐品标题 → 外卖', () => {
    expect(
      bizLineOf(
        order({
          platform: 'jd',
          orderId: 'h',
          shopName: '塔斯汀·中国汉堡(番禺龙美牌坊店)',
          title: '香辣鸡腿中国汉堡+塔塔鸡块+翅根+冰柠可乐 默认',
          extra: { payMethod: '在线支付', itemCount: '1' }
        })
      )
    ).toBe('local')
  })

  it('京东：有商品链接的食品仍是网购（京东超市买零食不算外卖）', () => {
    expect(
      bizLineOf(
        order({
          platform: 'jd',
          orderId: 'h2',
          shopName: '京东',
          title: '康师傅方便面 经典红烧牛肉面 整箱',
          extra: { itemUrl: '//item.jd.com/10088695622326.html' }
        })
      )
    ).toBe('shopping')
  })

  it('京东：无链接的实物/药品/服务不算外卖', () => {
    // 门店发货的实物单、送药上门、服务包都没有商品链接，不能误判
    for (const [shopName, title] of [
      ['迪卡侬(广州桥南店)', '迪卡侬跑步鞋男春季减震运动鞋网面透气'],
      ['喜德盛禅城普澜一路店', '喜德盛山地自行车2022款黑客500 白/蓝 17寸'],
      ['京东大药房(市桥店)', '白云山 小柴胡颗粒 10g/袋*10袋/盒'],
      ['京东', '京东（JD）VIVO手机服务包（1年全保修）']
    ]) {
      expect(bizLineOf(order({ platform: 'jd', orderId: title, shopName, title }))).toBe('shopping')
    }
  })

  it('解析层已标记 bizLine 时直接采信', () => {
    expect(
      bizLineOf(
        order({ platform: 'jd', orderId: 'k', title: '随便什么', extra: { bizLine: 'local' } })
      )
    ).toBe('local')
  })

  it('其他平台一律算购物', () => {
    expect(bizLineOf(order({ platform: 'pdd', orderId: 'j', title: '木桶饭-默认' }))).toBe(
      'shopping'
    )
  })
})

describe('splitLocalLife', () => {
  const groups = [
    {
      id: 'taobao',
      name: '淘宝',
      orders: [
        order({ platform: 'taobao', orderId: 't1', extra: { bizType: '200' }, paidAmount: '10' }),
        order({ platform: 'taobao', orderId: 't2', extra: { bizType: '5000' }, paidAmount: '20' })
      ]
    },
    { id: 'pdd', name: '拼多多', orders: [order({ platform: 'pdd', orderId: 'p1' })] }
  ]

  it('淘宝拆成「淘宝 + 淘宝外卖」两个分组', () => {
    const out = splitLocalLife(groups)
    expect(out.map((g) => g.id)).toEqual(['taobao', 'taobao-local', 'pdd'])
    expect(out[1].name).toBe('淘宝外卖')
    expect(out[0].orders).toHaveLength(1)
    expect(out[1].orders).toHaveLength(1)
  })

  it('没有外卖单时不生成空分组', () => {
    const out = splitLocalLife([
      { id: 'jd', name: '京东', orders: [order({ platform: 'jd', orderId: 'j1', title: '键盘' })] }
    ])
    expect(out.map((g) => g.id)).toEqual(['jd'])
  })
})

describe('filterByScope（总览的「全部 / 网购 / 外卖」口径）', () => {
  const groups = splitLocalLife([
    {
      id: 'taobao',
      name: '淘宝',
      orders: [
        order({ platform: 'taobao', orderId: 't1', extra: { bizType: '200' }, paidAmount: '10' }),
        order({ platform: 'taobao', orderId: 't2', extra: { bizType: '5000' }, paidAmount: '20' })
      ]
    },
    {
      id: 'jd',
      name: '京东',
      orders: [
        order({ platform: 'jd', orderId: 'j1', title: '键盘', paidAmount: '30' }),
        order({
          platform: 'jd',
          orderId: 'j2',
          title: '香辣鸡腿堡 默认',
          paidAmount: '40'
        })
      ]
    },
    { id: 'pdd', name: '拼多多', orders: [order({ platform: 'pdd', orderId: 'p1', paidAmount: '50' })] }
  ])

  it('全部：网购与外卖都在', () => {
    expect(filterByScope(groups, 'all').map((g) => g.id)).toEqual([
      'taobao',
      'taobao-local',
      'jd',
      'jd-local',
      'pdd'
    ])
  })

  it('网购：只剩购物分组', () => {
    const out = filterByScope(groups, 'shopping')
    expect(out.map((g) => g.id)).toEqual(['taobao', 'jd', 'pdd'])
    expect(out.every((g) => !g.id.endsWith('-local'))).toBe(true)
  })

  it('外卖：只剩外卖分组', () => {
    const out = filterByScope(groups, 'local')
    expect(out.map((g) => g.id)).toEqual(['taobao-local', 'jd-local'])
    expect(out.reduce((n, g) => n + g.orders.length, 0)).toBe(2)
  })

  it('口径过滤后统计口径同步变化', () => {
    const shop = buildOverviewStats(filterByScope(groups, 'shopping'), 2026)
    const local = buildOverviewStats(filterByScope(groups, 'local'), 2026)
    expect(shop.totalAmount).toBe(90) // 10 + 30 + 50
    expect(local.totalAmount).toBe(60) // 20 + 40
  })
})

describe('groupByPlatform', () => {
  it('闲鱼买 / 卖两个视角合并成一个平台', () => {
    expect(platformKeyOf('xianyu-sold')).toBe('xianyu')
    const groups = groupByPlatform(
      {
        xianyu: [order({ platform: 'xianyu', orderId: 'a' })],
        'xianyu-sold': [order({ platform: 'xianyu-sold', orderId: 'b' })],
        jd: [order({ platform: 'jd', orderId: 'c' })]
      },
      (id) => (id === 'xianyu' ? '闲鱼' : id)
    )
    const xianyu = groups.find((g) => g.id === 'xianyu')
    expect(xianyu?.name).toBe('闲鱼')
    expect(xianyu?.orders).toHaveLength(2)
    expect(groups.map((g) => g.id).sort()).toEqual(['jd', 'xianyu'])
  })

  it('空平台被跳过', () => {
    expect(groupByPlatform({ jd: [] }, (id) => id)).toEqual([])
  })
})

describe('buildOverviewStats', () => {
  const groups = groupByPlatform(
    {
      jd: [
        order({
          platform: 'jd',
          orderId: '1',
          createdAt: '2026-10-01 10:00:00',
          paidAmount: '100',
          status: '已完成'
        }),
        order({
          platform: 'jd',
          orderId: '2',
          createdAt: '2026-10-01 12:00:00',
          paidAmount: '50',
          status: '已完成'
        }),
        order({
          platform: 'jd',
          orderId: '3',
          createdAt: '2025-12-31 23:00:00',
          paidAmount: '30',
          status: '已完成'
        })
      ],
      taobao: [
        order({
          platform: 'taobao',
          orderId: '4',
          createdAt: '2026-03-15 09:00:00',
          paidAmount: '20',
          status: '交易成功'
        }),
        order({
          platform: 'taobao',
          orderId: '5',
          createdAt: '2026-03-16 09:00:00',
          paidAmount: '40',
          status: '退款成功'
        }),
        order({
          platform: 'taobao',
          orderId: '6',
          createdAt: '2026-03-17 09:00:00',
          paidAmount: '60',
          status: '交易关闭'
        })
      ]
    },
    (id) => id
  )

  it('总量 / 均值 / 覆盖区间', () => {
    const s = buildOverviewStats(groups, 2026)
    expect(s.totalCount).toBe(6)
    expect(s.totalAmount).toBe(300)
    expect(s.activeDays).toBe(5)
    expect(s.firstDate).toBe('2025-12-31')
    expect(s.lastDate).toBe('2026-10-01')
  })

  it('支付成功 / 退款 / 关闭 三分，互不串味', () => {
    const s = buildOverviewStats(groups, 2026)
    expect(s.paidCount).toBe(4)
    expect(s.paidAmount).toBe(200)
    expect(s.refundCount).toBe(1)
    expect(s.refundAmount).toBe(40)
    expect(s.closedCount).toBe(1)
    expect(s.closedAmount).toBe(60)
    // 平均每单只算支付成功的
    expect(s.avgPaid).toBe(50)
    // 退款率 = 退款 /（支付 + 退款），关闭单不参与
    expect(s.refundRate).toBeCloseTo(40 / 240)
  })

  it('按年 / 月 / 日聚合，桶内同样带三分', () => {
    const s = buildOverviewStats(groups, 2026)
    expect(s.monthYear).toBe(2026)
    expect(s.years.map((y) => [y.key, y.count])).toEqual([
      ['2025', 1],
      ['2026', 5]
    ])
    const oct = s.months[9]
    expect([oct.paidCount, oct.paidAmount]).toEqual([2, 150])
    const mar = s.months[2]
    expect([mar.paidCount, mar.paidAmount, mar.refundCount, mar.closedCount]).toEqual([1, 20, 1, 1])
    expect(s.months[11].count).toBe(0)
    const day = s.days.find((d) => d.key === '2026-10-01')
    expect(day?.paidCount).toBe(2)
    expect(day?.paidAmount).toBe(150)
  })

  it('日序列覆盖整年，闰年 366 天', () => {
    expect(buildOverviewStats(groups, 2026).days).toHaveLength(365)
    expect(buildOverviewStats(groups, 2024).days).toHaveLength(366)
  })

  it('年度汇总与峰值年', () => {
    const s = buildOverviewStats(groups, 2026)
    expect(s.year.paidCount).toBe(3)
    expect(s.year.paidAmount).toBe(170)
    expect(s.peakYear?.key).toBe('2026')
    expect(s.peakYear?.count).toBe(5)
  })

  it('未指定年份时默认最新一年', () => {
    expect(buildOverviewStats(groups, null).monthYear).toBe(2026)
  })

  it('无下单时间的订单仍计入总量，但不进年 / 月 / 日', () => {
    const s = buildOverviewStats(
      groupByPlatform(
        {
          jd: [
            order({
              platform: 'jd',
              orderId: 'x',
              createdAt: null,
              paidAmount: '9',
              status: '已完成'
            })
          ]
        },
        (id) => id
      ),
      2026
    )
    expect(s.totalCount).toBe(1)
    expect(s.paidAmount).toBe(9)
    expect(s.firstDate).toBe('')
    expect(s.years).toEqual([])
  })

  it('平台维度按支付成功金额降序', () => {
    const s = buildOverviewStats(groups, 2026)
    expect(s.platforms.map((p) => p.key)).toEqual(['jd', 'taobao'])
    expect(s.platforms[0].paidAmount).toBe(180)
    expect(s.platforms[1].refundAmount).toBe(40)
  })

  it('状态维度带三分且按单量降序', () => {
    const s = buildOverviewStats(groups, 2026)
    const refunded = s.statuses.find((x) => x.key === '退款成功')
    expect(refunded?.refundCount).toBe(1)
    expect(s.statuses[0].count).toBeGreaterThanOrEqual(s.statuses[1].count)
  })

  it('空数据不抛错', () => {
    const s = buildOverviewStats([], 2026)
    expect(s.totalCount).toBe(0)
    expect(s.avgPaid).toBe(0)
    expect(s.refundRate).toBe(0)
    expect(s.days).toHaveLength(365)
  })

  it('金额浮点累加不会留下 0.30000000000000004', () => {
    const s = buildOverviewStats(
      groupByPlatform(
        {
          jd: [
            order({ platform: 'jd', orderId: 'a', createdAt: '2026-01-01 00:00:00', paidAmount: '0.1', status: '已完成' }),
            order({ platform: 'jd', orderId: 'b', createdAt: '2026-01-01 00:00:00', paidAmount: '0.2', status: '已完成' })
          ]
        },
        (id) => id
      ),
      2026
    )
    expect(s.paidAmount).toBe(0.3)
  })
})
