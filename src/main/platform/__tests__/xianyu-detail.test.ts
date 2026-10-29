import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isMultiPackageDetail,
  normalizeXianyuDetail,
  XianyuMultiPackageError,
  XianyuValidateRequiredError
} from '../xianyu-detail'

const read = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../../testdata/${name}`), 'utf-8'))

describe('工单 008：闲鱼详情解析（真实快照脱敏版）', () => {
  const fixture = read('xianyu-order-detail.json')

  it('orderInfoVO.orderInfoList 取地址/交易号/三个时间', () => {
    const f = normalizeXianyuDetail(fixture)
    expect(f.receiverAddress).toBe('合成收货人 13800000001 北京市朝阳区合成路1号')
    expect(f.alipayTradeNo).toBe('2026051022001128031449000001')
    expect(f.paidAt).toBe('2026-05-10 12:30:15')
    expect(f.shippedAt).toBe('2026-05-11 09:00:00')
    expect(f.completedAt).toBe('2026-05-14 18:20:30')
  })

  it('priceInfo.billList 取运费/闲鱼币抵扣', () => {
    const f = normalizeXianyuDetail(fixture)
    expect(f.freight).toBe('0.00')
    expect(f.coinDiscount).toBe('-0.10')
  })

  it('D-3：时间字段为字符串，且不产生序列号', () => {
    const f = normalizeXianyuDetail(fixture)
    for (const t of [f.paidAt, f.shippedAt, f.completedAt]) {
      expect(typeof t).toBe('string')
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }
  })

  it('缺失标题项留空不报错（详情缺失列留空）', () => {
    const f = normalizeXianyuDetail({
      data: {
        components: [
          {
            render: 'orderInfoVO',
            data: {
              orderInfoList: [{ title: '订单编号', value: 'X1' }],
              priceInfo: { billList: [] }
            }
          }
        ]
      }
    })
    expect(f.receiverAddress).toBe('')
    expect(f.alipayTradeNo).toBe('')
    expect(f.freight).toBe('')
    expect(f.coinDiscount).toBe('')
    expect(f.paidAt).toBeNull()
  })

  it('「分成多个包」抛 XianyuMultiPackageError（head.fields.title 路径）', () => {
    const multi = read('xianyu-order-detail-multipkg.json')
    expect(isMultiPackageDetail(multi)).toBe(true)
    expect(() => normalizeXianyuDetail(multi)).toThrow(XianyuMultiPackageError)
  })

  it('FAIL_SYS_USER_VALIDATE 抛 XianyuValidateRequiredError（暂停批量抓取）', () => {
    expect(() =>
      normalizeXianyuDetail({ ret: ['FAIL_SYS_USER_VALIDATE::...'], data: {} })
    ).toThrow(XianyuValidateRequiredError)
  })

  it('结构异常（无 components / 无 orderInfoVO）抛错不静默', () => {
    expect(() => normalizeXianyuDetail({ data: {} })).toThrow(/结构异常/)
    expect(() =>
      normalizeXianyuDetail({ data: { components: [{ render: 'orderStatusVO' }] } })
    ).toThrow(/orderInfoVO/)
  })
})
