import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildOrdersWorkbook, resolveExportColumns } from '../excel'
import { SIGNATURE } from '../../../shared/app-meta'
import type { PreparedImage } from '../images'
import { CORE_EXPORT_COLUMNS, emptyOrder, type Order } from '../../../shared/types/order'
import type { ExportColumn } from '../../../shared/types/order'

const makeOrder = (i: number, platform = 'xianyu'): Order => {
  const o = emptyOrder(platform, 'u-1')
  o.orderId = `O${1000 + i}`
  o.createdAt = '2026-10-01 12:00:00'
  o.title = `商品 ${i}`
  o.paidAmount = `${(i * 1.5).toFixed(2)}`
  o.quantity = 1
  o.status = '已完成'
  o.shopName = '店铺'
  o.extra = { itemId: `I${i}`, sellerId: 'S1' }
  return o
}

async function loadWorkbook(orders: Order[], extended: ExportColumn[] = []): Promise<ExcelJS.Workbook> {
  const buffer = await buildOrdersWorkbook(orders, extended)
  const wb = new ExcelJS.Workbook()
  // exceljs 类型声明与新版 @types/node 的 Buffer 泛型不兼容，运行时 Buffer 可读
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

async function loadWorkbookWithImages(
  orders: Order[],
  extended: ExportColumn[],
  images: Map<string, PreparedImage>
): Promise<ExcelJS.Workbook> {
  const buffer = await buildOrdersWorkbook(orders, extended, { images })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

describe('resolveExportColumns', () => {
  it('核心列在前，扩展列去重追加，与核心列重名的扩展列丢弃', () => {
    const cols = resolveExportColumns([
      { key: 'itemId', header: '商品ID' },
      { key: 'itemId', header: '商品ID重复' },
      { key: 'orderId', header: '伪核心列' }
    ])
    expect(cols[0].key).toBe('platform')
    expect(cols[cols.length - 1].key).toBe('itemId')
    expect(cols.filter((c) => c.key === 'itemId')).toHaveLength(1)
    expect(cols.filter((c) => c.key === 'orderId')).toHaveLength(1)
  })
})

describe('buildOrdersWorkbook', () => {
  it('表头 = 核心列中文名，行数 = 订单数，sheet 名「订单」', async () => {
    const wb = await loadWorkbook([makeOrder(1), makeOrder(2)])
    const sheet = wb.getWorksheet('订单')!
    expect(sheet.rowCount).toBe(3) // 表头 + 2 行
    const headers = sheet.getRow(1).values as unknown[]
    for (const col of CORE_EXPORT_COLUMNS) {
      expect(headers).toContain(col.header)
    }
  })

  it('决策 D-3：时间单元格为字符串而非日期序列号', async () => {
    const wb = await loadWorkbook([makeOrder(1)])
    const sheet = wb.getWorksheet('订单')!
    const headers = sheet.getRow(1).values as (string | undefined)[]
    const createdAtCol = headers.indexOf('下单时间')
    const cell = sheet.getRow(2).getCell(createdAtCol)
    expect(typeof cell.value).toBe('string')
    expect(cell.value).toBe('2026-10-01 12:00:00')
    expect(cell.numFmt).toBe('@')
  })

  it('扩展列：extra 值按列写出', async () => {
    const extended: ExportColumn[] = [
      { key: 'itemId', header: '商品ID' },
      { key: 'sellerId', header: '卖家ID' }
    ]
    const wb = await loadWorkbook([makeOrder(7)], extended)
    const sheet = wb.getWorksheet('订单')!
    const headers = sheet.getRow(1).values as (string | undefined)[]
    const itemCol = headers.indexOf('商品ID')
    expect(sheet.getRow(2).getCell(itemCol).value).toBe('I7')
  })

  it('>1000 单分批写入不丢行（性能/内存护栏）', async () => {
    const orders = Array.from({ length: 1001 }, (_, i) => makeOrder(i + 1))
    const wb = await loadWorkbook(orders)
    expect(wb.getWorksheet('订单')!.rowCount).toBe(1002)
  }, 30000)

  it('空字符串字段落为空单元，不产生 undefined', async () => {
    const o = emptyOrder('mock')
    o.orderId = 'X'
    const wb = await loadWorkbook([o])
    const sheet = wb.getWorksheet('订单')!
    const cell = sheet.getRow(2).getCell(2)
    expect([null, '', undefined]).toContain(cell.value as null | string | undefined)
  })
})

describe('工单 009：含图导出', () => {
  // 1x1 PNG
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )

  it('首列插入「商品图」、行高 80、图片写入工作簿 media', async () => {
    const o = makeOrder(1)
    o.imageUrl = 'https://img.example.com/a.jpg_220x10000Q90.jpg'
    const images = new Map([[o.imageUrl, { buffer: PNG_1X1, extension: 'png' as const }]])
    const wb = await loadWorkbookWithImages([o], [], images)
    const sheet = wb.getWorksheet('订单')!
    const headers = sheet.getRow(1).values as (string | undefined)[]
    expect(headers[1]).toBe('商品图')
    expect(sheet.getRow(2).height).toBe(80)
    // exceljs 将图片存于 model.media
    expect((wb.model as { media?: unknown[] }).media?.length ?? 0).toBeGreaterThan(0)
  })

  it('下载失败的图片不阻断，仅缺图行无 media 引用', async () => {
    const a = makeOrder(1)
    a.imageUrl = 'https://img.example.com/a.jpg'
    const b = makeOrder(2)
    b.imageUrl = 'https://img.example.com/b.jpg'
    const images = new Map([[a.imageUrl, { buffer: PNG_1X1, extension: 'png' as const }]])
    const wb = await loadWorkbookWithImages([a, b], [], images)
    const sheet = wb.getWorksheet('订单')!
    expect(sheet.rowCount).toBe(3)
    expect((wb.model as { media?: unknown[] }).media?.length).toBe(1)
  })
})

describe('导出文件水印：文档属性里的作者署名', () => {
  it('creator / lastModifiedBy 写入固定署名（分发出去能看出处）', async () => {
    const buf = await buildOrdersWorkbook([makeOrder(1)])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.creator).toBe(SIGNATURE)
    expect(wb.lastModifiedBy).toBe(SIGNATURE)
  })

  it('署名里不含本机用户名 / 路径（D-4 隐私要求）', async () => {
    const buf = await buildOrdersWorkbook([makeOrder(1)])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    // 元数据只能是固定字符串，不能带出运行环境
    expect(wb.creator).not.toMatch(/Lynn|Users|AppData|Desktop/i)
    expect(wb.creator).toContain('github.com/FaustDream/Reflow')
  })
})
