/**
 * 工单 012/013/015/040：主动批量抓取编排 IPC。
 *
 * 2026-10-31（工单 040）起，四大平台全部为**接口型**抓取，无需打开订单页：
 *   拼多多：主进程直连 order_list_v4（Cookie 直连 + 页面截获 anti_content 复用翻页）
 *   淘宝  ：mtop h5 直连（本地 md5 签名，竞品抓包参数，协议树响应）
 *   京东  ：隐藏页当签名宿主 → pcorder_center_list 接口翻页（h5st 由页面 PSign 算）
 *   闲鱼  ：隐藏 webview 页面 SDK（goofish mtop，签名仍由页面算）
 *
 * 每页响应构造成 CaptureReport 注入**同一个 CaptureEngine**，
 * 因此路由/解析/去重/渲染层事件链路与被动浏览完全一致。
 */
import { ipcMain, type BrowserWindow, type Session } from 'electron'
import { bgReloadPlatform } from '../bg-fetch'
import { loadPlatformCache } from '../order-cache'
import { dispatchPageSdkRequest } from '../page-sdk'
import {
  fetchXianyuOrders,
  XIANYU_BOUGHT_API,
  XianyuSessionError,
  XianyuValidateRequiredError
} from './xianyu-fetch'
import { openXianyuHost } from './xianyu-host'
import { withPageRetry } from './page-retry'
import { debug, error, info } from '../logging/logger'
import { fetchTaobaoOrdersByApi, taobaoApiRpc, TaobaoSessionError } from './taobao-api-fetch'
import { fetchTaobaoAsyncOrders, taobaoAsyncUrl } from './taobao-page-fetch'
import { TAOBAO_HOME_URL } from './taobao'
import {
  decodeResponseText,
  fetchTaobaoAsyncPageViaHost,
  parseTaobaoAsyncResponse
} from './taobao-async-host'
import { fetchPddOrdersViaApi } from './pdd-api-fetch'
import { fetchJdOrdersViaApi, JdApiLoginRequiredError } from './jd-api-fetch'
import { cookieValue, sessionCookieString } from './session-http'
import { openHiddenHost } from './host-window'
import type { CaptureEngine } from './capture-engine'
import type { CaptureReport, FetchPlatform, OrdersFetchEvent } from '../../shared/types'

const cancelFlags = new Set<string>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 用户取消时抛出，用于从编排循环中跳出 */
class FetchCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'FetchCancelledError'
  }
}

/** 淘宝 mtop 鉴权必需项：必须排在 Cookie 头最前，超长被截断时先丢的是末尾 */
const TAOBAO_AUTH_COOKIES = ['_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 'unb', '_tb_token_']

/** 静默续期用的通用 Chrome UA（与隐藏宿主窗口一致） */
const RENEW_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/**
 * 会话静默续期：开一次隐藏页面访问平台首页，让站点自己的 SSO/页面请求
 * 刷新会话 Cookie（session2/sgcookie 这类短命凭据页面自己会续）。
 *
 * 「登录态失效」很多时候只是这类短命 Cookie 过期而长命凭据（unb 等）还在，
 * 直接让用户重扫是过度反应。失败（网络/窗口问题）返回 false，调用方继续走原错误。
 */
async function renewSessionViaPage(
  partition: string,
  url: string,
  label: string
): Promise<boolean> {
  try {
    const host = await openHiddenHost({ partition, url, userAgent: RENEW_UA, openLabel: label })
    // 页面加载 + 它自己的 SSO/初始化请求需要几秒才能把会话 Cookie 刷新
    await sleep(5000)
    host.destroy()
    return true
  } catch {
    return false
  }
}

export interface FetchRunnerOptions {
  getMainWindow: () => BrowserWindow | null
  engine: CaptureEngine
  /** 按平台取会话分区（拼多多/淘宝直连抓取读 Cookie 用） */
  getSession: (platform: string) => Session
}

export function setupOrdersFetchIpc({ getMainWindow, engine, getSession }: FetchRunnerOptions): void {
  const emit = (payload: Omit<OrdersFetchEvent, 'ts'>): void => {
    // 抓取的每条阶段变化都落日志：出问题时能直接看到「哪一步停的、报了什么」
    const scope = `fetch:${payload.platform}`
    if (payload.phase === 'started') {
      info(scope, '抓取开始', { platform: payload.platform })
    } else if (payload.phase === 'progress') {
      debug(scope, payload.message || '抓取进度', {
        pages: payload.pages,
        orders: payload.orders,
        detail: payload.detail
      })
    } else if (payload.phase === 'completed') {
      if (payload.ok) {
        info(scope, payload.cancelled ? '抓取已取消' : '抓取完成', {
          pages: payload.pages,
          orders: payload.orders
        })
      } else {
        error(scope, '抓取失败', { error: payload.error })
      }
    }
    try {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:fetch-event', { ...payload, ts: Date.now() })
      }
    } catch {
      /* 窗口尚未就绪，丢弃该条事件 */
    }
  }

  /**
   * 把主动抓取的一页响应按被动捕获的同样路径喂给引擎。
   * @param known 增量基准：本地已知的单号集合（不传 = 不做增量判定）
   * @returns 本页「本地没有的新订单」数量；无法判定时为 null
   */
  const ingest = (
    body: unknown,
    url: string,
    kind: CaptureReport['kind'],
    method: string,
    known?: Set<string>
  ): number | null => {
    const report: CaptureReport = { kind, url, method, status: 200, body, ts: Date.now() }
    const outcome = engine.handleReport(report, -1)
    let freshCount: number | null = null
    if (outcome.type === 'ok' && outcome.event) {
      if (known) {
        freshCount = outcome.event.orders.filter((o) => !known.has(o.orderId)).length
      }
      // 主动抓取的事件仍推给渲染层（webviewId 用 -1 表示来自后台抓取）。
      // ingest 在各平台抓取循环的 onResponse 回调里被调，此时窗口可能已销毁：
      // 与 emit() 一致加防护，否则 send 抛异常会打断进行中的整轮抓取。
      try {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return freshCount
        win.webContents.send('orders:captured', { ...outcome.event, webviewId: -1 })
      } catch {
        /* 窗口销毁竞态，丢弃该条事件 */
        return freshCount
      }
    } else if (outcome.type === 'error') {
      try {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('capture:parse-error', { ...outcome.error, webviewId: -1 })
        }
      } catch {
        /* 与上面同理：窗口已销毁 */
      }
    }
    return freshCount
  }

  ipcMain.handle(
    'orders:fetch-all',
    async (
      _event,
      payload: {
        platform: FetchPlatform
        /** 闲鱼仍需要页面 SDK 宿主；拼多多/淘宝/京东已不需要 */
        webviewId?: number
        /** 京东：'current' 今年 / 'all' 逐年全量 / 指定年份 */
        range?: 'current' | 'all' | number
        /** 京东：range='all' 时追溯的年数 */
        years?: number
        months?: number
        /**
         * 增量抓取：以本地缓存为「已知单号」基准，翻到整页全是已知单就停。
         * 不传/传 false = 全量（首次抓取、或渲染层按周期安排的全量刷新）。
         */
        incremental?: boolean
      }
    ): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> => {
      const { platform } = payload
      cancelFlags.delete(platform)
      emit({ platform, phase: 'started' })

      const cancelCheck = (): void => {
        if (cancelFlags.has(platform)) throw new FetchCancelledError()
      }

      // 增量基准：本地缓存的全部单号（各平台分支把它传给自己的 ingest 调用）
      let knownOrderIds: Set<string> | undefined
      if (payload.incremental) {
        const cached = await loadPlatformCache(platform).catch(() => [])
        if (cached.length) {
          knownOrderIds = new Set(cached.map((o: { orderId: string }) => o.orderId).filter(Boolean))
          emit({ platform, phase: 'progress', message: `增量同步：以本地 ${cached.length} 单为基准` })
        }
      }

      try {
        // ---- 拼多多：Cookie 直连 + anti_content 复用；不全时回落隐藏页滚动 ----
        if (platform === 'pdd') {
          // 滚动补全是被动捕获（无页号可报），靠 ingest 计数让用户看到进展
          let fallbackOrders = 0
          let fallbackActive = false
          let lastFallbackEmit = 0
          let outcome = await fetchPddOrdersViaApi({
            session: getSession('pdd'),
            known: knownOrderIds,
            ingest: (body, url) => {
              ingest(body, url, 'xhr', 'POST', knownOrderIds)
              if (fallbackActive && typeof body === 'object' && body) {
                const list = (body as { orders?: unknown[] }).orders
                fallbackOrders += Array.isArray(list) ? list.length : 0
                const now = Date.now()
                if (now - lastFallbackEmit > 600) {
                  lastFallbackEmit = now
                  emit({
                    platform,
                    phase: 'progress',
                    orders: fallbackOrders,
                    message: '页面捕获补全中',
                    detail: `已捕获 ${fallbackOrders} 单`
                  })
                }
              }
            },
            onProgress: (message) => emit({ platform, phase: 'progress', message }),
            cancelCheck
          })
          if (cancelFlags.has('pdd')) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true })
            return { ok: true, cancelled: true }
          }
          if (!outcome.complete) {
            emit({
              platform,
              phase: 'progress',
              orders: outcome.orders,
              message: `接口通道只取到 ${outcome.orders} 单，切换到页面捕获模式补全`
            })
            fallbackActive = true
            try {
              const r = await bgReloadPlatform('pdd')
              if (r.ok) outcome = { ...outcome, complete: true }
            } finally {
              fallbackActive = false
            }
            emit({
              platform,
              phase: 'progress',
              orders: fallbackOrders,
              message: '页面捕获补全完成'
            })
          }
          emit({ platform, phase: 'completed', ok: true, orders: outcome.orders + fallbackOrders })
          return { ok: true }
        }

        // ---- 淘宝：隐藏页预热 + mtop 直连 + 网页版外卖补抓（2026-11-11 改造） ----
        if (platform === 'taobao') {
          // 整个淘宝流程共用一个隐藏页：
          //   ① 预热 Cookie —— mtop 要新鲜的 cookie2/_tb_token_，纯接口调用不会续期
          //   ② 当网页版接口的宿主 —— 裸 fetch 会被 rgv587 判成机器流量（实测）
          const tbHost = await openHiddenHost({
            partition: 'persist:platform-taobao',
            url: TAOBAO_HOME_URL,
            userAgent: RENEW_UA,
            openLabel: '打开淘宝订单页'
          }).catch(() => null)
          try {
            const runOnce = async (): Promise<{ pages: number; orders: number }> => {
              const tbSess = getSession('taobao')
              const cookieString = await sessionCookieString(tbSess, 'taobao', TAOBAO_AUTH_COOKIES)
              // 诊断：Cookie 头过长/缺项是 mtop 判会话失效的常见原因，先把事实记下来
              info('fetch:taobao', 'mtop Cookie 串', {
                bytes: cookieString.length,
                count: cookieString.split('; ').length,
                hasToken: cookieString.includes('_m_h5_tk='),
                hasCookie2: cookieString.includes('cookie2='),
                hasUnb: cookieString.includes('unb='),
                head: cookieString.slice(0, 24).replace(/=[^;]+/g, '=***')
              })
              if (!cookieString) {
                throw new Error('淘宝未登录（分区里没有 Cookie），请先扫码登录')
              }
              const { rpc } = taobaoApiRpc(cookieString)
              let totalOrders = 0
              let sawAllKnown = false
              return await fetchTaobaoOrdersByApi(
                rpc,
                { maxPages: 200, delayMs: 600 },
                {
                  cancelCheck,
                  onResponse: (json) => {
                    const fresh = ingest(
                      json,
                      'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2/1.0/',
                      'xhr',
                      'POST',
                      knownOrderIds
                    )
                    sawAllKnown = knownOrderIds !== undefined && fresh === 0
                  },
                  shouldStop: () => sawAllKnown,
                  onProgress: (page, info) => {
                    totalOrders += info.shopCount
                    emit({
                      platform,
                      phase: 'progress',
                      pages: page,
                      orders: totalOrders,
                      message: '正在逐页拉取全部订单',
                      detail: `第 ${page} 页 · 本页 ${info.shopCount} 单`
                    })
                  },
                  sleep: async (ms) => {
                    cancelCheck()
                    await sleep(ms)
                  }
                }
              )
            }
            let result: { pages: number; orders: number }
            try {
              result = await runOnce()
            } catch (e) {
              // 会话短命（session2/sgcookie 过期但 unb 还在）：开一次隐藏淘宝页让
              // SSO 自己刷新会话，然后重试一次 —— 别让用户为可自动续期的失效重扫
              if (e instanceof TaobaoSessionError && !cancelFlags.has('taobao')) {
                /**
                 * 诊断（2026-11-11）：宿主页是同一份 Cookie 在真浏览器环境里的样子。
                 * 它还认得出登录态 → Cookie 有效，问题在「主进程拼头直连」这条路；
                 * 它自己都跳到登录页 → 服务端会话真的作废，只能重扫。
                 * 这两种结论对应的修法完全不同，不能靠猜。
                 */
                if (tbHost) {
                  const title = await tbHost
                    .evalJs<string>('document.title', 4000, '读取淘宝页标题')
                    .catch(() => '')
                  info('fetch:taobao', '宿主页登录态', {
                    title: String(title).slice(0, 50),
                    href: tbHost.currentUrl().slice(0, 90)
                  })
                }
                emit({ platform, phase: 'progress', message: '登录态过期，正在后台静默续期…' })
                const ok = await renewSessionViaPage(
                  'persist:platform-taobao',
                  'https://www.taobao.com',
                  '续期淘宝登录态'
                )
                if (!ok) throw e
                result = await runOnce()
              } else {
                throw e
              }
            }
            /**
             * 网页版订单补抓（2026-11-02 引入，2026-11-11 起用途改为「补齐漏单」）：
             * mtop 协议树会漏掉少量网页版才有的订单（实测 416 vs 421）。
             * 外卖分栏已下线，这条通道不再承担 bizType 归类，只用来把订单抓全。
             * 补抓失败只提示，不推翻已抓到的接口订单。
             */
            let webPages = 0
            let webOrders = 0
            let webOrdersOnPage = 0
            try {
              emit({
                platform,
                phase: 'progress',
                pages: result.pages,
                orders: result.orders,
                message: '正在补抓网页版订单（补齐接口漏掉的单）…'
              })
              // _tb_token_ 可能是 httpOnly（页面 JS 读不到），从分区 Cookie 取一份兜底
              const tbToken = cookieValue(
                await sessionCookieString(getSession('taobao'), 'taobao', TAOBAO_AUTH_COOKIES),
                '_tb_token_'
              )
              const web = await fetchTaobaoAsyncOrders(
                {
                  // 优先在隐藏页里发（指纹 / Cookie / _tb_token_ 全部正确）；
                  // 宿主打不开才退回主进程裸请求 —— 那条路基本必被 rgv587 拦，只是别让整轮抓取白跑
                  page: async (n) => {
                    if (tbHost) return (await fetchTaobaoAsyncPageViaHost(tbHost, n, tbToken)) as unknown
                    const res = await getSession('taobao').fetch(taobaoAsyncUrl(n), {
                      credentials: 'include',
                      headers: {
                        referer: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'
                      }
                    })
                    if (!res.ok) throw new Error(`网页版订单接口 HTTP ${res.status}`)
                    // 与宿主路径同款编码探测：这条退化路径同样可能拿到 GBK 分片
                    return parseTaobaoAsyncResponse(
                      decodeResponseText(await res.arrayBuffer()).text
                    ) as unknown
                  }
                },
                { maxPages: 20, delayMs: 400 },
                {
                  cancelCheck,
                  onPage: (body, page) => {
                    webOrdersOnPage =
                      ingest(body, taobaoAsyncUrl(page), 'xhr', 'GET', knownOrderIds) ?? 0
                    webOrders += webOrdersOnPage
                  },
                  // 增量：这一页全是本地已知单 → 后面的页只会更旧
                  shouldStop: () => knownOrderIds !== undefined && webOrdersOnPage === 0,
                  onProgress: (page, count) => {
                    emit({
                      platform,
                      phase: 'progress',
                      pages: result.pages + page,
                      orders: result.orders + webOrders,
                      message: '正在补抓网页版订单',
                      detail: `第 ${page} 页 · 本页 ${count} 单`
                    })
                  },
                  sleep: async (ms) => {
                    cancelCheck()
                    await sleep(ms)
                  }
                }
              )
              webPages = web.pages
              if (web.pages) {
                emit({
                  platform,
                  phase: 'progress',
                  pages: result.pages + webPages,
                  orders: result.orders + webOrders,
                  message: `网页版补抓完成：${web.pages} 页 / ${web.orders} 单`
                })
              }
            } catch (e) {
              if (cancelFlags.has('taobao')) throw e
              emit({
                platform,
                phase: 'progress',
                message: `网页版订单补抓失败（可能漏掉部分网页版订单）：${e instanceof Error ? e.message : String(e)}`
              })
            }
            emit({
              platform,
              phase: 'completed',
              ok: true,
              pages: result.pages + webPages,
              orders: result.orders + webOrders
            })
            return { ok: true }
          } finally {
            tbHost?.destroy()
          }
        }

        // ---- 京东：隐藏页签名宿主 + pcorder_center_list 接口翻页 ----
        if (platform === 'jd') {
          const runOnce = async (): Promise<{ pages: number; orders: number }> => {
            let sawAllKnown = false
            return await fetchJdOrdersViaApi({
              ingest: (body, url) => {
                const fresh = ingest(body, url, 'xhr', 'POST', knownOrderIds)
                sawAllKnown = knownOrderIds !== undefined && fresh === 0
              },
              shouldStopPage: () => sawAllKnown,
              onProgress: (p) =>
                emit({
                  platform,
                  phase: 'progress',
                  pages: p.pages,
                  orders: p.orders,
                  message: '正在按年拉取全部订单',
                  detail: `第 ${p.yearsDone}/${p.yearsTotal} 年 · ${p.yearLabel} 第 ${p.page} 页`
                }),
              // 页级重试、某年到底这类瞬时说明：不接的话界面上看不到，
              // 「抓取为什么停在这一年」就只能去翻磁盘日志
              onProgressDetail: (message) => emit({ platform, phase: 'progress', message }),
              cancelCheck,
              // 默认拉全量：京东列表一次只出一年，只抓「今年」会出现
              // 「登录成功但只有几条数据」（2026-10-29 用户反馈过的现象）
              range: payload.range ?? 'all',
              years: payload.years ?? 10
            })
          }
          let result: { pages: number; orders: number }
          try {
            result = await runOnce()
          } catch (e) {
            // 登录页重定向 = 会话过期：先访问一次京东首页让会话自动续期，再试一次
            if (e instanceof JdApiLoginRequiredError && !cancelFlags.has('jd')) {
              emit({ platform, phase: 'progress', message: '登录态过期，正在后台静默续期…' })
              const ok = await renewSessionViaPage(
                'persist:platform-jd',
                'https://www.jd.com',
                '续期京东登录态'
              )
              if (!ok) throw e
              result = await runOnce()
            } else {
              throw e
            }
          }
          if (cancelFlags.has('jd')) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true, pages: result.pages, orders: result.orders })
            return { ok: true, cancelled: true }
          }
          emit({ platform, phase: 'completed', ok: true, pages: result.pages, orders: result.orders })
          return { ok: true }
        }

        // ---- 闲鱼：隐藏 webview 页面 SDK 分页（签名由页面算） ----
        if (platform === 'xianyu') {
          const api = XIANYU_BOUGHT_API
          const runOnce = async (): Promise<{ pages: number }> => {
            let totalOrders = 0
            let sawAllKnown = false
            // 优先用界面 webview；没有就开隐藏宿主（goofish 的 mtop 会话键在
            // CHIPS 分区 Cookie 里，纯直连必失效，页面宿主才能带上）
            let host: { webContentsId: number; destroy: () => void } | null = null
            let webviewId = payload.webviewId
            if (!webviewId) {
              emit({ platform, phase: 'progress', message: '正在打开闲鱼页面（后台隐藏，不弹界面）…' })
              host = await openXianyuHost()
              webviewId = host.webContentsId
            }
            try {
              return await fetchXianyuOrders(
                {
                  mtop: async (options) => {
                    cancelCheck()
                    const r = await withPageRetry(
                      () => dispatchPageSdkRequest(webviewId, options),
                      { sleep }
                    )
                    if (!r.ok) {
                      // mtop 库失败时走 err 回调，error 是序列化的响应 JSON：
                      // 会话/滑块类错误要还原成语义异常（续期与提示都依赖它们）
                      const raw = String(r.error ?? '')
                      if (/SESSION_EXPIRED|NOT_LOGIN|needLogin/i.test(raw)) {
                        throw new XianyuSessionError()
                      }
                      if (/USER_VALIDATE|ILLEGAL_ACCESS/i.test(raw)) {
                        throw new XianyuValidateRequiredError()
                      }
                      try {
                        return JSON.parse(raw) as never
                      } catch {
                        throw new Error(raw || '页面 SDK 调用失败')
                      }
                    }
                    return r.result as never
                  }
                },
                { delayMs: 600 },
                {
                  sleep: async (ms) => {
                    cancelCheck()
                    await sleep(ms)
                  },
                  onResponse: (body) => {
                    const fresh = ingest(
                      body,
                      `https://h5api.m.goofish.com/h5/${api}/1.0/`,
                      'xhr',
                      'POST',
                      knownOrderIds
                    )
                    if (knownOrderIds !== undefined && fresh === 0) sawAllKnown = true
                    const items = (body as { data?: { items?: unknown[] } }).data?.items
                    totalOrders += Array.isArray(items) ? items.length : 0
                  },
                  shouldStop: () => sawAllKnown,
                  onProgress: (page) =>
                    emit({
                      platform,
                      phase: 'progress',
                      pages: page,
                      orders: totalOrders,
                      message: '正在逐页拉取订单',
                      detail: `第 ${page} 页`
                    })
                }
              )
            } finally {
              host?.destroy()
            }
          }
          let result: { pages: number }
          try {
            result = await runOnce()
          } catch (e) {
            // 会话过期：先开一次闲鱼首页让 SSO 刷新会话（登录 Cookie 都在时能自愈），
            // 再重试一次；仍然失败才把「登录已失效」交回界面
            if (e instanceof XianyuSessionError && !cancelFlags.has(platform)) {
              emit({ platform, phase: 'progress', message: '登录态过期，正在后台静默续期…' })
              const ok = await renewSessionViaPage(
                'persist:platform-xianyu',
                'https://www.goofish.com',
                '续期闲鱼登录态'
              )
              if (!ok) throw e
              result = await runOnce()
            } else {
              throw e
            }
          }
          if (cancelFlags.has(platform)) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true, pages: result.pages, orders: 0 })
            return { ok: true, cancelled: true }
          }
          emit({ platform, phase: 'completed', ok: true, pages: result.pages })
          return { ok: true }
        }

        return { ok: false, message: `暂不支持平台 ${platform} 的主动抓取` }
      } catch (err) {
        const cancelled = cancelFlags.has(platform) || err instanceof FetchCancelledError
        const message = cancelled
          ? '已取消'
          : err instanceof Error
            ? err.message
            : String(err)
        emit({ platform, phase: 'completed', ok: false, cancelled, error: cancelled ? undefined : message })
        return { ok: false, cancelled, message }
      } finally {
        cancelFlags.delete(platform)
      }
    }
  )

  ipcMain.handle('orders:cancel-fetch', (_event, platform: FetchPlatform) => {
    cancelFlags.add(platform)
    return { ok: true }
  })
}
