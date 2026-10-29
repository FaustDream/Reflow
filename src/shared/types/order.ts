/**
 * 工单 003：统一订单模型 —— 主进程 / preload / 渲染层共享的**单一来源**。
 *
 * 设计依据：方案附录 A.5（core columns / extended columns 两层模型）。
 * 各平台列数差异大（京东 ~9 / 闲鱼 17 / 拼多多 25 / 1688 50），
 * 全平台共有的字段落在 Order 顶层，平台特有字段进 `extra`。
 *
 * ⚠ CI 校验：`interface Order` 只允许在本文件定义（order-types.test.ts 门禁）。
 */
import type { DateTimeString } from '../datetime'

/**
 * 统一订单。所有取值均为「已规整」的展示值：
 * - 时间字段：`YYYY-MM-DD HH:mm:ss`（决策 D-3）或 null
 * - 金额：字符串（保留平台原始精度，导出端不做浮点运算）
 */
export interface Order {
  /** 所属平台 = 适配器 id（如 'xianyu' / 'jd' / 'mock'） */
  platform: string
  /** 归属账号标识（021 多账号聚合的落地字段；单账号场景为平台用户 id 或空串） */
  account: string
  /** 订单号（平台唯一） */
  orderId: string
  /** 下单时间 */
  createdAt: DateTimeString | null
  /** 商品标题 */
  title: string
  /** 商品图 URL */
  imageUrl: string
  /** 单价 */
  unitPrice: string
  /** 实付金额 */
  paidAmount: string
  /** 数量 */
  quantity: number | null
  /** 订单状态（平台原文，不做翻译） */
  status: string
  /** 店铺/卖家名 */
  shopName: string
  /** 收货人 */
  receiverName: string
  /** 收货地址 */
  receiverAddress: string
  /** 收货电话 */
  receiverPhone: string
  /** 物流公司 */
  logisticsCompany: string
  /** 运单号 */
  trackingNo: string
  /** 付款时间 */
  paidAt: DateTimeString | null
  /** 发货时间 */
  shippedAt: DateTimeString | null
  /** 成交时间 */
  completedAt: DateTimeString | null
  /** 平台特有字段（闲鱼币抵扣、Offer ID、发票四要素…），导出为 extended columns */
  extra: Record<string, string>
}

/** 账号信息（登录态检测的产出，021 多账号聚合用） */
export interface AccountInfo {
  userId: string
  nickname?: string
  avatarUrl?: string
}

/** 分页状态（由解析器从响应中读出，供自动翻页 010 与 UI 进度展示） */
export interface PageInfo {
  /** 是否还有下一页（闲鱼 `nextPage` 兼容布尔与字符串 "true"） */
  hasMore: boolean
  /** 总条数（平台提供时才有） */
  totalCount?: number
  /** 翻页游标（如闲鱼 `lastEndRow`） */
  cursor?: string
}

/** 导出列定义：Excel/CSV/表格共用 */
export interface ExportColumn {
  /** Order 顶层字段名，或 extra 中的键 */
  key: string
  /** 表头（中文） */
  header: string
  /** 列宽（Excel 字符宽，缺省由导出引擎决定） */
  width?: number
  /** 单元格形态，缺省 text */
  format?: 'text' | 'number' | 'datetime' | 'image'
  /**
   * 跨平台合并时的消歧后缀（导出引擎在表头冲突时使用）。
   * 适配器本身不设置；由导出 IPC 按订单实际所属平台注入。
   */
  platformName?: string
  /** 同上，缺省消歧名（platformName 缺失时回退它） */
  platformId?: string
  /**
   * 该列只对哪些平台的订单填值（导出引擎在拆列后写入）。
   * 缺省/空数组 = 对所有平台生效。用于 `sellerId` 这类跨平台语义反转的列。
   */
  platformIds?: string[]
}

/**
 * 全平台共有的 core columns（方案附录 A.5），顺序即默认导出顺序。
 * 各平台适配器导出时以 `CORE_EXPORT_COLUMNS + 平台 extended columns` 拼接。
 */
export const CORE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'platform', header: '平台', width: 8 },
  { key: 'account', header: '账号', width: 14 },
  { key: 'orderId', header: '订单号', width: 24 },
  { key: 'createdAt', header: '下单时间', width: 20, format: 'datetime' },
  { key: 'title', header: '商品标题', width: 36 },
  { key: 'imageUrl', header: '商品图URL', width: 30 },
  { key: 'unitPrice', header: '单价', width: 10, format: 'number' },
  { key: 'paidAmount', header: '实付金额', width: 12, format: 'number' },
  { key: 'quantity', header: '数量', width: 6, format: 'number' },
  { key: 'status', header: '订单状态', width: 12 },
  { key: 'shopName', header: '店铺名', width: 18 },
  { key: 'receiverName', header: '收货人', width: 10 },
  { key: 'receiverAddress', header: '收货地址', width: 40 },
  { key: 'receiverPhone', header: '收货电话', width: 14 },
  { key: 'logisticsCompany', header: '物流公司', width: 12 },
  { key: 'trackingNo', header: '运单号', width: 20 },
  { key: 'paidAt', header: '付款时间', width: 20, format: 'datetime' },
  { key: 'shippedAt', header: '发货时间', width: 20, format: 'datetime' },
  { key: 'completedAt', header: '成交时间', width: 20, format: 'datetime' }
]

/** 构造空订单，适配器解析时先展开再逐字段填充，保证新字段不遗漏 */
export function emptyOrder(platform: string, account = ''): Order {
  return {
    platform,
    account,
    orderId: '',
    createdAt: null,
    title: '',
    imageUrl: '',
    unitPrice: '',
    paidAmount: '',
    quantity: null,
    status: '',
    shopName: '',
    receiverName: '',
    receiverAddress: '',
    receiverPhone: '',
    logisticsCompany: '',
    trackingNo: '',
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    extra: {}
  }
}
