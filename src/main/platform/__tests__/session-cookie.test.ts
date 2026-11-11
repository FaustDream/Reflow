import { describe, expect, it } from 'vitest'
import { sessionCookieString } from '../session-http'

type FakeCookie = { name: string; value: string; domain: string }

/** 只需要 cookies.get，其余 Session 能力本函数用不到 */
const fakeSession = (cookies: FakeCookie[]): Parameters<typeof sessionCookieString>[0] =>
  ({ cookies: { get: async (): Promise<FakeCookie[]> => cookies } }) as unknown as Parameters<
    typeof sessionCookieString
  >[0]

describe('会话 Cookie 串拼装（2026-11-11 关键项前置）', () => {
  it('同名 Cookie 在多域各有一份时只取第一份（防头部超长被网关截断）', async () => {
    const sess = fakeSession([
      { name: 'cna', value: 'a', domain: '.taobao.com' },
      { name: 'cna', value: 'b', domain: '.tmall.com' },
      { name: 'unb', value: 'u1', domain: '.taobao.com' }
    ])
    expect(await sessionCookieString(sess, 'taobao')).toBe('cna=a; unb=u1')
  })

  it('prefer 里的鉴权项排到最前，其余保持原顺序', async () => {
    const sess = fakeSession([
      { name: 'aaa', value: '1', domain: '.taobao.com' },
      { name: 'cookie2', value: 'c', domain: '.taobao.com' },
      { name: 'zzz', value: '2', domain: '.taobao.com' },
      { name: '_m_h5_tk', value: 'tk', domain: '.taobao.com' }
    ])
    const s = await sessionCookieString(sess, 'taobao', ['_m_h5_tk', 'cookie2'])
    expect(s.indexOf('_m_h5_tk=')).toBe(0)
    expect(s.indexOf('cookie2=')).toBeLessThan(s.indexOf('aaa='))
    expect(s.indexOf('aaa=')).toBeLessThan(s.indexOf('zzz='))
  })

  it('prefer 里不存在的名字跳过，不影响其余项', async () => {
    const sess = fakeSession([{ name: 'unb', value: 'u', domain: '.taobao.com' }])
    expect(await sessionCookieString(sess, 'taobao', ['_m_h5_tk', 'unb'])).toBe('unb=u')
  })

  it('只取匹配域名段的 Cookie', async () => {
    const sess = fakeSession([
      { name: 'unb', value: 'u', domain: '.taobao.com' },
      { name: 'pdd_user_id', value: 'p', domain: '.yangkeduo.com' }
    ])
    expect(await sessionCookieString(sess, 'taobao')).toBe('unb=u')
  })
})
