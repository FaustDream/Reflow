import { describe, expect, it } from 'vitest'
import {
  COLUMN_ORDER_STORAGE_KEY,
  DEFAULT_COLUMN_ORDER,
  TABLE_COLUMN_KEYS,
  isSameColumnOrder,
  loadColumnOrder,
  moveColumn,
  moveColumnByKey,
  normalizeColumnOrder,
  saveColumnOrder,
  type TableColumnKey
} from '../column-order'

describe('normalizeColumnOrder', () => {
  it('默认顺序覆盖全部列且无重复', () => {
    expect(DEFAULT_COLUMN_ORDER).toHaveLength(TABLE_COLUMN_KEYS.length)
    expect(new Set(DEFAULT_COLUMN_ORDER).size).toBe(TABLE_COLUMN_KEYS.length)
  })

  it('非数组 / 空值回退默认顺序', () => {
    expect(normalizeColumnOrder(undefined)).toEqual(DEFAULT_COLUMN_ORDER)
    expect(normalizeColumnOrder(null)).toEqual(DEFAULT_COLUMN_ORDER)
    expect(normalizeColumnOrder('orderId')).toEqual(DEFAULT_COLUMN_ORDER)
    expect(normalizeColumnOrder({ orderId: 1 })).toEqual(DEFAULT_COLUMN_ORDER)
  })

  it('丢弃已删除的列（老版本存的 key）', () => {
    const saved = ['title', 'sellerId', 'orderId']
    expect(normalizeColumnOrder(saved)).toEqual([
      'title',
      'orderId',
      'paidAmount',
      'quantity',
      'status',
      'createdAt',
      'shopName'
    ])
  })

  it('缺失的列按默认顺序补在末尾（新增列不会永远不显示）', () => {
    const saved = ['shopName', 'orderId']
    const result = normalizeColumnOrder(saved)
    expect(result.slice(0, 2)).toEqual(['shopName', 'orderId'])
    expect(result).toHaveLength(TABLE_COLUMN_KEYS.length)
    expect(result).toContain('title')
  })

  it('重复项只保留第一次出现的位置', () => {
    const saved = ['title', 'title', 'orderId', 'title']
    expect(normalizeColumnOrder(saved).slice(0, 2)).toEqual(['title', 'orderId'])
    expect(normalizeColumnOrder(saved)).toHaveLength(TABLE_COLUMN_KEYS.length)
  })

  it('过滤非字符串项', () => {
    const saved: unknown[] = ['title', 42, null, { key: 'orderId' }, 'status']
    const result = normalizeColumnOrder(saved)
    expect(result[0]).toBe('title')
    expect(result[1]).toBe('status')
    expect(result).toHaveLength(TABLE_COLUMN_KEYS.length)
  })
})

describe('moveColumn', () => {
  const base: TableColumnKey[] = ['orderId', 'title', 'paidAmount', 'quantity']

  it('把列拖到目标位置', () => {
    expect(moveColumn(base, 0, 2)).toEqual(['title', 'paidAmount', 'orderId', 'quantity'])
    expect(moveColumn(base, 3, 0)).toEqual(['quantity', 'orderId', 'title', 'paidAmount'])
  })

  it('原地移动返回等价副本', () => {
    const result = moveColumn(base, 1, 1)
    expect(result).toEqual(base)
    expect(result).not.toBe(base)
  })

  it('越界位置夹取到两端', () => {
    expect(moveColumn(base, 0, 99)).toEqual(['title', 'paidAmount', 'quantity', 'orderId'])
    expect(moveColumn(base, 3, -5)).toEqual(['quantity', 'orderId', 'title', 'paidAmount'])
  })

  it('非法起点原样返回（不抛错）', () => {
    expect(moveColumn(base, -1, 2)).toEqual(base)
    expect(moveColumn(base, 9, 2)).toEqual(base)
  })

  it('不修改传入的数组', () => {
    const snapshot = [...base]
    moveColumn(base, 0, 3)
    expect(base).toEqual(snapshot)
  })
})

describe('moveColumnByKey', () => {
  const base: TableColumnKey[] = ['orderId', 'title', 'paidAmount']

  it('按 key 上下移动一格', () => {
    expect(moveColumnByKey(base, 'title', -1)).toEqual(['title', 'orderId', 'paidAmount'])
    expect(moveColumnByKey(base, 'title', 1)).toEqual(['orderId', 'paidAmount', 'title'])
  })

  it('边界处原样返回（按钮 disabled 时的兜底）', () => {
    expect(moveColumnByKey(base, 'orderId', -1)).toEqual(base)
    expect(moveColumnByKey(base, 'paidAmount', 1)).toEqual(base)
  })

  it('未知 key 原样返回', () => {
    expect(moveColumnByKey(base, 'shopName', 1)).toEqual(base)
  })
})

describe('isSameColumnOrder', () => {
  it('同内容不同引用视为一致', () => {
    expect(isSameColumnOrder([...DEFAULT_COLUMN_ORDER], DEFAULT_COLUMN_ORDER)).toBe(true)
  })

  it('顺序不同 / 长度不同视为不一致', () => {
    const swapped = [...DEFAULT_COLUMN_ORDER]
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(isSameColumnOrder(swapped, DEFAULT_COLUMN_ORDER)).toBe(false)
    expect(isSameColumnOrder(DEFAULT_COLUMN_ORDER.slice(1), DEFAULT_COLUMN_ORDER)).toBe(false)
  })
})

describe('localStorage 读写', () => {
  it('node 环境没有 localStorage 时读默认、写不抛错', () => {
    expect(loadColumnOrder()).toEqual(DEFAULT_COLUMN_ORDER)
    expect(() => saveColumnOrder(DEFAULT_COLUMN_ORDER)).not.toThrow()
  })

  it('存储键名固定（改名等于让所有老用户的顺序丢失）', () => {
    expect(COLUMN_ORDER_STORAGE_KEY).toBe('reflow.table-column-order')
  })
})
