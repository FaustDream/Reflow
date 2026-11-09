/**
 * 列顺序的共享状态（工单 043）。
 *
 * 用模块级单例而不是 Pinia store：只有 OrderTable（读）与列设置弹窗（写）
 * 两个消费方，且数据就是一个 key 数组 —— 为它建一个 store 反而要处理
 * 「谁负责首次加载」。模块级 ref 天然全局唯一，且 HMR 时从 localStorage 重建，
 * 与用户看到的顺序始终一致。
 */
import { computed, ref } from 'vue'
import {
  DEFAULT_COLUMN_ORDER,
  isSameColumnOrder,
  loadColumnOrder,
  normalizeColumnOrder,
  saveColumnOrder,
  type TableColumnKey
} from '@renderer/utils/column-order'

/** 首次 import 时从 localStorage 恢复 */
const order = ref<TableColumnKey[]>(loadColumnOrder())

const isDefault = computed(() => isSameColumnOrder(order.value, DEFAULT_COLUMN_ORDER))

export function useColumnOrder(): {
  order: typeof order
  isDefault: typeof isDefault
  setOrder: (next: readonly TableColumnKey[]) => void
  resetOrder: () => void
} {
  /** 保存并立即生效（OrderTable 的 columns 是 computed，改完当帧重排） */
  function setOrder(next: readonly TableColumnKey[]): void {
    const normalized = normalizeColumnOrder(next)
    order.value = normalized
    saveColumnOrder(normalized)
  }

  function resetOrder(): void {
    setOrder(DEFAULT_COLUMN_ORDER)
  }

  return { order, isDefault, setOrder, resetOrder }
}
