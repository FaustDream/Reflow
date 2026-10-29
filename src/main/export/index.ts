/**
 * 工单 007/009/022：统一导出 IPC。
 *
 * 支持三种导出形态：
 * - `xlsx` 单 Sheet（所有平台合并到一张表，跨平台列冲突自动消歧）
 * - `xlsx` 多 Sheet（每个平台一张表，列互不干扰）
 * - `csv`  单表（带 UTF-8 BOM）
 *
 * 渲染层把已捕获的 Order[] 发来（订单主存渲染层），主进程负责建表、下载图片、落盘。
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CORE_EXPORT_COLUMNS, type Order } from '../../shared/types/order'
import {
  buildMultiSheetWorkbook,
  buildOrdersWorkbook,
  pickCoreColumns,
  resolveExportColumns
} from './excel'
import { buildOrdersCsv } from './csv'
import { appendHistory, clearHistory, loadHistory } from './history'
import { downloadOrderImages, type PreparedImage } from './images'
import type { AdapterRegistry } from '../platform/registry'
import type { ExportColumn } from '../../shared/types/order'

export type ExportFormat = 'xlsx' | 'csv'
export type ExportLayout = 'single' | 'multi-sheet'

export interface ExportOptions {
  orders: Order[]
  platforms?: string[]
  includeImages?: boolean
  /** 格式，默认 xlsx */
  format?: ExportFormat
  /** 布局，默认 single（合并到一张表） */
  layout?: ExportLayout
  /** 只导出这些扩展列 key（缺省全导出；传空数组 = 不要扩展列） */
  columnKeys?: string[]
  /** 只导出这些核心列 key（缺省全导出；传空数组 = 不要核心列） */
  coreKeys?: string[]
  /** 多 Sheet 模式是否附带「汇总」表，默认 true */
  summary?: boolean
  /** 导出后的文件路径（不传则弹保存对话框；用于「重复上次导出」） */
  targetPath?: string
}

export interface ExportResult {
  ok: boolean
  cancelled?: boolean
  reason?: 'empty' | 'write-failed' | 'no-columns'
  message?: string
  path?: string
  /** 工单 009：图片下载失败的 URL 数（文件仍正常导出） */
  imageFailures?: number
  /** 实际导出的行数 */
  rowCount?: number
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 各平台图片 CDN 的 Referer（部分 CDN 有防盗链） */
const REFERERS: Record<string, string> = {
  xianyu: 'https://www.goofish.com/',
  'xianyu-sold': 'https://www.goofish.com/',
  taobao: 'https://www.taobao.com/',
  jd: 'https://order.jd.com/',
  pdd: 'https://mobile.yangkeduo.com/',
  meituan: 'https://wx.waimai.meituan.com/'
}

/**
 * 工单 034：平台自定义列序（原版列序）。
 * 声明了 `exportColumns` 的平台，导出时直接用这份列表，不再拼核心列。
 * `columnKeys` 语义与扩展列一致：undefined = 全要，[] = 一列都不要。
 */
function customColumns(
  registry: AdapterRegistry,
  platformId: string,
  columnKeys?: string[]
): ExportColumn[] | undefined {
  const list = registry.get(platformId)?.exportColumns
  if (!list?.length) return undefined
  if (!columnKeys) return list
  const allow = new Set(columnKeys)
  return list.filter((c) => allow.has(c.key))
}

/** 按平台收集扩展列（注入 platformId/platformName 供冲突消歧） */
function collectExtended(
  ids: string[],
  registry: AdapterRegistry,
  columnKeys?: string[]
): ExportColumn[] {
  // 缺省 = 全要；空数组 = 一列都不要（用户在导出中心取消了所有扩展列）
  const allow = columnKeys ? new Set(columnKeys) : null
  const extended: ExportColumn[] = []
  for (const id of ids) {
    const adapter = registry.get(id)
    if (!adapter) continue
    for (const col of adapter.columns) {
      if (allow && !allow.has(col.key)) continue
      extended.push({ ...col, platformId: id, platformName: adapter.displayName })
    }
  }
  return extended
}

export function setupExportIpc(
  getMainWindow: () => BrowserWindow | null,
  registry: AdapterRegistry
): void {
  ipcMain.handle(
    'export:excel',
    async (event, payload: ExportOptions): Promise<ExportResult> => {
      const orders = Array.isArray(payload?.orders) ? payload.orders : []
      if (!orders.length) return { ok: false, reason: 'empty', message: '没有可导出的订单' }

      const format: ExportFormat = payload.format === 'csv' ? 'csv' : 'xlsx'
      const layout: ExportLayout = payload.layout === 'multi-sheet' ? 'multi-sheet' : 'single'

      // 涉及平台（顺序按调用方给的 platforms，缺省从订单推导）
      const ids =
        payload.platforms && payload.platforms.length
          ? payload.platforms
          : [...new Set(orders.map((o) => o.platform))]

      // 工单 031：列白名单先校验 —— 一列都没选时不该弹保存框再写一个空文件
      const core = pickCoreColumns(payload.coreKeys)
      const extendedAll = collectExtended(ids, registry, payload.columnKeys)
      // 工单 034：声明了原版列序的平台，列来自 exportColumns，不参与核心列/扩展列判定
      // 自定义列序平台的「全选清单」由导出中心放在 coreKeys 里（UI 只渲染一个列组）
      const custom = ids.length === 1 ? customColumns(registry, ids[0], payload.coreKeys) : undefined
      if (!core.length && !extendedAll.length && !custom?.length) {
        return { ok: false, reason: 'no-columns', message: '没有选择任何导出列' }
      }

      // 保存路径（默认停在上次导出的目录，省得每次翻文件夹）
      const label = ids.length === 1 ? registry.get(ids[0])?.displayName ?? ids[0] : '全部平台'
      const ext = format === 'csv' ? 'csv' : 'xlsx'
      const suffix = payload.includeImages && format === 'xlsx' ? '_含图' : ''
      const win = getMainWindow()
      let targetPath = payload.targetPath
      if (!targetPath) {
        const defaultName = `回流_${label}_${timestamp()}${suffix}.${ext}`
        const lastDir = (await loadHistory().catch(() => null))?.lastDir ?? ''
        const picked = await dialog.showSaveDialog(win as BrowserWindow, {
          title: '导出订单',
          defaultPath: lastDir ? join(lastDir, defaultName) : defaultName,
          filters:
            format === 'csv'
              ? [{ name: 'CSV 表格', extensions: ['csv'] }]
              : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        })
        if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
        targetPath = picked.filePath
      }

      // 工单 009：含图导出先下载图片（进度实时推送），失败单张跳过
      let images: Map<string, PreparedImage> | undefined
      let imageFailures = 0
      const wantImages = Boolean(payload.includeImages) && format === 'xlsx'
      if (wantImages) {
        const urls = orders.map((o) => o.imageUrl).filter(Boolean)
        const sender = event.sender
        const { images: downloaded, failed } = await downloadOrderImages(urls, {
          concurrency: 8,
          refererFor: (url) => {
            const owner = orders.find((o) => o.imageUrl === url)
            return owner ? REFERERS[owner.platform] : undefined
          },
          onProgress: (p) => {
            if (!sender.isDestroyed()) sender.send('export:image-progress', p)
          }
        })
        images = downloaded
        imageFailures = failed.length
      }

      try {
        let buffer: Buffer
        if (format === 'csv') {
          // CSV 无多 Sheet 概念：始终单表，列合并去重
          buffer = buildOrdersCsv(orders, custom ?? resolveExportColumns(extendedAll, core))
        } else if (layout === 'multi-sheet') {
          // 每平台一张表，各自列定义（互不污染）
          const sheets = ids
            .map((id) => ({
              name: registry.get(id)?.displayName ?? id,
              orders: orders.filter((o) => o.platform === id),
              extended: collectExtended([id], registry, payload.columnKeys),
              columns: customColumns(registry, id, payload.coreKeys)
            }))
            .filter((s) => s.orders.length)
          buffer = await buildMultiSheetWorkbook(sheets, {
            images,
            coreKeys: payload.coreKeys,
            summary: payload.summary
          })
        } else {
          buffer = await buildOrdersWorkbook(orders, extendedAll, {
            images,
            coreKeys: payload.coreKeys,
            columns: custom
          })
        }

        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, buffer)
        // 历史记录只存元信息；写失败不影响本次导出结果
        await appendHistory({
          path: targetPath,
          fileName: basename(targetPath),
          format,
          layout: format === 'csv' ? 'single' : layout,
          rowCount: orders.length,
          platforms: ids,
          includeImages: wantImages,
          at: Date.now()
        }).catch(() => undefined)
        return {
          ok: true,
          path: targetPath,
          imageFailures,
          rowCount: orders.length
        }
      } catch (err) {
        return {
          ok: false,
          reason: 'write-failed',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  /**
   * 工单 031：导出中心的列清单。
   * 由主进程按适配器 + 跨平台消歧规则算出（与真正导出时同一套 `resolveExportColumns`），
   * 渲染层只负责勾选，避免两边各算一套导致「看到的列」和「导出的列」不一致。
   */
  ipcMain.handle('export:columns', (_event, platforms: string[] | undefined) => {
    const ids = Array.isArray(platforms) && platforms.length ? platforms : registry.list().map((a) => a.id)
    // 单平台且声明了原版列序 → 直接返回那份列表，UI 按「平台列」展示
    const custom = ids.length === 1 ? registry.get(ids[0])?.exportColumns : undefined
    if (custom?.length) {
      return { core: [], extended: custom.map((c) => ({ ...c })), custom: true }
    }
    const resolved = resolveExportColumns(collectExtended(ids, registry))
    const coreKeys = new Set(CORE_EXPORT_COLUMNS.map((c) => c.key))
    return {
      core: CORE_EXPORT_COLUMNS.map((c) => ({ ...c })),
      extended: resolved.filter((c) => !coreKeys.has(c.key))
    }
  })

  ipcMain.handle('export:open-path', async (_event, path: string) => {
    if (typeof path === 'string') await shell.openPath(path)
  })

  ipcMain.handle('export:show-in-folder', async (_event, path: string) => {
    if (typeof path === 'string') shell.showItemInFolder(path)
  })

  /** 工单 031：最近导出记录（元信息，不含订单内容） */
  ipcMain.handle('export:history', async () => {
    const history = await loadHistory()
    return history.entries
  })

  ipcMain.handle('export:clear-history', async () => {
    await clearHistory()
    return { ok: true }
  })
}
