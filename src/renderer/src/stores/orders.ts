import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  OrdersCapturedEvent,
  ParseErrorEvent,
  Order,
  AccountInfo,
  PageInfo,
  OrderDetailEvent,
  DetailProgressEvent,
  DetailsCompletedEvent,
  OrdersFetchEvent
} from '@shared/types'

const MAX_PER_PLATFORM = 10_000
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
  const pageInfoByPlatform = ref<Record<string, PageInfo>>({})
  const accountByPlatform = ref<Record<string, AccountInfo>>({})
  const parseErrors = ref<ParseErrorEvent[]>([])
  const duplicatesTotal = ref(0)
  const initialized = ref(false)
  /**
   * 首屏缓存加载中：界面要等**全部历史订单都读进内存**后再展示，
   * 否则会先闪一下「暂无订单」再突然跳出几百条，看起来像数据丢了。
   */
  const cacheLoading = ref(true)
  /** platform id → 详情抓取进度 */
  const detailProgress = ref<Record<string, DetailProgressState>>({})
  /** 工单 012/013：京东/淘宝主动抓取状态 */
  const fetchState = ref<Record<string, { running: boolean; message: string; error: string }>>(
    {}
  )
  /** 各平台最近一次成功抓取的时间戳 + 订单数签名（用于切换平台时跳过重复请求） */
  const lastSyncAt = ref<Record<string, number>>({})
  const lastSyncCount = ref<Record<string, number>>({})

  const total = computed(() =>
    Object.values(byPlatform.value).reduce((sum, list) => sum + list.length, 0)
  )
  const platformSummaries = computed(() =>
    Object.entries(byPlatform.value).map(([platform, list]) => ({
      platform,
      count: list.length,
      pageInfo: pageInfoByPlatform.value[platform],
      account: accountByPlatform.value[platform]
    }))
  )

  function detailState(platform: string): DetailProgressState {
    return detailProgress.value[platform] ?? IDLE_PROGRESS
  }

  function fetchStateOf(platform: string): { running: boolean; message: string; error: string } {
    return fetchState.value[platform] ?? { running: false, message: '', error: '' }
  }

  function init(): void {
    if (initialized.value) return
    initialized.value = true

    // 工单 023：先恢复本地缓存，再订阅新订单（避免启动瞬间的捕获覆盖历史）
    void window.api
      .loadOrderCache()
      .then((cached) => {
        const restored: Record<string, Order[]> = {}
        for (const [platform, list] of Object.entries(cached)) {
          if (!Array.isArray(list) || !list.length) continue
          // 丢弃历史垃圾行：既无单号又无任何内容（旧版字段映射错误留下的空订单，
          // 例如美团 H5 早期版本全部 orderId 为空）。留着只会污染表格与合计。
          const clean = (list as Order[]).filter(
            (o) => o.orderId || o.title || o.paidAmount || o.shopName
          )
          if (clean.length) restored[platform] = clean
        }
        if (Object.keys(restored).length) {
          // 与已到达的新订单合并（新订单优先，历史补位）
          const merged = { ...restored, ...byPlatform.value }
          for (const [platform, list] of Object.entries(restored)) {
            const incoming = byPlatform.value[platform]
            if (!incoming?.length) {
              merged[platform] = list
              continue
            }
            const seen = new Set(incoming.map((o) => o.orderId))
            merged[platform] = [...incoming, ...list.filter((o) => !seen.has(o.orderId))]
          }
          byPlatform.value = merged
        }
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
            error: current?.error ?? ''
          }
        }
      } else if (payload.phase === 'completed') {
        fetchState.value = {
          ...fetchState.value,
          [payload.platform]: {
            running: false,
            message: payload.cancelled ? '已取消' : payload.ok ? '抓取完成' : payload.message ?? '',
            error: payload.cancelled || payload.ok ? '' : payload.error ?? '抓取失败'
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
    // 空单号不参与索引：所有空单号会共享同一个 Map key（''），
    // 于是「每来一单就覆盖上一单」，界面只剩一条。
    // 美团 H5 曾因字段名对不上导致全部订单 orderId 为空，就是这么变成「只有 2 单」的。
    const index = new Map<string, number>()
    existing.forEach((o, i) => {
      if (o.orderId) index.set(o.orderId, i)
    })
    const merged = [...existing]
    for (const order of payload.orders) {
      if (!order.orderId) {
        merged.unshift(order)
        continue
      }
      const at = index.get(order.orderId)
      if (at !== undefined) merged[at] = order
      else merged.unshift(order)
    }
    if (merged.length > MAX_PER_PLATFORM) merged.length = MAX_PER_PLATFORM
    byPlatform.value = { ...byPlatform.value, [payload.platform]: merged }
    if (payload.pageInfo) {
      pageInfoByPlatform.value = { ...pageInfoByPlatform.value, [payload.platform]: payload.pageInfo }
    }
    if (payload.account) {
      accountByPlatform.value = { ...accountByPlatform.value, [payload.platform]: payload.account }
    }
    duplicatesTotal.value += payload.duplicates
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
    const plain = list.map((o) => ({ ...o, extra: o.extra ? { ...o.extra } : {} }))
    void window.api.saveOrderCache(platform, plain).catch((err) => {
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
    pageInfoByPlatform.value = {}
    accountByPlatform.value = {}
    parseErrors.value = []
    duplicatesTotal.value = 0
    detailProgress.value = {}
    // 引擎的去重集合一并重置，否则清空后同一订单不会再次出现
    await window.api.resetOrders()
    // 工单 023：磁盘缓存一并清除，否则重启后历史订单会「复活」
    await window.api.clearAllCache().catch(() => undefined)
  }

  /** 重新从磁盘读一遍（导入订单文件后调用，不动内存里已有的新捕获） */
  async function reloadCache(): Promise<void> {
    const cached = await window.api.loadOrderCache()
    const restored: Record<string, Order[]> = {}
    for (const [platform, list] of Object.entries(cached)) {
      if (!Array.isArray(list) || !list.length) continue
      const clean = (list as Order[]).filter(
        (o) => o.orderId || o.title || o.paidAmount || o.shopName
      )
      if (clean.length) restored[platform] = clean
    }
    if (!Object.keys(restored).length) return
    const merged = { ...restored, ...byPlatform.value }
    for (const [platform, list] of Object.entries(restored)) {
      const incoming = byPlatform.value[platform]
      if (!incoming?.length) {
        merged[platform] = list
        continue
      }
      const seen = new Set(incoming.map((o) => o.orderId))
      merged[platform] = [...incoming, ...list.filter((o) => !seen.has(o.orderId))]
    }
    byPlatform.value = merged
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
    pageInfoByPlatform,
    accountByPlatform,
    parseErrors,
    duplicatesTotal,
    detailProgress,
    fetchState,
    cacheLoading,
    total,
    platformSummaries,
    detailState,
    fetchStateOf,
    init,
    reloadCache,
    isCacheFresh,
    markSynced,
    mergeDetail,
    clear
  }
})
