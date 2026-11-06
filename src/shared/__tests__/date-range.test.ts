import { describe, expect, it } from 'vitest'
import { inDateRange } from '../date-range'

describe('本地日期范围筛选（inDateRange）', () => {
  it('起止当天都算命中（闭区间）', () => {
    expect(inDateRange('2026-10-01 08:00:00', '2026-10-01', '2026-10-31')).toBe(true)
    expect(inDateRange('2026-10-31 23:59:59', '2026-10-01', '2026-10-31')).toBe(true)
  })

  it('范围外与跨月边界正确排除', () => {
    expect(inDateRange('2026-09-30 23:59:59', '2026-10-01', '2026-10-31')).toBe(false)
    expect(inDateRange('2026-11-01 00:00:00', '2026-10-01', '2026-10-31')).toBe(false)
  })

  it('支持 ISO 带 T 的 createdAt（前 10 位同样是日期）', () => {
    expect(inDateRange('2026-10-15T12:30:00', '2026-10-01', '2026-10-31')).toBe(true)
  })

  it('无日期/格式异常不匹配（避免混进错误区间）', () => {
    expect(inDateRange(null, '2026-10-01', '2026-10-31')).toBe(false)
    expect(inDateRange(undefined, '2026-10-01', '2026-10-31')).toBe(false)
    expect(inDateRange('', '2026-10-01', '2026-10-31')).toBe(false)
    expect(inDateRange('未知', '2026-10-01', '2026-10-31')).toBe(false)
  })

  it('单日范围：start=end 只命中那一天', () => {
    expect(inDateRange('2026-10-15 00:00:01', '2026-10-15', '2026-10-15')).toBe(true)
    expect(inDateRange('2026-10-16 00:00:00', '2026-10-15', '2026-10-15')).toBe(false)
  })
})
