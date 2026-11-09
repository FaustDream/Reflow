/**
 * 表格列顺序（工单 043，2026-11-09）。
 *
 * 为什么单独抽一层：列顺序是**纯数据变换**，与表格怎么渲染无关。
 * 抽出来才能单测「旧版本存的顺序里混进了已删除的列 / 新增了列 / 有重复项」
 * 这类只有升级时才踩得到的问题。
 *
 * 约定：
 *   - 顺序里只存**列 key**，不存标题与宽度 —— 改文案、调宽度不需要迁移存储
 *   - 全局一套顺序（不按平台分），切换平台时列位置不跳变
 *   - 勾选列不参与排序，永远钉在最左（fixed）
 */

/** 可排序的列，数组顺序即默认顺序 */
export const TABLE_COLUMN_KEYS = [
  'orderId',
  'title',
  'paidAmount',
  'quantity',
  'status',
  'createdAt',
  'shopName'
] as const

export type TableColumnKey = (typeof TABLE_COLUMN_KEYS)[number]

/** 设置面板里显示的列名（与 OrderTable 的 title 保持一致） */
export const COLUMN_LABELS: Record<TableColumnKey, string> = {
  orderId: '订单号',
  title: '商品',
  paidAmount: '实付',
  quantity: '数量',
  status: '状态',
  createdAt: '下单时间',
  shopName: '店铺'
}

/** 与 `reflow.visible-platforms` 同一套 localStorage 约定 */
export const COLUMN_ORDER_STORAGE_KEY = 'reflow.table-column-order'

export const DEFAULT_COLUMN_ORDER: TableColumnKey[] = [...TABLE_COLUMN_KEYS]

const KNOWN = new Set<string>(TABLE_COLUMN_KEYS)

function isColumnKey(value: unknown): value is TableColumnKey {
  return typeof value === 'string' && KNOWN.has(value)
}

/**
 * 把任意来源的顺序规整成「合法、完整、无重复」的一份。
 *
 * - 未知 key（老版本有、现在已经删掉的列）直接丢弃
 * - 重复项只保留第一次出现的位置
 * - 缺的 key 按默认顺序补在末尾 —— 将来加新列时，老用户的存储里没有它，
 *   不补就会「新列永远不显示」，而且不会有任何报错
 * - 非数组 / 全是垃圾值 → 回退默认顺序
 */
export function normalizeColumnOrder(input: unknown): TableColumnKey[] {
  const out: TableColumnKey[] = []
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isColumnKey(item) && !out.includes(item)) out.push(item)
    }
  }
  for (const key of TABLE_COLUMN_KEYS) {
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/** 把 from 位置的列挪到 to 位置（splice 语义，越界自动夹取） */
export function moveColumn(
  order: readonly TableColumnKey[],
  from: number,
  to: number
): TableColumnKey[] {
  const next = [...order]
  if (from < 0 || from >= next.length) return next
  const target = Math.max(0, Math.min(next.length - 1, to))
  if (target === from) return next
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/** 按 key 上下移动一格（delta = -1 上移，+1 下移）；到边界时原样返回 */
export function moveColumnByKey(
  order: readonly TableColumnKey[],
  key: TableColumnKey,
  delta: number
): TableColumnKey[] {
  const from = order.indexOf(key)
  if (from < 0) return [...order]
  return moveColumn(order, from, from + delta)
}

/** 两份顺序是否一致（用于判断「是否已恢复默认」） */
export function isSameColumnOrder(
  a: readonly TableColumnKey[],
  b: readonly TableColumnKey[]
): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

/**
 * 读取已保存的顺序。
 * localStorage 在 SSR / 单测（node 环境）里不存在，隐私模式下也可能抛错 ——
 * 任何异常都退回默认顺序，排序功能坏掉不该连带表格打不开。
 */
export function loadColumnOrder(): TableColumnKey[] {
  try {
    if (typeof localStorage === 'undefined') return [...DEFAULT_COLUMN_ORDER]
    const raw = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)
    if (!raw) return [...DEFAULT_COLUMN_ORDER]
    return normalizeColumnOrder(JSON.parse(raw))
  } catch {
    return [...DEFAULT_COLUMN_ORDER]
  }
}

/** 保存顺序；写入失败（配额满 / 隐私模式）静默降级为「本次会话有效」 */
export function saveColumnOrder(order: readonly TableColumnKey[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(normalizeColumnOrder(order)))
  } catch {
    /* 忽略：不影响当前会话的展示 */
  }
}
