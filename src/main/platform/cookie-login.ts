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
import { info, warn } from '../logging/logger'

/**
 * 把会话级登录 Cookie 改写成持久 Cookie（180 天）。
 *
 * 背景：Electron 只把带 Expires 的 Cookie 落盘，会话级 Cookie 随进程退出消失，
 * 且不会像浏览器那样做 session restore。淘宝的 `unb` 就是会话级 —— 表现为
 * 「每次启动都要重新扫码」，而掉线期间的新单是静默丢失的。
 *
 * 只改**本地过期时间**：值、domain、path、安全属性原样保留，服务端不看这个字段。
 * 已经是持久 Cookie 的跳过，不重复改写。
 *
 * @returns 实际改写成功的 Cookie 名（供日志与调用方判断）
 */
export async function persistSessionCookies(
  sess: Electron.Session,
  names: string[] | undefined,
  days = 180
): Promise<string[]> {
  if (!names?.length) return []
  const all = await sess.cookies.get({})
  const deadline = Math.floor(Date.now() / 1000) + days * 86_400
  const done: string[] = []

  for (const name of names) {
    for (const c of all) {
      if (c.name !== name) continue
      if (c.expirationDate !== undefined) continue // 已是持久 Cookie
      const host = (c.domain ?? '').replace(/^\./, '')
      if (!host) continue
      try {
        await sess.cookies.set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: deadline
        })
        done.push(name)
      } catch (e) {
        // 个别 Cookie 带 Chromium 不接受的属性组合（如 partitioned）会拒绝写入，
        // 失败不该阻断登录流程本身
        warn('login:persist', '会话 Cookie 改写失败', {
          cookie: name,
          domain: c.domain,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }
  return done
}

/**
 * 把分区里所有会话级 Cookie 改写为持久。
 *
 * 用于 `login.persistAllSession`：淘宝这类平台的会话由多个无 Expires 的
 * Cookie 共同构成（`sca` / `tbsa` / `_samesite_flag_` …），只保住几个关键项，
 * 重启后服务端仍判会话失效。
 */
export async function persistAllSessionCookies(
  sess: Electron.Session,
  days = 180
): Promise<string[]> {
  const all = await sess.cookies.get({})
  const names = [
    ...new Set(
      all.filter((c) => c.name && c.expirationDate === undefined).map((c) => c.name)
    )
  ]
  if (!names.length) return []
  return persistSessionCookies(sess, names, days)
}

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

/**
 * 昵称 Cookie 解码。
 *
 * 淘宝把昵称存成 `%5Cu58A8%5Cu8FF9%5Cu9519%5Cu54AF%5Cu548C` ——
 * 先 URL 解码得到 `\u58A8\u8FF9…` 这样的**字面量**，再按 Unicode 转义还原才是中文。
 * 只做 decodeURIComponent 的话，界面上会显示成一串 `\u58A8…`，看着就像「没有昵称」。
 */
const decodeEscapedUnicode = (v: string): string =>
  v.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )

export const decodeNickname = (v: string): string => {
  if (!v) return ''
  let out = v
  try {
    out = decodeURIComponent(out)
  } catch {
    // 不是合法的百分号编码，保留原值
  }
  return decodeEscapedUnicode(out)
}

/** 按顺序取第一个非空的昵称 Cookie */
const pickNickname = (
  all: Array<{ name: string; value: string }>,
  names: string[] | undefined
): string => {
  if (!names?.length) return ''
  for (const name of names) {
    const hit = all.find((c) => c.name === name)?.value
    if (hit) return decodeNickname(hit)
  }
  return ''
}

export function watchCookieLogin(
  adapters: PlatformAdapter[],
  emit: (event: PlatformEvent) => void
): void {
  // 同一 partition 只挂一个监听：美团有两个适配器（meituan / meituan-platform）声明了
  // 同一个 persist:platform-meituan 分区，各挂一份 watcher 会把登录事件上报两次、
  // 并维护两份互不知晓的 loginStates
  const watchedPartitions = new Set<string>()
  for (const adapter of adapters) {
    const login = adapter.login
    if (!login?.cookies.length) continue
    const partition = adapter.partition ?? `persist:platform-${adapter.id}`
    if (watchedPartitions.has(partition)) continue
    watchedPartitions.add(partition)
    const sess = session.fromPartition(partition)
    const state: WatchState = { present: new Set(), loggedIn: false }
    const persistAll = login.persistAllSession === true
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
          const nickname = pickNickname(all, login.nicknameCookies)
          loginStates.set(adapter.id, { loggedIn: true, userId, nickname })
          emit({
            platform: adapter.id,
            type: 'login',
            userId,
            nickname,
            ts: Date.now()
          })
          // 会话级 Cookie 落盘：否则关掉应用就掉登录（淘宝 unb 就是这样丢的）。
          // 全量平台连 sca / tbsa 一起收，少一个服务端就判会话失效。
          void (persistAll
            ? persistAllSessionCookies(sess)
            : persistSessionCookies(sess, login.persistCookies)
          ).then((done) => {
            if (!done.length) return
            info('login:persist', '已把会话级登录 Cookie 改写为持久', {
              platform: adapter.id,
              names: done
            })
          })
        })
      } else if (!allPresent && state.loggedIn) {
        state.loggedIn = false
        loginStates.set(adapter.id, { loggedIn: false, userId: '', nickname: '' })
        emit({ platform: adapter.id, type: 'logout', ts: Date.now() })
      }
    }

    /**
     * 会话级登录 Cookie 持续落盘（2026-11-11）。
     *
     * 只在「登录判定成功那一刻」写一次是不够的：`cookie2` / `_tb_token_` 是
     * 登录跳转**之后**才下发（且会被反复重发），那一刻还拿不到，于是关掉应用
     * 依旧掉登录。改成监听变化、只要出现名单内的会话级 Cookie 就改写为持久。
     *
     * 改写后的 Cookie 带 `expirationDate`，`persistSessionCookies` 会直接跳过，
     * 所以自身触发的 changed 不会再排一次，不会打转。
     */
    const persistTargets = new Set(login.persistCookies ?? [])
    const pendingPersist = new Set<string>()
    const shouldPersist = (cookie: Cookie): boolean =>
      persistAll || persistTargets.has(cookie.name)

    const schedulePersist = (cookie: Cookie): void => {
      if (!shouldPersist(cookie)) return
      if (cookie.expirationDate !== undefined) return
      if (pendingPersist.has(cookie.name)) return
      pendingPersist.add(cookie.name)
      // 登录跳转会连发同一批 Cookie，等它们落齐再改写，避免写一半被覆盖
      setTimeout(() => {
        pendingPersist.delete(cookie.name)
        void persistSessionCookies(sess, [cookie.name]).then((done) => {
          if (!done.length) return
          info('login:persist', '会话级登录 Cookie 已落盘', {
            platform: adapter.id,
            names: done
          })
        })
      }, 1200)
    }

    sess.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!matches(cookie) && !shouldPersist(cookie)) return
      const expired =
        cookie.expirationDate !== undefined && cookie.expirationDate * 1000 < Date.now()
      if (removed || expired) {
        state.present.delete(cookie.name)
      } else {
        state.present.add(cookie.name)
        schedulePersist(cookie)
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
        // 全量落盘平台：启动时把分区里现存的会话级 Cookie 一次补齐，
        // 覆盖「升级到本版本之前就已登录」的会话（否则要等它自然变化才落盘）
        if (persistAll) {
          void persistAllSessionCookies(sess).then((done) => {
            if (!done.length) return
            info('login:persist', '启动时补齐会话级 Cookie', {
              platform: adapter.id,
              names: done
            })
          })
        }
      })
      .catch(() => undefined)
  }
}
