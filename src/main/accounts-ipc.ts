/**
 * 工单 021：多账号聚合 IPC。
 *
 * 关键职责：
 * 1. 账号增删改查（每个账号一个 partition）
 * 2. **被动识别账号**：订单响应到达时，把响应里的 userId/nickname 写回账号档案
 * 3. 账号切换时清理该槽位的 Cookie（原版 PDD accountLogout 的等价做法）
 *
 * 订单与账号的绑定由「当前活动账号」决定：webview 以哪个槽位的 partition 运行，
 * 它捕获的订单就归该账号。适配器 parse() 返回的 account 字段用于**校验/补全**身份，
 * 不用于路由（路由靠 partition，更可靠）。
 */
import { ipcMain, session, type BrowserWindow } from 'electron'
import type { OrdersCapturedEvent } from '../shared/types'
import {
  accountId,
  displayNameOf,
  ensureDefaultAccount,
  loadAccounts,
  nextSlot,
  partitionFor,
  saveAccounts,
  type Account
} from './accounts'

/** 每个平台当前活动槽位（webview 用哪个 partition 由它决定） */
const activeSlot = new Map<string, number>()

/** 已加载的账号表（内存副本，写入即落盘） */
let cache: Account[] | null = null

async function accounts(): Promise<Account[]> {
  if (!cache) cache = await loadAccounts()
  return cache
}

async function persist(next: Account[]): Promise<void> {
  cache = next
  await saveAccounts(next)
}

/**
 * 供其他模块查询：某平台当前活动账号的 partition。
 *
 * 2026-10-26 起**单账号模式**：固定 slot 0（`persist:platform-<id>`），不再读 activeSlot。
 * 原因（真实故障）：`watchCookieLogin` 监听的是适配器固定的 `persist:platform-<id>`，
 * 而这里若返回 `persist:platform-<id>-<slot>`，扫码登录写进的分区与登录态监听的分区不是同一个，
 * 于是「扫码成功但界面永远显示未登录」= 用户说的「京东登录没反应」。
 * 另外 activeSlot 只在内存里，重启归零，webview 又会切回 slot 0，登录态凭空消失。
 */
export function activePartition(platform: string): string {
  return partitionFor(platform, 0)
}

/** 供其他模块查询：某平台当前活动账号 id（单账号模式固定 slot 0） */
export function activeAccountId(platform: string): string {
  return accountId(platform, 0)
}

export interface AccountsIpcOptions {
  getMainWindow: () => BrowserWindow | null
}

export function setupAccountsIpc(_options: AccountsIpcOptions): void {
  const forward = (channel: string, payload: unknown): void => {
    const win = _options.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /** 列出全部账号（含展示名、当前是否活动） */
  ipcMain.handle('accounts:list', async () => {
    const list = await accounts()
    return list.map((a) => ({
      ...a,
      displayName: displayNameOf(a),
      partition: partitionFor(a.platform, a.slot),
      active: (activeSlot.get(a.platform) ?? 0) === a.slot
    }))
  })

  /** 确保平台有默认账号（首次进入该平台时调用） */
  ipcMain.handle('accounts:ensure', async (_event, platform: string) => {
    const list = ensureDefaultAccount(await accounts(), platform)
    if (list !== cache) await persist(list)
    return { ok: true }
  })

  /** 新增账号：分配下一个槽位（新的空 partition，用户扫码登录即可） */
  ipcMain.handle('accounts:add', async (_event, platform: string) => {
    const list = await accounts()
    const slot = nextSlot(list, platform)
    const account: Account = {
      id: accountId(platform, slot),
      platform,
      slot,
      label: '',
      userId: '',
      nickname: '',
      createdAt: Date.now()
    }
    await persist([...list, account])
    return {
      ok: true,
      account: { ...account, displayName: displayNameOf(account), partition: partitionFor(platform, slot) }
    }
  })

  /** 切换活动账号 */
  ipcMain.handle('accounts:activate', async (_event, id: string) => {
    const list = await accounts()
    const target = list.find((a) => a.id === id)
    if (!target) return { ok: false, message: '账号不存在' }
    activeSlot.set(target.platform, target.slot)
    forward('accounts:changed', { platform: target.platform, accountId: target.id })
    return { ok: true, partition: partitionFor(target.platform, target.slot) }
  })

  /** 重命名（用户自定义备注） */
  ipcMain.handle('accounts:rename', async (_event, payload: { id: string; label: string }) => {
    const list = await accounts()
    const next = list.map((a) =>
      a.id === payload.id ? { ...a, label: String(payload.label ?? '').slice(0, 40) } : a
    )
    await persist(next)
    return { ok: true }
  })

  /** 删除账号（连同其 partition 的 Cookie） */
  ipcMain.handle('accounts:remove', async (_event, id: string) => {
    const list = await accounts()
    const target = list.find((a) => a.id === id)
    if (!target) return { ok: false, message: '账号不存在' }
    // 不允许删掉平台最后一个账号（否则该平台无可用槽位）
    const siblings = list.filter((a) => a.platform === target.platform)
    if (siblings.length <= 1) {
      return { ok: false, message: '每个平台至少保留一个账号' }
    }
    await persist(list.filter((a) => a.id !== id))
    // 清理该槽位会话（退出登录 + 清 Cookie）
    const partition = partitionFor(target.platform, target.slot)
    await session.fromPartition(partition).clearStorageData().catch(() => undefined)
    if ((activeSlot.get(target.platform) ?? 0) === target.slot) {
      const fallback = siblings.find((a) => a.id !== id)
      if (fallback) activeSlot.set(target.platform, fallback.slot)
    }
    forward('accounts:changed', { platform: target.platform, accountId: '' })
    return { ok: true }
  })

  /** 退出某账号（清 Cookie，保留账号条目） */
  ipcMain.handle('accounts:logout', async (_event, id: string) => {
    const list = await accounts()
    const target = list.find((a) => a.id === id)
    if (!target) return { ok: false, message: '账号不存在' }
    const partition = partitionFor(target.platform, target.slot)
    await session.fromPartition(partition).clearStorageData().catch(() => undefined)
    // 清掉被动获取的身份（下次捕获会重新填）
    const next = list.map((a) => (a.id === id ? { ...a, userId: '', nickname: '' } : a))
    await persist(next)
    forward('accounts:changed', { platform: target.platform, accountId: '' })
    return { ok: true }
  })

  /**
   * 单账号模式：退出当前平台。
   * 清空该平台分区（slot 0）的全部存储，等价原版京东的
   * `clearStorageData({ storages: ['cookies'] })`。
   */
  ipcMain.handle('platform:logout', async (_event, platform: string) => {
    const partition = partitionFor(platform, 0)
    await session.fromPartition(partition).clearStorageData().catch(() => undefined)
    forward('platform:event', { platform, type: 'logout', ts: Date.now() })
    return { ok: true }
  })

  /**
   * 被动识别账号：订单响应里带 userId/nickname 时，补全当前活动账号档案。
   * 由 capture 引擎侧调用（见 capture-bridge）。
   */
  ipcMain.on('accounts:note-identity', async (_event, payload: OrdersCapturedEvent) => {
    const identity = payload.account
    if (!identity?.userId) return
    const platform = payload.platform
    const list = await accounts()
    const slot = activeSlot.get(platform) ?? 0
    const id = accountId(platform, slot)
    const target = list.find((a) => a.id === id)
    if (!target) {
      // 平台还没有账号条目（可能是直接打开页面就捕获了）：补建
      const created: Account = {
        id,
        platform,
        slot,
        label: '',
        userId: identity.userId,
        nickname: identity.nickname ?? '',
        createdAt: Date.now()
      }
      await persist([...list, created])
      forward('accounts:changed', { platform, accountId: id })
      return
    }
    // 身份没变就不写盘（避免每次捕获都触发写）
    if (target.userId === identity.userId && target.nickname === (identity.nickname ?? target.nickname)) {
      return
    }
    const next = list.map((a) =>
      a.id === id
        ? { ...a, userId: identity.userId, nickname: identity.nickname ?? a.nickname }
        : a
    )
    await persist(next)
    forward('accounts:changed', { platform, accountId: id })
  })
}
