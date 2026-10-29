import { describe, expect, it, vi } from 'vitest'
import {
  XIANYU_BOUGHT_API,
  XIANYU_SOLD_API,
  XianyuSessionError,
  XianyuValidateRequiredError,
  buildXianyuMtopOptions,
  fetchXianyuOrders,
  isXianyuNextPage
} from '../xianyu-fetch'
import type { XianyuMtopResponse } from '../xianyu-fetch'

const page = (n: number, next: unknown, row?: string): XianyuMtopResponse => ({
  ret: ['SUCCESS::调用成功'],
  data: { items: [{ commonData: { orderIdStr: `o${n}` } }], nextPage: next, lastEndRow: row }
})

const noSleep = async (): Promise<void> => undefined

describe('工单 006/011：闲鱼主动全量抓取编排', () => {
  it('请求参数与原版一致：appKey 34839810、POST、offsetRow 仅后续页携带', async () => {
    const calls: Array<Record<string, unknown>> = []
    const rpc = {
      mtop: vi.fn(async (o: Record<string, unknown>) => {
        calls.push(o)
        return calls.length < 3 ? page(calls.length, 'true', `row${calls.length}`) : page(3, false)
      })
    }
    const onResponse = vi.fn()
    return fetchXianyuOrders(
      rpc,
      { delayMs: 0 },
      { onResponse, sleep: noSleep }
    ).then(({ pages }) => {
      expect(pages).toBe(3)
      expect(onResponse).toHaveBeenCalledTimes(3)
      expect(calls[0].api).toBe(XIANYU_BOUGHT_API)
      expect(calls[0].appKey).toBe('34839810')
      expect(calls[0].type).toBe('POST')
      expect((calls[0].data as Record<string, unknown>).orderStatus).toBe('ALL')
      expect((calls[0].data as Record<string, unknown>).offsetRow).toBeUndefined()
      expect((calls[1].data as Record<string, unknown>).pageNumber).toBe(2)
      expect((calls[1].data as Record<string, unknown>).offsetRow).toBe('row1')
      expect((calls[2].data as Record<string, unknown>).offsetRow).toBe('row2')
    })
  })

  it('卖家模式走 sold.list', async () => {
    const rpc = { mtop: vi.fn(async (_o: Record<string, unknown>) => page(1, false)) }
    await fetchXianyuOrders(rpc, { seller: true, delayMs: 0 }, { onResponse: vi.fn(), sleep: noSleep })
    expect((rpc.mtop.mock.calls[0][0] as { api: string }).api).toBe(XIANYU_SOLD_API)
  })

  it('nextPage 为布尔 false / 无 lastEndRow 都安全结束，不死循环', async () => {
    const rpc1 = { mtop: vi.fn(async () => page(1, false, 'row1')) }
    const r1 = await fetchXianyuOrders(
      rpc1,
      { delayMs: 0 },
      { onResponse: vi.fn(), sleep: noSleep }
    )
    expect(r1.pages).toBe(1)

    // nextPage=true 却不给 lastEndRow（异常响应）：只抓首页即停
    const bad: XianyuMtopResponse = { ret: ['SUCCESS::x'], data: { items: [], nextPage: true } }
    const rpc2 = { mtop: vi.fn(async () => bad) }
    const r2 = await fetchXianyuOrders(
      rpc2,
      { delayMs: 0 },
      { onResponse: vi.fn(), sleep: noSleep }
    )
    expect(r2.pages).toBe(1)
  })

  it('maxPages 兜底', async () => {
    const rpc = {
      mtop: vi.fn(async () => page(1, true, 'row'))
    }
    const r = await fetchXianyuOrders(
      rpc,
      { maxPages: 3, delayMs: 0 },
      { onResponse: vi.fn(), sleep: noSleep }
    )
    expect(r.pages).toBe(3)
  })

  it('结构异常（无 items）重试一次后抛错', async () => {
    const rpc = {
      mtop: vi
        .fn()
        .mockResolvedValueOnce({ ret: ['SUCCESS::x'], data: {} })
        .mockResolvedValueOnce({ ret: ['SUCCESS::x'], data: {} })
    }
    await expect(
      fetchXianyuOrders(rpc, { delayMs: 0 }, { onResponse: vi.fn(), sleep: noSleep })
    ).rejects.toThrow(/返回结构异常/)
    expect(rpc.mtop).toHaveBeenCalledTimes(2)
  })

  it('首次失败、重试成功：继续完成抓取', async () => {
    const rpc = {
      mtop: vi
        .fn()
        .mockRejectedValueOnce(new Error('网络抖动'))
        .mockResolvedValueOnce(page(1, false))
    }
    const r = await fetchXianyuOrders(
      rpc,
      { delayMs: 0 },
      { onResponse: vi.fn(), sleep: noSleep }
    )
    expect(r.pages).toBe(1)
  })

  it('滑块验证 / 会话失效为专有错误且不重试', async () => {
    const validateRpc = {
      mtop: vi.fn(async () => ({ ret: ['FAIL_SYS_USER_VALIDATE::x'], data: {} }))
    }
    await expect(
      fetchXianyuOrders(validateRpc, { delayMs: 0 }, { onResponse: vi.fn(), sleep: noSleep })
    ).rejects.toBeInstanceOf(XianyuValidateRequiredError)
    expect(validateRpc.mtop).toHaveBeenCalledTimes(1)

    const sessionRpc = {
      mtop: vi.fn(async () => ({ ret: ['FAIL_SYS_SESSION_EXPIRED::x'], data: {} }))
    }
    await expect(
      fetchXianyuOrders(sessionRpc, { delayMs: 0 }, { onResponse: vi.fn(), sleep: noSleep })
    ).rejects.toBeInstanceOf(XianyuSessionError)
    expect(sessionRpc.mtop).toHaveBeenCalledTimes(1)
  })

  it('onProgress 回报页码', async () => {
    const rpc = {
      mtop: vi
        .fn()
        .mockResolvedValueOnce(page(1, 'true', 'r1'))
        .mockResolvedValueOnce(page(2, false))
    }
    const onProgress = vi.fn()
    await fetchXianyuOrders(rpc, { delayMs: 0 }, { onResponse: vi.fn(), onProgress, sleep: noSleep })
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, '')
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 'r1')
  })

  it('isXianyuNextPage 兼容布尔与字符串', () => {
    expect(isXianyuNextPage(true)).toBe(true)
    expect(isXianyuNextPage('true')).toBe(true)
    expect(isXianyuNextPage(false)).toBe(false)
    expect(isXianyuNextPage('false')).toBe(false)
    expect(isXianyuNextPage(undefined)).toBe(false)
  })

  it('buildXianyuMtopOptions 透传 api 与 data', () => {
    const opts = buildXianyuMtopOptions('mtop.idle.web.trade.bought.list', { pageNumber: 1 })
    expect(opts.api).toBe('mtop.idle.web.trade.bought.list')
    expect(opts.data).toEqual({ pageNumber: 1 })
    expect(opts.accountSite).toBe('xianyu')
  })
})
