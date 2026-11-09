/**
 * 工单 041：页级重试统一——所有接口抓取器的单页调用共用。
 *
 * 策略：失败重试 2 次（退避 1.5s / 3s）；登录失效、滑块验证、用户取消**不重试**
 * （重试也不会成功，只会拖慢失败反馈）。重试次数通过 onRetry 上报，进度条可见。
 */

export interface PageRetryOptions {
  retries?: number
  backoffMs?: number[]
  onRetry?: (attempt: number, error: Error) => void
  sleep: (ms: number) => Promise<void>
}

/** 这些错误重试无意义：取消 / 登录失效 / 需要人工验证 */
export function isNoRetryError(error: unknown): boolean {
  const name = (error as Error)?.name ?? ''
  const message = (error as Error)?.message ?? ''
  if (name === 'FetchCancelledError') return true
  return /登录|失效|滑块|人机验证|请先扫码|未登录|已取消/.test(message)
}

export async function withPageRetry<T>(
  fn: () => Promise<T>,
  options: PageRetryOptions
): Promise<T> {
  const retries = options.retries ?? 2
  const backoff = options.backoffMs ?? [1500, 3000]
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (isNoRetryError(error)) throw error
      if (attempt < retries) {
        const delay = backoff[Math.min(attempt, backoff.length - 1)]
        options.onRetry?.(attempt + 1, error instanceof Error ? error : new Error(String(error)))
        await options.sleep(delay)
      }
    }
  }
  throw lastError
}
