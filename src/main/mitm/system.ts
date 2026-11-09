/**
 * MITM 的系统级改动：系统代理（HKCU）+ 根证书（当前用户存储）+ 崩溃兜底状态。
 *
 * 全部只用**当前用户**范围，不需要管理员、不弹 UAC：
 * - 代理：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`（WinINET）
 * - 证书：`certutil -addstore -user Root`（当前用户「受信任的根证书颁发机构」）
 *
 * 关键约束（docs/033 §4）：
 * 1. 改动前**先快照**原代理设置，还原时逐字段写回（用户可能本来就有公司代理）
 * 2. 状态落盘，启动时若发现「上次没还原」→ 自动还原（否则用户会断网）
 * 3. 退出前必须还原（`before-quit` 里同步执行）
 */
import { app } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const CERT_CN = 'Reflow Local MITM CA'

/**
 * 当前平台是否支持「系统代理 + 根证书」这套改动。
 *
 * 只有 Windows 实现，且全部落在当前用户范围（HKCU / certutil -user），不需要管理员。
 * macOS（networksetup / security add-trusted-cert）与 Linux（update-ca-certificates、NSS）
 * 都需要提权或改系统库，与本项目「不装根证书到系统、不要管理员权限」的硬约束冲突，
 * 因此这两个平台直接判定为不支持 —— 默认的 WebView 注入通道不受影响，
 * 只是少一条可选的 MITM 通道。
 */
export function mitmSupported(): boolean {
  return process.platform === 'win32'
}

export interface ProxySnapshot {
  enabled: boolean
  server: string
  override: string
}

export interface MitmState {
  /** 上次是否处于「已开启」状态（用于崩溃兜底） */
  enabled: boolean
  port: number
  snapshot: ProxySnapshot | null
  /** CA 证书指纹（cert-gen 写入；isCertInstalled 按它校验，避免同名 CA 误判） */
  caThumbprint?: string
  /** 叶子证书 sha256 指纹（cert-gen 写入，用于检测文件被换掉） */
  leafFingerprint?: string
  /** 生成叶子证书时的 SAN 域名快照（白名单变化时触发重签） */
  sanHosts?: string[]
}

const EMPTY_STATE: MitmState = { enabled: false, port: 8899, snapshot: null }

function statePath(): string {
  return join(app.getPath('userData'), 'mitm-state.json')
}

export function loadState(): MitmState {
  try {
    const data = JSON.parse(readFileSync(statePath(), 'utf-8')) as MitmState
    return {
      enabled: Boolean(data?.enabled),
      port: Number(data?.port) || 8899,
      snapshot: data?.snapshot ?? null,
      caThumbprint: data?.caThumbprint,
      leafFingerprint: data?.leafFingerprint,
      sanHosts: Array.isArray(data?.sanHosts) ? data.sanHosts : undefined
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

export function saveState(state: MitmState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 1), 'utf-8')
  } catch {
    /* 写不进去不影响本次会话 */
  }
}

/** 读注册表字符串值（reg query 的输出按行解析） */
function regQuery(value: string): string {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', value], {
      encoding: 'utf-8',
      windowsHide: true
    })
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(value))
    if (!line) return ''
    return line.trim().split(/\s{2,}/).slice(-1)[0]?.trim() ?? ''
  } catch {
    return ''
  }
}

function regSet(value: string, type: 'REG_DWORD' | 'REG_SZ', data: string): void {
  execFileSync('reg', ['add', REG_KEY, '/v', value, '/t', type, '/d', data, '/f'], {
    stdio: 'ignore',
    windowsHide: true
  })
}

export function readProxy(): ProxySnapshot {
  if (!mitmSupported()) return { enabled: false, server: '', override: '' }
  const enabled = regQuery('ProxyEnable') === '0x1'
  return {
    enabled,
    server: regQuery('ProxyServer'),
    override: regQuery('ProxyOverride')
  }
}

export function applyProxy(server: string): void {
  if (!mitmSupported()) {
    throw new Error('当前平台不支持修改系统代理（仅 Windows 支持）')
  }
  regSet('ProxyServer', 'REG_SZ', server)
  // 本机/内网地址不走代理，避免本地服务被自己拦住
  regSet('ProxyOverride', 'REG_SZ', '<local>;127.0.0.1;localhost')
  regSet('ProxyEnable', 'REG_DWORD', '1')
}

export function restoreProxy(snapshot: ProxySnapshot | null): void {
  if (!mitmSupported()) return
  if (!snapshot) {
    regSet('ProxyEnable', 'REG_DWORD', '0')
    return
  }
  if (snapshot.server) regSet('ProxyServer', 'REG_SZ', snapshot.server)
  if (snapshot.override) regSet('ProxyOverride', 'REG_SZ', snapshot.override)
  regSet('ProxyEnable', 'REG_DWORD', snapshot.enabled ? '1' : '0')
}

/**
 * certutil 一律异步 + 超时强杀。**绝不能在主进程上同步执行 certutil**：
 * 实测 `certutil -delstore` 可能无限期挂起（可疑证书状态/存储锁），同步调用会
 * 把主进程事件循环整个堵死——窗口冻结、CDP/IPC 全部失效，只能杀进程。
 */
function runCertutil(args: string[], timeoutMs = CERTUTIL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'certutil',
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout ?? ''))
      }
    )
  })
}

const CERTUTIL_TIMEOUT_MS = 20_000

/** 证书是否已在「当前用户/受信任的根证书颁发机构」里。
 *  优先按 cert-gen 记录的 CA 指纹校验（同名 CA 不算数）；无指纹记录时退回 CN 匹配。
 *  certutil 的指纹输出带空格分隔（`95 8a cc …`），比对前要去掉全部空白 */
export async function isCertInstalled(): Promise<boolean> {
  if (!mitmSupported()) return false
  try {
    const out = await runCertutil(['-user', '-store', 'Root'])
    const { caThumbprint } = loadState()
    if (caThumbprint) {
      // certutil 输出的是小写 hex，PS 的 Thumbprint 是大写——统一大写后比对
      return out.replace(/\s+/g, '').toUpperCase().includes(caThumbprint.toUpperCase())
    }
    return out.includes(CERT_CN)
  } catch {
    return false
  }
}

/**
 * 安装 CA（当前用户，不需要管理员）。路径由调用方提供（来自 cert-gen，避免循环依赖）。
 * 先按 CN 清掉旧 CA 再装：历史版本的构建期共享 CA（leaf.key 已随包泄露）必须从
 * 用户机器上移除，同 CN 的旧条目也会一并清掉，避免 Root 库里积累重复 CA。
 * 清理是尽力而为：它挂起/失败不阻断新 CA 安装。
 */
export async function installCert(caPath: string): Promise<void> {
  if (!mitmSupported()) {
    throw new Error('当前平台不支持自动安装根证书（仅 Windows 支持）')
  }
  try {
    await runCertutil(['-delstore', '-user', 'Root', CERT_CN], 15_000)
  } catch {
    /* 没装过旧 CA / 清理超时——不阻断 */
  }
  await runCertutil(['-addstore', '-user', 'Root', caPath])
}

/** 删除 CA（按 CN 删；重复删不报错） */
export async function removeCert(): Promise<void> {
  if (!mitmSupported()) return
  try {
    await runCertutil(['-delstore', '-user', 'Root', CERT_CN])
  } catch {
    /* 没装过 */
  }
}

/**
 * 启动兜底：上次退出时没还原（崩溃/断电）→ 立刻还原，避免用户整机断网。
 * @returns 是否执行过还原
 */
export function recoverIfNeeded(): boolean {
  if (!mitmSupported()) return false
  const state = loadState()
  if (!state.enabled) return false
  try {
    restoreProxy(state.snapshot)
    saveState({ ...state, enabled: false })
    return true
  } catch {
    return false
  }
}
