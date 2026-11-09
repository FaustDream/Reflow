import { describe, expect, it } from 'vitest'
import { toDateTimeString } from '../datetime'

describe('toDateTimeString（决策 D-3：统一时间格式）', () => {
  it('Date / 毫秒时间戳 → YYYY-MM-DD HH:mm:ss', () => {
    const d = new Date(2026, 9, 13, 15, 30, 45)
    expect(toDateTimeString(d)).toBe('2026-10-13 15:30:45')
    expect(toDateTimeString(d.getTime())).toBe('2026-10-13 15:30:45')
  })

  it('秒级时间戳（10 位）自动识别', () => {
    const ms = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(toDateTimeString(Math.floor(ms / 1000))).toBe(toDateTimeString(ms))
  })

  it('ISO 字符串与纯数字字符串', () => {
    expect(toDateTimeString('2026-10-13T15:30:45')).toBe('2026-10-13 15:30:45')
    expect(toDateTimeString('1760340000000')).toBe(toDateTimeString(1760340000000))
  })

  it('已符合目标格式的输入原样通过', () => {
    expect(toDateTimeString('2026-10-13 15:30:45')).toBe('2026-10-13 15:30:45')
  })

  it('Excel 日期序列号拒绝（原版 1688 缺陷回归防护）', () => {
    expect(toDateTimeString('45903.8374')).toBeNull()
  })

  it('无效输入返回 null 而不抛错', () => {
    expect(toDateTimeString(null)).toBeNull()
    expect(toDateTimeString(undefined)).toBeNull()
    expect(toDateTimeString('')).toBeNull()
    expect(toDateTimeString('   ')).toBeNull()
    expect(toDateTimeString('not-a-date')).toBeNull()
    expect(toDateTimeString(NaN)).toBeNull()
  })
})
