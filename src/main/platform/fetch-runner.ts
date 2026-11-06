/**
 * 工单 012/013/014：主动批量抓取编排 IPC。
 *
 * 京东：页面内同源 fetch 逐页取 list.action?__fetch__=1
 * 淘宝：页面官方 mtop SDK 按月分批取 queryboughtlistV2
 * 1688：页面官方 mtop SDK 分页取 dataline.service（buyerOrderList）
 *
 * 每页响应构造成 CaptureReport 注入**同一个 CaptureEngine**，
 * 因此路由/解析/去重/渲染层事件链路与被动浏览完全一致。
 */
import { ipcMain, webContents, type BrowserWindow } from 'electron'
import { bgReloadPlatform } from '../bg-fetch'
import {
  BudgetExceededError,
  CooldownActiveError,
  EarlyStopError,
  RiskControlError,
  addUsage,
  assertCooldown,
  budgetLeft,
  chargeRequest,
  coveredMonthKeys,
  detectRiskStatus,
  detectRiskText,
  humanGap,
  monthKeyOfRangeStart,
  restEvery,
  restGap,
  setCooldown
} from './fetch-guard'
import { loadPlatformCache, savePlatformCache } from '../order-cache'
import { dispatchPageFetch, dispatchPageSdkRequest } from '../page-sdk'
import {
  TAOBAO_FETCH_ALL_SCRIPT,
  TaobaoFetchAllRaw,
  toOrderFromMain
} from './taobao-v2-fetch'
import { fetchJdOrders } from './jd-fetch'
import { fetchTaobaoOrders } from './taobao-fetch'
import { XIANYU_BOUGHT_API, XIANYU_SOLD_API, fetchXianyuOrders } from './xianyu-fetch'
import type { CaptureEngine } from './capture-engine'
import type { CaptureReport, FetchPlatform, OrdersFetchEvent } from '../../shared/types'

const cancelFlags = new Set<string>()
/** 正在抓取的平台，防并发重复触发 */
const inFlight = new Set<string>()

/** 给 executeJavaScript 包一层超时，页面卡死时不让 IPC handler 永久挂起 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * mtop/页面返回的头部字符串化，供风控扫描。
 * ret 码在 data 之前，4KB 头部足够覆盖；整页订单体不进入扫描串。
 */
function safeHead(value: unknown): string {
  try {
    return JSON.stringify(value ?? '').slice(0, 4000)
  } catch {
    return ''
  }
}

/** 用户取消时抛出，用于从编排循环中跳出 */
class FetchCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'FetchCancelledError'
  }
}

export interface FetchRunnerOptions {
  getMainWindow: () => BrowserWindow | null
  engine: CaptureEngine
}

export function setupOrdersFetchIpc({ getMainWindow, engine }: FetchRunnerOptions): void {
  const emit = (payload: Omit<OrdersFetchEvent, 'ts'>): void => {
    try {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:fetch-event', { ...payload, ts: Date.now() })
      }
    } catch {
      /* 窗口尚未就绪，丢弃该条事件 */
    }
  }

  /** 把主动抓取的一页响应按被动捕获的同样路径喂给引擎；返回引擎判定供增量早停使用 */
  const ingest = (
    body: unknown,
    url: string,
    kind: CaptureReport['kind'],
    method: string
  ): ReturnType<CaptureEngine['handleReport']> => {
    const report: CaptureReport = { kind, url, method, status: 200, body, ts: Date.now() }
    const outcome = engine.handleReport(report, -1)
    const win = getMainWindow()
    // 主动抓取的事件仍推给渲染层（webviewId 用 -1 表示来自后台抓取）
    if (outcome.type === 'ok' && outcome.event) {
      win?.webContents.send('orders:captured', { ...outcome.event, webviewId: -1 })
    } else if (outcome.type === 'error') {
      win?.webContents.send('capture:parse-error', { ...outcome.error, webviewId: -1 })
    }
    return outcome
  }

  ipcMain.handle(
    'orders:fetch-all',
    async (
      _event,
      payload: {
        platform: FetchPlatform
        webviewId: number
        /** 京东：'current' 今年 / 'all' 逐年全量 / 指定年份 */
        range?: 'current' | 'all' | number
        /** 京东：range='all' 时追溯的年数 */
        years?: number
        months?: number
        /** 强制全量：跳过增量早停与月份跳过，重请求所有页（本地数据自愈用） */
        full?: boolean
      }
    ): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> => {
      const { platform, webviewId } = payload
      cancelFlags.delete(platform)
      emit({ platform, phase: 'started' })

      // 守卫 B：冷却期内拒绝触发（撞过限流后正确行为是退让，不是重试）
      try {
        assertCooldown(platform)
      } catch (err) {
        if (err instanceof CooldownActiveError) {
          emit({ platform, phase: 'completed', ok: false, message: err.message })
          return { ok: false, message: err.message }
        }
        throw err
      }

      // 守卫 A：本地缓存快照 → 页级早停 + 月份跳过；强制全量时两者都 bypass
      const full = payload.full === true
      const cachedOrders = full ? [] : await loadPlatformCache(platform)
      const cacheIds = new Set(
        cachedOrders.filter((o) => o.orderId).map((o) => o.orderId as string)
      )
      const nowD = new Date()
      const coveredKeys = coveredMonthKeys(
        cachedOrders,
        (m) => new Date(nowD.getFullYear(), nowD.getMonth() - m, 1).getTime(),
        payload.months ?? 12
      )
      let earlyStop = false
      let pagesSeen = 0
      let nextRestAt = restEvery()

      /**
       * 守卫 A 页级早停：整页单号都已在本地缓存（或整页都是本会话重复）时，
       * 更深的页必然更旧、必然已覆盖，继续翻页只是白白打请求。
       */
      const ingestGuarded = (body: unknown, url: string, method: string): void => {
        const outcome = ingest(body, url, 'xhr', method)
        if (full || earlyStop) return
        if (outcome.type !== 'ok' || !outcome.event) return
        const orders = outcome.event.orders ?? []
        const withId = orders.filter((o) => o.orderId)
        if (withId.length && withId.every((o) => cacheIds.has(o.orderId as string))) {
          earlyStop = true
        } else if (!orders.length && (outcome.event.duplicates ?? 0) > 0) {
          earlyStop = true
        }
      }

      /** 守卫 C：抖动间隔 + 每若干页一次长停顿；取消与早停也在这里收口 */
      const guardedSleep = async (ms?: number): Promise<void> => {
        if (cancelFlags.has(platform)) throw new FetchCancelledError()
        if (earlyStop) throw new EarlyStopError(platform)
        pagesSeen += 1
        if (pagesSeen >= nextRestAt) {
          nextRestAt = pagesSeen + restEvery()
          await sleep(restGap())
          return
        }
        await sleep(humanGap(ms ?? 500))
      }

      /** 守卫 B：mtop 返回扫限流/人机验证标记，命中即冷却并中止 */
      const guardMtopResult = (result: unknown): void => {
        const marker = detectRiskText(safeHead(result))
        if (marker) {
          setCooldown(platform)
          throw new RiskControlError(platform, marker)
        }
      }

      try {
        if (platform === 'jd') {
          const { pages } = await fetchJdOrders(
            {
              pageGet: async (url) => {
                if (cancelFlags.has('jd')) throw new FetchCancelledError()
                chargeRequest('jd')
                const r = await dispatchPageFetch(webviewId, url)
                if (!r.ok) throw new Error(r.error ?? '页面请求失败')
                // 守卫 B：419/420 与风控页文本都算命中
                const marker =
                  detectRiskStatus(r.result?.status ?? 0) ??
                  detectRiskText(String(r.result?.text ?? '').slice(0, 4000))
                if (marker) {
                  setCooldown('jd')
                  throw new RiskControlError('jd', marker)
                }
                return r.result!
              }
            },
            { range: payload.range, years: payload.years, delayMs: 500 },
            {
              sleep: guardedSleep,
              onResponse: (r) => ingestGuarded(r.body, r.url, 'GET'),
              onProgress: (pages) =>
                emit({ platform, phase: 'progress', pages, message: `已抓取 ${pages} 页` })
            }
          )
          if (cancelFlags.has('jd')) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true, pages })
            return { ok: true, cancelled: true }
          }
          emit({ platform, phase: 'completed', ok: true, pages })
          return { ok: true }
        }

        /**
         * @deprecated UI 已统一走 orders:taobao-fetch-all（页内全量分页脚本）：
         * OrderFilter+按月过滤实测只回空数组（见 taobao-v2-fetch 注释），
         * 走这里会出现「主动抓取颗粒无收、只剩首屏 30 条」的问题。保留仅供调试。
         */
        if (platform === 'taobao') {
          const { months, pages, skippedMonths } = await fetchTaobaoOrders(
            {
              mtop: async (options) => {
                if (cancelFlags.has('taobao')) {
                  throw new FetchCancelledError()
                }
                chargeRequest('taobao')
                const r = await dispatchPageSdkRequest(webviewId, options)
                if (!r.ok) throw new Error(r.error ?? '页面 SDK 调用失败')
                guardMtopResult(r.result)
                return r.result as never
              }
            },
            {
              months: payload.months ?? 12,
              delayMs: 500,
              // 守卫 A 月级跳过：本地已覆盖且不属于近几个月的月份不再请求
              monthCovered: (_m: number, startTs: number) =>
                coveredKeys.has(monthKeyOfRangeStart(startTs))
            },
            {
              sleep: guardedSleep,
              onResponse: (body) =>
                ingestGuarded(
                  body,
                  'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2/1.0/',
                  'POST'
                ),
              onProgress: (monthIndex, page) =>
                emit({
                  platform,
                  phase: 'progress',
                  pages: page,
                  message: `第 ${monthIndex + 1} 个月 · 第 ${page} 页`
                })
            }
          )
          const skipNote = skippedMonths
            ? `增量：跳过 ${skippedMonths} 个本地已覆盖月份`
            : undefined
          if (cancelFlags.has('taobao')) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true, pages, months })
            return { ok: true, cancelled: true }
          }
          emit({ platform, phase: 'completed', ok: true, pages, months, message: skipNote })
          return { ok: true, message: skipNote }
        }

        if (platform === 'xianyu' || platform === 'xianyu-sold') {
          const seller = platform === 'xianyu-sold'
          const api = seller ? XIANYU_SOLD_API : XIANYU_BOUGHT_API
          const { pages } = await fetchXianyuOrders(
            {
              mtop: async (options) => {
                if (cancelFlags.has(platform)) throw new FetchCancelledError()
                chargeRequest(platform)
                const r = await dispatchPageSdkRequest(webviewId, options)
                if (!r.ok) throw new Error(r.error ?? '页面 SDK 调用失败')
                guardMtopResult(r.result)
                return r.result as never
              }
            },
            { seller, delayMs: 600 },
            {
              sleep: guardedSleep,
              onResponse: (body) =>
                ingestGuarded(body, `https://h5api.m.goofish.com/h5/${api}/1.0/`, 'POST'),
              onProgress: (page) =>
                emit({ platform, phase: 'progress', pages: page, message: `第 ${page} 页` })
            }
          )
          if (cancelFlags.has(platform)) {
            emit({ platform, phase: 'completed', ok: true, cancelled: true, pages })
            return { ok: true, cancelled: true }
          }
          emit({ platform, phase: 'completed', ok: true, pages })
          return { ok: true }
        }

        return { ok: false, message: `暂不支持平台 ${platform} 的主动抓取` }
      } catch (err) {
        // 守卫 A：增量早停是成功收尾，不是失败
        if (err instanceof EarlyStopError) {
          emit({ platform, phase: 'completed', ok: true, pages: pagesSeen, message: err.message })
          return { ok: true, message: err.message }
        }
        // 守卫 B/D：限流冷却与预算熔断都是明确失败（冷却已在抛出前落盘）
        if (err instanceof RiskControlError || err instanceof BudgetExceededError) {
          emit({ platform, phase: 'completed', ok: false, message: err.message })
          return { ok: false, message: err.message }
        }
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

  /**
   * 后台重新加载某个平台的订单：跑在**独立隐藏窗口**里，
   * 不占用界面上那个共享 webview —— 用户可以在抓取期间随意切换别的平台。
   * 订单仍通过 capture-bridge 的被动捕获实时入库。
   */
  /**
   * 淘宝全量抓取：在**已登录的主 webview** 里调 `lib.mtop`（魔猫同款做法）。
   *
   * 不用隐藏窗口 —— 实测 SDK 在 offscreen 里行为不同，抓不到数据；
   * 用用户当前打开的淘宝订单页最稳（登录态与 SDK 都是现成的）。
   */
  ipcMain.handle(
    'orders:taobao-fetch-all',
    async (
      _event,
      webviewId: number,
      full?: boolean
    ): Promise<{ ok: boolean; imported: number; totalPage: number; message?: string }> => {
      if (inFlight.has('taobao')) {
        return { ok: false, imported: 0, totalPage: 0, message: '淘宝抓取进行中，请稍候' }
      }
      // 守卫 B：冷却期内拒绝触发
      try {
        assertCooldown('taobao')
      } catch (err) {
        if (err instanceof CooldownActiveError) {
          return { ok: false, imported: 0, totalPage: 0, message: err.message }
        }
        throw err
      }
      inFlight.add('taobao')
      try {
        const contents = webContents.fromId(webviewId)
        if (!contents || contents.isDestroyed()) {
          return { ok: false, imported: 0, totalPage: 0, message: '页面未就绪，请先打开淘宝订单页' }
        }
        // 等 lib.mtop 真正就绪（页面加载完 SDK 还要一会儿）
        let ready = false
        for (let i = 0; i < 40; i++) {
          try {
            ready = (await contents.executeJavaScript(
              '!!(window.lib && window.lib.mtop && window.lib.mtop.request)'
            )) as boolean
          } catch {
            ready = false
          }
          if (ready) break
          await new Promise((r) => setTimeout(r, 500))
        }
        if (!ready) {
          return {
            ok: false,
            imported: 0,
            totalPage: 0,
            message: '淘宝页面 SDK 未就绪，请先在页面里登录淘宝'
          }
        }

        // 守卫 A/D：把本地单号集合与剩余预算传进页内脚本（脚本自限请求数、翻到已知单早停）
        // full=true（强制全量）时 knownIds 置空，页内脚本不做增量早停
        const knownIds = full
          ? []
          : (await loadPlatformCache('taobao'))
              .filter((o) => o.orderId)
              .map((o) => o.orderId as string)
        const maxRequests = budgetLeft('taobao')
        if (maxRequests <= 0) {
          return {
            ok: false,
            imported: 0,
            totalPage: 0,
            message: new BudgetExceededError('taobao').message
          }
        }
        await contents.executeJavaScript(
          `window.__reflowFetchCfg = ${JSON.stringify({ maxRequests, knownIds })}`
        )

        const raw = (await withTimeout(
          contents.executeJavaScript(TAOBAO_FETCH_ALL_SCRIPT),
          300_000,
          '淘宝全量抓取'
        )) as TaobaoFetchAllRaw
        // 守卫 D：页内脚本实际发了多少请求，事后记账
        if (raw?.calls) addUsage('taobao', raw.calls)
        // 守卫 B：脚本内识别到限流/人机验证 → 冷却并明确失败
        if (raw?.risk) {
          setCooldown('taobao')
          return {
            ok: false,
            imported: 0,
            totalPage: raw.months ?? 0,
            message: '命中淘宝限流/人机验证，已自动停止并进入 2 小时冷却'
          }
        }
        if (raw?.error) {
          return { ok: false, imported: 0, totalPage: raw.months ?? 0, message: raw.error }
        }
        const orders = (raw?.orders ?? []).map(toOrderFromMain).filter((o) => o.orderId)
        const existing = await loadPlatformCache('taobao')
        /**
         * 新抓到的订单必须**覆盖**同名旧单，不能只追加。
         *
         * 原来这里是 `incoming = 新单.filter(不在缓存里)`，于是解析逻辑修好后
         * 旧缓存里的坏数据永远自愈不了：2026-10-29 修好「外卖单金额是对象」之后，
         * 重新抓了 34 页，28 单外卖订单的金额依然为空 —— 因为它们都被当成重复跳过了。
         */
        const byId = new Map<string, (typeof existing)[number]>()
        for (const o of existing) if (o.orderId) byId.set(o.orderId, o)
        const before = byId.size
        for (const o of orders) byId.set(o.orderId, o)
        const added = byId.size - before
        // 无单号的旧行原样保留（畸形数据的防御，不参与索引）
        const merged = [...byId.values(), ...existing.filter((o) => !o.orderId)].sort((a, b) =>
          (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
        )
        await savePlatformCache('taobao', merged)
        getMainWindow()?.webContents.send('orders:cache-updated', 'taobao')
        return {
          ok: true,
          imported: added,
          totalPage: raw?.months ?? 1,
          message: raw?.budgetCapped ? '触及当日请求预算上限，提前收尾' : undefined
        }
      } catch (err) {
        return {
          ok: false,
          imported: 0,
          totalPage: 0,
          message: err instanceof Error ? err.message : String(err)
        }
      } finally {
        inFlight.delete('taobao')
      }
    }
  )

  ipcMain.handle('orders:bg-reload', async (_event, platform: string) => {
    emit({ platform: platform as FetchPlatform, phase: 'started' })

    // 淘宝走 orders:taobao-fetch-all（主 webview lib.mtop），这里不重复实现。
    // 隐藏窗口方案实测 SDK 行为不同，已废弃（bgFetchTaobaoAll 仅保留供调试）。
    if (platform === 'taobao') {
      emit({ platform: 'taobao', phase: 'completed', ok: false, error: '请用刷新按钮（主 webview 路径）' })
      return {
        ok: false,
        platform: 'taobao',
        steps: 0,
        message: '淘宝请用平台列表旁的刷新按钮'
      }
    }

    const result = await bgReloadPlatform(platform)
    emit({
      platform: platform as FetchPlatform,
      phase: 'completed',
      ok: result.ok,
      pages: result.steps,
      error: result.ok ? undefined : result.message
    })
    return result
  })
}
