/**
 * 系统日志 IPC（2026-11-02）。
 *
 * - `log:list` / `log:clear` / `log:open-folder`：给「运行日志」标签页用
 * - `log:write`：渲染层把用户动作（切平台、点抓取、改筛选…）记进同一份日志
 * - 实时推送：主进程每条日志经 `log:entry` 发到窗口，界面无需轮询
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  clearLogs,
  currentLogDir,
  currentLogFile,
  debug,
  error,
  info,
  listLogs,
  setLogSink,
  warn
} from './logging/logger'
import type { LogLevel } from '../shared/types'

interface LogWritePayload {
  level?: LogLevel
  scope?: string
  message?: string
  detail?: unknown
}

const WRITERS: Record<LogLevel, (scope: string, message: string, detail?: unknown) => void> = {
  debug,
  info,
  warn,
  error
}

export function setupLoggingIpc(getWindow: () => BrowserWindow | null): void {
  setLogSink((entry) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('log:entry', entry)
  })

  ipcMain.handle('log:list', () => ({ entries: listLogs(), filePath: currentLogFile() }))

  ipcMain.handle('log:clear', () => {
    clearLogs()
    return { ok: true }
  })

  ipcMain.handle('log:open-folder', async () => {
    const dir = currentLogDir()
    if (!dir) return { ok: false, error: '日志目录不可用' }
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('log:write', (_event, payload: LogWritePayload) => {
    const level: LogLevel = payload?.level && payload.level in WRITERS ? payload.level : 'info'
    const scope = String(payload?.scope ?? 'ui').slice(0, 40)
    const message = String(payload?.message ?? '').slice(0, 500)
    if (!message) return { ok: false }
    WRITERS[level](scope, message, payload.detail)
    return { ok: true }
  })
}
