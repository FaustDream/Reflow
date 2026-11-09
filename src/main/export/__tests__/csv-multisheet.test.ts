/**
 * 工单 022：CSV 导出 + 多 Sheet 的单元测试。
 *
 * 重点验证工单验收项：
 * - CSV 带 UTF-8 BOM（否则 Excel 打开中文乱码）
 * - RFC 4180 转义（逗号/引号/换行）
 * - 决策 D-3：时间字段是字符串，不是日期序列号
 * - 多 Sheet：每 sheet 独立列、名称合法化
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildOrdersCsv, csvField } from '../csv'
import { buildMultiSheetWorkbook, resolveExportColumns, safeSheetName } from '../excel'
import { emptyOrder, type Order } from '../../../shared/types/order'
import type { ExportColumn } from '../../../shared/types/order'

const makeOrder = (over: Partial<Order> = {}): Order => ({
  ...emptyOrder('dewu', 'dewu#0'),
  orderId: 'O1',
  createdAt: '2026-01-02 03:04:05',
  title: '商品',
  paidAmount: '9.9',
  quantity: 1,
  status: '已完成',
  ...over
})

describe('CSV：BOM 与转义', () => {
  it('输出以 UTF-8 BOM 开头（Excel 中文不乱码）', () => {
    const buf = buildOrdersCsv([makeOrder()], resolveExportColumns([]))
    expect(buf[0]).toBe(0xef)
    expect(buf[1]).toBe(0xbb)
    expect(buf[2]).toBe(0xbf)
  })

  it('表头是核心列中文名', () => {
    const buf = buildOrdersCsv([makeOrder()], resolveExportColumns([]))
    const text = buf.toString('utf-8').replace(/^\ufeff/, '')
    const header = text.split('\r\n')[0]
    expect(header).toContain('订单号')
    expect(header).toContain('下单时间')
    expect(header).toContain('实付金额')
  })

  it('时间字段原样输出字符串（D-3，非序列号）', () => {
    const buf = buildOrdersCsv([makeOrder()], resolveExportColumns([]))
    const text = buf.toString('utf-8').replace(/^\ufeff/, '')
    expect(text).toContain('2026-01-02 03:04:05')
    // 不应出现 Excel 日期序列号形态
    expect(text).not.toMatch(/\b4[0-9]{4}\.[0-9]+\b/)
  })

  it('含逗号的字段加引号', () => {
    expect(csvField('a,b')).toBe('"a,b"')
  })

  it('含引号的字段引号翻倍', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('含换行的字段加引号', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('普通字段不加引号', () => {
    expect(csvField('普通文本')).toBe('普通文本')
    expect(csvField('')).toBe('')
  })

  it('订单里的逗号不会破坏列数', () => {
    const order = makeOrder({ title: '商品,带逗号' })
    const cols = resolveExportColumns([])
    const buf = buildOrdersCsv([order], cols)
    const lines = buf.toString('utf-8').replace(/^\ufeff/, '').split('\r\n')
    expect(lines).toHaveLength(2) // 表头 + 1 行
    // 标题字段应被引号包裹
    expect(lines[1]).toContain('"商品,带逗号"')
  })

  it('CSV 行数与订单数一致', () => {
    const buf = buildOrdersCsv([makeOrder({ orderId: 'A' }), makeOrder({ orderId: 'B' })], resolveExportColumns([]))
    const lines = buf.toString('utf-8').replace(/^\ufeff/, '').split('\r\n')
    expect(lines).toHaveLength(3)
  })
})

describe('多 Sheet：工作表名合法化', () => {
  it('去掉 Excel 非法字符', () => {
    const used = new Set<string>()
    expect(safeSheetName('a:b\\c/d?e*f[g]', used)).toBe('a_b_c_d_e_f_g_')
  })

  it('截断到 31 字符', () => {
    const used = new Set<string>()
    expect(safeSheetName('x'.repeat(50), used)).toHaveLength(31)
  })

  it('重名自动加序号', () => {
    const used = new Set<string>()
    expect(safeSheetName('订单', used)).toBe('订单')
    expect(safeSheetName('订单', used)).toBe('订单_2')
    expect(safeSheetName('订单', used)).toBe('订单_3')
  })

  it('空名回退为「订单」', () => {
    const used = new Set<string>()
    expect(safeSheetName('', used)).toBe('订单')
  })
})

describe('多 Sheet：工作簿生成', () => {
  it('每个平台一个 sheet，各自独立列', async () => {
    const dewuCols: ExportColumn[] = [{ key: 'skuProp', header: '商品规格' }]
    const ksCols: ExportColumn[] = [{ key: 'skuDesc', header: '商品规格' }]
    const buf = await buildMultiSheetWorkbook([
      {
        name: '得物',
        orders: [makeOrder({ platform: 'dewu', extra: { skuProp: '红' } })],
        extended: dewuCols
      },
      {
        name: '快手小店',
        orders: [makeOrder({ platform: 'kuaishou', extra: { skuDesc: '蓝' } })],
        extended: ksCols
      }
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)

    expect(wb.worksheets.map((w) => w.name)).toEqual(['得物', '快手小店'])
    // 各自列头都是「商品规格」（单平台内不冲突，不需要加平台后缀）
    for (const sheet of wb.worksheets) {
      const headers = sheet.getRow(1).values as unknown[]
      expect(headers).toContain('商品规格')
    }
  })

  it('空订单的 sheet 被跳过', async () => {
    const buf = await buildMultiSheetWorkbook([
      { name: '有单', orders: [makeOrder()], extended: [] },
      { name: '空表', orders: [], extended: [] }
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['有单'])
  })

  it('全部为空时仍生成一个合法工作簿（不是零 sheet）', async () => {
    const buf = await buildMultiSheetWorkbook([{ name: '空', orders: [], extended: [] }])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.worksheets).toHaveLength(1)
  })

  it('多 Sheet 下时间列仍是文本格式（D-3 全局生效）', async () => {
    const buf = await buildMultiSheetWorkbook([
      { name: 'A', orders: [makeOrder()], extended: [] },
      { name: 'B', orders: [makeOrder({ orderId: 'O2' })], extended: [] }
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    for (const sheet of wb.worksheets) {
      const headers = sheet.getRow(1).values as (string | undefined)[]
      const col = headers.indexOf('下单时间')
      const cell = sheet.getRow(2).getCell(col)
      expect(typeof cell.value).toBe('string')
      expect(cell.numFmt).toBe('@')
    }
  })
})
