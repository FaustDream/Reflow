import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AdapterSummary, PlatformEvent } from '@shared/types'

/** 单平台登录态（工单 006） */
export interface PlatformLoginState {
  loggedIn: boolean
  userId: string
  nickname: string
  avatarUrl: string
  /** 页面出现 #alibaba-login-box */
  needsLogin: boolean
}

const EMPTY_LOGIN: PlatformLoginState = {
  loggedIn: false,
  userId: '',
  nickname: '',
  avatarUrl: '',
  needsLogin: false
}

/**
 * 平台注册表 + 登录态的渲染层汇聚点。
 * 登录事件来自页面脚本（经页面官方 SDK 轮询，工单 006）。
 */
export const usePlatformsStore = defineStore('platforms', () => {
  const adapters = ref<AdapterSummary[]>([])
  const loginByPlatform = ref<Record<string, PlatformLoginState>>({})
  const initialized = ref(false)

  const platformAdapters = computed(() => adapters.value)

  function loginOf(platform: string): PlatformLoginState {
    return loginByPlatform.value[platform] ?? EMPTY_LOGIN
  }

  function init(): void {
    if (initialized.value) return
    initialized.value = true

    window.api.onPlatformEvent((payload: PlatformEvent) => {
      applyEvent(payload)
    })
    void window.api.getAdapters().then((list) => {
      adapters.value = list
    })
    // 启动时补一次快照：主进程做存量 Cookie 检查时窗口可能还没建好，
    // 那次 login 事件会丢 —— 不补的话界面永远从「未登录」开始，也就不会触发抓取。
    void window.api
      .getPlatformLoginStates()
      .then((states) => {
        const next: Record<string, PlatformLoginState> = { ...loginByPlatform.value }
        for (const [platform, s] of Object.entries(states)) {
          // 期间若已有实时事件到达，以事件为准
          if (next[platform]?.loggedIn) continue
          next[platform] = {
            ...EMPTY_LOGIN,
            loggedIn: s.loggedIn,
            userId: s.userId,
            nickname: s.nickname
          }
        }
        loginByPlatform.value = next
      })
      .catch(() => undefined)
  }

  function applyEvent(payload: PlatformEvent): void {
    const current = loginOf(payload.platform)
    if (payload.type === 'login') {
      loginByPlatform.value = {
        ...loginByPlatform.value,
        [payload.platform]: {
          loggedIn: true,
          userId: payload.userId ?? current.userId,
          nickname: payload.nickname ?? '',
          avatarUrl: payload.avatarUrl ?? '',
          needsLogin: false
        }
      }
    } else if (payload.type === 'logout') {
      loginByPlatform.value = {
        ...loginByPlatform.value,
        [payload.platform]: { ...EMPTY_LOGIN }
      }
    } else if (payload.type === 'login-required') {
      // 页面自己跳到登录页：只标记「需要登录」，不推翻 Cookie 判定。
      // （推翻会引出「重新登录后 Cookie 变化不再触发 login 事件」的新问题）
      loginByPlatform.value = {
        ...loginByPlatform.value,
        [payload.platform]: { ...current, needsLogin: true }
      }
    }
  }

  return { adapters, platformAdapters, loginByPlatform, loginOf, init }
})
