import { describe, expect, it, vi } from 'vitest'
import { fetchJdOrders, jdRangeValue, JdLoginRequiredError } from '../jd-fetch'

const makeRpc = (pages: Array<{ status?: number; text?: string; body?: unknown }>) => {
  let i = 0
  const calls: string[] = []
  return {
    calls,
    rpc: {
      pageGet: vi.fn(async (url: string) => {
        calls.push(url)
        const page = pages[Math.min(i++, pages.length - 1)]
        return {
          status: page.status ?? 200,
          url: `https://order.jd.com${url}`,
          text: page.text ?? JSON.stringify(page.body ?? [])
        }
      })
    }
  }
}

describe('京东主动抓取编排（复刻 renderer.js getListData）', () => {
  it('时间范围值：今年 2&s=4096；年份 N&s=4096', () => {
    expect(jdRangeValue('current')).toBe('2&s=4096')
    expect(jdRangeValue(undefined)).toBe('2&s=4096')
    expect(jdRangeValue(2024)).toBe('2024&s=4096')
    // 传「今年」这个具体年份时也要用原版的 2，而不是四位年份
    expect(jdRangeValue(new Date().getFullYear())).toBe('2&s=4096')
  })

  it('range=all：逐年遍历，每年各自翻页到空页', async () => {
    const year = new Date().getFullYear()
    const order = (createdTs: string) => ({ orderId: createdTs.replace(/\D/g, ''), createdTs })
    const { rpc, calls } = makeRpc([
      // 今年：第 1 页有数据、第 2 页空
      { body: [order(`${year}-05-01 10:00:00`)] },
      { body: [] },
      // 去年：同样一页数据 + 空页
      { body: [order(`${year - 1}-05-01 10:00:00`)] },
      { body: [] }
    ])
    const result = await fetchJdOrders(
      rpc,
      { range: 'all', years: 2, delayMs: 0 },
      { onResponse: () => {} }
    )
    expect(result.pages).toBe(4)
    // 第一年用今年（d=2），第二年用具体年份
    expect(calls[0]).toContain(`d=${encodeURIComponent('2&s=4096')}`)
    expect(calls[2]).toContain(`d=${encodeURIComponent(`${year - 1}&s=4096`)}`)
  })

  it('逐页 __fetch__=1 翻页，空页停止；回调收到每页 body', async () => {
    const order = (createdTs: string) => ({ orderId: createdTs.replace(/\D/g, ''), createdTs })
    const { rpc, calls } = makeRpc([
      { body: [order('2026-05-01 10:00:00'), order('2026-04-01 10:00:00')] },
      { body: [order('2026-03-01 10:00:00'), order('2026-02-01 10:00:00')] },
      { body: [] }
    ])
    const responses: unknown[] = []
    const result = await fetchJdOrders(
      rpc,
      { range: 'current', delayMs: 0 },
      { onResponse: (r) => responses.push(r.body) }
    )
    expect(result.pages).toBe(3)
    expect(calls[0]).toContain('__fetch__=1')
    expect(calls[0]).toContain('page=1')
    expect(calls[1]).toContain('page=2')
    expect(responses).toHaveLength(3)
  })

  it('needNext：末条 createdTs 早于范围起点时按截止停止', async () => {
    const { rpc } = makeRpc([
      { body: [{ orderId: '1', createdTs: '2025-06-01 00:00:00' }] }
    ])
    const result = await fetchJdOrders(
      rpc,
      { range: 2026, delayMs: 0 },
      { onResponse: () => {} }
    )
    expect(result.stoppedByCutoff).toBe(true)
    expect(result.pages).toBe(1)
  })

  it('登录跳转（opaque status=0）/ HTML 验证页 → JdLoginRequiredError', async () => {
    const { rpc } = makeRpc([{ status: 0, text: '' }])
    await expect(
      fetchJdOrders(rpc, { delayMs: 0 }, { onResponse: () => {} })
    ).rejects.toBeInstanceOf(JdLoginRequiredError)

    const html = makeRpc([{ text: '<html>滑块验证</html>' }])
    await expect(
      fetchJdOrders(html.rpc, { delayMs: 0 }, { onResponse: () => {} })
    ).rejects.toBeInstanceOf(JdLoginRequiredError)
  })
})
