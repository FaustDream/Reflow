/**
 * 工单 012/013/015：基于 Cookie 的平台登录态监听（原版京东/拼多多主进程同机制）。
 *
 * 对声明 `login` 描述符的适配器，监听其独立 partition 的 Cookie 变化：
 *   全部条件 Cookie 出现 → login；任一消失（移除/过期）→ logout。
 * 启动时做一次存量检查（persist 分区会保留上次会话）。
 *
 * 安全：Cookie 值仅取「用户标识类」（pin/unb），PDDAccessToken 这类令牌绝不上报。
 */
import { session, type Cookie } from 'electron'
import type { PlatformAdapter } from './adapter'
import type { PlatformEvent } from '../../shared/types'

interface WatchState {
  present: Set<string>
  loggedIn: boolean
}

export interface PlatformLoginSnapshot {
  loggedIn: boolean
  userId: string
  nickname: string
}

/**
 * 各平台最近一次的登录判定结果。
 *
 * 存在的理由：`watchCookieLogin` 在 `app.whenReady()` 里立刻做存量检查，
 * 那时主窗口往往还没创建 —— 登录事件发出去直接丢掉，渲染层就永远从「未登录」开始，
 * 于是「页面明明登录了、界面不认、不触发抓取」。
 * 渲染层启动时用这个快照补一次。
 */
const loginStates = new Map<string, PlatformLoginSnapshot>()

export function getPlatformLoginStates(): Record<string, PlatformLoginSnapshot> {
  return Object.fromEntries(loginStates)
}

const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export function watchCookieLogin(
  adapters: PlatformAdapter[],
  emit: (event: PlatformEvent) => void
): void {
  for (const adapter of adapters) {
    const login = adapter.login
    if (!login?.cookies.length) continue
    const partition = adapter.partition ?? `persist:platform-${adapter.id}`
    const sess = session.fromPartition(partition)
    const state: WatchState = { present: new Set(), loggedIn: false }
    loginStates.set(adapter.id, { loggedIn: false, userId: '', nickname: '' })

    const matches = (cookie: Cookie): boolean =>
      login.cookies.some(
        (c) => c.name === cookie.name && (cookie.domain ?? '').includes(c.domainIncludes)
      )

    const evaluate = (): void => {
      // any：任一 Cookie 出现即登录（京东新版只发 pinId/unick）；all：全部出现（默认）
      const allPresent =
        login.mode === 'any'
          ? login.cookies.some((c) => state.present.has(c.name))
          : login.cookies.every((c) => state.present.has(c.name))
      if (allPresent && !state.loggedIn) {
        state.loggedIn = true
        void sess.cookies.get({}).then((all) => {
          const get = (name?: string): string =>
            name ? all.find((c) => c.name === name)?.value ?? '' : ''
          const userId = get(login.userIdCookie)
          const nickname = safeDecode(get(login.nicknameCookie))
          loginStates.set(adapter.id, { loggedIn: true, userId, nickname })
          emit({
            platform: adapter.id,
            type: 'login',
            userId,
            nickname,
            ts: Date.now()
          })
        })
      } else if (!allPresent && state.loggedIn) {
        state.loggedIn = false
        loginStates.set(adapter.id, { loggedIn: false, userId: '', nickname: '' })
        emit({ platform: adapter.id, type: 'logout', ts: Date.now() })
      }
    }

    sess.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!matches(cookie)) return
      const expired =
        cookie.expirationDate !== undefined && cookie.expirationDate * 1000 < Date.now()
      if (removed || expired) {
        state.present.delete(cookie.name)
      } else {
        state.present.add(cookie.name)
      }
      evaluate()
    })

    // 存量会话检查（持久分区 + 应用重启场景）
    void sess.cookies
      .get({})
      .then((all) => {
        for (const c of login.cookies) {
          if (
            all.some((cookie) => cookie.name === c.name && (cookie.domain ?? '').includes(c.domainIncludes))
          ) {
            state.present.add(c.name)
          }
        }
        evaluate()
      })
      .catch(() => undefined)
  }
}
