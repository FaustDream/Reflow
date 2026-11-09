/**
 * Web 调试桥（2026-11-07）：让渲染层跑在系统浏览器里，主进程照常在后台跑。
 *
 * 背景：日常开发 / 测试要反复开关 Electron 窗口，且 electron-vite build 会持续产出
 * out/ 产物。这里提供一条「网页 UI + 本地后台」的开发通道：
 *   - 主进程仍是最初的那个 Electron 进程（登录二维码窗口、Cookie 分区、MITM、
 *     页面 SDK 全部原样运行）——功能一致性的根基
 *   - 浏览器打开 vite dev server 的页面（同一份渲染层代码），window.api 由
 *     renderer 的 web-api.ts shim 提供，invoke 走 HTTP、事件推送走 SSE
 *
 * 实现要点（零新依赖，node:http + text/event-stream）：
 *   1. 包一层 ipcMain.handle，把各模块注册的 handler 记进注册表 —— 浏览器的
 *      invoke 请求直接调这些函数，不再经 IPC。必须在 traceIpc() 之后安装，
 *      这样 Electron 窗口内的 invoke 仍走留痕包装，互不干扰。
 *   2. 包一层 WebContents.prototype.send，把白名单频道的推送镜像给所有 SSE
 *      客户端 —— 主进程十几个 send 调用点一行都不用改。
 *   3. invoke 的 event 用隐藏主窗口的 webContents 充当 sender：
 *      export 含图进度按 sender.send 回推、导入导出的系统对话框挂在主窗口上，
 *      用真窗口才能保持这些行为不变。
 *
 * 启用方式：`npm run dev:web`（等价于 electron-vite dev -- --web，
 * 也可设环境变量 REFLOW_WEB_BRIDGE=1）。生产打包不含此通道。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { app, ipcMain, type BrowserWindow } from 'electron'

/** 桥端口：与 electron.vite.config.ts renderer.server.proxy 的目标保持一致 */
export const WEB_BRIDGE_PORT = 9478

/** 主进程 → 渲染层的推送频道白名单（与 preload/index.ts 的 on* 一一对应） */
const FORWARD_CHANNELS = new Set([
  'capture:report',
  'capture:error',
  'capture:deeplink-blocked',
  'orders:captured',
  'capture:parse-error',
  'platform:event',
  'export:image-progress',
  'orders:details-started',
  'orders:detail',
  'orders:detail-progress',
  'orders:details-completed',
  'orders:fetch-event',
  'orders:cache-updated',
  'login:status',
  'accounts:changed',
  'log:entry'
])

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
type SseClient = ServerResponse

const handlers = new Map<string, IpcHandler>()
const clients = new Set<SseClient>()

function sseWrite(client: SseClient, channel: string, payload: unknown): void {
  try {
    client.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
  } catch {
    clients.delete(client)
  }
}

/** 向所有已连接的浏览器广播一条主进程推送 */
function broadcast(channel: string, payload: unknown): void {
  if (clients.size === 0) return
  for (const client of clients) sseWrite(client, channel, payload)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * 安装桥接层。必须在任何 ipcMain.handle 之前调用（index.ts 顶层、traceIpc() 之后）。
 * Electron 的 WebContents 类不是运行时导出值，原型补丁借第一个创建的 webContents
 * 实例挂上（`web-contents-created` 早于任何窗口加载内容，推送不会漏）。
 */
export function installWebBridge(getMainWindow: () => BrowserWindow | null): void {
  // 1) 捕获 handler 注册表：包装 ipcMain.handle，注册原样透传（Electron 窗口照常用）
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ;(ipcMain as unknown as { handle: (channel: string, listener: IpcHandler) => void }).handle = (
    channel: string,
    listener: IpcHandler
  ) => {
    if (!handlers.has(channel)) handlers.set(channel, listener)
    return originalHandle(channel, listener)
  }

  // 2) 镜像推送：白名单频道的 webContents.send 同步发给浏览器。
  //    所有 webContents 共享同一个类原型，第一个实例出现时补一次即可。
  app.on('web-contents-created', (_event, wc) => {
    const proto = Object.getPrototypeOf(wc) as {
      send?: (channel: string, ...args: unknown[]) => void
      __reflowWebBridgePatched?: boolean
    }
    if (!proto || proto.__reflowWebBridgePatched || typeof proto.send !== 'function') return
    const originalSend = proto.send
    proto.__reflowWebBridgePatched = true
    proto.send = function (channel: string, ...args: unknown[]) {
      if (FORWARD_CHANNELS.has(channel)) broadcast(channel, args[0])
      return originalSend.call(this, channel, ...args)
    }
  })

  // 3) HTTP 服务器：invoke + SSE
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      })
      res.end()
      return
    }

    if (req.method === 'GET' && url === '/api/health') {
      json(res, 200, { ok: true, mode: 'web-bridge', handlers: handlers.size, clients: clients.size })
      return
    }

    // SSE 事件流：主进程推送的镜像通道
    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      })
      res.write(': connected\n\n')
      clients.add(res)
      // 25s 一条注释行保活，防代理/防火墙掐空闲连接
      const keepalive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* 断开时 clearInterval */
        }
      }, 25_000)
      req.on('close', () => {
        clearInterval(keepalive)
        clients.delete(res)
      })
      return
    }

    if (req.method === 'POST' && url === '/api/invoke') {
      void (async () => {
        let channel = ''
        let args: unknown[] = []
        try {
          const body = JSON.parse(await readBody(req)) as { channel?: string; args?: unknown[] }
          channel = String(body.channel ?? '')
          args = Array.isArray(body.args) ? body.args : []
        } catch {
          json(res, 400, { ok: false, message: '请求体不是合法 JSON' })
          return
        }

        const handler = handlers.get(channel)
        if (!handler) {
          json(res, 404, { ok: false, message: `频道未注册: ${channel}` })
          return
        }

        // sender 用隐藏主窗口的 webContents：对话框挂主窗口、进度按 sender 回推
        const win = getMainWindow()
        const sender = win && !win.isDestroyed() ? win.webContents : null
        const fakeEvent = {
          sender,
          senderId: sender?.id ?? -1,
          processId: process.pid,
          frame: sender?.mainFrame,
          reply: () => undefined
        }
        try {
          const result = await handler(fakeEvent, ...args)
          json(res, 200, { ok: true, result: result ?? null })
        } catch (e) {
          // 与 Electron invoke 的错误语义对齐：错误以字符串消息到达渲染层
          json(res, 200, {
            ok: false,
            message: e instanceof Error ? e.message : String(e)
          })
        }
      })()
      return
    }

    json(res, 404, { ok: false, message: `未知路径: ${url}` })
  })

  server.on('error', (err) => {
    console.error(`[web-bridge] 服务器异常: ${err.message}`)
  })
  server.listen(WEB_BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[web-bridge] http://127.0.0.1:${WEB_BRIDGE_PORT}  （invoke=POST /api/invoke，推送=GET /api/events）`)
  })
}
