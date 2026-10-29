/**
 * 工单 012（主动抓取）：京东订单分批编排（纯逻辑，无 Electron 依赖，可单测）。
 *
 * ⚠️ 2026-10-26 实测：京东订单页已改成 SPA（bundle `pc_orderList` 0.0.41），
 *   `order.jd.com/center/list.action?...&__fetch__=1` 现在返回 **HTML 壳**
 *   （status 200、约 23KB `<!doctype html>`），不再是 JSON 数组。
 *   真实数据走 `api.m.jd.com/api?functionId=pcorder_center_list`（POST，带签名），
 *   只能由页面自己发出 → 改为「被动捕获 + 页面点下一页」。
 *
 *   本模块因此**不再用于自动抓取**，仅保留：
 *   - 万一京东恢复 `__fetch__=1` 的 JSON 行为，把它加回 FETCH_PLATFORMS 即可复用；
 *   - 单测固化「按年分页」的原版语义（d=2&s=4096 今年 / d=<year>&s=4096 往年）。
 *
 * 复刻 asar_jd renderer.js 的 getListData：
 *   时间范围值由客户端按年份生成（HTML 仅用于判定新旧版，不影响取数）：
 *     今年 → "2&s=4096"；指定年份 → "{year}&s=4096"
 *   URL：/center/list.action?d={range}&page={N}&__fetch__=1
 *   终止：空页 / 末条 createdTs 早于范围起点（needNext）/ 页数上限
 *
 * D-2：请求由页面内同源 fetch 发出（rpc.pageGet），浏览器携带用户 Cookie，
 * 应用不接触签名/鉴权头。
 */

export interface JdFetchOptions {
  /**
   * `'current'` 只抓今年；`'all'` 今年起往前 `years` 年逐年抓；
   * 或指定年份（如 2025）。
   *
   * 京东列表接口的时间范围是**按年**的（`d=2&s=4096` 今年，`d=2025&s=4096` 2025 年），
   * 一次只能覆盖一年。想要「登录后把订单全抓回来」就必须逐年遍历 ——
   * 只传 `'current'` 会出现「登录成功但只有几条数据」。
   */
  range?: 'current' | 'all' | number
  /** `range='all'` 时追溯的年数（含今年），默认 5，上限 10 */
  years?: number
  /** 单年最大分页数（安全上限） */
  maxPages?: number
  /** 全部年份合计的最大分页数（防止极端账号跑太久） */
  maxTotalPages?: number
  /** 每页间隔（ms），由调用方注入便于测试 */
  delayMs?: number
}

export interface JdPageResponse {
  /** 已 JSON.parse 的响应体（数组或包裹） */
  body: unknown
  url: string
  page: number
}

export interface JdFetchRpc {
  pageGet: (url: string) => Promise<{ status: number; url: string; text: string }>
}

export interface JdFetchHandlers {
  onResponse: (r: JdPageResponse) => void
  onProgress?: (done: number) => void
  sleep?: (ms: number) => Promise<void>
}

export class JdLoginRequiredError extends Error {
  constructor(
    message = '京东未登录或需要滑块验证，请在页面中完成后重试'
  ) {
    super(message)
    this.name = 'JdLoginRequiredError'
  }
}

const JD_LIST_PATH = '/center/list.action'
const PAGE_LIMIT = 100
const TOTAL_PAGE_LIMIT = 200
const YEARS_LIMIT = 10

/** 原版时间范围 value：今年 "2&s=4096"，往年 "{year}&s=4096" */
export function jdRangeValue(
  range: 'current' | number | undefined,
  currentYear = new Date().getFullYear()
): string {
  if (range === undefined || range === 'current') return '2&s=4096'
  // 今年用原版的 "2" 而不是四位年份
  if (range === currentYear) return '2&s=4096'
  return `${range}&s=4096`
}

/** 把 range 展开成逐年抓取的计划（今年用 'current'，往年用具体年份） */
export function resolveYearRanges(
  range: JdFetchOptions['range'],
  years: number | undefined,
  currentYear = new Date().getFullYear()
): Array<'current' | number> {
  if (range !== 'all') return [range ?? 'current']
  const n = Math.max(1, Math.min(YEARS_LIMIT, years ?? 5))
  return Array.from({ length: n }, (_, i) =>
    i === 0 ? ('current' as const) : currentYear - i
  )
}

/** 范围起点时间戳（用于 needNext 判定） */
function rangeStart(
  range: 'current' | number | undefined,
  currentYear: number
): number {
  const year = range === undefined || range === 'current' ? currentYear : range
  return new Date(`${year}-01-01T00:00:00`).getTime()
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function fetchJdOrders(
  rpc: JdFetchRpc,
  options: JdFetchOptions,
  handlers: JdFetchHandlers
): Promise<{ pages: number; stoppedByCutoff: boolean }> {
  const currentYear = new Date().getFullYear()
  const maxPages = options.maxPages ?? PAGE_LIMIT
  const maxTotalPages = options.maxTotalPages ?? TOTAL_PAGE_LIMIT
  const sleep = handlers.sleep ?? sleepDefault
  const delay = options.delayMs ?? 500
  const yearRanges = resolveYearRanges(options.range, options.years, currentYear)

  let pages = 0
  let stoppedByCutoff = false

  outer: for (const yearRange of yearRanges) {
    const d = jdRangeValue(yearRange, currentYear)
    const cutoff = rangeStart(yearRange, currentYear)

    for (let page = 1; page <= maxPages; page++) {
      if (pages >= maxTotalPages) break outer

      const url = `${JD_LIST_PATH}?d=${encodeURIComponent(d)}&page=${page}&__fetch__=1`
      const response = await rpc.pageGet(url)

      // redirect:'manual' 下登录跳转 status=0；非 200 同样视为需要登录
      if (
        response.status === 0 ||
        response.status === 302 ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw new JdLoginRequiredError()
      }
      if (response.status !== 200) {
        throw new Error(`京东列表请求失败：HTTP ${response.status}`)
      }

      let body: unknown
      try {
        body = JSON.parse(response.text)
      } catch {
        // 非 JSON：要么是登录页/滑块验证页，要么是京东把订单页改成了 HTML 渲染。
        // 必须区分开 —— 一律报「未登录」会掩盖真正的接口改版。
        const head = response.text.trim().slice(0, 200).replace(/\s+/g, ' ')
        const looksLogin = /passport|login|登录|验证/i.test(head)
        throw new JdLoginRequiredError(
          looksLogin
            ? '京东未登录或需要滑块验证，请在页面中完成后重试'
            : `京东订单接口返回异常（HTTP ${response.status}，非 JSON）：${head.slice(0, 80) || '空响应'}`
        )
      }

      const list = Array.isArray(body)
        ? body
        : ((body as { data?: { orderList?: unknown[] } })?.data?.orderList ?? [])
      if (!Array.isArray(list)) throw new JdLoginRequiredError()

      pages += 1
      handlers.onResponse({ body, url: response.url, page })
      handlers.onProgress?.(pages)

      // 空页 = 这一年抓完了，换下一年
      if (list.length === 0) break

      // needNext：末条 createdTs 仍在范围内才继续（原版逻辑）
      const last = list[list.length - 1] as { createdTs?: string | number } | undefined
      const lastTs = last?.createdTs ? new Date(last.createdTs).getTime() : NaN
      if (Number.isFinite(lastTs) && lastTs < cutoff) {
        stoppedByCutoff = true
        break
      }
      if (page < maxPages) await sleep(delay)
    }
  }

  return { pages, stoppedByCutoff }
}
