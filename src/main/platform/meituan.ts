/**
 * 工单 020：美团外卖订单适配器。
 *
 * **两套接口并存，字段名完全不同（2026-10-26 实测补齐 H5 版）**
 *
 * A. H5 订单页（当前主用，`h5.waimai.meituan.com/waimai/mindex/olist`）：
 *    接口 `i.waimai.meituan.com/openh5/order/list`（GET，带 mtgsig 签名，只能被动捕获）
 *    响应 `{ msg, code, data: { orderList: [...], isEnd, cursor, amount } }`
 *    - 订单号 `orderId`（19 位字符串）
 *    - 门店 `shopName`；状态 `orderStatusStr`
 *    - 金额 `totalPrice`（**字符串，元**）
 *    - 时间 `orderTime`（`YYYY-MM-DD HH:mm`）或 `orderTimeSec`（秒）
 *    - 餐品 `productList[].productName` / `productCount`
 *    - 图片 `img`；详情 `scheme`
 *    ⚠ 之前按小程序的 `wm_order_id` / `poi_name` / `status_description` 取值，
 *    全部取空 → 订单号空串 → 去重时被当成同一单合并 → 界面上永远只有 1~2 条空订单。
 *
 * B. 微信小程序（原版 `wx.waimai.meituan.com`，结构判据 `data.digestlist`）：
 *    `wm_order_id` / `poi_name` / `status_description` / `total` / `product_list`
 *
 * 两种形态在 `normalizeMeituanOrder` 里统一兼容。
 *
 * 本地生活列语义与饿了么共用 `local-life.ts`（工单 018/020 共用要求）。
 *
 * 决策 D-2：只解析页面自身请求的响应，不构造请求（mtgsig 由页面 SDK 计算）。
 */
import { toDateTimeString } from '../../shared/datetime'
import { toMillis } from '../../shared/money'
import { emptyOrder, type Order, type PageInfo } from '../../shared/types/order'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'
import {
  LOCAL_LIFE_COLUMNS,
  joinProductDetails,
  localLifeAmount,
  selfPickLabel,
  unitPriceFrom
} from './local-life'

/** 美团外卖 H5（小程序内嵌页） */
// wx.waimai.meituan.com 是微信小程序的 API 网关（浏览器打开报 50001 找不到请求路径），
// waimai.meituan.com 是商家官网（没有我的订单）。
// C 端真正可用的是 i.waimai.meituan.com：会跳 passport.meituan.com 手机号登录，
// 登录后回到 H5 订单页（2026-10-26 实测）。
// 订单列表页实测地址（i.waimai.meituan.com/order/list 会 302 到这里）
export const MEITUAN_HOME_URL = 'https://h5.waimai.meituan.com/waimai/mindex/olist'
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

interface MeituanProduct {
  product_name?: unknown
  productName?: unknown
  product_count?: unknown
  productCount?: unknown
  product_pic?: unknown
  productImg?: unknown
}

export interface MeituanOrder {
  // ---- H5（openh5/order/list）----
  orderId?: unknown
  shopName?: unknown
  totalPrice?: unknown
  orderTime?: unknown
  orderTimeSec?: unknown
  orderStatusStr?: unknown
  productList?: MeituanProduct[]
  img?: unknown
  scheme?: unknown
  poi_id_str?: unknown
  // ---- 微信小程序（digestlist）----
  wm_order_id?: unknown
  order_id?: unknown
  poi_name?: unknown
  product_list?: MeituanProduct[]
  total?: unknown
  product_total?: unknown
  product_count?: unknown
  status_description?: unknown
  order_time?: unknown
  logistics_status?: unknown
  is_self_pick?: unknown
  estimate_arrival_time?: unknown
  hash_id?: unknown
  format_order_time?: unknown
}

interface MeituanPayload {
  data?: { digestlist?: unknown; orderList?: unknown; isEnd?: unknown; cursor?: unknown }
  userId?: unknown
  userName?: unknown
  status?: unknown
  msg?: unknown
}

/** 从响应取订单数组：H5 `data.orderList` 优先，其次小程序 `data.digestlist` */
export function extractMeituanOrders(body: unknown): MeituanOrder[] {
  const b = body as Record<string, unknown> | null
  const data = (b?.data ?? {}) as Record<string, unknown>
  // 原版小程序是 data.digestlist；H5 是 data.orderList
  const candidates = [
    data.orderList,
    data.digestlist,
    data.list,
    data.order_list,
    data.orderInfoList,
    data.orders,
    b?.digestlist,
    b?.list,
    b?.orderList
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c as MeituanOrder[]
  }
  return []
}

/** 取不到订单时把响应结构暴露出来（只给 key，不含内容），便于定位改版 */
export function meituanShapeHint(body: unknown): string {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return typeof body
  const data = (b.data ?? {}) as Record<string, unknown>
  const keys = Object.keys(data)
  return keys.length ? `data{${keys.slice(0, 8).join(',')}}` : `root{${Object.keys(b).slice(0, 8).join(',')}}`
}

/** 美团图片 http→https，协议相对路径补全（`//p0.meituan.net/...` 在页面内可见） */
export function meituanImageUrl(value: unknown): string {
  const v = str(value)
  if (!v) return ''
  if (v.startsWith('//')) return `https:${v}`
  return v.replace(/^http:\/\//i, 'https://')
}

/** 配送状态码 → 可读文本（美团 logistics_status，0/40 等；未知码保留原值便于诊断） */
function logisticsLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return str(value)
  if (n === 0) return '未配送'
  if (n === 10) return '配送中'
  if (n === 40) return '已送达'
  if (n === 50) return '已完成'
  return `状态码 ${n}`
}

export function normalizeMeituanOrder(raw: MeituanOrder, account = ''): Order {
  const o = emptyOrder('meituan', account)
  // 两套接口的商品数组字段名不同：H5 productList / 小程序 product_list
  const products: MeituanProduct[] = Array.isArray(raw.productList)
    ? raw.productList
    : Array.isArray(raw.product_list)
      ? raw.product_list
      : []
  const first = products[0] ?? {}

  // H5 用 orderId，小程序用 wm_order_id / order_id
  o.orderId = str(raw.orderId ?? raw.wm_order_id ?? raw.order_id)
  // H5 的 orderTimeSec 是秒；orderTime 是 `YYYY-MM-DD HH:mm`（无秒，交给 toDateTimeString 补 00）
  o.createdAt =
    raw.orderTimeSec != null
      ? toDateTimeString(toMillis(raw.orderTimeSec))
      : raw.orderTime != null
        ? toDateTimeString(str(raw.orderTime))
        : toDateTimeString(toMillis(raw.order_time))
  o.title = joinProductDetails(
    products.map((p) => ({
      name: p.productName ?? p.product_name,
      count: p.productCount ?? p.product_count
    }))
  )
  o.imageUrl = meituanImageUrl(raw.img ?? first.productImg ?? first.product_pic)
  // H5 的 totalPrice 是字符串「元」；小程序 total / product_total 是数字「元」
  o.paidAmount = localLifeAmount(raw.totalPrice ?? raw.total ?? raw.product_total)
  const summed = products.reduce((sum, p) => {
    const n = Number(p.productCount ?? p.product_count)
    return Number.isFinite(n) ? sum + n : sum
  }, 0)
  const productCount = Number(raw.product_count ?? (summed > 0 ? summed : products.length))
  o.unitPrice = unitPriceFrom(raw.totalPrice ?? raw.total ?? raw.product_total, productCount)
  o.quantity = Number.isFinite(productCount) && productCount > 0 ? productCount : null
  // H5 用 orderStatusStr；小程序用 status_description
  o.status = str(raw.orderStatusStr ?? raw.status_description)
  // H5 用 shopName；小程序用 poi_name
  o.shopName = str(raw.shopName ?? raw.poi_name)

  o.extra = {
    ...(logisticsLabel(raw.logistics_status) ? { deliveryStatus: logisticsLabel(raw.logistics_status) } : {}),
    ...(raw.is_self_pick != null ? { isSelfPick: selfPickLabel(raw.is_self_pick) } : {}),
    ...(raw.estimate_arrival_time != null
      ? { estimateArrival: toDateTimeString(toMillis(raw.estimate_arrival_time)) ?? '' }
      : {}),
    ...(str(raw.hash_id) ? { hashId: str(raw.hash_id) } : {}),
    // H5 才有：详情页深链（scheme）与门店 poi 标识
    ...(str(raw.scheme) ? { orderDetailUrl: str(raw.scheme) } : {}),
    ...(str(raw.poi_id_str) ? { poiId: str(raw.poi_id_str) } : {})
  }
  return o
}

/**
 * 分页：
 * - H5 `openh5/order/list` 有显式 `data.isEnd`（false = 还有更早订单）+ `cursor`
 * - 小程序 `digestlist` 是滚动加载，接口无显式 hasMore，不臆造
 */
function pageInfoOf(body: unknown): PageInfo | undefined {
  const b = body as Record<string, unknown> | null
  const data = (b?.data ?? {}) as Record<string, unknown>
  if (typeof data.isEnd === 'boolean') {
    return { hasMore: !data.isEnd, cursor: str(data.cursor) || undefined }
  }
  const list = extractMeituanOrders(body)
  if (!list.length) return { hasMore: false }
  return undefined
}

export const meituanAdapter: PlatformAdapter = {
  id: 'meituan',
  displayName: '美团外卖',
  homeUrl: MEITUAN_HOME_URL,
  partition: 'persist:platform-meituan',
  // 美团登录后下发 userId / token / mt_c_token（.meituan.com）+ w_token（i.waimai）。
  // 之前完全没配判定，所以页面里登录了界面也永远「未登录」。
  // 访客只有 _lxsdk_cuid / uuid，不会有 userId，用它做判据最稳。
  login: {
    mode: 'any',
    cookies: [
      { name: 'userId', domainIncludes: 'meituan.com' },
      { name: 'w_token', domainIncludes: 'waimai.meituan.com' },
      { name: 'token', domainIncludes: 'meituan.com' }
    ],
    userIdCookie: 'userId',
    nicknameCookies: ['u']
  },
  matchRules: [
    // 原版：URL 含 https://wx.waimai.meituan.com（宽匹配），结构由 parse 内的 digestlist 判定
    { pattern: /https:\/\/wx\.waimai\.meituan\.com/i },
    // H5 版订单列表（2026-10 实测：h5 页面实际请求 i.waimai.meituan.com/openh5/order/list）
    { pattern: /waimai\.meituan\.com\/openh5\/order\/list/i }
  ],
  supportsSeller: false,
  columns: LOCAL_LIFE_COLUMNS,
  parse(report: CaptureReport): ParseResult {
    const body = report.body as MeituanPayload | null
    const list = extractMeituanOrders(body)
    if (!list.length) {
      // 精确命中 openh5/order/list 却解析不出订单 → 结构变了，把形状报出来
      if (/openh5\/order\/list/i.test(report.url)) {
        throw new Error(`美团订单接口结构未匹配（${meituanShapeHint(body)}），可能已改版`)
      }
      // 同域其他接口（非订单响应）不是错误，静默忽略 —— 原版 c() 判据同语义
      return { orders: [], pageInfo: pageInfoOf(body) }
    }
    // 原版小程序响应带 userId；H5 的 openh5/order/list 不带。
    // 单账号模式下账号归属由分区保证，这里缺失就留空，不能因此丢单。
    const userId = str(body?.userId ?? (body as { data?: { userId?: unknown } })?.data?.userId)
    return {
      orders: list.map((raw) => normalizeMeituanOrder(raw, userId)),
      account: userId
        ? { userId, nickname: str(body?.userName) || undefined }
        : undefined,
      pageInfo: pageInfoOf(body)
    }
  }
}
