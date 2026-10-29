/**
 * 工单 010：自动滚动脚本的单元测试。
 *
 * 脚本本身在页面主世界运行，这里只验证「可序列化注入」这个关键性质：
 * 函数体内不得引用模块作用域变量，否则 toString() 后注入会 ReferenceError。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_SCROLL,
  SCROLL_PLATFORMS,
  installAutoScroller
} from '../page-scripts/auto-scroll'

describe('自动滚动：可注入性', () => {
  it('installAutoScroller 可 toString 后独立解析（无外部依赖）', () => {
    const src = installAutoScroller.toString()
    expect(() => new Function(`return (${src})`)).not.toThrow()
  })

  it('默认参数合理（间隔不过快，有步数上限）', () => {
    expect(DEFAULT_AUTO_SCROLL.intervalMs).toBeGreaterThanOrEqual(1000)
    expect(DEFAULT_AUTO_SCROLL.maxSteps).toBeGreaterThan(10)
    expect(DEFAULT_AUTO_SCROLL.idleStops).toBeGreaterThan(1)
  })

  it('函数体不含模块级 import 引用', () => {
    const src = installAutoScroller.toString()
    // 不应出现对模块作用域符号的引用（这些在注入后会 undefined）
    expect(src).not.toContain('DEFAULT_AUTO_SCROLL')
  })
})

describe('自动滚动：平台覆盖', () => {
  it('滚动型平台清单：不含代码侧翻页平台，含滚动加载平台', () => {
    for (const id of ['jd', 'taobao']) {
      expect(SCROLL_PLATFORMS.has(id), `${id} 应走代码侧翻页`).toBe(false)
    }
    for (const id of ['xianyu', 'meituan', 'pdd']) {
      expect(SCROLL_PLATFORMS.has(id), `${id} 应支持自动滚动`).toBe(true)
    }
  })
})


describe('工单 034：点下一页（原版作法）', () => {
  it('京东走文案、淘宝仍是 mtop 分页（不点按钮）', async () => {
    const { CLICK_PAGE_TARGETS, isClickPagePlatform } = await import('../page-scripts/auto-scroll')
    expect(isClickPagePlatform('jd')).toBe(true)
    expect(CLICK_PAGE_TARGETS.jd.text).toBe('下一页')

    // 淘宝仍是官方 mtop 分页，不点按钮
    expect(isClickPagePlatform('taobao')).toBe(false)
  })

  it('点下一页脚本自包含（可被 toString 注入页面主世界）', async () => {
    const { installClickPager } = await import('../page-scripts/auto-scroll')
    const source = installClickPager.toString()
    expect(source).not.toMatch(/import |require\(/)
    expect(source).toContain('__reflowAutoScroll')
  })
})
