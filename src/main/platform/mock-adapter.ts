/**
 * 工单 003/005：mock 平台适配器。
 *
 * 作用一（003 验收）：作为接口完备性样例，证明「新增平台只需加一个文件」；
 * 作用二（005 验收）：配合 dev-fixtures 的本地 mock 页面端到端贯通捕获管道，
 * 不依赖任何真实平台账号。
 *
 * mock 页面（dev-fixtures/mock-platform/）会以 XHR / fetch / JSONP 三种形态
 * 请求本适配器声明的三个端点，响应体统一为：
 *   { "orders": [{ orderId, title, paidAmount, quantity, status, createdAt, ... }] }
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type ExportColumn } from '../../shared/types/order'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'

/** mock 平台本地服务端口与来源（定义在 shared/mock-platform.ts，此处再导出供既有引用方使用） */
import { MOCK_PLATFORM_ORIGIN } from '../../shared/mock-platform'
export { MOCK_PLATFORM_ORIGIN }

interface MockOrderPayload {
  orderId?: unknown
  title?: unknown
  paidAmount?: unknown
  unitPrice?: unknown
  quantity?: unknown
  status?: unknown
  createdAt?: unknown
  shopName?: unknown
  /** 平台特有字段，原样进 extra */
  [key: string]: unknown
}

interface MockResponsePayload {
  orders?: unknown
  account?: { userId?: unknown; nickname?: unknown }
  pageInfo?: { hasMore?: unknown; totalCount?: unknown; cursor?: unknown }
}

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export const mockAdapter: PlatformAdapter = {
  id: 'mock',
  displayName: 'Mock 平台',
  homeUrl: `${MOCK_PLATFORM_ORIGIN}/`,
  matchRules: [
    { pattern: `${MOCK_PLATFORM_ORIGIN}/api/orders-xhr*`, kind: 'xhr', method: 'GET' },
    { pattern: `${MOCK_PLATFORM_ORIGIN}/api/orders-fetch*`, kind: 'fetch', method: 'GET' },
    // JSONP 上报不带 method（由 <script src> 发起），规则不得声明 method
    { pattern: `${MOCK_PLATFORM_ORIGIN}/api/orders-jsonp*`, kind: 'jsonp' }
  ],
  supportsSeller: false,
  columns: [{ key: 'mockRemark', header: '备注（mock）', width: 24 }] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const payload = report.body as MockResponsePayload
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.orders)) {
      throw new Error(`mock 平台响应结构异常：期望 { orders: [...] }，实际 ${typeof report.body}`)
    }

    const orders = payload.orders.map((raw) => {
      const o = (raw ?? {}) as MockOrderPayload
      const order = emptyOrder('mock', str(payload.account?.userId))
      order.orderId = str(o.orderId)
      order.title = str(o.title)
      order.paidAmount = str(o.paidAmount)
      order.unitPrice = str(o.unitPrice)
      order.quantity = typeof o.quantity === 'number' ? o.quantity : null
      order.status = str(o.status)
      order.createdAt = toDateTimeString(o.createdAt as string | number)
      order.shopName = str(o.shopName)
      // 其余字段全部进 extra，验证扩展列通道
      for (const [k, v] of Object.entries(o)) {
        if (
          ['orderId', 'title', 'paidAmount', 'unitPrice', 'quantity', 'status', 'createdAt', 'shopName'].includes(
            k
          )
        )
          continue
        if (typeof v === 'string' || typeof v === 'number') order.extra[k] = String(v)
      }
      return order
    })

    return {
      orders,
      account: payload.account?.userId
        ? { userId: str(payload.account.userId), nickname: str(payload.account.nickname) }
        : undefined,
      pageInfo:
        payload.pageInfo && typeof payload.pageInfo === 'object'
          ? {
              hasMore: payload.pageInfo.hasMore === true || payload.pageInfo.hasMore === 'true',
              totalCount:
                typeof payload.pageInfo.totalCount === 'number' ? payload.pageInfo.totalCount : undefined,
              cursor: str(payload.pageInfo.cursor) || undefined
            }
          : undefined
    }
  }
}
