/**
 * 工单 040：主进程直连 HTTP（接口型抓取的传输层）。
 *
 * 必须用 Electron 的 `net`（Chromium 网络栈）而不是 Node 的 fetch/undici：
 * 本机环境普遍挂着系统代理，undici 不读系统代理设置，会直连超时——
 * 页面（Chromium）能访问而主进程 fetch 卡死的「灵异现象」根因就在这。
 *
 * 这里不做任何签名逻辑，只负责：Cookie 串拼装 + 请求 + 超时。
 */
import { net, type Session } from 'electron'

export interface RawHttpResponse {
  status: number
  text: string
  /** 原始 set-cookie 行（含属性，未拆分） */
  setCookie: string[]
}

export interface RawHttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | null
  timeoutMs?: number
}

/**
 * 用 Chromium 网络栈发一次请求；超时抛错（请求已 abort）。
 *
 * 系统代理（clash 类）的去广告规则经常把 `h5api.m.taobao.com` 等网关域名 REJECT，
 * Chromium 侧表现为 `net::ERR_BLOCKED_BY_CLIENT` —— 这种错误自动降级用
 * Node 的 fetch（undici，不读系统代理设置）直连重试一次。
 */
export function httpRequest(
  url: string,
  options: RawHttpRequestOptions = {}
): Promise<RawHttpResponse> {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 20_000 } = options
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      try {
        r.abort()
      } catch {
        /* 已结束 */
      }
      done(() => reject(new Error(`请求超时（${timeoutMs / 1000}s）：${url.slice(0, 80)}`)))
    }, timeoutMs)

    let r: Electron.ClientRequest
    try {
      r = net.request({ url, method })
    } catch (e) {
      done(() => reject(e instanceof Error ? e : new Error(String(e))))
      return
    }
    r.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        done(() =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            setCookie: (res.headers['set-cookie'] as unknown as string[]) ?? []
          })
        )
      })
      res.on('error', (e) => done(() => reject(e)))
    })
    r.on('error', (e) => {
      // Electron 的 net 错误把 net:: 错误码放在 message 里（code 属性可能为空）
      const text = `${(e as NodeJS.ErrnoException).code ?? ''} ${e.message ?? ''}`
      done(() => {
        if (/ERR_BLOCKED_BY_CLIENT|ERR_PROXY/i.test(text)) {
          // 代理把该域名拒了：绕过代理直连重试
          directFetch(url, method, headers, body, timeoutMs).then(resolve, reject)
          return
        }
        reject(e)
      })
    })
    for (const [k, v] of Object.entries(headers)) {
      try {
        r.setHeader(k, v)
      } catch {
        /* 个别受保护的请求头跳过 */
      }
    }
    if (body) r.write(body)
    r.end()
  })
}

/** undici 直连（不走系统代理），供代理拦截时降级 */
async function directFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number
): Promise<RawHttpResponse> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: ac.signal
    })
    const text = await res.text()
    return {
      status: res.status,
      text,
      setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    }
  } catch (e) {
    throw new Error(
      `直连失败（代理拦截 + 无直连通路）：${e instanceof Error ? e.message : String(e)}`
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从会话分区读取某域名的 Cookie 串。
 *
 * 分区里同名 Cookie 可能有多份（历史域各写一份，如淘宝分区里 4 份 cna），
 * 直接全拼会让 Cookie 头超长被服务端截断（实测 mtop 因此丢掉追加在末尾的
 * `_m_h5_tk`，永远报 FAIL_SYS_TOKEN_EMPTY）——这里按名去重取第一份。
 */
export async function sessionCookieString(
  sess: Session,
  domainPart: string
): Promise<string> {
  const cookies = await sess.cookies.get({})
  const seen = new Map<string, string>()
  for (const c of cookies) {
    if (!(c.domain ?? '').includes(domainPart)) continue
    if (c.name === '') continue
    if (!seen.has(c.name)) seen.set(c.name, `${c.name}=${c.value}`)
  }
  return [...seen.values()].join('; ')
}

/**
 * 把若干 `name=value` 对合并进 Cookie 串：同名先删再前置。
 *
 * mtop 引导出的 `_m_h5_tk`/`_m_h5_tk_enc` 必须放在头部——长 Cookie 头被
 * 截断时丢的是末尾，新 token 追加在末尾等于白拿。
 */
export function mergeCookiePairs(cookieString: string, pairs: string[]): string {
  const list: string[] = []
  for (const p of pairs) {
    if (p) list.push(p)
  }
  const dropped = new Set(list.map((p) => p.split('=')[0]))
  const rest = cookieString
    .split('; ')
    .filter((p) => p && !dropped.has(p.split('=')[0]))
  return [...list, ...rest].join('; ')
}

/** 取 Cookie 串里某个 name 的值（无则空串） */
export function cookieValue(cookieString: string, name: string): string {
  for (const pair of cookieString.split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1)
  }
  return ''
}
