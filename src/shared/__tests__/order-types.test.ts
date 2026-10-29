/**
 * 工单 003 验收项：类型单一来源 —— 主进程与渲染进程共用同一份 Order 定义，
 * 任何文件不得重复定义（防止两端漂移）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(__dirname, '../..') // 指向 src/，避免扫描仓库内逆向素材

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name.startsWith('__tests__')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (/\.(ts|vue)$/.test(name)) acc.push(full)
  }
  return acc
}

/** 断言某声明只出现在给定文件中（相对 src 的路径） */
function expectDefinedOnlyIn(decl: RegExp, allowedFile: string): void {
  const offenders = walk(SRC_ROOT)
    .filter((f) => relative(SRC_ROOT, f).replaceAll('\\', '/') !== allowedFile)
    .filter((f) => decl.test(readFileSync(f, 'utf-8')))
    .map((f) => relative(SRC_ROOT, f))
  expect(offenders).toEqual([])
}

describe('类型单一来源（003 验收）', () => {
  it('interface Order 只定义在 shared/types/order.ts', () => {
    expectDefinedOnlyIn(/\binterface Order\b/, 'shared/types/order.ts')
  })

  it('interface PlatformAdapter 只定义在 main/platform/adapter.ts', () => {
    expectDefinedOnlyIn(/\binterface PlatformAdapter\b/, 'main/platform/adapter.ts')
  })

  it('DateTimeString 类型只定义在 shared/datetime.ts', () => {
    // 要求「声明」形态（type X =），避免把 `import { type X }` 误判为重复定义
    expectDefinedOnlyIn(/\btype DateTimeString\s*=/, 'shared/datetime.ts')
  })

  it('CORE_EXPORT_COLUMNS 覆盖方案附录 A.5 的全部核心列', async () => {
    const { CORE_EXPORT_COLUMNS } = await import('../types/order')
    const keys = CORE_EXPORT_COLUMNS.map((c) => c.key)
    for (const key of [
      'platform',
      'account',
      'orderId',
      'createdAt',
      'title',
      'imageUrl',
      'unitPrice',
      'paidAmount',
      'quantity',
      'status',
      'shopName',
      'receiverName',
      'receiverAddress',
      'receiverPhone',
      'logisticsCompany',
      'trackingNo',
      'paidAt',
      'shippedAt',
      'completedAt'
    ]) {
      expect(keys).toContain(key)
    }
  })
})
