/**
 * 淘宝「已买到的宝贝」**网页版**订单解析（`/trade/itemlist/asyncBought.htm` 的 mainOrders）。
 *
 * 为什么需要它（2026-11-02）：工单 040 把淘宝改成 mtop 接口直连后，用的是
 * `queryboughtlistV2` 的协议树 —— 那条通道**只返回实物订单**：
 *   - 协议树的 `shopInfo_` 字段里没有 bizType，无法判断业务线；
 *   - 饿了么/闪购（本地生活）订单根本不在里面。
 * 结果就是「淘宝外卖」永远是 0 单。网页版接口的 `mainOrders[].extra.bizType`
 * 才是权威判据（5000 = 本地生活/外卖，200 = 实物，其它如 2700 = 阿里健康）。
 *
 * 结构（真实响应，见 testdata/taobao-async-bought.json）：
 *   { error, extra, mainOrders: [ { extra:{bizType,tradeStatus}, id, orderInfo:{id,createTime},
 *     payInfo:{actualFee,postFees[]}, seller:{id,nick,shopName}, statusInfo:{text,url},
 *     subOrders:[{ quantity, itemInfo:{id,title,pic,itemUrl}, priceInfo }] } ] }
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type Order } from '../../shared/types/order'

interface AsyncSubOrder {
  quantity?: unknown
  itemInfo?: { id?: unknown; title?: unknown; pic?: unknown; itemUrl?: unknown }
  priceInfo?: { price?: unknown; actualTotalFee?: unknown }
}

interface AsyncOrder {
  id?: unknown
  extra?: { bizType?: unknown; tradeStatus?: unknown }
  orderInfo?: { id?: unknown; createTime?: unknown }
  payInfo?: { actualFee?: unknown; postFees?: Array<{ value?: unknown }> }
  seller?: { id?: unknown; nick?: unknown; shopName?: unknown }
  statusInfo?: { text?: unknown; url?: unknown }
  subOrders?: AsyncSubOrder[]
}

interface AsyncBoughtBody {
  mainOrders?: AsyncOrder[]
}

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

const money = (v: unknown): string => str(v).replace(/[^\d.-]/g, '')

const absolute = (v: unknown): string => {
  const s = str(v)
  if (!s) return ''
  return s.startsWith('//') ? `https:${s}` : s
}

/** 这份 body 是不是网页版（asyncBought）响应 */
export function isTaobaoAsyncBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && Array.isArray((body as AsyncBoughtBody).mainOrders)
}

/** 单条 mainOrders → 统一 Order */
function buildOrder(raw: AsyncOrder): Order | null {
  const orderId = str(raw.orderInfo?.id ?? raw.id)
  if (!orderId) return null
  const subs = (raw.subOrders ?? []).filter((s): s is AsyncSubOrder => !!s && !!s.itemInfo)
  const titles = subs.map((s) => str(s.itemInfo?.title)).filter(Boolean)
  const qty = subs.reduce((sum, s) => {
    const n = Number(s.quantity)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)

  const o = emptyOrder('taobao')
  o.orderId = orderId
  o.createdAt = toDateTimeString(str(raw.orderInfo?.createTime))
  o.status = str(raw.statusInfo?.text)
  o.title = titles.join('；')
  o.imageUrl = absolute(subs[0]?.itemInfo?.pic)
  o.quantity = qty > 0 ? qty : null
  o.paidAmount = money(raw.payInfo?.actualFee)
  o.shopName = str(raw.seller?.shopName ?? raw.seller?.nick)
  o.unitPrice = money(subs[0]?.priceInfo?.actualTotalFee ?? subs[0]?.priceInfo?.price)

  const bizType = raw.extra?.bizType
  const sellerId = str(raw.seller?.id)
  const itemIds = subs.map((s) => str(s.itemInfo?.id)).filter(Boolean)
  const freight = money(raw.payInfo?.postFees?.[0]?.value)
  const detailUrl = absolute(raw.statusInfo?.url)

  o.extra = {
    // bizLineOf 优先读它：5000 = 本地生活/外卖，其余一律按购物
    ...(bizType !== undefined && bizType !== null ? { bizType: str(bizType) } : {}),
    ...(sellerId ? { sellerId } : {}),
    ...(itemIds.length ? { itemIds: itemIds.join(',') } : {}),
    ...(freight ? { freight } : {}),
    ...(detailUrl ? { detailUrl } : {}),
    itemCount: String(subs.length)
  }
  return o
}

/** 整页 mainOrders → Order[]（空/异常结构返回空数组，不抛错） */
export function parseTaobaoAsyncOrders(body: unknown): Order[] {
  if (!isTaobaoAsyncBody(body)) return []
  return (body as AsyncBoughtBody).mainOrders!
    .filter((raw): raw is AsyncOrder => !!raw && typeof raw === 'object')
    .map((raw) => buildOrder(raw))
    .filter((o): o is Order => o !== null)
}
