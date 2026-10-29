/**
 * 登录策略表回归测试。
 *
 * 这里的断言来自**真实 Electron 环境实测**（scripts/qr-probe.cjs、dom-qr-probe.cjs），
 * 目的是防止以后有人「顺手」把某个平台从二维码改成网页登录，或反之。
 */
import { describe, expect, it } from 'vitest'
import { QR_STRATEGIES, isPureQr, supportsQrLogin } from '../qr-login'

describe('登录策略：能力分类', () => {
  it('阿里系两平台走原生二维码接口（实测可用，Set-Cookie 正确落盘）', () => {
    for (const id of ['taobao', 'xianyu']) {
      expect(QR_STRATEGIES[id]?.kind, id).toBe('native')
      expect(QR_STRATEGIES[id]?.native, id).toBeDefined()
      expect(isPureQr(id), id).toBe(true)
    }
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

  it('纯二维码平台 4 个（京东 + 拼多多 + 淘宝 + 闲鱼）', () => {
    const pure = Object.keys(QR_STRATEGIES).filter((id) => isPureQr(id))
    expect(pure.sort()).toEqual(['jd', 'pdd', 'taobao', 'xianyu'].sort())
  })

  it('每个平台都有登录入口 URL', () => {
    for (const [id, strategy] of Object.entries(QR_STRATEGIES)) {
      expect(strategy.loginUrl, id).toMatch(/^https:\/\//)
    }
  })
})

describe('登录策略：登录成功判定', () => {
  it('阿里系用 unb/tracknick 判定（访客也有的 cookie2 不能用来判定）', () => {
    for (const id of ['taobao', 'xianyu']) {
      const names = QR_STRATEGIES[id]?.successCookies?.map((c) => c.name) ?? []
      expect(names, id).toContain('unb')
      expect(names, id).toContain('tracknick')
      // 2026-10-26 故障：cookie2/tfstk 访客也有，拿它们判定会「假登录」
      expect(names, id).not.toContain('cookie2')
      expect(QR_STRATEGIES[id]?.verifyMode, id).toBe('any')
    }
  })

  it('京东用 thor + pin 判定（与 cookie-login.ts 一致）', () => {
    const names = QR_STRATEGIES.jd?.successCookies?.map((c) => c.name) ?? []
    expect(names).toContain('thor')
    expect(names).toContain('pin')
  })

  it('拼多多用 PDDAccessToken 判定（与适配器登录态一致）', () => {
    expect(QR_STRATEGIES.pdd?.successCookies?.[0]?.name).toBe('PDDAccessToken')
  })

  it('非阿里系保持「全部命中」语义（不误继承 any）', () => {
    for (const id of ['jd', 'pdd']) {
      expect(QR_STRATEGIES[id]?.verifyMode, id).toBeUndefined()
    }
  })
})

describe('登录策略：能力查询接口', () => {
  it('supportsQrLogin 覆盖全部 5 个业务平台，且不含 mock', () => {
    const ids = Object.keys(QR_STRATEGIES)
    expect(ids.sort()).toEqual(['jd', 'meituan', 'pdd', 'taobao', 'xianyu'].sort())
    for (const id of ids) expect(supportsQrLogin(id), id).toBe(true)
    expect(supportsQrLogin('mock')).toBe(false)
    expect(supportsQrLogin('xianyu-sold')).toBe(false)
  })
})
