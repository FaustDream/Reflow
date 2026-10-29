/**
 * 工单 006：闲鱼（goofish）买家订单列表适配器。
 *
 * 捕获对象：用户浏览 https://www.goofish.com/bought 时页面自身发出的
 *   `h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list` 响应（xhr/fetch 两形态）。
 * 解析路径依据方案附录 B.2（60 条字段路径，源自真实快照校验）；
 * 字段映射与原版 `orders.js#normalizeOrders` 一致：
 *   orderId ← commonData.orderIdStr ?? orderId
 *   createdAt ← head.data.createTime；title ← content.data.detailInfo.auctionTitle
 *   图 ← auctionPic（http→https、截断 ?#、补 `_220x10000Q90.jpg`）
 *   实付 ← priceInfo.price；数量 ← priceInfo.buyAmount；状态 ← head.data.statusViewMsg
 *   卖家 ← head.data.userInfo.userNick/userId；商品ID ← commonData.itemId
 * 登录态由页面脚本（shared/page-scripts/xianyu.ts）经页面官方 SDK 轮询上报。
 *
 * 决策 D-2：本适配器从不发起请求，只解析页面自身请求的响应。
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type ExportColumn, type Order, type PageInfo } from '../../shared/types/order'
import { installXianyuPageScript } from '../../shared/page-scripts/xianyu'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'

/** 闲鱼买家订单列表页（webview 首屏） */
export const XIANYU_HOME_URL = 'https://www.goofish.com/bought'

/** 缩略图后缀：与原版 compressOrderImageUrl 一致（工单 009 图片下载复用） */
const IMAGE_THUMB_SUFFIX = '_220x10000Q90.jpg'

/** 规整商品图 URL：http→https、截断 ?/#、补缩略图后缀（不重复追加） */
export function compressXianyuImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const base = value
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .split(/[?#]/)[0]
  if (!base) return ''
  return base.endsWith(IMAGE_THUMB_SUFFIX) ? base : base + IMAGE_THUMB_SUFFIX
}

/** 闲鱼 nextPage 兼容布尔与字符串 "true"（原版 isNextPage） */
export function isXianyuNextPage(value: unknown): boolean {
  return value === true || value === 'true'
}

/** 真正的会话失效：只有它才提示「未登录」 */
export function isXianyuSessionExpired(retText: string): boolean {
  return /SESSION_EXPIRED/i.test(retText)
}

/**
 * mtop 令牌瞬时失败（令牌为空/过期，含阿里官方拼写 FAIL_SYS_TOKEN_EXOIRED）：
 * 页面官方 SDK 会自动取新令牌并重试同请求，被动捕获会看到「先失败后成功」两条响应。
 * 首条失败不应当成解析异常/未登录吓到用户，静默忽略即可。
 */
export function isXianyuTokenTransient(retText: string): boolean {
  // FAIL_SYS_SESSION_EXPIRED 不含 TOKEN，不会被此规则误吞；令牌类一律视为瞬时
  return /FAIL_SYS_TOKEN/i.test(retText)
}

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

interface XianyuItem {
  commonData?: {
    orderId?: unknown
    orderIdStr?: unknown
    itemId?: unknown
    peerUserId?: unknown
    utArgs?: { idleBizCode?: unknown }
  }
  head?: {
    data?: {
      createTime?: unknown
      statusViewMsg?: unknown
      userInfo?: { userId?: unknown; userNick?: unknown; userIcon?: unknown }
    }
  }
  content?: {
    data?: {
      detailInfo?: { auctionTitle?: unknown; auctionPic?: unknown }
      priceInfo?: { price?: unknown; buyAmount?: unknown; auctionPriceDesc?: unknown }
    }
  }
}

/** 单条列表 item → 统一 Order（附录 B.2 路径）。卖家单（工单 011）结构同构，仅 platform 不同 */
export function normalizeXianyuItem(raw: unknown, platform: 'xianyu' | 'xianyu-sold' = 'xianyu'): Order {
  const item = (raw ?? {}) as XianyuItem
  const order = emptyOrder(platform)
  order.orderId = str(item.commonData?.orderIdStr ?? item.commonData?.orderId)
  order.createdAt = toDateTimeString(item.head?.data?.createTime as string | number)
  order.title = str(item.content?.data?.detailInfo?.auctionTitle)
  order.imageUrl = compressXianyuImageUrl(item.content?.data?.detailInfo?.auctionPic)
  order.paidAmount = str(item.content?.data?.priceInfo?.price)
  const qty = Number(item.content?.data?.priceInfo?.buyAmount)
  order.quantity = Number.isFinite(qty) && item.content?.data?.priceInfo?.buyAmount != null ? qty : null
  order.status = str(item.head?.data?.statusViewMsg)
  // 买家视角：userInfo 是卖家昵称；卖家视角（sold）：userInfo 是买家昵称 → core 店铺列承载对方昵称
  order.shopName = str(item.head?.data?.userInfo?.userNick)
  order.extra = {
    ...(item.commonData?.itemId != null ? { itemId: str(item.commonData.itemId) } : {}),
    ...(item.head?.data?.userInfo?.userId != null
      ? { sellerId: str(item.head.data.userInfo.userId) }
      : {}),
    ...(item.commonData?.utArgs?.idleBizCode != null
      ? { idleBizCode: str(item.commonData.utArgs.idleBizCode) }
      : {}),
    ...(item.content?.data?.priceInfo?.auctionPriceDesc != null
      ? { priceLabel: str(item.content.data.priceInfo.auctionPriceDesc) }
      : {})
  }
  return order
}

interface XianyuListPayload {
  data?: { items?: unknown; nextPage?: unknown; lastEndRow?: unknown; totalCount?: unknown }
  ret?: unknown
}

const pageInfoOf = (data: NonNullable<XianyuListPayload['data']>): PageInfo => {
  const totalCount = Number(data.totalCount)
  return {
    hasMore: isXianyuNextPage(data.nextPage),
    // 实测 totalCount 恒为 "0"（原版 AGENTS.md 记录），仅非 0 时下发
    totalCount: Number.isFinite(totalCount) && totalCount > 0 ? totalCount : undefined,
    cursor: str(data.lastEndRow) || undefined
  }
}

/** 闲鱼适配器（买家订单；卖家单在工单 011，详情二次抓取在 008） */
export const xianyuAdapter: PlatformAdapter = {
  id: 'xianyu',
  displayName: '闲鱼',
  homeUrl: XIANYU_HOME_URL,
  // 独立会话分区；021 多账号时按账号追加分区
  partition: 'persist:platform-xianyu',
  matchRules: [
    // mtop 列表接口为页面自身发出的 xhr/fetch；JSONP 形态不存在，不声明
    { pattern: '*.goofish.com/h5/mtop.idle.web.trade.bought.list*', kind: 'xhr' },
    { pattern: '*.goofish.com/h5/mtop.idle.web.trade.bought.list*', kind: 'fetch' }
  ],
  pageScript: `(${installXianyuPageScript.toString()})`,
  supportsSeller: false,
  columns: [
    { key: 'itemId', header: '商品ID', width: 16 },
    { key: 'sellerId', header: '卖家ID', width: 14 },
    { key: 'idleBizCode', header: '业务类型', width: 10 },
    { key: 'priceLabel', header: '价格标签', width: 10 }
  ] as ExportColumn[],
  /**
   * 工单 034：原版 `xy-web-order` 的 17 列列序（从 `lib/orders.js` 的 EXPORT_COLUMNS 提取），
   * 老用户从原版迁过来时列的位置完全一致。
   */
  exportColumns: [
    { key: 'orderId', header: '订单号', width: 24 },
    { key: 'createdAt', header: '创建时间', width: 20, format: 'datetime' },
    { key: 'title', header: '商品标题', width: 36 },
    { key: 'imageUrl', header: '商品图片', width: 30 },
    { key: 'paidAmount', header: '实付款', width: 12, format: 'number' },
    { key: 'quantity', header: '数量', width: 6, format: 'number' },
    { key: 'status', header: '订单状态', width: 12 },
    { key: 'shopName', header: '卖家昵称', width: 16 },
    { key: 'sellerId', header: '卖家ID', width: 14 },
    { key: 'itemId', header: '商品ID', width: 16 },
    { key: 'receiverAddress', header: '收货地址', width: 40 },
    { key: 'freight', header: '运费', width: 10 },
    { key: 'coinDiscount', header: '闲鱼币抵扣', width: 12 },
    { key: 'alipayTradeNo', header: '支付宝交易号', width: 24 },
    { key: 'paidAt', header: '付款时间', width: 20, format: 'datetime' },
    { key: 'shippedAt', header: '发货时间', width: 20, format: 'datetime' },
    { key: 'completedAt', header: '成交时间', width: 20, format: 'datetime' }
  ] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const payload = report.body as XianyuListPayload | null
    if (!payload || typeof payload !== 'object') {
      throw new Error(`闲鱼列表响应结构异常：期望对象，实际 ${typeof report.body}`)
    }

    const retText = Array.isArray(payload.ret) ? payload.ret.join(';') : str(payload.ret)
    if (isXianyuSessionExpired(retText)) {
      // 未登录/会话过期响应形如 { data: {}, ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] }
      throw new Error('闲鱼会话已过期（未登录），请在页面中完成登录')
    }
    if (isXianyuTokenTransient(retText)) {
      // 令牌为空/过期的瞬时响应（SDK 会自动刷新并重试），不计解析异常
      return { orders: [] }
    }
    if (!payload.data || !Array.isArray(payload.data.items)) {
      throw new Error(
        `闲鱼列表响应结构异常：期望 data.items 数组${retText ? `，ret=${retText}` : ''}`
      )
    }

    // 注意：不可直接 .map(normalizeXianyuItem)——map 第二参会是数组下标，会覆盖 platform
    const orders = (payload.data.items as unknown[]).map((raw) => normalizeXianyuItem(raw))
    return { orders, pageInfo: pageInfoOf(payload.data) }
  }
}