import { describe, expect, it } from 'vitest'
import {
  fetchTaobaoOrdersByApi,
  taobaoOrderListData,
  taobaoPageInfo,
  taobaoRetError,
  TaobaoSessionError,
  TaobaoValidateError
} from '../taobao-api-fetch'

/** 构造一页协议树响应（与直连实测结构一致） */
function treePage(shops: number, hasMore: boolean, nextPageIndex: number) {
  const structure: Record<string, string[]> = { orderContainer: [] }
  const data: Record<string, unknown> = {}
  for (let i = 0; i < shops; i++) {
    const key = `shopOrderContainer_${1000 + i}`
    structure.orderContainer.push(key)
    structure[key] = [`shopInfo_${1000 + i}`]
    data[`shopInfo_${1000 + i}`] = { id: `${1000 + i}`, fields: { orderId: `${1000 + i}` } }
  }
  return {
    api: 'mtop.taobao.order.queryboughtlistV2',
    ret: ['SUCCESS::调用成功'],
    data: {
      data,
      hierarchy: { structure },
      global: { pageControl: { hasMore, nextPageIndex } }
    }
  }
}

describe('工单 040：淘宝协议树分页解析', () => {
  it('shopOrderContainer 计数 + pageControl 翻页游标', () => {
    const info = taobaoPageInfo(treePage(30, true, 2))
    expect(info.shopCount).toBe(30)
    expect(info.hasMore).toBe(true)
    expect(info.nextPageIndex).toBe(2)
  })

  it('无 pageControl 时兜底 currentPage+1；空响应安全', () => {
    // 空响应：缺省 currentPage=1 → 兜底 nextPageIndex=2；但 hasMore=false，循环根本用不到它
    expect(taobaoPageInfo(null)).toEqual({ shopCount: 0, hasMore: false, nextPageIndex: 2 })
    const info = taobaoPageInfo({
      data: { data: { pagination: { fields: { currentPage: 5, hasMore: true } } } }
    })
    expect(info.hasMore).toBe(true)
    expect(info.nextPageIndex).toBe(6)
  })

  it('单页业务参数是竞品抓包样本形态（tborder/OrderList/condition）', () => {
    const data = taobaoOrderListData(3)
    expect(data).toMatchObject({
      tabCode: 'all',
      page: 3,
      OrderType: 'OrderList',
      appName: 'tborder',
      appVersion: '3.0',
      __needlessClearProtocol__: true
    })
    expect(data.condition).toBe('{"directRouteToTm2Scene":"1"}')
  })
})

describe('工单 040：淘宝分页循环', () => {
  it('hasMore=false 停止；每页响应都回调出去', async () => {
    const seen: number[] = []
    const result = await fetchTaobaoOrdersByApi(
      { page: async (p) => treePage(30, p < 2, p + 1) },
      { maxPages: 10 },
      { onResponse: (_json, page) => seen.push(page) }
    )
    expect(seen).toEqual([1, 2])
    expect(result.pages).toBe(2)
    expect(result.orders).toBe(60)
  })

  it('空页立即停止', async () => {
    const result = await fetchTaobaoOrdersByApi(
      { page: async () => treePage(0, true, 2) },
      { maxPages: 10 },
      { onResponse: () => undefined }
    )
    expect(result.pages).toBe(1)
    expect(result.orders).toBe(0)
  })

  it('nextPageIndex 不推进 → 防死循环停止', async () => {
    const result = await fetchTaobaoOrdersByApi(
      { page: async () => treePage(30, true, 1) },
      { maxPages: 10 },
      { onResponse: () => undefined }
    )
    expect(result.pages).toBe(1)
  })

  it('cancelCheck 抛错直接中断', async () => {
    await expect(
      fetchTaobaoOrdersByApi(
        { page: async () => treePage(30, true, 2) },
        { maxPages: 10 },
        {
          onResponse: () => undefined,
          cancelCheck: () => {
            throw new Error('已取消')
          }
        }
      )
    ).rejects.toThrow('已取消')
  })
})

describe('工单 040：ret 错误翻译', () => {
  it('SUCCESS → null；SESSION_EXPIRED → 登录失效；USER_VALIDATE → 滑块', () => {
    expect(taobaoRetError(['SUCCESS::调用成功'])).toBeNull()
    expect(taobaoRetError(['FAIL_SYS_SESSION_EXPIRED::Session过期'])).toBeInstanceOf(
      TaobaoSessionError
    )
    expect(taobaoRetError(['FAIL_SYS_USER_VALIDATE::需要验证'])).toBeInstanceOf(TaobaoValidateError)
    expect(taobaoRetError(['FAIL_SYS_OTHER::未知'])).toBeInstanceOf(Error)
  })

  it('风控优先于会话过期：同时出现时判滑块，不误导用户重扫', () => {
    const err = taobaoRetError([
      'FAIL_SYS_SESSION_EXPIRED::Session过期',
      'FAIL_SYS_USER_VALIDATE::哎哟喂,被挤爆啦'
    ])
    expect(err).toBeInstanceOf(TaobaoValidateError)
    expect(err?.message).toContain('人机验证')
  })
})
