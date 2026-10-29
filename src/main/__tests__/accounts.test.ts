/**
 * 工单 021：多账号聚合的纯逻辑测试。
 *
 * 覆盖分区命名、展示名回退、槽位分配、默认账号补建。
 * （partition 隔离本身需要真实 Electron session，由 scripts/accounts-check.cjs 验证。）
 */
import { describe, expect, it } from 'vitest'
import {
  accountId,
  displayNameOf,
  ensureDefaultAccount,
  nextSlot,
  partitionFor,
  type Account
} from '../accounts'

const make = (over: Partial<Account> = {}): Account => ({
  id: 'dewu#0',
  platform: 'dewu',
  slot: 0,
  label: '',
  userId: '',
  nickname: '',
  createdAt: 0,
  ...over
})

describe('多账号：分区命名', () => {
  it('slot 0 沿用历史分区名（升级不丢登录态）', () => {
    expect(partitionFor('dewu', 0)).toBe('persist:platform-dewu')
  })

  it('slot N 使用独立分区', () => {
    expect(partitionFor('dewu', 1)).toBe('persist:platform-dewu-1')
    expect(partitionFor('dewu', 2)).toBe('persist:platform-dewu-2')
  })

  it('同平台不同槽位分区互不相同', () => {
    const partitions = [0, 1, 2].map((s) => partitionFor('xianyu', s))
    expect(new Set(partitions).size).toBe(3)
  })

  it('账号 id 由平台与槽位构成', () => {
    expect(accountId('jd', 0)).toBe('jd#0')
    expect(accountId('jd', 3)).toBe('jd#3')
  })
})

describe('多账号：展示名回退链', () => {
  it('备注名优先', () => {
    expect(displayNameOf(make({ label: '主号', nickname: '小明', userId: '123' }))).toBe('主号')
  })

  it('无备注时用昵称', () => {
    expect(displayNameOf(make({ nickname: '小明', userId: '123' }))).toBe('小明')
  })

  it('无昵称时用 userId（工单要求的降级）', () => {
    expect(displayNameOf(make({ userId: '2300000001' }))).toBe('2300000001')
  })

  it('全都拿不到时用「账号 N」', () => {
    expect(displayNameOf(make({ slot: 0 }))).toBe('账号 1')
    expect(displayNameOf(make({ slot: 1 }))).toBe('账号 2')
  })
})

describe('多账号：槽位分配', () => {
  it('空表时下一个槽位是 0', () => {
    expect(nextSlot([], 'dewu')).toBe(0)
  })

  it('已有 slot 0 时下一个是 1', () => {
    expect(nextSlot([make({ slot: 0 })], 'dewu')).toBe(1)
  })

  it('有空缺时不复用（避免与已删除账号的旧分区混淆）', () => {
    const accounts = [make({ slot: 0 }), make({ slot: 2 })]
    expect(nextSlot(accounts, 'dewu')).toBe(3)
  })

  it('槽位按平台独立计算', () => {
    const accounts = [make({ platform: 'dewu', slot: 0 }), make({ platform: 'dewu', slot: 1 })]
    expect(nextSlot(accounts, 'jd')).toBe(0)
  })
})

describe('多账号：默认账号补建', () => {
  it('平台无账号时补建 slot 0', () => {
    const next = ensureDefaultAccount([], 'dewu')
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'dewu#0', platform: 'dewu', slot: 0 })
  })

  it('已有账号时原样返回（不重复补建）', () => {
    const accounts = [make({ slot: 0 })]
    expect(ensureDefaultAccount(accounts, 'dewu')).toBe(accounts)
  })
})
