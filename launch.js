/**
 * 回流 Reflow 启动器（桌面快捷方式的入口）
 *
 * 以 Electron 主进程身份运行，但**不创建任何窗口** —— 它只负责把
 * `electron-vite dev` 拉起来，然后安静地待着；用户关掉应用，它跟着退出。
 *
 * 为什么必须常驻（2026-10-29 反复实测的结论）：
 * 试过「spawn 完就退」，三种写法都活不过 40 秒 ——
 *   ① `process.exit(0)`：整个进程树被带走，只剩 dev server 空转；
 *   ② 自然退出 + 日志 fd 继承：父进程退、控制台关，子进程收到关闭事件一起死；
 *   ③ cmd 重定向 + `stdio:'ignore'` + `detached`：命令压根没起来。
 * 根因是 Windows 上父进程退出会牵连子进程的控制台/句柄。跳板常驻最稳，
 * 代价只是多一个无窗口的 Electron 进程。
 *
 * 快捷方式：见 scripts/make-shortcut.cjs
 * 启动日志：%TEMP%\reflow-dev.log（双击没反应时看这里）
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = __dirname
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const isElectronApp = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE

/**
 * 单实例闸门：已经有一个跳板在跑就不要再起第二个 dev（否则 5173 端口打架、
 * 两个窗口抢同一份 userData）。
 */
if (isElectronApp) {
  const { app } = require('electron')
  app.disableHardwareAcceleration()
  // 没有窗口，别让 Electron 因为「窗口都关了」而退出
  app.on('window-all-closed', () => {})
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  app.whenReady().then(() => {
    const child = startDev()
    // 用户关掉应用 → electron-vite 退出 → 跳板跟着退，不留僵尸进程
    child.on('exit', () => setTimeout(() => app.exit(0), 800))
  })
} else {
  // 被当成普通 node 脚本跑（`node launch.js`）：同样等子进程结束再退
  const child = startDev()
  child.on('exit', () => process.exit(0))
}

/** 用哪个 node 跑 electron-vite：优先当前进程（若自己就是 node），否则找 PATH */
function nodeExe() {
  if (process.execPath && !process.versions.electron) return process.execPath
  try {
    const first = execSync('where node', { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
    if (first) return first
  } catch {
    /* 忽略：退回 PATH 查找 */
  }
  return 'node'
}

function startDev() {
  const viteBin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const logPath = path.join(os.tmpdir(), 'reflow-dev.log')

  let stdio = 'ignore'
  try {
    const fd = fs.openSync(logPath, 'a')
    stdio = ['ignore', fd, fd]
  } catch {
    /* 日志开不了不影响启动 */
  }

  return spawn(
    nodeExe(),
    [
      viteBin,
      'dev',
      '--',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader'
    ],
    {
      cwd: root,
      env,
      detached: false,
      stdio,
      /**
       * 必须显式关掉控制台窗口。
       *
       * 父进程是 electron.exe（GUI 子系统，本来没有控制台），
       * 而 node.exe 是**控制台子系统**程序 —— Windows 会给它分配一个新控制台，
       * 于是双击快捷方式后弹出一个黑窗口，一直挂到应用关闭。
       * `windowsHide: true` 会带 CREATE_NO_WINDOW 标志，窗口不会出现。
       */
      windowsHide: true
    }
  )
}
