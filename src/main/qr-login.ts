/**
 * 登录：**用户只需面对一个登录弹窗**。
 *
 * 三种实现路径，按平台能力自动选择（都已实测，见文末策略表）：
 *
 * A. `native` —— 直接调平台二维码接口（阿里系淘宝/闲鱼/1688）。
 *    无页面渲染、最快；Set-Cookie 正确落进目标 partition（已实测验证）。
 *
 * B. `dom` —— 隐藏窗口加载登录页，把页面渲染的二维码**提取出来**只显示二维码
 *    （京东、拼多多）。用户看不到网页，只看到码。
 *
 * C. `page` —— 平台网页端确实没有登录二维码（得物/快手/饿了么/美团），
 *    退而在**小弹窗**里加载其登录页。相比原来的整页 Tab 仍然是大幅简化：
 *    用户不必离开当前界面，登录完成自动关闭。
 *
 * 红线不变：不构造带签名的业务请求、不碰系统代理/证书、不读取用户密码。
 * 登录始终由平台官方页面/官方接口完成。
 */
import { BrowserWindow, net, session, type Session } from 'electron'
import { EventEmitter } from 'node:events'

/** 一次登录会话 */
export interface QrLoginSession {
  id: string
  platformId: string
  /** data:image/png;base64,... 或远端图片 URL；`page` 模式为空 */
  qrImage: string
  /** native = 原生接口；dom = 从登录页提取；page = 弹窗内网页登录 */
  source: 'native' | 'dom' | 'page'
}

export interface QrLoginStatus {
  state: 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'
  message: string
  /**
   * `waiting` 时若二维码已被页面刷新（过期换新），带上新图。
   *
   * 必须回传：平台会在二维码过期后自己换一张，渲染层若还显示旧图，
   * 用户扫的就是已作废的码 —— 手机提示「登录成功」，PC 端永远等不到确认
   * （2026-10-26 用户实测故障：京东扫码后毫无响应）。
   */
  qrImage?: string
}

/** 一条「登录凭据」判定条件 */
interface CookieRule {
  name: string
  domainIncludes: string
}

/** 平台登录策略 */
interface QrStrategy {
  /** A 路径：原生接口；缺省则走 B/C 路径 */
  native?: {
    /**
     * 生成二维码。`sess` 必须是目标 partition 的 session：
     * 二维码接口通常会在响应里 Set-Cookie，登录成功后的凭据也靠它写进去。
     */
    generate: (sess: Session) => Promise<{ image: string; ticket: string }>
    /**
     * 轮询扫码状态；同样走目标 session，成功后 Cookie 自动落盘。
     *
     * `partition` 必须传：扫码确认后要开隐藏窗口把登录跳转「走完」，
     * 只靠 HTTP 请求拿不到页面 JS 写的那批凭据（见 finishLoginInWindow）。
     */
    poll: (sess: Session, ticket: string, partition: string) => Promise<QrLoginStatus>
  }
  /** B/C 路径：登录页 URL（页面自身会渲染二维码或登录表单） */
  loginUrl: string
  /** 登录成功的判定 Cookie */
  successCookies?: CookieRule[]
  /**
   * `successCookies` 的语义：`all` 全部命中（默认）／`any` 任一命中。
   *
   * 阿里系必须用 `any`：淘宝登录态的标志是 `unb`（数字用户 id）**或** `tracknick`（昵称），
   * 不同入口下发的组合不一样，要求全中会永远判不出登录。
   */
  verifyMode?: 'all' | 'any'
  /** B 路径：进入二维码视图前需要点击的文案（如拼多多「扫码登录」页签） */
  clickText?: string
  /** C 路径：不提取二维码，直接把窗口展示给用户 */
  showWindow?: boolean
}

const ALIBABA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * 用 **Electron `net` + 指定 session** 发请求（而不是 Node fetch）。
 *
 * 这是原生路径成立的关键：平台在扫码成功后通过 **Set-Cookie** 下发登录凭据，
 * 只有请求走 Electron 的网络栈并绑定到目标 partition，Cookie 才会自动写入该会话，
 * 用户后续打开平台页/主动抓取才带着登录态。Node 的 fetch 会把这些 Cookie 丢掉。
 *
 * 注意两个必需项（实测踩过）：
 * - `useSessionCookies: true`：让本请求读写该 session 的 Cookie 罐（否则 Set-Cookie 直接丢弃）
 * - `credentials: 'include'`：允许跨域带上已有 Cookie
 */
function netFetch(
  sess: Session,
  url: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; text: string; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      session: sess,
      useSessionCookies: true,
      credentials: 'include'
    })
    // net.request 默认没有超时：平台偶发不响应时轮询会永久挂住，
    // 界面就一直停在「等待扫码」。15 秒兜底。
    const timer = setTimeout(() => {
      request.abort()
      reject(new Error('请求超时'))
    }, 15_000)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      fn()
    }
    request.setHeader('user-agent', ALIBABA_UA)
    for (const [k, v] of Object.entries(extraHeaders)) request.setHeader(k, v)
    const chunks: Buffer[] = []
    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        done(() => resolve({ status: response.statusCode, text: buffer.toString('utf8'), buffer }))
      })
      response.on('error', (err) => done(() => reject(err)))
    })
    request.on('error', (err) => done(() => reject(err)))
    request.end()
  })
}

/** 把 `//host/path` 补成 `https://host/path` */
function absolutize(url: string): string {
  if (!url) return ''
  return url.startsWith('//') ? `https:${url}` : url
}

/** 分区里是否已经出现任一「真登录」凭据 */
async function hasAnyCookie(partition: string, rules: CookieRule[]): Promise<boolean> {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({})
    return rules.some((r) =>
      cookies.some((c) => c.name === r.name && (c.domain ?? '').includes(r.domainIncludes))
    )
  } catch {
    return false
  }
}

/**
 * 给 Promise 加超时（超时返回 null，不抛错）。
 *
 * `webContents.loadURL` 没有超时：跳转页若卡在某个资源上，会把整个扫码轮询拖住，
 * 界面就永远停在「已扫描，请在手机上确认」。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
  ])
}

/**
 * 用**隐藏窗口**把登录跳转走完，直到凭据真正落地。
 *
 * 为什么不能只发 HTTP 请求（2026-10-26 实测踩过）：
 * 阿里扫码确认后 `qrcodeLoginCheck` 只给一个跳转地址，那个地址的响应里
 * 顶多带 `Set-Cookie: cookie2/t`；而 `tracknick`、`_l_g_`、`lgc`、`cookie17`、`uc1/uc3/uc4`
 * 这批关键凭据是**登录页 JS 用 document.cookie 写进去的**，纯 HTTP 请求永远拿不到。
 * 结果就是：代码以为登录成功、界面也关了弹窗，但分区里没有 `unb`/`tracknick`，
 * 订单页立刻 302 回登录页 —— 用户看到的就是「扫了码但没登录成功」。
 *
 * 这里开一个不显示、但拥有正常视口（1280×900，不用 1px：会让懒加载/跳转失效）
 * 的窗口按顺序访问跳转地址 → 落地页，边访问边查凭据。
 */
async function finishLoginInWindow(
  partition: string,
  urls: string[],
  rules: CookieRule[],
  timeoutMs = 20_000
): Promise<boolean> {
  const targets = urls.filter((u) => /^https?:/.test(u))
  if (!targets.length) return false
  if (await hasAnyCookie(partition, rules)) return true

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const deadline = Date.now() + timeoutMs
  try {
    for (const url of targets) {
      if (win.isDestroyed()) break
      // 跳转页常常导航中断（302 链），loadURL 抛错属正常，忽略；卡住则 8 秒后继续
      await withTimeout(win.loadURL(url), 8000)
      // 页面 JS 写 cookie 需要一点时间，逐轮询
      while (Date.now() < deadline) {
        if (await hasAnyCookie(partition, rules)) return true
        if (win.isDestroyed()) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (Date.now() >= deadline) break
    }
    return await hasAnyCookie(partition, rules)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * 阿里系二维码登录（淘宝 / 闲鱼 / 1688 共用阿里登录体系）。
 *
 * `redirectTo` 决定扫码确认后登录凭据写到哪个域：
 * 淘宝必须落 taobao.com、1688 必须落 1688.com —— 之前三个平台都写死
 * `defaulturl=https://www.taobao.com`，1688 扫完码自然拿不到自己的凭据。
 */
function alibabaStrategy(
  loginUrl: string,
  opts: { redirectTo: string; verify: CookieRule[]; appKey?: string }
): QrStrategy {
  const appKey = opts.appKey ?? '00000000'
  return {
    loginUrl,
    verifyMode: 'any',
    successCookies: opts.verify,
    native: {
      async generate(sess) {
        const ts = Date.now()
        const url =
          `https://qrlogin.taobao.com/qrcodelogin/generateQRCode4Login.do` +
          `?from=tb&appkey=${appKey}&_ksTS=${ts}_${ts % 10000}`
        const res = await netFetch(sess, url)
        const data = JSON.parse(res.text) as { success?: boolean; lgToken?: string; url?: string }
        if (!data?.success || !data.lgToken || !data.url) {
          throw new Error('阿里二维码生成失败（平台接口返回异常）')
        }
        return { image: absolutize(data.url), ticket: data.lgToken }
      },
      async poll(sess, ticket, partition) {
        const url =
          `https://qrlogin.taobao.com/qrcodelogin/qrcodeLoginCheck.do` +
          `?lgToken=${encodeURIComponent(ticket)}&defaulturl=${encodeURIComponent(opts.redirectTo)}` +
          `&_ksTS=${Date.now()}_1`
        const res = await netFetch(sess, url)
        const data = JSON.parse(res.text) as {
          success?: boolean
          code?: string
          message?: string
          url?: string
          redirectUrl?: string
        }
        // 阿里返回码：10000 未扫码；10001 已扫待确认；10006 已确认；10004 过期
        switch (data?.code) {
          case '10000':
            return { state: 'waiting', message: '请使用 App 扫描二维码' }
          case '10001':
            return { state: 'scanned', message: '已扫描，请在手机上确认登录' }
          case '10006': {
            /**
             * 扫码确认后**必须把跳转走完**才会下发完整登录 Cookie。
             *
             * 这里不再「访问一下就算成功」：跳转地址里的令牌通常是一次性的，
             * 先用 net.request 访问会把它消耗掉，后面再开窗口就完不成了 ——
             * 所以直接交给隐藏窗口，一次走完跳转页 + 落地页，
             * **最后以分区里真的有 unb/tracknick 为准**。
             */
            const redirect = absolutize(data.url || data.redirectUrl || '')
            const urls = redirect ? [redirect, opts.redirectTo] : [opts.redirectTo]
            const ok = await finishLoginInWindow(partition, urls, opts.verify)
            return ok
              ? { state: 'success', message: '登录成功' }
              : {
                  state: 'failed',
                  message: '已确认登录，但登录态没写进本机（请刷新二维码重试）'
                }
          }
          case '10004':
            return { state: 'expired', message: '二维码已过期，请刷新' }
          default:
            return { state: 'waiting', message: data?.message || '等待扫码…' }
        }
      }
    }
  }
}

/**
 * 各平台策略表。
 *
 * **实测结论（真实 Electron 环境验证，见 scripts/qr-probe.cjs / dom-qr-probe.cjs）**：
 * - 阿里系（淘宝/闲鱼/1688）：原生 QR API 完全可用，且 Set-Cookie 正确落进 partition ✅
 * - 京东：原生 API 被风控拒绝（257），但登录页能提取出 147×147 二维码 ✅
 * - 拼多多：登录页有「扫码登录」页签，点击后生成 350×350 base64 二维码 ✅
 *   （文案为「在原设备上打开拼多多 APP 扫描」，属设备核对类扫码）
 * - 得物：网页只有「扫码下载 App」，**没有登录二维码** ❌
 * - 饿了么：H5 无二维码登录，走淘宝闪购/支付宝授权 ❌
 * - 快手：主站拒绝无头加载，需真实窗口 ⚠
 * - 美团：小程序 H5，无独立登录入口 ❌
 *
 * 因此策略是分层的：有原生/可提取二维码的走 `qr`；其余走 `page`（在**弹窗内**加载
 * 登录页，用户看到的是小弹窗而非整页应用，登录完成即自动关闭）。
 */
interface QrStrategyEntry {
  /** 二维码来源 */
  kind: 'native' | 'dom' | 'page'
  loginUrl: string
  /** 原生接口（仅阿里系） */
  native?: QrStrategy['native']
  /** 登录成功的判定 Cookie */
  successCookies?: CookieRule[]
  /** successCookies 的语义（默认 all） */
  verifyMode?: 'all' | 'any'
  /** DOM 路径：进入二维码视图前需要点击的文案（如拼多多「扫码登录」页签） */
  clickText?: string
}
export const QR_STRATEGIES: Record<string, QrStrategyEntry> = {
  // 阿里系共用阿里登录体系：同一二维码可登录淘宝/闲鱼/1688（Cookie 落各自 partition）
  // 判定凭据只认 unb / tracknick：cookie2、tfstk 访客也有，拿它们判定会「假登录」
  taobao: {
    kind: 'native',
    loginUrl: 'https://login.taobao.com/member/login.jhtml',
    native: alibabaStrategy('https://login.taobao.com/member/login.jhtml', {
      redirectTo: 'https://www.taobao.com',
      verify: [
        { name: 'unb', domainIncludes: 'taobao' },
        { name: 'tracknick', domainIncludes: 'taobao' }
      ]
    }).native,
    verifyMode: 'any',
    successCookies: [
      { name: 'unb', domainIncludes: 'taobao' },
      { name: 'tracknick', domainIncludes: 'taobao' }
    ]
  },
  xianyu: {
    kind: 'native',
    loginUrl: 'https://www.goofish.com/login',
    native: alibabaStrategy('https://www.goofish.com/login', {
      redirectTo: 'https://www.goofish.com',
      verify: [
        { name: 'unb', domainIncludes: 'taobao' },
        { name: 'tracknick', domainIncludes: 'taobao' }
      ]
    }).native,
    verifyMode: 'any',
    successCookies: [
      { name: 'unb', domainIncludes: 'taobao' },
      { name: 'tracknick', domainIncludes: 'taobao' }
    ]
  },
  // 京东：登录页可提取二维码（原生 API 被风控）
  jd: {
    kind: 'dom',
    loginUrl: 'https://passport.jd.com/new/login.aspx',
    successCookies: [
      { name: 'thor', domainIncludes: 'jd.com' },
      { name: 'pin', domainIncludes: 'jd.com' }
    ]
  },
  // 拼多多：需先点「扫码登录」页签
  pdd: {
    kind: 'dom',
    loginUrl: 'https://mobile.yangkeduo.com/login.html',
    clickText: '扫码登录',
    successCookies: [{ name: 'PDDAccessToken', domainIncludes: 'yangkeduo' }]
  },
  // 美团：passport 只提供手机验证码/账号密码登录，无二维码
  meituan: { kind: 'page', loginUrl: 'https://i.waimai.meituan.com/', successCookies: [] }
}

/** 该平台是否支持二维码登录（含弹窗内网页登录） */
export function supportsQrLogin(platformId: string): boolean {
  return platformId in QR_STRATEGIES
}

/** 该平台能否只显示二维码（无需展示任何网页） */
export function isPureQr(platformId: string): boolean {
  const kind = QR_STRATEGIES[platformId]?.kind
  return kind === 'native' || kind === 'dom'
}

// ---------------------------------------------------------------------------
// 会话管理
// ---------------------------------------------------------------------------

interface ActiveLogin {
  session: QrLoginSession
  strategy: QrStrategy & { kind: QrStrategyEntry['kind']; clickText?: string }
  partition: string
  /** B/C 路径的窗口（native 路径为空） */
  window: BrowserWindow | null
  timer: NodeJS.Timeout | null
  stopped: boolean
  /** 上一次推送的状态，用于去重（waiting/scanned 每 2 秒都会命中） */
  lastState?: QrLoginStatus['state']
  /** 二维码有效期截止时间：过了就报过期，不能无限轮询（用户会以为卡住） */
  deadline: number
  /** 轮询连续失败次数：接口被风控/返回非 JSON 时要报错，不能静默重试 */
  failures: number
}

/** 二维码有效时长：阿里/京东的码都是 2~3 分钟，取 150 秒 */
const QR_TTL_MS = 150_000
/** 连续失败多少次判定为「接口无响应」 */
const MAX_POLL_FAILURES = 5

/**
 * 登录服务。
 * 事件：`status`（QrLoginStatus & { id, platformId }）
 */
export class QrLoginService extends EventEmitter {
  private readonly active = new Map<string, ActiveLogin>()
  private seq = 0

  constructor(private readonly partitionFor: (platformId: string) => string) {
    super()
  }

  /**
   * 开始一次登录。
   * - native / dom：返回只含二维码的会话（UI 只显示码）
   * - page：返回 source='page' 且 qrImage 为空，UI 改为在弹窗内嵌 webview 加载登录页
   */
  async start(platformId: string): Promise<QrLoginSession> {
    const entryMeta = QR_STRATEGIES[platformId]
    if (!entryMeta) throw new Error(`平台 ${platformId} 不支持登录`)

    this.cancel(platformId)
    const id = `${platformId}-${++this.seq}`
    const partition = this.partitionFor(platformId)
    const sess = session.fromPartition(partition)
    const strategy = { ...entryMeta, successCookies: entryMeta.successCookies }

    if (entryMeta.kind === 'native' && entryMeta.native) {
      const { image, ticket } = await entryMeta.native.generate(sess)
      const entry: ActiveLogin = {
        session: { id, platformId, qrImage: image, source: 'native' },
        strategy,
        partition,
        window: null,
        timer: null,
        stopped: false,
        deadline: Date.now() + QR_TTL_MS,
        failures: 0
      }
      this.active.set(platformId, entry)
      this.pollNative(entry, ticket, sess)
      return entry.session
    }

    // page 模式：窗口直接可见，用户在小窗口里登录
    const showWindow = entryMeta.kind === 'page'
    const win = new BrowserWindow({
      show: showWindow,
      width: showWindow ? 520 : 1000,
      height: showWindow ? 680 : 720,
      title: showWindow ? `登录 ${platformId}` : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        offscreen: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.on('closed', () => {
      const cur = this.active.get(platformId)
      if (cur?.session.id === id) this.active.delete(platformId)
    })

    const entry: ActiveLogin = {
      session: { id, platformId, qrImage: '', source: showWindow ? 'page' : 'dom' },
      strategy,
      partition,
      window: win,
      timer: null,
      stopped: false,
      deadline: Date.now() + QR_TTL_MS,
      failures: 0
    }
    this.active.set(platformId, entry)

    await win.loadURL(strategy.loginUrl).catch(() => undefined)

    if (showWindow) {
      // 用户在小窗口里自行登录；这里只负责轮询登录成功并自动关窗
      this.pollDom(entry)
      return entry.session
    }

    // dom 模式：先尝试点开「扫码登录」页签（拼多多等）
    if (entryMeta.clickText) {
      await clickByText(win, entryMeta.clickText, 8000)
    }
    // 等待页面渲染出二维码（最多 20 秒）
    const qrImage = await extractQrFromWindow(win, 20_000)
    if (!qrImage) {
      this.dispose(entry)
      throw new Error('该平台登录页未提供二维码，请改用弹窗登录')
    }
    entry.session.qrImage = qrImage
    this.pollDom(entry)
    return entry.session
  }

  /** 取消一次登录（关闭窗口、清理定时器） */
  cancel(platformId: string): void {
    const entry = this.active.get(platformId)
    if (!entry) return
    this.dispose(entry)
    this.active.delete(platformId)
  }

  /** 当前进行中的登录（供 UI 恢复显示） */
  current(platformId: string): QrLoginSession | null {
    return this.active.get(platformId)?.session ?? null
  }

  /** page 模式下的窗口（渲染层需要把它嵌进弹窗时用不到：窗口已是独立小窗） */
  windowOf(platformId: string): BrowserWindow | null {
    return this.active.get(platformId)?.window ?? null
  }

  private dispose(entry: ActiveLogin): void {
    entry.stopped = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
    entry.window = null
  }

  private emitStatus(entry: ActiveLogin, status: QrLoginStatus): void {
    // waiting / scanned 每 2 秒都会重复命中，除二维码换新外不重复推送
    const repeated = entry.lastState === status.state && !status.qrImage
    if ((status.state === 'waiting' || status.state === 'scanned') && repeated) return
    entry.lastState = status.state

    this.emit('status', { id: entry.session.id, platformId: entry.session.platformId, ...status })
    if (status.state === 'success' || status.state === 'expired' || status.state === 'failed') {
      // 成功后不立刻销毁 DOM 窗口：Cookie 已落盘，但页面可能还在跳转。
      // 延迟关闭，确保 Set-Cookie 全部写入 partition。
      const win = entry.window
      entry.stopped = true
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      const platformId = entry.session.platformId
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.destroy()
        const cur = this.active.get(platformId)
        if (cur?.session.id === entry.session.id) this.active.delete(platformId)
      }, 1500)
    }
  }

  private pollNative(entry: ActiveLogin, ticket: string, sess: Session): void {
    const tick = async (): Promise<void> => {
      if (entry.stopped) return
      // 二维码过期就明确告诉用户，不要无限轮询让界面「假活着」
      if (Date.now() > entry.deadline) {
        this.emitStatus(entry, { state: 'expired', message: '二维码已过期，请点「刷新二维码」' })
        return
      }
      try {
        const status = await entry.strategy.native!.poll(sess, ticket, entry.partition)
        entry.failures = 0
        this.emitStatus(entry, status)
        if (entry.stopped) return
        // 未扫码时 1.5s 一次；已扫待确认时更快，减少用户等待感
        entry.timer = setTimeout(tick, status.state === 'scanned' ? 800 : 1500)
      } catch (err) {
        /**
         * 之前这里静默重试：接口返回非 JSON（被风控重定向）时会永远卡在「等待扫码」，
         * 用户扫完码毫无反应。现在计数，连续失败到阈值就报错并结束本次登录。
         */
        entry.failures += 1
        if (entry.failures >= MAX_POLL_FAILURES) {
          this.emitStatus(entry, {
            state: 'failed',
            message: `登录状态查询失败（${err instanceof Error ? err.message : String(err)}），请刷新二维码重试`
          })
          return
        }
        entry.timer = setTimeout(tick, 2500)
      }
    }
    void tick()
  }

  private pollDom(entry: ActiveLogin): void {
    const tick = async (): Promise<void> => {
      if (entry.stopped || !entry.window || entry.window.isDestroyed()) return
      try {
        // 1. Cookie 到位才算真登录完成（唯一可信判据）
        const ok = await this.checkCookieLogin(entry)
        if (ok) {
          this.emitStatus(entry, { state: 'success', message: '登录成功' })
          return
        }

        // 2. 页面文案：扫码后平台会提示「扫描成功，请在手机上确认」
        const pageState = await readLoginStateFromWindow(entry.window)
        if (pageState === 'scanned') {
          this.emitStatus(entry, { state: 'scanned', message: '已扫描，请在手机上确认登录' })
        } else if (pageState === 'expired') {
          this.emitStatus(entry, { state: 'expired', message: '二维码已失效，请点「刷新二维码」' })
          return
        }

        // 3. 二维码可能被页面换新：必须把新图推给界面，否则用户扫的是作废的码
        const fresh = await extractQrFromWindow(entry.window, 500)
        if (fresh && fresh !== entry.session.qrImage) {
          entry.session.qrImage = fresh
          this.emitStatus(entry, {
            state: 'waiting',
            message: '二维码已更新，请重新扫描',
            qrImage: fresh
          })
        }
        entry.timer = setTimeout(tick, 2000)
      } catch {
        entry.timer = setTimeout(tick, 3000)
      }
    }
    void tick()
  }

  /** 以 successCookies（或通用登录 Cookie）判定登录是否完成 */
  private async checkCookieLogin(entry: ActiveLogin): Promise<boolean> {
    const sess: Session = session.fromPartition(entry.partition)
    const cookies = await sess.cookies.get({})
    const required = entry.strategy.successCookies?.length
      ? entry.strategy.successCookies
      : [
          { name: 'thor', domainIncludes: 'jd.com' },
          { name: 'unb', domainIncludes: 'taobao' },
          { name: 'PDDAccessToken', domainIncludes: 'yangkeduo' }
        ]
    // 有明确 successCookies 时按 verifyMode 判定（阿里系是「任一命中」）
    if (entry.strategy.successCookies?.length) {
      const hit = (c: CookieRule): boolean =>
        cookies.some((k) => k.name === c.name && (k.domain ?? '').includes(c.domainIncludes))
      return entry.strategy.verifyMode === 'any'
        ? required.some(hit)
        : required.every(hit)
    }
    // page 模式且未配置判定 Cookie：轮询窗口 URL，离开登录入口页即视为登录完成
    // （用户在小窗里完成登录后，站点会跳转到它的主页/订单页）
    if (entry.window && !entry.window.isDestroyed()) {
      try {
        const url = entry.window.webContents.getURL()
        const loginEntry = entry.strategy.loginUrl
        // 当前 URL 与登录入口不同（域名或路径变了）→ 用户已经登录并跳转
        if (url && url !== loginEntry && !url.startsWith(loginEntry.split('?')[0])) {
          return true
        }
      } catch {
        /* 窗口销毁竞态，忽略 */
      }
    }
    // 兜底：任一通用登录 Cookie 出现
    return required.some((c) =>
      cookies.some((k) => k.name === c.name && (k.domain ?? '').includes(c.domainIncludes))
    )
  }
}

/**
 * 在页面里按可见文本点击元素（用于切到「扫码登录」页签）。
 * 只点叶子节点，避免命中包裹整块区域的容器。
 */
async function clickByText(win: BrowserWindow, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const script = `(() => {
    const target = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === target
    );
    if (!els.length) return false;
    const el = els[0];
    el.click();
    return true;
  })()`
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false
    try {
      const ok = (await win.webContents.executeJavaScript(script)) as boolean
      if (ok) {
        // 给页签切换后渲染二维码留时间
        await new Promise((r) => setTimeout(r, 1200))
        return true
      }
    } catch {
      /* 页面导航中会抛错 */
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

/**
 * 从窗口页面里提取二维码。
 *
 * 依次尝试：
 * 1. `<canvas>` → toDataURL（部分平台用 canvas 画二维码）
 * 2. `<img>`：src 是 data: 或 http(s) 图片，且尺寸/类名/alt 像二维码
 * 3. 元素的 CSS background-image
 *
 * 只返回「最像二维码」的那一张，避免把页面 logo 当二维码。
 */
async function extractQrFromWindow(win: BrowserWindow, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return null
    try {
      const result = (await win.webContents.executeJavaScript(SCRIPT_FIND_QR)) as string | null
      if (result) return result
    } catch {
      /* 页面导航中会抛错，继续重试 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/**
 * 页面内脚本：读登录页当前走到哪一步。
 * 只看可见文案，不点击、不构造请求。
 */
const SCRIPT_READ_LOGIN_STATE = `(() => {
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
  if (/扫描成功|请在手机上确认|已扫码/.test(text)) return 'scanned';
  if (/二维码已失效|二维码已过期|二维码过期/.test(text)) return 'expired';
  return 'waiting';
})()`

/**
 * 读登录页当前状态。
 *
 * 京东/拼多多/快手扫码成功后会把二维码区域换成提示文案
 *（京东是「扫描成功！请在手机上确认登录」）。
 * 不回传这一步，用户会以为扫完就完事了 —— 实际还差「在手机上点确认」。
 */
async function readLoginStateFromWindow(
  win: BrowserWindow
): Promise<'waiting' | 'scanned' | 'expired'> {
  try {
    const result = (await win.webContents.executeJavaScript(SCRIPT_READ_LOGIN_STATE)) as string
    return result === 'scanned' || result === 'expired' ? result : 'waiting'
  } catch {
    return 'waiting'
  }
}

/**
 * 页面内脚本：找最像二维码的元素并转成 data URL。
 *
 * 判定规则（按优先级打分）：
 * - canvas 且尺寸在 100~400 之间（二维码典型尺寸）
 * - img/img-webp：类名/alt/id 含 qr/qrcode/二维码，或尺寸接近正方形且 >= 100
 * - 背景图 URL 含 qr
 * 取分数最高者。必须自包含，不能引用外部变量。
 */
const SCRIPT_FIND_QR = `(() => {
  const MIN = 90, MAX = 460;
  const score = (el) => {
    const tag = el.tagName;
    const cls = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '') + '';
    const hint = (cls + ' ' + (el.id||'') + ' ' + (el.alt||'') + ' ' + (el.title||'')).toLowerCase();
    const src = ((el.currentSrc || el.src || '') + '');
    let s = 0;
    if (/qr|qrcode|二维码|xcode/.test(hint)) s += 100;
    // 阿里的真二维码图带 -xcode，静态插画/图标带 -tps-：
    // 淘宝登录页那张「怎么扫码登录?」插画 236×298 会靠 alt 命中 hint 抢到最高分，
    // 必须按 URL 特征压下去，否则提取到的是插画而不是二维码（2026-10-26 实测）。
    if (/-xcode/i.test(src)) s += 60;
    if (/-tps-|\\/tps\\//i.test(src)) s -= 120;
    const w = el.naturalWidth || el.width || el.clientWidth || 0;
    const h = el.naturalHeight || el.height || el.clientHeight || 0;
    if (w >= MIN && w <= MAX && h >= MIN && h <= MAX) s += 30;
    if (w && h && Math.abs(w - h) / Math.max(w, h) < 0.12) s += 20;
    // canvas 画出来的方形图基本就是二维码：淘宝登录页的码是 176×176 canvas，
    // 没有任何 class/alt 提示，旧权重下只有 90 分，会被上面的插画挤掉。
    if (tag === 'CANVAS') s += 120;
    // 页面角落的小图标一般不是二维码
    if (w < MIN || h < MIN) s -= 60;
    return s;
  };
  const cands = [];
  document.querySelectorAll('canvas').forEach((el) => cands.push(el));
  document.querySelectorAll('img').forEach((el) => cands.push(el));
  document.querySelectorAll('[style*="background"]').forEach((el) => cands.push(el));
  let best = null, bestScore = 0;
  for (const el of cands) {
    const s = score(el);
    if (s > bestScore) { bestScore = s; best = el; }
  }
  if (!best || bestScore < 100) return null;
  try {
    if (best.tagName === 'CANVAS') return best.toDataURL('image/png');
    if (best.tagName === 'IMG') {
      const src = best.currentSrc || best.src || '';
      if (src.startsWith('data:image')) return src;
      if (/^https?:/.test(src)) return src;
    }
    const bg = getComputedStyle(best).backgroundImage || '';
    const m = bg.match(/url\\(["']?(.+?)["']?\\)/);
    if (m && m[1]) return m[1];
  } catch (e) {}
  return null;
})()`
