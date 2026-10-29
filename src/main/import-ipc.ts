/**
 * 「导入平台导出的订单文件」IPC。
 *
 * 场景：淘宝/美团的网页订单列表只给一部分，官方导出才是全量。
 * 用户把导出的 xlsx/csv 选进来，直接并进本地库（按 platform 分文件），
 * 以后启动从本地恢复，不会重复拉取。
 */
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { loadPlatformCache, savePlatformCache } from './order-cache'
import { parseOrdersFile } from './import-orders'
import type { Order } from '../shared/types/order'

export function setupImportIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    'orders:import-file',
    async (
      _event,
      platform: string
    ): Promise<{ ok: boolean; imported: number; skipped: number; message?: string }> => {
      const win = getMainWindow()
      const options = {
        title: '选择平台导出的订单文件（xlsx / csv）',
        properties: ['openFile' as const],
        filters: [
          { name: '订单文件', extensions: ['xlsx', 'xls', 'csv'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths.length) {
        return { ok: false, imported: 0, skipped: 0, message: '已取消' }
      }

      try {
        const parsed = await parseOrdersFile(picked.filePaths[0])
        if (!parsed.orders.length) {
          return {
            ok: false,
            imported: 0,
            skipped: parsed.skipped,
            message: '文件里没识别出订单（表头需要包含「订单编号 / 商品标题 / 实付款」等列）'
          }
        }

        const existing = await loadPlatformCache(platform)
        const seen = new Set(existing.map((o) => o.orderId).filter(Boolean))
        const incoming: Order[] = parsed.orders
          .map((o) => ({ ...o, platform }))
          .filter((o) => !o.orderId || !seen.has(o.orderId))

        const merged = [...incoming, ...existing].sort((a, b) =>
          (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
        )
        await savePlatformCache(platform, merged)

        // 通知渲染层重载本地缓存（订单数、表格立刻更新）
        win?.webContents.send('orders:cache-updated', platform)
        return { ok: true, imported: incoming.length, skipped: parsed.skipped }
      } catch (err) {
        return {
          ok: false,
          imported: 0,
          skipped: 0,
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
