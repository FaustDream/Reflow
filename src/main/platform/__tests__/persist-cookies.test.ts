import { describe, expect, it } from 'vitest'
import { persistAllSessionCookies, persistSessionCookies } from '../cookie-login'

type FakeCookie = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified'
  expirationDate?: number
}

const cookie = (name: string, extra: Partial<FakeCookie> = {}): FakeCookie => ({
  name,
  value: `v-${name}`,
  domain: name === 'sca' ? '.taobao.com' : '.taobao.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'unspecified',
  ...extra
})

function fakeSession(cookies: FakeCookie[]): {
  sess: Parameters<typeof persistSessionCookies>[0]
  written: Array<Record<string, unknown>>
} {
  const written: Array<Record<string, unknown>> = []
  const sess = {
    cookies: {
      get: async (): Promise<FakeCookie[]> => cookies,
      set: async (details: Record<string, unknown>): Promise<void> => {
        written.push(details)
      }
    }
  } as unknown as Parameters<typeof persistSessionCookies>[0]
  return { sess, written }
}

describe('会话级 Cookie 落盘', () => {
  it('只改写会话级，已是持久的不重复写', async () => {
    const { sess, written } = fakeSession([
      cookie('cookie2'),
      cookie('sca'),
      cookie('lgc', { expirationDate: Math.floor(Date.now() / 1000) + 86400 })
    ])
    const done = await persistSessionCookies(sess, ['cookie2', 'sca', 'lgc'])
    expect(done.sort()).toEqual(['cookie2', 'sca'])
    expect(written).toHaveLength(2)
    for (const w of written) expect(typeof w.expirationDate).toBe('number')
  })

  it('值 / domain / 安全属性原样保留，只加过期时间', async () => {
    const { sess, written } = fakeSession([cookie('sca')])
    await persistSessionCookies(sess, ['sca'])
    expect(written[0]).toMatchObject({
      name: 'sca',
      value: 'v-sca',
      domain: '.taobao.com',
      secure: true,
      httpOnly: true,
      path: '/'
    })
    expect(written[0].url).toBe('https://taobao.com/')
  })

  it('persistAllSessionCookies 覆盖分区内全部会话级项（含 sca/tbsa）', async () => {
    const { sess, written } = fakeSession([
      cookie('unb'),
      cookie('cookie2'),
      cookie('sca'),
      cookie('tbsa'),
      cookie('cna', { expirationDate: Math.floor(Date.now() / 1000) + 86400 })
    ])
    const done = await persistAllSessionCookies(sess)
    expect(done.sort()).toEqual(['cookie2', 'sca', 'tbsa', 'unb'])
    expect(written.map((w) => w.name).sort()).toEqual(['cookie2', 'sca', 'tbsa', 'unb'])
  })

  it('单个 Cookie 写失败不影响其它项', async () => {
    const { sess } = fakeSession([cookie('bad'), cookie('good')])
    ;(sess.cookies as unknown as { set: (d: { name: string }) => Promise<void> }).set = async (
      d: { name: string }
    ): Promise<void> => {
      if (d.name === 'bad') throw new Error('拒绝写入')
    }
    const done = await persistAllSessionCookies(sess)
    expect(done).toEqual(['good'])
  })
})
