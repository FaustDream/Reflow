/**
 * 渲染层的 window.api 类型声明。
 *
 * 类型**只此一处**：`ReflowApi` 直接取自 preload/index.ts 的 `typeof api`。
 * 之前这里手抄过一份 245 行的 API 面，preload 侧一改（如 FetchPlatform 平台增减）
 * 这边就静默漂移 —— 编译器两份各查各的，永远不会有告警。
 */
import { ElectronAPI } from '@electron-toolkit/preload'
import type { ReflowApi } from './index'

// 供 Web 调试模式的渲染层 shim 引用（tsconfig.web paths: @preload-api → 本文件）。
// 直接 import '../../preload/index' 会把 preload 运行时模块拖进 web 工程（TS6307），
// 经这里中转则与桌面版共用同一类型来源，零漂移。
export type { ReflowApi }

declare global {
  interface Window {
    electron: ElectronAPI
    api: ReflowApi
  }
}

// 阻止该文件被当作全局脚本：保持模块形态（与手抄版行为一致）
export {}
