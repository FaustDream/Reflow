import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AdapterSummary,
  CaptureEvent,
  CaptureErrorEvent,
  DeepLinkBlockedEvent,
  DetailProgressEvent,
  DetailsCompletedEvent,
  ExportColumn,
  ExportHistoryEntry,
  FetchPlatform,
  MitmResult,
  MitmStatus,
  OrderDetailEvent,
  OrdersFetchEvent,
  OrdersCapturedEvent,
  ParseErrorEvent,
  PlatformEvent,
  LogEntry,
  LogLevel
} from '../shared/types'

type Unsubscribe = () => void

const on = <T>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

// 工单 001 + 004：仅暴露最小 API 面。平台适配器（006 起）在此基础上扩展。
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getAppInfo: (): Promise<{
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
  }> => ipcRenderer.invoke('app:get-info'),

  /** 仅 dev：读取平台分区 Cookie（含 httpOnly），校准登录态判定 */
  debugPartitionCookies: (
    partition: string
  ): Promise<{
    partition: string
    cookies?: Array<{ name: string; domain: string; httpOnly: boolean; hostOnly: boolean; session: boolean }>
    error?: string
  }> => ipcRenderer.invoke('debug:partition-cookies', partition),

  /** 工单 004：订阅页面 Hook 捕获到的原始响应（未解析为 Order） */
  onCapture: (listener: (payload: CaptureEvent) => void): Unsubscribe =>
    on<CaptureEvent>('capture:report', listener),

  /** 工单 004：订阅注入/加载故障，供 025 诊断面板消费 */
  onCaptureError: (listener: (payload: CaptureErrorEvent) => void): Unsubscribe =>
    on<CaptureErrorEvent>('capture:error', listener),

  /** 工单 004：订阅被拦截的平台 App 深链 */
  onDeepLinkBlocked: (listener: (payload: DeepLinkBlockedEvent) => void): Unsubscribe =>
    on<DeepLinkBlockedEvent>('capture:deeplink-blocked', listener),

  /** 工单 005：订阅捕获引擎解析出的新订单（已去重） */
  onOrders: (listener: (payload: OrdersCapturedEvent) => void): Unsubscribe =>
    on<OrdersCapturedEvent>('orders:captured', listener),

  /** 工单 005：订阅适配器解析失败（响应结构与预期不符），供诊断展示 */
  onParseError: (listener: (payload: ParseErrorEvent) => void): Unsubscribe =>
    on<ParseErrorEvent>('capture:parse-error', listener),

  /** 工单 006：订阅平台页面脚本事件（登录态 / 需要登录 / 登出） */
  onPlatformEvent: (listener: (payload: PlatformEvent) => void): Unsubscribe =>
    on<PlatformEvent>('platform:event', listener),

  /** 启动时补一次登录态快照（启动瞬间的事件可能因主窗口未就绪而丢失） */
  getPlatformLoginStates: (): Promise<
    Record<string, { loggedIn: boolean; userId: string; nickname: string }>
  > => ipcRenderer.invoke('platform:login-states'),

  /** 工单 005：已注册的平台适配器摘要 */
  getAdapters: (): Promise<AdapterSummary[]> => ipcRenderer.invoke('app:get-adapters'),

  /** 工单 005：清空订单与引擎去重状态 */
  resetOrders: (): Promise<void> => ipcRenderer.invoke('orders:reset'),

  /** 工单 007/009：把捕获到的统一订单导出为 xlsx；includeImages 时先下载并内嵌 60×60 缩略图 */
  exportExcel: (
    orders: unknown[],
    platforms?: string[],
    includeImages?: boolean,
    extra?: {
      format?: 'xlsx' | 'csv'
      layout?: 'single' | 'multi-sheet'
      columnKeys?: string[]
      coreKeys?: string[]
      summary?: boolean
      targetPath?: string
    }
  ): Promise<{
    ok: boolean
    cancelled?: boolean
    reason?: 'empty' | 'write-failed' | 'no-columns'
    message?: string
    path?: string
    imageFailures?: number
    rowCount?: number
  }> =>
    ipcRenderer.invoke('export:excel', {
      orders,
      platforms,
      includeImages,
      ...(extra ?? {})
    }),

  /**
   * 工单 031：导出中心的可选列（核心列 + 已消歧的扩展列）。
   * 列清单由主进程计算，保证与真正导出时的表头完全一致。
   */
  getExportColumns: (
    platforms?: string[]
  ): Promise<{ core: ExportColumn[]; extended: ExportColumn[]; custom?: boolean }> =>
    ipcRenderer.invoke('export:columns', platforms),

  /** 工单 009：含图导出的图片下载进度 */
  onImageProgress: (
    listener: (payload: { done: number; total: number; failed: number }) => void
  ): Unsubscribe => on('export:image-progress', listener),

  /** 工单 007：导出完成后打开文件 / 在目录中定位 */
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('export:open-path', path),
  showInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('export:show-in-folder', path),

  // ---------------------------------------------------------------------------
  // 工单 034：MITM 抓取通道（改系统代理 + 装根证书，默认关闭）
  // ---------------------------------------------------------------------------

  getMitmStatus: (): Promise<MitmStatus> => ipcRenderer.invoke('mitm:status'),
  installMitmCert: (): Promise<MitmResult> => ipcRenderer.invoke('mitm:install-cert'),
  removeMitmCert: (): Promise<MitmResult> => ipcRenderer.invoke('mitm:remove-cert'),
  enableMitm: (): Promise<MitmResult> => ipcRenderer.invoke('mitm:enable'),
  disableMitm: (): Promise<MitmResult> => ipcRenderer.invoke('mitm:disable'),
  /** 通道自测：不装证书、不改系统代理，走一遍 CONNECT→TLS→GET */
  selftestMitm: (): Promise<{ ok: boolean; status?: number; captured?: number; message?: string }> =>
    ipcRenderer.invoke('mitm:selftest'),

  /** 工单 031：最近导出记录（元信息，不含订单内容） */
  getExportHistory: (): Promise<ExportHistoryEntry[]> => ipcRenderer.invoke('export:history'),
  clearExportHistory: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('export:clear-history'),

  /**
   * 统计报表导出（2026-11-08）：仪表盘汇总统计 → Excel。
   * 区块由渲染层按页面显示口径算好，主进程只排版落盘。
   */
  exportStatsExcel: (payload: {
    sheets: Array<{ name: string; headers: string[]; rows: Array<Array<string | number>>; boldLast?: boolean }>
    fileName?: string
  }): Promise<{ ok: boolean; cancelled?: boolean; path?: string; sheets?: number; message?: string }> =>
    ipcRenderer.invoke('export:stats-excel', payload),

  /**
   * 工单 004：经页面官方 SDK 发起请求（决策 D-2：sign 由官方 SDK 计算）。
   * 目前仅支持闲鱼/淘宝系 mtop；新增平台 SDK 时在 hook-source 扩展。
   */
  requestViaPageSdk: (
    webviewId: number,
    options: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('sdk:request', { webviewId, options }),

  /** 工单 008：闲鱼详情批量抓取（经页面官方 mtop SDK，串行限速） */
  fetchXianyuDetails: (
    webviewId: number,
    items: Array<{ orderId: string; idleBizCode?: string }>
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('xianyu:fetch-details', { webviewId, items }),
  cancelXianyuDetails: (webviewId: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('xianyu:cancel-details', webviewId),
  onDetailsStarted: (listener: (payload: { platform: string; total: number }) => void): Unsubscribe =>
    on('orders:details-started', listener),
  onOrderDetail: (listener: (payload: OrderDetailEvent) => void): Unsubscribe =>
    on<OrderDetailEvent>('orders:detail', listener),
  onDetailProgress: (listener: (payload: DetailProgressEvent) => void): Unsubscribe =>
    on<DetailProgressEvent>('orders:detail-progress', listener),
  onDetailsCompleted: (listener: (payload: DetailsCompletedEvent) => void): Unsubscribe =>
    on<DetailsCompletedEvent>('orders:details-completed', listener),

  /** 工单 006/011/040：四平台主动批量抓取（拼多多/淘宝/京东为纯接口直连，无需页面） */
  fetchAllOrders: (
    platform: FetchPlatform,
    webviewId?: number,
    options?: {
      range?: 'current' | 'all' | number
      years?: number
      months?: number
      /** 增量抓取：以本地缓存为基准，翻到整页全是已知单就停（默认全量） */
      incremental?: boolean
    }
  ): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke('orders:fetch-all', { platform, webviewId, ...options }),
  cancelFetchOrders: (
    platform: FetchPlatform
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('orders:cancel-fetch', platform),
  onOrdersFetchEvent: (listener: (payload: OrdersFetchEvent) => void): Unsubscribe =>
    on<OrdersFetchEvent>('orders:fetch-event', listener),
  /** 主进程落盘后通知渲染层重载本地缓存 */
  onOrdersCacheUpdated: (listener: (platform: string) => void): Unsubscribe =>
    on<string>('orders:cache-updated', listener),

  // ---------------------------------------------------------------------------
  // 登录（一律二维码弹窗；「打开页面」通道已下线）
  // ---------------------------------------------------------------------------

  /** 开始登录：native（淘宝/闲鱼）与 dom（京东/拼多多）都返回二维码图 */
  startLogin: (
    platformId: string
  ): Promise<{
    ok: boolean
    qrImage?: string
    source?: 'native' | 'dom' | 'page'
    message?: string
  }> => ipcRenderer.invoke('login:start', platformId),

  /** 取消登录（关闭隐藏窗口 / 停止轮询） */
  cancelLogin: (platformId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('login:cancel', platformId),

  /** 登录状态推送：waiting / scanned / success / expired / failed */
  onLoginStatus: (
    listener: (payload: {
      id: string
      platformId: string
      state: 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'
      message: string
      /** waiting 时二维码被页面换新：必须替换，否则用户扫的是作废的码 */
      qrImage?: string
    }) => void
  ): Unsubscribe => on('login:status', listener),

  // ---------------------------------------------------------------------------
  // 工单 010：自动翻页（滚动加载）已随「打开页面」下线移除（2026-11-01）
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 工单 023：订单本地缓存
  // ---------------------------------------------------------------------------

  /** 启动时恢复全部平台缓存 */
  loadOrderCache: (): Promise<Record<string, unknown[]>> => ipcRenderer.invoke('cache:load-all'),

  getCacheSummary: (): Promise<Array<{ platform: string; count: number; savedAt: number }>> =>
    ipcRenderer.invoke('cache:summary'),

  /** 保存某平台完整订单快照（去抖落盘） */
  saveOrderCache: (platform: string, orders: unknown[]): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('cache:save', { platform, orders }),

  clearPlatformCache: (platform: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('cache:clear-platform', platform),

  clearAllCache: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('cache:clear-all'),


  // ---------------------------------------------------------------------------
  // 工单 021：多账号聚合
  // ---------------------------------------------------------------------------

  /** 列出全部账号（含展示名、分区、是否活动） */
  listAccounts: (): Promise<Array<{
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
  }>> => ipcRenderer.invoke('accounts:list'),

  /** 确保平台有默认账号（首次进入时） */
  ensureAccount: (platform: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('accounts:ensure', platform),

  /** 新增账号（分配新槽位/新分区） */
  addAccount: (platform: string): Promise<{ ok: boolean; account?: unknown }> =>
    ipcRenderer.invoke('accounts:add', platform),

  activateAccount: (id: string): Promise<{ ok: boolean; partition?: string; message?: string }> =>
    ipcRenderer.invoke('accounts:activate', id),

  /** 重命名账号（自定义备注） */
  renameAccount: (id: string, label: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('accounts:rename', { id, label }),

  /** 删除账号（连同其 Cookie） */
  removeAccount: (id: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('accounts:remove', id),

  /** 退出账号（清 Cookie，保留条目） */
  logoutAccount: (id: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('accounts:logout', id),

  /** 单账号模式：退出当前平台（清空该平台分区） */
  logoutPlatform: (platform: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('platform:logout', platform),

  /** 账号变化通知（新增/切换/删除/被动识别到身份） */
  onAccountsChanged: (
    listener: (payload: { platform: string; accountId: string }) => void
  ): Unsubscribe => on('accounts:changed', listener),

  // ---------------------------------------------------------------------------
  // 工单 024：首次启动引导
  // ---------------------------------------------------------------------------

  /** 读取引导状态（completed / 已选平台） */
  loadOnboarding: (): Promise<{
    version: number
    completed: boolean
    completedAt?: number
    platforms: string[]
  }> => ipcRenderer.invoke('onboarding:load'),

  completeOnboarding: (platforms: string[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('onboarding:complete', { platforms }),

  /** 重置引导（诊断/设置里可再次查看） */
  resetOnboarding: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('onboarding:reset'),

  // ---------------------------------------------------------------------------
  // 工单 027：自动更新
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 系统日志（2026-11-02）：运行日志标签页
  // ---------------------------------------------------------------------------
  logs: {
    list: (): Promise<{ entries: LogEntry[]; filePath: string }> => ipcRenderer.invoke('log:list'),
    clear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('log:clear'),
    openFolder: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('log:open-folder'),
    /** 渲染层记录用户动作（切平台、点抓取、导出…） */
    write: (
      level: LogLevel,
      scope: string,
      message: string,
      detail?: unknown
    ): Promise<{ ok: boolean }> => ipcRenderer.invoke('log:write', { level, scope, message, detail }),
    /** 实时订阅新日志 */
    onEntry: (listener: (entry: LogEntry) => void): Unsubscribe => on<LogEntry>('log:entry', listener)
  }
}

export type ReflowApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('contextBridge 暴露失败', error)
  }
} else {
  // 非隔离环境的降级路径（正常打包恒走上一分支）。显式断言而不是 @ts-expect-error：
  // 本文件同时被 tsconfig.preload 与 tsconfig.web（经 index.d.ts 的 import type）检查，
  // 两边对 window 类型的解析不同，指令会在其中一边变成「未使用」而报错
  const target = window as unknown as { electron: unknown; api: unknown }
  target.electron = electronAPI
  target.api = api
}
