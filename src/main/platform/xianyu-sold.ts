/**
 * 工单 011：闲鱼**卖家**订单适配器（卖出的宝贝）。
 *
 * 与买家适配器（xianyu.ts）的区别：
 * - 匹配 sold 系列接口（App H5 的 mtop.taobao.idle.trade.sold.get 与 PC 的 idle.web 命名空间都兼容）
 * - platform='xianyu-sold'，引擎天然分表/独立计数/独立导出，不与买家单混淆
 * - item 结构与 bought 同构（魔猫g goofishMapListSeller 同模型），复用 normalizeXianyuItem
 * - 卖家视角 head.userInfo 是**买家**昵称，落入 core 店铺列（导出时列名差异由扩展列说明）
 *
 * 登录态复用 xianyu 分区与页面脚本（installXianyuPageScript 按 goofish.com 域守卫，卖家页同样生效）。
 */
import type { ExportColumn } from '../../shared/types/order'
import { installXianyuPageScript } from '../../shared/page-scripts/xianyu'
import type { CaptureReport } from '../../shared/types'
import {
  isXianyuNextPage,
  isXianyuSessionExpired,
  isXianyuTokenTransient,
  normalizeXianyuItem
} from './xianyu'
import type { ParseResult, PlatformAdapter } from './adapter'

/** 卖家订单页（卖出的宝贝） */
export const XIANYU_SOLD_HOME_URL = 'https://www.goofish.com/sold'

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

interface SoldListPayload {
  data?: { items?: unknown[]; nextPage?: unknown; lastEndRow?: unknown; totalCount?: unknown }
  ret?: unknown
}

export const xianyuSoldAdapter: PlatformAdapter = {
  id: 'xianyu-sold',
  displayName: '闲鱼卖家',
  homeUrl: XIANYU_SOLD_HOME_URL,
  partition: 'persist:platform-xianyu',
  matchRules: [
    // PC Web（idle.web.trade.sold）与 App H5（mtop.taobao.idle.trade.sold）两套命名空间都兼容
    // （工单 011 注意事项）；kind 缺省即 xhr/fetch 皆匹配；sold 词段保证不误匹配 bought
    { pattern: /goofish\.com\/h5\/.*idle\.(web\.)?trade\.sold/i }
  ],
  pageScript: `(${installXianyuPageScript.toString()})`,
  supportsSeller: true,
  columns: [
    { key: 'itemId', header: '商品ID', width: 16 },
    { key: 'sellerId', header: '买家ID', width: 14 },
    { key: 'idleBizCode', header: '业务类型', width: 10 },
    { key: 'priceLabel', header: '价格标签', width: 10 }
  ] as ExportColumn[],
  /**
   * 工单 034：与买家视角同一套列序，只把「卖家」换成「买家」
   * （`userInfo` 在卖家视角下是买家身份，见 xianyu.ts 的注释）。
   */
  exportColumns: [
    { key: 'orderId', header: '订单号', width: 24 },
    { key: 'createdAt', header: '创建时间', width: 20, format: 'datetime' },
    { key: 'title', header: '商品标题', width: 36 },
    { key: 'imageUrl', header: '商品图片', width: 30 },
    { key: 'paidAmount', header: '实付款', width: 12, format: 'number' },
    { key: 'quantity', header: '数量', width: 6, format: 'number' },
    { key: 'status', header: '订单状态', width: 12 },
    { key: 'shopName', header: '买家昵称', width: 16 },
    { key: 'sellerId', header: '买家ID', width: 14 },
    { key: 'itemId', header: '商品ID', width: 16 },
    { key: 'receiverAddress', header: '收货地址', width: 40 },
    { key: 'freight', header: '运费', width: 10 },
    { key: 'coinDiscount', header: '闲鱼币抵扣', width: 12 },
    { key: 'alipayTradeNo', header: '支付宝交易号', width: 24 },
    { key: 'paidAt', header: '付款时间', width: 20, format: 'datetime' },
    { key: 'shippedAt', header: '发货时间', width: 20, format: 'datetime' },
    { key: 'completedAt', header: '成交时间', width: 20, format: 'datetime' }
  ] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const payload = report.body as SoldListPayload | null
    if (!payload || typeof payload !== 'object') {
      throw new Error(`闲鱼卖家列表响应结构异常：期望对象，实际 ${typeof report.body}`)
    }
    const retText = Array.isArray(payload.ret) ? payload.ret.join(';') : str(payload.ret)
    if (isXianyuSessionExpired(retText)) {
      throw new Error('闲鱼会话已过期（未登录），请在页面中完成登录')
    }
    if (isXianyuTokenTransient(retText)) {
      // 令牌瞬时失败：SDK 自动刷新重试，静默忽略
      return { orders: [] }
    }
    if (!payload.data || !Array.isArray(payload.data.items)) {
      throw new Error(
        `闲鱼卖家列表响应结构异常：期望 data.items 数组${retText ? `，ret=${retText}` : ''}`
      )
    }
    const orders = (payload.data.items as unknown[]).map((raw) =>
      normalizeXianyuItem(raw, 'xianyu-sold')
    )
    return {
      orders,
      pageInfo: {
        hasMore: isXianyuNextPage(payload.data.nextPage),
        totalCount:
          Number(payload.data.totalCount) > 0 ? Number(payload.data.totalCount) : undefined,
        cursor: str(payload.data.lastEndRow) || undefined
      }
    }
  }
}
