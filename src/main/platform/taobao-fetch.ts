/**
 * 工单 013（主动抓取）：淘宝「已买到的宝贝」按月分批编排（纯逻辑，可单测）。
 *
 * 完整移植 asar_taobao/out/preload/preload-index.js 的 getAllOrders：
 *   按月切范围 → mtop.queryboughtlistV2 翻页（pageControl.hasMore/nextPageIndex）
 *   condition.orderFilterExtParam 携带 beginTime/endTime（YYYY-MM-DD HH:mm:ss）
 * 响应由注入 CaptureEngine 走 taobao 适配器解析（节点树遍历），本模块不重复解析。
 */

export interface TaobaoMtopResponse {
  ret?: string[]
  data?: unknown
}

export interface TaobaoFetchOptions {
  /** 回溯月数（含本月），默认 12 */
  months?: number
  maxPagesPerMonth?: number
  delayMs?: number
}

export interface TaobaoMtopRpc {
  mtop: (options: Record<string, unknown>) => Promise<TaobaoMtopResponse>
}

export interface TaobaoFetchHandlers {
  onResponse: (body: TaobaoMtopResponse, context: { monthIndex: number; page: number }) => void
  onProgress?: (monthIndex: number, page: number) => void
  sleep?: (ms: number) => Promise<void>
}

export class TaobaoValidateRequiredError extends Error {
  constructor() {
    super('淘宝要求滑块/人机验证，请在页面中手动完成后重试')
    this.name = 'TaobaoValidateRequiredError'
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pad2 = (n: number): string => String(n).padStart(2, '0')

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 某月起止时间戳（与原版 getMonthRange 一致） */
export function monthRange(now: Date, monthsBack: number): { start: number; end: number } {
  const anchor = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0, 0).getTime()
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
  return { start, end }
}

function buildCondition(start: number, end: number): string {
  return JSON.stringify({
    directRouteToTm2Scene: '1',
    wordType: '3',
    wordTerm: '',
    showText: '',
    itemTitle: '',
    orderFilterExtParam: JSON.stringify({
      beginTime: formatTime(start),
      endTime: formatTime(end)
    })
  })
}

function buildMtopOptions(page: number, start: number, end: number): Record<string, unknown> {
  return {
    v: '1.0',
    ecode: 1,
    timeout: 8000,
    dataType: 'json',
    valueType: 'original',
    ttid: '1@tbwang_mac_1.0.0#pc',
    needLogin: true,
    type: 'POST',
    isHttps: '1',
    needRetry: true,
    data: {
      tabCode: 'all',
      page,
      OrderType: 'OrderFilter',
      appName: 'tborder',
      appVersion: '3.0',
      condition: buildCondition(start, end),
      __needlessClearProtocol__: true
    },
    api: 'mtop.taobao.order.queryboughtlistV2',
    __customTag__: 'boughtList_all_OrderFilter',
    preventFallback: true
  }
}

function isValidate(retText: string): boolean {
  return /FAIL_SYS_USER_VALIDATE/i.test(retText)
}

/** 读取分页控制（与原版 getPageControlFromMtopResponse 一致） */
export function pageControlOf(body: TaobaoMtopResponse): {
  hasMore: boolean
  nextPageIndex: number
  currentPage: number
} {
  const root = (body as any)?.data ?? {}
  const currentPage = Number(root?.data?.pagination?.fields?.currentPage ?? 1)
  const pc = root?.global?.pageControl ?? {}
  return {
    currentPage,
    hasMore:
      typeof pc.hasMore === 'boolean'
        ? pc.hasMore
        : Boolean(root?.data?.pagination?.fields?.hasMore),
    nextPageIndex: Number(pc.nextPageIndex ?? currentPage + 1)
  }
}

export async function fetchTaobaoOrders(
  rpc: TaobaoMtopRpc,
  options: TaobaoFetchOptions,
  handlers: TaobaoFetchHandlers
): Promise<{ months: number; pages: number }> {
  const months = options.months ?? 12
  const maxPages = options.maxPagesPerMonth ?? 50
  const sleep = handlers.sleep ?? sleepDefault
  const delay = options.delayMs ?? 500
  const now = new Date()

  let pages = 0
  for (let m = 0; m < months; m++) {
    const { start, end } = monthRange(now, m)
    let hasMore = true
    let page = 1

    while (hasMore && page <= maxPages) {
      const response = await rpc.mtop(buildMtopOptions(page, start, end))
      const retText = Array.isArray(response?.ret) ? response.ret.join(',') : ''
      if (isValidate(retText)) throw new TaobaoValidateRequiredError()

      pages += 1
      handlers.onResponse(response, { monthIndex: m, page })
      handlers.onProgress?.(m, page)

      const control = pageControlOf(response)
      hasMore = control.hasMore
      const next = control.nextPageIndex
      if (!hasMore || next === page) break
      page = next
      await sleep(delay)
    }
    // 月份之间也停顿，降低风控概率
    if (m < months - 1) await sleep(delay)
  }

  return { months, pages }
}
