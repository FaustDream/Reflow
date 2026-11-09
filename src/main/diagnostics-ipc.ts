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
import { ipcMain, app, session } from 'electron'
import { cacheSummary } from './order-cache'
import { QR_STRATEGIES } from './qr-login'
import { adapterRegistry } from './platform/registry'
import { getPlatformLoginStates } from './platform/cookie-login'

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
  /**
   * 登录态自检（2026-11-02 加）：用户报「登录失效」时，先看这里能区分
   * 「Cookie 真的没了」还是「Cookie 在、接口仍拒绝」。
   * 只报必要性 Cookie 的**名字与是否存在**，绝不带值。
   */
  login: Array<{
    platform: string
    detected: boolean
    present: string[]
    missing: string[]
  }>
  /** 渲染层会补充：各平台在内存中的订单数、解析错误、滚动状态 */
  renderer?: unknown
}

/** 生成诊断快照（不含任何敏感数据） */
export async function buildDiagnostics(): Promise<DiagnosticsSnapshot> {
  const cache = await cacheSummary()
  return {
    login: await loginAudit(),
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

/** 各平台必需 Cookie 的在场情况（只看名字，不看值） */
async function loginAudit(): Promise<DiagnosticsSnapshot['login']> {
  const states = getPlatformLoginStates()
  const out: DiagnosticsSnapshot['login'] = []
  for (const adapter of adapterRegistry.list()) {
    const required = adapter.login?.cookies ?? []
    if (!required.length) continue
    const sess = session.fromPartition(adapter.partition ?? `persist:platform-${adapter.id}`)
    let all: Electron.Cookie[] = []
    try {
      all = await sess.cookies.get({})
    } catch {
      all = []
    }
    const has = (name: string, domainIncludes: string): boolean =>
      all.some((c) => c.name === name && (c.domain ?? '').includes(domainIncludes))
    const present: string[] = []
    const missing: string[] = []
    for (const c of required) {
      // 同名 Cookie 可能有多条（不同域），去重只报一次
      const label = `${c.name}@${c.domainIncludes}`
      if (has(c.name, c.domainIncludes)) present.push(label)
      else missing.push(label)
    }
    out.push({
      platform: adapter.id,
      detected: states[adapter.id]?.loggedIn ?? false,
      present,
      missing
    })
  }
  return out
}

export function setupDiagnosticsIpc(): void {
  ipcMain.handle('diagnostics:snapshot', async () => buildDiagnostics())
}
