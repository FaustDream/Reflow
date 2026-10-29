/**
 * 工单 012：京东订单适配器（TBD-7 双模式结论中的 JSON 分支）。
 *
 * 被动捕获：用户浏览 order.jd.com 订单中心时页面自身发出的
 *   `order.jd.com/center/list.action?...&__fetch__=1` XHR/fetch（响应为订单数组），
 *   以及 api.m.jd.com `pcorder_center_list`（响应包裹在 data.orderList）。
 *
 * 字段路径取自 asar_jd/dist/electron/renderer.js 明文 webpack 包的归一化函数：
 *   consigneeInfo{customerName,address,mobile} / shopInfo{shopName,shopUrl}
 *   itemPayInfo{fistPrice(原版拼写),paymentTypeName} / statusInfo.orderStateName
 *   wareList[]{name,imgPath,num,wareUrl} / dateSubmit / orderId
 * 登录态（thor+pin Cookie）在主进程 cookie-login.ts 监听，不在本文件。
 *
 * 决策 D-2：本适配器只解析页面自身请求的响应，不构造任何请求。
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type ExportColumn, type Order } from '../../shared/types/order'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'

export const JD_HOME_URL = 'https://order.jd.com/center/list.action'

interface JdWare {
  name?: unknown
  imgPath?: unknown
  num?: unknown
  wareUrl?: unknown
}
interface JdPayInfo {
  /** 京东把 firstPrice 拼成了 fistPrice，普通订单只给这个 */
  fistPrice?: unknown
  /** 虚拟/服务类订单（互联网医院、话费充值）没有 fistPrice，只有这三个 */
  shouldPay?: unknown
  totalPrice?: unknown
  price?: unknown
  paymentTypeName?: unknown
}
interface JdRawOrder {
  orderId?: unknown
  dateSubmit?: unknown
  consigneeInfo?: { customerName?: unknown; address?: unknown; mobile?: unknown }
  shopInfo?: { shopName?: unknown; shopUrl?: unknown }
  itemPayInfo?: JdPayInfo
  statusInfo?: { orderStateName?: unknown; orderState?: unknown }
  wareList?: JdWare[]
}

/**
 * `statusInfo.orderState` 数字码 → 文案。
 *
 * 普通订单接口会直接给 `orderStateName`，只有虚拟/服务类订单（京东互联网医院、
 * 话费充值等）省略了它，只留数字码（2026-10-29 抓包实测）。这里只收录已核实的码，
 * 未收录的返回空串 —— 宁可不显示，也不要猜错状态。
 * `18 = 已完成`：同一批响应里普通订单的 `orderStateName` 就是「已完成」。
 */
const JD_ORDER_STATE: Record<string, string> = {
  '18': '已完成'
}

/** 取第一个「存在且非空」的金额字段：0 是合法值（免费问诊/赠品单），不能用 `||` */
function firstAmount(pay: JdPayInfo | undefined): string {
  if (!pay) return ''
  for (const key of ['fistPrice', 'shouldPay', 'totalPrice', 'price'] as const) {
    const v = pay[key]
    if (v === undefined || v === null || v === '') continue
    const s = str(v)
    if (s !== '') return s
  }
  return ''
}

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

/** 京东图片为协议相对路径时补 https（原版 normalizeJdImageUrl 仅裁剪尺寸，这里只做协议规整） */
function absoluteImg(url: unknown): string {
  const v = str(url)
  if (!v) return ''
  if (v.startsWith('//')) return `https:${v}`
  return v.startsWith('http') ? v : ''
}

/** 从两种响应包裹中取订单数组：裸数组（__fetch__）或 data.orderList / data.data.orderList */
export function extractJdOrderArray(body: unknown): JdRawOrder[] {
  if (Array.isArray(body)) return body as JdRawOrder[]
  const root = (body ?? {}) as {
    data?: { orderList?: unknown; data?: { orderList?: unknown } }
  }
  const list = root.data?.orderList ?? root.data?.data?.orderList
  return Array.isArray(list) ? (list as JdRawOrder[]) : []
}

export function normalizeJdOrder(raw: JdRawOrder): Order {
  const o = emptyOrder('jd')
  o.orderId = str(raw.orderId)
  o.createdAt = toDateTimeString(raw.dateSubmit as string | number)
  o.status =
    str(raw.statusInfo?.orderStateName) ||
    JD_ORDER_STATE[str(raw.statusInfo?.orderState)] ||
    ''
  o.paidAmount = firstAmount(raw.itemPayInfo)
  o.shopName = str(raw.shopInfo?.shopName) || '京东'
  o.receiverName = str(raw.consigneeInfo?.customerName)
  o.receiverAddress = str(raw.consigneeInfo?.address)
  o.receiverPhone = str(raw.consigneeInfo?.mobile)

  const wares = Array.isArray(raw.wareList) ? raw.wareList : []
  // 统一模型一单一行：多商品标题以「；」连接，图片/链接取首件
  o.title = wares.map((w) => str(w.name)).filter(Boolean).join('；')
  o.imageUrl = absoluteImg(wares[0]?.imgPath)
  const qty = wares.reduce((sum, w) => {
    const n = Number(w.num)
    return Number.isFinite(n) ? sum + n : sum
  }, 0)
  o.quantity = qty > 0 ? qty : null

  o.extra = {
    ...(raw.itemPayInfo?.paymentTypeName != null
      ? { payMethod: str(raw.itemPayInfo.paymentTypeName) }
      : {}),
    ...(raw.shopInfo?.shopUrl != null ? { shopUrl: str(raw.shopInfo.shopUrl) } : {}),
    itemCount: String(wares.length),
    ...(wares[0]?.wareUrl != null ? { itemUrl: str(wares[0].wareUrl) } : {})
  }
  return o
}

export const jdAdapter: PlatformAdapter = {
  id: 'jd',
  displayName: '京东',
  homeUrl: JD_HOME_URL,
  partition: 'persist:platform-jd',
  // 京东登录态：老版下发 thor+pin；新版（2026-10 实测）只发 pinId/unick（非 httpOnly）。
  // 用 any 覆盖两代，否则会出现「页面已登录、界面永远未登录」→ 不触发抓取。
  login: {
    mode: 'any',
    cookies: [
      { name: 'thor', domainIncludes: 'jd.com' },
      { name: 'pin', domainIncludes: 'jd.com' },
      // unick = 登录后的昵称，访客不会有；比 pinId 更可靠（pinId 访客也可能有）
      { name: 'unick', domainIncludes: 'jd.com' }
    ],
    userIdCookie: 'pinId',
    nicknameCookies: ['unick']
  },
  matchRules: [
    // list.action 带 __fetch__=1 返回 JSON 数组；HTML 形态（不带标记）不匹配，避免误解析
    { pattern: '*order.jd.com/center/list.action*__fetch__=1*' },
    // 订单中心另一入口（renderer.js 中出现，响应包裹于 data.orderList）
    { pattern: '*api.m.jd.com/*functionId=pcorder_center_list*' }
  ],
  supportsSeller: false,
  columns: [
    { key: 'payMethod', header: '支付方式', width: 14 },
    { key: 'shopUrl', header: '店铺首页', width: 24 },
    { key: 'itemUrl', header: '商品链接', width: 30 },
    { key: 'itemCount', header: '商品件数', width: 8 }
  ] as ExportColumn[],
  /**
   * 工单 034：原版 `jd-order` 的导出列序
   * （`dist/electron/renderer.js` 里的 headFields：下单日期…物流信息，共 15 列）。
   */
  exportColumns: [
    { key: 'createdAt', header: '下单日期', width: 20, format: 'datetime' },
    { key: 'orderId', header: '订单ID', width: 22 },
    { key: 'status', header: '订单状态', width: 12 },
    { key: 'quantity', header: '数量', width: 6, format: 'number' },
    { key: 'imageUrl', header: '商品图片', width: 30 },
    { key: 'itemUrl', header: '商品链接', width: 30 },
    { key: 'title', header: '商品名', width: 36 },
    { key: 'shopName', header: '店名', width: 18 },
    { key: 'shopUrl', header: '店铺首页', width: 24 },
    { key: 'receiverAddress', header: '收货地址', width: 40 },
    { key: 'receiverName', header: '收货人', width: 10 },
    { key: 'receiverPhone', header: '收货人电话', width: 14 },
    { key: 'paidAmount', header: '本单实付总款', width: 12, format: 'number' },
    { key: 'trackingNo', header: '运单号', width: 20 },
    { key: 'track', header: '物流信息', width: 30 }
  ] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const list = extractJdOrderArray(report.body)
    if (!list.length) {
      // 两种包裹都取不到数组：登录跳转/验证页 HTML 会走到这里
      throw new Error('京东订单响应中未找到订单数组（可能未登录或需要滑块验证）')
    }
    return { orders: list.map(normalizeJdOrder) }
  }
}
