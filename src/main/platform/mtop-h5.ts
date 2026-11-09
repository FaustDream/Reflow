/**
 * 工单 040：mtop H5 网关直连客户端（主进程）。
 *
 * mtop h5 协议是公开稳定的：
 *   sign = md5(token & t & appKey & dataJson)
 *   token 取 Cookie `_m_h5_tk` 值的第一段（下划线前 32 位 hex）
 *   token 缺失/过期时，网关会在响应 set-cookie 里下发新 `_m_h5_tk`+`_m_h5_tk_enc`，
 *   用新 token 重签重试一次即可（竞品抓包样本 `api-migrate.md` 验证过的完整参数集）。
 *
 * 请求形态（2026-10-31 实测直连 SUCCESS）：
 *   POST https://h5api.m.taobao.com/h5/{api}/{v}/?jsv=2.7.2&appKey=..&t=..&sign=..
 *        &v=..&ecode=1&timeout=8000&dataType=json&valueType=original
 *        &ttid=1@tbwang_mac_1.0.0#pc&needLogin=true&type=originaljson
 *        &isHttps=1&needRetry=true&api={api}
 *   body: data={urlencoded json}
 *   headers: content-type: application/x-www-form-urlencoded + Origin/Referer + Cookie
 */
import { createHash } from 'crypto'
import { httpRequest, mergeCookiePairs } from './session-http'

export const MTOP_H5_APP_KEY = '12574478'

export interface MtopHttpResult {
  status: number
  text: string
  setCookie: string[]
}

export type MtopHttp = (
  url: string,
  options: { method: string; headers: Record<string, string>; body: string; timeoutMs?: number }
) => Promise<MtopHttpResult>

/** 默认传输：Electron net（跟随系统代理） */
export const defaultMtopHttp: MtopHttp = (url, options) =>
  httpRequest(url, { ...options, timeoutMs: options.timeoutMs ?? 20_000 })

/** 签名：md5(token & t & appKey & dataJson) */
export function mtopH5Sign(
  token: string,
  t: string,
  appKey: string,
  dataJson: string
): string {
  return createHash('md5').update(`${token}&${t}&${appKey}&${dataJson}`, 'utf8').digest('hex')
}

/** 从 Cookie 串提取 mtop token（`_m_h5_tk` 第一段） */
export function mtopTokenFromCookie(cookieString: string): string {
  const m = /(?:^|;\s*)_m_h5_tk=([^;]+)/.exec(cookieString)
  if (!m) return ''
  const value = decodeURIComponent(m[1])
  const token = value.split('_')[0] ?? ''
  return /^[0-9a-f]{16,}$/i.test(token) ? token : ''
}

export interface MtopH5CallOptions {
  api: string
  /** 默认 '1.0' */
  v?: string
  /** 业务参数对象（内部 JSON.stringify） */
  data: unknown
  appKey?: string
  /** '1' = 需要登录态（订单类接口都是） */
  ecode?: '0' | '1'
  origin: string
  referer: string
  userAgent?: string
  cookieString: string
  host?: string
  timeoutMs?: number
}

export interface MtopH5CallResult {
  json: Record<string, unknown>
  /** mtop 的 ret 数组（如 ["SUCCESS::调用成功"]） */
  ret: string[]
  /** 重试后带上了新 token 的 Cookie 串 —— 翻页时请复用它，避免每页重新引导 */
  cookieString: string
}

/**
 * mtop 令牌类错误（需要重新引导 token）。
 *
 * 注意阿里官方把 EXPIRED 拼成了 **EXOIRED**（历史遗留，线上仍在返回），
 * 只写正确拼写会漏掉最常见的那条，导致「令牌过期」被当成普通错误上抛，
 * 用户看到的就是莫名其妙的抓取失败。
 */
const TOKEN_ERR =
  /FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_ILLEGAL|TOKEN_FORBIDDEN/i

function buildUrl(
  api: string,
  v: string,
  appKey: string,
  t: string,
  sign: string,
  ecode: string,
  host: string
): string {
  const qs = new URLSearchParams({
    jsv: '2.7.2',
    appKey,
    t,
    sign,
    v,
    ecode,
    timeout: '8000',
    dataType: 'json',
    valueType: 'original',
    ttid: '1@tbwang_mac_1.0.0#pc',
    needLogin: 'true',
    type: 'originaljson',
    isHttps: '1',
    needRetry: 'true',
    api
  }).toString()
  return `https://${host}/h5/${api}/${v}/?${qs}`
}

function cookieHeaderFor(cookieString: string, ua: string, origin: string, referer: string): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    origin,
    referer,
    'user-agent': ua,
    cookie: cookieString
  }
}

/**
 * 发一次 mtop h5 请求；token 缺失/过期自动引导重试一次。
 * 返回 `cookieString` 供后续分页复用（token 已引导好的状态）。
 */
export async function mtopH5Request(
  http: MtopHttp,
  options: MtopH5CallOptions
): Promise<MtopH5CallResult> {
  const {
    api,
    v = '1.0',
    data,
    appKey = MTOP_H5_APP_KEY,
    ecode = '1',
    origin,
    referer,
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    cookieString,
    host = 'h5api.m.taobao.com',
    timeoutMs
  } = options
  const dataJson = typeof data === 'string' ? data : JSON.stringify(data)
  const body = `data=${encodeURIComponent(dataJson)}`
  const headersOf = (cookie: string) => cookieHeaderFor(cookie, userAgent, origin, referer)

  const call = async (token: string, cookie: string): Promise<MtopHttpResult> => {
    const t = String(Date.now())
    const sign = mtopH5Sign(token, t, appKey, dataJson)
    return http(buildUrl(api, v, appKey, t, sign, ecode, host), {
      method: 'POST',
      headers: headersOf(cookie),
      body,
      timeoutMs
    })
  }

  let cookie = cookieString
  let res = await call(mtopTokenFromCookie(cookie), cookie)
  let json = safeJson(res.text)
  let ret = retOf(json)

  // token 引导：首响应的 set-cookie 一定带新 _m_h5_tk（没有有效 token 时必走这条路）
  if (ret.some((r) => TOKEN_ERR.test(r))) {
    cookie = mergeCookiePairs(cookie, tkPairsFromSetCookie(res.setCookie))
    const token = mtopTokenFromCookie(cookie)
    if (!token) {
      // 措辞刻意不带「重新登录」：这是令牌引导失败（多半是网络/风控瞬时问题），
      // 界面上按「接口异常」提示即可，不该把用户赶去重新扫码
      const err = new Error('mtop 网关未下发 token（Cookie 不完整或网关异常），请重试')
      err.name = 'MtopTokenError'
      throw err
    }
    res = await call(token, cookie)
    json = safeJson(res.text)
    ret = retOf(json)
  }

  return { json: json ?? {}, ret, cookieString: cookie }
}

/** 从 set-cookie 行数组里抠出 _m_h5_tk / _m_h5_tk_enc 的 name=value 对 */
export function tkPairsFromSetCookie(setCookie: string[]): string[] {
  const pairs: string[] = []
  for (const line of setCookie) {
    const pair = line.split(';')[0] ?? ''
    if (/^_m_h5_tk(_enc)?=/.test(pair) && pair.includes('=')) pairs.push(pair)
  }
  return pairs
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function retOf(json: Record<string, unknown> | null): string[] {
  const ret = json?.ret
  return Array.isArray(ret) ? ret.map(String) : []
}
