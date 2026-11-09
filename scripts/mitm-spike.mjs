#!/usr/bin/env node
/**
 * MITM 抓取通道 —— 可行性验证（spike，尚未接进应用）。
 *
 * 目的：证明「本地 TLS 代理 + 自签证书 → 能读到平台订单接口的明文」这条路在本机可行，
 * 并且把风险点（装证书、改系统代理）拆成**显式开关**，默认什么都不动。
 *
 * 用法：
 *   node scripts/mitm-spike.mjs --self-test          # 只在本机起代理 + 用 curl 走一次，不动系统设置
 *   node scripts/mitm-spike.mjs --install --yes      # 装根证书到「当前用户」+ 设 HKCU 系统代理
 *   node scripts/mitm-spike.mjs --run                # 起代理并打印命中的订单接口（配合 --install 用）
 *   node scripts/mitm-spike.mjs --restore            # 还原：删证书 + 关代理（务必执行）
 *
 * 安全边界（与 docs/033 一致）：
 *   - 只对白名单订单域名做 TLS 解密，其它域名一律 CONNECT 隧道透传，不解密不记录
 *   - 只打印 URL 与响应长度，不落盘 Cookie / 请求头 / 响应原文
 *   - 证书只装在「当前用户」存储（certutil -user，不需要管理员，也不需要 UAC）
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as createTlsServer } from 'node:tls'

const WORK = join(tmpdir(), 'reflow-mitm-spike')
const PORT = 8899
const CA_CRT = join(WORK, 'ca.crt')
const CA_KEY = join(WORK, 'ca.key')
const LEAF_CRT = join(WORK, 'leaf.crt')
const LEAF_KEY = join(WORK, 'leaf.key')

/** 需要解密的订单域名（其余一律隧道透传） */
const WHITELIST = [
  'order.jd.com',
  'api.m.jd.com',
  'h5api.m.goofish.com',
  'h5api.m.taobao.com',
  'mtop.1688.com',
  'mobile.yangkeduo.com',
  'app.dewu.com',
  'open.kwaixiaodian.com',
  'waimai-guide.ele.me',
  'wx.waimai.meituan.com'
]

/** 命中的订单接口特征（只用于打印，不参与解密决策） */
const ORDER_HINTS = [
  'order', 'trade', 'mtop.', 'list', 'detail', 'bought', 'sold',
  'pcorder_center_list', 'dataline', 'purchase'
]

const args = new Set(process.argv.slice(2))
const has = (flag) => args.has(flag)

// ---------------------------------------------------------------------------
// 1. 证书：openssl 生成 CA + 覆盖白名单域名的叶子证书
// ---------------------------------------------------------------------------
function ensureCerts() {
  mkdirSync(WORK, { recursive: true })
  if (!existsSync(CA_CRT) || !existsSync(LEAF_CRT)) {
    console.log('[cert] 生成 CA 与叶子证书…')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', CA_KEY, '-out', CA_CRT, '-days', '365',
      '-subj', '/CN=Reflow Local MITM CA/O=Reflow (local only)'
    ], { stdio: 'ignore' })

    const ext = join(WORK, 'leaf.ext')
    writeFileSync(ext, [
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${WHITELIST.map((h) => `DNS:${h}`).join(',')}`
    ].join('\n'))

    execFileSync('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', LEAF_KEY, '-out', join(WORK, 'leaf.csr'),
      '-subj', '/CN=reflow-mitm'
    ], { stdio: 'ignore' })
    execFileSync('openssl', [
      'x509', '-req', '-in', join(WORK, 'leaf.csr'),
      '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
      '-out', LEAF_CRT, '-days', '365', '-extfile', ext
    ], { stdio: 'ignore' })
  }
  console.log(`[cert] CA: ${CA_CRT}`)
  console.log(`[cert] 覆盖域名: ${WHITELIST.length} 个（${WHITELIST.slice(0, 3).join(', ')} …）`)
}

// ---------------------------------------------------------------------------
// 2. 代理：CONNECT → 白名单解密 / 其它隧道
// ---------------------------------------------------------------------------
const hits = []

function isWhitelisted(host) {
  return WHITELIST.some((h) => host === h || host.endsWith(`.${h}`))
}

function shouldLog(url) {
  const lower = url.toLowerCase()
  return ORDER_HINTS.some((k) => lower.includes(k))
}

function startProxy() {
  const tlsServer = createTlsServer({
    key: readFileSync(LEAF_KEY),
    cert: readFileSync(LEAF_CRT)
  })

  // 解密后的 HTTP 请求：转发到真实站点，并记录命中的接口
  const inner = createHttpServer((req, res) => {
    const host = req.headers.host?.split(':')[0] ?? ''
    const target = `https://${host}${req.url}`
    if (shouldLog(req.url ?? '')) {
      hits.push(target)
      console.log(`[hit] ${req.method} ${target}`)
    }
    const upstream = httpsRequest(
      {
        host,
        port: 443,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host },
        servername: host
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${e.message}`)
    })
    req.pipe(upstream)
  })

  tlsServer.on('secureConnection', (socket) => {
    inner.emit('connection', socket)
  })

  const proxy = createNetServer((socket) => {
    socket.once('data', (chunk) => {
      const text = chunk.toString('latin1')
      const [firstLine] = text.split('\r\n')
      const [method, target] = firstLine.split(' ')
      if (method !== 'CONNECT') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      const host = target.split(':')[0]
      if (!isWhitelisted(host)) {
        // 非白名单：隧道透传（不解密、不记录）
        const upstream = netConnect(443, host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        return
      }
      console.log(`[tls] 解密 ${host}`)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      tlsServer.emit('connection', socket)
    })
    socket.on('error', () => socket.destroy())
  })

  proxy.listen(PORT, '127.0.0.1', () => {
    console.log(`[proxy] 监听 127.0.0.1:${PORT}（白名单 ${WHITELIST.length} 个域名解密，其余隧道）`)
  })
  return proxy
}

// ---------------------------------------------------------------------------
// 3. 系统设置：装证书 / 设代理 / 还原
// ---------------------------------------------------------------------------
function install() {
  if (!has('--yes')) {
    console.log('\n以下命令会改动本机设置，确认后加 --yes 执行：')
    console.log(`  certutil -addstore -user Root "${CA_CRT}"`)
    console.log('  reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f')
    console.log(`  reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d 127.0.0.1:${PORT} /f`)
    return
  }
  // -user 只装进当前用户存储：不需要管理员，也不需要 UAC
  execFileSync('certutil', ['-addstore', '-user', 'Root', CA_CRT], { stdio: 'inherit' })
  execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'], { stdio: 'ignore' })
  execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${PORT}`, '/f'], { stdio: 'ignore' })
  console.log('[install] 证书已装入「当前用户/受信任的根证书颁发机构」，系统代理已指向本机')
  console.log('[install] 还原请执行：node scripts/mitm-spike.mjs --restore')
}

function restore() {
  try {
    execFileSync('certutil', ['-delstore', '-user', 'Root', 'Reflow Local MITM CA'], { stdio: 'inherit' })
  } catch {
    console.log('[restore] 证书未找到（可能已删除）')
  }
  try {
    execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'ignore' })
    console.log('[restore] 系统代理已关闭')
  } catch (e) {
    console.log('[restore] 关闭代理失败:', e.message)
  }
}

// ---------------------------------------------------------------------------
// 4. 自测：起代理 + 用 curl 走一次（不装证书、不改系统设置）
// ---------------------------------------------------------------------------
function selfTest() {
  const url = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'https://order.jd.com/center/list.action'
  console.log(`[self-test] 用 curl 经代理访问 ${url}（--cacert 临时信任，不改系统）`)
  const out = spawn('curl', [
    '-sS', '-o', join(WORK, 'body.bin'), '-w', 'HTTP %{http_code} in %{time_total}s',
    '--proxy', `http://127.0.0.1:${PORT}`,
    '--cacert', CA_CRT,
    '--ssl-no-revoke',
    '--max-time', '20',
    url
  ], { stdio: 'inherit' })
  out.on('exit', (code) => {
    console.log(`\n[self-test] curl 退出码 ${code}；命中订单特征接口 ${hits.length} 个`)
    for (const h of hits) console.log('  -', h)
    console.log('[self-test] 结论：' + (hits.length
      ? 'TLS 解密链路可用（能看到明文接口）'
      : '链路通了但没命中订单特征（可能被重定向到登录页，属正常）'))
    proxy.close()
    setTimeout(() => process.exit(0), 200)
  })
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
if (has('--restore')) {
  restore()
  process.exit(0)
}

ensureCerts()

if (has('--install')) {
  install()
  process.exit(0)
}

const proxy = startProxy()

if (has('--self-test')) {
  selfTest()
} else {
  console.log('[run] 代理运行中。请另开终端执行 --install（或手动把系统代理指到 127.0.0.1:' + PORT + '）')
  console.log('[run] Ctrl+C 退出（退出前请务必执行 --restore）')
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[exit] 关闭代理（系统代理/证书请用 --restore 还原）')
    proxy.close()
    process.exit(0)
  })
}
