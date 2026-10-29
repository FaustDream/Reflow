/**
 * 本地 TLS 代理（MITM 通道的抓取侧）。
 *
 * 流程：
 *   Chromium 走系统代理 → CONNECT host:443
 *     ├─ 白名单域名 → 用内置叶子证书与客户端握手（解密）→ 解析 HTTP → 转发上游 → 抓响应
 *     └─ 其它域名   → 纯 TCP 隧道（不解密、不记录）
 *
 * 只做「观察」：请求原样转发，不修改、不重放（红线 2）。
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { connect as tlsConnect, createServer as createTlsServer, type Server as TlsServer } from 'node:tls'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { loadCerts, type MitmCerts } from './certs'
import { MAX_CAPTURE_BYTES, isMitmHost, parseBody, shouldCapture } from './whitelist'

export interface MitmCapture {
  url: string
  method: string
  /** 已解析的响应体（JSON 对象 / JSONP 剥壳 / 原始字符串） */
  body: unknown
  status: number
  ts: number
}

export interface MitmProxyOptions {
  port: number
  onCapture: (capture: MitmCapture) => void
  /** 诊断用日志（只含域名与 URL，不含内容） */
  onLog?: (message: string) => void
}

/** 解压响应体（上游可能无视 accept-encoding: identity 仍然压缩） */
function decodeBody(buffer: Buffer, encoding: string | undefined): string {
  const enc = (encoding ?? '').toLowerCase()
  try {
    if (enc.includes('br')) return brotliDecompressSync(buffer).toString('utf-8')
    if (enc.includes('gzip')) return gunzipSync(buffer).toString('utf-8')
    if (enc.includes('deflate')) return inflateSync(buffer).toString('utf-8')
  } catch {
    /* 解压失败就按原文处理 */
  }
  return buffer.toString('utf-8')
}

export class MitmProxy {
  private proxy: NetServer | null = null
  private inner: HttpServer | null = null
  private tls: TlsServer | null = null
  private certs: MitmCerts | null = null
  private captured = 0
  private intercepted = 0

  constructor(private readonly options: MitmProxyOptions) {}

  get running(): boolean {
    return this.proxy !== null
  }

  get stats(): { captured: number; intercepted: number } {
    return { captured: this.captured, intercepted: this.intercepted }
  }

  start(): void {
    if (this.proxy) return
    this.certs = loadCerts()
    const log = (msg: string): void => this.options.onLog?.(msg)

    // 解密后的 HTTP 请求 → 转发上游 + 抓响应
    this.inner = createHttpServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0]
      if (!host) {
        res.writeHead(400).end()
        return
      }
      const url = `https://${host}${req.url ?? '/'}`
      // 让上游返回未压缩内容，便于直接解析；顺带去掉代理专用头
      const headers: Record<string, unknown> = { ...req.headers, host }
      delete headers['accept-encoding']
      delete headers['proxy-connection']

      const upstream = httpsRequest(
        {
          host,
          port: 443,
          path: req.url,
          method: req.method,
          headers: headers as Record<string, string>,
          servername: host
        },
        (up) => {
          const chunks: Buffer[] = []
          let size = 0
          let overflow = false
          up.on('data', (chunk: Buffer) => {
            if (overflow) return
            size += chunk.length
            if (size > MAX_CAPTURE_BYTES) {
              overflow = true
              chunks.length = 0
              return
            }
            chunks.push(chunk)
          })
          up.on('end', () => {
            if (overflow) return
            const type = String(up.headers['content-type'] ?? '')
            if (!shouldCapture(url, type)) return
            const text = decodeBody(Buffer.concat(chunks), up.headers['content-encoding'] as string | undefined)
            const body = parseBody(text)
            this.captured++
            this.options.onCapture({
              url,
              method: req.method ?? 'GET',
              body,
              status: up.statusCode ?? 0,
              ts: Date.now()
            })
          })
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        }
      )
      upstream.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`upstream error: ${e.message}`)
      })
      req.pipe(upstream)
    })

    // WebSocket 等 Upgrade：解密后按字节转发（不抓内容）
    this.inner.on('upgrade', (req, socket: Socket, head: Buffer) => {
      const host = (req.headers.host ?? '').split(':')[0]
      if (!host) return socket.destroy()
      const up = tlsConnect({ host, port: 443, servername: host }, () => {
        const raw = [`${req.method} ${req.url} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          raw.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        up.write(raw.join('\r\n') + '\r\n\r\n')
        if (head?.length) up.write(head)
        socket.pipe(up)
        up.pipe(socket)
      })
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
    })

    this.tls = createTlsServer(
      { key: this.certs.key, cert: this.certs.cert },
      (socket) => this.inner?.emit('connection', socket)
    )

    this.proxy = createNetServer((socket) => {
      socket.once('data', (chunk) => {
        const firstLine = chunk.toString('latin1').split('\r\n')[0]
        const [method, target] = firstLine.split(' ')
        if (method !== 'CONNECT') {
          socket.destroy()
          return
        }
        const host = target.split(':')[0]
        if (!isMitmHost(host)) {
          // 非白名单：纯隧道，不解密不记录
          const upstream = netConnect(443, host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            upstream.pipe(socket)
            socket.pipe(upstream)
          })
          upstream.on('error', () => socket.destroy())
          socket.on('error', () => upstream.destroy())
          return
        }
        this.intercepted++
        log(`解密 ${host}`)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        this.tls?.emit('connection', socket)
      })
      socket.on('error', () => socket.destroy())
    })

    this.proxy.listen(this.options.port, '127.0.0.1', () => {
      log(`MITM 代理已启动 127.0.0.1:${this.options.port}`)
    })
  }

  stop(): void {
    this.proxy?.close()
    this.proxy = null
    this.inner?.close()
    this.inner = null
    this.tls?.close()
    this.tls = null
  }
}
