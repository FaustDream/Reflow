import { defineStore } from 'pinia'
import { ref } from 'vue'
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

  /**
   * 接口判定「登录态已失效」时，把界面标记改回未登录（2026-11-02）。
   *
   * 原来 Cookie 还在（unb/pin 这类长期 Cookie）就一直显示「已登录」，
   * 但真实会话其实已经废了 —— 用户点一次抓取失败，界面还写着已登录，
   * 于是反复点、反复弹「登录已失效」。标记诚实了，用户才会去扫码。
   */
  function markLoggedOut(platform: string): void {
    loginByPlatform.value = { ...loginByPlatform.value, [platform]: { ...EMPTY_LOGIN } }
  }

  /** 抓取成功 = 会话确实可用：把标记补回已登录（不覆盖已有的昵称/ID） */
  function markLoggedIn(platform: string): void {
    const current = loginOf(platform)
    if (current.loggedIn) return
    loginByPlatform.value = {
      ...loginByPlatform.value,
      [platform]: { ...current, loggedIn: true, needsLogin: false }
    }
  }

  return { adapters, loginByPlatform, loginOf, init, markLoggedOut, markLoggedIn }
})
