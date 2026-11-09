/**
 * 淘宝登录取证：两条路径到底哪条能走通。
 *
 * 目的（2026-10-26 用户实测「扫码后登录没成功」）：
 *  1. 验证原生接口 `generateQRCode4Login.do` / `qrcodeLoginCheck.do` 的真实返回结构
 *     —— 现有代码按 `code` 字段分支，必须先确认字段名与取值没变。
 *  2. 验证 `login.taobao.com/member/login.jhtml` 登录页能否**提取出二维码**
 *     —— 若能，就走和京东/拼多多同一条 `dom` 路径（页面自己完成登录、Cookie 齐全），
 *        比手工拼 native 轮询可靠得多。
 *
 * 用独立 userData，避免与正在运行的应用争抢分区锁。
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/taobao-login-probe.cjs
 */
const { app, BrowserWindow, session, net } = require('electron')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const OUT = []
const log = (...args) => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  OUT.push(line)
  console.log(line)
}

app.setPath('userData', path.join(os.tmpdir(), `reflow-tb-probe-${Date.now()}`))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

function netFetch(sess, url) {
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
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }))
    })
    req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }))
    req.end()
  })
}

/** 与 qr-login.ts 里 SCRIPT_FIND_QR 等价的探测版：额外返回候选清单，便于判断为什么找不到 */
const SCRIPT_LIST_QR = `(() => {
  const MIN = 90, MAX = 460;
  const info = (el) => {
    const tag = el.tagName;
    const cls = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '') + '';
    const w = el.naturalWidth || el.width || el.clientWidth || 0;
    const h = el.naturalHeight || el.height || el.clientHeight || 0;
    const src = (el.currentSrc || el.src || '') + '';
    return { tag, cls: cls.slice(0, 60), w, h, src: src.slice(0, 90) };
  };
  const cands = [];
  document.querySelectorAll('canvas').forEach((el) => cands.push(el));
  document.querySelectorAll('img').forEach((el) => cands.push(el));
  const score = (el) => {
    const c = info(el);
    const hint = (c.cls + ' ' + (el.id||'') + ' ' + (el.alt||'') + ' ' + (el.title||'')).toLowerCase();
    let s = 0;
    if (/qr|qrcode|二维码|xcode/.test(hint)) s += 100;
    if (c.w >= MIN && c.w <= MAX && c.h >= MIN && c.h <= MAX) s += 30;
    if (c.w && c.h && Math.abs(c.w - c.h) / Math.max(c.w, c.h) < 0.12) s += 20;
    if (c.tag === 'CANVAS') s += 40;
    if (c.w < MIN || c.h < MIN) s -= 60;
    return s;
  };
  const scored = cands.map((el) => ({ s: score(el), ...info(el) })).sort((a, b) => b.s - a.s);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 6),
    text: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 400),
    top: scored.slice(0, 8)
  });
})()`

async function probeLoginPage() {
  log('\n=== [2] 登录页能否提取二维码 ===')
  const part = 'persist:probe-taobao'
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: part,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setUserAgent(UA)
  try {
    await win.loadURL('https://login.taobao.com/member/login.jhtml')
  } catch (e) {
    log('loadURL error:', e.message)
  }
  // 等页面 JS 渲染二维码
  for (const wait of [3000, 4000, 5000]) {
    await new Promise((r) => setTimeout(r, wait))
    try {
      const raw = await win.webContents.executeJavaScript(SCRIPT_LIST_QR)
      const data = JSON.parse(raw)
      log(`\n-- t=${wait}ms url=${data.url}`)
      log(`   title=${data.title}`)
      log(`   text=${data.text}`)
      log(`   iframes=${JSON.stringify(data.iframes)}`)
      log(`   top=${JSON.stringify(data.top)}`)
    } catch (e) {
      log('eval error:', e.message)
    }
  }
  const ses = win.webContents.session
  const ck = await ses.cookies.get({})
  log(`\n-- 登录页写下的 cookie: ${ck.length} 条`)
  log('   ' + ck.map((c) => `${c.domain}:${c.name}`).join(', '))
  if (!win.isDestroyed()) win.destroy()
}

async function probeNativeApi() {
  log('\n=== [1] 原生二维码接口真实返回 ===')
  const sess = session.fromPartition('persist:probe-native')
  const ts = Date.now()
  const gen =
    `https://qrlogin.taobao.com/qrcodelogin/generateQRCode4Login.do` +
    `?from=tb&appkey=00000000&_ksTS=${ts}_${ts % 10000}`
  const g = await netFetch(sess, gen)
  log(`generate status=${g.status} body=${g.text.slice(0, 400)}`)

  let lgToken = ''
  try {
    const j = JSON.parse(g.text)
    lgToken = j.lgToken || ''
    log(`  -> success=${j.success} lgToken=${lgToken ? lgToken.slice(0, 24) + '…' : ''} url=${(j.url || '').slice(0, 80)}`)
  } catch {
    log('  -> generate 返回不是 JSON')
  }
  if (!lgToken) return

  const chk =
    `https://qrlogin.taobao.com/qrcodelogin/qrcodeLoginCheck.do` +
    `?lgToken=${encodeURIComponent(lgToken)}&defaulturl=${encodeURIComponent('https://www.taobao.com')}` +
    `&_ksTS=${Date.now()}_1`
  const c = await netFetch(sess, chk)
  log(`check status=${c.status} body=${c.text.slice(0, 400)}`)
  try {
    const j = JSON.parse(c.text)
    log(`  -> code=${JSON.stringify(j.code)} message=${JSON.stringify(j.message)} keys=${Object.keys(j).join(',')}`)
  } catch {
    log('  -> check 返回不是 JSON（可能被风控重定向）')
  }
}

app.whenReady().then(async () => {
  try {
    await probeNativeApi()
  } catch (e) {
    log('native probe error:', e.message)
  }
  try {
    await probeLoginPage()
  } catch (e) {
    log('page probe error:', e.message)
  }
  const file = path.resolve('.scratch', 'taobao-login-probe.log')
  fs.writeFileSync(file, OUT.join('\n'), 'utf8')
  log('\nwritten:', file)
  app.quit()
})
