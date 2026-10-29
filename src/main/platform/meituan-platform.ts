/**
 * 美团平台（综合）订单适配器 —— 工单 020 扩展。
 *
 * 美团 App 内有两套订单体系：
 * A. **美团外卖**（`meituan` 适配器，已实现）：`h5.waimai.meituan.com/waimai/mindex/olist`
 * B. **美团平台**（本适配器）：酒店、电影、团购、买菜、打车等综合订单
 *
 * ⚠️ 2026-10-29 实测：**美团 C 端综合订单没有可用的 Web 入口**。
 *    - 原入口 `https://i.meituan.com/account/order` 已 404（返回「信息未找到」）
 *    - `i.meituan.com/awp/h5/mine|order/*` 全部 NoSuchKey
 *    - `www.meituan.com/ordercenterlist` 跳回企业官网首页
 *    - 大众点评 `m.dianping.com/mine|order/*` 一律「请下载 App」
 *    - 接口 `i.meituan.com/api/poi/order/list` 在 meituan 域外跨域不可达，
 *      域内也没有任何页面会去调它
 *    所以本适配器**只能靠 MITM 被动捕获 App 流量**（App 内订单页才是真数据源）。
 *    `homeUrl` 指向美团首页仅作登录/占位，不会产生订单。
 *
 * 📌 2026-10-29 用户决定：暂时不做美团综合订单，本适配器已加入
 *    `HIDDEN_PLATFORMS`（界面不显示），代码保留。将来美团若开放 Web 入口、
 *    或愿意走 MITM 抓 App，把它从隐藏列表移出即可恢复，无需重写。
 *
 * 接口（MITM 捕获时匹配）：`https://i.meituan.com/api/poi/order/list`
 * 响应 `{ data: { orderList: [...], hasMore, nextCursor } }`
 *
 * 字段映射（与外卖适配器兼容，复用 `normalizeMeituanOrder`）：
 * - 订单号 `orderId`（19 位）
 * - 商户 `shopName` / `poiName`
 * - 金额 `totalPrice`（字符串「元」）/ `total`
 * - 时间 `orderTime` / `createTime`
 * - 状态 `orderStatusStr` / `statusText`
 * - 商品 `productList[]`（含 productName / productCount）
 * - 图片 `img` / `pic`
 * - 类目 `category`（hotel / movie / group / grocery / taxi 等）
 *
 * 与外卖数据合并时按 `orderId` 去重（两套接口可能返回同一订单）。
 * 账号与美团外卖共用 `persist:platform-meituan`，登录一次即可。
 */
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'
import { type Order, type PageInfo } from '../../shared/types/order'
import { LOCAL_LIFE_COLUMNS } from './local-life'
import { normalizeMeituanOrder, type MeituanOrder } from './meituan'

/**
 * 打开面板时加载的页面。
 *
 * 综合订单没有 Web 入口（见文件头），这里只放一个能正常打开的页面，
 * 让「打开页面」不至于 404；真正的数据靠 MITM 捕获 App 流量。
 * 账号与外卖共用分区，所以这里打开也是已登录状态。
 */
export const MEITUAN_PLATFORM_HOME_URL = 'https://www.meituan.com/'

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

interface MeituanPlatformPayload {
  data?: {
    orderList?: unknown
    orders?: unknown
    hasMore?: unknown
    nextCursor?: unknown
    list?: unknown
  }
  code?: unknown
  msg?: unknown
}

/** 从响应取订单数组（美团综合接口的字段名与外卖略有不同） */
export function extractMeituanPlatformOrders(body: unknown): MeituanOrder[] {
  const b = body as Record<string, unknown> | null
  const data = (b?.data ?? {}) as Record<string, unknown>
  const candidates = [data.orderList, data.orders, data.list, b?.orderList, b?.orders]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c as MeituanOrder[]
  }
  return []
}

/** 取不到订单时把响应结构暴露出来（只给 key，不含内容） */
export function meituanPlatformShapeHint(body: unknown): string {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return typeof body
  const data = (b.data ?? {}) as Record<string, unknown>
  const keys = Object.keys(data)
  return keys.length ? `data{${keys.slice(0, 8).join(',')}}` : `root{${Object.keys(b).slice(0, 8).join(',')}}`
}

/** 分页：美团综合接口用 hasMore + nextCursor */
function pageInfoOf(body: unknown): PageInfo | undefined {
  const b = body as Record<string, unknown> | null
  const data = (b?.data ?? {}) as Record<string, unknown>
  if (typeof data.hasMore === 'boolean') {
    return { hasMore: data.hasMore, cursor: str(data.nextCursor) || undefined }
  }
  const list = extractMeituanPlatformOrders(body)
  if (!list.length) return { hasMore: false }
  return undefined
}

/** 美团综合订单归一化（复用外卖的 normalizeMeituanOrder，补 category 字段） */
export function normalizeMeituanPlatformOrder(raw: MeituanOrder, account = ''): Order {
  const o = normalizeMeituanOrder(raw, account)
  o.platform = 'meituan-platform'
  // 综合订单有 category 字段（hotel / movie / group / grocery / taxi 等）
  const category = str((raw as Record<string, unknown>).category ?? (raw as Record<string, unknown>).orderCategory)
  if (category) {
    o.extra = { ...o.extra, category }
  }
  return o
}

export const meituanPlatformAdapter: PlatformAdapter = {
  id: 'meituan-platform',
  displayName: '美团平台',
  homeUrl: MEITUAN_PLATFORM_HOME_URL,
  partition: 'persist:platform-meituan',
  login: {
    mode: 'any',
    cookies: [
      { name: 'userId', domainIncludes: 'meituan.com' },
      { name: 'token', domainIncludes: 'meituan.com' }
    ],
    userIdCookie: 'userId',
    nicknameCookies: ['u']
  },
  matchRules: [
    // 美团综合订单接口
    { pattern: /i\.meituan\.com\/api\/poi\/order\/list/i },
    { pattern: /i\.meituan\.com\/account\/order/i },
    // 美团 App 内嵌页
    { pattern: /meituan\.com\/api\/.*order/i }
  ],
  supportsSeller: false,
  columns: LOCAL_LIFE_COLUMNS,
  parse(report: CaptureReport): ParseResult {
    const body = report.body as MeituanPlatformPayload | null
    const list = extractMeituanPlatformOrders(body)
    if (!list.length) {
      if (/order\/list/i.test(report.url)) {
        throw new Error(`美团平台订单接口结构未匹配（${meituanPlatformShapeHint(body)}），可能已改版`)
      }
      return { orders: [], pageInfo: pageInfoOf(body) }
    }
    const userId = str((body as Record<string, unknown>)?.userId)
    return {
      orders: list.map((raw) => normalizeMeituanPlatformOrder(raw, userId)),
      account: userId ? { userId, nickname: str((body as Record<string, unknown>)?.userName) || undefined } : undefined,
      pageInfo: pageInfoOf(body)
    }
  }
}
