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
  account?: AccountInfo
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
  /**
   * 需要「强制落盘」的登录 Cookie 名。
   *
   * Electron 只把带过期时间的 Cookie 写进磁盘，**会话级 Cookie（无 Expires）随进程退出消失**，
   * 而且不做 session restore。淘宝的登录身份 `unb` 恰好是会话级 —— 每关一次应用就要重新扫码，
   * 掉线期间的新订单既抓不到也捕获不到，是静默丢单。
   *
   * 声明在这里的 Cookie，会在登录成功时被改写成 180 天有效的持久 Cookie
   * （只改本地过期时间，不动值、不影响服务端校验）。
   * 其它平台（京东 pinId、闲鱼 unb）本来就是持久的，不需要声明。
   */
  persistCookies?: string[]

  /**
   * 把分区里**所有**会话级 Cookie 都改写为持久（2026-11-11）。
   *
   * 只点名几个关键项不够用：淘宝的会话除 `unb`/`cookie2`/`_tb_token_` 外，
   * 还依赖 `sca`、`tbsa`、`_samesite_flag_` 这些同样无 Expires 的项。少一个，
   * 重启后宿主页就直接跳登录页（实测），所以整分区一起落盘才完整。
   *
   * 会对该分区的全部 Cookie 生效，只对「整个分区就是平台登录态」的平台开启。
   */
  persistAllSession?: boolean
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
   * 所有可见平台都必须声明 —— 登录态是界面「已登录/自动抓取」的唯一信号，
   * 没有它扫码成功后界面毫无反馈（2026-11-01 闲鱼踩过：页面脚本通道下线后没兜底）。
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
