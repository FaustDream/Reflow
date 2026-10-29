/**
 * 工单 025：诊断面板。
 *
 * 把散落在各处的运行状态收进一个只读快照，出问题时用户能一键复制给我们：
 * - 应用/运行时版本（Electron/Chromium/Node）
 * - 各平台适配器状态（规则数、登录态、已捕获数、最近解析错误）
 * - 缓存文件情况（哪个平台有多少历史单）
 * - 登录能力表（哪些平台能纯二维码）
 * - 最近 N 条捕获错误
 *
 * 隐私红线（D-4）：**绝不包含** Cookie、令牌、订单内容、收货地址。
 * 只输出计数、平台名、错误消息、版本号。
 */
import { ipcMain, app, type BrowserWindow } from 'electron'
import { cacheSummary } from './order-cache'
import { QR_STRATEGIES } from './qr-login'
import { adapterRegistry } from './platform/registry'

export interface DiagnosticsSnapshot {
  generatedAt: string
  app: {
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
    userDataPath: string
  }
  adapters: Array<{
    id: string
    displayName: string
    rules: number
    homeUrl: string
    hasLoginDetector: boolean
    loginKind: 'native' | 'dom' | 'page' | 'none'
  }>
  cache: Array<{ platform: string; count: number; savedAt: string }>
  /** 渲染层会补充：各平台在内存中的订单数、解析错误、滚动状态 */
  renderer?: unknown
}

/** 生成诊断快照（不含任何敏感数据） */
export async function buildDiagnostics(): Promise<DiagnosticsSnapshot> {
  const cache = await cacheSummary()
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData')
    },
    adapters: adapterRegistry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      rules: a.matchRules.length,
      homeUrl: a.homeUrl,
      hasLoginDetector: Boolean(a.login) || Boolean(a.pageScript),
      loginKind: QR_STRATEGIES[a.id]?.kind ?? 'none'
    })),
    cache: cache.map((c) => ({
      platform: c.platform,
      count: c.count,
      savedAt: new Date(c.savedAt).toISOString()
    }))
  }
}

export function setupDiagnosticsIpc(_getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('diagnostics:snapshot', async () => buildDiagnostics())
}
