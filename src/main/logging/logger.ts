/**
 * 系统日志（2026-11-02）。
 *
 * 目标：出问题时不用猜 —— 每次抓取、登录、导出、缓存读写都在这里留一条，
 * 界面上有「运行日志」标签页实时看，磁盘上按天写 NDJSON，事后也能翻。
 *
 * 三条硬约束：
 * 1. **绝不写敏感值**：Cookie / token / 密码 / 收货地址这些键的值一律打码，
 *    只保留「有没有、几条、什么域名」这种可用于判断的信息。
 * 2. **不阻塞主流程**：写文件走队列 + 异步 append，失败只吞掉（日志不该把应用搞崩）。
 * 3. **有上限**：内存环形缓冲最多 3000 条，磁盘按天分文件、只留最近 7 天。
 */
import { app } from 'electron'
import { appendFile, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { LogEntry, LogLevel } from '../../shared/types'

const MAX_ENTRIES = 3000
const MAX_DETAIL = 2000
const KEEP_DAYS = 7

const entries: LogEntry[] = []
let seq = 0
let sink: ((entry: LogEntry) => void) | null = null
let logDir = ''
let writeChain: Promise<void> = Promise.resolve()
let pruning = false

/** 敏感键：命中就把值换成 ***（键名本身保留，方便判断"有没有"） */
const SECRET_KEY = /(cookie|token|ticket|lgtoken|session|authorization|password|passwd|secret|_tb_token_|unb|pin$)/i

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth > 4) return '[deep]'
  if (typeof value === 'string') {
    if (value.length > 500) {
      // 与渲染层同款：切点落在代理对中间会写出半个字符，日志里看着像乱码
      let end = 500
      const code = value.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
      return `${value.slice(0, end)}…(${value.length})`
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '***' : sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

function serializeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  try {
    const text = typeof detail === 'string' ? detail : JSON.stringify(sanitize(detail))
    if (!text || text === '{}') return undefined
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
  } catch {
    return '[unserializable]'
  }
}

function todayFile(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return join(logDir, `app-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}

function enqueueWrite(line: string): void {
  if (!logDir) return
  writeChain = writeChain
    .then(() => appendFile(todayFile(), line, 'utf8'))
    .then(async () => {
      if (pruning) return
      pruning = true
      try {
        const files = (await readdir(logDir))
          .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
          .sort()
        for (const old of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
          await unlink(join(logDir, old)).catch(() => undefined)
        }
      } finally {
        pruning = false
      }
    })
    .catch(() => {
      // 日志写失败不影响应用
    })
}

/** 初始化：建目录、记一条启动日志（幂等） */
export async function initLogging(): Promise<void> {
  try {
    logDir = join(app.getPath('userData'), 'logs')
    await mkdir(logDir, { recursive: true })
  } catch {
    logDir = ''
  }
  info('app', '日志系统就绪', { file: logDir ? todayFile() : '(内存模式)' })
}

/** 当前日志文件路径（界面展示 / 打开目录用） */
export function currentLogFile(): string {
  return logDir ? todayFile() : ''
}

export function currentLogDir(): string {
  return logDir
}

/** 注册实时订阅（主窗口 webContents 转发） */
export function setLogSink(fn: ((entry: LogEntry) => void) | null): void {
  sink = fn
}

function push(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    id: ++seq,
    ts: Date.now(),
    level,
    scope,
    message,
    ...(serializeDetail(detail) ? { detail: serializeDetail(detail) } : {})
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  try {
    sink?.(entry)
  } catch {
    // 转发失败不影响主流程
  }
  enqueueWrite(`${JSON.stringify(entry)}\n`)
  // 同步到 stdout：dev 时 electron-vite 会把它带出到终端，浏览器日志页也能看到
  const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase()} ${scope} ${message}`
  if (level === 'error') console.error(line, entry.detail ?? '')
  else if (level === 'warn') console.warn(line, entry.detail ?? '')
  else console.log(line, entry.detail ?? '')
}

export const debug = (scope: string, message: string, detail?: unknown): void =>
  push('debug', scope, message, detail)
export const info = (scope: string, message: string, detail?: unknown): void =>
  push('info', scope, message, detail)
export const warn = (scope: string, message: string, detail?: unknown): void =>
  push('warn', scope, message, detail)
export const error = (scope: string, message: string, detail?: unknown): void =>
  push('error', scope, message, detail)

export function listLogs(): LogEntry[] {
  return entries.slice()
}

export function clearLogs(): void {
  entries.length = 0
  info('app', '日志已清空（仅清空内存视图，磁盘文件保留）')
}
