/**
 * 工单 006：闲鱼页面主世界脚本（自包含函数，经 toString() 序列化注入）。
 *
 * 职责（复刻原版 webview-preload.cjs 的 checkLogin 逻辑，通道改为 postMessage+nonce）：
 *  1. 轮询页面官方 SDK `window.lib.mtop.request` 调 `mtop.taobao.idlemessage.pc.loginuser.get`
 *     取 userId —— 登录成功即上报并转入慢速轮询（检测登出/会话过期）
 *  2. 登录成功后调 `mtop.idle.web.user.page.nav` 取昵称/头像
 *  3. 观察页面登录框 `#alibaba-login-box`，出现即上报「需要登录」
 *
 * 决策 D-2：sign 全部由页面官方 SDK 计算，本脚本不自行构造任何带签名请求。
 * ⚠ 本函数必须自包含：不得引用任何 import / 模块级变量 / 闭包外部标识符。
 */

export function installXianyuPageScript(nonce: string): void {
  const w = window as unknown as Record<string, unknown>
  if (w.__reflowXianyuInstalled) return
  w.__reflowXianyuInstalled = true

  // 自护卫：只在闲鱼域执行（inject 会对所有 webview 注入全部平台脚本）
  if (!/(^|\.)goofish\.com$/.test(location.hostname)) return

  const report = (payload: Record<string, unknown>): void => {
    try {
      window.postMessage({ __reflowPlatform: nonce, payload }, '*')
    } catch {
      /* 页面卸载时 postMessage 可能抛错，忽略 */
    }
  }

  const LOGIN_USER_API = 'mtop.taobao.idlemessage.pc.loginuser.get'
  const USER_NAV_API = 'mtop.idle.web.user.page.nav'
  const MTOP_BASE = {
    v: '1.0',
    type: 'POST',
    appKey: '34839810',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: 20000,
    needLoginPC: false,
    showErrorToast: false,
    valueType: 'string',
    needLogin: false,
    sessionOption: 'AutoLoginOnly',
    ecode: 0
  }

  const waitForMtop = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const check = (): void => {
        const request = (window as unknown as { lib?: { mtop?: { request?: unknown } } }).lib?.mtop
          ?.request
        if (typeof request === 'function') {
          resolve()
          return
        }
        if (Date.now() - startedAt >= 20000) {
          reject(new Error('window.lib.mtop.request 不存在（页面 SDK 未就绪）'))
          return
        }
        setTimeout(check, 200)
      }
      check()
    })

  const mtopRequest = (api: string, data: Record<string, unknown>): Promise<unknown> =>
    waitForMtop().then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const request = (window as unknown as { lib?: { mtop?: { request?: unknown } } }).lib?.mtop
            ?.request as
            | ((
                o: Record<string, unknown>,
                ok: (r: unknown) => void,
                err: (e: unknown) => void
              ) => unknown)
            | undefined
          if (typeof request !== 'function') {
            reject(new Error('window.lib.mtop.request 不存在'))
            return
          }
          try {
            const maybe = request({ ...MTOP_BASE, api, data }, resolve, reject)
            if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
              ;(maybe as Promise<unknown>).then(resolve).catch(reject)
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
    )

  let loggedIn = false
  let loginRequiredReported = false
  let checking = false

  const notifyLoginRequiredIfVisible = (): void => {
    if (loginRequiredReported || loggedIn) return
    if (document.querySelector('#alibaba-login-box')) {
      loginRequiredReported = true
      report({ platform: 'xianyu', type: 'login-required', ts: Date.now() })
    }
  }

  const checkLogin = async (): Promise<void> => {
    if (checking) return
    checking = true
    try {
      const resp = (await mtopRequest(LOGIN_USER_API, {})) as { data?: { userId?: unknown } } | null
      const userId = resp?.data?.userId
      if (userId) {
        loggedIn = true
        loginRequiredReported = false
        let nickname = ''
        let avatarUrl = ''
        try {
          const nav = (await mtopRequest(USER_NAV_API, {})) as {
            data?: { module?: { base?: { displayName?: unknown; avatar?: unknown } } }
          } | null
          nickname = String(nav?.data?.module?.base?.displayName ?? '')
          avatarUrl = String(nav?.data?.module?.base?.avatar ?? '')
        } catch {
          /* 昵称/头像属增强信息，取不到不阻塞登录态 */
        }
        report({
          platform: 'xianyu',
          type: 'login',
          userId: String(userId),
          nickname,
          avatarUrl,
          ts: Date.now()
        })
      } else if (loggedIn) {
        loggedIn = false
        report({ platform: 'xianyu', type: 'logout', ts: Date.now() })
      } else {
        notifyLoginRequiredIfVisible()
      }
    } catch {
      if (!loggedIn) notifyLoginRequiredIfVisible()
    } finally {
      checking = false
    }
  }

  const loop = (): void => {
    void checkLogin().finally(() => {
      setTimeout(loop, loggedIn ? 10000 : 1500)
    })
  }
  loop()

  // 登录框可能在两次轮询之间弹出，用 MutationObserver 即时补捉
  const observer = new MutationObserver(() => notifyLoginRequiredIfVisible())
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true })
    })
  }
}
