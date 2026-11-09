/**
 * 工单 029：性能与规模护栏。
 *
 * 这些测试跑的是真实导出路径（不是 mock），用来守住工单里的量化目标：
 * - 1000 单导出 < 10s
 * - 10000 单不 OOM、不丢行（分批写入）
 * - CSV 同样规模可用
 *
 * 阈值取得比较宽松（CI 机器性能差异大），目的是**拦住数量级退化**，
 * 而不是精确计时。真正的实测数据记录在 docs/test-report-v1.md。
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildOrdersWorkbook, buildMultiSheetWorkbook } from '../excel'
import { buildOrdersCsv } from '../csv'
import { emptyOrder, type Order } from '../../../shared/types/order'
import type { ExportColumn } from '../../../shared/types/order'

const PLATFORMS = ['xianyu', 'jd', 'taobao', 'pdd', 'dewu', 'kuaishou', 'eleme', 'meituan']

function makeOrders(n: number): Order[] {
  return Array.from({ length: n }, (_, i) => {
    const platform = PLATFORMS[i % PLATFORMS.length]
    return {
      ...emptyOrder(platform, `${platform}#0`),
      orderId: `ORD-${String(i).padStart(8, '0')}`,
      createdAt: '2026-01-02 03:04:05',
      title: `商品标题 ${i}`,
      imageUrl: `https://img.example.com/${i}.jpg`,
      unitPrice: '10.00',
      paidAmount: `${(i % 1000) + 0.5}`,
      quantity: (i % 3) + 1,
      status: '已完成',
      shopName: `店铺 ${i % 50}`,
      receiverName: `收货人${i % 100}`,
      receiverAddress: `地址 ${i}`,
      receiverPhone: '13900000000',
      logisticsCompany: '顺丰',
      trackingNo: `SF${i}`,
      paidAt: '2026-01-02 03:05:00',
      shippedAt: '2026-01-03 10:00:00',
      completedAt: '2026-01-05 18:00:00',
      extra: { itemId: String(i), sku: `规格${i % 20}` }
    }
  })
}

const EXTENDED: ExportColumn[] = [
  { key: 'itemId', header: '商品ID', platformId: 'xianyu', platformName: '闲鱼' },
  { key: 'sku', header: '规格', platformId: 'xianyu', platformName: '闲鱼' }
]

describe('工单 029：导出性能护栏', () => {
  it('1000 单导出在 10 秒内完成且不丢行', async () => {
    const orders = makeOrders(1000)
    const start = Date.now()
    const buffer = await buildOrdersWorkbook(orders, EXTENDED)
    const elapsed = Date.now() - start

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!

    expect(sheet.rowCount, '行数应为表头 + 1000').toBe(1001)
    expect(elapsed, `1000 单耗时 ${elapsed}ms，超过 10s 目标`).toBeLessThan(10_000)
  }, 30_000)

  it('10000 单分批写入不丢行（内存护栏）', async () => {
    const orders = makeOrders(10_000)
    const buffer = await buildOrdersWorkbook(orders, EXTENDED)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    expect(sheet.rowCount).toBe(10_001)
  }, 120_000)

  it('10000 单多 Sheet 导出不丢行', async () => {
    const orders = makeOrders(10_000)
    const sheets = PLATFORMS.map((p) => ({
      name: p,
      orders: orders.filter((o) => o.platform === p),
      extended: EXTENDED
    }))
    const buffer = await buildMultiSheetWorkbook(sheets)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const total = wb.worksheets.reduce((n, w) => n + (w.rowCount - 1), 0)
    expect(total).toBe(10_000)
  }, 120_000)

  it('10000 单 CSV 生成在合理时间内且行数正确', () => {
    const orders = makeOrders(10_000)
    const start = Date.now()
    const buf = buildOrdersCsv(orders, EXTENDED)
    const elapsed = Date.now() - start
    const lines = buf.toString('utf-8').replace(/^\ufeff/, '').split('\r\n')
    expect(lines).toHaveLength(10_001)
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})

describe('工单 029：边界情况', () => {
  it('空订单集生成合法工作簿', async () => {
    const buffer = await buildOrdersWorkbook([], [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    expect(wb.worksheets).toHaveLength(1)
    expect(wb.getWorksheet('订单')!.rowCount).toBe(1) // 只有表头
  })

  it('单条订单不报错', async () => {
    const buffer = await buildOrdersWorkbook(makeOrders(1), [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    expect(wb.getWorksheet('订单')!.rowCount).toBe(2)
  })

  it('超长文本不截断（Excel 单元格上限 32767 字符）', async () => {
    const orders = makeOrders(1)
    orders[0].title = 'x'.repeat(30_000)
    const buffer = await buildOrdersWorkbook(orders, [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    const headers = sheet.getRow(1).values as (string | undefined)[]
    const titleCol = headers.indexOf('商品标题')
    const value = String(sheet.getRow(2).getCell(titleCol).value ?? '')
    expect(value.length).toBe(30_000)
  })

  it('含换行/引号/逗号的字段在 CSV 中正确转义', () => {
    const orders = makeOrders(1)
    orders[0].title = '多行\n标题,"带引号"'
    const buf = buildOrdersCsv(orders, [])
    const text = buf.toString('utf-8').replace(/^\ufeff/, '')
    // RFC 4180：字段含换行/逗号/引号时整体加引号，内部引号翻倍
    const expected = '"多行\n标题,""带引号"""'
    expect(text).toContain(expected)
    // 且该字段必须被引号包裹（否则换行会破坏 CSV 行结构）
    expect(expected.startsWith('"') && expected.endsWith('"')).toBe(true)
  })

  it('空字段不产生 undefined 字符串', async () => {
    const orders = makeOrders(1)
    orders[0].receiverAddress = ''
    orders[0].trackingNo = ''
    const buffer = await buildOrdersWorkbook(orders, [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    sheet.eachRow((row, n) => {
      if (n === 1) return
      row.eachCell({ includeEmpty: true }, (cell) => {
        expect(String(cell.value ?? '')).not.toBe('undefined')
      })
    })
  })
})
