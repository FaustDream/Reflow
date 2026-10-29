/**
 * 完整 UI 交互自检：点「登录当前平台」→ 弹窗 → 二维码 → 截图。
 * 运行：npx electron scripts/login-ui-shot.cjs [平台显示名]
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const wantPlatform = process.argv[2] || '淘宝'
app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  require(path.join(ROOT, 'out/main/index.js'))
  await new Promise((r) => setTimeout(r, 2500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('NO WINDOW'); app.quit(); return }
  win.setSize(1400, 900)
  await new Promise((r) => setTimeout(r, 1500))

  // 1. 点击左侧平台项
  const clicked = await win.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('.platform-item')];
      const el = items.find(e => e.innerText.includes(${JSON.stringify(wantPlatform)}));
      if (!el) return 'not found';
      el.click();
      return 'clicked ' + el.querySelector('.platform-name').innerText;
    })()`
  ).catch((e) => 'ERR ' + e.message)
  console.log('select:', clicked)
  await new Promise((r) => setTimeout(r, 800))

  // 2. 点「登录当前平台」
  const loginClicked = await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.sidebar-foot button')];
    const el = btns.find(b => /登录|扫码/.test(b.innerText));
    if (!el) return 'not found';
    el.click();
    return 'clicked';
  })()`)
  console.log('login btn:', loginClicked)
  await new Promise((r) => setTimeout(r, 12000))

  const state = await win.webContents.executeJavaScript(`(() => ({
    dialogOpen: !!document.querySelector('.login-dialog'),
    hasQr: !!document.querySelector('.qr-img'),
    qrSrc: (document.querySelector('.qr-img')?.src || '').slice(0, 90),
    tip: document.querySelector('.login-tip')?.innerText || '',
    sub: document.querySelector('.login-sub')?.innerText || ''
  }))()`).catch((e) => ({ err: e.message }))
  console.log('state:', JSON.stringify(state, null, 1))

  const outDir = path.join(ROOT, '.scratch')
  fs.mkdirSync(outDir, { recursive: true })
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'login-ui.png'), img.toPNG())
  app.quit()
})
