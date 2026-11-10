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
import { debug, error, info, warn } from './logging/logger'

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
/** 当前分区里与 rules 相关的 Cookie 名（只报名字，不带值），排障用 */
async function cookieNames(partition: string): Promise<string[]> {
  try {
    const all = await session.fromPartition(partition).cookies.get({})
    return all.map((c) => `${c.name}@${c.domain ?? ''}`).sort().slice(0, 30)
  } catch {
    return []
  }
}

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
  if (!targets.length) {
    warn('login:window', '没有可用的跳转地址，登录凭据无法落地', { partition })
    return false
  }
  if (await hasAnyCookie(partition, rules)) {
    info('login:window', '分区里已有登录凭据，跳过落地跳转', {
      partition,
      rules: rules.map((r) => `${r.name}@${r.domainIncludes}`)
    })
    return true
  }
  info('login:window', '开始走登录跳转落地凭据', {
    partition,
    urls: targets.map((u) => u.slice(0, 100)),
    rules: rules.map((r) => `${r.name}@${r.domainIncludes}`)
  })

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
    const found = await hasAnyCookie(partition, rules)
    info('login:window', found ? '登录凭据已落地' : '跳转走完但凭据没落地', {
      found,
      cookies: await cookieNames(partition)
    })
    return found
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
            if (!ok) {
              return {
                state: 'failed',
                message: '已确认登录，但登录态没写进本机（请刷新二维码重试）'
              }
            }
            /**
             * 落地后二次确认（2026-11-02 用户实测「报成功但没登录」之后加的）：
             * 阿里登录页存在「先写 Cookie 再撤销」的情况（触发二次校验/风控时），
             * 窗口里能读到 unb，1~2 秒后又被页面 JS 删掉。
             * 只在写入瞬间判定就会报假成功，这里隔 1.5 秒复查一次。
             */
            await new Promise((r) => setTimeout(r, 1500))
            const stillThere = await hasAnyCookie(partition, opts.verify)
            info('login:window', stillThere ? '二次确认通过' : '二次确认失败：登录态被平台撤销', {
              partition,
              cookies: await cookieNames(partition)
            })
            return stillThere
              ? { state: 'success', message: '登录成功' }
              : {
                  state: 'failed',
                  message: '登录态写入后被平台撤销（可能触发了二次校验），请重新扫码'
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
  //
  // 成功判定**只认 unb**（账号数字 ID）。`tracknick` 是昵称 Cookie，掉登录后还会留很久：
  // 2026-11-02 用户实测「扫完码显示登录成功、但抓取说没登录」——
  // 分区里本来就有一个旧的 tracknick，`finishLoginInWindow` 的「已有凭据就直接返回成功」
  // 因此立刻放行，隐藏窗口根本没打开，跳转没走完，`unb`/`cookie2` 一个都没落地。
  // 现在只认 unb：旧昵称骗不过去，必须真的把登录跳转走完。
  taobao: {
    kind: 'native',
    loginUrl: 'https://login.taobao.com/member/login.jhtml',
    native: alibabaStrategy('https://login.taobao.com/member/login.jhtml', {
      redirectTo: 'https://www.taobao.com',
      verify: [{ name: 'unb', domainIncludes: 'taobao' }]
    }).native,
    successCookies: [{ name: 'unb', domainIncludes: 'taobao' }]
  },
  // 闲鱼：小窗模式（2026-11-01 定型）。三条路都试过不通后产品化：
  // 1) 原生 generateQRCode4Login.do 没有 goofish appKey（生成淘宝系码，闲鱼 App 扫不了）
  // 2) www.goofish.com/login 的码在跨域 iframe（passport.goofish.com/mini_login）里
  // 3) mini_login 默认停在短信页签，隐藏 canvas 的尺寸过不了找码脚本打分
  // 所以让用户在**可见小窗**里对着官方登录页操作（点「扫码登录」→ 闲鱼 App 扫），
  // 页面自己完成登录；成功判定走分区 Cookie（unb/tracknick 任一变化，与淘宝同源 SSO）。
  xianyu: {
    kind: 'page',
    loginUrl:
      'https://passport.goofish.com/mini_login.htm?lang=zh_cn&appName=xianyu&appEntrance=web&styleType=vertical',
    verifyMode: 'any',
    // 2026-11-01 用户实测：goofish 登录后 unb 落在 **.goofish.com** 域（不带 taobao 字样），
    // 只认 taobao 域会导致登录成功也永不判定 → 窗口不关、无反馈。
    // 同理只认 unb，昵称 Cookie 会残留、不能当凭据。
    successCookies: [
      { name: 'unb', domainIncludes: 'taobao' },
      { name: 'unb', domainIncludes: 'goofish' }
    ]
  },
  // 京东：登录页可提取二维码（原生 API 被风控）
  jd: {
    kind: 'dom',
    loginUrl: 'https://passport.jd.com/new/login.aspx',
    // verifyMode 必须 'any'：thor 每次登录都会换新，但 pin 是账号昵称，
    // 同一账号「重新登录」时值不变——默认 'all' 会永远判定不成功，弹窗卡死在等待扫码。
    verifyMode: 'any',
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
  /**
   * 启动时的成功 Cookie 快照（工单 041）：「重新登录」时旧会话的 Cookie 还在，
   * 只判存在会 0.8s 假成功闪退（京东实测）——success 要求 Cookie **值发生变化**。
   */
  baseline: Map<string, string>
  /**
   * 页面自己请求到的二维码图片字节（URL → data URL，由 webContents.debugger 抓取）。
   * 弹窗必须显示**页面正在轮询的那张码**：京东的 /show 响应与窗口会话 Cookie 绑定，
   * 弹窗自己重新请求会拿到另一个 token 的码（字节级实测不同，2026-11-01）。
   */
  readonly qrData: Map<string, string>
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
  /** start() 进行中的平台：cancel() 与 active.set() 之间有多个 await，快速连点
   * 会让两次 start 交错、先完成者的 entry 被后者覆盖成永不清理的幽灵轮询 */
  private readonly starting = new Set<string>()
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
    if (this.starting.has(platformId)) {
      throw new Error('正在启动登录，请稍候')
    }
    this.starting.add(platformId)
    try {
      return await this.startInner(platformId, entryMeta)
    } finally {
      this.starting.delete(platformId)
    }
  }

  private async startInner(
    platformId: string,
    entryMeta: QrStrategyEntry
  ): Promise<QrLoginSession> {
    info('login', `开始登录 ${platformId}`, {
      kind: entryMeta.kind,
      rules: (entryMeta.successCookies ?? []).map((r) => `${r.name}@${r.domainIncludes}`)
    })
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
        failures: 0,
        baseline: await this.snapshotSuccessCookies(sess, strategy.successCookies),
        qrData: new Map()
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
      failures: 0,
      baseline: await this.snapshotSuccessCookies(sess, strategy.successCookies),
      qrData: new Map()
    }
    // 必须在 loadURL 之前挂上：页面一加载就会请求二维码图，晚了抓不到那一次响应
    this.attachQrCapture(win, entry.qrData)
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
    const qrImage = await extractQrFromWindow(entry, 20_000)
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

  /**
   * 用 webContents.debugger 抓页面自己请求到的二维码图片字节。
   *
   * 弹窗要显示的是「页面正在轮询的那张码」：京东 /show 的响应与窗口会话 Cookie
   * 绑定，拿 URL 让弹窗重新请求会得到另一个 token 的码（字节级实测不同）。
   * 在 Network 层拦页面收到的图片响应体，按请求 URL 存进 entry.qrData。
   */
  private attachQrCapture(win: BrowserWindow, sink: Map<string, string>): void {
    const dbg = win.webContents.debugger
    try {
      dbg.attach('1.3')
    } catch (e) {
      return // 已附加或环境不支持：只剩 canvas 类平台可用（拼多多不受影响）
    }
    void dbg.sendCommand('Network.enable').catch(() => undefined)
    const urlByRequest = new Map<string, string>()
    const mimeByRequest = new Map<string, string>()
    dbg.on('message', (_event, method, params) => {
      const p = params as {
        requestId?: string
        request?: { url?: string }
        type?: string
        response?: { mimeType?: string }
      }
      if (method === 'Network.requestWillBeSent') {
        const url = String(p.request?.url ?? '')
        if (/^https?:/i.test(url)) urlByRequest.set(String(p.requestId), url)
      } else if (method === 'Network.responseReceived') {
        const reqId = String(p.requestId ?? '')
        if (p.type === 'Image' && urlByRequest.has(reqId)) {
          mimeByRequest.set(reqId, String(p.response?.mimeType ?? 'image/png'))
        }
      } else if (method === 'Network.loadingFinished') {
        const reqId = String(p.requestId ?? '')
        const url = urlByRequest.get(reqId)
        const mime = mimeByRequest.get(reqId)
        if (!url || !mime || !/^image\//i.test(mime)) return
        void dbg
          .sendCommand('Network.getResponseBody', { requestId: reqId })
          .then((body: unknown) => {
            const b = body as { base64Encoded?: boolean; body?: string }
            if (!b?.body) return
            const dataUrl = b.base64Encoded
              ? `data:${mime};base64,${b.body}`
              : `data:${mime};base64,${Buffer.from(b.body, 'binary').toString('base64')}`
            sink.set(url, dataUrl)
            // 只留最近几张，防止长挂涨内存
            if (sink.size > 8) {
              const first = sink.keys().next().value
              if (first !== undefined) sink.delete(first)
            }
          })
          .catch(() => undefined)
      }
    })
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

    // 登录流程的状态变化全部落日志：扫码→确认→落地凭据，哪一步卡住一眼能看到
    const scope = `login:${entry.session.platformId}`
    if (status.state === 'success') info(scope, '登录成功', { message: status.message })
    else if (status.state === 'failed') error(scope, '登录失败', { message: status.message })
    else if (status.state === 'expired') warn(scope, '二维码失效', { message: status.message })
    else if (status.state === 'scanned') info(scope, '已扫码，等待手机确认')

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
        if (status.state !== 'waiting') {
          debug('login', `${entry.session.platformId} 轮询`, { state: status.state, message: status.message })
        }
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
      // 与 pollNative 一致：超过有效期就明确报过期，不能无限轮询让界面「假活着」。
      // 页面自行换新码时下方会顺延 deadline，所以不影响「码还有效」的正常会话。
      if (Date.now() > entry.deadline) {
        this.emitStatus(entry, { state: 'expired', message: '二维码已过期，请点「刷新二维码」' })
        return
      }
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
        const fresh = await extractQrFromWindow(entry, 500)
        if (fresh && fresh !== entry.session.qrImage) {
          entry.session.qrImage = fresh
          // 新码 = 新的有效期
          entry.deadline = Date.now() + QR_TTL_MS
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

  /**
   * 启动登录时快照「成功 Cookie」的当前值：之后值**变化**才算新登录。
   * 没配置 successCookies（page 模式）时返回空 Map，不影响 URL 判定。
   */
  private async snapshotSuccessCookies(
    sess: Session,
    rules?: CookieRule[]
  ): Promise<Map<string, string>> {
    const baseline = new Map<string, string>()
    if (!rules?.length) return baseline
    try {
      const cookies = await sess.cookies.get({})
      for (const rule of rules) {
        const hit = cookies.find(
          (k) => k.name === rule.name && (k.domain ?? '').includes(rule.domainIncludes)
        )
        if (hit) baseline.set(rule.name, hit.value)
      }
    } catch {
      /* 读不到就当作没有旧会话 */
    }
    return baseline
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
      // 「重新登录」场景：旧会话的 Cookie 还在，值没变就不算新登录（否则弹窗闪退）
      const hit = (c: CookieRule): boolean =>
        cookies.some(
          (k) =>
            k.name === c.name &&
            (k.domain ?? '').includes(c.domainIncludes) &&
            entry.baseline.get(c.name) !== k.value
        )
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
 * 在窗口的所有 frame（主文档 + 子 frame）里找二维码元素。
 *
 * 闲鱼登录页的码在跨域 iframe（passport.goofish.com/mini_login）里，只扫主文档
 * 够不着——用 WebFrameMain 逐 frame 执行（Electron 28+ 支持，与进程隔离无关）。
 *
 * @param nudged 已尝试过「切到扫码页签」的 frame（每个只切一次，防止来回跳）
 */
function findQrOnce(
  win: BrowserWindow,
  nudged: Set<string>
): Promise<
  | { kind: 'data'; dataUrl: string }
  | { kind: 'rect'; src: string; x: number; y: number; width: number; height: number }
  | null
> {
  type Found =
    | { kind: 'data'; dataUrl: string }
    | { kind: 'rect'; src: string; x: number; y: number; width: number; height: number }
    | null
  const run = async (frame: { executeJavaScript: (code: string) => Promise<unknown> }): Promise<Found> => {
    try {
      return (await frame.executeJavaScript(SCRIPT_FIND_QR)) as Found
    } catch {
      return null // frame 分离/导航中
    }
  }
  return (async () => {
    const main = await run(win.webContents.mainFrame)
    if (main) return main
    for (const frame of win.webContents.mainFrame.frames) {
      let found = await run(frame)
      // 找不到码时先试试点「扫码登录」切换图标（闲鱼 mini_login 默认停在短信页签，
      // 二维码视图在 DOM 里但隐藏；阿里系切换图标的类名约定是 view-<tab 名>）
      if (!found && !nudged.has(frame.url)) {
        nudged.add(frame.url)
        try {
          await frame.executeJavaScript(
            `(() => { const el = document.querySelector('[class*="view-qrcode"], [class*="switch-tab"] [class*="qrcode"]'); if (el) { el.click(); return true } return false })()`
          )
          await new Promise((r) => setTimeout(r, 800))
          found = await run(frame)
        } catch {
          /* frame 分离 */
        }
      }
      if (found) return found
    }
    return null
  })()
}

async function extractQrFromWindow(entry: ActiveLogin, timeoutMs: number): Promise<string | null> {
  const win = entry.window
  const deadline = Date.now() + timeoutMs
  const nudged = new Set<string>()
  while (Date.now() < deadline) {
    if (!win || win.isDestroyed()) return null
    try {
      const found = await findQrOnce(win, nudged)
      if (found?.kind === 'data' && found.dataUrl) return found.dataUrl
      if (found?.kind === 'rect' && found.src) {
        // debugger 已抓到页面收到的字节 → 原样给弹窗（同一张码的保证就在这）。
        // 精确匹配失败时按「origin+路径」兜底：个别页面会给 img 加动态查询参数
        const data = entry.qrData.get(found.src)
        if (data) return data
        const path = found.src.split('?')[0]
        for (const [url, dataUrl] of entry.qrData) {
          if (url.split('?')[0] === path) return dataUrl
        }
      }
    } catch {
      /* 页面导航中会抛错，继续重试 */
    }
    await new Promise((r) => setTimeout(r, 400))
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
 * 读登录页当前状态（含子 frame）。
 *
 * 京东/拼多多/快手扫码成功后会把二维码区域换成提示文案
 *（京东是「扫描成功！请在手机上确认登录」）；闲鱼的文案在 mini_login iframe 里。
 * 不回传这一步，用户会以为扫完就完事了 —— 实际还差「在手机上点确认」。
 */
async function readLoginStateFromWindow(
  win: BrowserWindow
): Promise<'waiting' | 'scanned' | 'expired'> {
  const run = async (frame: { executeJavaScript: (code: string) => Promise<unknown> }): Promise<'waiting' | 'scanned' | 'expired'> => {
    try {
      const result = (await frame.executeJavaScript(SCRIPT_READ_LOGIN_STATE)) as string
      return result === 'scanned' || result === 'expired' ? result : 'waiting'
    } catch {
      return 'waiting'
    }
  }
  const main = await run(win.webContents.mainFrame)
  if (main !== 'waiting') return main
  for (const frame of win.webContents.mainFrame.frames) {
    const state = await run(frame)
    if (state !== 'waiting') return state
  }
  return 'waiting'
}

/**
 * 页面内脚本：找最像二维码的元素。
 *
 * 返回结构化结果而不是 URL（2026-11-01）：
 * - canvas → { kind:'data', dataUrl }（页面自己画的，转 data URL 无跨域问题；
 *   闲鱼 mini_login / 淘宝登录页的码都是 canvas）
 * - img 的 data: src → { kind:'data', dataUrl }
 * - img（http URL）或背景图 → { kind:'rect', src, x.. }，
 *   src 用于在 entry.qrData 里匹配 debugger 抓到的页面字节——
 *   **绝不返回 URL 让弹窗重新请求**：京东的码与窗口会话 Cookie 绑定，
 *   弹窗重取会拿到另一个 token 的码（字节级实测不同）。
 *
 * 判定规则（按优先级打分），必须自包含。
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
    // 用字符串匹配而不是正则：模板字面量 + 正则的反斜杠转义在注入链路上坏过一次
    //（bundle 里 "missing /" 语法错误，2026-11-01 实测），indexOf 无此隐患
    if (src.indexOf('-tps-') !== -1 || src.indexOf('/tps/') !== -1) s -= 120;
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
    if (best.tagName === 'CANVAS') {
      return { kind: 'data', dataUrl: best.toDataURL('image/png') };
    }
    if (best.tagName === 'IMG') {
      const raw = best.currentSrc || best.src || '';
      if (raw.startsWith('data:image')) return { kind: 'data', dataUrl: raw };
      // 解析成绝对 URL：Network 层记录的请求 URL 一定是绝对的，
      // DOM src 可能是协议相对（//qr.m.jd.com/...），直接拿会匹配不上
      const src = new URL(raw, location.href).href;
      const r = best.getBoundingClientRect();
      return { kind: 'rect', src, x: r.x, y: r.y, width: r.width, height: r.height };
    }
    const r = best.getBoundingClientRect();
    return { kind: 'rect', src: '', x: r.x, y: r.y, width: r.width, height: r.height };
  } catch (e) {}
  return null;
})()`
