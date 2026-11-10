/**
 * 工单 034：MITM 抓取通道（设置 + 生命周期 + IPC）。
 *
 * 与 WebView 注入通道的关系：
 *   - 注入通道：每个平台页面挂 preload，拦页面自己发的请求（默认，始终可用）
 *   - MITM 通道：改系统代理 + 装根证书，解密订单域名流量（可选，需显式开启）
 *   两者最终都进 `capture-engine`（见 capture-bridge 的 feedExternalCapture），
 *   所以适配器、去重、导出全部复用，不需要第二套解析。
 *
 * 安全边界（工单 033 §4）：只解密白名单域名、只观察不改写、退出必还原、崩溃兜底。
 */
import { app, ipcMain, session } from 'electron'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { adapterRegistry } from '../platform/registry'
import { feedExternalCapture } from '../capture-bridge'
import { MitmProxy } from './proxy'
import {
  applyProxy,
  installCert,
  isCertInstalled,
  loadState,
  mitmSupported,
  readProxy,
  recoverIfNeeded,
  removeCert,
  restoreProxy,
  saveState
} from './system'
import { MITM_HOSTS } from './whitelist'
import { caCertPath, ensureMitmCerts } from './cert-gen'

import type { MitmResult, MitmStatus } from '../../shared/types'

export type { MitmResult, MitmStatus }

/** 开启/关闭时同步应用自身各 session 的代理（不等系统代理生效） */
function setSessionProxy(port: number | null): void {
  const rules =
    port === null
      ? null
      : { proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`, proxyBypassRules: '<local>' }

  const apply = (s: Electron.Session): void => {
    void s.setProxy(rules ?? { mode: 'system' }).catch(() => undefined)
  }

  apply(session.defaultSession)
  for (const adapter of adapterRegistry.list()) {
    apply(session.fromPartition(adapter.partition ?? `persist:platform-${adapter.id}`))
  }
}

/**
 * 通道自测：临时起一个代理，用「自己当客户端」的方式走一遍
 * CONNECT → TLS（信任内置 CA）→ GET，验证解密与转发链路。
 *
 * 不碰系统代理、不装证书 —— 所以可以随时点，适合排查「开了但抓不到」。
 */
function probeThroughProxy(
  port: number,
  host: string,
  path: string
): Promise<{ ok: boolean; status?: number; message?: string }> {
  // 上游不响应（网络不通/对端风控）时不能让自测按钮永久 busy
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, message: '自测超时（15s）' }), 15_000)
    const done = (r: { ok: boolean; status?: number; message?: string }): void => {
      clearTimeout(timer)
      resolve(r)
    }
    const req = httpRequest({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        done({ ok: false, message: `CONNECT 返回 ${res.statusCode}` })
        return
      }
      const tls = tlsConnect({ socket, servername: host, ca: readFileSync(caCertPath()) }, () => {
        tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      tls.on('data', (chunk: Buffer) => {
        if (data.length < 2048) data += chunk.toString('latin1')
      })
      tls.on('end', () => {
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0)
        done({ ok: true, status })
      })
      tls.on('error', (e) => done({ ok: false, message: e.message }))
    })
    req.on('error', (e) => done({ ok: false, message: e.message }))
    req.end()
  })
}

export function setupMitmIpc(): { shutdown: () => void } {
  let proxy: MitmProxy | null = null
  let lastError = ''
  const state = loadState()
  const recovered = recoverIfNeeded()
  if (recovered) {
    lastError = '上次退出未还原系统代理，已自动还原'
    setSessionProxy(null)
  }

  // MITM 开启期间新建的 session（如新账号分区）也走代理
  app.on('session-created', (created) => {
    if (!proxy) return
    void created
      .setProxy({
        proxyRules: `http=127.0.0.1:${state.port};https=127.0.0.1:${state.port}`,
        proxyBypassRules: '<local>'
      })
      .catch(() => undefined)
  })

  const status = async (): Promise<MitmStatus> => ({
    running: proxy?.running ?? false,
    port: state.port,
    supported: mitmSupported(),
    certInstalled: await isCertInstalled(),
    systemProxy: (() => {
      const p = readProxy()
      return { enabled: p.enabled, server: p.server }
    })(),
    whitelist: [...MITM_HOSTS],
    stats: proxy?.stats ?? { captured: 0, intercepted: 0 },
    lastError,
    recovered
  })

  function stopAndRestore(): void {
    proxy?.stop()
    proxy = null
    const current = loadState()
    try {
      restoreProxy(current.snapshot)
    } catch (e) {
      lastError = `还原系统代理失败：${e instanceof Error ? e.message : String(e)}`
    }
    saveState({ ...current, enabled: false })
    setSessionProxy(null)
  }

  ipcMain.handle('mitm:status', async () => status())

  /**
   * macOS / Linux：系统代理与根证书安装需要提权，与「不要管理员权限」的约束冲突，
   * 直接返回不支持。默认的 WebView 注入通道不受影响。
   */
  const unsupported = (): MitmResult => ({
    ok: false,
    reason: 'unsupported',
    message:
      '当前平台不支持 MITM 通道（系统代理与根证书安装仅 Windows 实现）。' +
      'WebView 注入通道不受影响，抓取与导出照常可用。'
  })

  ipcMain.handle('mitm:install-cert', async (): Promise<MitmResult> => {
    if (!mitmSupported()) return unsupported()
    try {
      // 先确保证书存在（按机器随机生成），再装进当前用户 Root 库
      await ensureMitmCerts()
      await installCert(caCertPath())
      return { ok: true, message: '根证书已安装（按机器随机生成，仅本机有效）' }
    } catch (e) {
      return { ok: false, reason: 'cert-install-failed', message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('mitm:remove-cert', async (): Promise<MitmResult> => {
    await removeCert()
    return { ok: true }
  })

  ipcMain.handle('mitm:enable', async (): Promise<MitmResult> => {
    if (proxy) return { ok: true }
    if (!mitmSupported()) return unsupported()
    // 证书按机器随机生成（已有且未过期/SAN 未变化则复用）；失败以 start-failed 返回
    try {
      await ensureMitmCerts()
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: 'cert-gen-failed', message: lastError }
    }
    if (!(await isCertInstalled())) {
      return { ok: false, reason: 'cert-missing', message: '请先安装根证书（只需一次）' }
    }
    // 端口被占（EADDRINUSE）等绑定错误经 start() 的 promise 到达这里，
    // 以 start-failed 返回给界面，而不是 uncaughtException 崩掉主进程。
    let instance: MitmProxy | null = null
    try {
      const snapshot = readProxy()
      instance = new MitmProxy({
        port: state.port,
        onCapture: (capture) => {
          feedExternalCapture({
            url: capture.url,
            method: capture.method,
            status: capture.status,
            body: capture.body,
            kind: 'fetch',
            ts: capture.ts
          })
        },
        onLog: (message) => {
          lastError = message
        }
      })
      await instance.start()
      proxy = instance
      /**
       * 改系统代理可能因为权限（reg EPERM）失败，也可能和用户自己的代理软件
       * （Clash 之类，占用 7897）冲突。这两种情况都不该阻断 MITM 本身：
       * - Electron 内部流量靠 setSessionProxy 走代理，不依赖系统设置
       * - 手机抓包本来就要手动把 WiFi 代理指到「本机 IP:端口」
       * 所以失败只记一条提示，代理服务照常跑。
       */
      let proxyNote = ''
      try {
        applyProxy(`127.0.0.1:${state.port}`)
      } catch (err) {
        proxyNote =
          `系统代理未修改（${err instanceof Error ? err.message : String(err)}）。` +
          `手机抓包请手动把 WiFi 代理设为「本机 IP:${state.port}」`
      }
      setSessionProxy(state.port)
      saveState({ enabled: true, port: state.port, snapshot })
      return proxyNote ? { ok: true, message: proxyNote } : { ok: true }
    } catch (e) {
      instance?.stop()
      proxy = null
      lastError = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: 'start-failed', message: lastError }
    }
  })

  ipcMain.handle('mitm:selftest', async () => {
    if (proxy) return { ok: false, message: '通道正在运行，先关闭再做自测' }
    try {
      await ensureMitmCerts()
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    const port = state.port + 1
    let captured = 0
    const test = new MitmProxy({ port, onCapture: () => { captured++ } })
    try {
      await test.start()
      const result = await probeThroughProxy(port, 'order.jd.com', '/center/list.action')
      return { ...result, captured }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    } finally {
      test.stop()
    }
  })

  ipcMain.handle('mitm:disable', (): MitmResult => {
    // 守卫：本就没开启时不能走还原流程 —— snapshot 为 null 会把 ProxyEnable 直接写 0，
    // 关掉用户自己的系统代理（如 Clash）。当前 UI 用 v-if 挡住了，主进程侧也要自守
    if (!proxy && !loadState().enabled) {
      return { ok: true, message: 'MITM 通道未开启' }
    }
    stopAndRestore()
    return { ok: true }
  })

  // 退出必还原：即使用户直接关窗，也不能把人整机代理留在本机端口上
  app.on('before-quit', () => {
    if (proxy) stopAndRestore()
  })

  return { shutdown: stopAndRestore }
}
