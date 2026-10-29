/**
 * 登录能力深度探测：找出还有哪些平台能做「纯二维码」。
 *
 * 重点验证：
 *  1. 饿了么 mtop.alsc 接口是否接受淘宝登录态（若可以，淘宝扫码 = 饿了么也能用）
 *  2. 得物 H5 是否有二维码登录路由（不止首页的「扫码下载」）
 *  3. 美团/快手是否有可用的 Web 登录入口
 *  4. 阿里统一登录能否同时覆盖 淘宝/闲鱼/1688/饿了么
 *
 * 运行：npx electron scripts/login-probe.cjs
 */
const { app, BrowserWindow, session, net } = require('electron')
const path = require('path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()

function netFetch(sess, url, headers = {}) {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url, session: sess, useSessionCookies: true, credentials: 'include' })
    req.setHeader('user-agent', UA)
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    const chunks = []
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
          buffer: Buffer.concat(chunks)
        })
      )
      res.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }))
    })
    req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message }))
    req.end()
  })
}

/** 探测某个页面里是否有登录相关路由/接口 */
async function probePage(name, url, { waitMs = 6000, partition } = {}) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      partition: partition || `persist:probe-${name}`,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const reqs = []
  const ses = win.webContents.session
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    if (/login|qr|scan|auth|passport|sso|oauth|signin/i.test(u) && !/\.(js|css|png|jpg|svg|woff2?)/.test(u)) {
      reqs.push(u.slice(0, 140))
    }
    cb({})
  })
  try {
    await win.loadURL(url).catch(() => undefined)
    await new Promise((r) => setTimeout(r, waitMs))
    const info = await win.webContents
      .executeJavaScript(
        `(() => {
      const t = (document.body.innerText || '');
      const links = [...document.querySelectorAll('a')].map(a => a.href).filter(Boolean);
      return {
        url: location.href,
        title: document.title,
        hasQr: /扫码|二维码/.test(t),
        hasLogin: /登录|登陆/.test(t),
        text: t.slice(0, 200).replace(/\\s+/g, ' '),
        loginLinks: links.filter(h => /login|signin|passport|auth/i.test(h)).slice(0, 5),
        canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
        imgs: [...document.querySelectorAll('img')].filter(i => i.naturalWidth >= 100 && i.naturalWidth <= 400)
          .map(i => ({ src: i.src.slice(0, 70), w: i.naturalWidth, h: i.naturalHeight })).slice(0, 5)
      };
    })()`
      )
      .catch((e) => ({ err: e.message }))
    const uniq = [...new Set(reqs)].slice(0, 10)
    return { ...info, loginRequests: uniq }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

app.whenReady().then(async () => {
  console.log('===== 1. 饿了么：能否复用淘宝登录态 =====')
  // 用同一个 partition 先看 mtop.alsc 对未登录请求的响应
  const elemeSess = session.fromPartition('persist:probe-eleme-shared')
  const elemeResp = await netFetch(
    elemeSess,
    'https://waimai-guide.ele.me/h5/mtop.alsc.personal.queryorderlist/1.0/?jsv=2.7.2&appKey=12574478&t=' +
      Date.now() +
      '&sign=x&v=1.0&type=json&dataType=json&api=mtop.alsc.personal.queryorderlist&data=%7B%7D'
  )
  console.log('  未登录 mtop.alsc 响应:', elemeResp.status, elemeResp.text.slice(0, 220))

  // 检查是否有 openapi 登录态校验接口
  const elemeUser = await netFetch(
    elemeSess,
    'https://waimai-guide.ele.me/h5/mtop.alsc.user.info.query/1.0/?jsv=2.7.2&appKey=12574478&t=' +
      Date.now() +
      '&sign=x&v=1.0&type=json&dataType=json&api=mtop.alsc.user.info.query&data=%7B%7D'
  )
  console.log('  饿了么用户信息接口:', elemeUser.status, elemeUser.text.slice(0, 200))

  console.log('\n===== 2. 得物 H5 登录路由 =====')
  for (const [name, url] of [
    ['dewu-login', 'https://m.dewu.com/login'],
    ['dewu-h5', 'https://m.dewu.com/'],
    ['dewu-passport', 'https://m.dewu.com/passport/login']
  ]) {
    const r = await probePage(name, url, { waitMs: 5000 })
    console.log(`  [${name}]`, JSON.stringify(r).slice(0, 400))
  }

  console.log('\n===== 3. 美团 Web 登录入口 =====')
  for (const [name, url] of [
    ['mt-passport', 'https://passport.meituan.com/account/unitivelogin'],
    ['mt-h5', 'https://h5.waimai.meituan.com/'],
    ['mt-wx', 'https://wx.waimai.meituan.com/']
  ]) {
    const r = await probePage(name, url, { waitMs: 5000 })
    console.log(`  [${name}]`, JSON.stringify(r).slice(0, 400))
  }

  console.log('\n===== 4. 快手 Web 登录 =====')
  for (const [name, url] of [
    ['ks-passport', 'https://passport.kuaishou.com/pc/account/login'],
    ['ks-mp', 'https://mp.kwaixiaodian.com/']
  ]) {
    const r = await probePage(name, url, { waitMs: 6000 })
    console.log(`  [${name}]`, JSON.stringify(r).slice(0, 400))
  }

  app.quit()
})
