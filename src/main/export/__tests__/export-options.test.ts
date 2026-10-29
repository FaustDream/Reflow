/**
 * 工单 031：导出中心（列选择 / 汇总表 / 自动筛选）的回归测试。
 *
 * 这些断言对应「用户勾了什么就该导出什么」这一条硬约束：
 * - 核心列白名单必须严格生效（漏一列或多一列都会让用户拿到错的表）
 * - `undefined` 与 `[]` 语义必须区分（不传=全要；空数组=一列都不要）
 * - 多平台多 Sheet 时的「汇总」表数字必须与明细对得上
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildMultiSheetWorkbook,
  buildOrdersWorkbook,
  pickCoreColumns,
  resolveExportColumns,
  SUMMARY_SHEET_NAME
} from '../excel'
import { buildOrdersCsv } from '../csv'
import { CORE_EXPORT_COLUMNS, emptyOrder, type Order } from '../../../shared/types/order'

const makeOrder = (orderId: string, platform: string, paid: string): Order => {
  const o = emptyOrder(platform, `${platform}#0`)
  o.orderId = orderId
  o.createdAt = '2026-03-01 08:00:00'
  o.title = `商品 ${orderId}`
  o.paidAmount = paid
  o.quantity = 1
  o.extra = { itemId: `I-${orderId}` }
  return o
}

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

const headersOf = (sheet: ExcelJS.Worksheet): string[] =>
  (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v))

describe('pickCoreColumns：白名单语义', () => {
  it('不传 = 全部核心列', () => {
    expect(pickCoreColumns()).toHaveLength(CORE_EXPORT_COLUMNS.length)
    expect(pickCoreColumns().map((c) => c.key)).toEqual(CORE_EXPORT_COLUMNS.map((c) => c.key))
  })

  it('空数组 = 一列都不要（与「不传」区分）', () => {
    expect(pickCoreColumns([])).toEqual([])
  })

  it('子集按 CORE 的原始顺序输出，不受勾选顺序影响', () => {
    const picked = pickCoreColumns(['paidAmount', 'orderId'])
    expect(picked.map((c) => c.key)).toEqual(['orderId', 'paidAmount'])
  })
})

describe('单表导出：列白名单', () => {
  it('只导出勾选的核心列 + 勾选的扩展列', async () => {
    const wb = await load(
      await buildOrdersWorkbook(
        [makeOrder('A1', 'xianyu', '10.00')],
        [{ key: 'itemId', header: '商品ID', platformId: 'xianyu', platformName: '闲鱼' }],
        { coreKeys: ['orderId', 'paidAmount'] }
      )
    )
    expect(headersOf(wb.getWorksheet('订单')!)).toEqual(['订单号', '实付金额', '商品ID'])
  })

  it('表头带自动筛选（打开即可按平台/状态筛）', async () => {
    const wb = await load(await buildOrdersWorkbook([makeOrder('A1', 'jd', '1')]))
    const sheet = wb.getWorksheet('订单')!
    expect(sheet.autoFilter).toBeTruthy()
  })

  it('核心列全不选时只留扩展列（不会偷偷补回核心列）', async () => {
    const wb = await load(
      await buildOrdersWorkbook([makeOrder('A1', 'jd', '1')], [{ key: 'itemId', header: '商品ID' }], {
        coreKeys: []
      })
    )
    expect(headersOf(wb.getWorksheet('订单')!)).toEqual(['商品ID'])
  })
})

describe('多 Sheet 导出：汇总表', () => {
  const sheets = [
    {
      name: '闲鱼',
      orders: [makeOrder('X1', 'xianyu', '10.50'), makeOrder('X2', 'xianyu', '2.50')],
      extended: []
    },
    { name: '京东', orders: [makeOrder('J1', 'jd', '7.00')], extended: [] }
  ]

  it('显式开启时首表为「汇总」，数字与明细一致', async () => {
    const wb = await load(await buildMultiSheetWorkbook(sheets, { summary: true }))
    expect(wb.worksheets[0].name).toBe(SUMMARY_SHEET_NAME)

    const summary = wb.getWorksheet(SUMMARY_SHEET_NAME)!
    expect(headersOf(summary)).toEqual(['平台', '订单数', '实付合计', '最早下单', '最晚下单'])
    // 表头 + 2 平台 + 合计
    expect(summary.rowCount).toBe(4)
    expect(summary.getRow(2).getCell(2).value).toBe(2)
    expect(summary.getRow(2).getCell(3).value).toBe(13)
    expect(summary.getRow(3).getCell(3).value).toBe(7)
    // 合计行
    expect(summary.getRow(4).getCell(1).value).toBe('合计')
    expect(summary.getRow(4).getCell(2).value).toBe(3)
    expect(summary.getRow(4).getCell(3).value).toBe(20)
  })

  it('不传 summary 时不加汇总表（保持「每平台一张表」的既有语义）', async () => {
    const wb = await load(await buildMultiSheetWorkbook(sheets))
    expect(wb.getWorksheet(SUMMARY_SHEET_NAME)).toBeUndefined()
    expect(wb.worksheets.map((s) => s.name)).toEqual(['闲鱼', '京东'])
  })

  it('只有一个平台时即使开启也不加汇总表（一张表就是全貌）', async () => {
    const wb = await load(await buildMultiSheetWorkbook([sheets[0]], { summary: true }))
    expect(wb.getWorksheet(SUMMARY_SHEET_NAME)).toBeUndefined()
  })

  it('列白名单对每个 sheet 都生效', async () => {
    const wb = await load(await buildMultiSheetWorkbook(sheets, { coreKeys: ['orderId'] }))
    for (const name of ['闲鱼', '京东']) {
      expect(headersOf(wb.getWorksheet(name)!)).toEqual(['订单号'])
    }
  })
})

describe('工单 034：平台自定义列序', () => {
  it('声明 columns 时不再拼核心列，按给定顺序输出', async () => {
    const wb = await load(
      await buildOrdersWorkbook([makeOrder('A1', 'xianyu', '9.90')], [], {
        columns: [
          { key: 'paidAmount', header: '实付款' },
          { key: 'orderId', header: '订单号' }
        ]
      })
    )
    expect(headersOf(wb.getWorksheet('订单')!)).toEqual(['实付款', '订单号'])
  })

  it('京东 15 列 / 拼多多 25 列原版列序', async () => {
    const { jdAdapter } = await import('../../platform/jd')
    const { pddAdapter } = await import('../../platform/pdd')
    expect(jdAdapter.exportColumns?.[0].header).toBe('下单日期')
    expect(jdAdapter.exportColumns).toHaveLength(15)
    expect(pddAdapter.exportColumns?.[0].header).toBe('下单日期')
    expect(pddAdapter.exportColumns).toHaveLength(25)
    expect(pddAdapter.exportColumns?.at(-1)?.header).toBe('用户名')
  })

  it('闲鱼适配器带原版 17 列列序', async () => {
    const { xianyuAdapter } = await import('../../platform/xianyu')
    expect(xianyuAdapter.exportColumns).toHaveLength(17)
    expect(xianyuAdapter.exportColumns?.[0].header).toBe('订单号')
    expect(xianyuAdapter.exportColumns?.at(-1)?.header).toBe('成交时间')
  })
})

describe('CSV：列白名单', () => {
  it('只输出勾选的列', () => {
    const buf = buildOrdersCsv(
      [makeOrder('C1', 'pdd', '3.30')],
      resolveExportColumns([], pickCoreColumns(['orderId', 'paidAmount']))
    )
    const text = buf.toString('utf-8').replace(/^\ufeff/, '')
    const [header, row] = text.split('\r\n')
    expect(header).toBe('订单号,实付金额')
    expect(row).toBe('C1,3.30')
  })
})
