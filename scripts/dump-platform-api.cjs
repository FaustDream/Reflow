/**
 * 订单接口取证脚本（诊断用，不参与打包）。
 *
 * 用真实的 persist:platform-<id> 分区（复用已登录 Cookie）在隐藏窗口里打开平台订单页，
 * 把页面自己发出的订单相关 XHR/Fetch 响应体 dump 到 .scratch/dump-<platform>.json。
 *
 * 目的：解决「明明登录了却没数据 / 只有订单号 / 只有 2 单」这类问题 ——
 * 光猜适配器的字段名永远猜不准，必须以真实响应为准。
 *
 * 实现说明：
 * - 不用 CDP 的 Network 域（本机 Network service 一 enable 就崩），改用 Page 域注入 hook：
 *   在文档创建前把 XHR/fetch 包一层，响应体存进 window.__dump。
 * - Electron 只接受一个位置参数（app 路径），额外位置参数会让它直接退出(127)，
 *   所以参数全部走环境变量。
 *
 * 用法：
 *   DUMP_PLATFORM=pdd DUMP_URL="https://..." DUMP_WAIT=10000 DUMP_SCROLL=1 \
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe \
 *     scripts/dump-platform-api.cjs --no-sandbox --disable-gpu
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const platform = process.env.DUMP_PLATFORM || 'taobao'
const waitMs = Number(process.env.DUMP_WAIT || 12000)
const doScroll = process.env.DUMP_SCROLL === '1'
const targetUrl = process.env.DUMP_URL || ''
const clickText = process.env.DUMP_CLICK || ''

const USER_DATA =
  process.env.DUMP_USER_DATA || path.join(process.env.APPDATA || '', '回流 Reflow')
app.setPath('userData', USER_DATA)
app.setPath('sessionData', USER_DATA)

const PARTITION = `persist:platform-${platform}`
const OUT = path.resolve('.scratch', `dump-${platform}.json`)
const LOG = path.resolve('.scratch', `dump-${platform}.log`)

const log = (...args) => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  try {
    fs.appendFileSync(LOG, line + '\n')
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => log('[uncaught]', String(e && e.stack ? e.stack : e)))
process.on('unhandledRejection', (e) => log('[unhandled]', String(e)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注入到页面主世界：记录订单相关 XHR/fetch 的响应体 */
const HOOK = `(() => {
  if (window.__reflowDumpInstalled) return 'already';
  window.__reflowDumpInstalled = true;
  window.__reflowDump = [];
  var LIMIT = 400000;
  var keep = function (u) { return /order|trade|querybought|waimai|ele\\.me|yangkeduo|mtop/i.test(u || ''); };
  var push = function (o) { try { if (window.__reflowDump.length < 120) window.__reflowDump.push(o); } catch (e) {} };
  try {
    var OX = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__ru = String(u || ''); this.__rm = m; return OX.apply(this, arguments);
    };
    var OS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      self.addEventListener('load', function () {
        try {
          if (!keep(self.__ru)) return;
          var t = self.responseType;
          var body = '';
          if (t === '' || t === 'text') body = String(self.responseText || '');
          else if (t === 'json') body = JSON.stringify(self.response || null);
          push({ u: self.__ru, m: self.__rm, s: self.status, ct: self.getResponseHeader('content-type') || '', b: body.slice(0, LIMIT) });
        } catch (e) { push({ u: self.__ru, err: String(e) }); }
      });
      return OS.apply(this, arguments);
    };
  } catch (e) {}
  try {
    var OF = window.fetch;
    if (OF) {
      window.fetch = function (input, init) {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        var p = OF.apply(this, arguments);
        try {
          p.then(function (r) {
            if (!keep(u)) return;
            r.clone().text().then(function (t) {
              push({ u: u, m: (init && init.method) || 'GET', s: r.status, ct: r.headers.get('content-type') || '', b: String(t).slice(0, LIMIT) });
            }).catch(function () {});
          }).catch(function () {});
        } catch (e) {}
        return p;
      };
    }
  } catch (e) {}
  return 'installed';
})()`

async function main() {
  log(`[start] platform=${platform} url=${targetUrl} userData=${app.getPath('userData')}`)
  const ses = session.fromPartition(PARTITION)
  const cookies = await ses.cookies.get({})
  const names = cookies.map((c) => c.name).sort()
  log(`[cookies] ${names.length} 个: ${names.slice(0, 40).join(', ')}`)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  const wc = win.webContents

  // 文档创建前注入（Page 域，不碰 Network 域）
  let injectedBeforeLoad = false
  try {
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
    injectedBeforeLoad = true
    log('[hook] addScriptToEvaluateOnNewDocument ok')
  } catch (e) {
    log('[hook] debugger 方式失败，改用加载后注入:', String(e))
  }

  log(`[load] ${targetUrl}`)
  await wc.loadURL(targetUrl).catch((e) => log('[load-error]', String(e)))
  await sleep(2500)
  log('[href]', wc.getURL())

  if (!injectedBeforeLoad) {
    const r = await wc.executeJavaScript(HOOK, true).catch((e) => String(e))
    log('[hook] late inject:', r)
  }

  if (clickText) {
    const clicked = await wc
      .executeJavaScript(
        `(() => {
          const t = ${JSON.stringify(clickText)};
          const els = Array.from(document.querySelectorAll('div,span,a,button,li'));
          const el = els.find(e => (e.innerText || '').trim() === t);
          if (!el) return 'not-found';
          el.click();
          return 'clicked';
        })()`,
        true
      )
      .catch((e) => String(e))
    log('[click]', clickText, clicked)
    await sleep(3000)
  }

  if (doScroll) {
    for (let i = 0; i < 6; i++) {
      await wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight); 1', true)
      await sleep(1200)
    }
  }
  await sleep(waitMs)

  const text = await wc
    .executeJavaScript('(document.body && document.body.innerText || "").slice(0, 800)', true)
    .catch(() => '')
  log('[text]', JSON.stringify(text.slice(0, 300)))

  const raw = await wc
    .executeJavaScript('JSON.stringify(window.__reflowDump || [])', true)
    .catch((e) => `[] /* ${String(e)} */`)
  let hits = []
  try {
    hits = JSON.parse(raw)
  } catch (e) {
    log('[parse-dump-fail]', String(e), String(raw).slice(0, 200))
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        platform,
        partition: PARTITION,
        finalUrl: wc.getURL(),
        cookieNames: names,
        pageText: text,
        hits
      },
      null,
      1
    ),
    'utf8'
  )
  log(`[done] ${hits.length} 个响应 -> ${OUT}`)
  for (const h of hits.slice(0, 50)) {
    log(`  ${h.s || '-'} ${String(h.b || '').length}b ${String(h.u).slice(0, 140)}`)
  }
  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((e) => {
    log('[fatal]', String(e && e.stack ? e.stack : e))
    app.exit(1)
  })
)
