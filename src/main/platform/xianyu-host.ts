/**
 * 工单 041：闲鱼「隐藏宿主」—— 免 UI 页面抓取。
 *
 * 闲鱼的 mtop 会话键（cookie2/tfstk）是 **CHIPS 分区 Cookie**，`session.cookies.get`
 * 读不出分区值，纯直连必然 SESSION_EXPIRED（2026-11-01 webRequest diff 实测，
 * 另发现 goofish 的 appKey 是 34839810 而非淘宝的 12574478）。
 * 所以让一个**隐藏 BrowserWindow** 加载 goofish 页面充当 SDK 宿主：
 * 浏览器态自动带上全部分区 Cookie，`window.lib.mtop.request` 负责签名，
 * 与界面上的 webview 同一条 `__reflowPageSdk` 通道，用户全程看不到页面。
 */
import { injectPreloadFile } from '../capture-bridge'
import { openHiddenHost, sleep } from './host-window'

export const XIANYU_BOUGHT_URL = 'https://www.goofish.com/bought'

const HOST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export interface XianyuHost {
  /** 页面 webContents id（dispatchPageSdkRequest 用） */
  webContentsId: number
  /** 用完必须调用（销毁隐藏窗口） */
  destroy: () => void
}

/**
 * 打开隐藏宿主并等 `window.lib.mtop` 就绪。
 * 未登录时页面会弹登录框/跳登录页 → 通过检查 cookies（unb）与 URL 判定抛会话错误。
 */
export async function openXianyuHost(): Promise<XianyuHost> {
  const host = await openHiddenHost({
    partition: 'persist:platform-xianyu',
    url: XIANYU_BOUGHT_URL,
    userAgent: HOST_UA,
    preload: injectPreloadFile(),
    openLabel: '打开闲鱼页面'
  })
  // 等 lib.mtop 挂出来（最多 30s）
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(1000)
    ready = (await host
      .evalJs<boolean>('!!(window.lib && window.lib.mtop && window.lib.mtop.request)', 8_000, '检查页面 SDK')
      .catch(() => false)) as boolean
  }
  if (!ready) {
    const url = host.currentUrl()
    // 诊断：SDK 未就绪时记录页面实况（标题/文本片段/canvas 数），定位改版形态
    const snapshot = await host
      .evalJs<unknown>(
        `({ title: document.title, text: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 160), canvases: document.querySelectorAll('canvas').length, hasLib: typeof window.lib })`,
        8_000,
        '诊断页面'
      )
      .catch(() => null)
    console.error('[xianyu-host] SDK 未就绪:', url.slice(0, 90), JSON.stringify(snapshot))
    host.destroy()
    if (/login|passport/i.test(url)) {
      const err = new Error('闲鱼登录态已失效，请重新扫码登录')
      err.name = 'XianyuSessionError'
      throw err
    }
    throw new Error('闲鱼页面 SDK 未就绪（页面可能改版），请打开闲鱼页面确认后重试')
  }
  return { webContentsId: host.webContentsId, destroy: host.destroy }
}
