/**
 * 淘宝网页版订单**补抓**（含外卖/本地生活）。
 *
 * mtop 接口（queryboughtlistV2）只给实物订单，饿了么/闪购订单只在网页版
 * `asyncBought.htm` 里，且带 `extra.bizType`（5000=外卖/本地生活）。
 * 所以淘宝抓取在 mtop 翻完之后，再走这条通道补一遍，响应经同一个捕获引擎入库
 * （taobao 适配器按 URL 路由到 asyncBought 解析器）。
 *
 * 分页：`pageNum` 从 1 开始，返回 `mainOrders` 为空即到底；没有可靠的 totalPage 字段，
 * 用「空页 + maxPages」双保险。补抓失败不影响接口订单（调用方兜住）。
 */
export const TAOBAO_ASYNC_URL = 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'

/** 网页版订单页 URL（可作为 CaptureReport.url，落到 taobao 适配器的 asyncBought 规则） */
export function taobaoAsyncUrl(page: number): string {
  const qs = new URLSearchParams({
    action: 'itemlist/BoughtQueryAction',
    event_submit_do_query: '1',
    tabCode: 'all',
    pageNum: String(page),
    _input_charset: 'utf8'
  })
  return `${TAOBAO_ASYNC_URL}?${qs.toString()}`
}

export interface TaobaoAsyncPage {
  mainOrders?: unknown[]
}

export interface TaobaoAsyncRpc {
  /** 拉一页；失败/被重定向到登录页抛错 */
  page: (page: number) => Promise<unknown>
}

export interface TaobaoAsyncFetchOptions {
  /** 安全上限（网页版一页 15–20 单） */
  maxPages?: number
  delayMs?: number
}

export interface TaobaoAsyncHandlers {
  /** 每一页的原始响应；调用方负责喂捕获引擎 */
  onPage: (body: unknown, page: number) => void
  /** 增量抓取：这一页没有新单（全是本地已知）→ 更后面的页只会更旧 */
  shouldStop?: () => boolean
  onProgress?: (page: number, orderCount: number) => void
  sleep?: (ms: number) => Promise<void>
  cancelCheck?: () => void
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function orderCountOf(body: unknown): number {
  const list = (body as TaobaoAsyncPage | null)?.mainOrders
  return Array.isArray(list) ? list.length : 0
}

/** 逐页补抓；返回页数与订单数 */
export async function fetchTaobaoAsyncOrders(
  rpc: TaobaoAsyncRpc,
  options: TaobaoAsyncFetchOptions,
  handlers: TaobaoAsyncHandlers
): Promise<{ pages: number; orders: number }> {
  const maxPages = options.maxPages ?? 20
  const delay = options.delayMs ?? 400
  const sleep = handlers.sleep ?? sleepDefault

  let pages = 0
  let orders = 0
  for (let page = 1; page <= maxPages; page++) {
    handlers.cancelCheck?.()
    const body = await rpc.page(page)
    const count = orderCountOf(body)
    if (count === 0) break
    pages += 1
    orders += count
    handlers.onPage(body, page)
    handlers.onProgress?.(page, count)
    if (handlers.shouldStop?.()) break
    await sleep(delay)
  }
  return { pages, orders }
}
