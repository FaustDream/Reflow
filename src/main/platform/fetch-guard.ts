/**
 * 抓取风控守卫（2026-10-30 安全性评估后的加固层）。
 *
 * 四件事，对应评估报告里的 A/B/C/D：
 * - A 增量判定：`coveredMonthKeys` 给出「本地缓存已覆盖且不属于近 N 个月」的月份集合，
 *   编排层据此跳过这些月份的请求（稳态请求量从几十~上百降到个位数）。
 * - B 风控识别+冷却：`detectRiskText/detectRiskStatus` 认限流/人机验证信号；命中即
 *   `setCooldown` 落盘 2h 冷却，冷却期内拒绝触发——被风控注意到时的正确行为是退让。
 * - C 人类化节奏：`humanGap` 把固定间隔变成随机区间，`restGap` 提供翻页间的长停顿，
 *   抹掉机器流量的周期签名。
 * - D 每日预算：`chargeRequest` 按平台每日计数，超预算抛错熔断，防用户连点叠加密度。
 *
 * 状态落盘在 userData/fetch-guard.json（冷却截止时间 + 每日计数），重启不丢。
 * 目录可被 `initGuardDir` 覆盖（单测用），未初始化时才回落到 app.getPath('userData')。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 命中风控后的冷却时长：2 小时 */
export const COOLDOWN_MS = 2 * 60 * 60 * 1000
/** 近 N 个月不做增量跳过（状态可能还在流转，始终全量刷新） */
export const RECENT_FULL_MONTHS = 3

/** 每平台每日请求预算：评估后定的密度上限，改大等于主动靠近风控 */
const DAILY_BUDGET: Record<string, number> = {
  taobao: 150,
  xianyu: 150,
  'xianyu-sold': 150,
  jd: 200
}
const DEFAULT_DAILY_BUDGET = 120

interface GuardState {
  /** platform -> 冷却截止 epoch ms */
  cooldowns: Record<string, number>
  /** platform -> { 日期 YYYY-MM-DD, 当日已用请求数 } */
  budget: Record<string, { date: string; count: number }>
}

const EMPTY_STATE: GuardState = { cooldowns: {}, budget: {} }

let stateDir: string | null = null
let cache: GuardState | null = null

/** 单测/自检注入状态目录；不调用则回落到 userData */
export function initGuardDir(dir: string): void {
  stateDir = dir
  cache = null
}

function statePath(): string {
  const dir = stateDir ?? app.getPath('userData')
  return join(dir, 'fetch-guard.json')
}

function load(): GuardState {
  if (cache) return cache
  try {
    const data = JSON.parse(readFileSync(statePath(), 'utf-8')) as Partial<GuardState>
    cache = {
      cooldowns: data?.cooldowns ?? {},
      budget: data?.budget ?? {}
    }
  } catch {
    cache = { ...EMPTY_STATE, cooldowns: {}, budget: {} }
  }
  return cache
}

function save(): void {
  try {
    writeFileSync(statePath(), JSON.stringify(cache ?? EMPTY_STATE, null, 1), 'utf-8')
  } catch {
    /* 落盘失败不影响本次会话 */
  }
}

/** 冷却期内触发抓取时抛出 */
export class CooldownActiveError extends Error {
  constructor(
    public readonly platform: string,
    public readonly until: number
  ) {
    super(`命中风控冷却期，${new Date(until).toLocaleTimeString()} 后可再试`)
    this.name = 'CooldownActiveError'
  }
}

/** 每日预算用完时抛出 */
export class BudgetExceededError extends Error {
  constructor(public readonly platform: string) {
    super('今日抓取请求预算已用完，明天再试（或在设置里理解这是保护账号的熔断）')
    this.name = 'BudgetExceededError'
  }
}

/** 命中平台限流/人机验证信号时抛出 */
export class RiskControlError extends Error {
  constructor(
    public readonly platform: string,
    public readonly marker: string
  ) {
    super(`平台返回风控信号（${marker}），已停止抓取并进入冷却`)
    this.name = 'RiskControlError'
  }
}

/** 增量抓取的正常早停（不是错误，编排层按成功收尾） */
export class EarlyStopError extends Error {
  constructor(public readonly platform: string) {
    super('增量抓取：翻到本地缓存已覆盖的订单，提前停止')
    this.name = 'EarlyStopError'
  }
}

/**
 * 风控信号识别。只认高置信度标记：mtop 限流/人机验证系、京东系验证码跳转、
 * 通用 HTTP 限流语义。宁可漏认（继续抓）也不误认（把正常响应当风控停跑）。
 */
const RISK_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/FAIL_SYS_TRAFFIC_LIMIT/i, 'mtop 限流'],
  [/FAIL_SYS_FLOW_LIMIT/i, 'mtop 流控'],
  [/FAIL_SYS_USER_VALIDATE/i, 'mtop 人机验证'],
  [/RGV587/i, '阿里风控跳转'],
  [/FAIL_SYS_API_STOP_SERVICE/i, 'mtop 接口停用'],
  [/too\s+many\s+requests/i, 'HTTP 限流语义']
]

export function detectRiskText(text: string): string | null {
  for (const [re, label] of RISK_TEXT_PATTERNS) {
    if (re.test(text)) return label
  }
  return null
}

/** 419/420 是电商系常用的「需要验证/限流」状态码 */
export function detectRiskStatus(status: number): string | null {
  if (status === 419 || status === 420) return `HTTP ${status}`
  return null
}

/** 冷却期内抛 CooldownActiveError；编排层在 handler 入口调用 */
export function assertCooldown(platform: string, now: number = Date.now()): void {
  const until = load().cooldowns[platform] ?? 0
  if (until > now) throw new CooldownActiveError(platform, until)
}

export function cooldownUntil(platform: string): number {
  return load().cooldowns[platform] ?? 0
}

export function setCooldown(platform: string, ms: number = COOLDOWN_MS, now: number = Date.now()): number {
  const until = now + ms
  load().cooldowns[platform] = until
  save()
  return until
}

export function clearCooldown(platform: string): void {
  delete load().cooldowns[platform]
  save()
}

export function dailyBudgetOf(platform: string): number {
  return DAILY_BUDGET[platform] ?? DEFAULT_DAILY_BUDGET
}

function todayKey(now: number = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当日剩余预算（不修改状态） */
export function budgetLeft(platform: string, now: number = Date.now()): number {
  const entry = load().budget[platform]
  const count = entry?.date === todayKey(now) ? entry.count : 0
  return Math.max(0, dailyBudgetOf(platform) - count)
}

/**
 * 发请求前计费：超预算抛 BudgetExceededError。
 * 页内脚本那种「一次执行内部发 N 个请求」的通道改用 `addUsage` 事后记账 +
 * 把 `budgetLeft` 作为上限传进脚本自限。
 */
export function chargeRequest(platform: string, now: number = Date.now()): void {
  const state = load()
  const key = todayKey(now)
  const entry = state.budget[platform]
  const count = entry?.date === key ? entry.count : 0
  if (count + 1 > dailyBudgetOf(platform)) throw new BudgetExceededError(platform)
  state.budget[platform] = { date: key, count: count + 1 }
  save()
}

/** 事后记账（不抛错）：页内脚本回报实际请求数时用 */
export function addUsage(platform: string, n: number, now: number = Date.now()): void {
  if (n <= 0) return
  const state = load()
  const key = todayKey(now)
  const entry = state.budget[platform]
  const count = entry?.date === key ? entry.count : 0
  state.budget[platform] = { date: key, count: count + n }
  save()
}

/** C：固定间隔 → 0.8x~2.0x 随机区间（500ms 基 → 400~1000ms） */
export function humanGap(baseMs: number): number {
  return Math.round(baseMs * 0.8 + Math.random() * baseMs * 1.2)
}

/** C：每若干页一次的长停顿（3~8s），模拟人翻着翻着停下来看 */
export function restGap(): number {
  return 3000 + Math.round(Math.random() * 5000)
}

/** 两次长停顿之间的页数间隔（5~8 页） */
export function restEvery(): number {
  return 5 + Math.floor(Math.random() * 4)
}

/** A：订单 createdAt（'YYYY-MM-DD ...'）所属月份键 */
export function monthKeyOfCreatedAt(createdAt: string): string | null {
  const m = /^(\d{4}-\d{2})/.exec(createdAt ?? '')
  return m ? m[1] : null
}

/** 月份区间起始 ts → 月份键（与 taobao-fetch 的 monthRange 同口径） */
export function monthKeyOfRangeStart(startTs: number): string {
  const d = new Date(startTs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * A：本地缓存已覆盖的月份集合。
 * 覆盖 = 该月至少有 1 单缓存；近 RECENT_FULL_MONTHS 个月永远不算覆盖（状态还在流转）。
 * `monthIndex` 从 0（当月）起，与抓取循环同序。
 */
export function coveredMonthKeys(
  cachedOrders: Array<{ createdAt?: string | null }>,
  monthIndexToStartTs: (monthIndex: number) => number,
  totalMonths: number,
  now: number = Date.now()
): Set<string> {
  const counts = new Map<string, number>()
  for (const o of cachedOrders) {
    const key = o?.createdAt ? monthKeyOfCreatedAt(o.createdAt) : null
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const covered = new Set<string>()
  for (let m = 0; m < totalMonths; m++) {
    if (m < RECENT_FULL_MONTHS) continue
    const key = monthKeyOfRangeStart(monthIndexToStartTs(m))
    if ((counts.get(key) ?? 0) > 0) covered.add(key)
  }
  void now
  return covered
}
