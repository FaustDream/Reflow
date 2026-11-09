/**
 * 订单状态机（2026-11-01）：把各平台五花八门的状态文案归一成五种语义状态。
 *
 * 放 shared 的原因：渲染层（表格标签/筛选/金额口径）与主进程（导出列）都要用。
 * 金额计算以此为准 —— 退款单不计入实付、关闭单不进任何金额口径。
 */

/** 归一化的订单状态 */
export type OrderState =
  | 'success' // 交易成功（钱已花掉且货/服务已结清）
  | 'pending' // 进行中（已付款未完成：待发货/已发货/运输中…）
  | 'refunding' // 退款中（钱出去了一部分，还在退）
  | 'refunded' // 已退款（钱已退回 —— 不计入实付）
  | 'closed' // 已关闭/已取消（未成交 —— 不计入任何金额口径）

export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  success: '交易成功',
  pending: '进行中',
  refunding: '退款中',
  refunded: '已退款',
  closed: '已关闭'
}

/**
 * 状态文案 → 归一状态。规则按优先级排列，新平台状态出现时按语义落桶，不会未知。
 *
 * 顺序要点：
 * - 「退款成功/退款关闭」是终态退款，必须先于「退款中」和「关闭」判断
 *   （「成功后又退款」的混合文案会明确写「退款」）
 * - 兜底：完全未识别的文案，有实付金额按 success，没有按 pending
 */
export function orderStateOfStatus(status: string, paidAmount?: string): OrderState {
  const s = (status || '').trim()
  if (!s) return paidAmount ? 'success' : 'pending'
  if (/退款成功|已退款|已退货|已退回|退货成功|退款完成|已全额退款|退款关闭|退货关闭|售后成功/.test(s)) {
    return 'refunded'
  }
  if (/交易关闭|订单关闭|已取消|取消订单|已撤销|超时未付款|未付自动关闭/.test(s)) return 'closed'
  if (/交易成功|已完成|已签收|已收货|交易完成|订单完成|已确认收货|已评价|充值成功|已提货|交易成功,/.test(s)) {
    return 'success'
  }
  if (/退款中|退货中|售后中|待退款|退款处理|申请退款/.test(s)) return 'refunding'
  if (/待付款|未付款|待发货|未发货|已发货|处理中|运输中|派送中|进行中|已下单|备货中|待收货|待使用|待分享|已预约/.test(s)) {
    return 'pending'
  }
  return paidAmount ? 'success' : 'pending'
}

export interface OrderStateLike {
  status?: string | null
  paidAmount?: string | null
}

export function orderStateOf(order: OrderStateLike): OrderState {
  return orderStateOfStatus(order.status || '', order.paidAmount || undefined)
}
