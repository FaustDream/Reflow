/**
 * 工单 021：多账号聚合的账号模型与存储。
 *
 * 核心设计：**账号 = 平台 + 槽位（slot）**，每个槽位一个独立的 Electron session partition。
 * 这样同一平台的两个账号 Cookie 天然隔离，互不覆盖。
 *
 * partition 命名（兼容既有单账号数据）：
 * - slot 0 → `persist:platform-<id>`      ← 历史数据沿用此分区，升级后不丢登录态
 * - slot N → `persist:platform-<id>-<N>`  ← 第 2 个及之后的账号
 *
 * 账号身份**被动获取**（工单要求）：不主动调用户接口，而是从订单响应的
 * `userId`/`nickname` 字段里读出来（各适配器 parse() 已返回 account）。
 * 拿不到昵称时降级显示 userId，并允许用户自定义备注名。
 */
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Account {
  /** 稳定标识：`<platform>#<slot>` */
  id: string
  platform: string
  /** 槽位，0 起；决定 partition */
  slot: number
  /** 用户可编辑的备注名（空则回退 nickname → userId → "账号 N"） */
  label: string
  /** 被动获取到的平台用户 id */
  userId: string
  /** 被动获取到的昵称 */
  nickname: string
  createdAt: number
}

interface AccountsFile {
  version: number
  accounts: Account[]
}

const VERSION = 1

export function accountId(platform: string, slot: number): string {
  return `${platform}#${slot}`
}

/** 平台 + 槽位 → session partition */
export function partitionFor(platform: string, slot: number): string {
  return slot === 0 ? `persist:platform-${platform}` : `persist:platform-${platform}-${slot}`
}

/** 账号展示名：备注名 > 昵称 > userId > 「账号 N」 */
export function displayNameOf(account: Account): string {
  if (account.label) return account.label
  if (account.nickname) return account.nickname
  if (account.userId) return account.userId
  return `账号 ${account.slot + 1}`
}

function filePath(): string {
  return join(app.getPath('userData'), 'accounts.json')
}

/** 读全部账号；文件不存在/损坏时返回空表 */
export async function loadAccounts(): Promise<Account[]> {
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const data = JSON.parse(raw) as AccountsFile
    if (data?.version !== VERSION || !Array.isArray(data.accounts)) return []
    return data.accounts
  } catch {
    return []
  }
}

/** 原子写入 */
export async function saveAccounts(accounts: Account[]): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  const target = filePath()
  const tmp = `${target}.tmp`
  const payload: AccountsFile = { version: VERSION, accounts }
  await writeFile(tmp, JSON.stringify(payload, null, 1), 'utf-8')
  await rename(tmp, target)
}

/**
 * 确保某平台至少有 slot 0 账号（首次使用/升级自单账号版本时自动创建）。
 * 返回补全后的完整账号表。
 */
export function ensureDefaultAccount(accounts: Account[], platform: string): Account[] {
  if (accounts.some((a) => a.platform === platform)) return accounts
  return [
    ...accounts,
    {
      id: accountId(platform, 0),
      platform,
      slot: 0,
      label: '',
      userId: '',
      nickname: '',
      createdAt: Date.now()
    }
  ]
}

/** 取某平台的下一个可用槽位 */
export function nextSlot(accounts: Account[], platform: string): number {
  const used = accounts.filter((a) => a.platform === platform).map((a) => a.slot)
  return used.length ? Math.max(...used) + 1 : 0
}
