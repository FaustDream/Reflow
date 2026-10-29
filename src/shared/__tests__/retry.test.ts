import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../retry'

describe('withRetry', () => {
  it('首次成功：只调用一次，不等待', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withRetry(fn, 3, 0)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('失败后重试直到成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom1'))
      .mockRejectedValueOnce(new Error('boom2'))
      .mockResolvedValueOnce('ok')
    await expect(withRetry(fn, 3, 0)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('用尽次数后抛出最后一次的错误', async () => {
    const fn = vi.fn(async () => {
      throw new Error('persistent')
    })
    await expect(withRetry(fn, 3, 0)).rejects.toThrow('persistent')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('isRetryable=false 时立即抛出，不再重试（业务终态）', async () => {
    class FatalError extends Error {}
    const fn = vi.fn(async () => {
      throw new FatalError('需要人机验证')
    })
    await expect(
      withRetry(fn, 5, 0, (err) => !(err instanceof FatalError))
    ).rejects.toThrow('需要人机验证')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('attempts<1 按 1 处理，不产生无效循环', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withRetry(fn, 0, 0)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('线性退避：第 1/2 次重试分别等待 baseDelayMs 与 2*baseDelayMs', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('a'))
        .mockRejectedValueOnce(new Error('b'))
        .mockResolvedValueOnce('ok')
      const p = withRetry(fn, 3, 1000)
      // 首次调用立即发生，失败后挂起等待 1000ms
      await vi.advanceTimersByTimeAsync(0)
      expect(fn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fn).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000)
      await expect(p).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
