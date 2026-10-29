/**
 * 工单 004：平台 App 深链拦截。
 *
 * 平台网页会尝试唤起手机 App（如京东 openapp.jd://），在桌面端表现为跳转失败或弹出无关程序。
 * 原版京东用「主进程注册协议兜底 + 页面捕获阶段点击拦截」双层防御（见 static/preload-login.js）。
 * 此处实现主进程层：will-navigate / will-redirect / setWindowOpenHandler 三处拦截。
 */
import type { WebContents } from 'electron'

export const BLOCKED_PROTOCOLS = [
  'openapp.jd',
  'openapp.jdmobile',
  'jdmobile',
  'fleamarket',
  'meituanwaimai'
] as const

export function isBlockedDeepLink(url: string): boolean {
  return BLOCKED_PROTOCOLS.some((p) => url.startsWith(`${p}://`) || url.startsWith(`${p}:`))
}

/** 给任意 webContents（含 webview）挂上深链拦截。返回是否拦截过（便于日志/诊断）。 */
export function attachDeepLinkGuard(contents: WebContents, onBlocked?: (url: string) => void): void {
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isBlockedDeepLink(url)) {
      event.preventDefault()
      onBlocked?.(url)
    }
  }

  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(({ url }) => {
    if (isBlockedDeepLink(url)) {
      onBlocked?.(url)
      return { action: 'deny' }
    }
    // 非深链的外链也不在应用内开新窗，交还系统浏览器由调用方决定；此处保守拒绝
    return { action: 'deny' }
  })
}
