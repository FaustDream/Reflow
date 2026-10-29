/**
 * 订单文件导入：把平台官方导出的 Excel/CSV 直接读进本地库。
 *
 * 为什么需要它：
 * 淘宝/美团的网页订单列表只展示一部分（实测美团 h5 滚到底 78 单，淘宝订单页走 SPA），
 * 想在**不改动平台、不逆向签名**的前提下拿到全量，最稳的路是让平台自己导出：
 * - 淘宝「已买到的宝贝 → 导出订单」直接给 xlsx（全量）
 * - 其他平台能用 CSV 的也走这里
 *
 * 导入后与在线抓取的订单走同一份存储（按 platform 分文件），
 * 因此下次启动直接从本地恢复，不会重复拉取。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import ExcelJS from 'exceljs'
import { toDateTimeString } from '../shared/datetime'
import type { Order } from '../shared/types/order'

export interface ImportResult {
  ok: boolean
  platform?: string
  imported: number
  skipped: number
  message?: string
}

/** 表头别名：平台导出的列名五花八门，做模糊匹配 */
const HEADER_ALIASES: Record<keyof Pick<Order, 'orderId' | 'title' | 'paidAmount' | 'createdAt' | 'shopName' | 'quantity' | 'status'>, string[]> = {
  orderId: ['订单编号', '订单号', '主订单编号', 'orderid', 'order id', '订单流水号'],
  title: ['商品标题', '宝贝标题', '商品名称', '商品', 'title', '商品信息'],
  paidAmount: ['实付款', '实付金额', '订单金额', '付款金额', '总金额', 'amount', '金额'],
  createdAt: ['订单创建时间', '创建时间', '下单时间', '订单时间', '成交时间', 'time', '日期'],
  shopName: ['店铺名称', '卖家店铺', '店铺', '商家', 'shop'],
  quantity: ['购买数量', '数量', '件数', 'qty'],
  status: ['订单状态', '状态', 'status']
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return ''
  // exceljs 的富文本/公式单元格
  if (typeof v === 'object') {
    const anyV = v as { text?: string; result?: unknown; richText?: Array<{ text?: string }> }
    if (typeof anyV.text === 'string') return anyV.text.trim()
    if (anyV.result !== undefined) return String(anyV.result).trim()
    if (Array.isArray(anyV.richText)) return anyV.richText.map((r) => r.text ?? '').join('').trim()
    return ''
  }
  return String(v).trim()
}

/** 表头 → 字段索引 */
function mapHeader(header: string[]): Partial<Record<keyof typeof HEADER_ALIASES, number>> {
  const map: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {}
  const lowered = header.map((h) => h.toLowerCase().replace(/\s+/g, ''))
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof typeof HEADER_ALIASES, string[]]
  >) {
    for (const alias of aliases) {
      const a = alias.toLowerCase().replace(/\s+/g, '')
      const idx = lowered.findIndex((h) => h.includes(a))
      if (idx >= 0) {
        map[field] = idx
        break
      }
    }
  }
  return map
}

function amountOf(raw: string): string {
  // "¥1,234.50" / "1,234.50" / "实付 99" → "1234.50"
  const n = raw.replace(/[^\d.-]/g, '')
  if (!n) return ''
  const v = Number(n)
  return Number.isFinite(v) ? v.toFixed(2) : ''
}

/** 解析成二维表（xlsx 或 csv 都归一到这里） */
async function readRows(filePath: string): Promise<string[][]> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    const text = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        // 简易 CSV：支持双引号包裹与转义逗号
        const cells: string[] = []
        let cur = ''
        let quoted = false
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]
          if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
              cur += '"'
              i++
            } else quoted = !quoted
          } else if (ch === ',' && !quoted) {
            cells.push(cur)
            cur = ''
          } else cur += ch
        }
        cells.push(cur)
        return cells.map((c) => c.trim())
      })
  }

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(filePath) as unknown as ArrayBuffer)
  const sheet = wb.worksheets[0]
  if (!sheet) return []
  const rows: string[][] = []
  sheet.eachRow((row) => {
    const cells: string[] = []
    for (let c = 1; c <= row.cellCount; c++) cells.push(norm(row.getCell(c).value))
    rows.push(cells)
  })
  return rows
}

/** 解析文件，返回订单列表（不落盘，由调用方决定合并到哪个平台） */
export async function parseOrdersFile(filePath: string): Promise<{
  orders: Order[]
  skipped: number
  header: string[]
}> {
  const rows = await readRows(filePath)
  if (rows.length < 2) return { orders: [], skipped: 0, header: rows[0] ?? [] }

  // 前几行里找表头（平台导出常在前面加一行标题/说明）
  let headerIdx = 0
  let map = mapHeader(rows[0])
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const m = mapHeader(rows[i])
    if (m.orderId !== undefined || m.title !== undefined) {
      headerIdx = i
      map = m
      break
    }
  }
  const header = rows[headerIdx] ?? []

  const orders: Order[] = []
  let skipped = 0
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r]
    const pick = (field: keyof typeof HEADER_ALIASES): string => {
      const idx = map[field]
      return idx === undefined ? '' : (cells[idx] ?? '')
    }
    const orderId = pick('orderId')
    const title = pick('title')
    if (!orderId && !title) {
      skipped++
      continue
    }
    orders.push({
      orderId,
      title,
      paidAmount: amountOf(pick('paidAmount')),
      createdAt: toDateTimeString(pick('createdAt')),
      shopName: pick('shopName'),
      quantity: Number(pick('quantity')) || undefined,
      status: pick('status'),
      // 导入的单没有平台 id，由调用方补齐
      platform: ''
    } as Order)
  }
  return { orders, skipped, header }
}
