import { describe, expect, it, vi } from 'vitest'
import {
  fetchTaobaoOrders,
  monthRange,
  pageControlOf,
  TaobaoValidateRequiredError
} from '../taobao-fetch'

/** 构造一页 queryboughtlistV2 响应（用简化节点树标志分页即可，解析由适配器测试覆盖） */
const pageResponse = (hasMore: boolean, nextPageIndex: number, currentPage = nextPageIndex - 1) => ({
  ret: ['SUCCESS::调用成功'],
  data: {
    global: { pageControl: { hasMore, nextPageIndex } },
    data: { pagination: { fields: { currentPage, hasMore: String(hasMore) } } }
  }
})

describe('淘宝主动抓取编排（移植 preload-index.js getAllOrders）', () => {
  it('monthRange：某月月初到月末（与原版 getMonthRange 一致）', () => {
    const { start, end } = monthRange(new Date(2026, 9, 14), 0) // 本月（10 月）
    expect(new Date(start).toISOString().slice(0, 10)).toBe('2026-09-30')
    // 10 月最后一天为 31 日（new Date(y, m+1, 0)）
    expect(new Date(end).toISOString().slice(0, 10)).toBe('2026-10-31')
  })

  it('pageControlOf 读取 hasMore/nextPageIndex（含 global 缺省回退）', () => {
    expect(pageControlOf(pageResponse(true, 2))).toMatchObject({ hasMore: true, nextPageIndex: 2 })
    const fallback = {
      data: { data: { pagination: { fields: { currentPage: 3, hasMore: false } } } }
    }
    expect(pageControlOf(fallback as Parameters<typeof pageControlOf>[0])).toMatchObject({
      hasMore: false,
      nextPageIndex: 4
    })
  })

  it('按月翻页：第 1 月 2 页、第 2 月 1 页后结束', async () => {
    const mtop = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(true, 2))
      .mockResolvedValueOnce(pageResponse(false, 2))
      .mockResolvedValueOnce(pageResponse(false, 1))
    const responses: unknown[] = []
    const result = await fetchTaobaoOrders(
      { mtop },
      { months: 2, delayMs: 0 },
      { onResponse: (body) => responses.push(body) }
    )
    expect(result).toEqual({ months: 2, pages: 3 })
    expect(responses).toHaveLength(3)
    // 首次请求携带 tborder 应用标记与 condition
    const firstOptions = mtop.mock.calls[0][0]
    expect(firstOptions.api).toBe('mtop.taobao.order.queryboughtlistV2')
    expect(firstOptions.data.appName).toBe('tborder')
    expect(JSON.parse(firstOptions.data.condition).orderFilterExtParam).toMatch(/beginTime/)
  })

  it('FAIL_SYS_USER_VALIDATE 立即抛出并停止', async () => {
    const mtop = vi
      .fn()
      .mockResolvedValueOnce({ ret: ['FAIL_SYS_USER_VALIDATE::...'], data: {} })
    await expect(
      fetchTaobaoOrders({ mtop }, { months: 1, delayMs: 0 }, { onResponse: () => {} })
    ).rejects.toBeInstanceOf(TaobaoValidateRequiredError)
    expect(mtop).toHaveBeenCalledTimes(1)
  })

  it('nextPageIndex 与当前页相同则终止（防死循环）', async () => {
    const mtop = vi.fn().mockResolvedValue(pageResponse(true, 1))
    await fetchTaobaoOrders(
      { mtop },
      { months: 1, delayMs: 0 },
      { onResponse: () => {} }
    )
    expect(mtop).toHaveBeenCalledTimes(1)
  })
})
