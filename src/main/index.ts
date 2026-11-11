import { app, shell, BrowserWindow, ipcMain, session, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupCaptureBridge } from './capture-bridge'
import { setupMitmIpc } from './mitm'
import { adapterRegistry } from './platform/registry'
import { setupExportIpc } from './export'
import { setupDetailFetchIpc } from './platform/detail-fetch'
import { setupImportIpc } from './import-ipc'
import { setupLoginIpc } from './login-ipc'
import { setupOrderCacheIpc, flushAllCache } from './cache-ipc'
import { setupDiagnosticsIpc } from './diagnostics-ipc'
import { setupAccountsIpc } from './accounts-ipc'
import { setupOnboardingIpc } from './onboarding'
import { initLogging, info as logInfo, warn as logWarn } from './logging/logger'
import { setupLoggingIpc } from './logging-ipc'
import { traceIpc } from './logging/ipc-trace'
import { installWebBridge, WEB_BRIDGE_PORT } from './web-bridge'

/**
 * Web 调试模式（`npm run dev:web`，即 electron-vite dev -- --web）：
 * 主进程在后台照常运行（窗口隐藏），渲染层跑在系统浏览器里，经 web-bridge 通信。
 * 功能与桌面模式完全一致 —— 同一个主进程、同一份渲染层代码，只换传输层。
 */
const webBridgeMode = process.argv.includes('--web') || process.env.REFLOW_WEB_BRIDGE === '1'

/**
 * 演示 / 自检用：把 userData 指到隔离目录（由 `npm run dev:demo` 设置）。
 *
 * 目的：带样例订单演示界面时，不污染真实目录里的订单缓存、登录态与导出记录。
 * 必须在 `requestSingleInstanceLock()` 之前设置 —— 单实例锁本身也落在 userData 下，
 * 换目录后演示实例才能和正式实例并存。
 */
const userDataOverride = process.env.REFLOW_USER_DATA
if (userDataOverride) app.setPath('userData', userDataOverride)

/**
 * 诊断用：`REFLOW_DEBUG_PORT=9333` 时开远程调试端口，供 `.scratch/*.mjs` 脚本
 * 通过 CDP 检查界面状态、抓页面请求。仅本地调试使用，不设变量就不会开端口。
 *
 * 必须在 app ready 之前 appendSwitch 才生效。
 */
const debugPort = process.env.REFLOW_DEBUG_PORT
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort)

// 指令留痕要在任何 ipcMain.handle 之前装好，否则先注册的频道抓不到
traceIpc()
// Web 桥要在 traceIpc 之后包 handle：浏览器 invoke 直达原始 handler，
// Electron 窗口内的 invoke 仍走留痕包装，两条链路互不干扰
if (webBridgeMode) installWebBridge(safeGetMainWindow)

// 工单 001：单实例锁。原版 PDD 有 second-instance 处理，重复启动应聚焦已有窗口而非再开一个。
const gotTheLock = app.requestSingleInstanceLock()

/**
 * 主窗口。
 * ⚠ 必须声明在 bootstrap() 之前：bootstrap 是在模块顶层直接调用的，
 * 若声明写在调用之后，回调里访问 mainWindow 会撞 TDZ
 * （实测报错 `Cannot access 'mainWindow' before initialization`，捕获事件整批丢失）。
 */
let mainWindow: BrowserWindow | null = null
/** 缓存落盘完成的标记，防止 before-quit 递归 */
let flushDone = false

/**
 * 安全取主窗口。
 * 实测撞过 TDZ（`Cannot access 'mainWindow' before initialization`），
 * 一旦抛出去会把 capture-bridge 的 forward 炸掉、后续所有捕获事件全丢。
 * 声明已提前到 bootstrap() 之前，这里再兜一层，宁可返回 null 也不让链路崩。
 */
function safeGetMainWindow(): BrowserWindow | null {
  try {
    return mainWindow
  } catch {
    return null
  }
}

if (!gotTheLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  app.on('second-instance', () => {
    logWarn('app', '检测到重复启动，聚焦已有窗口')
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.reflow.app')
    // 日志系统先就绪：后面的 createWindow / 适配器注册才有地方留痕
    void initLogging().then(() => {
      logInfo('app', '应用启动', {
        version: app.getVersion(),
        electron: process.versions.electron,
        userData: app.getPath('userData'),
        dev: is.dev,
        webBridge: webBridgeMode
      })
      if (webBridgeMode) {
        logInfo('app', `Web 调试模式：浏览器打开 vite dev server 页面即可测试（桥端口 ${WEB_BRIDGE_PORT}）`)
      }
    })

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch(() => undefined)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 工单 023：退出前把待写缓存落盘（避免关窗丢掉最近捕获的订单）
  app.on('before-quit', (event) => {
    if (flushDone) return
    logInfo('app', '应用退出，开始落盘缓存')
    event.preventDefault()
    void flushAllCache()
      .catch(() => undefined)
      .finally(() => {
        flushDone = true
        app.quit()
      })
  })

  registerIpc()
}

/**
 * 窗口图标。
 *
 * Windows 的任务栏按钮优先用窗口自己带的 HICON，拿不到才回落到 exe 内嵌图标。
 * exe 图标由 electron-builder 从 build/icons/reflow.ico 写入；这里再显式给一份，
 * 一是 Explorer 图标缓存可能还留着旧图标（表现为通用「空白文件」），
 * 二是窗口图标不经 shell 的 exe 图标查找，能绕开这份缓存。
 *
 * 图片随包放在 app.asar/build/icons/ 下（见 electron-builder.yml 的 files）；
 * 源码运行时 app.getAppPath() 就是仓库根目录，同一路径也成立。
 */
function windowIcon(): Electron.NativeImage | undefined {
  const img = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icons', 'icon-256.png'))
  return img.isEmpty() ? undefined : img
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    // Web 调试模式：窗口纯当后台用（webview/事件源），UI 在浏览器里
    skipTaskbar: webBridgeMode,
    title: 'Reflow',
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!webBridgeMode) mainWindow?.show()
  })
  // 兜底：生产模式（file:// 加载）下 ready-to-show 偶尔不触发，
  // 窗口就永远藏着、只剩进程 —— 双击图标后「什么都没发生」。3 秒后强制显示。
  // Web 模式例外：窗口本来就是隐藏的后台，不该自己冒出来。
  setTimeout(() => {
    if (!webBridgeMode && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }, 3000)

  // 外链一律交给系统浏览器，不在应用内打开。
  // 只放行 https:：渲染层内容含平台侧外部数据（订单标题等），一旦被注入，
  // window.open('ms-msdt:…'/'file://'/'自定义协议') 不应被拉起。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https:/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  setupLoggingIpc(safeGetMainWindow)

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }))

  // 仅 dev 诊断：读取平台分区 Cookie（含 httpOnly），用于校准登录态判定；白名单限定平台分区
  ipcMain.handle('debug:partition-cookies', (_e, partition: unknown) => {
    if (!is.dev) return { partition: '', cookies: [] }
    if (typeof partition !== 'string' || !/^persist:platform-[a-z0-9-]+$/.test(partition)) {
      return { partition: String(partition), cookies: [], error: '非法分区名' }
    }
    return session
      .fromPartition(partition)
      .cookies.get({})
      .then((all) => ({
        partition,
        cookies: all.map((c) => ({
          name: c.name,
          domain: c.domain,
          httpOnly: !!c.httpOnly,
          hostOnly: !!c.hostOnly,
          session: c.expirationDate === undefined
        }))
      }))
  })

  // 工单 005/006：适配器摘要（平台 Tab / 状态栏 / 诊断面板展示）。注册发生在 setupCaptureBridge 内。
  ipcMain.handle('app:get-adapters', () =>
    adapterRegistry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      homeUrl: a.homeUrl,
      supportsSeller: a.supportsSeller,
      ruleCount: a.matchRules.length,
      partition: a.partition
    }))
  )

  setupCaptureBridge({ getMainWindow: safeGetMainWindow })
  // 工单 034：MITM 抓取通道（可选，需先装证书；默认不开启）
  setupMitmIpc()
  setupExportIpc(safeGetMainWindow, adapterRegistry)
  setupImportIpc(safeGetMainWindow)
  setupDetailFetchIpc({ getMainWindow: safeGetMainWindow })
  // 登录：二维码（阿里/京东/拼多多/快手）或小弹窗（其余平台），不再占用整页 Tab
  setupLoginIpc(safeGetMainWindow)
  // 工单 023：订单本地缓存（关掉应用后再打开，历史订单还在）
  setupOrderCacheIpc()
  // 工单 025：诊断面板（只读快照，不含 Cookie/订单内容）
  setupDiagnosticsIpc()
  // 工单 021：多账号聚合（每账号独立 partition）
  setupAccountsIpc({ getMainWindow: safeGetMainWindow })
  // 工单 024：首次启动引导
  setupOnboardingIpc()
}
