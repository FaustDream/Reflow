/**
 * 隐藏签名宿主窗口（工单 040/041：京东/拼多多/闲鱼接口直连共用）。
 *
 * 各平台的「隐藏 BrowserWindow 当页面 SDK 宿主」曾是三份逐字复制的手抄
 * （窗口参数、setUserAgent、loadURL 超时、就绪探测、销毁兜底）——本工厂只收编
 * **窗口生命周期**这部分；探测循环（各平台等各自 SDK/签名器/hook 就绪）差异真实，
 * 仍留在各平台文件里。
 *
 * ⚠ 信任边界：宿主页面必须 `contextIsolation: false, sandbox: false`
 * （页面 SDK 签名/hook 都要在页面主世界），页面脚本能篡改注入的 hook。
 * 该窗口只加载对应平台自己的页面（partition 与用户登录态同源）。
 */
import { BrowserWindow } from 'electron'

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), ms))
  ])
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface HiddenHost {
  win: BrowserWindow
  readonly webContentsId: number
  /** 当前页面地址（登录跳转判定用） */
  currentUrl: () => string
  /** 在页面主世界执行脚本（自带超时兜底；执行期页面跳转等异常由调用方处理） */
  evalJs: <T>(code: string, timeoutMs: number, label: string) => Promise<T>
  destroy: () => void
}

export interface HiddenHostOptions {
  /** 与用户登录态相同的平台分区 */
  partition: string
  url: string
  userAgent: string
  /** 闲鱼 = injectPreloadFile()；拼多多 = hook preload 文件；京东无 */
  preload?: string
  /** loadURL 超时标签（错误信息用） */
  openLabel: string
}

/** 打开隐藏宿主并等页面 loadURL（失败不抛：可能停在登录跳转，由调用方判 URL） */
export async function openHiddenHost(options: HiddenHostOptions): Promise<HiddenHost> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 960,
    webPreferences: {
      partition: options.partition,
      ...(options.preload ? { preload: options.preload } : {}),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false
    }
  })
  const destroy = (): void => {
    try {
      win.destroy()
    } catch {
      /* 已销毁 */
    }
  }
  try {
    try {
      await win.webContents.setUserAgent(options.userAgent)
    } catch {
      /* 无关紧要 */
    }
    try {
      await withTimeout(win.loadURL(options.url), 40_000, options.openLabel)
    } catch {
      /* 加载失败仍继续：可能停在登录跳转，由调用方判 URL */
    }
    return {
      win,
      get webContentsId() {
        return win.webContents.id
      },
      currentUrl: () => win.webContents.getURL(),
      evalJs: <T,>(code: string, timeoutMs: number, label: string) =>
        withTimeout(win.webContents.executeJavaScript(code), timeoutMs, label) as Promise<T>,
      destroy
    }
  } catch (e) {
    destroy()
    throw e
  }
}
