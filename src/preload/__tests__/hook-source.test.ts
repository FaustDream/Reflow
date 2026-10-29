/**
 * 订单号精度保护（关键回归）。
 *
 * 背景：美团 `wm_order_id: 2100000000000000001`、得物 `orderNo: 130000000000000001`
 * 这类 18~19 位整数超过 JS 安全整数上限，`JSON.parse` 会静默把末几位抹平。
 * 导出到 Excel 的单号就成了错的 —— 用户拿这个单号去平台查是查不到的。
 *
 * 这里覆盖：超长整数加引号、普通小数/安全整数不动、字符串内数字不误伤、转义正确。
 */
import { describe, expect, it } from 'vitest'
import { installPageHooks, protectBigInts } from '../hook-source'

describe('protectBigInts', () => {
  it('19 位订单号被转成字符串，不再丢精度', () => {
    const raw = '{"wm_order_id":2100000000000000001}'
    const parsed = JSON.parse(protectBigInts(raw)) as { wm_order_id: unknown }
    expect(parsed.wm_order_id).toBe('2100000000000000001')
    // 反证：直接 parse 后 String() 回来的单号与原文不同（末几位已被舍入），单号已不可用。
    // 注意：不能拿 JS 数字字面量 2100000000000000001 做比较 —— 它本身在源码里就已舍入。
    const naive = (JSON.parse(raw) as { wm_order_id: number }).wm_order_id
    expect(String(naive)).not.toBe('2100000000000000001')
  })

  it('16 位超安全范围的整数同样保护', () => {
    const parsed = JSON.parse(protectBigInts('{"id":12345678901234567}')) as { id: unknown }
    expect(parsed.id).toBe('12345678901234567')
  })

  it('安全范围内的整数保持数字类型（不改变原有解析语义）', () => {
    const parsed = JSON.parse(protectBigInts('{"n":123,"small":9007199254740991}')) as {
      n: unknown
      small: unknown
    }
    expect(parsed.n).toBe(123)
    expect(parsed.small).toBe(9007199254740991)
  })

  it('小数与科学计数法不处理（它们不是 ID）', () => {
    const parsed = JSON.parse(protectBigInts('{"a":1.5,"b":1e20}')) as { a: unknown; b: unknown }
    expect(parsed.a).toBe(1.5)
    expect(parsed.b).toBe(1e20)
  })

  it('字符串内部的数字字面量不被误改', () => {
    const raw = '{"t":"order 2100000000000000001 ok","n":2100000000000000001}'
    const parsed = JSON.parse(protectBigInts(raw)) as { t: unknown; n: unknown }
    expect(parsed.t).toBe('order 2100000000000000001 ok')
    expect(parsed.n).toBe('2100000000000000001')
  })

  it('字符串内的引号转义不破坏扫描', () => {
    const raw = '{"msg":"say \\"hi\\" 2100000000000000001","id":2100000000000000001}'
    const parsed = JSON.parse(protectBigInts(raw)) as { msg: unknown; id: unknown }
    expect(parsed.msg).toBe('say "hi" 2100000000000000001')
    expect(parsed.id).toBe('2100000000000000001')
  })

  it('数组中的超长整数同样保护', () => {
    const parsed = JSON.parse(protectBigInts('[2100000000000000001,1]')) as unknown[]
    expect(parsed[0]).toBe('2100000000000000001')
    expect(parsed[1]).toBe(1)
  })

  it('负数超长整数保护', () => {
    const parsed = JSON.parse(protectBigInts('{"x":-2100000000000000001}')) as { x: unknown }
    expect(parsed.x).toBe('-2100000000000000001')
  })

  it('不破坏原始 JSON 结构（深度/键序/嵌套）', () => {
    const raw = '{"a":{"b":[{"c":2100000000000000001}]},"d":"e"}'
    const parsed = JSON.parse(protectBigInts(raw)) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['a', 'd'])
    expect(((parsed.a as { b: Array<{ c: unknown }> }).b)[0].c).toBe('2100000000000000001')
  })

  it('非 JSON 文本原样返回（由 safeParse 兜底）', () => {
    const text = '<html>not json</html>'
    expect(protectBigInts(text)).toBe(text)
  })
})

describe('installPageHooks 可在主世界重建精度保护（序列化注入路径）', () => {
  it('toString + new Function 恢复的函数与源函数行为一致', () => {
    // 模拟 inject.ts 的注入方式：只用源码字符串重建
    const rebuilt = new Function(`return (${protectBigInts.toString()})`)() as (
      t: string
    ) => string
    const raw = '{"id":2100000000000000001,"n":42}'
    expect(rebuilt(raw)).toBe(protectBigInts(raw))
    expect((JSON.parse(rebuilt(raw)) as { id: unknown }).id).toBe('2100000000000000001')
  })

  it('installPageHooks 自身不含模块作用域引用（可 toString 后独立执行）', () => {
    // 只做静态检查：函数体内不应引用 protectBigInts 之外的模块符号
    const src = installPageHooks.toString()
    expect(src).toContain('protectBigInts')
    // 能被 new Function 解析说明没有语法层面的外部依赖
    expect(() => new Function(`return (${src})`)).not.toThrow()
  })
})
