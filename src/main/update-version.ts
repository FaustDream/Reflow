/**
 * 版本号比较与 CHANGELOG 解析（纯函数，无 Electron 依赖）。
 *
 * 单独成文件的原因：这两件事都需要单测，而 update-check.ts 要碰 net / app / 日志，
 * 把纯逻辑留在那里会让测试不得不 mock 整个 Electron。
 */
import type { ChangelogRelease } from '../shared/types'

/** 只留 主.次.修订；`v1.2.0` / `1.2.0-beta.1` / `1.2` 都归一化成数值数组 */
function parseVersion(input: string): number[] {
  const core = String(input).trim().replace(/^v/i, '').split(/[-+]/)[0]
  return core
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

/**
 * 语义化版本比较：a > b 返回正数，a < b 返回负数，相等返回 0。
 * 缺位按 0 处理（`1.2` 等于 `1.2.0`）。预发布后缀不参与比较 ——
 * latest 接口本身就不返回预发布版，真要比也没意义。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 解析 CHANGELOG.md → 版本段落数组（顺序同文件，最新在前）。
 *
 * 只认两种标题：`## [x.y.z] - YYYY-MM-DD` 开版本，`### 标题` 开分组。
 * 其余行原样收进当前分组正文，交给渲染层的轻量 markdown 处理 —— 这里不做
 * 「列表/表格转结构体」，因为书写方式一直在变，转一次就得跟着改一次解析器。
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let section: { title: string; lines: string[] } | null = null

  const flushSection = (): void => {
    if (!release || !section) return
    const body = section.lines.join('\n').trim()
    if (body) release.sections.push({ title: section.title, body })
    section = null
  }
  const flushRelease = (): void => {
    flushSection()
    if (release && release.sections.length) releases.push(release)
    release = null
  }

  for (const line of markdown.split(/\r?\n/)) {
    // `## [1.1.0] - 2026-11-11`；负向断言避免 1.0 命中 1.0.0
    const versionMatch = /^##\s+\[?v?(\d+(?:\.\d+)+)\]?(?![\d.])\s*(?:[-–]\s*(\d{4}-\d{2}-\d{2}))?/.exec(
      line
    )
    if (versionMatch) {
      flushRelease()
      release = { version: versionMatch[1], date: versionMatch[2] ?? '', sections: [] }
      continue
    }
    // 其余二级标题（文件头说明、「未发布」这类）结束当前段落，本身不入记录
    if (/^##\s/.test(line)) {
      flushRelease()
      continue
    }
    if (!release) continue

    const sectionMatch = /^###\s+(.+?)\s*$/.exec(line)
    if (sectionMatch) {
      flushSection()
      section = { title: sectionMatch[1], lines: [] }
      continue
    }
    // 版本段落开头的正文（如 1.0.0 的「首个正式版。…」）先落在空标题分组里
    if (!section) section = { title: '', lines: [] }
    section.lines.push(line)
  }
  flushRelease()
  return releases
}

/**
 * 从 Release 正文里去掉尾巴上的「### 下载」区块。
 * 界面上另有下载按钮，把资产清单再列一遍只会让人以为要自己挑文件名。
 */
export function stripDownloadSection(body: string): string {
  const index = body.search(/^###\s+下载/m)
  return (index === -1 ? body : body.slice(0, index)).trim()
}
