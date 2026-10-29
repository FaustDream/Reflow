/**
 * 平台页面脚本的注入清单（工单 003「两段式」的页面段）。
 * inject preload 会对每个 webview 注入全部脚本；各脚本自行按域名护卫。
 * 新增平台时在此追加一行（实现见同目录 <platform>.ts）。
 */
import { installXianyuPageScript } from './xianyu'

export interface PlatformPageScript {
  platform: string
  /** 序列化后的 IIFE 源码，注入时追加 (nonce) 参数执行 */
  source: string
}

export const platformPageScripts: PlatformPageScript[] = [
  {
    platform: 'xianyu',
    source: `(${installXianyuPageScript.toString()})`
  }
]
