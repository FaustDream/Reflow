/**
 * 统计报表工作簿（2026-11-08）：把仪表盘的汇总统计导出成 Excel。
 *
 * 与订单明细导出（excel.ts）的分工：明细导出的数据语义在主进程（列定义、
 * 状态文案都在 shared），而统计报表的区块由**渲染层按页面显示口径**算好发来 ——
 * 保证「导出的数字 = 看到的数字」，主进程只负责排版与落盘，不重复实现口径。
 *
 * 结构：每区块一张 Sheet（headers + rows），boldLast 时末行加粗（合计行惯例）。
 */
import type ExcelJS from 'exceljs'
import { loadExcelJS } from '../lazy-exceljs'
import { SIGNATURE } from '../../shared/app-meta'

export interface StatsSheet {
  /** Sheet 名（如「月度趋势」「平台对比」） */
  name: string
  headers: string[]
  rows: Array<Array<string | number>>
  /** 末行加粗（合计行） */
  boldLast?: boolean
}

/** 中文字符按 2 个宽度估列宽，表头/内容取最大，夹在 [8, 32] */
function colWidth(header: string, values: Array<string | number>): number {
  const widthOf = (s: string): number =>
    [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0)
  let w = widthOf(header) + 2
  for (const v of values) {
    if (v === null || v === undefined) continue
    w = Math.max(w, widthOf(String(v)) + 2)
  }
  return Math.min(Math.max(w, 8), 32)
}

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const row = sheet.getRow(1)
  row.font = { bold: true }
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF3F4F6' }
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

/** 由统计区块构建多 Sheet 工作簿 */
export async function buildStatsWorkbook(sheets: StatsSheet[]): Promise<Buffer> {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  // 与订单导出同款固定署名（D-4）：不写本机用户名/机器名
  workbook.creator = SIGNATURE
  workbook.lastModifiedBy = SIGNATURE

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, {
      properties: { defaultRowHeight: 18 }
    })
    sheet.columns = spec.headers.map((h, i) => ({
      header: h,
      key: `c${i}`,
      width: colWidth(
        h,
        spec.rows.map((r) => r[i] ?? '')
      )
    }))
    styleHeaderRow(sheet)

    spec.rows.forEach((r, ri) => {
      const row = sheet.addRow(r)
      if (spec.boldLast && ri === spec.rows.length - 1) row.font = { bold: true }
      // 数字列右对齐 + 千分位（仅当整列都是数字时才按数字列排版）
    })
    for (let i = 0; i < spec.headers.length; i++) {
      const allNum = spec.rows.length > 0 && spec.rows.every((r) => typeof r[i] === 'number')
      if (allNum) {
        const col = sheet.getColumn(i + 1)
        col.alignment = { horizontal: 'right' }
        col.numFmt = '#,##0.00'
      }
    }
  }

  // 全空时至少给一个占位表，避免生成无 sheet 的非法文件
  if (!workbook.worksheets.length) {
    const sheet = workbook.addWorksheet('统计')
    sheet.addRow(['暂无统计数据'])
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as unknown as ArrayBuffer)
}
