/**
 * 决策 D-3：所有时间字段输出统一为 `YYYY-MM-DD HH:mm:ss` 可读字符串，
 * 禁止 Excel 日期序列号（原版 1688 的 `45903.8374` 缺陷）。
 * 本模块是时间格式化的唯一实现，主进程 / 渲染层共用。
 */

/** `YYYY-MM-DD HH:mm:ss` 格式的时间字符串（本地时区） */
export type DateTimeString = string

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 将任意时间输入规整为 `YYYY-MM-DD HH:mm:ss`。
 * 接受 Date、毫秒时间戳、秒时间戳（自动识别 10 位数）、ISO 字符串、`YYYY-MM-DD HH:mm:ss`。
 * 无法解析时返回 null（不抛错，不输出垃圾值）。
 */
export function toDateTimeString(
  input: Date | number | string | null | undefined
): DateTimeString | null {
  if (input === null || input === undefined || input === '') return null

  let date: Date
  if (input instanceof Date) {
    date = input
  } else if (typeof input === 'number') {
    // 10 位数字视为秒级时间戳（部分平台接口返回秒）
    date = new Date(input < 1e11 ? input * 1000 : input)
  } else if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    // 纯数字字符串按时间戳处理
    if (/^\d+$/.test(trimmed)) return toDateTimeString(Number(trimmed))
    // Excel 风格日期序列号（原版 1688 缺陷）不是合法输入，拒绝
    if (/^\d+(\.\d+)?$/.test(trimmed)) return null
    // 已符合目标格式的直接校验后返回
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed
    date = new Date(trimmed)
  } else {
    return null
  }

  if (Number.isNaN(date.getTime())) return null
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}
