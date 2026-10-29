import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AdapterSummary,
  CaptureEvent,
  CaptureErrorEvent,
  DeepLinkBlockedEvent,
  DetailProgressEvent,
  DetailsCompletedEvent,
  ExportColumn,
  ExportHistoryEntry,
  MitmResult,
  MitmStatus,
  OrderDetailEvent,
  OrdersFetchEvent,
  OrdersCapturedEvent,
  ParseErrorEvent,
  PlatformEvent
} from '../shared/types'

type Unsubscribe = () => void

type ReflowApi = {
  getVersion: () => Promise<string>
  getAppInfo: () => Promise<{
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
  }>
  getInjectPreload: () => Promise<string>
  debugPartitionCookies: (
    partition: string
  ) => Promise<{
    partition: string
    cookies?: Array<{ name: string; domain: string; httpOnly: boolean; hostOnly: boolean; session: boolean }>
    error?: string
  }>
  onCapture: (listener: (payload: CaptureEvent) => void) => Unsubscribe
  onCaptureError: (listener: (payload: CaptureErrorEvent) => void) => Unsubscribe
  onDeepLinkBlocked: (listener: (payload: DeepLinkBlockedEvent) => void) => Unsubscribe
  onOrders: (listener: (payload: OrdersCapturedEvent) => void) => Unsubscribe
  onParseError: (listener: (payload: ParseErrorEvent) => void) => Unsubscribe
  onPlatformEvent: (listener: (payload: PlatformEvent) => void) => Unsubscribe
  /** 启动时补一次登录态快照（启动瞬间的事件可能因主窗口未就绪而丢失） */
  getPlatformLoginStates: () => Promise<
    Record<string, { loggedIn: boolean; userId: string; nickname: string }>
  >
  getAdapters: () => Promise<AdapterSummary[]>
  resetOrders: () => Promise<void>
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
  ) => Promise<{
    ok: boolean
    cancelled?: boolean
    reason?: 'empty' | 'write-failed' | 'no-columns'
    message?: string
    path?: string
    imageFailures?: number
    rowCount?: number
  }>
  /** 工单 031：导出中心的可选列（核心列 + 已消歧扩展列） */
  getExportColumns: (
    platforms?: string[]
  ) => Promise<{ core: ExportColumn[]; extended: ExportColumn[]; custom?: boolean }>
  onImageProgress: (
    listener: (payload: { done: number; total: number; failed: number }) => void
  ) => Unsubscribe
  openPath: (path: string) => Promise<void>
  showInFolder: (path: string) => Promise<void>
  /** 工单 034：MITM 抓取通道 */
  getMitmStatus: () => Promise<MitmStatus>
  installMitmCert: () => Promise<MitmResult>
  removeMitmCert: () => Promise<MitmResult>
  enableMitm: () => Promise<MitmResult>
  disableMitm: () => Promise<MitmResult>
  selftestMitm: () => Promise<{ ok: boolean; status?: number; captured?: number; message?: string }>

  /** 工单 031：最近导出记录 */
  getExportHistory: () => Promise<ExportHistoryEntry[]>
  clearExportHistory: () => Promise<{ ok: boolean }>
  requestViaPageSdk: (
    webviewId: number,
    options: Record<string, unknown>
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  fetchXianyuDetails: (
    webviewId: number,
    items: Array<{ orderId: string; idleBizCode?: string }>
  ) => Promise<{ ok: boolean; message?: string }>
  cancelXianyuDetails: (webviewId: number) => Promise<{ ok: boolean }>
  onDetailsStarted: (listener: (payload: { platform: string; total: number }) => void) => Unsubscribe
  onOrderDetail: (listener: (payload: OrderDetailEvent) => void) => Unsubscribe
  onDetailProgress: (listener: (payload: DetailProgressEvent) => void) => Unsubscribe
  onDetailsCompleted: (listener: (payload: DetailsCompletedEvent) => void) => Unsubscribe
  fetchAllOrders: (
    platform: 'jd' | 'taobao' | 'xianyu' | 'xianyu-sold',
    webviewId: number,
    options?: { range?: 'current' | 'all' | number; years?: number; months?: number }
  ) => Promise<{ ok: boolean; message?: string; cancelled?: boolean }>
  cancelFetchOrders: (
    platform: 'jd' | 'taobao' | 'xianyu' | 'xianyu-sold'
  ) => Promise<{ ok: boolean }>
  /** 后台重新加载某平台订单（独立隐藏窗口，不影响界面/不打断其它平台） */
  bgReloadOrders: (
    platform: string
  ) => Promise<{ ok: boolean; platform: string; steps: number; message?: string }>
  /** 导入平台官方导出的 xlsx/csv（全量订单），并进本地库 */
  importOrdersFile: (
    platform: string
  ) => Promise<{ ok: boolean; imported: number; skipped: number; message?: string }>
  /** 淘宝全量抓取：在已登录的主 webview 里调 lib.mtop（魔猫同款做法） */
  taobaoFetchAll: (
    webviewId: number
  ) => Promise<{ ok: boolean; imported: number; totalPage: number; message?: string }>
  onOrdersFetchEvent: (listener: (payload: OrdersFetchEvent) => void) => Unsubscribe
  /** 主进程落盘后通知渲染层重载本地缓存 */
  onOrdersCacheUpdated: (listener: (platform: string) => void) => Unsubscribe

  /** 各平台登录能力（pureQr=只显示二维码；page=弹窗内网页登录） */
  getLoginCapabilities: () => Promise<
    Array<{
      platformId: string
      supportsLogin: boolean
      pureQr: boolean
      source: 'native' | 'dom' | 'page'
      /** 登录页地址（点「登录」直接跳过去用，不必先手动打开页面） */
      loginUrl: string
    }>
  >
  /** 开始登录：native/dom 返回二维码；page 模式由主进程开小窗 */
  startLogin: (platformId: string) => Promise<{
    ok: boolean
    qrImage?: string
    source?: 'native' | 'dom' | 'page'
    message?: string
  }>
  cancelLogin: (platformId: string) => Promise<{ ok: boolean }>
  onLoginStatus: (
    listener: (payload: {
      id: string
      platformId: string
      state: 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'
      message: string
      /** waiting 时二维码被页面换新：必须替换，否则用户扫的是作废的码 */
      qrImage?: string
    }) => void
  ) => Unsubscribe

  /** 工单 010：自动翻页（滚动加载） */
  startAutoScroll: (
    platform: string,
    webviewId: number,
    options?: { intervalMs?: number; maxSteps?: number; idleStops?: number }
  ) => Promise<{ ok: boolean; message?: string }>
  stopAutoScroll: (platform: string) => Promise<{ ok: boolean }>
  onAutoScrollEvent: (
    listener: (payload: {
      platform: string
      phase: 'started' | 'progress' | 'finished'
      steps?: number
      ok?: boolean
      cancelled?: boolean
      reason?: string
      error?: string
      ts: number
    }) => void
  ) => Unsubscribe

  /** 工单 023：订单本地缓存 */
  loadOrderCache: () => Promise<Record<string, unknown[]>>
  getCacheSummary: () => Promise<Array<{ platform: string; count: number; savedAt: number }>>
  saveOrderCache: (platform: string, orders: unknown[]) => Promise<{ ok: boolean; message?: string }>
  clearPlatformCache: (platform: string) => Promise<{ ok: boolean }>
  clearAllCache: () => Promise<{ ok: boolean }>

  /** 工单 025：诊断快照 */
  getDiagnostics: () => Promise<unknown>

  /** 诊断：最近捕获摘要（URL / 命中平台 / 结果），用于「捕获日志」面板 */
  getRecentCaptures: () => Promise<
    Array<{
      url: string
      kind: string
      status: number
      ts: number
      platform: string | null
      outcome: 'ok' | 'error' | 'unmatched'
      detail: string
    }>
  >

  /** 工单 021：多账号 */
  listAccounts: () => Promise<
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
  >
  ensureAccount: (platform: string) => Promise<{ ok: boolean }>
  addAccount: (platform: string) => Promise<{ ok: boolean; account?: unknown }>
  activateAccount: (id: string) => Promise<{ ok: boolean; partition?: string; message?: string }>
  renameAccount: (id: string, label: string) => Promise<{ ok: boolean }>
  removeAccount: (id: string) => Promise<{ ok: boolean; message?: string }>
  logoutAccount: (id: string) => Promise<{ ok: boolean; message?: string }>

  /** 单账号模式：退出当前平台（清空该平台分区） */
  logoutPlatform: (platform: string) => Promise<{ ok: boolean }>
  onAccountsChanged: (
    listener: (payload: { platform: string; accountId: string }) => void
  ) => Unsubscribe

  /** 工单 024：首次启动引导 */
  loadOnboarding: () => Promise<{
    version: number
    completed: boolean
    completedAt?: number
    platforms: string[]
  }>
  completeOnboarding: (platforms: string[]) => Promise<{ ok: boolean }>
  resetOnboarding: () => Promise<{ ok: boolean }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ReflowApi
  }
}

export {}
