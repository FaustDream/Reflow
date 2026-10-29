/**
 * 创建「回流 Reflow」桌面快捷方式（.lnk，带项目图标）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/make-shortcut.cjs
 *
 * 为什么不用 .bat：双击会闪一个黑窗口，而且任务栏图标是 cmd 的；
 * 旧入口还把整个 dev server 挂在前台，窗口不关就一直在。
 * .lnk 可以指定图标、描述、工作目录，和正常软件一模一样。
 *
 * 目标：electron.exe + launch.js
 * - electron.exe 是 GUI 子系统程序，不会弹控制台；
 * - launch.js 以 Electron 主进程身份运行（不建窗口），负责拉起 electron-vite dev 并常驻；
 * - 用户关掉应用 → dev 退出 → 跳板自己跟着退。
 */
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

app.disableHardwareAcceleration()
app.setPath('userData', path.join(os.tmpdir(), `reflow-lnk-${Date.now()}`))
app.on('window-all-closed', () => {})

const ROOT = path.resolve(__dirname, '..')
/**
 * 目标用 **electron.exe**（GUI 子系统，双击不弹控制台）。
 *
 * 它会以 Electron 主进程身份运行 launch.js：不建窗口，只负责把 electron-vite dev
 * 拉起来并常驻，用户关掉应用后自己退出。详见 launch.js 顶部的注释。
 *
 * 注意：路径必须是 ASCII —— `.lnk` 的参数里中文会被写坏，
 * 实测 `"D:\reflow\reflow\启动.js"` 存进去后「启动」两个字丢失、双击毫无反应。
 */
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const LAUNCHER = path.join(ROOT, 'launch.js')
const ICON = path.join(ROOT, 'build', 'icons', 'reflow.ico')
const NAME = '回流 Reflow'

function fail(msg) {
  console.error('✗', msg)
  app.exit(1)
}

app.whenReady().then(() => {
  for (const [label, p] of [
    ["electron.exe", ELECTRON],
    ['launch.js', LAUNCHER],
    ['图标', ICON]
  ]) {
    if (!fs.existsSync(p)) return fail(`缺少 ${label}：${p}`)
  }
  console.log("target:", ELECTRON)

  const desktop = app.getPath('desktop')
  const targets = [
    path.join(desktop, `${NAME}.lnk`),
    // 开始菜单也放一份，方便 Win 键直接搜到
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`)
  ]

  const options = {
    target: ELECTRON,
    args: `"${LAUNCHER}"`,
    cwd: ROOT,
    icon: ICON,
    iconIndex: 0,
    description: '回流 Reflow — 多平台订单聚合与导出',
    appUserModelId: 'com.reflow.app'
  }

  let ok = 0
  for (const lnk of targets) {
    try {
      fs.mkdirSync(path.dirname(lnk), { recursive: true })
      // operation: 'create' 已存在时覆盖（'update' 只在已存在时可用）
      const done = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', options)
      if (!done) throw new Error('writeShortcutLink 返回 false')
      console.log('✓', lnk)
      ok++
    } catch (err) {
      console.error('✗', lnk, '-', err.message)
    }
  }

  // 清掉旧的 .bat 入口，避免两个入口并存时点到黑窗口
  const oldBat = path.join(desktop, `${NAME}.bat`)
  if (fs.existsSync(oldBat)) {
    fs.unlinkSync(oldBat)
    console.log('✓ 已移除旧入口', oldBat)
  }

  // 让资源管理器重新读图标缓存（否则新图标可能要等很久才显示）
  try {
    execFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'ie4uinit.exe'), ['-show'], {
      stdio: 'ignore'
    })
    console.log('✓ 已刷新图标缓存')
  } catch {
    /* 刷不了不影响使用 */
  }

  console.log(ok ? `\n完成：${ok} 个快捷方式` : '\n没有创建任何快捷方式')
  app.exit(ok ? 0 : 1)
})
