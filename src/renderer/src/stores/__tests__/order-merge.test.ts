import { describe, expect, it } from 'vitest'
import { dedupeOrders, mergeOrderLists } from '../orders'
import type { Order } from '../../../../shared/types/order'

const o = (id: string, title = `t-${id}`): Order =>
  ({
    platform: 'pdd',
    account: '',
    orderId: id,
    title,
    imageUrl: '',
    unitPrice: '',
    paidAmount: '',
    quantity: null,
    status: '',
    shopName: '',
    createdAt: '',
    receiverName: '',
    receiverAddress: '',
    receiverPhone: '',
    logisticsCompany: '',
    trackingNo: '',
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    extra: {}
  }) as Order

describe('工单 040：mergeOrderLists（重写后的订单合并）', () => {
  it('新单排顶部（到达顺序），旧单原地更新（b 保持原位置）', () => {
    const existing = [o('a'), o('b'), o('c')]
    const merged = mergeOrderLists(existing, [o('d', 'new-d'), o('b', 'updated-b')])
    expect(merged.map((x) => x.orderId)).toEqual(['d', 'a', 'b', 'c'])
    expect(merged.find((x) => x.orderId === 'b')?.title).toBe('updated-b')
  })

  it('同一批 payload 里的重复单号只保留一条（旧实现会产生重复行）', () => {
    const existing = [o('a'), o('b')]
    const merged = mergeOrderLists(existing, [o('x'), o('a', 'upd-a'), o('x', 'x-final')])
    expect(merged.filter((x) => x.orderId === 'x')).toHaveLength(1)
    expect(merged.find((x) => x.orderId === 'x')?.title).toBe('x-final')
    // a 被更新且不丢
    expect(merged.find((x) => x.orderId === 'a')?.title).toBe('upd-a')
    expect(merged).toHaveLength(3) // x（新）+ a（更新）+ b（旧）
  })

  it('大批量交错更新不再漂移（工单 040 实测 104 条重复的回归用例）', () => {
    // 30 条旧单 + 一批「新单在前、旧单穿插更新」的到达流
    const existing = Array.from({ length: 30 }, (_, i) => o(`old-${i}`))
    const incoming = [
      ...Array.from({ length: 10 }, (_, i) => o(`new-${i}`)),
      ...Array.from({ length: 30 }, (_, i) => o(`old-${i}`, 'upd'))
    ]
    const merged = mergeOrderLists(existing, incoming)
    const ids = merged.map((x) => x.orderId)
    expect(new Set(ids).size).toBe(ids.length) // 无任何重复
    expect(merged.filter((x) => x.orderId.startsWith('old-'))).toHaveLength(30)
    expect(merged.find((x) => x.orderId === 'old-0')?.title).toBe('upd')
  })

  it('空单号行不参与索引、原样保留（美团 H5 教训）', () => {
    const existing = [o('a'), { ...o(''), title: 'old-empty' } as Order]
    const merged = mergeOrderLists(existing, [{ ...o(''), title: 'new-empty' } as Order])
    const empties = merged.filter((x) => !x.orderId)
    expect(empties.map((x) => x.title)).toEqual(['new-empty', 'old-empty'])
  })
})

describe('工单 040：dedupeOrders（缓存恢复去重）', () => {
  it('去掉 orderId 重复行，保留先出现；空单号行不去重', () => {
    const list = [o('a', 'first'), o('a', 'second'), o('b'), { ...o(''), title: 'e1' } as Order, { ...o(''), title: 'e2' } as Order]
    const out = dedupeOrders(list)
    expect(out.map((x) => x.orderId + ':' + x.title)).toEqual([
      'a:first',
      'b:t-b',
      ':e1',
      ':e2'
    ])
  })
})
