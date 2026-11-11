/**
 * 工单 040：京东订单**接口直连**抓取（隐藏页做签名宿主，不再滚动/逐年点击）。
 *
 * 京东的 `pcorder_center_list` 需要 h5st 签名 + x-api-eid-token：
 *   - h5st 由订单页自带的 `window.PSign.sign()` 计算（算法在页面 JS 里，
 *     逆向成本高且随版本变化，魔猫京东版也是复用页面签名器）
 *   - 参与签名的是 {appid, functionId, client, clientVersion, t} + body 的 SHA256
 *   - body = {page, s:4096, d:<年份码>}（d=2 今年 / d=YYYY 往年 / d=3 2014 以前）
 *   - 每页 20 条，不足 20 条 = 该年度抓完（2026-10-31 实测翻页/往年遍历全通过）
 *   - 订单数正好是 20 的整数倍时要多翻一页才知道到底；京东对越界页返回的是
 *     `{revision, success:true, traceId, requestId, recycleType}` 空壳而非空数组
 *     （2026-11-11 实测），不能当错误（见 `isJdEmptyPageShell`）
 *
 * 所以方案 = 打开一次**隐藏**页面当签名宿主，之后每一页都是 api.m.jd.com
 * 的纯接口调用，数据走与被动捕获完全相同的解析链路（`jd.ts`）。
 */
import { withPageRetry } from './page-retry'
import { openHiddenHost, sleep } from './host-window'

/** range='all' 时最多追溯的年数 */
const YEARS_LIMIT = 10

/** 把 range 展开成逐年抓取的计划（今年用 'current'，往年用具体年份） */
export function resolveYearRanges(
  range: 'current' | 'all' | number | undefined,
  years: number | undefined,
  currentYear = new Date().getFullYear()
): Array<'current' | number> {
  if (range !== 'all') return [range ?? 'current']
  const n = Math.max(1, Math.min(YEARS_LIMIT, years ?? 5))
  return Array.from({ length: n }, (_, i) =>
    i === 0 ? ('current' as const) : currentYear - i
  )
}

export const JD_ORDER_CENTER_URL = 'https://order.jd.com/center/list.action'
/** 注入的接口调用 URL（ingest 给捕获引擎路由用，须命中 jd.ts 的 matchRules） */
export function jdApiUrl(functionId = 'pcorder_center_list'): string {
  return `https://api.m.jd.com/api?functionId=${functionId}&source=pc_order_center`
}

const JD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export class JdApiLoginRequiredError extends Error {
  constructor(message = '京东登录态已失效，请重新扫码登录') {
    super(message)
    this.name = 'JdApiLoginRequiredError'
  }
}

/** 页面内执行一次 pcorder_center_list 调用（自包含，可 stringify 注入） */
export function jdApiCallScript(d: number, page: number): string {
  return `(async () => {
  const getCookie = (n) => (document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')) || [])[1] || ''
  const data = { page: ${page}, s: 4096, d: ${d} }
  const params = {
    appid: 'order-jd-com', functionId: 'pcorder_center_list', client: 'pc',
    clientVersion: '1.0.0', uuid: getCookie('__jda') || '', loginType: '3', t: Date.now()
  }
  let h5st = ''
  try {
    const signPayload = { ...params, body: window.SHA256(JSON.stringify(data)) }
    const r = await window.PSign.sign(signPayload)
    h5st = (r && r.h5st) || ''
  } catch (e) { /* 签名失败裸发，与魔猫同策略 */ }
  let jt = ''
  try {
    jt = await new Promise((res, rej) => {
      if (window.getJsToken) window.getJsToken(res, 200)
      else res('')
    })
  } catch (e) { /* token 缺失容忍 */ }
  const qs = new URLSearchParams({ ...params, source: 'pc_order_center', h5st })
  if (jt) qs.set('x-api-eid-token', jt)
  const res = await fetch('https://api.m.jd.com/api?' + qs.toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=' + encodeURIComponent(JSON.stringify(data))
  })
  return { status: res.status, text: (await res.text()).slice(0, 400000) }
})()`
}

/** 年份码：今年=2，往年=YYYY（d 参数语义） */
export function jdYearCode(range: 'current' | number, currentYear = new Date().getFullYear()): number {
  if (range === 'current' || range === currentYear) return 2
  return range as number
}

/** 从 pcorder_center_list 响应里取 orderList（jd.ts 解析同样的两种包裹） */
export function jdOrderListOf(json: Record<string, unknown> | null): unknown[] {
  if (!json) return []
  const data = json.data as Record<string, any> | undefined
  if (!data) return []
  const root = Array.isArray(data.orderList) ? data : (data.data ?? {})
  return Array.isArray(root.orderList) ? root.orderList : []
}

/**
 * 京东「翻过了最后一页」的空壳响应：`{revision, success, traceId, requestId, recycleType}`。
 *
 * 页码越界时京东不返回 `data.orderList: []`，而是回一个只有信封字段的响应
 * （2026-11-11 实测：2024 年共 120 单 = 6 个整页，第 7 页就是这个形状）。
 * 业务含义是「查完了、没有更多数据」，不是错误。
 */
export function isJdEmptyPageShell(json: Record<string, unknown> | null): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  if (json.data !== undefined && json.data !== null) return false
  // 显式 success === true 才算「查完了」：失效/风控的响应要么没有 success，要么是 false
  if (json.success !== true) return false
  const code = json.code
  // 带错误码的不算空壳（"0" / 空串视为无错）
  if (code !== undefined && code !== null && String(code) !== '0' && String(code) !== '') return false
  return true
}

export type JdPageVerdict = 'ok' | 'year-end' | 'login' | 'error'

/**
 * 单页响应定性。抽成纯函数是为了能测：区分「该年到底」和「真异常」是这条路的核心难点。
 *
 * @param pagesSoFar 本次抓取已成功取到数据的页数
 */
export function classifyJdPage(
  json: Record<string, unknown> | null,
  pagesSoFar: number,
  rawText: string
): JdPageVerdict {
  if (json && json.data !== undefined && json.data !== null) return 'ok'
  // 登录失效/风控时常是 200 + JSON，靠文案判定，优先于「到底」
  if (/passport|login|notlogin|未登录|登录/i.test(rawText)) return 'login'
  // 前面已经成功取到过数据 → 空壳只能是页码越界。
  // 首屏就空壳（pagesSoFar=0）时分不清「一单都没有」和「登录态异常」，
  // 仍按异常上报，避免沿用旧逻辑的坑：静默跳过所有年份后报「完成 0 单」。
  if (pagesSoFar > 0 && isJdEmptyPageShell(json)) return 'year-end'
  return 'error'
}

/** 结构化进度：抓取界面据此展示「第 X/Y 年 · 年份 第 N 页 · 已抓 M 单」 */
export interface JdProgress {
  /** 年度计划总数（如 range='all' 共 9 年） */
  yearsTotal: number
  /** 已完成的年份数（含当前正在抓的这年） */
  yearsDone: number
  /** 当前年份标签（'今年' / '2024 年'） */
  yearLabel: string
  /** 当前年内页号 */
  page: number
  /** 累计页数 */
  pages: number
  /** 累计订单数 */
  orders: number
}

export interface JdViaApiDeps {
  /** 每页响应喂给捕获引擎 */
  ingest: (body: unknown, url: string) => void
  onProgress?: (p: JdProgress) => void
  /** 重试等瞬时状态文案（追加到 detail） */
  onProgressDetail?: (message: string) => void
  cancelCheck: () => void
  /** 'current' 今年 / 'all' 逐年 / 指定年份 */
  range?: 'current' | 'all' | number
  years?: number
  /** 增量抓取：返回 true = 刚 ingest 的一页全是本地已知单，可停止翻页 */
  shouldStopPage?: () => boolean
}

export interface JdApiFetchResult {
  pages: number
  orders: number
}

/**
 * 京东接口直连编排：隐藏页签名宿主 + 逐年逐页接口翻页。
 * 页面会话与登录态共用 `persist:platform-jd` 分区。
 */
export async function fetchJdOrdersViaApi(deps: JdViaApiDeps): Promise<JdApiFetchResult> {
  const host = await openHiddenHost({
    partition: 'persist:platform-jd',
    url: JD_ORDER_CENTER_URL,
    userAgent: JD_UA,
    openLabel: '打开京东订单页'
  })
  let pages = 0
  let orders = 0
  try {
    // 页面跳到 passport = 未登录
    if (/passport\.jd\.com|\/login/i.test(host.currentUrl())) {
      throw new JdApiLoginRequiredError()
    }

    // 等 SPA 挂出签名器
    let signReady = false
    for (let i = 0; i < 30 && !signReady; i++) {
      await sleep(1000)
      deps.cancelCheck()
      signReady = (await host
        .evalJs<boolean>('!!(window.PSign && window.PSign.sign && window.SHA256)', 8_000, '检查签名器')
        .catch(() => false)) as boolean
    }
    if (!signReady) {
      // 可能未登录（订单页被重定向）或改版
      const url = host.currentUrl()
      if (/passport\.jd\.com|\/login/i.test(url)) throw new JdApiLoginRequiredError()
      throw new Error('京东订单页签名器未就绪（页面可能改版），请打开京东页面确认后重试')
    }

    const currentYear = new Date().getFullYear()
    const yearRanges = resolveYearRanges(deps.range ?? 'current', deps.years ?? 5, currentYear)

    outer: for (let yearIndex = 0; yearIndex < yearRanges.length; yearIndex++) {
      const yearRange = yearRanges[yearIndex]
      const d = jdYearCode(yearRange, currentYear)
      const yearLabel = yearRange === 'current' ? '今年' : `${yearRange} 年`
      for (let page = 1; page <= 200; page++) {
        deps.cancelCheck()
        let raw: { status: number; text: string }
        try {
          // 页级重试：页面脚本偶发超时/网络抖动；登录态错误不重试
          raw = await withPageRetry(
            async () =>
              (await host.evalJs<{ status: number; text: string }>(
                jdApiCallScript(d, page),
                30_000,
                `京东接口调用 d=${d} p=${page}`
              )) as { status: number; text: string },
            {
              onRetry: (attempt) =>
                deps.onProgressDetail?.(`第 ${page} 页重试中（第 ${attempt} 次）`),
              sleep
            }
          )
        } catch (e) {
          if (e instanceof Error && e.name === 'FetchCancelledError') throw e
          throw new Error(`京东接口调用失败：${e instanceof Error ? e.message : String(e)}`)
        }
        if (raw.status !== 200) {
          throw new Error(`京东接口 HTTP ${raw.status}`)
        }
        let json: Record<string, unknown> | null = null
        try {
          json = JSON.parse(raw.text) as Record<string, unknown>
        } catch {
          const head = raw.text.trim().slice(0, 100).replace(/\s+/g, ' ')
          if (/passport|login|登录|验证/i.test(head)) throw new JdApiLoginRequiredError()
          throw new Error(`京东接口返回异常：${head || '空响应'}`)
        }
        // JSON 形态的业务错误（登录失效/风控时仍是 200 + JSON，但缺少 data 包裹）：
        // 不检查会被 jdOrderListOf 吞成空数组，10 个年份全部静默跳过后报「完成 0 单」。
        // 但「页码越界」也长这个样（see isJdEmptyPageShell），所以用 classifyJdPage 区分。
        const verdict = classifyJdPage(json, pages, raw.text)
        if (verdict === 'login') throw new JdApiLoginRequiredError()
        if (verdict === 'year-end') {
          // 该年订单数正好是 20 的整数倍时，必然多翻这一页才发现到底
          deps.onProgressDetail?.(`${yearLabel}已到底（第 ${page} 页无数据）`)
          continue outer
        }
        if (verdict === 'error') {
          const head = raw.text.trim().slice(0, 200).replace(/\s+/g, ' ')
          throw new Error(
            pages === 0
              ? `京东接口返回异常数据：${head || '空数据'}（本次一单未取到，请确认登录态是否有效）`
              : `京东接口返回异常数据：${head || '空数据'}（第 ${page} 页）`
          )
        }
        const list = jdOrderListOf(json)
        pages += 1
        orders += list.length
        if (list.length) {
          deps.ingest(json, jdApiUrl())
          deps.onProgress?.({
            yearsTotal: yearRanges.length,
            yearsDone: yearIndex + 1,
            yearLabel,
            page,
            pages,
            orders
          })
        }
        // 增量抓取：这一页全是本地已知单 → 更早的年份/页只会更旧，直接收工
        if (deps.shouldStopPage?.()) {
          deps.onProgressDetail?.('增量同步：本页无新订单，已停止翻页')
          break outer
        }
        // 不满 20 条 = 该年度到底了
        if (list.length < 20) continue outer
        await sleep(600)
      }
    }
    return { pages, orders }
  } finally {
    host.destroy()
  }
}
