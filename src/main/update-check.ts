/**
 * 检查更新与更新记录（2026-11-12）。
 *
 * 为什么自己做而不是 electron-updater：
 * 发版走 `.github/workflows/release.yml` 手动下载（electron-builder.yml 里 `publish: null`），
 * 安装包未做代码签名、还提供免安装版。自动下载替换文件在这种交付形态下既没有可靠的
 * 验签链路，也会把「免安装版」用户的应用目录改坏。所以这里只做三件事：
 * 比对版本 → 告诉用户有新版 → 让他去 Release 页面下载。
 *
 * 版本来源：GitHub Releases API 的 latest（默认不含预发布版）。不带 token 时限流
 * 60 次/小时/IP，单机手动点「检查更新」远够用。
 *
 * 更新记录来源：随包的 CHANGELOG.md —— 与 Release 说明正文同源（见 scripts/release-notes.mjs），
 * 不另外维护一份给界面用的文案，否则两边必然漂移。
 */
import { app, ipcMain, net } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { info as logInfo, warn as logWarn } from './logging/logger'
import { REPO_URL } from '../shared/app-meta'
import type { ChangelogRelease, UpdateCheckResult } from '../shared/types'
import { compareVersions, parseChangelog, stripDownloadSection } from './update-version'

const RELEASE_API = 'https://api.github.com/repos/FaustDream/Reflow/releases/latest'
const RELEASES_PAGE = `${REPO_URL}/releases`
/** 请求超时：GitHub 在国内偶尔极慢，太短会误报「没网」，太长用户干等 */
const DEFAULT_TIMEOUT_MS = 12000

/** 读随包的 CHANGELOG.md。开发时是仓库根，打包后在 app.asar 内（electron-builder files 已收录） */
export async function loadChangelog(): Promise<ChangelogRelease[]> {
  try {
    const raw = await readFile(join(app.getAppPath(), 'CHANGELOG.md'), 'utf-8')
    const releases = parseChangelog(raw)
    if (!releases.length) logWarn('update', 'CHANGELOG.md 解析后为空，格式可能变了')
    return releases
  } catch (err) {
    // 老安装包没随包 CHANGELOG 时会走到这里，界面给「去项目主页看」的兜底
    logWarn('update', '读取更新记录失败', { error: String(err) })
    return []
  }
}

export interface CheckOptions {
  currentVersion: string
  /** 测试注入用；默认走 Electron 的 net.fetch（跟随系统代理） */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** 比对远端最新版本与当前版本。任何失败都返回 `ok:false` + 可读文案，不抛异常 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheckResult> {
  const current = String(options.currentVersion || '0.0.0').replace(/^v/i, '')
  const doFetch = options.fetchImpl ?? (net.fetch as unknown as typeof fetch)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const res = await doFetch(RELEASE_API, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub API 强制要求 UA，缺了直接 403
        'user-agent': `Reflow/${current}`,
        'x-github-api-version': '2022-11-28'
      },
      signal: controller.signal
    })

    if (res.status === 404) {
      logWarn('update', '仓库还没有发布任何 Release')
      return {
        ok: false,
        current,
        reason: 'not-found',
        message: '项目还没有发布过版本，暂时无从比较。',
        releaseUrl: RELEASES_PAGE
      }
    }
    if (!res.ok) {
      // 带上响应体片段：403 既可能是限流，也可能是网络中间层拦截，
      // 只有正文（"API rate limit exceeded" / 代理页面）能分清
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* 拿不到正文不影响判断 */
      }
      logWarn('update', '检查更新失败：接口返回异常', { status: res.status, body: detail.slice(0, 200) })
      return {
        ok: false,
        current,
        reason: 'http',
        message: `更新服务返回 ${res.status}，稍后再试（也可能是网络环境限制了对 GitHub 的访问）。`,
        releaseUrl: RELEASES_PAGE
      }
    }

    const data = (await res.json()) as {
      tag_name?: unknown
      html_url?: unknown
      published_at?: unknown
      body?: unknown
    }
    const latest = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : ''
    if (!latest) {
      return {
        ok: false,
        current,
        reason: 'bad-response',
        message: '更新服务返回的内容不完整（缺少版本号），稍后再试。',
        releaseUrl: RELEASES_PAGE
      }
    }

    const hasUpdate = compareVersions(latest, current) > 0
    logInfo('update', `检查更新完成：当前 ${current}，最新 ${latest}`, { hasUpdate })
    return {
      ok: true,
      current,
      latest,
      hasUpdate,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : undefined,
      releaseUrl: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE,
      notes: typeof data.body === 'string' ? stripDownloadSection(data.body) : undefined
    }
  } catch (err) {
    const aborted = controller.signal.aborted
    logWarn('update', aborted ? '检查更新超时' : '检查更新失败：网络不可达', { error: String(err) })
    return {
      ok: false,
      current,
      reason: 'network',
      message: aborted
        ? '连接 GitHub 超时。可能是网络受限，稍后再试，或直接打开项目主页查看。'
        : '连不上 GitHub（网络受限或断网）。可以稍后再试，或直接打开项目主页查看最新版本。',
      releaseUrl: RELEASES_PAGE
    }
  } finally {
    clearTimeout(timer)
  }
}

export function setupUpdateIpc(): void {
  ipcMain.handle('update:check', async () => checkForUpdate({ currentVersion: app.getVersion() }))
  ipcMain.handle('update:changelog', async () => loadChangelog())
}
