import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  OrdersCapturedEvent,
  ParseErrorEvent,
  Order,
  OrderDetailEvent,
  DetailProgressEvent,
  DetailsCompletedEvent,
  OrdersFetchEvent
} from '@shared/types'

const MAX_PER_PLATFORM = 10_000

/** 某平台当前抓取进度（进度条 + 计数展示用） */
interface FetchState {
  running: boolean
  message: string
  error: string
  /** 已完成页数 */
  pages?: number
  /** 已抓订单数（累计） */
  orders?: number
  /** 结构化进度说明（如「第 2/9 年 · 2024 年 第 3 页」） */
  detail?: string
}

/**
 * 订单列表合并（纯函数，2026-10-31 重写）。
 *
 * 旧实现按「合并前位置索引」原地替换（`merged[at] = order`），但循环里每
 * `unshift` 一条新单都会让后续位置整体 +1 —— 索引全部漂移，之后每次替换都
 * 写错位置：一条旧单被顶掉、被更新的单留在原位又来一份。
 * 表现就是缓存里出现完全相同的重复行（拼多多实测 104 条 ×2）且部分行丢失。
 *
 * 现在按 Map 归并：新单在顶部（保持到达顺序），旧单原地更新（Map 重 set
 * 保留原插入位置），同批次重复以最后一条为准；空单号行不参与索引
 * （所有空单号共享 '' 键会互相覆盖 —— 美团 H5 教训），原样保留。
 */
export function mergeOrderLists(existing: Order[], incoming: Order[]): Order[] {
  const existingMap = new Map<string, Order>()
  const existingNoId: Order[] = []
  for (const o of existing) {
    if (o.orderId) existingMap.set(o.orderId, o)
    else existingNoId.push(o)
  }
  const fresh: Order[] = []
  const freshIds = new Set<string>()
  for (const o of incoming) {
    if (!o.orderId) {
      fresh.push(o)
      continue
    }
    if (existingMap.has(o.orderId)) {
      existingMap.set(o.orderId, o) // 覆盖旧数据（解析修复后靠它自愈），Map 保持原位置
      continue
    }
    if (freshIds.has(o.orderId)) {
      // 同一批里的重复单号：以后到的为准，原地替换
      const at = fresh.findIndex((x) => x.orderId === o.orderId)
      if (at >= 0) fresh[at] = o
      continue
    }
    freshIds.add(o.orderId)
    fresh.push(o)
  }
  const merged = [...fresh, ...existingNoId, ...existingMap.values()]
  return merged.length > MAX_PER_PLATFORM ? merged.slice(0, MAX_PER_PLATFORM) : merged
}

/** 去掉列表里 orderId 重复的行（保留先出现的；空单号行不去重） */
export function dedupeOrders(list: Order[]): Order[] {
  const seen = new Set<string>()
  const out: Order[] = []
  for (const o of list) {
    if (!o.orderId) {
      out.push(o)
      continue
    }
    if (seen.has(o.orderId)) continue
    seen.add(o.orderId)
    out.push(o)
  }
  return out
}

/**
 * 订单列表脱 Proxy 成纯对象：store 里的元素经 reactive 读取时是 Vue 的 Proxy，
 * IPC 的 structured clone 对代理的行为随版本/路径而异 —— 凡是跨 IPC 传订单
 * （存缓存、导出）都先过这一步，统一语义，不给「能传/不能传」留暧昧空间。
 */
export function toPlainOrders(list: Order[]): Order[] {
  return list.map((o) => ({ ...o, extra: o.extra ? { ...o.extra } : {} }))
}
const MAX_PARSE_ERRORS = 200

/** 工单 008：详情批量抓取的进度状态 */
export interface DetailProgressState {
  running: boolean
  total: number
  done: number
  /** 最近一批的失败明细（完成后保留，下次开始时清空） */
  failed: Array<{ orderId: string; message: string }>
  /** 人机验证暂停提示 */
  pausedMessage: string
}

const IDLE_PROGRESS: DetailProgressState = {
  running: false,
  total: 0,
  done: 0,
  failed: [],
  pausedMessage: ''
}

/**
 * 工单 005/008：解析后订单的渲染层汇聚点。
 * 引擎已按 platform|account|orderId 去重；本 store 再做一次合并防御
 * （同单号 replace，避免并发事件时序问题导致重复行）。
 */
export const useOrdersStore = defineStore('orders', () => {
  /** platform id → 订单列表（新订单插前） */
  const byPlatform = ref<Record<string, Order[]>>({})
  const parseErrors = ref<ParseErrorEvent[]>([])
  const initialized = ref(false)
  /**
   * 首屏缓存加载中：界面要等**全部历史订单都读进内存**后再展示，
   * 否则会先闪一下「暂无订单」再突然跳出几百条，看起来像数据丢了。
   */
  const cacheLoading = ref(true)
  /** platform id → 详情抓取进度 */
  const detailProgress = ref<Record<string, DetailProgressState>>({})
  /** 工单 012/013：京东/淘宝主动抓取状态 */
  const fetchState = ref<Record<string, FetchState>>({})
  /** 各平台最近一次成功抓取的时间戳 + 订单数签名（用于切换平台时跳过重复请求） */
  const lastSyncAt = ref<Record<string, number>>({})
  const lastSyncCount = ref<Record<string, number>>({})

  function fetchStateOf(platform: string): FetchState {
    return fetchState.value[platform] ?? { running: false, message: '', error: '' }
  }

  /** 清洗磁盘缓存：丢历史垃圾行（旧版空订单）并按单号去重 */
  function cleanCached(cached: Record<string, unknown[]>): Record<string, Order[]> {
    const restored: Record<string, Order[]> = {}
    for (const [platform, list] of Object.entries(cached)) {
      if (!Array.isArray(list) || !list.length) continue
      // 丢弃历史垃圾行：既无单号又无任何内容（旧版字段映射错误留下的空订单，
      // 例如美团 H5 早期版本全部 orderId 为空）。留着只会污染表格与合计。
      const clean = dedupeOrders(
        (list as Order[]).filter((o) => o.orderId || o.title || o.paidAmount || o.shopName)
      )
      if (clean.length) restored[platform] = clean
    }
    return restored
  }

  /** 与已到达的新订单合并（新订单优先，历史补位）；只按有单号的行判重 */
  function mergeRestored(restored: Record<string, Order[]>): void {
    if (!Object.keys(restored).length) return
    const merged = { ...restored, ...byPlatform.value }
    for (const [platform, list] of Object.entries(restored)) {
      const incoming = byPlatform.value[platform]
      if (!incoming?.length) {
        merged[platform] = list
        continue
      }
      // 判重集合只收有单号的行：无单号行（无法判重的历史遗留）不合并进内存，
      // 否则每次导入都会追加一份（磁盘缓存不含它们的更新，永远判不了重）
      const seen = new Set(incoming.map((o) => o.orderId).filter((id): id is string => !!id))
      merged[platform] = [...incoming, ...list.filter((o) => !!o.orderId && !seen.has(o.orderId))]
    }
    byPlatform.value = merged
  }

  function init(): void {
    if (initialized.value) return
    initialized.value = true

    // 工单 023：先恢复本地缓存，再订阅新订单（避免启动瞬间的捕获覆盖历史）
    void window.api
      .loadOrderCache()
      .then((cached) => {
        mergeRestored(cleanCached(cached))
      })
      .catch(() => undefined)
      .finally(() => {
        // 全部历史都进内存了，遮罩撤掉再渲染表格
        cacheLoading.value = false
      })

    window.api.onOrders((payload) => {
      mergeOrders(payload)
    })
    window.api.onParseError((payload) => {
      parseErrors.value.unshift(payload)
      if (parseErrors.value.length > MAX_PARSE_ERRORS) parseErrors.value.length = MAX_PARSE_ERRORS
    })

    // 工单 008：详情事件
    window.api.onDetailsStarted(({ platform, total: n }) => {
      detailProgress.value = {
        ...detailProgress.value,
        [platform]: { running: true, total: n, done: 0, failed: [], pausedMessage: '' }
      }
    })
    window.api.onDetailProgress((payload: DetailProgressEvent) => {
      patchProgress(payload.platform, { done: payload.done })
    })
    window.api.onOrderDetail((payload: OrderDetailEvent) => {
      mergeDetail(payload)
    })
    window.api.onDetailsCompleted((payload: DetailsCompletedEvent) => {
      detailProgress.value = {
        ...detailProgress.value,
        [payload.platform]: {
          running: false,
          total: payload.total,
          done: payload.done,
          failed: payload.failed,
          pausedMessage: payload.paused ? payload.message ?? '需要人工验证' : ''
        }
      }
    })

    // 工单 012/013：主动抓取生命周期
    window.api.onOrdersFetchEvent((payload: OrdersFetchEvent) => {
      if (payload.phase === 'started') {
        fetchState.value = {
          ...fetchState.value,
          [payload.platform]: { running: true, message: '开始抓取…', error: '' }
        }
      } else if (payload.phase === 'progress') {
        const current = fetchState.value[payload.platform]
        fetchState.value = {
          ...fetchState.value,
          [payload.platform]: {
            running: true,
            message: payload.message ?? `已抓取 ${payload.pages ?? 0} 页`,
            error: current?.error ?? '',
            pages: payload.pages ?? current?.pages,
            orders: payload.orders ?? current?.orders,
            detail: payload.detail
          }
        }
      } else if (payload.phase === 'completed') {
        fetchState.value = {
          ...fetchState.value,
          [payload.platform]: {
            running: false,
            message: payload.cancelled ? '已取消' : payload.ok ? '抓取完成' : payload.message ?? '',
            error: payload.cancelled || payload.ok ? '' : payload.error ?? '抓取失败',
            pages: payload.pages,
            orders: payload.orders
          }
        }
      }
    })

    // 主进程落盘后（导入文件 / taobao 全量抓取）通知重载本地缓存
    window.api.onOrdersCacheUpdated(() => {
      void reloadCache()
    })
  }

  function patchProgress(platform: string, patch: Partial<DetailProgressState>): void {
    const current = detailProgress.value[platform] ?? IDLE_PROGRESS
    detailProgress.value = {
      ...detailProgress.value,
      [platform]: { ...current, ...patch }
    }
  }

  function mergeOrders(payload: OrdersCapturedEvent): void {
    // 该平台已有新订单成功入表，其历史解析异常（多为登录前/令牌瞬时失败的旧响应）即失效，清除
    if (payload.orders.length && parseErrors.value.some((e) => e.platformId === payload.platform)) {
      parseErrors.value = parseErrors.value.filter((e) => e.platformId !== payload.platform)
    }
    const existing = byPlatform.value[payload.platform] ?? []
    byPlatform.value = {
      ...byPlatform.value,
      [payload.platform]: mergeOrderLists(existing, payload.orders)
    }
    // 工单 023：订单变化后把该平台完整快照交给主进程去抖落盘
    persistPlatform(payload.platform)
  }

  /** 把某平台的完整订单列表交给主进程缓存（去抖） */
  function persistPlatform(platform: string): void {
    const list = byPlatform.value[platform]
    if (!list) return
    // 逐项脱 Proxy：只展开数组是不够的 —— 元素仍是 Vue 的 reactive Proxy，
    // IPC 的 structured clone 不接受代理，整次 invoke 会被 reject，
    // 之前又被 .catch 静默吞掉，于是缓存文件从来没生成过（重启即丢单）。
    void window.api.saveOrderCache(platform, toPlainOrders(list)).catch((err) => {
      console.warn('[cache] 保存订单缓存失败', err)
    })
  }

  /** 工单 008：详情字段按 orderId 合并回列表订单（已抓到的字段不被空值覆盖） */
  function mergeDetail(payload: OrderDetailEvent): void {
    const list = byPlatform.value[payload.platform]
    if (!list) return
    const f = payload.fields
    const merged = list.map((o) => {
      if (o.orderId !== payload.orderId) return o
      return {
        ...o,
        receiverAddress: f.receiverAddress || o.receiverAddress,
        paidAt: f.paidAt ?? o.paidAt,
        shippedAt: f.shippedAt ?? o.shippedAt,
        completedAt: f.completedAt ?? o.completedAt,
        extra: {
          ...o.extra,
          ...(f.alipayTradeNo ? { alipayTradeNo: f.alipayTradeNo } : {}),
          ...(f.freight ? { freight: f.freight } : {}),
          ...(f.coinDiscount ? { coinDiscount: f.coinDiscount } : {}),
          detailFetched: 'true'
        }
      }
    })
    byPlatform.value = { ...byPlatform.value, [payload.platform]: merged }
    // 详情字段也要落盘，否则重启后地址/时间等又变回空
    persistPlatform(payload.platform)
  }

  async function clear(): Promise<void> {
    byPlatform.value = {}
    parseErrors.value = []
    detailProgress.value = {}
    // 引擎的去重集合一并重置，否则清空后同一订单不会再次出现
    await window.api.resetOrders()
    // 工单 023：磁盘缓存一并清除，否则重启后历史订单会「复活」
    await window.api.clearAllCache().catch(() => undefined)
  }

  /** 重新从磁盘读一遍（导入订单文件后调用，不动内存里已有的新捕获） */
  async function reloadCache(): Promise<void> {
    const cached = await window.api.loadOrderCache()
    mergeRestored(cleanCached(cached))
  }

  /**
   * 判断某平台缓存是否"足够新鲜"，可跳过重新抓取。
   *
   * 策略：10 分钟内抓过、且订单数未变 → 跳过；
   * 超过 10 分钟或订单数有变化（说明有新单/删除）→ 允许重新抓。
   */
  function isCacheFresh(platformId: string, staleMs = 10 * 60_000): boolean {
    const at = lastSyncAt.value[platformId]
    if (!at) return false
    if (Date.now() - at > staleMs) return false
    const count = byPlatform.value[platformId]?.length ?? 0
    return count === (lastSyncCount.value[platformId] ?? 0)
  }

  /** 记录一次成功同步（抓取/导入/捕获后调用） */
  function markSynced(platformId: string): void {
    lastSyncAt.value[platformId] = Date.now()
    lastSyncCount.value[platformId] = byPlatform.value[platformId]?.length ?? 0
  }

  return {
    byPlatform,
    parseErrors,
    detailProgress,
    fetchState,
    cacheLoading,
    fetchStateOf,
    init,
    reloadCache,
    isCacheFresh,
    markSynced,
    clear
  }
})
