/**
 * 工单 010：自动翻页辅助。
 *
 * 闲鱼/得物/美团等平台是「滚动加载」而非分页按钮：用户必须不断往下滑动才会发下一页请求。
 * 原版的做法是注入脚本模拟滚动（魔猫g 各平台指引都写着「不停往下滑动，以提取更多订单」）。
 *
 * 本实现提供两档能力：
 *
 * 1. **自动滚动**（所有被动捕获平台）
 *    页面脚本按固定间隔滚到底部，触发平台自己的加载逻辑。响应仍走被动捕获管道，
 *    因此不需要为每个平台单独适配分页参数。用户可随时停止。
 *
 * 2. **代码侧翻页**（已有主动抓取的平台：闲鱼/淘宝/京东/1688）
 *    这些平台已有专门的 fetch-runner 按游标/月份翻页，无需滚动。
 *
 * 红线：只模拟用户滚动，不构造任何带签名的请求（决策 D-2）。
 */

export interface AutoScrollOptions {
  /** 每次滚动的间隔（毫秒），太快会被平台限流 */
  intervalMs?: number
  /** 最多滚动多少次（防止无限滚动） */
  maxSteps?: number
  /** 到底后连续多少次没有新订单就停止 */
  idleStops?: number
}

/**
 * 默认节奏：拼多多/美团这类 H5 列表加载偏慢（1.5s 内常常还没吐出下一屏），
 * 早期用 `intervalMs:1500 / idleStops:6` 会在第 6 次「高度没变」时误判「到底了」，
 * 导致只抓到一部分（拼多多停在 360 单、美团 39 单就是这个原因）。
 * 现在放慢节奏、放宽停止阈值。
 */
export const DEFAULT_AUTO_SCROLL: Required<AutoScrollOptions> = {
  intervalMs: 2200,
  maxSteps: 400,
  idleStops: 12
}

/**
 * 需要滚动加载的平台。
 *
 * 京东/淘宝/1688 已有代码侧翻页（按年/按月/按游标参数请求），比模拟滚动快得多也稳得多，
 * 故不在此列。闲鱼/美团/拼多多是纯滚动加载，必须靠模拟滚动触发。
 */
export const SCROLL_PLATFORMS: ReadonlySet<string> = new Set([
  'xianyu',
  'xianyu-sold',
  'meituan',
  'pdd'
])

export function isScrollPlatform(platformId: string): boolean {
  return SCROLL_PLATFORMS.has(platformId)
}

/**
 * 工单 034 / 2026-10-26：分页按钮型平台 —— 点「下一页」。
 *
 * 1688 原版 `list1688.js` 的 `nextPage()` 是深查 `#right:not([disabled])` 后 `.click()`；
 * 京东新版订单页是 SPA（bundle `pc_orderList` 0.0.41），底部是「上一页 / 下一页」文案按钮，
 * 没有稳定 id/class，只能按可见文本点。
 *
 * 所以目标既支持 CSS 选择器，也支持可见文案。
 */
export interface ClickPageTarget {
  /** CSS 选择器（命中第一个可点的） */
  selector?: string
  /** 按可见文本找叶子节点（如京东的「下一页」） */
  text?: string
}

export const CLICK_PAGE_TARGETS: Record<string, ClickPageTarget> = {
  // 京东新版订单页（2026-10 实测：list.action 已返回 HTML 壳，数据走 pcorder_center_list）
  jd: { text: '下一页' }
}

export function isClickPagePlatform(platformId: string): boolean {
  return platformId in CLICK_PAGE_TARGETS
}

/**
 * 生成「点下一页」脚本（原版作法）。
 *
 * 与自动滚动共用同一套事件通道（`__reflowAutoScroll` + state/progress），
 * 所以 UI 的进度与「停止」按钮不用改。
 * 连续 N 次找不到可点的下一页（按钮消失/置灰）即视为到底。
 */
export function installClickPager(
  nonce: string,
  platform: string,
  options?: AutoScrollOptions & ClickPageTarget
): void {
  const opts = Object.assign(
    // idleStops 5 = 连续 5 次（约 10 秒）找不到按钮才判定到底：
    // SPA 订单页（京东）渲染分页器需要时间，3 次太容易误判
    { intervalMs: 2000, maxSteps: 200, idleStops: 5 },
    options || {}
  ) as Required<AutoScrollOptions>
  const selector = (options && options.selector) || ''
  const text = (options && options.text) || ''

  const KEY = '__reflowAutoScroll'
  const w = window as unknown as Record<string, unknown>
  const prev = w[KEY] as { stop?: () => void } | undefined
  if (prev?.stop) prev.stop()

  let stopped = false
  let steps = 0
  let idle = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const report = (state: string, extra?: Record<string, unknown>): void => {
    try {
      // 必须用 preload 注入的 nonce：主进程传的那个 preload 不认，事件会被整包丢弃
      const pageNonce =
        ((window as unknown as Record<string, unknown>).__reflowNonce as string) || nonce
      window.postMessage(
        { __reflowAutoScroll: pageNonce, payload: { platform, state, steps, ...(extra || {}) } },
        '*'
      )
    } catch {
      /* 页面卸载时忽略 */
    }
  }

  /** 深查（含 shadow DOM），与原版 deepQuerySelector 一致 */
  const deepQuery = (sel: string): HTMLElement | null => {
    const walk = (root: Document | ShadowRoot): HTMLElement | null => {
      const hit = root.querySelector(sel) as HTMLElement | null
      if (hit) return hit
      const hosts = Array.from(root.querySelectorAll('*'))
      for (const el of hosts) {
        const sr = (el as HTMLElement).shadowRoot
        if (sr) {
          const found = walk(sr)
          if (found) return found
        }
      }
      return null
    }
    return walk(document)
  }

  /** 按可见文本找可点的叶子节点（跳过隐藏与禁用） */
  const findByText = (label: string): HTMLElement | null => {
    const nodes = Array.from(document.querySelectorAll('*'))
    for (const node of nodes) {
      const el = node as HTMLElement
      if (el.children.length) continue
      if ((el.textContent || '').trim() !== label) continue
      if (el.getAttribute('aria-disabled') === 'true') continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
      return el
    }
    return null
  }

  const findTarget = (): HTMLElement | null => {
    if (selector) return deepQuery(selector)
    if (text) return findByText(text)
    return null
  }

  const step = (): void => {
    if (stopped) return
    if (steps >= opts.maxSteps) {
      report('finished', { reason: 'max-steps' })
      return
    }

    // 页面自己说「没有更多了」就收工（京东末页会渲染这句）
    const bodyText = (document.body && document.body.innerText) || ''
    if (/没有更多了|没有更多订单/.test(bodyText)) {
      report('finished', { reason: 'no-more-content' })
      return
    }

    const btn = findTarget()
    if (btn) {
      steps++
      idle = 0
      try {
        btn.click()
      } catch {
        /* 忽略点击异常 */
      }
      report('progress', { page: steps })
    } else {
      idle++
      report('progress', { page: steps, idle })
      if (idle >= opts.idleStops) {
        report('finished', { reason: 'no-more-content' })
        return
      }
    }
    timer = setTimeout(step, opts.intervalMs)
  }

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    report('stopped')
  }

  w[KEY] = { stop }
  report('started', { mode: 'click', selector, maxSteps: opts.maxSteps })
  timer = setTimeout(step, opts.intervalMs)
}

/**
 * 京东专用：逐年切换时间范围（2026-10-26 实测的订单页结构）。
 *
 * 京东新版订单页默认只显示「近3个月订单」，页头那个下拉里有
 * `今年内订单 / 2025年订单 / … / 2014年订单`。切一次年份，页面自己就会发
 * `pcorder_center_list`（带 d/s 参数、带签名），响应走被动捕获入库。
 *
 * 所以「拿全量」不是去构造请求，而是**替用户点那个下拉**：
 * 逐年点一遍，每切一年等页面加载完，订单自然就攒齐了。
 *
 * ⚠ 需自包含（被 toString 后注入），不能引用模块作用域变量。
 */
export function installJdYearWalker(
  nonce: string,
  platform: string,
  options?: { years?: number; intervalMs?: number; maxPagesPerYear?: number }
): void {
  const totalYears = (options && options.years) || 8
  const interval = (options && options.intervalMs) || 2500
  const maxPages = (options && options.maxPagesPerYear) || 25

  const KEY = '__reflowAutoScroll'
  const w = window as unknown as Record<string, unknown>
  const prev = w[KEY] as { stop?: () => void } | undefined
  if (prev?.stop) prev.stop()

  let stopped = false
  let yearIdx = 0
  let pageInYear = 0
  let actions = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const report = (state: string, extra?: Record<string, unknown>): void => {
    try {
      // 必须用 preload 注入的 nonce：主进程传的那个 preload 不认，事件会被整包丢弃
      const pageNonce =
        ((window as unknown as Record<string, unknown>).__reflowNonce as string) || nonce
      window.postMessage(
        { __reflowAutoScroll: pageNonce, payload: { platform, state, steps: actions, ...(extra || {}) } },
        '*'
      )
    } catch {
      /* 页面卸载时忽略 */
    }
  }

  /** 找可见的叶子节点（京东的类名带 hash，只能按文案定位） */
  const visibleLeaf = (re: RegExp, maxLen: number): HTMLElement | null => {
    const nodes = Array.from(document.querySelectorAll('span,div'))
    for (const node of nodes) {
      const el = node as HTMLElement
      if (el.children.length) continue
      const t = (el.textContent || '').trim()
      if (!t || t.length > maxLen || !re.test(t)) continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      return el
    }
    return null
  }

  /** 下一页按钮：`button.nextBtn-xxxx`，类名带 hash 只能用属性包含匹配 */
  const nextButton = (): HTMLElement | null => {
    const btn = document.querySelector('button[class*="nextBtn"]') as HTMLElement | null
    if (!btn) return null
    if (btn.hasAttribute('disabled')) return null
    if (btn.getAttribute('aria-disabled') === 'true') return null
    if (/disabled/i.test(btn.className || '')) return null
    return btn
  }

  /** 要依次点的年份文案：今年 + 往前若干年 */
  const labels: string[] = (() => {
    const out: string[] = ['今年内订单']
    const y = new Date().getFullYear()
    for (let i = 1; i < totalYears; i++) out.push(`${y - i}年订单`)
    return out
  })()

  const goNextYear = (): void => {
    yearIdx++
    pageInYear = 0
    timer = setTimeout(step, 800)
  }

  const step = (): void => {
    if (stopped) return
    if (yearIdx >= labels.length) {
      report('finished', { reason: 'no-more-content' })
      return
    }
    const label = labels[yearIdx]

    // ---- 阶段一：还没进入这一年的第 1 页 → 切年份 ----
    if (pageInYear === 0) {
      const trigger = visibleLeaf(/近\d+个月|今年内订单|^\d{4}年订单$/, 24)
      if (trigger) {
        const box = (trigger.closest('div[class*=select]') ||
          trigger.parentElement) as HTMLElement | null
        if (box) box.click()
      }
      timer = setTimeout(() => {
        if (stopped) return
        const opt = visibleLeaf(new RegExp('^' + label + '$'), 24)
        if (opt) {
          const item = (opt.closest('div[class*=item]') || opt) as HTMLElement
          item.click()
          pageInYear = 1
          actions++
          report('progress', { label })
          timer = setTimeout(step, interval)
        } else {
          // 没有这一项（更早的年份可能不在列表里）：跳过
          actions++
          report('progress', { label, idle: 1 })
          goNextYear()
        }
      }, 700)
      return
    }

    // ---- 阶段二：这一年里翻到底 ----
    if (pageInYear >= maxPages) {
      goNextYear()
      return
    }
    const btn = nextButton()
    if (btn) {
      try {
        btn.click()
      } catch {
        /* 忽略点击异常 */
      }
      pageInYear++
      actions++
      report('progress', { label })
      timer = setTimeout(step, interval)
    } else {
      // 本年没有下一页了 → 换下一年
      goNextYear()
    }
  }

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    report('stopped')
  }

  w[KEY] = { stop }
  report('started', { mode: 'jd-years', total: labels.length })
  timer = setTimeout(step, 1200)
}

/**
 * 生成注入页面主世界的自动滚动脚本。
 *
 * 判定「到底」：连续 N 次滚动后 scrollHeight 不再增长（说明没有新内容加载）。
 * 脚本自报进度，主世界 → preload（nonce 校验）→ 主进程 → 渲染层。
 *
 * ⚠ 需自包含（被 toString 后注入），不能引用模块作用域变量。
 */
export function installAutoScroller(
  nonce: string,
  platform: string,
  options?: AutoScrollOptions
): void {
  const opts = Object.assign(
    { intervalMs: 2200, maxSteps: 400, idleStops: 12 },
    options || {}
  ) as Required<AutoScrollOptions>

  const KEY = '__reflowAutoScroll'
  const w = window as unknown as Record<string, unknown>
  // 重复安装时先停掉上一次
  const prev = w[KEY] as { stop?: () => void } | undefined
  if (prev?.stop) prev.stop()

  let stopped = false
  let steps = 0
  let idle = 0
  let lastHeight = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const report = (state: string, extra?: Record<string, unknown>): void => {
    try {
      // 必须用 preload 注入的 nonce：主进程传的那个 preload 不认，事件会被整包丢弃
      const pageNonce =
        ((window as unknown as Record<string, unknown>).__reflowNonce as string) || nonce
      window.postMessage(
        { __reflowAutoScroll: pageNonce, payload: { platform, state, steps, ...(extra || {}) } },
        '*'
      )
    } catch {
      /* 页面卸载时忽略 */
    }
  }

  const pickScroller = (): (Window | Element) => {
    // 优先找真正的滚动容器（页面常把列表放在固定高度容器里）
    const candidates = [
      document.scrollingElement as Element | null,
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll('[class*="scroll"],[class*="list"],[style*="overflow"]'))
    ].filter(Boolean) as Element[]

    for (const el of candidates) {
      const style = getComputedStyle(el as Element)
      const scrollable =
        el.scrollHeight > el.clientHeight + 20 &&
        /(auto|scroll)/.test(style.overflowY || '') &&
        el.clientHeight > 120
      if (scrollable) return el as Element
    }
    return window
  }

  const scrollStep = (): void => {
    if (stopped) return
    if (steps >= opts.maxSteps) {
      report('finished', { reason: 'max-steps' })
      return
    }
    steps++

    const target = pickScroller()
    const isWindow = target === window
    const el = target as Element
    const height = isWindow ? document.body.scrollHeight : el.scrollHeight
    const viewport = isWindow ? window.innerHeight : (el as HTMLElement).clientHeight

    // 滚到底（平台多在接近底部时触发加载）
    if (isWindow) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }

    const grew = height > lastHeight
    if (grew) {
      idle = 0
      lastHeight = height
    } else {
      idle++
    }

    report('progress', { height, viewport, idle })

    if (idle >= opts.idleStops) {
      report('finished', { reason: 'no-more-content' })
      return
    }
    timer = setTimeout(scrollStep, opts.intervalMs)
  }

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    report('stopped')
  }

  w[KEY] = { stop }

  report('started', { intervalMs: opts.intervalMs, maxSteps: opts.maxSteps })
  // 先记录初始高度，避免第一次判定误认为「没增长」
  lastHeight = document.body.scrollHeight
  timer = setTimeout(scrollStep, opts.intervalMs)
}
