/**
 * 手工验收脚本：用真实 fixture 走完整导出路径，落一个 xlsx 到临时目录并打印逐平台内容。
 * 运行：npx vite-node scripts/export-demo.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  adapterRegistry,
  registerBuiltinAdapters
} from '../src/main/platform/registry'
import { buildOrdersWorkbook, resolveExportColumns } from '../src/main/export/excel'
import type { CaptureReport, Order } from '../src/shared/types'
import type { ExportColumn } from '../src/shared/types'

const ROOT = resolve(import.meta.dirname, '..')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, 'testdata', name), 'utf-8'))
}

function report(url: string, body: unknown): CaptureReport {
  return { kind: 'xhr', url, method: 'POST', status: 200, body, ts: Date.now() }
}

registerBuiltinAdapters(adapterRegistry)

const sources: Array<{ id: string; url: string; fixture: string }> = [
  { id: 'xianyu', url: 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list', fixture: 'xianyu-bought-list.json' },
  { id: 'xianyu-sold', url: 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.sold.list', fixture: 'xianyu-sold-list.json' },
  { id: 'jd', url: 'https://order.jd.com/center/list.action?page=1&__fetch__=1', fixture: 'jd-order-list.json' },
  { id: 'taobao', url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2/1.0/', fixture: 'taobao-bought-list.json' },
  { id: 'ali1688', url: 'https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/', fixture: 'ali1688-order-list.json' },
  { id: 'pdd', url: 'https://mobile.yangkeduo.com/proxy/api/api/order_list/v1?page=1', fixture: 'pdd-order-list.json' },
  { id: 'dewu', url: 'https://app.dewu.com/api/v1/h5/order-interfaces/h5/order/buyerOrderList', fixture: 'dewu-order-list.json' },
  { id: 'kuaishou', url: 'https://mp.kwaixiaodian.com/rest/app/trade/c/gmp/v1/ks/order/list', fixture: 'kuaishou-order-list.json' },
  { id: 'eleme', url: 'https://waimai-guide.ele.me/h5/mtop.alsc.personal.queryorderlist/1.0/', fixture: 'eleme-order-list.json' },
  { id: 'meituan', url: 'https://wx.waimai.meituan.com/api/order/list', fixture: 'meituan-order-list.json' }
]

const all: Order[] = []
const perPlatform: Record<string, number> = {}
for (const src of sources) {
  const adapter = adapterRegistry.get(src.id)
  if (!adapter) throw new Error(`适配器未注册：${src.id}`)
  const { orders } = adapter.parse(report(src.url, fixture(src.fixture)))
  perPlatform[src.id] = orders.length
  all.push(...orders)
}

const platformIds = [...new Set(all.map((o) => o.platform))]
const extended: ExportColumn[] = platformIds.flatMap((id) => {
  const a = adapterRegistry.get(id)!
  return a.columns.map((c) => ({ ...c, platformId: id, platformName: a.displayName }))
})

const cols = resolveExportColumns(extended)
const buffer = await buildOrdersWorkbook(all, extended)

const outDir = resolve(ROOT, '.scratch')
mkdirSync(outDir, { recursive: true })
const outFile = resolve(outDir, 'reflow-export-demo.xlsx')
writeFileSync(outFile, buffer)

console.log('各平台解析订单数：', perPlatform)
console.log('合计订单：', all.length)
console.log('平台数：', platformIds.length, platformIds.join(', '))
console.log('导出列数：', cols.length, `（核心 ${19} + 扩展 ${cols.length - 19}）`)
console.log('文件：', outFile, `${(buffer.length / 1024).toFixed(1)} KB`)

// 抽样检查：每平台首单的关键字段
const headers = cols.map((c) => c.header)
console.log('\n表头：')
console.log(headers.join(' | '))
console.log('\n抽样（每平台首单核心字段）：')
for (const id of platformIds) {
  const o = all.find((x) => x.platform === id)!
  console.log(
    `- ${id.padEnd(12)} 单号=${o.orderId || '(空)'} 时间=${o.createdAt ?? '(空)'} 金额=${o.paidAmount || '(空)'} 标题=${o.title.slice(0, 20) || '(空)'}`
  )
}
