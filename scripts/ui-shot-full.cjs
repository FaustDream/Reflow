/**
 * 完整启动自检：走真实主进程（含 IPC / 适配器注册），截图并检查平台列表。
 * 运行：npx electron scripts/ui-shot-full.cjs
 */
const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()
app.requestSingleInstanceLock()

// 复用真实主进程模块（已编译到 out/main/index.js）
// 这里通过环境标记让主进程不自动创建窗口，改由本脚本控制
process.env.REFLOW_SHOT = '1'

app.whenReady().then(async () => {
  // 直接 require 编译后的主进程入口，让所有 IPC/适配器注册生效
  require(path.join(ROOT, 'out/main/index.js'))
  await new Promise((r) => setTimeout(r, 2500))

  const wins = BrowserWindow.getAllWindows()
  const win = wins[0]
  if (!win) {
    console.log('NO WINDOW')
    app.quit()
    return
  }
  win.setSize(1400, 900)
  await new Promise((r) => setTimeout(r, 3000))

  const outDir = path.join(ROOT, '.scratch')
  fs.mkdirSync(outDir, { recursive: true })
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'ui-full.png'), img.toPNG())

  const info = await win.webContents
    .executeJavaScript(`(() => ({
      text: document.body.innerText.slice(0, 600).replace(/\s+/g, ' '),
      platformItems: [...document.querySelectorAll('.platform-item')].map((e) => e.innerText.replace(/\s+/g, ' ')),
      activeTitle: document.querySelector('.content-title')?.innerText || ''
    }))()`)
    .catch((e) => ({ err: e.message }))
  console.log(JSON.stringify(info, null, 1))
  app.quit()
})
