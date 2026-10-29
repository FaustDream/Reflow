/**
 * 工单 015：拼多多适配器（2026-10-26 以真机响应为准重写解析）。
 *
 * 真实链路（实测，`persist:platform-pdd` 已登录态）：
 *   订单页 `https://mobile.yangkeduo.com/orders.html`
 *   （⚠ `order.html` 会 302 到 `orders.html`，旧入口地址是错的）
 *   接口   `https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?pdduid=...`
 *   响应   `{ server_time, orders: [...], extra_info, view_list }`
 *
 * 单条订单结构（父订单，含子订单数组）：
 *   {
 *     order_sn: 'PO-261023-...',           // 父订单号
 *     mall: { id, mall_name, logo },        // 店铺
 *     order_status_prompt: '待评价',        // 状态
 *     orders: [{ order_goods: [{ goods_name, goods_price(分), goods_number, thumb_url, spec }],
 *                order_sn: '261023-...' }], // 子订单
 *     display_amount: 1997,                 // 实付，**单位分**
 *     sort_id: '1792758823...',             // 前 10 位是下单时间戳（秒）
 *     order_link_url, tabs_belong
 *   }
 *
 * ⚠ 旧实现按「扁平 order_sn + goods_list + pay_amount」取值，真实响应里一个都没有，
 *   于是只留下订单号、其余全空（用户反馈「拼多多只有订单号」的根因）。
 *   现在按 v4 结构取值；旧的扁平结构（order_list/v1 之类）仍保留兼容分支。
 *
 * 决策 D-2：只解析页面自身请求的响应，不构造请求、不碰 anti_content 等签名参数。
 */
import { toDateTimeString } from '../../shared/datetime'
import { fenToYuan, toMillis } from '../../shared/money'
import { emptyOrder, type ExportColumn, type Order, type PageInfo } from '../../shared/types/order'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'

/** 订单页（`order.html` 会 302 到这里） */
export const PDD_HOME_URL = 'https://mobile.yangkeduo.com/orders.html'

/** v4 接口的单条订单（父订单） */
interface PddV4Goods {
  goods_id?: unknown
  goods_name?: unknown
  goods_price?: unknown
  goods_number?: unknown
  thumb_url?: unknown
  spec?: unknown
}

interface PddV4SubOrder {
  order_goods?: PddV4Goods[]
  order_sn?: unknown
  order_status_prompt?: unknown
}

/**
 * v4 订单有**两种形态**（实测同一响应里混着出现）：
 *
 * A. `type: 1` 普通订单 —— `order_goods` **直接挂在订单上**，还带
 *    `order_time` / `shipping_time` / `receive_time` / `tracking_number`。
 *    这是绝大多数订单（约 95%），旧实现只找 `orders[].order_goods`，
 *    于是这批订单「只有订单号」。
 *
 * B. `type: 2` 多多买菜 —— 商品在 `orders[].order_goods` 里，父级没有 order_goods。
 */
interface PddV4Order {
  type?: unknown
  order_sn?: unknown
  parent_order_sn?: unknown
  order_amount?: unknown
  display_amount?: unknown
  order_time?: unknown
  shipping_time?: unknown
  receive_time?: unknown
  tracking_number?: unknown
  order_goods?: PddV4Goods[]
  mall?: { id?: unknown; mall_name?: unknown; logo?: unknown }
  group_order?: { create_at?: unknown; success_time?: unknown }
  order_status_prompt?: unknown
  orders?: PddV4SubOrder[]
  sort_id?: unknown
  order_link_url?: unknown
  tabs_belong?: unknown[]
}

const pick = (...vs: unknown[]): string => {
  for (const v of vs) {
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

interface PddGoods {
  goods_name?: unknown
  goodsName?: unknown
  goods_thumb_url?: unknown
  thumb_url?: unknown
  image_url?: unknown
  goods_price?: unknown
  price?: unknown
  goods_count?: unknown
  count?: unknown
  quantity?: unknown
  sku?: unknown
  spec?: unknown
  goods_id?: unknown
  goodsId?: unknown
  link?: unknown
  goods_url?: unknown
}

interface PddRawOrder {
  order_sn?: unknown
  orderSn?: unknown
  order_status_text?: unknown
  status_text?: unknown
  orderStatusDesc?: unknown
  mall_name?: unknown
  mallName?: unknown
  mall_id?: unknown
  mallId?: unknown
  goods_list?: PddGoods[]
  goodsList?: PddGoods[]
  address?: { receiver_name?: unknown; receiver_name_sensitive?: unknown; address?: unknown; mobile?: unknown }
  receiver_name?: unknown
  receiver_address?: unknown
  receiver_phone?: unknown
  pay_amount?: unknown
  total_amount?: unknown
  totalAmount?: unknown
  pay_time?: unknown
  shipping_time?: unknown
  ship_time?: unknown
  receive_time?: unknown
  confirm_time?: unknown
  freight?: unknown
  remark?: unknown
  buyer_remark?: unknown
  pay_method?: unknown
  payMethod?: unknown
  tracking?: { company?: unknown; tracking_no?: unknown; status_text?: unknown }
  express_company?: unknown
  tracking_no?: unknown
  tracking_status?: unknown
  created_at?: unknown
  created_time?: unknown
  createTime?: unknown
}

/** 从多种包裹形态取订单数组（观察校准点之一） */
function extractPddArray(body: unknown): PddRawOrder[] {
  const root = (body ?? {}) as any
  const candidate =
    root?.result?.order_list ??
    root?.result?.orders ??
    root?.result?.list ??
    root?.data?.order_list ??
    root?.data?.orders ??
    root?.orders ??
    root?.order_list
  return Array.isArray(candidate) ? (candidate as PddRawOrder[]) : []
}

function pageInfoOf(root: any): PageInfo | undefined {
  const p = root?.result ?? root?.data
  const hasMore = Boolean(p?.has_more ?? p?.hasMore)
  if (!hasMore && !p?.total_count && !p?.total) return undefined
  return {
    hasMore,
    totalCount: Number(p?.total_count ?? p?.total) || undefined
  }
}

export function normalizePddOrder(raw: PddRawOrder, account = ''): Order {
  const goods = (raw.goods_list ?? raw.goodsList ?? []) as PddGoods[]
  const first = goods[0]
  const o = emptyOrder('pdd', account)

  o.orderId = pick(raw.order_sn, raw.orderSn)
  o.title = goods.map((g) => pick(g.goods_name, g.goodsName)).filter(Boolean).join('；')
  o.imageUrl = pick(first?.goods_thumb_url, first?.thumb_url, first?.image_url)
  o.paidAmount = pick(raw.pay_amount, raw.total_amount, raw.totalAmount)
  o.unitPrice = pick(first?.goods_price, first?.price)
  const qty = goods.reduce((sum, g) => {
    const n = Number(pick(g.goods_count, g.count, g.quantity))
    return Number.isFinite(n) ? sum + n : sum
  }, 0)
  o.quantity = qty > 0 ? qty : null
  o.status = pick(raw.order_status_text, raw.status_text, raw.orderStatusDesc)
  o.shopName = pick(raw.mall_name, raw.mallName)
  o.createdAt = toDateTimeString(pick(raw.created_at, raw.created_time, raw.createTime))
  o.paidAt = toDateTimeString(pick(raw.pay_time))
  o.shippedAt = toDateTimeString(pick(raw.shipping_time, raw.ship_time))
  o.completedAt = toDateTimeString(pick(raw.receive_time, raw.confirm_time))
  o.receiverName = pick(raw.address?.receiver_name, raw.address?.receiver_name_sensitive, raw.receiver_name)
  o.receiverAddress = pick(raw.address?.address, raw.receiver_address)
  o.receiverPhone = pick(raw.address?.mobile, raw.receiver_phone)
  o.logisticsCompany = pick(raw.tracking?.company, raw.express_company)
  o.trackingNo = pick(raw.tracking?.tracking_no, raw.tracking_no)

  o.extra = {
    ...(pick(raw.mall_id, raw.mallId) ? { mallId: pick(raw.mall_id, raw.mallId) } : {}),
    ...(pick(first?.goods_id, first?.goodsId) ? { goodsId: pick(first?.goods_id, first?.goodsId) } : {}),
    ...(goods.map((g) => pick(g.sku, g.spec)).filter(Boolean).join('；')
      ? { skuSpec: goods.map((g) => pick(g.sku, g.spec)).filter(Boolean).join('；') }
      : {}),
    ...(pick(first?.link, first?.goods_url) ? { itemUrl: pick(first?.link, first?.goods_url) } : {}),
    ...(pick(raw.pay_method, raw.payMethod) ? { payMethod: pick(raw.pay_method, raw.payMethod) } : {}),
    ...(pick(raw.remark, raw.buyer_remark) ? { remark: pick(raw.remark, raw.buyer_remark) } : {}),
    ...(pick(raw.freight) ? { freight: pick(raw.freight) } : {}),
    ...(pick(raw.tracking?.status_text, raw.tracking_status)
      ? { trackingStatus: pick(raw.tracking?.status_text, raw.tracking_status) }
      : {})
  }
  return o
}

/** 子单号 `261023-396304074272433` 的前 6 位是 YYMMDD（订单号格式约定） */
function dateFromSubSn(sn: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(sn)
  if (!m) return ''
  return `20${m[1]}-${m[2]}-${m[3]} 00:00:00`
}

/** v4 的 `sort_id` 前 10 位是下单秒级时间戳（`1792758823` + 子单号 + `0000`） */
function timeFromSortId(sortId: string): string | null {
  if (!/^\d{16,}$/.test(sortId)) return null
  const sec = Number(sortId.slice(0, 10))
  if (!Number.isFinite(sec) || sec < 1e9) return null
  return toDateTimeString(sec * 1000)
}

/** 拼多多图片 URL 补全（接口给的是 https 绝对地址，个别为协议相对） */
function pddImageUrl(value: unknown): string {
  const v = pick(value)
  if (!v) return ''
  return v.startsWith('//') ? `https:${v}` : v
}

/** 订单链接是站内相对路径（`ywgnpxpt.html?...`），补全为可点开的绝对地址 */
function pddLinkUrl(value: unknown): string {
  const v = pick(value)
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  return `https://mobile.yangkeduo.com/${v.replace(/^\/+/, '')}`
}

/**
 * 拼多多 `order_list_v4` 单条订单 → 统一 Order。
 *
 * 一个父订单可能含多个子订单（不同店铺/不同商品），这里**按父订单一行**，
 * 商品名与规格拼接、数量汇总，子单号进 extra（与京东/淘宝「一笔订单一行」一致）。
 * 金额接口给的是**分**，统一走 `fenToYuan`。
 */
export function normalizePddV4Order(raw: PddV4Order, account = ''): Order {
  const subs = Array.isArray(raw.orders) ? raw.orders : []
  // 形态 A：order_goods 直接挂在订单上；形态 B：在子订单里
  const goods: PddV4Goods[] = subs.length
    ? subs.flatMap((s) => (Array.isArray(s.order_goods) ? s.order_goods : []))
    : Array.isArray(raw.order_goods)
      ? raw.order_goods
      : []
  const first = goods[0] ?? {}
  const o = emptyOrder('pdd', account)

  o.orderId = pick(raw.order_sn, subs[0]?.order_sn)
  o.title = goods
    .map((g) => pick(g.goods_name))
    .filter(Boolean)
    .join('；')
  o.imageUrl = pddImageUrl(first.thumb_url)
  o.paidAmount = fenToYuan(raw.display_amount ?? raw.order_amount)
  o.unitPrice = fenToYuan(first.goods_price)
  const qty = goods.reduce((sum, g) => {
    const n = Number(pick(g.goods_number))
    return Number.isFinite(n) ? sum + n : sum
  }, 0)
  o.quantity = qty > 0 ? qty : null
  o.status = pick(raw.order_status_prompt, subs[0]?.order_status_prompt)
  o.shopName = pick(raw.mall?.mall_name)
  // 时间优先级：order_time（形态 A，精确到秒）> sort_id 前缀 > 拼团创建时间 > 子单号日期
  const groupCreateAt = Number(pick(raw.group_order?.create_at))
  o.createdAt =
    toDateTimeString(toMillis(pick(raw.order_time))) ??
    timeFromSortId(pick(raw.sort_id)) ??
    (Number.isFinite(groupCreateAt) && groupCreateAt > 0
      ? toDateTimeString(groupCreateAt)
      : null) ??
    (dateFromSubSn(pick(subs[0]?.order_sn)) || null)
  // 形态 A 才有的物流时间与运单号
  o.shippedAt = toDateTimeString(toMillis(pick(raw.shipping_time)))
  o.completedAt = toDateTimeString(toMillis(pick(raw.receive_time)))
  o.trackingNo = pick(raw.tracking_number)

  o.extra = {
    ...(pick(raw.mall?.id) ? { mallId: pick(raw.mall?.id) } : {}),
    ...(pick(first.goods_id) ? { goodsId: pick(first.goods_id) } : {}),
    ...(goods.map((g) => pick(g.spec)).filter(Boolean).join('；')
      ? { skuSpec: goods.map((g) => pick(g.spec)).filter(Boolean).join('；') }
      : {}),
    ...(pddLinkUrl(raw.order_link_url) ? { itemUrl: pddLinkUrl(raw.order_link_url) } : {}),
    ...(subs.map((s) => pick(s.order_sn)).filter(Boolean).join(',')
      ? { subOrderIds: subs.map((s) => pick(s.order_sn)).filter(Boolean).join(',') }
      : {})
  }
  return o
}

/** 判断一批订单是不是 v4 结构（父订单 + mall / display_amount / 子订单数组） */
function isPddV4List(list: PddRawOrder[]): boolean {
  const first = list[0] as unknown as PddV4Order | undefined
  if (!first || typeof first !== 'object') return false
  return (
    first.mall !== undefined ||
    first.display_amount !== undefined ||
    (Array.isArray(first.orders) && first.orders.length > 0)
  )
}

export const pddAdapter: PlatformAdapter = {
  id: 'pdd',
  displayName: '拼多多',
  homeUrl: PDD_HOME_URL,
  partition: 'persist:platform-pdd',
  // 原版 asar_pdd main.js：PDDAccessToken 出现即登录（令牌值不外显）
  login: {
    cookies: [{ name: 'PDDAccessToken', domainIncludes: 'yangkeduo' }],
    // 拼多多把昵称存在 pdd_user_name（URL 编码）；之前完全没配，界面上永远只能显示「已登录」
    nicknameCookies: ['pdd_user_name']
  },
  matchRules: [
    // 实测主接口（2026-10-26）：orders.html 首屏与滚动分页都走这个
    { pattern: /yangkeduo\.com\/proxy\/api\/api\/aristotle\/order_list_v4/i },
    // 兼容旧端点（proxy/api 前缀 + 路径含 order…list）
    { pattern: /yangkeduo\.com\/proxy\/api\/[a-z0-9_/]*order[a-z0-9_]*list(\/v\d+)?/i },
    // 个别版本无 proxy 前缀
    { pattern: /yangkeduo\.com\/(api\/)?[a-z0-9_]*order[a-z0-9_]*list(\/v\d+)?/i }
  ],
  supportsSeller: false,
  // 25 列中 core 未覆盖的部分（附录 A.1）；core 列已含图片/日期/订单ID/商品名/图/价格/实付/数量/
  // 店名/状态/收货人/地址/电话/快递/运单号/付款/发货/收货时间
  columns: [
    { key: 'goodsId', header: '商品ID', width: 16 },
    { key: 'itemUrl', header: '商品链接', width: 30 },
    { key: 'mallId', header: '店ID', width: 14 },
    { key: 'skuSpec', header: '规格', width: 20 },
    { key: 'freight', header: '运费', width: 8 },
    { key: 'payMethod', header: '支付方式', width: 12 },
    { key: 'remark', header: '备注', width: 20 },
    { key: 'trackingStatus', header: '快递状态', width: 12 }
  ] as ExportColumn[],
  /**
   * 工单 034：原版拼多多 25 列列序（方案附录 A.1，证据 `pdd-no-images.xlsx`）。
   * 「商品图片(内嵌)」由导出引擎的含图开关负责，不占列表列位。
   */
  exportColumns: [
    { key: 'createdAt', header: '下单日期', width: 20, format: 'datetime' },
    { key: 'goodsId', header: '商品ID', width: 16 },
    { key: 'itemUrl', header: '商品链接', width: 30 },
    { key: 'orderId', header: '订单ID', width: 22 },
    { key: 'title', header: '商品名', width: 36 },
    { key: 'imageUrl', header: '商品图(URL)', width: 30 },
    { key: 'unitPrice', header: '价格', width: 10, format: 'number' },
    { key: 'paidAmount', header: '实付', width: 10, format: 'number' },
    { key: 'skuSpec', header: '规格', width: 20 },
    { key: 'quantity', header: '数量', width: 6, format: 'number' },
    { key: 'shopName', header: '店名', width: 18 },
    { key: 'mallId', header: '店ID', width: 14 },
    { key: 'status', header: '订单状态', width: 12 },
    { key: 'receiverName', header: '收货人名', width: 10 },
    { key: 'receiverAddress', header: '收货地址', width: 40 },
    { key: 'receiverPhone', header: '收货电话', width: 14 },
    { key: 'logisticsCompany', header: '快递公司', width: 12 },
    { key: 'trackingNo', header: '运单号', width: 20 },
    { key: 'freight', header: '运费', width: 8, format: 'number' },
    { key: 'payMethod', header: '支付方式', width: 12 },
    { key: 'shippedAt', header: '发货时间', width: 20, format: 'datetime' },
    { key: 'remark', header: '备注', width: 20 },
    { key: 'trackingStatus', header: '快递状态', width: 12 },
    { key: 'completedAt', header: '收货时间', width: 20, format: 'datetime' },
    { key: 'account', header: '用户名', width: 16 }
  ] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const body = report.body as any
    const list = extractPddArray(body)
    if (!list.length) {
      // 精确命中订单接口却解析不出 → 报错（结构可能改版）；
      // 同域其他接口（`my_order_group` 等返回 `{}`）静默忽略，不刷诊断噪音。
      if (!/order[a-z0-9_]*list/i.test(report.url)) {
        return { orders: [], pageInfo: undefined }
      }
      // 未登录时 PDD 接口返回错误码包裹；登录检测由 PDDAccessToken cookie 负责
      const errText = pick(body?.error_msg, body?.errorMsg, body?.result?.error_msg)
      throw new Error(`拼多多订单响应中未找到订单数组${errText ? `：${errText}` : '（可能未登录）'}`)
    }
    // 多账号时 PDD 响应携带用户标识的常见字段；取不到则为空，去重仍按平台+单号
    const account = pick(body?.result?.user?.uid, body?.result?.mall_id, body?.data?.uid)
    // v4（父订单 + mall/display_amount）与旧扁平结构走各自的归一化
    const v4 = isPddV4List(list)
    return {
      orders: v4
        ? (list as unknown as PddV4Order[]).map((raw) => normalizePddV4Order(raw, account))
        : list.map((raw) => normalizePddOrder(raw, account)),
      pageInfo: pageInfoOf(body)
    }
  }
}
