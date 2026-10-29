/**
 * 主进程 / preload / 渲染层共享的捕获载荷类型。
 * 单一来源，避免三处各写一份导致漂移（工单 003 同理）。
 */
import type { AccountInfo, Order, PageInfo } from './types/order'

// 再导出统一订单模型：渲染层统一从 '@shared/types' 导入（单一入口，定义仍在 order.ts）
export type { AccountInfo, Order, PageInfo }
export type { ExportColumn } from './types/order'
export type { DateTimeString } from './datetime'
export { CORE_EXPORT_COLUMNS, emptyOrder } from './types/order'

export type CaptureKind = 'xhr' | 'fetch' | 'jsonp'

/** 页面 Hook 上报的单条捕获记录（尚未解析为 Order） */
export interface CaptureReport {
  kind: CaptureKind
  url: string
  method?: string
  status?: number
  /** 已尽力解析的响应体：JSON 成功时为对象，否则为原始字符串 */
  body: unknown
  ts: number
}

/** 主进程转发给渲染层时附加的来源信息 */
export interface CaptureEvent extends CaptureReport {
  webviewId: number
}

export interface CaptureErrorEvent {
  stage: 'inject' | 'did-fail-load' | 'render-process-gone'
  /** 注入失败所属平台脚本（006 起页面脚本注入失败时携带） */
  platform?: string
  webviewId: number
  errorCode?: number
  errorDescription?: string
  reason?: string
  url?: string
  message?: string
}

export interface DeepLinkBlockedEvent {
  url: string
  webviewId: number
}

/**
 * 工单 005：捕获引擎解析成功后推送给渲染层的订单事件。
 * `orders` 仅含去重后的新订单；重复数量由 `duplicates` 携带供 UI 提示。
 */
export interface OrdersCapturedEvent {
  platform: string
  orders: Order[]
  pageInfo?: PageInfo
  account?: AccountInfo
  /** 命中的捕获 URL */
  url: string
  kind: CaptureKind
  webviewId: number
  ts: number
  /** 本次命中中因重复被丢弃的条数 */
  duplicates: number
}

/** 工单 005：适配器解析失败（响应结构与适配器预期不符），供诊断面板 025 消费 */
export interface ParseErrorEvent {
  /** 解析失败所属适配器 id（路由成功但解析抛错时才有） */
  platformId: string | null
  url: string
  kind: CaptureKind
  message: string
  webviewId: number
  ts: number
}

/** 平台适配器摘要（UI 展示用，不含解析函数） */
export interface AdapterSummary {
  id: string
  displayName: string
  homeUrl: string
  supportsSeller: boolean
  ruleCount: number
  /** 会话分区（缺省时 UI 按 `persist:platform-<id>` 兜底） */
  partition?: string
}

/** 工单 034：MITM 通道状态（给设置界面看） */
export interface MitmStatus {
  running: boolean
  port: number
  /** 当前平台是否支持 MITM 通道（系统代理 + 根证书安装目前仅 Windows 实现） */
  supported: boolean
  certInstalled: boolean
  systemProxy: { enabled: boolean; server: string }
  whitelist: string[]
  stats: { captured: number; intercepted: number }
  lastError: string
  recovered: boolean
}

export interface MitmResult {
  ok: boolean
  reason?: 'cert-missing' | 'start-failed' | 'cert-install-failed' | 'unsupported'
  message?: string
}

/**
 * 工单 031：导出历史条目。
 * 只记元信息（路径 / 行数 / 平台 / 时间），**不含订单内容**（D-4 隐私门禁）。
 */
export interface ExportHistoryEntry {
  path: string
  fileName: string
  format: 'xlsx' | 'csv'
  layout: 'single' | 'multi-sheet'
  rowCount: number
  platforms: string[]
  includeImages: boolean
  at: number
}

/**
 * 工单 006：平台页面脚本经注入通道上报的事件（登录态等）。
 * 由页面主世界 postMessage（nonce 校验）→ inject preload → 主进程 → 渲染层。
 */
export interface PlatformEvent {
  platform: string
  type: 'login' | 'logout' | 'login-required'
  userId?: string
  nickname?: string
  avatarUrl?: string
  webviewId?: number
  ts: number
}

/** 工单 008：闲鱼详情合并进统一订单的字段（其余列留空，后续工单补） */
export interface XianyuDetailFields {
  receiverAddress: string
  alipayTradeNo: string
  freight: string
  coinDiscount: string
  paidAt: string | null
  shippedAt: string | null
  completedAt: string | null
}

export interface OrderDetailEvent {
  platform: string
  orderId: string
  fields: XianyuDetailFields
}

export interface DetailProgressEvent {
  platform: string
  done: number
  total: number
  orderId: string
}

export interface DetailsCompletedEvent {
  platform: string
  total: number
  /** 成功合并详情的订单数 */
  successCount: number
  /** 已处理数（成功+跳过+失败） */
  done: number
  failed: Array<{ orderId: string; message: string }>
  /** 人机验证导致整批暂停 */
  paused?: boolean
  cancelled?: boolean
  message?: string
}

/** 支持主动批量抓取的平台（006/011 闲鱼买·卖、012 京东、013 淘宝、014 1688） */
export type FetchPlatform = 'jd' | 'taobao' | 'ali1688' | 'xianyu' | 'xianyu-sold'

/** 主动批量抓取的生命周期事件 */
export interface OrdersFetchEvent {
  platform: FetchPlatform
  phase: 'started' | 'progress' | 'completed'
  /** 已完成页数 */
  pages?: number
  /** 总页数（已知时） */
  totalPages?: number
  /** 进度说明 */
  message?: string
  /** completed 时携带 */
  ok?: boolean
  cancelled?: boolean
  error?: string
  months?: number
  ts: number
}

/**
 * 工单 010：滚动加载型平台的自动翻页事件。
 * 只驱动页面滚动，订单仍由被动捕获管道进入。
 */
export interface AutoScrollEvent {
  platform: string
  phase: 'started' | 'progress' | 'finished'
  /** 已滚动步数 */
  steps?: number
  /** finished 时：是否正常结束 */
  ok?: boolean
  cancelled?: boolean
  /** finished 时的原因（no-more-content / max-steps / 错误信息） */
  reason?: string
  error?: string
  ts: number
}
