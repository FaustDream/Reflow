import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOrdersFile } from '../import-orders'

describe('订单文件导入：解析', () => {
  it('解析平台导出的 CSV（中文表头 + 带货币符号的金额）', async () => {
    const p = join(tmpdir(), 'reflow-import-test.csv')
    writeFileSync(
      p,
      [
        '订单编号,商品标题,实付款,订单创建时间,店铺名称,购买数量,订单状态',
        '123456789,测试商品A,¥99.50,2026-01-02 10:00:00,某旗舰店,1,交易成功',
        '987654321,"带,逗号的商品","1,234.00",2025-12-31 23:59:59,某专卖店,2,已收货'
      ].join('\n'),
      'utf-8'
    )
    const r = await parseOrdersFile(p)
    expect(r.orders.length).toBeGreaterThanOrEqual(2)
    expect(r.orders[0].orderId).toBe('123456789')
    expect(r.orders[0].paidAmount).toBe('99.50')
    expect(r.orders[0].shopName).toBe('某旗舰店')
    // 带引号的单元格里即使有逗号也不该被拆列
    expect(r.orders[1].title).toBe('带,逗号的商品')
    expect(r.orders[1].paidAmount).toBe('1234.00')
  })

  it('表头前面有说明行也能识别', async () => {
    const p = join(tmpdir(), 'reflow-import-test2.csv')
    writeFileSync(
      p,
      [
        '淘宝订单导出（2026-10-27）',
        '订单编号,商品标题,实付款,订单创建时间',
        '111,商品B,20.00,2026-03-04 12:00:00'
      ].join('\n'),
      'utf-8'
    )
    const r = await parseOrdersFile(p)
    expect(r.orders).toHaveLength(1)
    expect(r.orders[0].orderId).toBe('111')
  })

  it('空行/无有效列的行计入 skipped', async () => {
    const p = join(tmpdir(), 'reflow-import-test3.csv')
    writeFileSync(
      p,
      ['订单编号,商品标题', '222,商品C', ',', ''].join('\n'),
      'utf-8'
    )
    const r = await parseOrdersFile(p)
    expect(r.orders).toHaveLength(1)
    expect(r.skipped).toBeGreaterThanOrEqual(1)
  })
})
