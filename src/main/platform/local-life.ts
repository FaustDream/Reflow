/**
 * 工单 018/020：本地生活（外卖）平台共用的列语义。
 *
 * 饿了么与美团的订单模型与实物电商差异显著：
 * - 没有快递公司/运单号（用配送状态、预计送达替代）
 * - 「收货地址」是配送地址；「店铺名」是门店名（`storeName` / `poi_name`）
 * - 「商品标题」是餐品摘要（多份餐品以空格连接，数量 >1 追加 ` xN`）
 * - 下单时间字段可能为秒或毫秒时间戳
 *
 * 工单明确要求两者共用同一套映射，不得两处各写一遍 —— 本模块是唯一实现。
 */
import type { ExportColumn } from '../../shared/types/order'

/**
 * 本地生活平台共用的扩展列（core 已含订单号/时间/金额/数量/状态/门店名）。
 * 仅补 core 无法表达的配送语义字段。
 */
export const LOCAL_LIFE_COLUMNS: ExportColumn[] = [
  { key: 'deliveryStatus', header: '配送状态', width: 14 },
  { key: 'isSelfPick', header: '是否自取', width: 10 },
  { key: 'estimateArrival', header: '预计送达', width: 20 },
  { key: 'deliveryAddress', header: '配送地址', width: 36 },
  { key: 'orderDetailUrl', header: '订单详情链接', width: 36 }
]

/**
 * 餐品摘要拼接（原版美团 S3 规则）：
 * `product_list[].product_name`，`product_count > 1` 时追加 ` x{count}`，多份以空格连接。
 */
export function joinProductDetails(
  products: Array<{ name: unknown; count?: unknown }>
): string {
  return products
    .map((p) => {
      const name = typeof p.name === 'string' || typeof p.name === 'number' ? String(p.name) : ''
      if (!name) return ''
      const n = Number(p.count)
      return Number.isFinite(n) && n > 1 ? `${name} x${n}` : name
    })
    .filter(Boolean)
    .join(' ')
}

/** 布尔/数字混杂的「是否自取」→ 导出友好的中文标签；未知留空 */
export function selfPickLabel(value: unknown): string {
  if (value === true || value === 1 || value === '1' || value === 'true') return '自取'
  if (value === false || value === 0 || value === '0' || value === 'false') return '配送'
  return ''
}

/**
 * 本地生活平台的金额：多为**元**的 number（美团 `total: 22.8`、饿了么 `orderAmount`），
 * 统一转可读字符串，保留平台原始小数。
 */
export function localLifeAmount(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return String(value)
}

/**
 * 单价 = 总额 / 件数（外卖接口不返回单件价）。
 * 保留两位小数但去掉尾部 0（`7.60`→`7.6`、`19.00`→`19`），与平台展示一致。
 */
export function unitPriceFrom(total: unknown, count: unknown): string {
  const t = Number(total)
  const c = Number(count)
  if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) return ''
  return (t / c).toFixed(2).replace(/\.?0+$/, '')
}
