import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toOrderFromMain } from '../taobao-v2-fetch'

const waimai = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../testdata/taobao-waimai-order.json'), 'utf-8')
)

/** 普通实物单：actualFee 是字符串（合成数据） */
const normal = {
  id: '1234567890123456700',
  orderInfo: { createTime: '2026-10-18 12:26:37', id: '1234567890123456700' },
  payInfo: { actualFee: '23.39' },
  seller: { shopName: '合成餐饮店', nick: '合成卖家' },
  statusInfo: { text: '交易成功' },
  subOrders: [
    {
      itemInfo: { title: '合成套餐A', pic: '//img.alicdn.com/a.jpg' },
      priceInfo: { realTotal: '17.91' },
      quantity: '1'
    }
  ]
}

describe('淘宝 v2 抓取：mainOrders → Order', () => {
  it('普通单：actualFee 是字符串，直接取', () => {
    const o = toOrderFromMain(normal)
    expect(o.paidAmount).toBe('23.39')
    expect(o.title).toContain('合成套餐A')
    expect(o.shopName).toBe('合成餐饮店')
    expect(o.status).toBe('交易成功')
    expect(o.createdAt).toBe('2026-10-18 12:26:37')
  })

  it('外卖/闪购单：actualFee 是对象 {prefix,value}，必须取 value 而不是 [object Object]', () => {
    const o = toOrderFromMain(waimai)
    // 之前 String({...}) 得到 "[object Object]"，清洗后为空 → 28 单外卖只有商品名没有金额
    expect(o.paidAmount).toBe('9.40')
  })

  it('外卖单：没有 shopName 时回退到 seller.nick', () => {
    const o = toOrderFromMain(waimai)
    expect(o.shopName).toBe('合成餐饮店')
  })

  it('外卖单：件数按商品行 quantity 累加，单价取 realTotal，图片取首件', () => {
    const o = toOrderFromMain(waimai)
    expect(o.quantity).toBe(1)
    expect(o.unitPrice).toBe('9.50')
    expect(o.imageUrl).toContain('img.alicdn.com')
  })

  it('orderId 优先取 m.id（外卖单的 orderInfo.id 与主单号不同）', () => {
    const o = toOrderFromMain(waimai)
    expect(o.orderId).toBe('1234567890123456789')
    expect(o.orderId).not.toBe('1234567890123456788')
  })

  it('actualFee 缺失时回退 totalFee；都缺则留空', () => {
    expect(toOrderFromMain({ id: '1', payInfo: { totalFee: '￥12.00' } }).paidAmount).toBe('12.00')
    expect(toOrderFromMain({ id: '2', payInfo: {} }).paidAmount).toBe('')
    expect(toOrderFromMain({ id: '3' }).paidAmount).toBe('')
  })

  it('0 元单保留为 0.00（不是空串）', () => {
    expect(toOrderFromMain({ id: '4', payInfo: { actualFee: '0.00' } }).paidAmount).toBe('0.00')
    expect(
      toOrderFromMain({ id: '5', payInfo: { actualFee: { value: '￥0.00' } } }).paidAmount
    ).toBe('0.00')
  })

  it('畸形输入不抛错', () => {
    const o = toOrderFromMain({})
    expect(o.orderId).toBe('')
    expect(o.title).toBe('')
    expect(o.paidAmount).toBe('')
    expect(o.quantity).toBeNull()
  })
})
