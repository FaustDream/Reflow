/**
 * 工单 031：导出历史（纯函数部分）。
 *
 * 文件 IO 依赖 Electron 的 userData 路径，不在单测里跑；
 * 这里钉死三条容易写错的规则：最新在前、同路径去重、超限截断。
 */
import { describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { HISTORY_LIMIT, pushEntry, type ExportHistoryEntry } from '../history'

const entry = (path: string, at = 1): ExportHistoryEntry => ({
  path,
  fileName: path.split(/[\\/]/).pop() ?? path,
  format: 'xlsx',
  layout: 'single',
  rowCount: 10,
  platforms: ['xianyu'],
  includeImages: false,
  at
})

describe('pushEntry', () => {
  it('空历史：新记录成为唯一一条，并记住所在目录', () => {
    const history = pushEntry(null, entry('D:/out/a.xlsx'))
    expect(history.entries).toHaveLength(1)
    expect(history.lastDir).toBe(dirname('D:/out/a.xlsx'))
  })

  it('新记录排在最前', () => {
    let history = pushEntry(null, entry('D:/out/a.xlsx', 1))
    history = pushEntry(history, entry('D:/out/b.xlsx', 2))
    expect(history.entries.map((e) => e.fileName)).toEqual(['b.xlsx', 'a.xlsx'])
  })

  it('同一路径重复导出只保留一条（并移到最前）', () => {
    let history = pushEntry(null, entry('D:/out/a.xlsx', 1))
    history = pushEntry(history, entry('D:/out/b.xlsx', 2))
    history = pushEntry(history, entry('D:/out/a.xlsx', 3))
    expect(history.entries.map((e) => e.fileName)).toEqual(['a.xlsx', 'b.xlsx'])
    expect(history.entries[0].at).toBe(3)
  })

  it('超过上限时丢弃最旧的', () => {
    let history = null
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      history = pushEntry(history, entry(`D:/out/${i}.xlsx`, i))
    }
    expect(history!.entries).toHaveLength(HISTORY_LIMIT)
    expect(history!.entries[0].fileName).toBe(`${HISTORY_LIMIT + 4}.xlsx`)
    expect(history!.entries.at(-1)!.fileName).toBe('5.xlsx')
  })

  it('自定义上限生效（便于调用方收紧）', () => {
    let history = pushEntry(null, entry('D:/out/a.xlsx', 1))
    history = pushEntry(history, entry('D:/out/b.xlsx', 2), 1)
    expect(history.entries.map((e) => e.fileName)).toEqual(['b.xlsx'])
  })
})
