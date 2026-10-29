/**
 * 工单 022：CSV 导出。
 *
 * 要点（工单验收项）：
 * - **UTF-8 BOM**：没有 BOM 的 UTF-8 CSV 在 Excel 里中文全是乱码，这是最常见的投诉
 * - 字段含逗号/引号/换行时按 RFC 4180 加引号并转义
 * - 决策 D-3：时间字段已是 `YYYY-MM-DD HH:mm:ss` 字符串，直接输出，不做任何日期转换
 * - 金额保持平台原始精度字符串，不转数字（避免 Excel 吃掉尾随 0）
 */
import type { ExportColumn, Order } from '../../shared/types/order'
import { resolveExportColumns } from './excel'

/** Excel 识别 UTF-8 的 BOM */
const BOM = '\ufeff'

/** RFC 4180 字段转义 */
export function csvField(value: string): string {
  if (value === '') return ''
  // 含分隔符、引号、换行、回车时加引号，内部引号翻倍
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** 读取单元格值（与 Excel 引擎同规则：核心字段读顶层，扩展读 extra） */
function cellValue(order: Order, column: ExportColumn): string {
  if (column.platformIds?.length && !column.platformIds.includes(order.platform)) return ''
  const key = column.key
  if (key in order) {
    const v = (order as unknown as Record<string, unknown>)[key]
    if (v === null || v === undefined) return ''
    return String(v)
  }
  return order.extra[key] ?? ''
}

/**
 * 生成 CSV 文本（含 BOM）。
 * @param columns 已解析好的导出列（含核心列）。
 *   若传入空数组，自动回退到核心列 —— 否则会生成一个只有空行的文件，
 *   用户拿到后是「导出成功但内容为空」，这是最糟的失败方式。
 */
export function buildOrdersCsv(orders: Order[], columns: ExportColumn[]): Buffer {
  const cols = columns.length ? columns : resolveExportColumns([])
  const lines: string[] = []
  lines.push(cols.map((c) => csvField(c.header)).join(','))

  for (const order of orders) {
    // 图片列在 CSV 里没有意义（图片无法内嵌），输出 URL 即可
    lines.push(cols.map((c) => csvField(cellValue(order, c))).join(','))
  }

  // 用 CRLF 换行：Excel 在 Windows 上对 LF-only 的兼容性更差
  return Buffer.from(BOM + lines.join('\r\n'), 'utf-8')
}
