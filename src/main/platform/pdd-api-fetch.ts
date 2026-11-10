/**
 * 工单 040：拼多多订单**接口直连**抓取（主进程三级通道）。
 *
 * 实测结论（2026-11-01 逆向 react_orders chunk 后定型）：
 *  1. **v4 分页的真实游标 = 上一批最后一条订单自己的 `offset` 字段**（fallback order_sn），
 *     不是页号×30。竞品不懂这个语义，所以它的「直连方案」永远只回第一批。
 *  2. 用对游标后**不需要 anti_content**：纯 Cookie 直连翻全量
 *     （实测 17 页 494 单，与页面滚动抓到的完全一致）。
 *  3. anti_content 通道保留为风控兜底；页面滚动兜底在 fetch-runner。
 *
 * 响应解析复用 `pdd.ts` 适配器（被动捕获与直连是同一个接口）。
 */
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Session } from 'electron'
import { httpRequest, cookieValue, sessionCookieString } from './session-http'
import { withPageRetry } from './page-retry'
import { openHiddenHost, sleep } from './host-window'

export const PDD_ORDER_LIST_URL = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4'
export const PDD_HOME_URL = 'https://mobile.yangkeduo.com/orders.html'
const PDD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export class PddLoginRequiredError extends Error {
  constructor(message = '拼多多登录态已失效，请重新扫码登录') {
    super(message)
    this.name = 'PddLoginRequiredError'
  }
}

/** 单页请求返回的订单（直连与页面同构） */
export interface PddApiOrder {
  order_sn?: unknown
  [key: string]: unknown
}

export interface PddApiPage {
  page: number
  json: Record<string, unknown>
  orders: PddApiOrder[]
  count: number
}

export interface PddApiHandlers {
  onResponse: (page: PddApiPage) => void
  onProgress?: (message: string) => void
  onRetry?: (attempt: number, page: number) => void
  cancelCheck?: () => void
  sleep?: (ms: number) => Promise<void>
  /**
   * 增量抓取：本地已知单号集合。整页全是已知单 = 已同步到最新，
   * 提前收工（complete=true）；游标失效（回同一批）里含未知单才判定为抓取不全。
   */
  known?: Set<string>
}

export interface PddApiFetchOutcome {
  /** 走通的通道 */
  tier: 'direct' | 'anti-content'
  pages: number
  orders: number
  /** true = 确认抓到底（末页不满页）；false = 疑似不全，调用方应回落滚动通道 */
  complete: boolean
}

/** 直连/anti-content 请求头（两通道共用） */
export function pddRequestHeaders(cookie: string, tokenCookie: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json;charset=UTF-8',
    accept: 'application/json, text/plain, */*',
    origin: 'https://mobile.yangkeduo.com',
    referer: 'https://mobile.yangkeduo.com/orders.html',
    'user-agent': PDD_UA,
    cookie
  }
  if (tokenCookie) {
    headers.AccessToken = tokenCookie
    headers.token = tokenCookie
  }
  return headers
}

/** 解析一页响应：40001 = 登录失效 */
export function parsePddPage(json: Record<string, unknown> | null): PddApiOrder[] {
  if (!json) throw new Error('拼多多接口返回非 JSON 响应')
  const errorCode = Number(json.error_code ?? 0)
  if (errorCode === 40001) throw new PddLoginRequiredError()
  if (errorCode) {
    throw new Error(`拼多多接口错误 ${errorCode}${json.error_msg ? `：${String(json.error_msg)}` : ''}`)
  }
  const orders = json.orders
  return Array.isArray(orders) ? (orders as PddApiOrder[]) : []
}

/**
 * 纯逻辑：给定「取一页」的 rpc，循环翻页直到抓到底/无新增/上限。
 * 去重判据是 order_sn（ac 复用被无视时服务端会一直回同一批，靠这个发现）。
 */
export async function fetchPddOrdersByApi(
  rpc: (page: number, cursor?: string | number) => Promise<PddPageResponse>,
  options: { pageSize?: number; maxPages?: number; delayMs?: number },
  handlers: PddApiHandlers
): Promise<{ pages: number; orders: number; complete: boolean }> {
  const pageSize = options.pageSize ?? 30
  const maxPages = options.maxPages ?? 300
  const sleep = handlers.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const seen = new Set<string>()
  let pages = 0
  let cursor: string | number | undefined = undefined

  for (let page = 1; page <= maxPages; page++) {
    handlers.cancelCheck?.()
    const res = await withPageRetry(() => rpc(page, cursor), {
      onRetry: (attempt) => handlers.onRetry?.(attempt, page),
      sleep
    })
    const orders = parsePddPage(res.json)
    pages += 1
    let added = 0
    for (const o of orders) {
      const sn = typeof o.order_sn === 'string' ? o.order_sn : ''
      if (sn && !seen.has(sn)) {
        seen.add(sn)
        added += 1
      }
    }
    // 走到这里说明解析成功，json 必非 null（parsePddPage 对 null 抛错）
    handlers.onResponse({ page, json: res.json!, orders, count: orders.length })
    handlers.onProgress?.(`已抓取 ${pages} 页 · ${seen.size} 单`)
    // 增量抓取：整页全是本地已知单 → 已同步到最新，提前收工
    //（区分「游标失效回同一批」：那批里必然含不在已知集合里的单）
    const allKnown =
      handlers.known !== undefined &&
      orders.length > 0 &&
      orders.every((o) => typeof o.order_sn === 'string' && handlers.known!.has(o.order_sn))
    if (allKnown) {
      return { pages, orders: seen.size, complete: true }
    }
    // 抓到底：空页 / 末页不满页
    if (orders.length === 0 || orders.length < pageSize) {
      return { pages, orders: seen.size, complete: true }
    }
    // 服务端无视翻页参数（一直回同一批）→ 交给调用方换通道
    if (added === 0) {
      return { pages, orders: seen.size, complete: false }
    }
    /**
     * 推进游标：v4 的 `offset` 参数 = 上一批最后一条订单自己的 offset 字段
     * （fallback order_sn），不是页号 × 页大小。
     */
    const last = orders[orders.length - 1]
    const rawOffset = last.offset
    cursor =
      rawOffset !== undefined && rawOffset !== null && rawOffset !== ''
        ? (rawOffset as string | number)
        : (typeof last.order_sn === 'string' ? last.order_sn : undefined)
    if (cursor === undefined) {
      return { pages, orders: seen.size, complete: false }
    }
    await sleep(options.delayMs ?? 600)
  }
  return { pages, orders: seen.size, complete: false }
}

export interface PddPageResponse {
  /** 非 JSON 响应（风控墙等）为 null：交给 parsePddPage 抛错，绝不伪装成「抓到底 0 单」 */
  json: Record<string, unknown> | null
  status: number
  text: string
}

/** 直连单页请求（无 anti_content，靠 offset 游标翻页） */
export async function pddDirectPage(
  url: string,
  headers: Record<string, string>,
  cursor: string | number | undefined,
  pageSize: number
): Promise<PddPageResponse> {
  // 与页面自身请求同参（scene 模式每页 10 条 → 想要 30/页就别带 scene，实测两者都收）
  const bodyObj: Record<string, unknown> = {
    type: 'all',
    page: 1,
    size: pageSize,
    origin_host_name: 'mobile.yangkeduo.com'
  }
  if (cursor !== undefined) bodyObj.offset = cursor
  const body = JSON.stringify(bodyObj)
  const res = await httpRequest(url, { method: 'POST', headers, body, timeoutMs: 20_000 })
  if (res.status !== 200) {
    throw new Error(`拼多多接口 HTTP ${res.status}`)
  }
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(res.text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { json, status: res.status, text: res.text }
}

/** anti_content 分页通道用的真实页面参数（scene 模式每页 10 条） */
export async function pddAntiContentPage(
  url: string,
  headers: Record<string, string>,
  page: number,
  antiContent: string
): Promise<PddPageResponse> {
  const body = JSON.stringify({
    type: 'all',
    page,
    origin_host_name: 'mobile.yangkeduo.com',
    scene: 'order_list_h5',
    page_from: 0,
    front_env: 1,
    pay_front_supports: [],
    anti_content: antiContent
  })
  const res = await httpRequest(url, { method: 'POST', headers, body, timeoutMs: 20_000 })
  if (res.status !== 200) {
    throw new Error(`拼多多接口 HTTP ${res.status}`)
  }
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(res.text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { json, status: res.status, text: res.text }
}

// ---------------------------------------------------------------------------
// anti_content 截获（隐藏页面通道）
// ---------------------------------------------------------------------------

/**
 * 页面内 hook preload：记录页面自己发出的 order_list_v4 请求体里的 anti_content。
 * 运行在页面主世界（contextIsolation:false），先于页面脚本执行。
 */
export const PDD_HOOK_PRELOAD_SOURCE = `;(function () {
  try {
    window.__reflowPddAc = null
    const record = (url, body) => {
      try {
        if (String(url).indexOf('order_list_v4') === -1 || typeof body !== 'string') return
        const j = JSON.parse(body)
        if (j && j.anti_content) {
          window.__reflowPddAc = { ac: j.anti_content, ts: Date.now() }
        }
      } catch (e) { /* 忽略 */ }
    }
    const origFetch = window.fetch
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || ''
          const body = init && typeof init.body === 'string' ? init.body : null
          record(url, body)
        } catch (e) { /* 忽略 */ }
        return origFetch.apply(this, arguments)
      }
    }
    const origOpen = XMLHttpRequest.prototype.open
    const origSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__u = u
      return origOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function (b) {
      record(this.__u, b)
      return origSend.apply(this, arguments)
    }
  } catch (e) { /* 忽略 */ }
})()
`

/** hook preload 写到临时目录（不进包，路径每次启动都有效） */
export function ensurePddHookPreloadFile(): string {
  const file = join(tmpdir(), 'reflow-pdd-hook-preload.js')
  writeFileSync(file, PDD_HOOK_PRELOAD_SOURCE, 'utf8')
  return file
}

export interface PddAntiContentResult {
  antiContent: string
}

/**
 * 打开隐藏页让拼多多自己发一次订单请求，截获 anti_content。
 * 页面拿到就销毁（不滚动、不展示）。
 */
export async function capturePddAntiContent(
  hooks: { onProgress?: (message: string) => void } = {}
): Promise<PddAntiContentResult | null> {
  const host = await openHiddenHost({
    partition: 'persist:platform-pdd',
    url: PDD_HOME_URL,
    userAgent: PDD_UA,
    preload: ensurePddHookPreloadFile(),
    openLabel: '打开拼多多订单页'
  })
  try {
    for (let i = 0; i < 20; i++) {
      const ac = (await host
        .evalJs<{ ac?: string } | null>('window.__reflowPddAc || null', 8_000, '读取 anti_content')
        .catch(() => null)) as { ac?: string } | null
      if (ac && typeof ac.ac === 'string' && ac.ac.length > 32) {
        return { antiContent: ac.ac }
      }
      await sleep(1000)
    }
    hooks.onProgress?.('未能从页面截获 anti_content')
    return null
  } finally {
    host.destroy()
  }
}

// ---------------------------------------------------------------------------
// 三级通道编排（fetch-runner 调用）
// ---------------------------------------------------------------------------

export interface PddViaApiDeps {
  session: Session
  /** 把每页响应喂给捕获引擎（与被动捕获同一条解析链路） */
  ingest: (body: unknown, url: string) => void
  onProgress?: (message: string) => void
  cancelCheck: () => void
  /** 增量抓取：本地已知单号集合（透传给翻页循环做提前收工判定） */
  known?: Set<string>
}

/**
 * 拼多多接口直连编排：**offset 游标直连翻页（2026-11-01 起的主通道，全量秒级）**
 * → anti_content 复用（风控兜底）→ 调用方回落滚动。
 */
export async function fetchPddOrdersViaApi(deps: PddViaApiDeps): Promise<PddApiFetchOutcome> {
  const cookie = await sessionCookieString(deps.session, 'yangkeduo')
  if (!cookieValue(cookie, 'PDDAccessToken')) {
    throw new PddLoginRequiredError('拼多多未登录（分区里没有 PDDAccessToken），请先扫码登录')
  }
  const pdduid = cookieValue(cookie, 'pdd_user_id')
  const url = `${PDD_ORDER_LIST_URL}?pdduid=${encodeURIComponent(pdduid)}`
  const headers = pddRequestHeaders(cookie, cookieValue(cookie, 'PDDAccessToken'))

  // 通道一（主）：纯直连 + offset 游标翻页（无 anti_content，实测 17 页 494 单全量）
  try {
    const rpc = async (_page: number, cursor?: string | number): Promise<PddPageResponse> =>
      pddDirectPage(url, headers, cursor, 30)
    const result = await fetchPddOrdersByApi(
      rpc,
      { pageSize: 30, maxPages: 120, delayMs: 600 },
      {
        cancelCheck: deps.cancelCheck,
        onProgress: deps.onProgress,
        known: deps.known,
        onResponse: (p) => deps.ingest(p.json, url)
      }
    )
    if (result.orders > 0) {
      return { tier: 'direct', pages: result.pages, orders: result.orders, complete: result.complete }
    }
    deps.onProgress?.('直连通道没有返回订单')
  } catch (e) {
    if (e instanceof PddLoginRequiredError) throw e
    deps.onProgress?.(`直连通道失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 通道二（兜底）：截获页面 anti_content 后按真实页面参数翻页（scene 模式每页 10 条）
  try {
    deps.cancelCheck()
    deps.onProgress?.('直连通道不完整，尝试页面风控参数通道…')
    const ac = await capturePddAntiContent({ onProgress: deps.onProgress })
    if (ac) {
      const rpc = async (page: number, _cursor?: string | number): Promise<PddPageResponse> =>
        pddAntiContentPage(url, headers, page, ac.antiContent)
      const result = await fetchPddOrdersByApi(
        rpc,
        { pageSize: 10, maxPages: 300, delayMs: 700 },
        {
          cancelCheck: deps.cancelCheck,
          onProgress: deps.onProgress,
          known: deps.known,
        onResponse: (p) => deps.ingest(p.json, url)
        }
      )
      if (result.orders > 0) {
        return {
          tier: 'anti-content',
          pages: result.pages,
          orders: result.orders,
          complete: result.complete
        }
      }
    }
  } catch (e) {
    if (e instanceof PddLoginRequiredError) throw e
    deps.onProgress?.(`anti_content 通道失败：${e instanceof Error ? e.message : String(e)}`)
  }

  throw new Error('拼多多接口直连失败（无可用响应），请稍后重试')
}
