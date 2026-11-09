/**
 * 登录策略表回归测试。
 *
 * 这里的断言来自**真实 Electron 环境实测**（scripts/qr-probe.cjs、dom-qr-probe.cjs），
 * 目的是防止以后有人「顺手」把某个平台从二维码改成网页登录，或反之。
 */
import { describe, expect, it } from 'vitest'
import { QR_STRATEGIES, isPureQr, supportsQrLogin } from '../qr-login'

describe('登录策略：能力分类', () => {
  it('淘宝走原生二维码接口；闲鱼 2026-11-01 起走小窗（原生接口无 goofish appKey，页面码又在跨域 iframe 里提取不到）', () => {
    expect(QR_STRATEGIES.taobao?.kind).toBe('native')
    expect(QR_STRATEGIES.taobao?.native).toBeDefined()
    expect(isPureQr('taobao')).toBe(true)
    expect(QR_STRATEGIES.xianyu?.kind).toBe('page')
    expect(QR_STRATEGIES.xianyu?.native).toBeUndefined()
    expect(isPureQr('xianyu')).toBe(false)
  })

  it('京东走 DOM 提取（原生接口被风控，登录页二维码可用）', () => {
    expect(QR_STRATEGIES.jd?.kind).toBe('dom')
    expect(QR_STRATEGIES.jd?.native).toBeUndefined()
    expect(isPureQr('jd')).toBe(true)
  })

  it('拼多多走 DOM 提取，且需要先点「扫码登录」页签', () => {
    expect(QR_STRATEGIES.pdd?.kind).toBe('dom')
    expect(QR_STRATEGIES.pdd?.clickText).toBe('扫码登录')
    expect(isPureQr('pdd')).toBe(true)
  })

  it('美团：网页端无登录二维码 → 小窗模式', () => {
    expect(QR_STRATEGIES.meituan?.kind).toBe('page')
    expect(isPureQr('meituan')).toBe(false)
  })

  it('纯二维码平台 3 个（京东 + 拼多多 + 淘宝）；闲鱼走小窗', () => {
    const pure = Object.keys(QR_STRATEGIES).filter((id) => isPureQr(id))
    expect(pure.sort()).toEqual(['jd', 'pdd', 'taobao'].sort())
  })

  it('每个平台都有登录入口 URL', () => {
    for (const [id, strategy] of Object.entries(QR_STRATEGIES)) {
      expect(strategy.loginUrl, id).toMatch(/^https:\/\//)
    }
  })
})

describe('登录策略：登录成功判定', () => {
  it('阿里系只认 unb 判定（tracknick 残留会假成功、cookie2 访客也有）', () => {
    for (const id of ['taobao', 'xianyu']) {
      const names = QR_STRATEGIES[id]?.successCookies?.map((c) => c.name) ?? []
      expect(names, id).toContain('unb')
      // 2026-11-02 故障：分区里残留旧 tracknick → finishLoginInWindow 的「已有凭据」直接放行，
      // 跳转没走完、unb 没落地，用户看到「登录成功」但抓取说没登录
      expect(names, id).not.toContain('tracknick')
      // 2026-10-26 故障：cookie2/tfstk 访客也有，拿它们判定会「假登录」
      expect(names, id).not.toContain('cookie2')
      // 2026-11-01 实测：goofish 登录后 unb/tracknick 落在 .goofish.com 域，
      // 只认 taobao 域会让闲鱼登录成功也永不判定
      if (id === 'xianyu') {
        const domains = QR_STRATEGIES[id]?.successCookies?.map((c) => c.domainIncludes) ?? []
        expect(domains.join('|'), id).toContain('goofish')
      }
      // 多条规则时必须 any（unb 可能落在 taobao / goofish 任一域）；
      // 淘宝收紧成单条后默认 all 即可
      const rules = QR_STRATEGIES[id]?.successCookies?.length ?? 0
      if (rules > 1) expect(QR_STRATEGIES[id]?.verifyMode, id).toBe('any')
    }
  })

  it('京东用 thor + pin 判定（与 cookie-login.ts 一致）', () => {
    const names = QR_STRATEGIES.jd?.successCookies?.map((c) => c.name) ?? []
    expect(names).toContain('thor')
    expect(names).toContain('pin')
    // 2026-10-31 故障：pin 是账号昵称，同一账号「重新登录」时值不变，
    // 默认 'all'（每条都要变）会永远判定不成功，弹窗卡死在等待扫码——必须 'any'。
    expect(QR_STRATEGIES.jd?.verifyMode).toBe('any')
  })

  it('拼多多用 PDDAccessToken 判定（与适配器登录态一致）', () => {
    expect(QR_STRATEGIES.pdd?.successCookies?.[0]?.name).toBe('PDDAccessToken')
  })

  it('pdd 保持「全部命中」语义（单 Cookie 下 all/any 等价，不误继承 any）', () => {
    expect(QR_STRATEGIES.pdd?.verifyMode).toBeUndefined()
  })
})

describe('登录策略：能力查询接口', () => {
  it('supportsQrLogin 覆盖全部 5 个业务平台，且不含 mock', () => {
    const ids = Object.keys(QR_STRATEGIES)
    expect(ids.sort()).toEqual(['jd', 'meituan', 'pdd', 'taobao', 'xianyu'].sort())
    for (const id of ids) expect(supportsQrLogin(id), id).toBe(true)
    expect(supportsQrLogin('mock')).toBe(false)
    // 2026-11-02：闲鱼卖家视角下线，未知 id 一律 false
    expect(supportsQrLogin('not-a-platform')).toBe(false)
  })
})
