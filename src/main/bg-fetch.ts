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
 */
import { BrowserWindow } from 'electron'
import { injectPreloadFile } from './capture-bridge'
import { adapterRegistry } from './platform/registry'
import {
  TAOBAO_FETCH_ALL_SCRIPT,
  toOrderFromMain,
  type TaobaoFetchAllRaw
} from './platform/taobao-v2-fetch'
import type { Order } from '../shared/types/order'

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

/**
 * 淘宝专用：订单页是**服务端渲染的 HTML**（没有可捕获的订单接口，
 * 实测 `window.Qr === false`，mtop 主动抓取是死路），只能解析 DOM + 点「下一页」。
 * 一页 30 单、共 15 页左右，全部翻完才有完整历史。
 */
const TAOBAO_DOM_SCRIPT = `(async () => {
  const parsePage = () => {
    const lines = document.body.innerText.split('\\n').map((s) => s.trim()).filter(Boolean)
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^订单号[：:]\\s*(\\d+)$/.exec(lines[i])
      if (!m) continue
      const orderId = m[1]
      const shopName = lines[i + 1] || ''
      let status = ''
      let title = ''
      let spec = ''
      let paid = ''
      let qty = 1
      let date = ''
      for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
        if (/^\\d{4}-\\d{2}-\\d{2}$/.test(lines[k])) { date = lines[k]; break }
      }
      for (let k = i + 2; k < Math.min(lines.length, i + 16); k++) {
        const s = lines[k]
        if (!status && /交易成功|交易关闭|等待买家付款|等待卖家发货|卖家已发货|等待买家收货|退款|已完成/.test(s)) {
          status = s
          continue
        }
        if (status && !title && s.length > 5 && !/^[¥￥]/.test(s) && !/^x\\d+$/.test(s)) {
          title = s.replace(/\\s*\\[交易快照\\]$/, '')
          continue
        }
        if (title && !spec && s.length > 1 && s.length < 80 && !/^[¥￥]/.test(s) && !/^x\\d+$/.test(s) && !/实付款|含运费|再买一单|申请|加入购物车|手机订单/.test(s)) {
          spec = s
          continue
        }
        const pm = /实付款[￥¥]\\s*([\\d.]+)/.exec(s)
        if (pm && !paid) paid = pm[1]
        const qm = /^x(\\d+)$/.exec(s)
        if (qm) qty = Number(qm[1])
      }
      out.push({ orderId, shopName, status, title, spec, paid, qty, date })
    }
    return out
  }
  const seen = new Map()
  let pages = 0
  for (let p = 0; p < 40; p++) {
    const batch = parsePage()
    batch.forEach((o) => seen.set(o.orderId, o))
    pages++
    const next = Array.from(document.querySelectorAll('div, a, button, span')).find(
      (e) => /^下一页$/.test((e.innerText || '').trim()) && e.children.length === 0
    )
    if (!next) break
    const before = (document.body.innerText.match(/订单号: \\d+/g) || []).join(',')
    try {
      next.click()
    } catch (e) {
      break
    }
    await new Promise((r) => setTimeout(r, 3500))
    const after = (document.body.innerText.match(/订单号: \\d+/g) || []).join(',')
    if (before === after) break
  }
  return { orders: Array.from(seen.values()), pages }
})()`

export interface TaobaoDomOrder {
  orderId: string
  shopName: string
  status: string
  title: string
  spec: string
  paid: string
  qty: number
  date: string
}

/** 淘宝 DOM 抓取：返回原始条目（由调用方转成 Order 并入引擎） */
export async function bgFetchTaobaoDom(): Promise<{
  ok: boolean
  orders: TaobaoDomOrder[]
  pages: number
  message?: string
}> {
  const adapter = adapterRegistry.get('taobao')
  if (!adapter) return { ok: false, orders: [], pages: 0, message: '淘宝适配器未注册' }

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1000,
      webPreferences: {
        partition: adapter.partition,
        preload: injectPreloadFile(),
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    await win.loadURL(
      'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'
    )
    await new Promise((r) => setTimeout(r, 6000))
    const res = (await win.webContents.executeJavaScript(TAOBAO_DOM_SCRIPT)) as {
      orders: TaobaoDomOrder[]
      pages: number
    }
    return { ok: true, orders: res.orders ?? [], pages: res.pages ?? 0 }
  } catch (err) {
    return {
      ok: false,
      orders: [],
      pages: 0,
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

/**
 * 淘宝订单全量抓取：在**已登录的淘宝页面内**调 `lib.mtop`（魔猫同款做法）。
 *
 * 不需要 MITM、不需要逆向 sign —— 签名由页面 SDK 自己算。
 * 实测返回 `{mainOrders, page:{currentPage,totalPage,totalNumber}}`，可翻页拿全量。
 */
export async function bgFetchTaobaoAll(): Promise<{
  ok: boolean
  orders: Order[]
  totalPage: number
  message?: string
}> {
  const adapter = adapterRegistry.get('taobao')
  if (!adapter) return { ok: false, orders: [], totalPage: 0, message: '淘宝适配器不存在' }

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
        offscreen: true,
        backgroundThrottling: false
      }
    })
    // 必须是已登录的淘宝订单页：lib.mtop 依赖页面内的登录态与 SDK
    await win.loadURL('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm')

    // 等 lib.mtop 真正可用再调用 —— 否则会直接返回空/超时
    let sdkReady = false
    for (let i = 0; i < 40; i++) {
      try {
        sdkReady = (await win.webContents.executeJavaScript(
          '!!(window.lib && window.lib.mtop && window.lib.mtop.request)'
        )) as boolean
      } catch {
        sdkReady = false
      }
      if (sdkReady) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!sdkReady) {
      return {
        ok: false,
        orders: [],
        totalPage: 0,
        message: '淘宝页面 SDK 未就绪（可能未登录或页面加载失败）'
      }
    }

    const raw = (await win.webContents.executeJavaScript(TAOBAO_FETCH_ALL_SCRIPT)) as TaobaoFetchAllRaw
    if (raw?.error) {
      return { ok: false, orders: [], totalPage: raw.months ?? 0, message: raw.error }
    }
    const orders = (raw?.orders ?? []).map(toOrderFromMain).filter((o) => o.orderId)
    return { ok: true, orders, totalPage: raw?.months ?? 1 }
  } catch (err) {
    return {
      ok: false,
      orders: [],
      totalPage: 0,
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
