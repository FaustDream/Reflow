/**
 * 抓取风控守卫单测（2026-10-30 加固层）。
 *
 * 状态落盘目录用 initGuardDir 指到临时目录，避免碰真实 userData；
 * 节奏类函数只断言区间（随机值不钉死）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BudgetExceededError,
  COOLDOWN_MS,
  CooldownActiveError,
  RECENT_FULL_MONTHS,
  addUsage,
  assertCooldown,
  budgetLeft,
  chargeRequest,
  clearCooldown,
  coveredMonthKeys,
  cooldownUntil,
  detectRiskStatus,
  detectRiskText,
  humanGap,
  initGuardDir,
  restEvery,
  restGap,
  setCooldown
} from '../fetch-guard'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reflow-guard-'))
  initGuardDir(dir)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('C：人类化节奏', () => {
  it('humanGap 落在 0.8x~2.0x 区间（抹掉周期签名但不拖慢抓取）', () => {
    for (let i = 0; i < 200; i++) {
      const g = humanGap(500)
      expect(g).toBeGreaterThanOrEqual(400)
      expect(g).toBeLessThanOrEqual(1000)
    }
  })

  it('restGap 落在 3~8s、restEvery 落在 5~8 页', () => {
    for (let i = 0; i < 100; i++) {
      expect(restGap()).toBeGreaterThanOrEqual(3000)
      expect(restGap()).toBeLessThanOrEqual(8000)
      expect(restEvery()).toBeGreaterThanOrEqual(5)
      expect(restEvery()).toBeLessThanOrEqual(8)
    }
  })
})

describe('B：风控识别与冷却', () => {
  it('认得 mtop 限流/人机验证/风控跳转标记', () => {
    expect(detectRiskText('ret: ["FAIL_SYS_TRAFFIC_LIMIT::流量限制"]')).toBe('mtop 限流')
    expect(detectRiskText('{"ret":["FAIL_SYS_USER_VALIDATE"]}')).toBe('mtop 人机验证')
    expect(detectRiskText('rgv587://captcha?x=1')).toBe('阿里风控跳转')
    expect(detectRiskText('Too Many Requests')).toBe('HTTP 限流语义')
  })

  it('正常业务响应不误认（含 SUCCESS 与session过期——过期不是风控）', () => {
    expect(detectRiskText('{"ret":["SUCCESS::调用成功"]}')).toBeNull()
    expect(detectRiskText('FAIL_SYS_SESSION_EXPIRED::Session 过期')).toBeNull()
    expect(detectRiskText('<html>订单列表</html>')).toBeNull()
  })

  it('419/420 认作限流状态码，200/302 不认', () => {
    expect(detectRiskStatus(419)).toBe('HTTP 419')
    expect(detectRiskStatus(420)).toBe('HTTP 420')
    expect(detectRiskStatus(200)).toBeNull()
    expect(detectRiskStatus(302)).toBeNull()
  })

  it('冷却：设置后 assert 抛错且带截止时间，过期后放行，可手动清除', () => {
    const now = Date.now()
    const until = setCooldown('taobao', COOLDOWN_MS, now)
    expect(cooldownUntil('taobao')).toBe(until)
    expect(() => assertCooldown('taobao', now + 1000)).toThrow(CooldownActiveError)
    expect(() => assertCooldown('taobao', until + 1)).not.toThrow()
    clearCooldown('taobao')
    expect(() => assertCooldown('taobao', now + 1000)).not.toThrow()
  })
})

describe('D：每日预算熔断', () => {
  it('超预算抛 BudgetExceededError，次日自动重置', () => {
    const now = new Date('2026-10-30T10:00:00+08:00').getTime()
    const left0 = budgetLeft('jd', now)
    expect(left0).toBe(200)
    chargeRequest('jd', now)
    expect(budgetLeft('jd', now)).toBe(199)
    addUsage('jd', 199, now)
    expect(budgetLeft('jd', now)).toBe(0)
    expect(() => chargeRequest('jd', now)).toThrow(BudgetExceededError)
    // 次日重置
    const nextDay = now + 24 * 60 * 60 * 1000
    expect(budgetLeft('jd', nextDay)).toBe(200)
    expect(() => chargeRequest('jd', nextDay)).not.toThrow()
  })
})

describe('A：增量覆盖判定', () => {
  const startOf = (m: number): number => {
    const now = new Date('2026-10-30T12:00:00+08:00')
    return new Date(now.getFullYear(), now.getMonth() - m, 1).getTime()
  }

  it('有缓存的旧月算覆盖，近 3 个月与无缓存月不算', () => {
    const cached = [
      { createdAt: '2026-05-12 10:00:00' },
      { createdAt: '2026-10-01 09:00:00' },
      { createdAt: '2026-09-15 09:00:00' }
    ]
    const covered = coveredMonthKeys(cached, startOf, 12)
    // 2026-05 距当月 5 个月且有缓存 → 覆盖
    expect(covered.has('2026-05')).toBe(true)
    // 2026-10（当月）/2026-09（上月）在近 RECENT_FULL_MONTHS 内 → 不覆盖
    expect(covered.has('2026-10')).toBe(false)
    expect(covered.has('2026-09')).toBe(false)
    // 2026-08 无缓存 → 不覆盖（要抓）
    expect(covered.has('2026-08')).toBe(false)
  })

  it('RECENT_FULL_MONTHS 边界：第 3 个月开始才可能覆盖', () => {
    const cached = [{ createdAt: '2026-07-01 00:00:00' }]
    const covered = coveredMonthKeys(cached, startOf, 12)
    expect(covered.has('2026-07')).toBe(true)
    expect(RECENT_FULL_MONTHS).toBe(3)
  })
})
