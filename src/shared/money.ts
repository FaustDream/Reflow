/**
 * 金额规整：统一模型里的金额一律是「元」的可读字符串（决策 D-3 精神：不做浮点运算、不留原始分）。
 *
 * 各平台的列表接口普遍以**分**返回金额：
 * - 1688 `sumPayment` / `carriage`
 * - 得物 `payAmount` / `skuPrice`
 * - 快手小店 `paymentFee` / `totalFee` / `expressFee`
 * 统一在这里换算，避免每个适配器各写一份除以 100 的逻辑（且容易漏掉错误值处理）。
 */

/** 分 → 元。非数字或空值返回空串；整元去掉 `.00`（与原版 1688 展示一致）。 */
export function fenToYuan(fen: unknown): string {
  if (fen === null || fen === undefined || fen === '') return ''
  const n = Number(fen)
  if (!Number.isFinite(n)) return ''
  // 去尾 0 而非只去 `.00`：59.80 → 59.8，与平台展示一致
  return (n / 100).toFixed(2).replace(/\.?0+$/, '')
}

/**
 * 已经是「元」的金额（得物部分字段、美团 total）→ 规整字符串。
 * 只做空值/非数字防御，不改写精度。
 */
export function yuanString(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : ''
  // 保留原始小数位（31.3 不应变成 31.30），与平台展示一致
  return String(value)
}

/**
 * 秒/毫秒时间戳 → 毫秒。部分平台（饿了么、快手、得物）混用秒与毫秒，
 * 统一交给 `toDateTimeString` 前先归一，避免 `1e11` 阈值判断在边界上漂移。
 */
export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  // 10 位（秒）与 13 位（毫秒）并存；小于 1e12 视为秒
  return n < 1e12 ? n * 1000 : n
}
