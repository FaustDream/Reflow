/**
 * 工单 013：淘宝 C 端「已买到的宝贝」适配器。
 *
 * 被动捕获 `h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistV2` 响应
 * （大小写不敏感，含 queryboughtlistv2 变体）。响应为 mtop 节点树：
 *   data.hierarchy.structure：父 key → 子 key[]
 *   data.data：key → { id, fields } 节点映射
 * 遍历逻辑移植自原版 out/preload/preload-index.js（明文）：
 *   orderContainer → shopOrderContainer_* → shopInfo_/orderColContainer_
 *     → orderDetailCol_ → orderItemInfo_*（商品行）
 *     → orderPaymentCol_ → orderPayment_（金额）
 *
 * 与 1688 采购单（工单 014，50 列企业模板）严格分开，此处仅 C 端订单。
 * 决策 D-2：只解析，不构造请求。
 */
import { toDateTimeString } from '../../shared/datetime'
import { emptyOrder, type ExportColumn, type Order, type PageInfo } from '../../shared/types/order'
import type { CaptureReport } from '../../shared/types'
import type { ParseResult, PlatformAdapter } from './adapter'

export const TAOBAO_HOME_URL =
  'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'

type NodeMap = Record<string, TaobaoNode>
interface TaobaoNode {
  id?: string
  fields?: Record<string, any>
}
type Structure = Record<string, string[]>

const getNodeMap = (body: any): NodeMap => body?.data?.data ?? {}
const getHierarchy = (body: any): Structure => body?.data?.hierarchy?.structure ?? {}

function firstChildByPrefix(children: string[] | undefined, prefix: string): string {
  return (children ?? []).find((key) => key.startsWith(prefix)) ?? ''
}

function walkChildren(
  structure: Structure,
  key: string,
  predicate: (key: string) => boolean,
  result: string[] = []
): string[] {
  for (const childKey of structure[key] ?? []) {
    if (predicate(childKey)) {
      result.push(childKey)
      continue
    }
    walkChildren(structure, childKey, predicate, result)
  }
  return result
}

const normalizeMoney = (value: unknown): string =>
  String(value ?? '').replace(/[^\d.-]/g, '')

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

function ensureAbsoluteUrl(url: unknown): string {
  const v = str(url)
  if (!v) return ''
  return v.startsWith('//') ? `https:${v}` : v
}

/** 从店铺 outUrl 解析数字卖家 ID（shopNNNN.taobao.com 或 user_number_id 参数） */
function parseSellerId(shopUrl: unknown): string {
  const url = ensureAbsoluteUrl(shopUrl)
  const m = url.match(/shop(\d+)\.taobao\.com/)
  if (m) return m[1]
  try {
    return new URL(url).searchParams.get('user_number_id') ?? ''
  } catch {
    return ''
  }
}

interface TaobaoSub {
  title: string
  pic: string
  quantity: number | null
  skuText: string
  itemId: string
  realTotal: string
}

/** 单个商品行节点 → 精简子订单 */
function buildSub(node: TaobaoNode): TaobaoSub | null {
  const item = node.fields?.item
  if (!item) return null
  const qty = Number(item.quantity)
  const skuText = Array.isArray(item.skuInfo)
    ? item.skuInfo.map((s: any) => str(s?.skuText ?? s?.skuValue)).filter(Boolean).join('；')
    : str(item.skuText)
  return {
    title: str(item.title),
    pic: ensureAbsoluteUrl(item.pic),
    quantity: Number.isFinite(qty) ? qty : null,
    skuText,
    itemId: str(item.itemId),
    realTotal: normalizeMoney(item.priceInfo?.actualTotalFee)
  }
}

/** 单个店铺订单节点 → 统一 Order */
function buildOrder(nodeMap: NodeMap, structure: Structure, containerKey: string): Order | null {
  const containerChildren = structure[containerKey] ?? []
  const shopInfoKey = firstChildByPrefix(containerChildren, 'shopInfo_')
  const orderColKey = firstChildByPrefix(containerChildren, 'orderColContainer_')
  const shopInfoNode = nodeMap[shopInfoKey]
  const shopFields = shopInfoNode?.fields ?? {}
  const orderId = str(shopFields.orderId ?? shopInfoNode?.id)
  if (!orderId) return null

  const detailColKey = firstChildByPrefix(structure[orderColKey] ?? [], 'orderDetailCol_')
  const paymentColKey = firstChildByPrefix(structure[orderColKey] ?? [], 'orderPaymentCol_')
  const itemKeys = walkChildren(structure, detailColKey, (k) => k.startsWith('orderItemInfo_'))
  const paymentKey = walkChildren(structure, paymentColKey, (k) =>
    k.startsWith('orderPayment_')
  )[0]
  const paymentNode = nodeMap[paymentKey]
  const paymentFields = paymentNode?.fields ?? {}

  const subs = itemKeys
    .map((k) => buildSub(nodeMap[k]))
    .filter((x): x is TaobaoSub => x !== null)

  const o = emptyOrder('taobao')
  o.orderId = orderId
  o.createdAt = toDateTimeString(str(shopFields.createTime))
  o.status = str(shopFields.tradeTitle)
  o.title = subs.map((s) => s.title).filter(Boolean).join('；')
  o.imageUrl = subs[0]?.pic ?? ''
  o.quantity = subs.reduce((sum, s) => sum + (s.quantity ?? 0), 0) || null
  o.paidAmount = normalizeMoney(paymentFields.actualFee?.value)
  o.shopName = str(shopFields.shopName ?? shopFields.sellerName)
  o.unitPrice = subs[0]?.realTotal ?? ''
  o.extra = {
    ...(parseSellerId(shopFields.outUrl) ? { sellerId: parseSellerId(shopFields.outUrl) } : {}),
    ...(subs.map((s) => s.itemId).filter(Boolean).length
      ? { itemIds: subs.map((s) => s.itemId).filter(Boolean).join(',') }
      : {}),
    ...(subs.map((s) => s.skuText).filter(Boolean).join('；')
      ? { skuText: subs.map((s) => s.skuText).filter(Boolean).join('；') }
      : {}),
    ...(paymentFields.pcPostFee?.value ? { freight: normalizeMoney(paymentFields.pcPostFee.value) } : {}),
    itemCount: String(subs.length),
    ...(ensureAbsoluteUrl(shopFields.orderDetailUrl)
      ? { detailUrl: ensureAbsoluteUrl(shopFields.orderDetailUrl) }
      : {})
  }
  return o
}

export function extractTaobaoOrders(body: any): Order[] {
  const nodeMap = getNodeMap(body)
  const structure = getHierarchy(body)
  const orderKeys = (structure.orderContainer ?? []).filter((k) =>
    k.startsWith('shopOrderContainer_')
  )
  return orderKeys
    .map((k) => buildOrder(nodeMap, structure, k))
    .filter((o): o is Order => o !== null)
}

function pageInfoOf(body: any): PageInfo | undefined {
  const root = body?.data ?? {}
  const pageControl = root?.global?.pageControl ?? {}
  const currentPage = Number(root?.data?.pagination?.fields?.currentPage ?? 1)
  const hasMore =
    typeof pageControl.hasMore === 'boolean'
      ? pageControl.hasMore
      : Boolean(root?.data?.pagination?.fields?.hasMore)
  return {
    hasMore,
    cursor: String(pageControl.nextPageIndex ?? currentPage + 1)
  }
}

export const taobaoAdapter: PlatformAdapter = {
  id: 'taobao',
  displayName: '淘宝',
  homeUrl: TAOBAO_HOME_URL,
  partition: 'persist:platform-taobao',
  // unb 为数字用户 ID；_nk_ 为 URL 编码的昵称
  // 淘宝登录态只认「真的登录了」的标记：unb（用户数字 id）/ tracknick（昵称）。
  // cookie2、tfstk 访客也有，拿它们判定会「假登录」—— 界面显示已登录，
  // 但 mtop 一调就是 FAIL_SYS_SESSION_EXPIRED（2026-10-26 实测踩过）。
  login: {
    mode: 'any',
    cookies: [
      { name: 'unb', domainIncludes: 'taobao.com' },
      { name: 'tracknick', domainIncludes: 'taobao.com' }
    ],
    userIdCookie: 'unb',
    // tracknick 由登录页写，_nk_ 由 m.taobao.com 写；两者不一定同时存在
    nicknameCookies: ['tracknick', '_nk_']
  },
  matchRules: [
    // 大小写不敏感匹配（原版 isBoughtListMtopUrl 用 toLowerCase）
    { pattern: /h5api\.m\.taobao\.com\/h5\/mtop\.taobao\.order\.queryboughtlistv2/i },
    { pattern: /h5api\.m\.taobao\.com\/h5\/mtop\.taobao\.order\.queryboughtlist\b/i }
  ],
  supportsSeller: false,
  columns: [
    { key: 'sellerId', header: '卖家ID', width: 14 },
    { key: 'itemIds', header: '商品ID', width: 24 },
    { key: 'skuText', header: '规格', width: 20 },
    { key: 'freight', header: '运费', width: 8 },
    { key: 'itemCount', header: '商品件数', width: 8 },
    { key: 'detailUrl', header: '订单详情链接', width: 30 }
  ] as ExportColumn[],
  parse(report: CaptureReport): ParseResult {
    const body = report.body as any
    const retText = Array.isArray(body?.ret) ? body.ret.join(';') : str(body?.ret)
    if (/FAIL_SYS_USER_VALIDATE/i.test(retText)) {
      const e = new Error('淘宝要求滑块/人机验证，请在页面中手动完成后重试')
      e.name = 'PlatformValidateRequired'
      throw e
    }
    const orders = extractTaobaoOrders(body)
    if (!orders.length) {
      throw new Error(`淘宝订单节点树解析为空${retText ? `，ret=${retText}` : ''}`)
    }
    return { orders, pageInfo: pageInfoOf(body) }
  }
}
