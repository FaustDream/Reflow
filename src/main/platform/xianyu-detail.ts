/**
 * 工单 008：闲鱼订单详情解析（`mtop.idle.web.trade.order.detail` 响应）。
 *
 * 结构依据真实快照 xy-order-detail.json：
 *   data.components[render=='orderInfoVO']
 *     .data.orderInfoList[]  → { title, value }：支付宝交易号/收货地址/付款/发货/成交时间
 *     .data.priceInfo.billList[] → 运费/闲鱼币抵扣
 * 与原版 orders.js#normalizeOrderDetail / webview-preload.cjs 一致。
 *
 * 决策 D-3：三个时间经 toDateTimeString 规整为 `YYYY-MM-DD HH:mm:ss`。
 */
import { toDateTimeString, type DateTimeString } from '../../shared/datetime'

interface TitleValue {
  title?: unknown
  value?: unknown
}
interface XianyuDetailPayload {
  ret?: unknown
  data?: {
    status?: unknown
    commonInfo?: Record<string, unknown>
    components?: Array<{
      render?: unknown
      data?: {
        orderInfoList?: TitleValue[]
        priceInfo?: { billList?: TitleValue[] }
        title?: unknown
        fields?: { title?: unknown }
      }
    }>
  }
}

/** 合并进统一 Order 的详情字段（其余列留空，由 009/物流等后续工单补） */
export interface XianyuDetailFields {
  receiverAddress: string
  alipayTradeNo: string
  freight: string
  coinDiscount: string
  paidAt: DateTimeString | null
  shippedAt: DateTimeString | null
  completedAt: DateTimeString | null
}

export class XianyuValidateRequiredError extends Error {
  constructor() {
    super('闲鱼要求人机验证，请在页面中手动完成后重试')
    this.name = 'XianyuValidateRequiredError'
  }
}

export class XianyuMultiPackageError extends Error {
  constructor() {
    super('该订单「分成多个包」，按原版逻辑跳过')
    this.name = 'XianyuMultiPackageError'
  }
}

const toMap = (items: TitleValue[] | undefined): Map<string, string> =>
  new Map((items ?? []).map((i) => [String(i.title ?? ''), String(i.value ?? '')]))

const MULTI_PACKAGE_MARK = '分成多个包'

/**
 * 「分成多个包」判定（工单 008）：详情响应中状态标题类字段出现该文案即跳过。
 * 检查若干可能的承载路径，避免因页面版本差异漏判。
 */
export function isMultiPackageDetail(body: XianyuDetailPayload): boolean {
  const candidates: unknown[] = [
    body.data?.status,
    body.data?.commonInfo,
    ...(body.data?.components ?? []).map((c) => c.data)
  ]
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    const c = candidate as Record<string, unknown>
    const titles = [c.title, (c.fields as { title?: unknown } | undefined)?.title]
    return titles.some((t) => typeof t === 'string' && t.includes(MULTI_PACKAGE_MARK))
  })
}

/** 解析单条详情响应 → 可合并进 Order 的字段；结构缺失时抛错（调用方计入失败，不静默） */
export function normalizeXianyuDetail(body: unknown): XianyuDetailFields {
  const payload = body as XianyuDetailPayload | null
  const retText = Array.isArray(payload?.ret) ? payload!.ret.join(';') : ''
  if (/FAIL_SYS_USER_VALIDATE/i.test(retText)) throw new XianyuValidateRequiredError()
  if (!payload?.data?.components) {
    throw new Error(`详情响应结构异常（无 data.components）${retText ? `，ret=${retText}` : ''}`)
  }

  // 「分成多个包」的订单按原版逻辑跳过，不产生脏数据（工单 008）
  if (isMultiPackageDetail(payload)) throw new XianyuMultiPackageError()

  const component = payload.data.components.find((c) => c.render === 'orderInfoVO')
  if (!component?.data) throw new Error('详情响应缺少 orderInfoVO 组件')

  const info = toMap(component.data.orderInfoList)
  const bills = toMap(component.data.priceInfo?.billList)

  return {
    receiverAddress: info.get('收货地址') ?? '',
    alipayTradeNo: info.get('支付宝交易号') ?? '',
    freight: bills.get('运费') ?? '',
    coinDiscount: bills.get('闲鱼币抵扣') ?? '',
    paidAt: toDateTimeString(info.get('付款时间')),
    shippedAt: toDateTimeString(info.get('发货时间')),
    completedAt: toDateTimeString(info.get('成交时间'))
  }
}
