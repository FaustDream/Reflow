/**
 * 工单 007：统一 Excel 导出引擎（主进程，exceljs）。
 *
 * 列模型（方案附录 A.5）：CORE_EXPORT_COLUMNS（19 核心列，全平台统一顺序）
 * + 涉及平台的 extended columns（按适配器注册顺序去重合并）。
 *
 * 决策 D-3：所有时间字段在适配器层已规整为 `YYYY-MM-DD HH:mm:ss` 字符串，
 * 这里以纯文本单元格写入，绝不产生 Excel 日期序列号（原版 1688 的 `45903.8374` 缺陷）。
 */
import ExcelJS from 'exceljs'
import { CORE_EXPORT_COLUMNS, type ExportColumn, type Order } from '../../shared/types/order'
import type { PreparedImage } from './images'

const ROW_CHUNK = 1000
/** 工单 009：内嵌缩略图尺寸与行高（与原版一致） */
const IMAGE_SIZE = 60
const IMAGE_ROW_HEIGHT = 80
const IMAGE_COLUMN_KEY = '__embeddedImage'
const IMAGE_COLUMN_HEADER = '商品图'
/** 汇总表名（多 Sheet 模式首表） */
export const SUMMARY_SHEET_NAME = '汇总'

/**
 * 核心列白名单（工单 031：导出中心的「列选择」）。
 *
 * 语义严格区分「没传」与「传了空数组」：
 * - `undefined` → 全部核心列（保持旧调用方行为）
 * - `[]` → 一列都不要（用户主动全不勾选）
 * 顺序始终按 `CORE_EXPORT_COLUMNS`，与用户勾选顺序无关。
 */
export function pickCoreColumns(coreKeys?: string[]): ExportColumn[] {
  if (!coreKeys) return CORE_EXPORT_COLUMNS
  const allow = new Set(coreKeys)
  return CORE_EXPORT_COLUMNS.filter((col) => allow.has(col.key))
}

export interface BuildOptions {
  /** 工单 009：imageUrl → 已下载图片；提供时首列内嵌 60×60 缩略图 */
  images?: Map<string, PreparedImage>
  /** 核心列白名单（缺省全部） */
  coreKeys?: string[]
  /** 多 Sheet 模式是否附带「汇总」表（默认不附带；导出中心默认勾选） */
  summary?: boolean
  /** 工单 034：平台自定义的完整列序（声明后不再拼核心列） */
  columns?: ExportColumn[]
}

/**
 * 读取单元格值：核心字段读 Order 顶层，扩展列读 extra。
 * 列声明了 `platformIds` 时，仅对来源平台的订单填值（跨平台拆列语义隔离）。
 */
function cellValue(order: Order, column: ExportColumn): string | number {
  if (column.platformIds?.length && !column.platformIds.includes(order.platform)) return ''
  const key = column.key
  if (key in order) {
    const v = (order as unknown as Record<string, unknown>)[key]
    if (v === null || v === undefined) return ''
    return typeof v === 'number' ? v : String(v)
  }
  return order.extra[key] ?? ''
}

/**
 * 组装导出列：核心列 + 平台扩展列。
 *
 * 跨平台合并时会遇到两类列名冲突，都会让用户看不懂导出的表：
 *
 * 1. **同 header 不同 key**（如得物 `skuProp` 与快手 `skuDesc` 都叫「商品规格」）：
 *    都保留会出现两个同名表头，用户无法分辨。给后续冲突列追加平台名（「商品规格(快手)」）。
 *
 * 2. **同 key 不同 header**（如 `sellerId` 在闲鱼叫「卖家ID」、在闲鱼卖家叫「买家ID」）：
 *    语义随平台反转，合并成一列会把买家 ID 标成「卖家ID」—— 这是错误数据。
 *    来源平台不同 → 拆成两列；来源平台相同（真正的重复声明）→ 去重。
 *
 * 拆列后每列记录 `platformIds`，写单元格时只给这些平台的订单填值（见 `cellValue`），
 * 否则 A 平台的行会在 B 平台的专属列里重复显示同一个值。
 *
 * @param extended 平台扩展列；`platformId`/`platformName` 由导出 IPC 注入
 */
export function resolveExportColumns(
  extended: ExportColumn[],
  coreColumns: ExportColumn[] = CORE_EXPORT_COLUMNS
): ExportColumn[] {
  const coreKeys = new Set(coreColumns.map((c) => c.key))
  const coreHeaders = new Set(coreColumns.map((c) => c.header))
  /** key → 该 key 已采纳的列（可能因平台不同而有多列） */
  const adopted = new Map<string, ExportColumn[]>()
  const usedHeaders = new Set<string>(coreHeaders)
  const merged: ExportColumn[] = [...coreColumns]

  const disambiguate = (col: ExportColumn, header: string): string => {
    const suffix = col.platformName ?? col.platformId
    const tagged = suffix ? `${header}(${suffix})` : header
    let candidate = tagged
    let n = 2
    while (usedHeaders.has(candidate)) candidate = `${tagged}#${n++}`
    return candidate
  }

  for (const col of extended) {
    if (coreKeys.has(col.key)) continue

    const existing = adopted.get(col.key) ?? []
    // 同 key 且同 header：无论来自哪个平台都是同一列，合并平台归属即可
    const sameHeader = existing.find((c) => c.header === col.header)
    if (sameHeader) {
      addPlatform(sameHeader, col)
      continue
    }
    // 同 key 不同 header：同一平台视为重复声明（丢弃），不同平台才是语义差异（拆列）
    if (existing.length && existing.some((c) => samePlatform(c, col))) continue

    const header = usedHeaders.has(col.header) ? disambiguate(col, col.header) : col.header
    usedHeaders.add(header)
    const created: ExportColumn = {
      ...col,
      header,
      platformIds: col.platformId ? [col.platformId] : undefined
    }
    adopted.set(col.key, [...existing, created])
    merged.push(created)
  }
  return merged
}

const samePlatform = (a: ExportColumn, b: ExportColumn): boolean =>
  (a.platformIds?.length ?? 0) === 0 || a.platformIds!.includes(b.platformId ?? '')

function addPlatform(column: ExportColumn, incoming: ExportColumn): void {
  if (!incoming.platformId) return
  if (!column.platformIds) return // 无平台归属的列对所有平台生效
  if (!column.platformIds.includes(incoming.platformId)) column.platformIds.push(incoming.platformId)
}

/** 表头统一样式（订单表与汇总表共用） */
function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F3F5' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD0D3D9' } } }
  })
}

/** 把一批订单填进一个 worksheet（多 Sheet 模式复用同一套样式逻辑） */
function fillSheet(
  sheet: ExcelJS.Worksheet,
  orders: Order[],
  columns: ExportColumn[],
  options: { withImages: boolean; images?: Map<string, PreparedImage>; workbook: ExcelJS.Workbook }
): void {
  const { withImages, images, workbook } = options

  sheet.columns = columns.map((col, index) => ({
    header: col.header,
    // 同 key 拆成多列时 exceljs 的 key 会撞车 → 用列序号做唯一键，取值仍按 col 对象
    key: `c${index}`,
    width: col.width ?? 16
  }))

  // 表头样式
  styleHeaderRow(sheet)

  // 分批写入（>1000 单时避免一次性行对象膨胀）
  for (let start = 0; start < orders.length; start += ROW_CHUNK) {
    const slice = orders.slice(start, start + ROW_CHUNK)
    const rows = slice.map((order) =>
      columns.map((col) => (col.key === IMAGE_COLUMN_KEY ? '' : cellValue(order, col)))
    )
    sheet.addRows(rows)
  }

  // 工单 031：表头自动筛选（按平台/状态/时间筛选是拿到表后第一件事）
  if (columns.length) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length }
    }
  }

  // 时间列强制文本格式 @（D-3：杜绝序列号）
  const datetimeKeys = new Set(
    CORE_EXPORT_COLUMNS.filter((c) => c.format === 'datetime').map((c) => c.key)
  )
  const datetimeColumns = new Set<number>()
  columns.forEach((col, index) => {
    if (datetimeKeys.has(col.key) || col.format === 'datetime') datetimeColumns.add(index + 1)
  })
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    if (withImages) row.height = IMAGE_ROW_HEIGHT
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (datetimeColumns.has(colNumber)) {
        cell.numFmt = '@'
        if (cell.value !== null && cell.value !== '') cell.value = String(cell.value)
      }
    })
  })

  // 工单 009：内嵌缩略图（浮动绘制在首列，60×60，行高 80）
  if (withImages && images) {
    orders.forEach((order, index) => {
      const image = images.get(order.imageUrl)
      if (!image) return
      const imageId = workbook.addImage({
        // exceljs 类型声明要求 Node Buffer（@types/node 泛型不兼容），运行时接受 Uint8Array
        buffer: image.buffer as unknown as never,
        extension: image.extension
      })
      sheet.addImage(imageId, {
        tl: { col: 0, row: index + 1 },
        ext: { width: IMAGE_SIZE, height: IMAGE_SIZE },
        editAs: 'oneCell'
      })
    })
  }
}

/** 创建并配置一个工作表（冻结首行 + 首列，横向滚动时仍能对上订单） */
function addOrdersSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  withImages: boolean
): ExcelJS.Worksheet {
  return workbook.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
    properties: { defaultRowHeight: withImages ? IMAGE_ROW_HEIGHT : 18 }
  })
}

function newWorkbook(): ExcelJS.Workbook {
  // 不写入创建者/机器元数据（避免本机用户名泄露，D-4 隐私意识）
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '回流 Reflow'
  workbook.created = new Date(0)
  workbook.modified = new Date(0)
  return workbook
}

/**
 * 由订单集合生成 xlsx Buffer（**单 Sheet**）。
 * @param orders 已去重的统一订单
 * @param extended 本次导出涉及平台的 extended columns
 * @param options 见 {@link BuildOptions}（图片内嵌 / 核心列白名单）
 */
export async function buildOrdersWorkbook(
  orders: Order[],
  extended: ExportColumn[] = [],
  options: BuildOptions = {}
): Promise<Buffer> {
  const withImages = options.images instanceof Map && options.images.size > 0
  const imageColumn: ExportColumn = { key: IMAGE_COLUMN_KEY, header: IMAGE_COLUMN_HEADER, width: 10 }
  const core = pickCoreColumns(options.coreKeys)
  const resolved = options.columns ?? resolveExportColumns(extended, core)
  const columns = withImages ? [imageColumn, ...resolved] : resolved

  const workbook = newWorkbook()
  const sheet = addOrdersSheet(workbook, '订单', withImages)
  fillSheet(sheet, orders, columns, { withImages, images: options.images, workbook })

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}

export interface SheetSpec {
  /** 工作表名（Excel 限制 31 字符，且不能含 : \ / ? * [ ]） */
  name: string
  orders: Order[]
  /** 该 sheet 的扩展列 */
  extended: ExportColumn[]
  /** 工单 034：该平台的完整列序（优先于 extended + 核心列） */
  columns?: ExportColumn[]
}

/** 工作表名合法化（去非法字符、截断、去重） */
export function safeSheetName(name: string, used: Set<string>): string {
  // Excel 禁止 : \ / ? * [ ] 且限 31 字符。
  // 用 String.raw 构造正则，避免转义层级把人绕晕（这里要匹配的是字面反斜杠）
  const ILLEGAL = new RegExp(String.raw`[:\\/?*\[\]]`, 'g')
  const cleaned = name.replace(ILLEGAL, '_').slice(0, 31) || '订单'
  let candidate = cleaned
  let n = 2
  while (used.has(candidate)) {
    const suffix = `_${n++}`
    candidate = cleaned.slice(0, 31 - suffix.length) + suffix
  }
  used.add(candidate)
  return candidate
}

/** 金额字符串 → 数值（平台原文可能带 ¥ / 元 / 千分位；解析失败按 0 计） */
function parseAmount(value: string): number {
  if (!value) return 0
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

interface SummaryRow {
  name: string
  count: number
  amount: number
  first: string
  last: string
}

/** 汇总表：每平台一行 + 合计行（多 Sheet 导出时放在最前，打开即见全局） */
function addSummarySheet(
  workbook: ExcelJS.Workbook,
  rows: SummaryRow[],
  used: Set<string>
): void {
  const sheet = workbook.addWorksheet(safeSheetName(SUMMARY_SHEET_NAME, used), {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 }
  })
  sheet.columns = [
    { header: '平台', key: 'name', width: 14 },
    { header: '订单数', key: 'count', width: 10 },
    { header: '实付合计', key: 'amount', width: 14 },
    { header: '最早下单', key: 'first', width: 20 },
    { header: '最晚下单', key: 'last', width: 20 }
  ]
  styleHeaderRow(sheet)

  for (const row of rows) {
    sheet.addRow([row.name, row.count, row.amount, row.first, row.last])
  }
  const totalRow = sheet.addRow([
    '合计',
    rows.reduce((sum, r) => sum + r.count, 0),
    rows.reduce((sum, r) => sum + r.amount, 0),
    '',
    ''
  ])
  totalRow.font = { bold: true }

  sheet.getColumn(3).numFmt = '#,##0.00'
  sheet.getColumn(2).alignment = { horizontal: 'right' }
  sheet.getColumn(3).alignment = { horizontal: 'right' }
}

/** 由各 sheet 的订单算出汇总行（时间按 `YYYY-MM-DD HH:mm:ss` 字符串比较，字典序即时间序） */
function summarizeSheets(sheets: SheetSpec[]): SummaryRow[] {
  return sheets
    .filter((s) => s.orders.length)
    .map((s) => {
      const dates = s.orders
        .map((o) => o.createdAt)
        .filter((d): d is string => Boolean(d))
        .sort()
      return {
        name: s.name,
        count: s.orders.length,
        amount: Math.round(s.orders.reduce((sum, o) => sum + parseAmount(o.paidAmount), 0) * 100) / 100,
        first: dates[0] ?? '',
        last: dates[dates.length - 1] ?? ''
      }
    })
}

/**
 * 由多组订单生成 **多 Sheet** 工作簿（工单 022）。
 * 每个 sheet 独立列定义（各平台的扩展列不同，不应互相污染）。
 * 工单 031：≥2 个平台时默认在最前加一张「汇总」表（单数 / 实付合计 / 时间范围）。
 */
export async function buildMultiSheetWorkbook(
  sheets: SheetSpec[],
  options: BuildOptions = {}
): Promise<Buffer> {
  const withImages = options.images instanceof Map && options.images.size > 0
  const imageColumn: ExportColumn = { key: IMAGE_COLUMN_KEY, header: IMAGE_COLUMN_HEADER, width: 10 }
  const core = pickCoreColumns(options.coreKeys)
  const workbook = newWorkbook()
  const used = new Set<string>()

  const filled = sheets.filter((s) => s.orders.length)
  // 汇总表是**显式开启**的附加内容：调用方没要求时不改变「每个平台一张表」的既有语义
  if (options.summary === true && filled.length >= 2) {
    addSummarySheet(workbook, summarizeSheets(filled), used)
  }

  for (const spec of filled) {
    const resolved = spec.columns ?? resolveExportColumns(spec.extended, core)
    const columns = withImages ? [imageColumn, ...resolved] : resolved
    const sheet = addOrdersSheet(workbook, safeSheetName(spec.name, used), withImages)
    fillSheet(sheet, spec.orders, columns, { withImages, images: options.images, workbook })
  }

  // 全空时至少给一个空表，避免生成无 sheet 的非法文件
  if (!workbook.worksheets.length) {
    const sheet = addOrdersSheet(workbook, '订单', false)
    fillSheet(sheet, [], resolveExportColumns([], core), { withImages: false, workbook })
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
