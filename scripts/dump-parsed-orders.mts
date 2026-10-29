/**
 * 用真实适配器解析各平台 fixture，把结果写成 JSON 供 Electron 脚本消费。
 * 运行：npx vite-node scripts/dump-parsed-orders.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { adapterRegistry, registerBuiltinAdapters } from '../src/main/platform/registry'
import type { CaptureReport } from '../src/shared/types'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, '.scratch')
mkdirSync(OUT, { recursive: true })

registerBuiltinAdapters(adapterRegistry)

const FIXTURES: Array<[string, string, string]> = [
  ['xianyu', 'xianyu-bought-list.json', 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/'],
  ['xianyu-sold', 'xianyu-sold-list.json', 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.sold.list/1.0/'],
  ['jd', 'jd-order-list.json', 'https://order.jd.com/center/list.action?page=1&__fetch__=1'],
  ['taobao', 'taobao-bought-list.json', 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2/1.0/'],
  ['ali1688', 'ali1688-order-list.json', 'https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/'],
  ['pdd', 'pdd-order-list.json', 'https://mobile.yangkeduo.com/proxy/api/api/order_list/v1'],
  ['dewu', 'dewu-order-list.json', 'https://app.dewu.com/api/v1/h5/order-interfaces/h5/order/buyerOrderList'],
  ['kuaishou', 'kuaishou-order-list.json', 'https://mp.kwaixiaodian.com/rest/app/trade/c/gmp/v1/ks/order/list'],
  ['eleme', 'eleme-order-list.json', 'https://waimai-guide.ele.me/h5/mtop.alsc.personal.queryorderlist/1.0/'],
  ['meituan', 'meituan-order-list.json', 'https://wx.waimai.meituan.com/api/order/list']
]

const parsed = FIXTURES.map(([id, file, url]) => {
  const adapter = adapterRegistry.get(id)!
  const body = JSON.parse(readFileSync(resolve(ROOT, 'testdata', file), 'utf-8'))
  const report: CaptureReport = { kind: 'xhr', url, method: 'POST', status: 200, body, ts: Date.now() }
  const { orders } = adapter.parse(report)
  return { id, orders }
})

writeFileSync(resolve(OUT, 'parsed-orders.json'), JSON.stringify(parsed, null, 1), 'utf-8')
console.log(
  '解析完成：',
  parsed.map((p) => `${p.id}:${p.orders.length}`).join(', '),
  '总计',
  parsed.reduce((n, p) => n + p.orders.length, 0)
)
