import { describe, expect, it } from 'vitest'
import { globToRegExp, matchRuleMatches, type PlatformAdapter } from '../adapter'
import { AdapterRegistry } from '../registry'

function makeAdapter(id: string, over: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    displayName: `平台 ${id}`,
    homeUrl: `https://${id}.example.com/`,
    matchRules: [{ pattern: `*.${id}.example.com/api/orders*` }],
    supportsSeller: false,
    columns: [],
    parse: () => ({ orders: [] }),
    ...over
  }
}

describe('AdapterRegistry', () => {
  it('注册后可按 id 查询并列出', () => {
    const reg = new AdapterRegistry()
    const a = makeAdapter('alpha')
    reg.register(a)
    expect(reg.get('alpha')).toBe(a)
    expect(reg.get('nope')).toBeUndefined()
    expect(reg.list().map((x) => x.id)).toEqual(['alpha'])
  })

  it('重复注册同一 id 抛错', () => {
    const reg = new AdapterRegistry()
    reg.register(makeAdapter('dup'))
    expect(() => reg.register(makeAdapter('dup'))).toThrow(/id 冲突/)
  })

  it('没有 matchRules 的适配器注册抛错', () => {
    const reg = new AdapterRegistry()
    expect(() => reg.register(makeAdapter('empty', { matchRules: [] }))).toThrow(/matchRules/)
  })

  it('route：URL glob 命中返回适配器与规则', () => {
    const reg = new AdapterRegistry()
    reg.register(makeAdapter('alpha'))
    const hit = reg.route('https://shop.alpha.example.com/api/orders?page=2', 'GET', 'xhr')
    expect(hit).not.toBeNull()
    expect(hit!.adapter.id).toBe('alpha')
    expect(hit!.rule.pattern).toBe('*.alpha.example.com/api/orders*')
  })

  it('route：未命中返回 null', () => {
    const reg = new AdapterRegistry()
    reg.register(makeAdapter('alpha'))
    expect(reg.route('https://other.example.com/api/orders', 'GET', 'xhr')).toBeNull()
    expect(reg.route('https://alpha.example.com/', 'GET', 'xhr')).toBeNull()
  })

  it('route：kind 与 method 声明时必须一致', () => {
    const reg = new AdapterRegistry()
    reg.register(
      makeAdapter('jsonponly', { matchRules: [{ pattern: '*.j.example.com/api*', kind: 'jsonp' }] })
    )
    expect(reg.route('https://m.j.example.com/api', 'GET', 'jsonp')).not.toBeNull()
    expect(reg.route('https://m.j.example.com/api', 'GET', 'xhr')).toBeNull()
  })

  it('route：多平台时按注册顺序取第一个命中', () => {
    const reg = new AdapterRegistry()
    reg.register(makeAdapter('first', { matchRules: [{ pattern: '*.shared.example.com/*' }] }))
    reg.register(makeAdapter('second', { matchRules: [{ pattern: '*.shared.example.com/*' }] }))
    expect(reg.route('https://x.shared.example.com/y')!.adapter.id).toBe('first')
  })

  it('registerBuiltinAdapters：内置平台可查询且可路由 mock 端点', async () => {
    const { registerBuiltinAdapters } = await import('../registry')
    const reg = new AdapterRegistry()
    registerBuiltinAdapters(reg)
    expect(reg.get('mock')).toBeDefined()
    expect(
      reg.route(`http://127.0.0.1:8931/api/orders-xhr?t=1`, 'GET', 'xhr')!.adapter.id
    ).toBe('mock')
  })
})

describe('matchRuleMatches / globToRegExp', () => {
  it('glob 的 * 跨越路径段与查询串', () => {
    const re = globToRegExp('*.goofish.com/h5/mtop.idle.web.trade.bought.list*')
    expect(re.test('https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/?jsv=2.7.2')).toBe(true)
    expect(re.test('https://evil.com/h5/mtop.idle.web.trade.bought.list')).toBe(false)
  })

  it('RegExp 模式按 test 匹配', () => {
    expect(matchRuleMatches({ pattern: /mtop\.\w+\.order/ }, 'https://a.com/mtop.tb.order/1.0')).toBe(true)
    expect(matchRuleMatches({ pattern: /mtop\.\w+\.order/ }, 'https://a.com/other')).toBe(false)
  })

  it('method 大小写不敏感', () => {
    const rule = { pattern: '*', method: 'POST' }
    expect(matchRuleMatches(rule, 'https://a.com', 'post')).toBe(true)
    expect(matchRuleMatches(rule, 'https://a.com', 'get')).toBe(false)
  })
})
