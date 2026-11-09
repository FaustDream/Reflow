/**
 * IPC 指令留痕（2026-11-02）。
 *
 * 用户要求「每一个指令都要在日志输出」。与其在每个 handler 里手写一遍，
 * 不如在启动早期包一层 `ipcMain.handle`：
 *   - 成功 → debug 级，记频道名与耗时
 *   - 抛错 → error 级，记频道名、耗时、错误信息
 *
 * 只在 renderer → main 的 invoke 通道上生效（`ipcMain.on` 的被动捕获流量不碰，
 * 否则每一条网页响应都会刷屏）。
 */
import { ipcMain } from 'electron'
import { debug, error } from './logger'

let patched = false

/** 日志频道自身不记（否则每看一次日志就多两条「log:list」，自我刷屏） */
const SKIP = /^log:/

type Handler = (event: unknown, ...args: unknown[]) => unknown

export function traceIpc(): void {
  if (patched) return
  patched = true
  const orig = ipcMain.handle.bind(ipcMain)
  // Electron 的类型定义不允许替换方法，这里按需覆写
  ;(ipcMain as unknown as { handle: (channel: string, listener: Handler) => void }).handle = (
    channel: string,
    listener: Handler
  ) => {
    orig(channel, async (event, ...args) => {
      const t0 = Date.now()
      try {
        const result = await listener(event, ...args)
        if (!SKIP.test(channel)) debug('ipc', channel, { ms: Date.now() - t0 })
        return result
      } catch (e) {
        error('ipc', `${channel} 调用失败`, {
          error: e instanceof Error ? e.message : String(e),
          ms: Date.now() - t0
        })
        throw e
      }
    })
  }
}
