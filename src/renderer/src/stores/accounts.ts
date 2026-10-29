import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/** 账号（工单 021）。展示名已由主进程算好（备注 > 昵称 > userId > 账号 N） */
export interface AccountRow {
  id: string
  platform: string
  slot: number
  label: string
  userId: string
  nickname: string
  displayName: string
  partition: string
  active: boolean
  createdAt: number
}

/**
 * 多账号状态。每平台可有多账号，各账号独立 session partition，
 * 订单按 `platform|account|orderId` 去重与归档。
 */
export const useAccountsStore = defineStore('accounts', () => {
  const list = ref<AccountRow[]>([])
  const initialized = ref(false)

  const byPlatform = computed(() => {
    const map: Record<string, AccountRow[]> = {}
    for (const a of list.value) {
      ;(map[a.platform] ??= []).push(a)
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => a.slot - b.slot)
    }
    return map
  })

  function accountsOf(platform: string): AccountRow[] {
    return byPlatform.value[platform] ?? []
  }

  function activeOf(platform: string): AccountRow | null {
    return accountsOf(platform).find((a) => a.active) ?? accountsOf(platform)[0] ?? null
  }

  async function refresh(): Promise<void> {
    list.value = await window.api.listAccounts()
  }

  async function init(): Promise<void> {
    if (initialized.value) return
    initialized.value = true
    await refresh()
    window.api.onAccountsChanged(() => {
      void refresh()
    })
  }

  /** 首次进入某平台时确保有默认账号 */
  async function ensure(platform: string): Promise<void> {
    if (accountsOf(platform).length) return
    await window.api.ensureAccount(platform)
    await refresh()
  }

  async function add(platform: string): Promise<AccountRow | null> {
    const result = await window.api.addAccount(platform)
    await refresh()
    if (!result.ok) return null
    const created = result.account as AccountRow | undefined
    if (created) {
      // 新增后自动切换过去（用户下一步就是给它扫码登录）
      await activate(created.id)
    }
    return accountsOf(platform).find((a) => a.id === created?.id) ?? null
  }

  async function activate(id: string): Promise<void> {
    await window.api.activateAccount(id)
    await refresh()
  }

  async function rename(id: string, label: string): Promise<void> {
    await window.api.renameAccount(id, label)
    await refresh()
  }

  async function remove(id: string): Promise<{ ok: boolean; message?: string }> {
    const result = await window.api.removeAccount(id)
    await refresh()
    return result
  }

  async function logout(id: string): Promise<{ ok: boolean; message?: string }> {
    const result = await window.api.logoutAccount(id)
    await refresh()
    return result
  }

  return {
    list,
    byPlatform,
    accountsOf,
    activeOf,
    init,
    refresh,
    ensure,
    add,
    activate,
    rename,
    remove,
    logout
  }
})
