import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildStatsWorkbook, type StatsSheet } from '../stats-excel'

async function load(sheets: StatsSheet[]): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await buildStatsWorkbook(sheets)) as unknown as ArrayBuffer)
  return wb
}

const headersOf = (sheet: ExcelJS.Worksheet): string[] =>
  (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v))

describe('buildStatsWorkbook（统计报表导出，2026-11-08）', () => {
  const sheets: StatsSheet[] = [
    {
      name: '月度趋势',
      headers: ['月份', '交易成功单数', '已完成金额'],
      rows: [
        ['2026-09', 12, 345.6],
        ['2026-10', 20, 1234.5],
        ['合计', 32, 1580.1]
      ],
      boldLast: true
    },
    {
      name: '平台汇总',
      headers: ['平台', '已完成金额'],
      rows: [
        ['淘宝', 100],
        ['京东', 50]
      ]
    }
  ]

  it('每区块一张 Sheet，表头与数值一一对应', async () => {
    const wb = await load(sheets)
    expect(wb.worksheets.map((s) => s.name)).toEqual(['月度趋势', '平台汇总'])
    const t = wb.getWorksheet('月度趋势')!
    expect(headersOf(t)).toEqual(['月份', '交易成功单数', '已完成金额'])
    expect(t.getRow(3).getCell(2).value).toBe(20)
    expect(t.getRow(3).getCell(3).value).toBe(1234.5)
  })

  it('boldLast：末行（合计行）加粗，非末行不加粗', async () => {
    const wb = await load(sheets)
    const t = wb.getWorksheet('月度趋势')!
    expect(t.getRow(3).font?.bold).toBeFalsy()
    expect(t.getRow(4).font?.bold).toBe(true)
    const p = wb.getWorksheet('平台汇总')!
    expect(p.getRow(2).font?.bold).toBeFalsy()
  })

  it('数字整列右对齐 + 千分位；文本列不受影响', async () => {
    const wb = await load(sheets)
    const t = wb.getWorksheet('月度趋势')!
    expect(t.getColumn(3).numFmt).toBe('#,##0.00')
    expect(t.getColumn(1).numFmt).toBeUndefined()
  })

  it('空区块列表给出占位表（避免无 sheet 的非法文件）', async () => {
    const wb = await load([])
    expect(wb.worksheets).toHaveLength(1)
    expect(wb.worksheets[0].name).toBe('统计')
  })
})
