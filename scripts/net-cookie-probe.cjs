/**
 * 关键验证：原生路径用的 `net.request({ session, useSessionCookies: true })`
 * 到底能不能把响应的 Set-Cookie **写进**目标 partition？
 *
 * 这决定了淘宝 native 扫码登录有没有可能成功：
 *  - 若写不进 → 扫码成功后 Cookie 永远落不了地，界面永远「未登录」，
 *    必须改走 dom 路径（隐藏窗口加载登录页，页面自己完成登录）。
 *  - 若能写进 → 问题只在 10006 之后的跳转访问，可以针对性修。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/net-cookie-probe.cjs
 */
const { app, session, net, BrowserWindow } = require('electron')
const os = require('node:os')
const path = require('node:path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

app.setPath('userData', path.join(os.tmpdir(), `reflow-netcookie-${Date.now()}`))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

function netFetch(sess, url, opts = {}) {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url,
      session: sess,
      useSessionCookies: true,
      credentials: 'include'
    })
    req.setHeader('user-agent', UA)
    const chunks = []
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          setCookie: res.headers['set-cookie'] || [],
          text: Buffer.concat(chunks).toString('utf8').slice(0, 200)
        })
      )
      res.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message, setCookie: [] }))
    })
    req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message, setCookie: [] }))
    req.end()
  })
}

const show = async (sess, label) => {
  const ck = await sess.cookies.get({})
  console.log(`  [${label}] session cookies = ${ck.length}: ${ck.map((c) => c.name).join(', ')}`)
  return ck
}

app.whenReady().then(async () => {
  console.log('\n=== A. net.request 能否写入 Set-Cookie ===')
  const sess = session.fromPartition('persist:probe-netcookie')
  await sess.clearStorageData()
  await show(sess, 'before')

  const ts = Date.now()
  const gen = await netFetch(
    sess,
    `https://qrlogin.taobao.com/qrcodelogin/generateQRCode4Login.do?from=tb&appkey=00000000&_ksTS=${ts}_${ts % 10000}`
  )
  console.log(`  generate status=${gen.status} set-cookie=${gen.setCookie.length} 条`)
  for (const sc of gen.setCookie) console.log('    ' + sc.slice(0, 120))
  await new Promise((r) => setTimeout(r, 800))
  await show(sess, 'after generate')

  const home = await netFetch(sess, 'https://www.taobao.com/')
  console.log(`  taobao.com status=${home.status} set-cookie=${home.setCookie.length} 条`)
  await new Promise((r) => setTimeout(r, 800))
  await show(sess, 'after taobao.com')

  console.log('\n=== B. 同一分区用隐藏窗口加载页面，Cookie 是否共享 ===')
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: 'persist:probe-netcookie', offscreen: true, sandbox: true }
  })
  win.webContents.setUserAgent(UA)
  await win.loadURL('https://www.taobao.com/').catch(() => undefined)
  await new Promise((r) => setTimeout(r, 3000))
  const ck = await show(sess, 'after window load')
  console.log('  有 unb？', ck.some((c) => c.name === 'unb'))
  console.log('  有 _tb_token_？', ck.some((c) => c.name === '_tb_token_'))

  app.quit()
})
