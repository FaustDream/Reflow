/**
 * 工单 003：平台适配器接口 —— 「新增一个平台时唯一需要实现的东西」。
 *
 * 注入路线（决策 D-E）下适配器是**两段式**的（原版淘宝即此结构）：
 *  1. `pageScript`（可选）：注入页面主世界的脚本，负责调页面官方 SDK
 *     （登录检测、详情批量抓取等主动行为，D-2：sign 由官方 SDK 计算）；
 *  2. `parse()`：主进程内的解析器，把注入桥回传的捕获响应映射为统一 Order。
 * 被动捕获（XHR/fetch/JSONP Hook）由共用注入桥（工单 004）完成，适配器只声明匹配规则。
 */
import type { CaptureKind, CaptureReport } from '../../shared/types'
import type { AccountInfo, ExportColumn, Order, PageInfo } from '../../shared/types/order'

/** 捕获匹配规则：URL（glob 或正则）× HTTP method × 请求形态 三维匹配 */
export interface MatchRule {
  /**
   * URL 匹配模式。
   * - 字符串：glob，`*` 匹配任意字符序列（含 `/`），如 `'*.goofish.com/h5/mtop.idle.web.trade.bought.list*'`
   * - RegExp：按 `test()` 精确匹配（不要带 g 标志）
   */
  pattern: string | RegExp
  /** HTTP method（大小写不敏感），缺省不限 */
  method?: string
  /** 请求形态，缺省不限 */
  kind?: CaptureKind | 'any'
}

/** 解析结果：订单 + 可选的账号/分页信息 */
export interface ParseResult {
  orders: Order[]
  /** 响应中携带的账号信息（如有） */
  account?: AccountInfo
  /** 分页状态（如有） */
  pageInfo?: PageInfo
}

/**
 * Cookie 登录态条件（原版京东/拼多多主进程即此机制）：
 * 列出的 Cookie 在本适配器 partition 中全部出现即视为已登录。
 */
export interface LoginCookieCondition {
  name: string
  /** Cookie domain 需包含的后缀（如 'jd.com' / 'yangkeduo.com'） */
  domainIncludes: string
}

export interface LoginDescriptor {
  cookies: LoginCookieCondition[]
  /**
   * 多个 Cookie 的判定方式：`'all'` 全部出现（默认） / `'any'` 任一出现。
   *
   * 京东必须用 `any`：老版登录下发 `thor`+`pin`，新版（2026）改发 `pinId`/`unick`，
   * 写死 `all(thor,pin)` 会出现「页面明明登录了、界面却永远未登录」→ 不触发抓取。
   */
  mode?: 'all' | 'any'
  /** 取哪个 Cookie 的值作为账号标识（不填则仅标记已登录，不暴露令牌值） */
  userIdCookie?: string
  /**
   * 取哪个 Cookie 的值作为昵称，**按顺序取第一个非空**。
   *
   * 各平台昵称存放位置不统一，而且同名 Cookie 在不同入口下可能缺席：
   * - 京东 `unick`
   * - 淘宝 `tracknick`（登录页写）或 `_nk_`（m.taobao.com 写），只配一个就会出现「登录了但没昵称」
   * - 拼多多 `pdd_user_name`
   *
   * 值会做一次 URL 解码 + `\uXXXX` 还原（淘宝的 tracknick 常是 `%5Cu58A8%5Cu8FF9` 这种转义形态）。
   */
  nicknameCookies?: string[]
}

/**
 * 平台适配器。8 个平台工单（006/008/012-018/020）各自实现一份，
 * 核心管道（005 捕获引擎）与导出中心（022）不因新增平台而改动。
 */
export interface PlatformAdapter {
  /** 全局唯一 id，如 'xianyu' / 'jd' / 'taobao' / 'ali1688' / 'mock' */
  id: string
  /** UI 展示名，如 '闲鱼' */
  displayName: string
  /** 平台入口页（Tab 打开时 webview 首次加载的 URL） */
  homeUrl: string
  /** 会话分区名（多账号隔离 Cookie，缺省 `persist:platform-<id>`） */
  partition?: string
  /**
   * Cookie 登录态条件（工单 012/013/015）：声明后由主进程监听 partition Cookie。
   * 闲鱼走页面 SDK 轮询，不声明此项。
   */
  login?: LoginDescriptor
  /** 被动捕获匹配规则（至少一条） */
  matchRules: MatchRule[]
  /**
   * 页面主世界注入脚本（可选，IIFE 字符串）。
   * 只允许调用页面自身 SDK / 读取页面状态，**不得自行构造带签名的请求**（D-2）。
   */
  pageScript?: string
  /** 是否支持卖家订单（当前仅闲鱼 true） */
  supportsSeller: boolean
  /** 导出列 = CORE_EXPORT_COLUMNS 之外的 extended columns；核心列由导出引擎自动附加 */
  columns: ExportColumn[]
  /**
   * 工单 034：平台自定义的**完整列序**（原版列序）。
   *
   * 声明后，导出该平台时直接用这份列表（不再走「核心列 + 扩展列」拼接），
   * 与「各平台各自定义」的决策一致；未声明的平台继续用默认拼接。
   */
  exportColumns?: ExportColumn[]
  /**
   * 把一条捕获响应解析为统一订单。
   * - 数据不符合预期时**抛错**（引擎记录并计入诊断面板 025，不静默丢弃）；
   * - 与本适配器无关的响应不会被路由进来（引擎按 matchRules 过滤）。
   */
  parse(report: CaptureReport): ParseResult
}

/** URL glob → RegExp。`*` 匹配任意字符序列，其余字符按字面量处理。 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** 规则匹配：URL 必须命中；method / kind 声明时必须一致 */
export function matchRuleMatches(
  rule: MatchRule,
  url: string,
  method?: string,
  kind?: CaptureKind
): boolean {
  const matched =
    typeof rule.pattern === 'string' ? globToRegExp(rule.pattern).test(url) : rule.pattern.test(url)
  if (!matched) return false
  if (rule.method && rule.method.toLowerCase() !== (method ?? '').toLowerCase()) return false
  if (rule.kind && rule.kind !== 'any' && kind !== rule.kind) return false
  return true
}
