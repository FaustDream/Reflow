/**
 * 工单 026：确认「无任何授权导致的功能降级」。
 *
 * 决策 D-B：原版两套授权机制（闲鱼前 3 单免费 + 魔猫g 卡密到期）都直接影响功能，
 * 整合版**全部移除**。本文件用回归测试把这个约束钉死：
 *
 * 1. 导出结果的行数恒等于捕获行数（原版会掩码第 4 行起的所有单元格）
 * 2. 导出内容里不出现「未解锁」等掩码占位
 * 3. 源码中不存在授权/掩码逻辑（防止未来有人误加）
 *
 * 这些断言很「笨」，但正是它们能在日后被无意破坏时立刻报警。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import ExcelJS from 'exceljs'
import { buildOrdersWorkbook } from '../excel'
import { buildOrdersCsv } from '../csv'
import { emptyOrder, type Order } from '../../../shared/types/order'

const SRC = resolve(__dirname, '../../../')

/** 递归收集源码文件 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|vue)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const makeOrders = (n: number): Order[] =>
  Array.from({ length: n }, (_, i) => ({
    ...emptyOrder('xianyu', 'xianyu#0'),
    orderId: `ORD${i + 1}`,
    title: `商品 ${i + 1}`,
    paidAmount: `${(i + 1) * 10}`,
    quantity: 1,
    status: '已完成',
    receiverAddress: `地址 ${i + 1}`,
    receiverPhone: `1390000${String(i).padStart(4, '0')}`
  }))

describe('工单 026：导出不掩码', () => {
  it('导出行数恒等于捕获行数（原版从第 4 行起掩码）', async () => {
    const orders = makeOrders(10)
    const buffer = await buildOrdersWorkbook(orders, [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    // 表头 + 10 行
    expect(sheet.rowCount).toBe(11)
  })

  it('第 4 行之后的关键字段仍有真实值（不是「未解锁」）', async () => {
    const orders = makeOrders(10)
    const buffer = await buildOrdersWorkbook(orders, [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    const headers = sheet.getRow(1).values as (string | undefined)[]
    const addrCol = headers.indexOf('收货地址')
    const phoneCol = headers.indexOf('收货电话')

    // 检查第 4~11 行（原版掩码区间）
    for (let r = 5; r <= 11; r++) {
      const addr = String(sheet.getRow(r).getCell(addrCol).value ?? '')
      const phone = String(sheet.getRow(r).getCell(phoneCol).value ?? '')
      expect(addr, `第 ${r} 行地址被掩码`).not.toBe('未解锁')
      expect(phone, `第 ${r} 行电话被掩码`).not.toBe('未解锁')
      expect(addr.length, `第 ${r} 行地址为空`).toBeGreaterThan(0)
    }
  })

  it('整张表不含任何「未解锁」占位', async () => {
    const buffer = await buildOrdersWorkbook(makeOrders(8), [])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = wb.getWorksheet('订单')!
    let found = false
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (String(cell.value ?? '').includes('未解锁')) found = true
      })
    })
    expect(found).toBe(false)
  })

  it('CSV 同样不掩码', () => {
    const buf = buildOrdersCsv(makeOrders(8), [])
    const text = buf.toString('utf-8')
    expect(text).not.toContain('未解锁')
    expect(text.replace(/^\ufeff/, '').split('\r\n')).toHaveLength(9) // 表头 + 8
  })
})

describe('工单 026：源码无授权逻辑', () => {
  it('不存在 unlocked / shouldMask 判定', () => {
    const files = walk(SRC)
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf-8')
      // 允许出现注释里提到「未解锁」作为历史说明，但不允许出现实际的掩码函数/变量
      if (/\bunlocked\b/.test(text) && !/^\s*(\/\/|\*)/.test(text)) {
        // 逐行判断，排除注释行
        const lines = text.split('\n')
        for (const line of lines) {
          if (/\bunlocked\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
            hits.push(`${file}: ${line.trim().slice(0, 80)}`)
          }
        }
      }
      if (/shouldMask/.test(text)) hits.push(`${file}: shouldMask`)
    }
    expect(hits, `发现掩码逻辑：\n${hits.join('\n')}`).toEqual([])
  })

  it('不存在注册码/卡密/到期校验', () => {
    const files = walk(SRC)
    const hits: string[] = []
    const patterns = [/注册码/, /卡密/, /InputRegisterCode/, /isExpire/, /expireDate/]
    for (const file of files) {
      const text = readFileSync(file, 'utf-8')
      for (const re of patterns) {
        if (re.test(text)) {
          // 排除注释与文档字符串里的说明
          const lines = text.split('\n')
          for (const line of lines) {
            if (re.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
              hits.push(`${file}: ${line.trim().slice(0, 80)}`)
            }
          }
        }
      }
    }
    expect(hits, `发现授权逻辑：\n${hits.join('\n')}`).toEqual([])
  })

  it('不依赖任何授权服务器', () => {
    const files = walk(SRC)
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf-8')
      if (/hereserver|registerCode|activationServer/i.test(text)) {
        hits.push(file)
      }
    }
    expect(hits).toEqual([])
  })
})
