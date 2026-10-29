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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { caCertPath } from './certs'

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const CERT_CN = 'Reflow Local MITM CA'

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
      snapshot: data?.snapshot ?? null
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
  const enabled = regQuery('ProxyEnable') === '0x1'
  return {
    enabled,
    server: regQuery('ProxyServer'),
    override: regQuery('ProxyOverride')
  }
}

export function applyProxy(server: string): void {
  regSet('ProxyServer', 'REG_SZ', server)
  // 本机/内网地址不走代理，避免本地服务被自己拦住
  regSet('ProxyOverride', 'REG_SZ', '<local>;127.0.0.1;localhost')
  regSet('ProxyEnable', 'REG_DWORD', '1')
}

export function restoreProxy(snapshot: ProxySnapshot | null): void {
  if (!snapshot) {
    regSet('ProxyEnable', 'REG_DWORD', '0')
    return
  }
  if (snapshot.server) regSet('ProxyServer', 'REG_SZ', snapshot.server)
  if (snapshot.override) regSet('ProxyOverride', 'REG_SZ', snapshot.override)
  regSet('ProxyEnable', 'REG_DWORD', snapshot.enabled ? '1' : '0')
}

/** 证书是否已在「当前用户/受信任的根证书颁发机构」里 */
export function isCertInstalled(): boolean {
  try {
    const out = execFileSync('certutil', ['-user', '-store', 'Root'], {
      encoding: 'latin1', // 中文 Windows 输出是 GBK；这里只匹配 ASCII 的 CN
      windowsHide: true
    })
    return out.includes(CERT_CN)
  } catch {
    return false
  }
}

/** 安装 CA（当前用户，不需要管理员） */
export function installCert(): void {
  const path = caCertPath()
  if (!existsSync(path)) throw new Error(`CA 证书不存在：${path}`)
  execFileSync('certutil', ['-addstore', '-user', 'Root', path], {
    stdio: 'ignore',
    windowsHide: true
  })
}

/** 删除 CA（按 CN 删；重复删不报错） */
export function removeCert(): void {
  try {
    execFileSync('certutil', ['-delstore', '-user', 'Root', CERT_CN], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    /* 没装过 */
  }
}

/**
 * 启动兜底：上次退出时没还原（崩溃/断电）→ 立刻还原，避免用户整机断网。
 * @returns 是否执行过还原
 */
export function recoverIfNeeded(): boolean {
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
