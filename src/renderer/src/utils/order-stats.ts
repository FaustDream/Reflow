/**
 * 总览页统计：把各平台订单聚合成「年 / 月 / 日 / 周 / 平台 / 状态」维度的桶。
 *
 * 纯函数，不依赖 Vue 与 Element Plus，便于单测（见 __tests__/order-stats.test.ts）。
 * 时间解析不走 `Date.parse` —— 订单时间统一是 `YYYY-MM-DD HH:mm:ss`（决策 D-3），
 * 直接正则取年月日，既不受时区影响，也不会被 `2026/10/01` 这类变体带偏。
 *
 * 每个桶都按「交易结果」拆成三份：支付成功 / 退款 / 关闭（未成交）。
 * 合计金额是毛额（含退款与关闭），净支出请看 `paidAmount`。
 */
import type { Order } from '@shared/types'

/** 交易结果：支付成功 / 退款（含退款中）/ 关闭（取消、未付款） */
export type Outcome = 'paid' | 'refunded' | 'closed'

/** 业务线：普通购物 / 外卖本地生活 */
export type BizLine = 'shopping' | 'local'

export interface Bucket {
  key: string
  label: string
  /** 全部订单（含退款、关闭） */
  count: number
  amount: number
  /** 支付成功 */
  paidCount: number
  paidAmount: number
  /** 退款成功 / 退款中 */
  refundCount: number
  refundAmount: number
  /** 关闭 / 取消（未成交） */
  closedCount: number
  closedAmount: number
}

/** 一个平台的订单集合（同平台多视角已合并，如闲鱼买/卖） */
export interface PlatformGroup {
  id: string
  name: string
  orders: Order[]
}

export interface OverviewStats {
  totalCount: number
  totalAmount: number
  paidCount: number
  paidAmount: number
  refundCount: number
  refundAmount: number
  closedCount: number
  closedAmount: number
  /** 退款率 = 退款金额 /（支付成功 + 退款） */
  refundRate: number
  /** 支付成功的平均单笔 */
  avgPaid: number
  /** 有下单记录的天数 */
  activeDays: number
  /** 最早 / 最晚下单日期 `YYYY-MM-DD`，无数据时为空串 */
  firstDate: string
  lastDate: string
  /** 按年升序（图表横轴从左到右） */
  years: Bucket[]
  /** 当前统计年份 */
  monthYear: number
  /** 当前年份的 12 个月 */
  months: Bucket[]
  /** 当前年份的每一天（无单的日子补 0，供热力图使用） */
  days: Bucket[]
  /** 周内分布，索引 0 = 周日 */
  weekdays: Bucket[]
  /** 按支付成功金额降序 */
  platforms: Bucket[]
  /** 按单量降序，最多 8 项 */
  statuses: Bucket[]
  /** 当前年份汇总 */
  year: Bucket
  /** 单量最高的年份（无数据为 null） */
  peakYear: Bucket | null
}

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** `YYYY-MM-DD...` → 年月日；解析失败返回 null */
export function parseYmd(
  value: string | null | undefined
): { y: number; m: number; d: number } | null {
  if (!value) return null
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d: d }
}

/**
 * 实付金额 → 数字。
 * 各平台给的是字符串，可能带 `¥`/`￥`、千分位；外卖单还出现过对象形态，
 * 一律清洗后取数，无法解析按 0 计（不要用 `||` 兜底 —— 0 元订单是真实存在的）。
 */
export function amountOf(order: Order): number {
  const raw = order.paidAmount
  const n = Number(String(raw ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * 交易结果分类。各平台状态文案不同（交易成功 / 已完成 / 已评价 / 退款成功 / 交易关闭 …），
 * 按语义归三类，不做逐平台映射表 —— 新状态出现时不会掉进「未知」。
 *
 * 注意顺序：先判退款再判关闭，因为「退款关闭」这类文案两种都沾。
 */
export function outcomeOfStatus(status: string): Outcome {
  if (/退款|退货|退换/.test(status)) return 'refunded'
  if (/关闭|已取消|取消|待付款|未付款/.test(status)) return 'closed'
  return 'paid'
}

export function outcomeOf(order: Order): Outcome {
  return outcomeOfStatus(order.status || '')
}

/** 淘宝 `extra.bizType`：5000 = 本地生活（外卖/闪购），200 = 普通实物，2700 = 阿里健康 */
const TAOBAO_LOCAL_BIZ_TYPE = '5000'

/** 淘宝外卖的标题特征（没有 bizType 的老缓存兜底用） */
const TB_LOCAL_TITLE_RE = /-默认$|-单点$|-到店自取$|蓝骑士|餐盒|配送费|商家配送|\d+人份/
/** 淘宝外卖的店铺特征：门店名带「(xx店)」 */
const TB_LOCAL_SHOP_RE = /\([^)]*店\)$/
/**
 * 京东外卖的判据：**没有商品页链接**（`extra.itemUrl` 为空）+ 标题是餐品。
 *
 * 京东商城订单一定有 `item.jd.com` 商品链接，外卖/秒送订单没有。
 * 但「无链接」单独不够 —— 迪卡侬/喜德盛的门店发货单、京东服务包、京东大药房送药
 * 也没有链接，所以要再叠加餐品标题。2026-10-29 用 532 条实测：
 * 命中 81 条全是餐饮/茶饮/小吃，零误判；被排除的 8 条全是实物/药品/服务。
 */
const JD_LOCAL_TITLE_RE =
  /米饭|饭|粉|汤面|面条|拌面|面馆|茶|堡|饺|比萨|披萨|麻辣烫|柠檬|套餐|人份|份|肉|鸡|鸭|菜|烤|粥|饼|串|饮|卤|鲜|虾|鱼|默认|桶|杯/

/**
 * 业务线判定：外卖/本地生活 vs 普通购物。
 *
 * 淘宝有权威字段（`extra.bizType === '5000'`，2026-10-29 抓 165 条实测：
 * 133 条 5000 全是餐饮/闪购，31 条 200 全是实物，1 条 2700 是阿里健康）；
 * 京东没有这样的枚举字段，只能靠「无商品链接 + 餐品标题」。
 */
export function bizLineOf(order: Order): BizLine {
  const bizType = order.extra?.bizType
  if (bizType) return bizType === TAOBAO_LOCAL_BIZ_TYPE ? 'local' : 'shopping'
  // 解析层若将来能直接标记，优先采信
  if (order.extra?.bizLine) return order.extra.bizLine === 'local' ? 'local' : 'shopping'

  const title = order.title || ''
  const shop = order.shopName || ''
  if (order.platform === 'taobao') {
    return TB_LOCAL_TITLE_RE.test(title) || TB_LOCAL_SHOP_RE.test(shop) ? 'local' : 'shopping'
  }
  if (order.platform === 'jd') {
    const noProductLink = !order.extra?.itemUrl
    return noProductLink && JD_LOCAL_TITLE_RE.test(title) ? 'local' : 'shopping'
  }
  return 'shopping'
}

/** 同平台多视角合并键：闲鱼卖出的订单在总览里算闲鱼 */
export function platformKeyOf(platformId: string): string {
  return platformId === 'xianyu-sold' ? 'xianyu' : platformId
}

/** `byPlatform` → 平台分组（空平台跳过，闲鱼买卖合并） */
export function groupByPlatform(
  byPlatform: Record<string, Order[]>,
  nameOf: (platformId: string) => string
): PlatformGroup[] {
  const map = new Map<string, PlatformGroup>()
  for (const [id, orders] of Object.entries(byPlatform)) {
    if (!orders?.length) continue
    const key = platformKeyOf(id)
    const group = map.get(key) ?? { id: key, name: nameOf(key) || key, orders: [] }
    group.orders.push(...orders)
    map.set(key, group)
  }
  return [...map.values()]
}

/**
 * 把京东/淘宝里的外卖订单拆成独立分组（`jd-local` / `taobao-local`）。
 * 没有外卖单的平台原样返回，外卖为空的平台不生成空分组。
 */
export function splitLocalLife(groups: PlatformGroup[]): PlatformGroup[] {
  const out: PlatformGroup[] = []
  for (const g of groups) {
    if (g.id !== 'jd' && g.id !== 'taobao') {
      out.push(g)
      continue
    }
    const local = g.orders.filter((o) => bizLineOf(o) === 'local')
    if (!local.length) {
      out.push(g)
      continue
    }
    out.push({ id: g.id, name: g.name, orders: g.orders.filter((o) => bizLineOf(o) === 'shopping') })
    out.push({ id: `${g.id}-local`, name: `${g.name}外卖`, orders: local })
  }
  return out
}

/** 统计口径：全部 / 只看网购 / 只看外卖 */
export type BizScope = 'all' | 'shopping' | 'local'

/** 按口径过滤分组；网购/外卖模式下顺手丢掉空分组，避免图上多出一行 0 */
export function filterByScope(groups: PlatformGroup[], scope: BizScope): PlatformGroup[] {
  if (scope === 'all') return groups
  const wantLocal = scope === 'local'
  return groups.filter((g) => g.id.endsWith('-local') === wantLocal && g.orders.length > 0)
}

function emptyBucket(key: string, label: string): Bucket {
  return {
    key,
    label,
    count: 0,
    amount: 0,
    paidCount: 0,
    paidAmount: 0,
    refundCount: 0,
    refundAmount: 0,
    closedCount: 0,
    closedAmount: 0
  }
}

function addTo(bucket: Bucket, outcome: Outcome, amount: number): void {
  bucket.count += 1
  bucket.amount += amount
  if (outcome === 'paid') {
    bucket.paidCount += 1
    bucket.paidAmount += amount
  } else if (outcome === 'refunded') {
    bucket.refundCount += 1
    bucket.refundAmount += amount
  } else {
    bucket.closedCount += 1
    bucket.closedAmount += amount
  }
}

/** 金额是浮点累加的，输出前统一保留两位，避免出现 6106.459999999999 */
function finalize(bucket: Bucket): Bucket {
  bucket.amount = round2(bucket.amount)
  bucket.paidAmount = round2(bucket.paidAmount)
  bucket.refundAmount = round2(bucket.refundAmount)
  bucket.closedAmount = round2(bucket.closedAmount)
  return bucket
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** 主入口：全量订单 → 总览所需的所有维度 */
export function buildOverviewStats(
  groups: PlatformGroup[],
  selectedYear: number | null
): OverviewStats {
  const yearMap = new Map<number, Bucket>()
  const monthMap = new Map<number, Bucket>()
  const dayMap = new Map<string, Bucket>()
  const weekday = WEEK_LABELS.map((label, i) => emptyBucket(String(i), label))
  const statusMap = new Map<string, Bucket>()
  const platforms: Bucket[] = []
  const totals = emptyBucket('all', '全部')
  const allDays = new Set<string>()

  // 先扫一遍年份，才能决定「没指定年份时用最新一年」
  const knownYears = new Set<number>()
  for (const g of groups) {
    for (const o of g.orders) {
      const ymd = parseYmd(o.createdAt)
      if (ymd) knownYears.add(ymd.y)
    }
  }
  const sortedYears = [...knownYears].sort((a, b) => a - b)
  const targetYear =
    selectedYear ??
    (sortedYears.length ? sortedYears[sortedYears.length - 1] : new Date().getFullYear())
  const yearBucket = emptyBucket(String(targetYear), String(targetYear))

  let firstDate = ''
  let lastDate = ''

  for (const g of groups) {
    const pb = emptyBucket(g.id, g.name)
    for (const o of g.orders) {
      const amount = amountOf(o)
      const outcome = outcomeOf(o)
      addTo(pb, outcome, amount)
      addTo(totals, outcome, amount)

      const ymd = parseYmd(o.createdAt)
      if (ymd) {
        const date = `${ymd.y}-${pad(ymd.m)}-${pad(ymd.d)}`
        if (!firstDate || date < firstDate) firstDate = date
        if (!lastDate || date > lastDate) lastDate = date
        allDays.add(date)

        const yb = yearMap.get(ymd.y) ?? emptyBucket(String(ymd.y), String(ymd.y))
        addTo(yb, outcome, amount)
        yearMap.set(ymd.y, yb)

        if (ymd.y === targetYear) {
          addTo(yearBucket, outcome, amount)

          const mb = monthMap.get(ymd.m) ?? emptyBucket(String(ymd.m), `${ymd.m}月`)
          addTo(mb, outcome, amount)
          monthMap.set(ymd.m, mb)

          const db = dayMap.get(date) ?? emptyBucket(date, date)
          addTo(db, outcome, amount)
          dayMap.set(date, db)

          addTo(weekday[new Date(ymd.y, ymd.m - 1, ymd.d).getDay()], outcome, amount)
        }
      }

      if (o.status) {
        const sb = statusMap.get(o.status) ?? emptyBucket(o.status, o.status)
        addTo(sb, outcome, amount)
        statusMap.set(o.status, sb)
      }
    }
    platforms.push(pb)
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const hit = monthMap.get(i + 1)
    return hit ? finalize(hit) : emptyBucket(String(i + 1), `${i + 1}月`)
  })

  // 热力图要「整年每一天」，没单的日子也得占一格，否则周内位置会错位
  const dayTotal = isLeapYear(targetYear) ? 366 : 365
  const days: Bucket[] = []
  for (let i = 0; i < dayTotal; i++) {
    const d = new Date(targetYear, 0, 1 + i)
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const hit = dayMap.get(date)
    days.push(hit ? finalize(hit) : emptyBucket(date, date))
  }

  const years = [...yearMap.values()].sort((a, b) => Number(a.key) - Number(b.key)).map(finalize)
  const peakYear = years.reduce<Bucket | null>(
    (best, y) => (best === null || y.count > best.count ? y : best),
    null
  )

  const denom = totals.paidAmount + totals.refundAmount

  return {
    totalCount: totals.count,
    totalAmount: round2(totals.amount),
    paidCount: totals.paidCount,
    paidAmount: round2(totals.paidAmount),
    refundCount: totals.refundCount,
    refundAmount: round2(totals.refundAmount),
    closedCount: totals.closedCount,
    closedAmount: round2(totals.closedAmount),
    refundRate: denom ? totals.refundAmount / denom : 0,
    avgPaid: totals.paidCount ? totals.paidAmount / totals.paidCount : 0,
    activeDays: allDays.size,
    firstDate,
    lastDate,
    years,
    monthYear: targetYear,
    months,
    days,
    weekdays: weekday.map(finalize),
    platforms: platforms
      .map(finalize)
      .sort((a, b) => b.paidAmount - a.paidAmount || b.paidCount - a.paidCount),
    statuses: [...statusMap.values()]
      .map(finalize)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    year: finalize(yearBucket),
    peakYear: peakYear ? finalize(peakYear) : null
  }
}
