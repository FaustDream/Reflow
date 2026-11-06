/**
 * 本地日期范围筛选（2026-10-30 用户要求：按抓取到的订单做范围筛选）。
 *
 * 纯本地、零请求：订单 createdAt 形如 'YYYY-MM-DD HH:mm:ss'（或 ISO 带 T），
 * 前 10 位就是日期，字符串字典序与时间序一致，直接比较即可，不做时区解析。
 * 起止日期都是**含当天**的闭区间。
 */

/** createdAt 是否落在 [start, end]（'YYYY-MM-DD'）闭区间内；无日期/格式异常一律不匹配 */
export function inDateRange(
  createdAt: string | null | undefined,
  start: string,
  end: string
): boolean {
  if (!createdAt) return false
  const day = createdAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  return day >= start && day <= end
}
