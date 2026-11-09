/**
 * 验证改造后的二维码提取脚本（SCRIPT_FIND_QR）在淘宝登录页上的表现。
 *
 * 直接从源码里取出脚本原文再 eval 成模板字符串，保证测的就是生产用的那份，
 * 不是复制品。产出 .scratch/tb-page-qr.png 供人眼确认「确实是二维码」。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/qr-extract-probe.cjs
 */
const { app, BrowserWindow } = require('electron')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

app.setPath('userData', path.join(os.tmpdir(), `reflow-qrx-${Date.now()}`))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

/** 从 qr-login.ts 里取出 SCRIPT_FIND_QR 的真实内容 */
function loadFindQrScript() {
  const src = fs.readFileSync(path.resolve('src/main/qr-login.ts'), 'utf8')
  const m = src.match(/const SCRIPT_FIND_QR = `([\s\S]*?)`\r?\n/)
  if (!m) throw new Error('没找到 SCRIPT_FIND_QR')
  // eslint-disable-next-line no-eval
  return eval('`' + m[1] + '`')
}

async function probe(name, url, { clickText, waitMs = 6000 } = {}) {
  console.log(`\n=== ${name} ${url}`)
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: `persist:probe-${name}`,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setUserAgent(UA)
  await win.loadURL(url).catch((e) => console.log('  load error:', e.message))
  await new Promise((r) => setTimeout(r, waitMs))
  if (clickText) {
    const clicked = await win.webContents
      .executeJavaScript(
        `(() => {
          const els = [...document.querySelectorAll('*')].filter(
            (e) => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(clickText)}
          );
          if (!els.length) return false;
          els[0].click();
          return true;
        })()`
      )
      .catch(() => false)
    console.log('  click', clickText, '->', clicked)
    await new Promise((r) => setTimeout(r, 2500))
  }
  const script = loadFindQrScript()
  const result = await win.webContents.executeJavaScript(script).catch((e) => 'ERR ' + e.message)
  if (!result) {
    console.log('  ✗ 没提取到二维码')
  } else if (typeof result === 'string' && result.startsWith('data:image')) {
    const b64 = result.split(',')[1]
    const file = path.resolve('.scratch', `${name}-qr.png`)
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    console.log(`  ✓ 提取到 data URL（${Math.round(b64.length / 1024)}KB）→ ${file}`)
  } else {
    console.log('  ✓ 提取到图片 URL:', String(result).slice(0, 120))
    try {
      const buf = Buffer.from(await (await fetch(String(result), { headers: { 'user-agent': UA } })).arrayBuffer())
      const file = path.resolve('.scratch', `${name}-qr.png`)
      fs.writeFileSync(file, buf)
      console.log(`  ✓ 已下载 → ${file} (${buf.length}B)`)
    } catch (e) {
      console.log('  下载失败:', e.message)
    }
  }
  if (!win.isDestroyed()) win.destroy()
}

app.whenReady().then(async () => {
  try {
    await probe('tb-page', 'https://login.taobao.com/member/login.jhtml')
    await probe('jd-page', 'https://passport.jd.com/new/login.aspx')
    await probe('pdd-page', 'https://mobile.yangkeduo.com/login.html', { clickText: '扫码登录' })
  } catch (e) {
    console.log('probe error:', e.message)
  }
  app.quit()
})
