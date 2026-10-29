/**
 * 工单 005：mock 平台本地服务 —— 扮演「电商平台」，零账号依赖地演示捕获管道。
 *
 *   node dev-fixtures/mock-platform/server.mjs
 *   → http://127.0.0.1:8931/   （端口与 src/shared/mock-platform.ts 一致）
 *
 * 三个端点返回**同一批订单**（同 orderId），用于验证引擎去重：
 *   /api/orders-xhr?page=N      JSON（页面用 XMLHttpRequest 发起）
 *   /api/orders-fetch?page=N    JSON（页面用 fetch 发起）
 *   /api/orders-jsonp?callback=cb   JS 脚本（页面动态 <script> 注入，JSONP）
 *
 * 决策 D-2 演示点：所有请求都由页面自身发起，注入脚本只「观察」，不构造请求。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 8931

const now = () => new Date().toISOString()

/** 同一批订单 —— 三种形态返回相同 orderId，验证去重只保留一条 */
const payload = (source) => ({
  orders: [
    {
      orderId: 'MOCK-2026-001',
      title: '雪平锅 18cm 加厚不锈钢',
      paidAmount: '59.90',
      unitPrice: '59.90',
      quantity: 1,
      status: '已发货',
      createdAt: '2026-10-01 10:00:00',
      shopName: 'mock 旗舰店',
      mockRemark: `来自 ${source}`
    },
    {
      orderId: 'MOCK-2026-002',
      title: '硅胶铲 不粘耐高温',
      paidAmount: '25.00',
      unitPrice: '12.50',
      quantity: 2,
      status: '待发货',
      createdAt: '2026-10-02 11:30:00',
      shopName: 'mock 旗舰店',
      mockRemark: `来自 ${source}`
    },
    {
      orderId: 'MOCK-2026-003',
      title: '日式陶瓷碗 四件套',
      paidAmount: '88.00',
      unitPrice: '88.00',
      quantity: 1,
      status: '已完成',
      createdAt: 1759461330000,
      shopName: 'mock 分店',
      mockRemark: `来自 ${source}`
    }
  ],
  account: { userId: 'mock-user-1', nickname: '测试买家' },
  pageInfo: { hasMore: false, totalCount: 3 }
})

const json = (res, body, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  console.log(`[mock-platform] ${now()} ${req.method} ${url.pathname}${url.search}`)

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(readFileSync(join(__dirname, 'index.html')))
    return
  }

  if (url.pathname === '/api/orders-xhr' || url.pathname === '/api/orders-fetch') {
    json(res, payload(url.pathname.endsWith('xhr') ? 'XHR' : 'fetch'))
    return
  }

  if (url.pathname === '/api/orders-jsonp') {
    const cb = url.searchParams.get('callback') ?? '__reflowMockCb'
    // 只允许合法标识符作为回调名，防意外注入
    if (!/^[A-Za-z_$][\w$.]*$/.test(cb)) {
      json(res, { error: '非法 callback' }, 400)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(`${cb}(${JSON.stringify(payload('JSONP'))})`)
    return
  }

  json(res, { error: 'not found' }, 404)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-platform] http://127.0.0.1:${PORT}/ 已就绪（Ctrl+C 停止）`)
})
