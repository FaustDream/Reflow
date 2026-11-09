import { describe, expect, it } from 'vitest'
import {
  fetchPddOrdersByApi,
  pddRequestHeaders,
  parsePddPage,
  PddLoginRequiredError
} from '../pdd-api-fetch'

interface FakeOrder {
  order_sn: string
  offset?: string | number
  display_amount?: number
  order_status_prompt?: string
}

function pddPage(sns: Array<string | { sn: string; offset: string | number }>): Record<string, unknown> {
  return {
    server_time: 1793428678,
    orders: sns.map((item) => {
      const o: FakeOrder =
        typeof item === 'string' ? { order_sn: item } : { order_sn: item.sn, offset: item.offset }
      o.display_amount = 882
      o.order_status_prompt = '待分享'
      return o
    })
  }
}

describe('工单 040：拼多多响应解析', () => {
  it('orders 数组照取；40001 → 登录失效', () => {
    const orders = parsePddPage(pddPage(['a', 'b']))
    expect(orders.length).toBe(2)
    expect(() => parsePddPage({ error_code: 40001, error_msg: '未登录' })).toThrow(
      PddLoginRequiredError
    )
  })

  it('请求头带手机网关伪装与 AccessToken/token（竞品同款）', () => {
    const headers = pddRequestHeaders('PDDAccessToken=tok; pdd_user_id=123', 'tok')
    expect(headers['content-type']).toContain('application/json')
    expect(headers.origin).toBe('https://mobile.yangkeduo.com')
    expect(headers.referer).toContain('orders.html')
    expect(headers.AccessToken).toBe('tok')
    expect(headers.token).toBe('tok')
    expect(headers.cookie).toContain('PDDAccessToken=tok')
  })
})

describe('工单 041：拼多多 offset 游标分页（2026-11-01 逆向定型）', () => {
  it('游标 = 上一批最后一条的 offset 字段；末页不满页 = 抓到底', async () => {
    // 第 1 页 30 单（带 offset），第 2 页 8 单（不满页）→ 结束
    const batches = [
      Array.from({ length: 30 }, (_, i) => ({ sn: `sn-${i + 1}`, offset: `MO-${i + 1}` })),
      Array.from({ length: 8 }, (_, i) => ({ sn: `sn-${31 + i}`, offset: `MO-${31 + i}` }))
    ]
    const cursors: Array<string | number | undefined> = []
    const pages: number[] = []
    const result = await fetchPddOrdersByApi(
      async (page, cursor) => {
        cursors.push(cursor)
        pages.push(page)
        return { json: pddPage(batches[page - 1] ?? []), status: 200, text: '' }
      },
      { pageSize: 30 },
      { onResponse: () => undefined }
    )
    expect(pages).toEqual([1, 2])
    // 第 1 页游标为空；第 2 页游标 = 第 1 页最后一条的 offset
    expect(cursors[0]).toBeUndefined()
    expect(cursors[1]).toBe('MO-30')
    expect(result.orders).toBe(38)
    expect(result.complete).toBe(true)
  })

  it('订单没有 offset 字段时游标回退到 order_sn', async () => {
    const batches = [
      Array.from({ length: 30 }, (_, i) => `sn-${i + 1}`),
      Array.from({ length: 30 }, (_, i) => `sn-${31 + i}`),
      []
    ]
    const cursors: Array<string | number | undefined> = []
    await fetchPddOrdersByApi(
      async (page, cursor) => {
        cursors.push(cursor)
        return { json: pddPage(batches[page - 1] ?? []), status: 200, text: '' }
      },
      { pageSize: 30 },
      { onResponse: () => undefined }
    )
    // 第 3 页游标 = 第 2 页最后一条的 order_sn（无 offset 字段时的回退）
    expect(cursors[2]).toBe('sn-60')
  })

  it('翻页被服务端无视（一直回同一批）→ complete=false 交给上层换通道', async () => {
    const same = Array.from({ length: 30 }, (_, i) => `sn-${i + 1}`)
    const result = await fetchPddOrdersByApi(
      async () => ({ json: pddPage(same), status: 200, text: '' }),
      { pageSize: 30 },
      { onResponse: () => undefined }
    )
    // 第 2 页 0 新增 → 停
    expect(result.pages).toBe(2)
    expect(result.orders).toBe(30)
    expect(result.complete).toBe(false)
  })

  it('增量：整页全是本地已知单 → 第 1 页后立即收工（complete=true）', async () => {
    const same = Array.from({ length: 30 }, (_, i) => `sn-${i + 1}`)
    const known = new Set(same)
    const result = await fetchPddOrdersByApi(
      async () => ({ json: pddPage(same), status: 200, text: '' }),
      { pageSize: 30 },
      { known, onResponse: () => undefined }
    )
    expect(result.pages).toBe(1)
    expect(result.complete).toBe(true)
  })

  it('增量：known 只覆盖部分 → 不算已同步（走游标失效判定 complete=false）', async () => {
    const same = Array.from({ length: 30 }, (_, i) => `sn-${i + 1}`)
    const known = new Set(same.slice(0, 10))
    const result = await fetchPddOrdersByApi(
      async () => ({ json: pddPage(same), status: 200, text: '' }),
      { pageSize: 30 },
      { known, onResponse: () => undefined }
    )
    expect(result.complete).toBe(false)
  })

  it('空页立即结束', async () => {
    const result = await fetchPddOrdersByApi(
      async () => ({ json: pddPage([]), status: 200, text: '' }),
      { pageSize: 30 },
      { onResponse: () => undefined }
    )
    expect(result.pages).toBe(1)
    expect(result.complete).toBe(true)
  })
})
