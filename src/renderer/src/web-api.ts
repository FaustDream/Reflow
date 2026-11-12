/**
 * Web 调试模式的 window.api shim（2026-11-07）。
 *
 * 浏览器里没有 preload 注入的 window.api，这里补一个**传输层替身**：
 *   - invoke（渲染层 → 主进程）→ POST /api/invoke（vite dev 代理到主进程 web-bridge）
 *   - 事件（主进程 → 渲染层）→ SSE GET /api/events（EventSource 自带断线重连）
 *
 * 类型直接取自 preload 的 `ReflowApi`：任何一边签名改动，typecheck 当场报错，
 * 保证网页版与桌面版 API 面完全一致。业务代码（stores / 组件）零改动。
 *
 * 安装：本文件被 import 时自检 —— window.api 已存在（Electron 窗口）就什么都不做；
 * 不存在（浏览器）才安装。main.ts 必须把它放在第一行 import。
 */
// 类型经 preload/index.d.ts 中转（@preload-api 别名）：与桌面版共用 ReflowApi，
// 任何一边签名改动 typecheck 当场报错；不能直接 import preload/index ——
// 那会把 preload 运行时模块拖进 web 工程，composite 工程会报 TS6307。
import type { ReflowApi } from '@preload-api'
import type { LogEntry, LogLevel } from '@shared/types'

type Unsubscribe = () => void

const BRIDGE_HINT = '无法连接本地后台（web-bridge）。请先启动 npm run dev:web，再刷新页面。'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  let res: Response
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
  } catch {
    throw new Error(BRIDGE_HINT)
  }
  const data = (await res.json()) as { ok: boolean; result?: T; message?: string }
  if (!data.ok) throw new Error(data.message ?? `invoke ${channel} 失败`)
  return data.result as T
}

// ---------------------------------------------------------------------------
// 事件分发：频道 → 监听器集合。EventSource 断线自动重连，监听关系无需重建。
// ---------------------------------------------------------------------------

const listeners = new Map<string, Set<(payload: unknown) => void>>()

function dispatch(channel: string, payload: unknown): void {
  const set = listeners.get(channel)
  if (!set) return
  for (const fn of set) fn(payload)
}

function on<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  const wrapped = listener as (payload: unknown) => void
  set.add(wrapped)
  return () => {
    set?.delete(wrapped)
  }
}

function connectEvents(): void {
  const es = new EventSource('/api/events')
  es.onmessage = (ev) => {
    try {
      const { channel, payload } = JSON.parse(ev.data) as { channel: string; payload: unknown }
      dispatch(channel, payload)
    } catch {
      /* 忽略无法解析的帧（保活注释行不会进 onmessage） */
    }
  }
  es.onerror = () => {
    // EventSource 会自动重连；只在控制台留个痕，别打断业务
    console.warn('[web-api] 事件流断开，自动重连中…')
  }
}

// ---------------------------------------------------------------------------
// API 面：与 preload/index.ts 的 api 一一对应（频道名 / 参数打包方式保持一致）
// ---------------------------------------------------------------------------

const webApi: ReflowApi = {
  getVersion: () => invoke<string>('app:get-version'),
  getAppInfo: () =>
    invoke<{
      version: string
      electron: string
      chrome: string
      node: string
      platform: string
      arch: string
    }>('app:get-info'),

  debugPartitionCookies: (partition: string) =>
    invoke<{
      partition: string
      cookies?: Array<{ name: string; domain: string; httpOnly: boolean; hostOnly: boolean; session: boolean }>
      error?: string
    }>('debug:partition-cookies', partition),

  onCapture: (listener) => on('capture:report', listener),
  onCaptureError: (listener) => on('capture:error', listener),
  onDeepLinkBlocked: (listener) => on('capture:deeplink-blocked', listener),
  onOrders: (listener) => on('orders:captured', listener),
  onParseError: (listener) => on('capture:parse-error', listener),
  onPlatformEvent: (listener) => on('platform:event', listener),

  getPlatformLoginStates: () =>
    invoke<Record<string, { loggedIn: boolean; userId: string; nickname: string }>>(
      'platform:login-states'
    ),

  getAdapters: () => invoke('app:get-adapters'),
  resetOrders: () => invoke<void>('orders:reset'),

  exportExcel: (orders, platforms, includeImages, extra) =>
    invoke('export:excel', {
      orders,
      platforms,
      includeImages,
      ...(extra ?? {})
    }),

  getExportColumns: (platforms) => invoke('export:columns', platforms),

  onImageProgress: (listener) => on('export:image-progress', listener),

  openPath: (path) => invoke<void>('export:open-path', path),
  showInFolder: (path) => invoke<void>('export:show-in-folder', path),

  getMitmStatus: () => invoke('mitm:status'),
  installMitmCert: () => invoke('mitm:install-cert'),
  removeMitmCert: () => invoke('mitm:remove-cert'),
  enableMitm: () => invoke('mitm:enable'),
  disableMitm: () => invoke('mitm:disable'),
  selftestMitm: () =>
    invoke<{ ok: boolean; status?: number; captured?: number; message?: string }>('mitm:selftest'),

  getExportHistory: () => invoke('export:history'),
  clearExportHistory: () => invoke<{ ok: boolean }>('export:clear-history'),

  exportStatsExcel: (payload: {
    sheets: Array<{ name: string; headers: string[]; rows: Array<Array<string | number>>; boldLast?: boolean }>
    fileName?: string
  }) =>
    invoke<{
      ok: boolean
      cancelled?: boolean
      path?: string
      sheets?: number
      message?: string
    }>('export:stats-excel', payload),

  requestViaPageSdk: (webviewId, options) =>
    invoke<{ ok: boolean; result?: unknown; error?: string }>('sdk:request', { webviewId, options }),

  fetchXianyuDetails: (webviewId, items) =>
    invoke<{ ok: boolean; message?: string }>('xianyu:fetch-details', { webviewId, items }),
  cancelXianyuDetails: (webviewId) =>
    invoke<{ ok: boolean }>('xianyu:cancel-details', webviewId),
  onDetailsStarted: (listener) => on('orders:details-started', listener),
  onOrderDetail: (listener) => on('orders:detail', listener),
  onDetailProgress: (listener) => on('orders:detail-progress', listener),
  onDetailsCompleted: (listener) => on('orders:details-completed', listener),

  fetchAllOrders: (platform, webviewId, options) =>
    invoke<{ ok: boolean; message?: string; cancelled?: boolean }>('orders:fetch-all', {
      platform,
      webviewId,
      ...(options ?? {})
    }),
  cancelFetchOrders: (platform) => invoke<{ ok: boolean }>('orders:cancel-fetch', platform),
  onOrdersFetchEvent: (listener) => on('orders:fetch-event', listener),
  onOrdersCacheUpdated: (listener) => on<string>('orders:cache-updated', listener),

  startLogin: (platformId) =>
    invoke<{
      ok: boolean
      qrImage?: string
      source?: 'native' | 'dom' | 'page'
      message?: string
    }>('login:start', platformId),
  cancelLogin: (platformId) => invoke<{ ok: boolean }>('login:cancel', platformId),
  onLoginStatus: (listener) =>
    on<{
      id: string
      platformId: string
      state: 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'
      message: string
      qrImage?: string
    }>('login:status', listener),

  loadOrderCache: () => invoke<Record<string, unknown[]>>('cache:load-all'),
  getCacheSummary: () =>
    invoke<Array<{ platform: string; count: number; savedAt: number }>>('cache:summary'),
  saveOrderCache: (platform, orders) =>
    invoke<{ ok: boolean; message?: string }>('cache:save', { platform, orders }),
  clearPlatformCache: (platform) => invoke<{ ok: boolean }>('cache:clear-platform', platform),
  clearAllCache: () => invoke<{ ok: boolean }>('cache:clear-all'),

  listAccounts: () =>
    invoke<
      Array<{
        id: string
        platform: string
        slot: number
        label: string
        userId: string
        nickname: string
        displayName: string
        partition: string
        active: boolean
        createdAt: number
      }>
    >('accounts:list'),
  ensureAccount: (platform) => invoke<{ ok: boolean }>('accounts:ensure', platform),
  addAccount: (platform) => invoke<{ ok: boolean; account?: unknown }>('accounts:add', platform),
  activateAccount: (id) =>
    invoke<{ ok: boolean; partition?: string; message?: string }>('accounts:activate', id),
  renameAccount: (id, label) => invoke<{ ok: boolean }>('accounts:rename', { id, label }),
  removeAccount: (id) => invoke<{ ok: boolean; message?: string }>('accounts:remove', id),
  logoutAccount: (id) => invoke<{ ok: boolean; message?: string }>('accounts:logout', id),
  logoutPlatform: (platform) => invoke<{ ok: boolean }>('platform:logout', platform),
  onAccountsChanged: (listener) =>
    on<{ platform: string; accountId: string }>('accounts:changed', listener),

  loadOnboarding: () =>
    invoke<{ version: number; completed: boolean; completedAt?: number; platforms: string[] }>(
      'onboarding:load'
    ),
  completeOnboarding: (platforms) => invoke<{ ok: boolean }>('onboarding:complete', { platforms }),
  resetOnboarding: () => invoke<{ ok: boolean }>('onboarding:reset'),

  checkUpdate: () => invoke('update:check'),
  getChangelog: () => invoke('update:changelog'),

  logs: {
    list: () => invoke<{ entries: LogEntry[]; filePath: string }>('log:list'),
    clear: () => invoke<{ ok: boolean }>('log:clear'),
    openFolder: () => invoke<{ ok: boolean; error?: string }>('log:open-folder'),
    write: (level: LogLevel, scope: string, message: string, detail?: unknown) =>
      invoke<{ ok: boolean }>('log:write', { level, scope, message, detail }),
    onEntry: (listener: (entry: LogEntry) => void) => on('log:entry', listener)
  }
}

/** 安装浏览器版 window.api：先挂对象，再接事件流（避免早到的推送无人接收） */
export function installWebApiShim(): void {
  ;(window as unknown as { api: ReflowApi }).api = webApi
  connectEvents()
  console.info('[web-api] Web 调试模式：window.api 已切换为 HTTP/SSE 桥（invoke → /api/invoke）')
}

// 桌面版（preload 注入了 api）什么都不做
if (typeof window !== 'undefined' && !('api' in window)) {
  installWebApiShim()
}
