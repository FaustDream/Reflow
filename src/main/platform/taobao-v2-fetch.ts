/**
 * 淘宝订单全量抓取（走页面内的 lib.mtop，不是 MITM）。
 *
 * 这是魔猫的真实做法（`work/asar_taobao/docs/2026-08-04.md`）：
 * 在已登录的淘宝页面里调 `lib.mtop.request`，签名由页面 SDK 自己算，
 * 所以既不需要逆向 sign，也不需要 MITM。
 *
 * 之前调用一直 TIMEOUT，原因就是少了 `appKey: '12574478'` 和 `ecode: 1`。
 *
 * 接口：`mtop.taobao.order.queryboughtlistV2`（POST）
 * 入参：`data:{tabCode:'all', page:N, OrderType:'OrderList', appName:'tborder', appVersion:'3.0'}`
 * 响应：`data.result` 是**序列化的 JSON 字符串**，解出来是
 *       `{ mainOrders: Order[], page: { currentPage, totalPage, totalNumber } }`
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type Order } from '../../shared/types/order'

/** 页面脚本的返回结构 */
export interface TaobaoFetchAllRaw {
  error: string | null
  orders: Array<Record<string, unknown>>
  /** 实际扫描到的月份数（按月分段抓取） */
  months?: number
}

/** 页面内执行：**按月分段**逐页拉全部订单（自包含，可 toString 注入）。
 *
 * 这是魔猫 `work/asar_taobao/out/preload/preload-index.js` 的做法（`buildMtopRequestPayload` +
 * `getMonthRange` + `orderMap.set(order.id, ...)`）：
 * - `OrderType: "OrderFilter"`（不是 "OrderList"），配 `condition.orderFilterExtParam`
 *   给 `beginTime/endTime`（`YYYY-MM-DD HH:mm:ss`），**按月过滤**
 * - 翻页用 `page`，并按 `nextPageIndex` 推进
 * - 全部结果按 `order.id` 去重（Map）
 *
 * 之前用 `OrderType: "OrderList"` + 不带 `condition` 的一次全抓，会把不同月份的分页
 * 互相覆盖，结果既不全也会重复 —— 这就是「97 单」比真实值多的原因。
 */
export const TAOBAO_FETCH_ALL_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pad2 = (n) => String(n).padStart(2, '0')
  const fmt = (ts) => {
    const d = new Date(ts)
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }
  const monthRange = (ts) => {
    const d = new Date(ts)
    return {
      start: new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime(),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
    }
  }
  const buildCondition = (start, end) =>
    JSON.stringify({
      directRouteToTm2Scene: '1',
      wordType: '3',
      wordTerm: '',
      showText: '',
      itemTitle: '',
      orderFilterExtParam: JSON.stringify({ beginTime: fmt(start), endTime: fmt(end) })
    })

  /**
   * 单次调用：**不带 condition 的全量分页**（实测可用）。
   * 之前用 OrderType=OrderFilter + 按月过滤，接口只回空数组 —— 这就是淘宝一直只有 32 单的原因。
   * 另外 result 是 **JSON 字符串**，必须二次 parse。
   * appVersion/appName 是必填业务参数，缺了直接 FAIL_SYS_BIZPARAM_MISSED。
   */
  const callMtop = (page) =>
    new Promise((resolve) => {
      try {
        window.lib.mtop.request(
          {
            api: 'mtop.taobao.order.queryboughtlistV2',
            v: '1.0',
            type: 'POST',
            dataType: 'json',
            timeout: 15000,
            data: {
              tabCode: 'all',
              page: String(page),
              pageSize: '20',
              appVersion: '1.0.0',
              appName: 'taobao'
            }
          },
          (res) => resolve(res),
          (err) => resolve({ __err: err })
        )
      } catch (e) {
        resolve({ __err: String(e) })
      }
    })

  const map = new Map()
  let page = 1
  let totalPage = 1

  // 全量分页：接口一次返回 totalPage，逐页拉完即可（实测 34 页 / 504 单）
  for (;;) {
    // 单页失败重试：mtop 偶发超时/风控，直接 break 会导致只抓到前几页（实测停在 62 单）
    let res = null
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await callMtop(page)
      const ok = res && !res.__err && res.data && res.data.result
      if (ok) break
      await sleep(1500)
    }
    if (res && res.__err) {
      // 出错时把已抓到的交出去，不要整批丢掉
      return { error: JSON.stringify(res.__err).slice(0, 120), orders: Array.from(map.values()), months: page }
    }
    let parsed = null
    const rawResult = res && res.data && res.data.result
    if (rawResult) {
      try {
        parsed = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult
      } catch (e) {
        parsed = null
      }
    }
    if (!parsed) break
    const list = parsed.mainOrders || []
    for (const m of list) {
      if (m && m.id) map.set(String(m.id), m)
    }
    totalPage = (parsed.page && parsed.page.totalPage) || 1
    if (page >= totalPage || page >= 120) break
    page++
    await sleep(1100)
  }

  return { error: null, orders: Array.from(map.values()), months: totalPage }
})()`

/** 单条原始订单 → 我们的 Order（字段路径全部容错） */
export function toOrderFromMain(m: Record<string, unknown>): Order {
  const sub = Array.isArray(m.subOrders) ? (m.subOrders as Array<Record<string, unknown>>) : []
  const itemOf = (s: Record<string, unknown>): Record<string, unknown> =>
    ((s?.itemInfo ?? s?.item ?? {}) as Record<string, unknown>)
  const title = sub
    .map((s) => {
      const info = itemOf(s)
      return String(info.title ?? info.name ?? '')
    })
    .filter(Boolean)
    .join(' ')

  const orderInfo = (m.orderInfo ?? {}) as Record<string, unknown>
  const payInfo = (m.payInfo ?? {}) as Record<string, unknown>
  const seller = (m.seller ?? {}) as Record<string, unknown>
  const statusInfo = (m.statusInfo ?? {}) as Record<string, unknown>

  const amount = amountOf(payInfo)
  const first = sub[0] ? itemOf(sub[0]) : {}
  const firstPrice = sub[0]
    ? ((sub[0].priceInfo ?? {}) as Record<string, unknown>).realTotal
    : undefined
  // 外卖/闪购单的件数在 payInfo.total.value，商品行自身也各带 quantity
  const qty = sub.reduce((sum, s) => {
    const n = Number(s.quantity)
    return Number.isFinite(n) ? sum + n : sum
  }, 0)

  // `extra.bizType` 是淘宝官方的业务类型：5000 = 本地生活（外卖/闪购），200 = 普通实物。
  // 总览页要靠它把外卖拆成独立分组，所以必须落盘 —— 只靠标题特征会漏掉
  // 「手撕半只荷叶鸡+米饭」这类没有 -默认 后缀、店铺名又为空的单。
  const extra = (m.extra ?? {}) as Record<string, unknown>
  const bizType = extra.bizType === undefined || extra.bizType === null ? '' : String(extra.bizType)

  return {
    ...emptyOrder('taobao'),
    orderId: String(m.id ?? orderInfo.id ?? ''),
    title,
    imageUrl: String(first.pic ?? ''),
    quantity: qty > 0 ? qty : null,
    unitPrice: normalizeFee(firstPrice),
    paidAmount: amount ? Number(amount).toFixed(2) : '',
    createdAt: toDateTimeString(String(orderInfo.createTime ?? orderInfo.createDay ?? '')),
    shopName: String(seller.shopName ?? seller.nick ?? ''),
    status: String(statusInfo.text ?? ''),
    platform: 'taobao',
    extra: bizType ? { bizType } : {}
  }
}

/**
 * 金额字段有两种形态（2026-10-29 抓包实测）：
 * - 普通实物单：`payInfo.actualFee` 是字符串 `"23.39"`
 * - 外卖/淘宝闪购单：`actualFee` 是对象 `{ prefix:'合计', value:'￥9.40' }`
 *
 * 之前直接 `String(actualFee)`，对象会变成 `"[object Object]"`，清洗后为空
 * → 28 单外卖订单「只有商品名、没有金额」。
 */
function amountOf(pay: Record<string, unknown>): string {
  for (const key of ['actualFee', 'totalFee'] as const) {
    const v = pay[key]
    if (v === undefined || v === null) continue
    const inner = typeof v === 'object' ? (v as Record<string, unknown>).value : v
    if (inner === undefined || inner === null) continue
    const cleaned = String(inner).replace(/[^\d.-]/g, '')
    if (cleaned) return cleaned
  }
  return ''
}

/** 单价的同款兼容：字符串直接清洗，对象取 value */
function normalizeFee(v: unknown): string {
  if (v === undefined || v === null) return ''
  const inner = typeof v === 'object' ? (v as Record<string, unknown>).value : v
  if (inner === undefined || inner === null) return ''
  const cleaned = String(inner).replace(/[^\d.-]/g, '')
  return cleaned ? Number(cleaned).toFixed(2) : ''
}
