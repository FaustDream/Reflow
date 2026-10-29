/**
 * 工单 023：订单缓存 IPC + 自动保存。
 *
 * 数据权威在渲染层 store（它持有完整订单列表）。主进程只做镜像落盘：
 * 渲染层每次合并订单后调 `cache:save` 传完整快照，主进程去抖后原子写文件。
 *
 * 这样避免了「主进程自己累积增量」导致的内存副本与渲染层不一致。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type { Order } from '../shared/types/order'
import {
  clearAllCache,
  clearPlatformCache,
  cacheSummary,
  loadAllCache,
  savePlatformCache
} from './order-cache'

const SAVE_DEBOUNCE_MS = 1200

/** platform → 最新完整快照（待写） */
const pending = new Map<string, Order[]>()
const timers = new Map<string, NodeJS.Timeout>()

function scheduleSave(platform: string, orders: Order[]): void {
  pending.set(platform, orders)
  const existing = timers.get(platform)
  if (existing) clearTimeout(existing)
  timers.set(
    platform,
    setTimeout(() => {
      void flush(platform)
    }, SAVE_DEBOUNCE_MS)
  )
}

async function flush(platform: string): Promise<void> {
  const orders = pending.get(platform)
  timers.delete(platform)
  if (!orders) return
  pending.delete(platform)
  try {
    await savePlatformCache(platform, orders)
  } catch {
    /* 磁盘满/权限问题不应崩主进程；下次快照会重试 */
  }
}

/** 应用退出前把所有待写快照落盘 */
export async function flushAllCache(): Promise<void> {
  await Promise.all([...pending.keys()].map((p) => flush(p)))
}

export interface CacheIpcOptions {
  getMainWindow: () => BrowserWindow | null
}

export function setupOrderCacheIpc(_options: CacheIpcOptions): void {
  /** 启动时恢复：渲染层拉取全部缓存 */
  ipcMain.handle('cache:load-all', async () => loadAllCache())

  /** 缓存概览（哪个平台有多少历史单、最后保存时间） */
  ipcMain.handle('cache:summary', async () => cacheSummary())

  /** 保存完整快照（渲染层在订单合并后调用；去抖落盘） */
  ipcMain.handle(
    'cache:save',
    async (_event, payload: { platform: string; orders: Order[] }) => {
      const { platform, orders } = payload ?? {}
      if (typeof platform !== 'string' || !Array.isArray(orders)) {
        return { ok: false, message: '参数不合法' }
      }
      scheduleSave(platform, orders)
      return { ok: true }
    }
  )

  /** 清除某平台缓存 */
  ipcMain.handle('cache:clear-platform', async (_event, platform: string) => {
    const t = timers.get(platform)
    if (t) clearTimeout(t)
    timers.delete(platform)
    pending.delete(platform)
    await clearPlatformCache(platform)
    return { ok: true }
  })

  /** 清空全部缓存 */
  ipcMain.handle('cache:clear-all', async () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    pending.clear()
    await clearAllCache()
    return { ok: true }
  })
}
