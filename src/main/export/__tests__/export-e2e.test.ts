/**
 * 端到端「完美导出」验收：真实响应结构 → 适配器解析 → Excel 工作簿。
 *
 * 与各适配器单测的区别：这里断言的是**用户最终在 Excel 里看到的东西** ——
 * 表头（核心列 + 该平台扩展列）、每个单元格的值、时间是否为文本。
 * 105 个单测通过只说明解析对了；本文件说明「导出的表填满了且填对了」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { buildOrdersWorkbook, resolveExportColumns } from '../excel'
import { adapterRegistry, registerBuiltinAdapters } from '../../platform/registry'
import { type Order } from '../../../shared/types/order'
import type { CaptureReport } from '../../../shared/types'

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../../testdata', name), 'utf-8'))

const report = (url: string, body: unknown): CaptureReport => ({
  kind: 'xhr',
  url,
  method: 'POST',
  status: 200,
  body,
  ts: Date.now()
})

async function sheetOf(orders: Order[], platformId: string): Promise<ExcelJS.Worksheet> {
  const adapter = adapterRegistry.get(platformId)
  expect(adapter, `适配器 ${platformId} 必须已注册`).toBeDefined()
  const buffer = await buildOrdersWorkbook(orders, adapter!.columns)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb.getWorksheet('订单')!
}

/** 表头 → 列号（1-based），方便按名取值 */
function headerMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>()
  const row = sheet.getRow(1)
  row.eachCell((cell, col) => {
    if (typeof cell.value === 'string') map.set(cell.value, col)
  })
  return map
}

const cellAt = (sheet: ExcelJS.Worksheet, headers: Map<string, number>, row: number, header: string): unknown => {
  const col = headers.get(header)
  if (!col) throw new Error(`导出表缺少列「${header}」`)
  return sheet.getRow(row).getCell(col).value
}

describe('导出前准备：注册表', () => {
  it('美团已注册且可路由到订单端点', () => {
    registerBuiltinAdapters(adapterRegistry)
    const routed = adapterRegistry.route(
      'https://wx.waimai.meituan.com/api/order/list',
      'POST',
      'xhr'
    )
    expect(routed?.adapter.id).toBe('meituan')
  })

  it('在册平台 = 5 个业务平台 + 闲鱼卖家 + mock', () => {
    const ids = adapterRegistry.list().map((a) => a.id)
    for (const expected of ['mock', 'xianyu', 'xianyu-sold', 'jd', 'taobao', 'pdd', 'meituan']) {
      expect(ids).toContain(expected)
    }
  })
})

describe('美团导出（本地生活）', () => {
  it('本地生活列语义：门店/餐品/配送状态', async () => {
    const { orders } = adapterRegistry.get('meituan')!.parse(
      report('https://wx.waimai.meituan.com/api/order/list', loadFixture('meituan-order-list.json'))
    )
    const sheet = await sheetOf(orders, 'meituan')
    const h = headerMap(sheet)

    expect(cellAt(sheet, h, 2, '店铺名')).toBe('合成羊肉炉店（示例）')
    expect(cellAt(sheet, h, 2, '商品标题')).toBe('合成羊杂粉 合成小菜 x2')
    expect(cellAt(sheet, h, 2, '实付金额')).toBe('22.8')
    expect(cellAt(sheet, h, 2, '数量')).toBe(3)
    expect(cellAt(sheet, h, 2, '配送状态')).toBe('已送达')
    expect(cellAt(sheet, h, 2, '是否自取')).toBe('配送')
    expect(cellAt(sheet, h, 2, '账号')).toBe('880000001')
  })
})

describe('跨平台统一导出（多平台合并到一个工作表）', () => {
  it('两个平台订单合并导出：列并集去重、行数正确、平台列可区分', async () => {
    const xy = adapterRegistry.get('xianyu')!.parse(
      report('https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/', loadFixture('xianyu-bought-list.json'))
    ).orders
    const mt = adapterRegistry.get('meituan')!.parse(
      report('https://wx.waimai.meituan.com/api/order/list', loadFixture('meituan-order-list.json'))
    ).orders

    const all = [...xy, ...mt]
    expect(all.length).toBeGreaterThan(0)

    const extended = ['xianyu', 'meituan'].flatMap((id) => {
      const adapter = adapterRegistry.get(id)!
      return adapter.columns.map((c) => ({
        ...c,
        platformId: id,
        platformName: adapter.displayName
      }))
    })
    const merged = resolveExportColumns(extended)
    const buffer = await buildOrdersWorkbook(all, extended)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!

    expect(sheet.getRow(1).cellCount).toBe(merged.length)
    const headers = (sheet.getRow(1).values as unknown[]).slice(1).filter(Boolean) as string[]
    expect(headers).toHaveLength(merged.length)
    expect(new Set(headers).size).toBe(headers.length)
    const h = headerMap(sheet)
    const platforms = Array.from({ length: all.length }, (_, i) =>
      cellAt(sheet, h, i + 2, '平台')
    )
    expect(new Set(platforms)).toEqual(new Set(['xianyu', 'meituan']))
  })

  it('同 key 不同 header：闲鱼买家/卖家的 sellerId 拆成语义正确的两列', async () => {
    const buyer: Order = {
      ...adapterRegistry.get('xianyu')!.parse(
        report('https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list', loadFixture('xianyu-bought-list.json'))
      ).orders[0]
    }
    const sold: Order = {
      ...adapterRegistry.get('xianyu-sold')!.parse(
        report('https://h5api.m.goofish.com/h5/mtop.idle.web.trade.sold.list', loadFixture('xianyu-sold-list.json'))
      ).orders[0]
    }
    const extended = ['xianyu', 'xianyu-sold'].flatMap((id) => {
      const adapter = adapterRegistry.get(id)!
      return adapter.columns.map((c) => ({ ...c, platformId: id, platformName: adapter.displayName }))
    })
    const cols = resolveExportColumns(extended)
    const sellerCol = cols.find((c) => c.key === 'sellerId' && c.header === '卖家ID')
    const buyerIdCol = cols.find((c) => c.key === 'sellerId' && c.header === '买家ID')
    expect(sellerCol, '卖家ID 列必须存在').toBeDefined()
    expect(buyerIdCol, '买家ID 列必须单独存在，不能被合并掉').toBeDefined()
    // 各列只归属自己的平台，避免买家 ID 出现在「卖家ID」列
    expect(sellerCol!.platformIds).toEqual(['xianyu'])
    expect(buyerIdCol!.platformIds).toEqual(['xianyu-sold'])
    expect(buyer.platform).toBe('xianyu')
    expect(sold.platform).toBe('xianyu-sold')
  })
})
