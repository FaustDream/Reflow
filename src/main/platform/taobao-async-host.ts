/**
 * 淘宝网页版订单接口（含外卖 / 本地生活）—— 页面宿主通道（2026-11-11）。
 *
 * 为什么要改：原来在主进程用 `session.fetch` 直接 GET `asyncBought.htm`，
 * 每次都拿到 `{"rgv587_flag":"sm","url":"https://login.taobao.com/..."}` ——
 * 淘宝风控把「无页面上下文的裸请求」判定成机器流量。而同一时刻 mtop 接口
 * 是能成功的，说明登录态没问题，问题在**请求特征**：真实页面发的是 POST 表单，
 * 带 `_tb_token_`（CSRF token，页面 JS 注入）和 `x-requested-with`，裸 GET 全缺。
 *
 * 所以改成和京东同一套路：先开一个隐藏页当宿主（同 partition，登录态一致），
 * 在页面主世界里发请求 —— 指纹、UA、Cookie、Referer、CSRF token 全部天然正确。
 *
 * 页面脚本自包含（可 stringify 注入），失败时向上抛可读原因。
 */
import type { HiddenHost } from './host-window'
import { info } from '../logging/logger'

/** 网页版订单接口基址（不含分页参数） */
export const TAOBAO_ASYNC_ENDPOINT =
  'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'

/**
 * 页面内执行一页查询，返回原始响应文本。
 *
 * 先试 POST（真实页面就是这个形态），响应里没有 mainOrders 再退 GET ——
 * 淘宝不同灰度版本对 method 的容忍度不一样，两条都试成本很低。
 */
export function taobaoAsyncPageScript(page: number, tokenHint = ''): string {
  // tokenHint 由主进程从分区 Cookie 里取（_tb_token_ 可能是 httpOnly，页面 JS 读不到）
  return `(async () => {
  const token = (document.cookie.match(/(?:^|; )_tb_token_=([^;]*)/) || [])[1] || ${JSON.stringify(tokenHint)}
  const base = '${TAOBAO_ASYNC_ENDPOINT}' +
    '?action=itemlist/BoughtQueryAction&event_submit_do_query=1' +
    '&_input_charset=utf8&tabCode=all&pageNum=${page}'
  const body = new URLSearchParams({
    _tb_token_: token,
    pageNum: '${page}',
    prePageNo: '${Math.max(1, page - 1)}',
    tabCode: 'all'
  }).toString()
  const send = async (method) => {
    const res = await fetch(base, {
      method,
      credentials: 'include',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: method === 'POST' ? body : undefined
    })
    // asyncBought 是老 servlet，部分分片返回 GBK 且响应头不带 charset ——
    // 直接 res.text() 会按 UTF-8 硬解，中文变「�」。这里拿字节自己判断：
    // 先 UTF-8，出现替换字符再按 GBK 重解（GBK 解出来的替换字符更少就用它）
    const buf = await res.arrayBuffer()
    let text = new TextDecoder('utf-8').decode(buf)
    let enc = 'utf-8'
    if (text.includes('\uFFFD')) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf)
        if (gbk.split('\uFFFD').length < text.split('\uFFFD').length) {
          text = gbk
          enc = 'gbk'
        }
      } catch (e) { /* 浏览器不支持 gbk 标签时保持 utf-8 */ }
    }
    return {
      status: res.status,
      text: text.slice(0, 500000),
      enc,
      ctype: res.headers.get('content-type') || ''
    }
  }
  let r = await send('POST')
  if (!/"mainOrders"\\s*:/.test(r.text)) r = await send('GET')
  return r
})()`
}

/** 解析网页版响应；结构不对时抛出「用户能看懂」的原因 */
export function parseTaobaoAsyncResponse(text: string): { mainOrders?: unknown[] } {
  let json: { mainOrders?: unknown[]; ret?: unknown } | null = null
  try {
    json = JSON.parse(text) as { mainOrders?: unknown[]; ret?: unknown }
  } catch {
    throw new Error('网页版订单接口返回的不是 JSON（登录态可能已失效）')
  }
  if (Array.isArray(json?.mainOrders)) return json

  // rgv587_flag = 淘宝滑块风控；login.taobao.com = 被踢回登录页
  if (/rgv587/i.test(text)) {
    throw new Error('淘宝风控要求滑块验证：请打开淘宝订单页手动过一次验证，再重新抓取')
  }
  if (/login\.taobao\.com/i.test(text)) {
    throw new Error('淘宝网页版接口要求重新登录，请重新扫码')
  }
  const ret = Array.isArray(json?.ret) ? json.ret.join(';') : String(json?.ret ?? '')
  throw new Error(ret || '网页版订单接口结构异常（缺少 mainOrders）')
}

/**
 * 按字节解码网页版响应：UTF-8 优先，出现替换字符再试 GBK。
 *
 * 为什么需要：`asyncBought.htm` 是淘宝的老 servlet，部分分片用 GBK 返回且
 * 响应头不带 charset。按 UTF-8 硬解会得到「����³��」这种乱码（实测 10/88 单）。
 * 判断依据是替换字符（U+FFFD）的数量：谁解出来的更少用谁，纯 ASCII 两边一致时走 UTF-8。
 */
export function decodeResponseText(buf: ArrayBuffer): { text: string; encoding: 'utf-8' | 'gbk' } {
  const bytes = new Uint8Array(buf)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' }
  try {
    const gbk = new TextDecoder('gbk').decode(bytes)
    if (gbk.split('\uFFFD').length < utf8.split('\uFFFD').length) {
      return { text: gbk, encoding: 'gbk' }
    }
  } catch {
    /* 运行环境没有 GBK 解码器时保持 UTF-8 */
  }
  return { text: utf8, encoding: 'utf-8' }
}

/** 在宿主页里拉一页，返回解析后的 JSON */
export async function fetchTaobaoAsyncPageViaHost(
  host: HiddenHost,
  page: number,
  tokenHint = ''
): Promise<{ mainOrders?: unknown[] }> {
  const raw = (await host.evalJs<{
    status: number
    text: string
    enc?: string
    ctype?: string
  }>(taobaoAsyncPageScript(page, tokenHint), 30_000, `淘宝网页版订单 第 ${page} 页`)) as {
    status: number
    text: string
    enc?: string
    ctype?: string
  }
  if (raw.status !== 200) throw new Error(`网页版订单接口 HTTP ${raw.status}`)
  // 命中 GBK 分片时留一条：这类乱码只在特定分片出现，日志能说明「这次是怎么解的」
  if (raw.enc && raw.enc !== 'utf-8') {
    info('fetch:taobao', '网页版响应按 GBK 解码', {
      page,
      encoding: raw.enc,
      contentType: raw.ctype
    })
  }
  return parseTaobaoAsyncResponse(raw.text)
}
