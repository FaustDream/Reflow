/**
 * 工单 031：导出历史 + 默认目录记忆。
 *
 * 为什么要有：用户导出后往往还要再导一次（补抓了新单、换了列），
 * 每次都要重新找目录很烦；出问题想回看「上次导的是哪个文件」也无从查起。
 *
 * 设计取舍：
 * - 只记**元信息**（路径/行数/平台/时间），不记订单内容 —— 与 D-4 隐私门禁一致
 * - 最多 20 条，超出丢弃最旧的；同一路径重复导出视为同一条（移到最前）
 * - 原子写入，损坏时返回空历史而不是崩溃
 */
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExportHistoryEntry } from '../../shared/types'

const VERSION = 1
export const HISTORY_LIMIT = 20

export type { ExportHistoryEntry }

export interface ExportHistory {
  version: number
  /** 上次导出所在目录（下次保存对话框默认停在这里） */
  lastDir: string
  entries: ExportHistoryEntry[]
}

const EMPTY: ExportHistory = { version: VERSION, lastDir: '', entries: [] }

function filePath(): string {
  return join(app.getPath('userData'), 'export-history.json')
}

/**
 * 纯函数：把一条记录并入历史（**新记录在最前**，同路径去重，超限截断）。
 * 单独抽出来是为了能在 vitest 里断言，不必启动 Electron。
 */
export function pushEntry(
  history: ExportHistory | null,
  entry: ExportHistoryEntry,
  limit = HISTORY_LIMIT
): ExportHistory {
  const base = history ?? EMPTY
  const rest = base.entries.filter((e) => e.path !== entry.path)
  return {
    version: VERSION,
    lastDir: dirname(entry.path),
    entries: [entry, ...rest].slice(0, limit)
  }
}

export async function loadHistory(): Promise<ExportHistory> {
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const data = JSON.parse(raw) as ExportHistory
    if (data?.version !== VERSION || !Array.isArray(data.entries)) return { ...EMPTY }
    return {
      version: VERSION,
      lastDir: typeof data.lastDir === 'string' ? data.lastDir : '',
      entries: data.entries.filter((e) => typeof e?.path === 'string')
    }
  } catch {
    return { ...EMPTY }
  }
}

export async function appendHistory(entry: ExportHistoryEntry): Promise<ExportHistory> {
  const next = pushEntry(await loadHistory(), entry)
  const target = filePath()
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 1), 'utf-8')
  await rename(tmp, target)
  return next
}

export async function clearHistory(): Promise<void> {
  const current = await loadHistory()
  const target = filePath()
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify({ ...EMPTY, lastDir: current.lastDir }, null, 1), 'utf-8')
  await rename(tmp, target)
}
