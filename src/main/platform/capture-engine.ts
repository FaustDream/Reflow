/**
 * 工单 005：捕获引擎 —— 管道的核心枢纽。
 *
 *   注入桥回传 CaptureReport → registry.route(URL/method/kind) → adapter.parse
 *     → 去重（platform|account|orderId）→ OrdersCapturedEvent 事件
 *
 * 设计约束：
 * - **纯同步、零网络**：引擎只消费注入桥回传的响应，绝不主动发起任何请求
 *   （决策 D-2 的结构性保证：所有被捕获的请求都是页面自己发的）。
 * - 解析抛错不静默：以 `error` 变体返回，由桥转发给诊断层（025）。
 * - 同一订单号三种请求形态各来一次只保留一条（验收项）。
 */
import type { CaptureKind, CaptureReport, OrdersCapturedEvent, ParseErrorEvent } from '../../shared/types'
import type { AdapterRegistry } from './registry'

export type EngineOutcome =
  | { type: 'unmatched' }
  | { type: 'error'; error: ParseErrorEvent }
  | { type: 'ok'; event: OrdersCapturedEvent | null }

export interface EngineStats {
  /** 累计解析成功且非重复的订单数 */
  captured: number
  /** 累计因重复被丢弃的订单数 */
  duplicates: number
  /** 未命中任何适配器规则的捕获数 */
  unmatched: number
  /** 路由命中但解析抛错的次数 */
  failed: number
}

export class CaptureEngine {
  private readonly seen = new Set<string>()
  private readonly registry: AdapterRegistry
  private statsInternal: EngineStats = { captured: 0, duplicates: 0, unmatched: 0, failed: 0 }

  constructor(registry: AdapterRegistry) {
    this.registry = registry
  }

  get stats(): EngineStats {
    return { ...this.statsInternal }
  }

  /** 清空去重状态与统计（UI「清空」按钮 / 测试用） */
  reset(): void {
    this.seen.clear()
    this.statsInternal = { captured: 0, duplicates: 0, unmatched: 0, failed: 0 }
  }

  handleReport(report: CaptureReport, webviewId: number): EngineOutcome {
    const kind: CaptureKind = report.kind
    const routed = this.registry.route(report.url, report.method, kind)
    if (!routed) {
      this.statsInternal.unmatched++
      return { type: 'unmatched' }
    }

    const base = { url: report.url, kind, webviewId, ts: Date.now() }
    let parseResult
    try {
      parseResult = routed.adapter.parse(report)
    } catch (err) {
      this.statsInternal.failed++
      return {
        type: 'error',
        error: {
          platformId: routed.adapter.id,
          message: err instanceof Error ? err.message : String(err),
          ...base
        }
      }
    }

    const fresh = []
    let duplicates = 0
    for (const order of parseResult.orders) {
      // 无单号的行不去重（防御：畸形数据不应被整批丢弃）
      if (!order.orderId) {
        fresh.push(order)
        continue
      }
      const key = `${order.platform}|${order.account}|${order.orderId}`
      if (this.seen.has(key)) {
        duplicates++
        continue
      }
      this.seen.add(key)
      fresh.push(order)
    }

    this.statsInternal.captured += fresh.length
    this.statsInternal.duplicates += duplicates

    if (!fresh.length && !parseResult.pageInfo && !parseResult.account) {
      return { type: 'ok', event: null }
    }

    return {
      type: 'ok',
      event: {
        platform: routed.adapter.id,
        orders: fresh,
        pageInfo: parseResult.pageInfo,
        account: parseResult.account,
        duplicates,
        ...base
      }
    }
  }
}
