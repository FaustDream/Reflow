/**
 * 后台重新加载订单：用**独立隐藏窗口**跑抓取，不占用界面上那个共享 webview。
 *
 * 为什么必须这样：
 * 界面上只有一个 webview（按平台重建）。原来点「后台翻页」后一切平台，
 * webview 就被销毁重建，滚动脚本随之死掉 —— 于是美团只抓到 39 单、还缺一整年。
 * 用户诉求也是「拉取时不能不让点其他平台」。
 *
 * 隐藏窗口与目标平台共用同一个 partition（登录态一致），
 * capture-bridge 的 `web-contents-created` 会为它挂上注入 preload，
 * 页面自己发出的订单接口照样被被动捕获，落库路径与前台完全一样。
 *
 * 2026-10-31（工单 040）：拼多多/淘宝/京东已改为接口直连（pdd-api-fetch /
 * taobao-api-fetch / jd-api-fetch），本模块只剩「隐藏页滚动 + 被动捕获」
 * 这一条回落通道，供拼多多 anti_content 通道不全时补全使用。
 */
import { BrowserWindow } from 'electron'
import { injectPreloadFile } from './capture-bridge'
import { adapterRegistry } from './platform/registry'

export interface BgReloadResult {
  ok: boolean
  platform: string
  steps: number
  message?: string
}

/** 页面内滚动到底，直到连续若干次高度不再增长 */
const SCROLL_SCRIPT = `(async () => {
  let idle = 0
  let last = 0
  let n = 0
  const h = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  )
  // 有的列表挂在内部容器里，光滚 window 不动 —— 所以window和各容器一起滚
  const scrollAll = () => {
    const bottom = h()
    window.scrollTo(0, bottom)
    if (document.documentElement) document.documentElement.scrollTop = bottom
    if (document.body) document.body.scrollTop = bottom
    const nodes = document.querySelectorAll('div, section, main, ul')
    for (const el of nodes) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) {
        el.scrollTop = el.scrollHeight
      }
    }
    // 传统分页页（淘宝 buyertrade）：滚动没用，得点「下一页」
    const next = Array.from(document.querySelectorAll('a, button, li')).find(
      (el) =>
        /下一页|next/i.test(el.innerText || '') &&
        !/disabled/i.test(el.className || '') &&
        !el.hasAttribute('disabled')
    )
    if (next) {
      try {
        next.click()
      } catch (e) {
        /* 忽略点击异常 */
      }
    }
  }
  for (let i = 0; i < 200; i++) {
    scrollAll()
    await new Promise((r) => setTimeout(r, 2500))
    const after = h()
    n++
    if (after > last + 10) { last = after; idle = 0 } else { idle++ }
    if (idle >= 8) break
  }
  return n
})()`

/**
 * 美团专用翻页脚本：H5 订单页是 cursor 分页（`data.isEnd` / `data.cursor`），
 * 但接口要 mtgsig 签名（决策 D-2 不构造请求），只能靠滚动触发懒加载。
 *
 * 比通用 SCROLL_SCRIPT 更激进：
 * - 滚动间隔 1200ms（美团懒加载偏慢）
 * - 连续 20 次无新增才停（通用版 8 次太早，实测 39 单就停了）
 * - 同时点「查看全部 / 加载更多 / 更早订单」按钮（美团有显式加载入口）
 * - 最多 500 轮（约 10 分钟），覆盖 500+ 单
 */
const MEITUAN_SCROLL_SCRIPT = `(async () => {
  let idle = 0
  let last = 0
  let n = 0
  const h = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  )
  const scrollAll = () => {
    const bottom = h()
    window.scrollTo(0, bottom)
    if (document.documentElement) document.documentElement.scrollTop = bottom
    if (document.body) document.body.scrollTop = bottom
    const nodes = document.querySelectorAll('div, section, main, ul')
    for (const el of nodes) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) {
        el.scrollTop = el.scrollHeight
      }
    }
    // 美团 H5 有显式加载入口
    const btns = Array.from(document.querySelectorAll('a, button, div, span')).filter(
      (el) => /查看全部|加载更多|更早订单|查看更多|历史订单/.test(el.innerText || '')
    )
    for (const b of btns.slice(0, 3)) {
      try { b.click() } catch (e) { /* 忽略 */ }
    }
  }
  for (let i = 0; i < 500; i++) {
    scrollAll()
    await new Promise((r) => setTimeout(r, 1200))
    const after = h()
    n++
    if (after > last + 10) { last = after; idle = 0 } else { idle++ }
    if (idle >= 20) break
  }
  return n
})()`


/** 后台滚动抓取（适用于拼多多/美团/京东这类靠页面滚动加载的平台） */
export async function bgReloadPlatform(
  platform: string,
  options?: { settleMs?: number }
): Promise<BgReloadResult> {
  const adapter = adapterRegistry.get(platform)
  if (!adapter) return { ok: false, platform, steps: 0, message: '未知平台' }

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 960,
      webPreferences: {
        partition: adapter.partition,
        preload: injectPreloadFile(),
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        /**
         * 离屏渲染：`show:false` 的普通窗口不跑 layout，
         * 列表懒加载（IntersectionObserver / 滚动监听）永远不触发 ——
         * 实测那样只能拿到首屏 7 单。离屏渲染保证页面真的在排版，滚动才有效。
         */
        offscreen: true,
        // 隐藏窗口默认会被降频，定时器被拉长 → 滚动节奏失真、加载不出来
        backgroundThrottling: false
      }
    })

    await win.loadURL(adapter.homeUrl)
    // 等首屏订单接口发完（登录态无效时这里会停在登录页，滚动自然无收益）
    await new Promise((r) => setTimeout(r, (options?.settleMs ?? 4000)))

    // 美团用专用翻页脚本（cursor 分页 + 显式加载按钮），其他平台用通用滚动
    const script = platform === 'meituan' ? MEITUAN_SCROLL_SCRIPT : SCROLL_SCRIPT
    const steps = (await win.webContents.executeJavaScript(script)) as number
    // 最后一批接口响应可能还在路上
    await new Promise((r) => setTimeout(r, 2500))

    return { ok: true, platform, steps }
  } catch (err) {
    return {
      ok: false,
      platform,
      steps: 0,
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    try {
      win?.destroy()
    } catch {
      /* 已销毁 */
    }
  }
}

