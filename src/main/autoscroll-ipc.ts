/**
 * 工单 010：自动翻页（滚动加载）IPC。
 *
 * 对「滚动加载」型平台（闲鱼/得物/美团/饿了么/快手/拼多多），
 * 主进程把自动滚动脚本注入平台 webview 的页面主世界，由页面自己触发加载，
 * 响应照常走被动捕获管道。
 */
import { ipcMain, webContents, type BrowserWindow } from 'electron'
import {
  installAutoScroller,
  installClickPager,
  installJdYearWalker,
  CLICK_PAGE_TARGETS,
  DEFAULT_AUTO_SCROLL,
  isClickPagePlatform,
  isScrollPlatform,
  type AutoScrollOptions
} from '../shared/page-scripts/auto-scroll'
import type { AutoScrollEvent } from '../shared/types'

interface RunnerState {
  webContentsId: number
  nonce: string
  startedAt: number
}

const running = new Map<string, RunnerState>()

export function setupAutoScrollIpc(getMainWindow: () => BrowserWindow | null): void {
  const emit = (payload: Omit<AutoScrollEvent, 'ts'>): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('autoscroll:event', { ...payload, ts: Date.now() })
  }

  ipcMain.handle(
    'autoscroll:start',
    async (
      _event,
      payload: { platform: string; webviewId: number; options?: AutoScrollOptions }
    ): Promise<{ ok: boolean; message?: string }> => {
      const { platform, webviewId, options } = payload
      const clickTarget = CLICK_PAGE_TARGETS[platform]
      if (!isScrollPlatform(platform) && !isClickPagePlatform(platform)) {
        return { ok: false, message: `平台 ${platform} 已有代码侧翻页，无需滚动` }
      }
      const contents = webContents.fromId(webviewId)
      if (!contents || contents.isDestroyed()) {
        return { ok: false, message: '页面尚未就绪' }
      }

      const nonce = `as-${Date.now()}-${Math.random().toString(36).slice(2)}`
      running.set(platform, { webContentsId: webviewId, nonce, startedAt: Date.now() })
      emit({ platform, phase: 'started' })

      // 京东：订单页默认只显示「近3个月」，逐年切换时间下拉才能把历史订单全拉出来
      // 1688：点「下一页」
      const source = platform === 'jd'
        ? `(${installJdYearWalker.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(platform)}, ${JSON.stringify({ years: 12, intervalMs: 2500, maxPagesPerYear: 25 })})`
        : clickTarget
        ? `(${installClickPager.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(
            platform
          )}, ${JSON.stringify({ ...DEFAULT_AUTO_SCROLL, ...(options ?? {}), ...clickTarget })})`
        : `(${installAutoScroller.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(
            platform
          )}, ${JSON.stringify(options ?? DEFAULT_AUTO_SCROLL)})`
      try {
        await contents.executeJavaScript(source)
        return { ok: true }
      } catch (err) {
        running.delete(platform)
        const message = err instanceof Error ? err.message : String(err)
        emit({ platform, phase: 'finished', ok: false, error: message })
        return { ok: false, message }
      }
    }
  )

  ipcMain.handle('autoscroll:stop', async (_event, platform: string) => {
    const state = running.get(platform)
    if (!state) return { ok: true }
    const contents = webContents.fromId(state.webContentsId)
    if (contents && !contents.isDestroyed()) {
      // 页面侧停表并自报 stopped（经 inject preload 转发回来，走同一条事件通道）
      await contents
        .executeJavaScript(
          `(() => { const s = window.__reflowAutoScroll; if (s && s.stop) s.stop(); return true; })()`
        )
        .catch(() => undefined)
    }
    // 兜底：若页面已卸载/无法回报，直接清理并补发 finished
    setTimeout(() => {
      if (!running.has(platform)) return
      running.delete(platform)
      emit({ platform, phase: 'finished', ok: true, cancelled: true })
    }, 800)
    return { ok: true }
  })

  /** 页面脚本经 postMessage 上报的状态（由 inject preload 校验 nonce 后转发） */
  ipcMain.on('autoscroll:report', (_event, payload: AutoScrollEvent) => {
    const state = running.get(payload.platform)
    if (!state) return
    if (payload.phase === 'finished') running.delete(payload.platform)
    emit(payload)
  })
}
