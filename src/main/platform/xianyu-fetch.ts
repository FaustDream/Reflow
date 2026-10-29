/**
 * 工单 006/011（主动抓取）：闲鱼买/卖家订单全量分页编排（纯逻辑，可单测）。
 *
 * 完整移植魔猫原版 webview-preload.cjs#extractOrders 的接口循环：
 *   api=mtop.idle.web.trade.bought.list（卖家为 sold.list）
 *   data={ pageNumber, orderStatus:'ALL', offsetRow? }
 *   首页不传 offsetRow；之后用上一页 data.lastEndRow；nextPage 非真即结束。
 *
 * 与人工翻页的区别：整个循环由我们经页面官方 mtop SDK 发起（sign 由 SDK 计算，D-2），
 * 用户无需在网页里逐页滚动；网页可隐藏（会话与 SDK 仍存活于后台 webview）。
 *
 * 响应不在此解析：fetch-runner 把每一页构造成 CaptureReport 喂给 CaptureEngine，
 * 走 xianyu / xianyu-sold 适配器的同一条解析/去重/事件链路。
 */

export interface XianyuMtopResponse {
  ret?: string[] | string
  data?: {
    items?: unknown[]
    nextPage?: unknown
    lastEndRow?: unknown
    totalCount?: unknown
  }
}

export interface XianyuFetchOptions {
  /** 卖家单传 true（api 换成 sold 系列），默认买家 bought */
  seller?: boolean
  /** 安全上限，默认 200 页（与原版无上限相比增加兜底，避免风控异常时死循环） */
  maxPages?: number
  delayMs?: number
}

export interface XianyuMtopRpc {
  mtop: (options: Record<string, unknown>) => Promise<XianyuMtopResponse>
}

export interface XianyuFetchHandlers {
  /** 每一页的原始 mtop 响应（由调用方喂给捕获引擎） */
  onResponse: (body: XianyuMtopResponse, context: { page: number }) => void
  onProgress?: (page: number, offsetRow: string) => void
  sleep?: (ms: number) => Promise<void>
}

/** 滑块/人机验证专有错误（UI 提示去页面完成，不做无意义重试） */
export class XianyuValidateRequiredError extends Error {
  constructor() {
    super('闲鱼要求滑块/人机验证，请在页面中手动完成后重试')
    this.name = 'XianyuValidateRequiredError'
  }
}

/** 会话失效：后台隐藏 webview 里 Cookie 过期等 */
export class XianyuSessionError extends Error {
  constructor() {
    super('闲鱼登录态已失效，请重新登录后再抓取')
    this.name = 'XianyuSessionError'
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const XIANYU_BOUGHT_API = 'mtop.idle.web.trade.bought.list'
export const XIANYU_SOLD_API = 'mtop.idle.web.trade.sold.list'

/** 构造一次闲鱼 mtop 请求（参数与原版 webview-preload.cjs 完全一致） */
export function buildXianyuMtopOptions(
  api: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    v: '1.0',
    type: 'POST',
    appKey: '34839810',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: 20000,
    needLoginPC: false,
    showErrorToast: false,
    valueType: 'string',
    needLogin: false,
    sessionOption: 'AutoLoginOnly',
    ecode: 0,
    api,
    data
  }
}

/** 兼容布尔与字符串 "true"（原版 isNextPage） */
export function isXianyuNextPage(value: unknown): boolean {
  return value === true || value === 'true'
}

function retTextOf(response: XianyuMtopResponse): string {
  return Array.isArray(response?.ret) ? response.ret.join(';') : String(response?.ret ?? '')
}

/** 单页请求：结构异常时重试一次（与原版 requestWithRetry 一致） */
async function requestPage(
  rpc: XianyuMtopRpc,
  api: string,
  pageNumber: number,
  offsetRow: string | undefined
): Promise<XianyuMtopResponse> {
  const data: Record<string, unknown> = { pageNumber, orderStatus: 'ALL' }
  if (offsetRow) data.offsetRow = offsetRow

  const call = async (): Promise<XianyuMtopResponse> => {
    const response = await rpc.mtop(buildXianyuMtopOptions(api, data))
    const retText = retTextOf(response)
    if (/FAIL_SYS_USER_VALIDATE|FAIL_SYS_ILLEGAL_ACCESS/i.test(retText)) {
      throw new XianyuValidateRequiredError()
    }
    if (/SESSION_EXPIRED|FAIL_SYS_SESSION_EXPIRED|NOT_LOGIN|needLogin/i.test(retText)) {
      throw new XianyuSessionError()
    }
    if (!response?.data || !Array.isArray(response.data.items)) {
      throw new Error(`闲鱼订单接口返回结构异常：ret=${retText || '(空)'}`)
    }
    return response
  }

  try {
    return await call()
  } catch (err) {
    if (err instanceof XianyuValidateRequiredError || err instanceof XianyuSessionError) throw err
    // 传输/结构类失败按原版重试一次
    return call()
  }
}

/**
 * 全量分页抓取。返回总页数；每页响应经 handlers.onResponse 回传。
 * 结束条件（任一）：nextPage 非真、缺少 lastEndRow、达到 maxPages。
 */
export async function fetchXianyuOrders(
  rpc: XianyuMtopRpc,
  options: XianyuFetchOptions,
  handlers: XianyuFetchHandlers
): Promise<{ pages: number }> {
  const api = options.seller ? XIANYU_SOLD_API : XIANYU_BOUGHT_API
  const maxPages = options.maxPages ?? 200
  const sleep = handlers.sleep ?? sleepDefault
  const delay = options.delayMs ?? 600

  let pageNumber = 1
  let offsetRow: string | undefined
  let pages = 0

  while (pageNumber <= maxPages) {
    const response = await requestPage(rpc, api, pageNumber, offsetRow)
    pages += 1
    handlers.onResponse(response, { page: pageNumber })
    handlers.onProgress?.(pageNumber, offsetRow ?? '')

    if (!isXianyuNextPage(response.data?.nextPage)) break
    const nextRow = response.data?.lastEndRow
    if (nextRow === undefined || nextRow === null || String(nextRow) === '') break
    offsetRow = String(nextRow)
    pageNumber += 1
    await sleep(delay)
  }

  return { pages }
}
