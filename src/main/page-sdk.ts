/**
 * 工单 004/008：「经页面官方 SDK 发请求」下行通道的可复用派发器。
 *
 *   主进程任意模块 dispatchPageSdkRequest(webviewId, options)
 *     → 目标 webview 的 inject preload → webFrame.executeJavaScript
 *     → 页面主世界 window.__reflowPageSdk.* → 页面官方 SDK（sign 由 SDK 计算，D-2）
 *
 * 结果监听器全局只注册一次（结果经 'sdk:mtop-result' 按 requestId 路由）。
 */
import { ipcMain, webContents } from 'electron'

const SDK_TIMEOUT_MS = 20_000

interface PendingSdkRequest {
  resolve: (value: { ok: boolean; result?: unknown; error?: string }) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingSdkRequest>()
let listenerInitialized = false

/** 注册结果监听（幂等）。须在 app 主 IPC 装配阶段调用一次。 */
export function initPageSdkResultListener(): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const onResult = (
    payload: { requestId: string; ok: boolean; result?: unknown; error?: string }
  ): void => {
    const entry = pending.get(payload.requestId)
    if (!entry) return
    pending.delete(payload.requestId)
    clearTimeout(entry.timer)
    entry.resolve({ ok: payload.ok, result: payload.result, error: payload.error })
  }
  ipcMain.on('sdk:mtop-result', (_e, p) => onResult(p))
  ipcMain.on('sdk:page-fetch-result', (_e, p) => onResult(p))
}

function dispatch(
  webviewId: number,
  payload: Record<string, unknown>,
  requestChannel: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const target = webContents.fromId(webviewId)
  if (!target || target.getType() !== 'webview') {
    return Promise.resolve({ ok: false, error: `webview ${webviewId} 不存在` })
  }
  const requestId = `${webviewId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve({ ok: false, error: `页面 SDK 请求超时（${SDK_TIMEOUT_MS / 1000}s）` })
    }, SDK_TIMEOUT_MS)

    pending.set(requestId, { resolve, timer })
    target.send(requestChannel, { requestId, ...payload })
  })
}

/** 向指定 webview 的页面 SDK 发起一次 mtop 结构化调用；20s 超时 */
export function dispatchPageSdkRequest(
  webviewId: number,
  options: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return dispatch(webviewId, { options }, 'sdk:mtop-request')
}

/** 工单 012：页面内同源 GET（京东传统页面分页） */
export function dispatchPageFetch(
  webviewId: number,
  url: string
): Promise<{ ok: boolean; result?: { status: number; url: string; text: string }; error?: string }> {
  return dispatch(webviewId, { url }, 'sdk:page-fetch') as Promise<{
    ok: boolean
    result?: { status: number; url: string; text: string }
    error?: string
  }>
}
