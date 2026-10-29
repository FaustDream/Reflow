/**
 * 工单 004：WebView 注入桥的主进程侧。
 *
 * 上行（捕获）：
 *   页面主世界(Hook) --postMessage+nonce--> inject preload(isolated)
 *     --ipc 'capture:report'--> 主进程 --mainWindow.webContents.send--> 渲染层
 *
 * 下行（经页面官方 SDK 发请求，决策 D-2）：
 *   渲染层 invoke('sdk:request') --> 主进程 --> 目标 webview 的 inject preload
 *     --webFrame.executeJavaScript--> 页面主世界 __reflowPageSdk.mtopRequest
 */
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { attachDeepLinkGuard } from './deeplinks'
import type { CaptureReport } from '../shared/types'
import { CaptureEngine } from './platform/capture-engine'
import { adapterRegistry, registerBuiltinAdapters } from './platform/registry'
import { watchCookieLogin, getPlatformLoginStates } from './platform/cookie-login'
import { dispatchPageSdkRequest, initPageSdkResultListener } from './page-sdk'
import { setupOrdersFetchIpc } from './platform/fetch-runner'
import { activeAccountId } from './accounts-ipc'

export interface CaptureBridgeOptions {
  getMainWindow: () => BrowserWindow | null
}

/**
 * 最近捕获摘要（诊断用）。
 *
 * 只记 URL / 结果 / 命中平台，**不含订单内容与 Cookie**。
 * 之前这些信息只发给渲染层一个没人消费的事件通道，出问题时完全看不见
 * —— 用户只能得到「没数据」三个字，无法判断是没捕获到、还是没匹配上、还是解析失败。
 */
export interface RecentCapture {
  url: string
  kind: string
  status: number
  ts: number
  platform: string | null
  outcome: 'ok' | 'error' | 'unmatched'
  detail: string
}

const RECENT_LIMIT = 200
const recentCaptures: RecentCapture[] = []

function pushRecent(item: RecentCapture): void {
  recentCaptures.push(item)
  if (recentCaptures.length > RECENT_LIMIT) {
    recentCaptures.splice(0, recentCaptures.length - RECENT_LIMIT)
  }
}

/**
 * 工单 034：外部捕获来源（MITM 通道）。
 *
 * 代理解密出来的响应走**同一个捕获引擎**（路由 → 解析 → 去重 → 事件），
 * 只是 `webviewId` 记为 -1（表示不是某个 webview 发的）。
 */
let externalFeed: ((report: CaptureReport) => void) | null = null

export function feedExternalCapture(report: CaptureReport): void {
  externalFeed?.(report)
}

export function injectPreloadFile(): string {
  return join(__dirname, '../preload/inject.js')
}

/** 供主窗口 will-attach-webview 使用：强制 webview 安全配置，不信任渲染层传入值 */
export function hardenWebviewPreferences(
  webPreferences: Electron.WebPreferences,
  injectPreloadPath: string
): void {
  webPreferences.preload = injectPreloadPath
  webPreferences.contextIsolation = true
  webPreferences.nodeIntegration = false
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
}

export function setupCaptureBridge({ getMainWindow }: CaptureBridgeOptions): void {
  // 工单 005：捕获引擎 —— 上行捕获的解析 / 去重 / 事件化
  registerBuiltinAdapters()
  const engine = new CaptureEngine(adapterRegistry)

  const forward = (channel: string, payload: unknown): void => {
    // 防御：窗口尚未初始化（TDZ / 主窗口已销毁）时不能把整条捕获链路炸掉，
    // 否则一次抛错会让后续所有 capture 事件丢失（实测见过 `Cannot access 'mainWindow' before initialization`）。
    try {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    } catch {
      /* 主窗口尚未就绪，丢弃该条事件 */
    }
  }

  // 工单 012/013/015：Cookie 登录态监听（京东 thor+pin / 淘宝 unb / 拼多多 PDDAccessToken）
  // session API 仅在 app ready 后可用
  app.whenReady().then(() => {
    watchCookieLogin(adapterRegistry.list(), (event) => {
      forward('platform:event', event)
    })
  }).catch(() => undefined)

  // ---- webview 生命周期：深链拦截 + 故障上报 ----
  app.on('web-contents-created', (_event, contents: WebContents) => {
    if (contents.getType() !== 'webview') return

    attachDeepLinkGuard(contents, (url) => {
      forward('capture:deeplink-blocked', { url, webviewId: contents.id })
    })

    contents.on('render-process-gone', (_e, details) => {
      forward('capture:error', {
        stage: 'render-process-gone',
        reason: details.reason,
        webviewId: contents.id
      })
    })

    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      forward('capture:error', {
        stage: 'did-fail-load',
        errorCode,
        errorDescription,
        url: validatedURL,
        webviewId: contents.id
      })
    })

    /**
     * 页面自己跳到登录页 = 这个平台当前没登录。
     *
     * 比只看 Cookie 可靠：饿了么有 USERID/SID，但 h5 订单页仍跳 /login/；
     * 只看 Cookie 会显示「已登录」，用户点开页面却要他登录。
     */
    contents.on('did-navigate', (_e, url) => {
      if (!/\/login\b|\/login\/|passport\.|signin|\/auth\//i.test(url)) return
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        return
      }
      // Electron 的 Session 没有 getPartition()，改用域名反查是哪个平台的适配器
      const base = host.split('.').slice(-2).join('.')
      const adapter = adapterRegistry.list().find((a) => {
        try {
          return new URL(a.homeUrl).hostname.split('.').slice(-2).join('.') === base
        } catch {
          return false
        }
      })
      if (!adapter) return
      forward('platform:event', {
        platform: adapter.id,
        type: 'login-required',
        ts: Date.now(),
        webviewId: contents.id
      })
    })
  })

  // ---- 上行 ----
  /** 统一入口：webview 注入桥与 MITM 通道都走这里 */
  const handleReport = (payload: CaptureReport, webviewId: number): void => {
    // 原始响应照旧转发（捕获日志面板），解析是引擎的职责
    forward('capture:report', { ...payload, webviewId })

    // 工单 005：路由 → 解析 → 去重 → 订单事件
    const outcome = engine.handleReport(payload, webviewId)

    // 诊断缓冲：不管命中与否都留一条，界面「捕获日志」直接读它
    pushRecent({
      url: payload.url,
      kind: payload.kind,
      status: payload.status ?? 0,
      ts: Date.now(),
      platform:
        outcome.type === 'ok'
          ? (outcome.event?.platform ?? null)
          : outcome.type === 'error'
            ? outcome.error.platformId
            : null,
      outcome: outcome.type,
      detail:
        outcome.type === 'ok'
          ? `${outcome.event?.orders.length ?? 0} 单`
          : outcome.type === 'error'
            ? outcome.error.message
            : '未命中任何平台规则'
    })

    if (outcome.type === 'ok') {
      if (outcome.event) {
        // 工单 021：把「当前活动账号」绑定到订单上（account 字段用于导出标注与账号内去重）。
        // 适配器 parse 出的 account 是平台侧身份，这里补一层本应用的账号槽位标识。
        const platform = outcome.event.platform
        const slotAccount = activeAccountId(platform)
        const enriched = {
          ...outcome.event,
          orders: outcome.event.orders.map((o) => ({
            ...o,
            account: o.account || slotAccount
          }))
        }
        forward('orders:captured', enriched)
        // 被动识别账号：响应里带 userId 时补全账号档案
        if (outcome.event.account?.userId) {
          forward('accounts:identity', enriched)
        }
      }
    } else if (outcome.type === 'error') {
      forward('capture:parse-error', outcome.error)
    }
    // unmatched：与任何平台无关的响应（绝大多数网页流量），静默计数
  }

  ipcMain.on('capture:report', (event, payload: CaptureReport) => {
    handleReport(payload, event.sender.id)
  })

  // MITM 通道：解密后的响应同样进引擎（webviewId = -1）
  externalFeed = (report) => handleReport(report, -1)

  ipcMain.on('capture:error', (event, payload) => {
    forward('capture:error', { ...payload, webviewId: event.sender.id })
  })

  // 工单 006：平台页面脚本事件（登录态等）转发渲染层
  ipcMain.on('platform:event', (event, payload) => {
    forward('platform:event', { ...payload, webviewId: event.sender.id })
  })

  // 工单 005：UI 清空时同步重置引擎去重状态
  ipcMain.handle('orders:reset', () => {
    engine.reset()
    recentCaptures.length = 0
  })

  /** 渲染层启动时补一次登录态（启动瞬间的事件会因为窗口未就绪而丢失） */
  ipcMain.handle('platform:login-states', () => getPlatformLoginStates())

  /** 诊断：最近捕获摘要（倒序，最新在前） */
  ipcMain.handle('capture:recent', () => recentCaptures.slice(-150).reverse())

  // 工单 012/013：京东/淘宝主动批量抓取（响应复用同一引擎）
  setupOrdersFetchIpc({ getMainWindow, engine })

  // ---- 下行：经页面官方 SDK 的请求（结果监听全局只注册一次） ----
  initPageSdkResultListener()
  ipcMain.handle(
    'sdk:request',
    (_event, payload: { webviewId: number; options: Record<string, unknown> }) =>
      dispatchPageSdkRequest(payload.webviewId, payload.options)
  )
}
