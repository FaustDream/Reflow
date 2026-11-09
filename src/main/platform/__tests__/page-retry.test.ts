import { describe, expect, it } from 'vitest'
import { isNoRetryError, withPageRetry } from '../page-retry'

const sleep = async (ms: number): Promise<void> => { void ms }

describe('工单 041：页级重试统一', () => {
  it('首次成功不重试', async () => {
    let calls = 0
    const v = await withPageRetry(
      async () => {
        calls += 1
        return 'ok'
      },
      { sleep }
    )
    expect(v).toBe('ok')
    expect(calls).toBe(1)
  })

  it('失败后重试成功（退避不真等：backoff 传 0）', async () => {
    let calls = 0
    const v = await withPageRetry(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('网络抖动')
        return 'ok'
      },
      { sleep: async () => undefined, backoffMs: [0, 0] }
    )
    expect(v).toBe('ok')
    expect(calls).toBe(2)
  })

  it('耗尽重试抛最后一个错误', async () => {
    let calls = 0
    await expect(
      withPageRetry(
        async () => {
          calls += 1
          throw new Error(`fail-${calls}`)
        },
        { retries: 2, sleep: async () => undefined, backoffMs: [0, 0] }
      )
    ).rejects.toThrow('fail-3')
    expect(calls).toBe(3)
  })

  it('登录失效/取消类错误不重试，立即抛出', async () => {
    let calls = 0
    await expect(
      withPageRetry(
        async () => {
          calls += 1
          throw new Error('淘宝登录态已失效，请重新扫码登录')
        },
        { sleep: async () => undefined, backoffMs: [0, 0] }
      )
    ).rejects.toThrow('登录态已失效')
    expect(calls).toBe(1)
  })

  it('isNoRetryError 识别取消与验证类', () => {
    expect(isNoRetryError(new Error('已取消'))).toBe(true)
    expect(isNoRetryError({ name: 'FetchCancelledError' })).toBe(true)
    expect(isNoRetryError(new Error('淘宝要求滑块/人机验证'))).toBe(true)
    expect(isNoRetryError(new Error('京东接口调用失败：网络错误'))).toBe(false)
  })

  it('onRetry 回调携带尝试次数与错误', async () => {
    const seen: Array<[number, string]> = []
    await withPageRetry(
      async () => {
        throw new Error('boom')
      },
      {
        retries: 2,
        sleep: async () => undefined,
        backoffMs: [0, 0],
        onRetry: (attempt, e) => seen.push([attempt, e.message])
      }
    ).catch(() => undefined)
    expect(seen).toEqual([
      [1, 'boom'],
      [2, 'boom']
    ])
  })
})
