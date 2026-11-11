/**
 * 启动自愈：给「已登录但会话 Cookie 缺失」的平台补一次页面访问（2026-11-11）。
 *
 * 背景：Electron 只把带 Expires 的 Cookie 落盘，会话级 Cookie 随进程退出消失。
 * 淘宝的 `cookie2` / `_tb_token_` 就属于这类 —— 只在打开页面时由服务端重新下发。
 * 表现很迷惑：界面显示「已登录」（`unb` 还在），但 mtop 一律 FAIL_SYS_SESSION_EXPIRED。
 *
 * 处理：应用启动、登录态就绪后，检查这些平台的关键会话 Cookie 是否齐全；
 * 缺了就静默开一次首页（隐藏窗口，几秒后销毁），让服务端把 Cookie 重新种回来。
 * 实测 `www.taobao.com` 一次访问即可重建 `cookie2` + `_tb_token_`。
 *
 * 这是**兜底**，不是主路径：登录成功时 `login.persistCookies` 已经把它们改写成持久 Cookie，
 * 正常情况下重启不会缺。兜底只覆盖「从旧版本升级上来」和「服务端单方面清掉会话」两种情况。
 */
import { session } from 'electron'
import { openHiddenHost } from './host-window'
import { getPlatformLoginStates } from './cookie-login'
import { info, warn } from '../logging/logger'

/** 平台 → 用于重建会话的入口页 */
const WARM_URLS: Record<string, string> = {
  taobao: 'https://www.taobao.com'
}

/** 平台 → 必须存在的会话 Cookie（缺任一个就触发自愈） */
const REQUIRED: Record<string, string[]> = {
  taobao: ['cookie2', '_tb_token_']
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export async function warmUpLogins(): Promise<void> {
  const states = getPlatformLoginStates()
  for (const [platform, url] of Object.entries(WARM_URLS)) {
    if (!states[platform]?.loggedIn) continue
    const need = REQUIRED[platform] ?? []
    if (!need.length) continue

    const sess = session.fromPartition(`persist:platform-${platform}`)
    let present: string[] = []
    try {
      const all = await sess.cookies.get({})
      present = all.map((c) => c.name)
    } catch (e) {
      warn('login:warmup', '读取分区 Cookie 失败', {
        platform,
        error: e instanceof Error ? e.message : String(e)
      })
      continue
    }
    const missing = need.filter((n) => !present.includes(n))
    if (!missing.length) continue

    info('login:warmup', '会话 Cookie 缺失，静默访问首页补种', { platform, missing })
    let host: Awaited<ReturnType<typeof openHiddenHost>> | null = null
    try {
      host = await openHiddenHost({
        partition: `persist:platform-${platform}`,
        url,
        userAgent: UA,
        openLabel: `预热 ${platform} 会话`
      })
      // 页面自己的 SSO/初始化请求要几秒才把 Cookie 种回来
      await new Promise((r) => setTimeout(r, 6000))
      const after = await sess.cookies.get({})
      const fixed = require_after(after.map((c) => c.name), missing)
      info('login:warmup', fixed.length ? '会话 Cookie 已补回' : '补种未成功（可能真的需要重新登录）', {
        platform,
        recovered: fixed
      })
    } catch (e) {
      warn('login:warmup', '预热窗口打开失败', {
        platform,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      host?.destroy()
    }
  }
}

/** 看看缺失项里哪些补回来了 */
function require_after(present: string[], missing: string[]): string[] {
  return missing.filter((n) => present.includes(n))
}
