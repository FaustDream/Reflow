/**
 * 通用有限重试：传输类抖动（网络/5xx/SDK 临时不可用）的统一策略。
 * 业务终态（需要人机验证、登录过期、明确的业务失败码）应由 isRetryable 判定为 false 立即抛出。
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * @param fn 带副作用的异步操作
 * @param attempts 最大尝试次数（含首次），<1 时按 1 处理
 * @param baseDelayMs 首次重试前等待；之后线性退避 baseDelayMs * 第几次重试
 * @param isRetryable 返回 false 时不再重试，直接抛原错（缺省全部可重试）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  isRetryable: (err: unknown) => boolean = () => true
): Promise<T> {
  const max = Math.max(1, attempts)
  let lastErr: unknown
  for (let i = 0; i < max; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === max - 1 || !isRetryable(err)) throw err
      await sleep(baseDelayMs * (i + 1))
    }
  }
  throw lastErr
}
