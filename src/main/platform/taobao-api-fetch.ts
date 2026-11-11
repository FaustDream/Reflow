/**
 * 工单 040：淘宝订单**接口直连**抓取（主进程，不再依赖打开订单页）。
 *
 * 实测（2026-10-31，真实登录分区 Cookie）：
 *   `appName=taobao`（页面 SDK 同款参数）直连会报 FAIL_SYS_SERVICE_INNER_FAULT，
 *   而**竞品抓包样本**（`work/asar_taobao/api-migrate.md`）的参数能直接 SUCCESS：
 *     data = { tabCode:'all', page:N, OrderType:'OrderList', appName:'tborder',
 *              appVersion:'3.0', condition:'{"directRouteToTm2Scene":"1"}',
 *              __needlessClearProtocol__:true }
 *   响应是 mtop **协议树**（data.data + data.hierarchy.structure），
 *   `taobao.ts` 适配器的解析器本来就是吃这个结构的（被动捕获同款），零改动复用。
 *
 * 翻页：`data.global.pageControl.hasMore` + `nextPageIndex`（每页 30 个店铺单）。
 */
import {
  mtopH5Request,
  type MtopHttp,
  defaultMtopHttp
} from './mtop-h5'
import { withPageRetry } from './page-retry'
import { info } from '../logging/logger'

export const TAOBAO_MTOP_API = 'mtop.taobao.order.queryboughtlistV2'
export const TAOBAO_MTOP_ORIGIN = 'https://buyertrade.taobao.com'
export const TAOBAO_MTOP_REFERER =
  'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'

/** 单页业务参数（竞品抓包样本原样参数） */
export function taobaoOrderListData(page: number): Record<string, unknown> {
  return {
    tabCode: 'all',
    page,
    OrderType: 'OrderList',
    appName: 'tborder',
    appVersion: '3.0',
    condition: '{"directRouteToTm2Scene":"1"}',
    __needlessClearProtocol__: true
  }
}

export interface TaobaoPageInfo {
  shopCount: number
  hasMore: boolean
  nextPageIndex: number
}

/** 从协议树响应里取分页信息（pageControl 优先，pagination 节点兜底） */
export function taobaoPageInfo(json: Record<string, unknown> | null | undefined): TaobaoPageInfo {
  const data = (json?.data ?? {}) as Record<string, any>
  const pc = data.global?.pageControl ?? {}
  const hasMore =
    typeof pc.hasMore === 'boolean' ? pc.hasMore : Boolean(data.data?.pagination?.fields?.hasMore)
  const nextPage = Number(pc.nextPageIndex)
  const currentPage = Number(data.data?.pagination?.fields?.currentPage ?? 1)
  const shopKeys = Array.isArray(data.hierarchy?.structure?.orderContainer)
    ? (data.hierarchy.structure.orderContainer as string[]).filter((k) =>
        String(k).startsWith('shopOrderContainer_')
      )
    : []
  return {
    shopCount: shopKeys.length,
    hasMore,
    nextPageIndex: Number.isFinite(nextPage) && nextPage > 0 ? nextPage : currentPage + 1
  }
}

export interface TaobaoApiFetchOptions {
  /** 安全上限（每页 30 单，200 页 = 6000 单） */
  maxPages?: number
  delayMs?: number
}

export interface TaobaoApiRpc {
  /** 拉一页；失败/风控抛错 */
  page: (page: number) => Promise<Record<string, unknown>>
}

export interface TaobaoApiHandlers {
  onResponse: (json: Record<string, unknown>, page: number) => void
  onProgress?: (page: number, info: TaobaoPageInfo) => void
  onRetry?: (attempt: number, page: number) => void
  sleep?: (ms: number) => Promise<void>
  cancelCheck?: () => void
  /** 增量抓取：返回 true = 刚 onResponse 的一页全是本地已知单，可停止翻页 */
  shouldStop?: () => boolean
}

/** ret 里带这些关键字 = 登录态失效 */
const SESSION_EXPIRED = /FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_ACCESS_TOKEN|SESSION_EXPIRED/i
/** 滑块/风控 */
const USER_VALIDATE = /FAIL_SYS_USER_VALIDATE|RGV587_FLAG|FAIL_SYS_ANTI/i

export class TaobaoSessionError extends Error {
  constructor() {
    super('淘宝登录态已失效，请重新扫码登录')
    this.name = 'TaobaoSessionError'
  }
}

export class TaobaoValidateError extends Error {
  constructor() {
    super('淘宝要求滑块/人机验证，请打开淘宝页面手动完成后重试')
    this.name = 'TaobaoValidateError'
  }
}

/** 把 mtop ret 翻译成人类可读错误；SUCCESS 之外的都算失败 */
export function taobaoRetError(ret: string[]): Error | null {
  const text = ret.join(';')
  if (/SUCCESS/.test(text)) return null
  /**
   * 风控判定要**先于**会话过期（2026-11-11）：淘宝被人机验证拦下时，
   * ret 里可能同时夹带 SESSION_EXPIRED 字样，先判会话过期就会把「去过滑块」
   * 误报成「重新扫码」，用户重扫多少次都没用。
   */
  if (USER_VALIDATE.test(text)) return new TaobaoValidateError()
  if (SESSION_EXPIRED.test(text)) return new TaobaoSessionError()
  return new Error(`淘宝接口返回错误：${text.slice(0, 120)}`)
}

/**
 * 逐页拉全量（纯逻辑，可单测）。
 * 终止：hasMore=false / 空页 / 页数上限 / 重复页（nextPageIndex 不推进）。
 */
export async function fetchTaobaoOrdersByApi(
  rpc: TaobaoApiRpc,
  options: TaobaoApiFetchOptions,
  handlers: TaobaoApiHandlers
): Promise<{ pages: number; orders: number }> {
  const maxPages = options.maxPages ?? 200
  const sleep = handlers.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let pages = 0
  let orders = 0

  for (let page = 1; page <= maxPages; page++) {
    handlers.cancelCheck?.()
    // 页级重试：mtop 偶发超时/风控抖动；连续失败 3 次（1 次 + 2 重试）才中断
    const json = await withPageRetry(() => rpc.page(page), {
      onRetry: (attempt) => handlers.onRetry?.(attempt, page),
      sleep
    })
    const info = taobaoPageInfo(json)
    pages += 1
    orders += info.shopCount
    handlers.onResponse(json, page)
    // 增量抓取：这一页全是本地已知单 → 更后面的页只会更旧，直接收工
    if (handlers.shouldStop?.()) break
    handlers.onProgress?.(page, info)
    if (!info.hasMore || info.shopCount === 0) break
    // nextPageIndex 不推进 = 服务端没给分页游标，避免死循环
    if (info.nextPageIndex <= page) break
    await sleep(options.delayMs ?? 600)
  }
  return { pages, orders }
}

/**
 * 组装 rpc：mtop h5 直连（token 引导一次后全页复用）。
 * 这里持有会话 Cookie 串与 mtop 客户端，供 fetch-runner 调用。
 */
export function taobaoApiRpc(
  cookieString: string,
  opts: { http?: MtopHttp; timeoutMs?: number } = {}
): {
  rpc: TaobaoApiRpc
  getCookieString: () => string
} {
  const http = opts.http ?? defaultMtopHttp
  let cookie = cookieString
  return {
    getCookieString: () => cookie,
    rpc: {
      page: async (page: number) => {
        const r = await mtopH5Request(http, {
          api: TAOBAO_MTOP_API,
          v: '1.0',
          data: taobaoOrderListData(page),
          ecode: '1',
          origin: TAOBAO_MTOP_ORIGIN,
          referer: TAOBAO_MTOP_REFERER,
          cookieString: cookie,
          timeoutMs: opts.timeoutMs
        })
        cookie = r.cookieString
        const err = taobaoRetError(r.ret)
        if (err) {
          // ret 原文是区分「风控 / 会话失效 / 参数错」的唯一依据，别只留一句结论
          info('fetch:taobao', 'mtop 返回错误', {
            page,
            ret: r.ret.join(';').slice(0, 200),
            kind: err.name
          })
          throw err
        }
        if (!r.json || Object.keys(r.json).length === 0) {
          throw new Error('淘宝接口返回空响应（可能未登录）')
        }
        return r.json
      }
    }
  }
}
