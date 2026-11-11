import { describe, expect, it } from 'vitest'
import {
  defaultMtopHttp,
  mtopH5Request,
  mtopH5Sign,
  mtopTokenFromCookie,
  tkPairsFromSetCookie
} from '../mtop-h5'
import { cookieValue, mergeCookiePairs } from '../session-http'

describe('工单 040：mtop h5 签名', () => {
  it('sign = md5(token & t & appKey & dataJson)', () => {
    expect(mtopH5Sign('abc123', '1700000000000', '12574478', '{"tabCode":"all","page":1}')).toBe(
      'e769998c39896db93542a9e0843af1a5'
    )
    expect(mtopH5Sign('', '1700000000001', '12574478', '{}')).toBe(
      '0bb822de2cdd360de02bb0f1cb955c2d'
    )
  })

  it('从 Cookie 串提取 token（_m_h5_tk 第一段，URL 编码容忍）', () => {
    const cookie =
      'unb=123; _m_h5_tk=fa85b5f5811eabcdef0123456789abcd_1761900000; other=x'
    expect(mtopTokenFromCookie(cookie)).toBe('fa85b5f5811eabcdef0123456789abcd')
    // 过短/非 hex 的值不算有效 token
    expect(mtopTokenFromCookie('_m_h5_tk=short_x; a=b')).toBe('')
    expect(mtopTokenFromCookie('a=b')).toBe('')
  })

  it('tkPairsFromSetCookie 只取 _m_h5_tk(_enc) 的 name=value 对', () => {
    const pairs = tkPairsFromSetCookie([
      'mtop_partitioned_detect=1; Path=/; Domain=.taobao.com',
      '_m_h5_tk=abc123_1761900000; Path=/; Domain=.taobao.com; HttpOnly',
      '_m_h5_tk_enc=abc%3D%3D; Path=/; Domain=.taobao.com; HttpOnly',
      'unb=123; Path=/'
    ])
    expect(pairs).toEqual(['_m_h5_tk=abc123_1761900000', '_m_h5_tk_enc=abc%3D%3D'])
  })
})

describe('工单 040：mtop h5 请求（注入假 http）', () => {
  it('token 为空时先用空 token 打一发，再从 set-cookie 引导重试', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const http = async (
      url: string,
      options: { headers: Record<string, string> }
    ): Promise<{ status: number; text: string; setCookie: string[] }> => {
      calls.push({ url, headers: options.headers })
      if (calls.length === 1) {
        return {
          status: 200,
          text: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'], data: {} }),
          setCookie: ['_m_h5_tk=abcdef0123456789abcdef0123456789ab_1761900000; Domain=.taobao.com']
        }
      }
      return {
        status: 200,
        text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { ok: 1 } }),
        setCookie: []
      }
    }
    const result = await mtopH5Request(http, {
      api: 'mtop.taobao.order.queryboughtlistV2',
      data: { tabCode: 'all', page: 1 },
      origin: 'https://buyertrade.taobao.com',
      referer: 'https://buyertrade.taobao.com/',
      cookieString: 'unb=123; skt=abc'
    })
    expect(calls.length).toBe(2)
    // 重试时 cookie 头带上引导出的 _m_h5_tk，且前置（防长头截断）
    expect(calls[1].headers.cookie).toContain('_m_h5_tk=abcdef0123456789abcdef0123456789ab_1761900000')
    expect(calls[1].headers.cookie.indexOf('_m_h5_tk=')).toBeLessThan(
      calls[1].headers.cookie.indexOf('unb=')
    )
    // 签名用的是新 token
    expect(calls[1].url).toMatch(/sign=/)
    expect(result.ret).toEqual(['SUCCESS::调用成功'])
    // 返回的 cookieString 供翻页复用（含新 token）
    expect(result.cookieString).toContain('_m_h5_tk=abcdef0123456789')
  })

  it('token 引导失败（网关不下发）→ 抛 MtopTokenError', async () => {
    const http = async (): Promise<{ status: number; text: string; setCookie: string[] }> => ({
      status: 200,
      text: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'], data: {} }),
      setCookie: []
    })
    await expect(
      mtopH5Request(http, {
        api: 'mtop.foo',
        data: {},
        origin: 'https://x.example',
        referer: 'https://x.example',
        cookieString: 'a=b'
      })
    ).rejects.toMatchObject({ name: 'MtopTokenError' })
  })
})

describe('陈旧 token 导致的会话过期（2026-11-11）', () => {
  it('会话过期 + 网关换发新 token → 用新 token 重签一次并成功', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const http = async (
      url: string,
      options: { headers: Record<string, string> }
    ): Promise<{ status: number; text: string; setCookie: string[] }> => {
      calls.push({ url, headers: options.headers })
      if (calls.length === 1) {
        return {
          status: 200,
          text: JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} }),
          setCookie: ['_m_h5_tk=bbbbbbbb111111112222222233333333_1762000000; Domain=.taobao.com']
        }
      }
      return {
        status: 200,
        text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { list: [] } }),
        setCookie: []
      }
    }
    const result = await mtopH5Request(http, {
      api: 'mtop.taobao.order.queryboughtlistV2',
      data: { page: 1 },
      origin: 'https://buyertrade.taobao.com',
      referer: 'https://buyertrade.taobao.com/',
      cookieString: '_m_h5_tk=aaaaaaaa111111112222222233333333_1761000000; cookie2=xyz; unb=123'
    })
    expect(calls.length).toBe(2)
    expect(calls[1].headers.cookie).toContain('_m_h5_tk=bbbbbbbb11111111')
    expect(result.ret).toEqual(['SUCCESS::调用成功'])
    expect(result.cookieString).toContain('_m_h5_tk=bbbbbbbb11111111')
  })

  it('会话真失效：剔除旧 token 重来一轮后仍过期，错误原样上抛（不会无限重试）', async () => {
    let calls = 0
    const cookiesSeen: string[] = []
    const http = async (
      _url: string,
      options: { headers: Record<string, string> }
    ): Promise<{ status: number; text: string; setCookie: string[] }> => {
      calls += 1
      cookiesSeen.push(options.headers.cookie)
      return {
        status: 200,
        text: JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} }),
        setCookie: []
      }
    }
    const result = await mtopH5Request(http, {
      api: 'mtop.foo',
      data: {},
      origin: 'https://x.example',
      referer: 'https://x.example',
      cookieString: '_m_h5_tk=aaaaaaaa111111112222222233333333_1761000000; cookie2=xyz'
    })
    // 首次 + 剔除 token 后的一轮；第二轮已无 token 可剔，就此收手
    expect(calls).toBe(2)
    expect(cookiesSeen[0]).toContain('_m_h5_tk=')
    expect(cookiesSeen[1]).not.toContain('_m_h5_tk=')
    expect(cookiesSeen[1]).toContain('cookie2=xyz')
    expect(result.ret[0]).toMatch(/SESSION_EXPIRED/)
  })
})

describe('工单 040：Cookie 串工具', () => {
  it('mergeCookiePairs 同名删除并前置', () => {
    const merged = mergeCookiePairs('a=1; b=2; c=3', ['b=new'])
    expect(merged).toBe('b=new; a=1; c=3')
  })

  it('cookieValue 取指定 name（容忍空格与值内等号）', () => {
    const cookie = 'PDDAccessToken=NLUMBVGA=xx==; pdd_user_id=1091320193'
    expect(cookieValue(cookie, 'pdd_user_id')).toBe('1091320193')
    expect(cookieValue(cookie, 'PDDAccessToken')).toBe('NLUMBVGA=xx==')
    expect(cookieValue(cookie, 'missing')).toBe('')
  })
})

describe('工单 040：默认传输走 Electron net', () => {
  it('defaultMtopHttp 是函数（Electron 环境下才真正发请求，这里只验形状）', () => {
    expect(typeof defaultMtopHttp).toBe('function')
  })
})
