/**
 * 版本比较与 CHANGELOG 解析（2026-11-12）。
 *
 * 这两块是「检查更新 / 更新记录」的唯一判断依据：比错了会误导用户升级，
 * 解析错了会让更新记录变成一堆 ## 和 ###，所以单独覆盖。
 */
import { describe, expect, it } from 'vitest'
import { compareVersions, parseChangelog, stripDownloadSection } from '../update-version'
import { checkForUpdate } from '../update-check'

describe('版本比较', () => {
  it('按段比较而不是按字符串', () => {
    // 字典序会认为 1.10.0 < 1.9.0，这里必须相反
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0)
  })

  it('相等与缺位', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
  })

  it('预发布后缀不参与比较（latest 接口本就不返回预发布版）', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0)
    expect(compareVersions('1.3.0-rc.1', '1.2.9')).toBeGreaterThan(0)
  })

  it('降级也算「不一样」（用于判断是否需要提示）', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0)
  })
})

const SAMPLE = `# 更新日志

本文件记录所有值得使用者注意的变更。

## [1.1.0] - 2026-11-11

### 变更

- **订单表格改为真分页**：每页可选 50 / 100 / 200 / 500 条。
- 周内分布、每日热力从总览页移除。

### 缺陷修复

- 商品名截断可能切坏 emoji。

## [1.0.0] - 2026-11-10

首个正式版。中断两个月的桌面安装包重新成为交付形态。

### 功能变更

- **新增「趋势分析」「平台对比」**。
`

describe('CHANGELOG 解析', () => {
  it('按版本切段，保留日期与分组', () => {
    const releases = parseChangelog(SAMPLE)
    expect(releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0'])
    expect(releases[0].date).toBe('2026-11-11')
    expect(releases[0].sections.map((s) => s.title)).toEqual(['变更', '缺陷修复'])
    expect(releases[0].sections[0].body).toContain('订单表格改为真分页')
  })

  it('版本段落开头的正文落在空标题分组里', () => {
    const releases = parseChangelog(SAMPLE)
    expect(releases[1].sections[0].title).toBe('')
    expect(releases[1].sections[0].body).toContain('首个正式版')
  })

  it('文件头说明不会被当成任何版本的内容', () => {
    const releases = parseChangelog(SAMPLE)
    const all = releases.flatMap((r) => r.sections.map((s) => s.body)).join('\n')
    expect(all).not.toContain('本文件记录所有值得使用者注意的变更')
    expect(releases[0].sections[0].body).not.toContain('# 更新日志')
  })

  it('1.0 不会命中 1.0.0（版本号是整段匹配）', () => {
    const releases = parseChangelog('## [1.0.0] - 2026-01-01\n\n- a\n')
    expect(releases).toHaveLength(1)
    expect(releases[0].version).toBe('1.0.0')
  })

  it('没有正文的版本段落不产出空记录', () => {
    expect(parseChangelog('## [2.0.0] - 2026-01-01\n\n## [1.0.0] - 2025-01-01\n- a\n')).toHaveLength(1)
  })

  it('「Unreleased」段不入记录（发版前它还不是版本号）', () => {
    const releases = parseChangelog(`## Unreleased

### 新增

- 还没发版的改动

## [1.1.0] - 2026-11-11

- 已发版的改动
`)
    expect(releases.map((r) => r.version)).toEqual(['1.1.0'])
    expect(releases[0].sections[0].body).toContain('已发版的改动')
    expect(releases[0].sections[0].body).not.toContain('还没发版')
  })

  it('空输入不抛异常', () => {
    expect(parseChangelog('')).toEqual([])
  })
})

describe('去掉 Release 正文里的下载区块', () => {
  it('截到「### 下载」之前', () => {
    const body = '### 1.1.0\n\n- 改动\n\n### 下载\n\n| 系统 | 文件 |\n|---|---|'
    expect(stripDownloadSection(body)).toBe('### 1.1.0\n\n- 改动')
  })

  it('没有下载区块时原样返回（只修掉尾部空白）', () => {
    expect(stripDownloadSection('### 1.1.0\n\n- 改动\n\n')).toBe('### 1.1.0\n\n- 改动')
  })
})

describe('检查更新：远端响应分支', () => {
  const respond = (init: {
    status?: number
    body?: unknown
    throw?: Error
  }): typeof fetch =>
    (async () => {
      if (init.throw) throw init.throw
      const status = init.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => init.body
      } as unknown as Response
    }) as unknown as typeof fetch

  it('远端更新时给出新版信息与下载地址', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({
        body: {
          tag_name: 'v1.2.0',
          html_url: 'https://github.com/FaustDream/Reflow/releases/tag/v1.2.0',
          published_at: '2026-12-01T00:00:00Z',
          body: '### 1.2.0\n\n- 新功能\n\n### 下载\n\n| 系统 | 文件 |\n|---|---|'
        }
      })
    })
    expect(result.ok).toBe(true)
    expect(result.latest).toBe('1.2.0')
    expect(result.hasUpdate).toBe(true)
    expect(result.notes).toBe('### 1.2.0\n\n- 新功能')
    expect(result.releaseUrl).toContain('v1.2.0')
  })

  it('同版本不算更新', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({ body: { tag_name: 'v1.1.0' } })
    })
    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(false)
  })

  it('本地版本更新（开发中）时不提示升级', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.3.0',
      fetchImpl: respond({ body: { tag_name: 'v1.2.0' } })
    })
    expect(result.hasUpdate).toBe(false)
  })

  it('404 当作「还没发过版」而不是错误弹窗', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({ status: 404 })
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-found')
    expect(result.releaseUrl).toContain('/releases')
  })

  it('限流 403 给出可读原因', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({ status: 403 })
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('http')
    expect(result.message).toContain('403')
  })

  it('网络异常不抛出去，返回 network 原因', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({ throw: new Error('ENOTFOUND api.github.com') })
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.message).toContain('GitHub')
  })

  it('超时按 network 上报，文案点明超时', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: hang,
      timeoutMs: 10
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.message).toContain('超时')
  })

  it('响应缺版本号时判为 bad-response', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.1.0',
      fetchImpl: respond({ body: { message: 'Not Found' } })
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad-response')
  })
})
