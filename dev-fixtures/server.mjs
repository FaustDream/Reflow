// 工单 004 自测用本地服务：提供自测页 + 三种请求形态的响应端点。
// 仅用于开发验证，不打包（electron-builder files 白名单不含 dev-fixtures/）。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT || 8731)

const ORDERS = {
  source: 'mock',
  data: {
    items: [
      { orderId: 'MOCK-0001', title: '自测订单一', price: '12.34' },
      { orderId: 'MOCK-0002', title: '自测订单二', price: '56.78' }
    ],
    nextPage: false,
    totalCount: '2'
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/api/orders.json') {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(ORDERS))
    return
  }

  if (url.pathname === '/jsonp.js') {
    const cb = url.searchParams.get('callback') || 'handleJsonp'
    res.setHeader('content-type', MIME['.js'])
    res.end(`${cb}(${JSON.stringify({ source: 'jsonp', items: ORDERS.data.items })})`)
    return
  }

  // 默认返回自测页
  const file = url.pathname === '/' ? 'hook-test.html' : url.pathname.replace(/^\/+/, '')
  try {
    const body = await readFile(join(here, file))
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`selftest server on http://127.0.0.1:${PORT}`)
})
