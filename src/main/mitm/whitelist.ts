/**
 * MITM 通道的域名白名单与「哪些响应值得抓」的判定。
 *
 * 红线（docs/033 §4）：**只解密订单域名**，其它域名一律隧道透传（不解密、不记录）。
 * 因此白名单既是安全边界，也是功能边界 —— 加平台必须同时改这里和证书 SAN
 * （`scripts/gen-mitm-certs.mjs` 的 HOSTS 与之保持一致）。
 */

/** 需要 TLS 解密的域名（叶子证书 SAN 覆盖同一组） */
export const MITM_HOSTS = [
  'order.jd.com',
  'api.m.jd.com',
  'h5api.m.goofish.com',
  'h5api.m.taobao.com',
  'mobile.yangkeduo.com',
  'wx.waimai.meituan.com',
  // 美团综合订单（酒店/电影/团购/买菜）：没有 Web 入口，只能从 App 流量里被动捕获。
  // 加了这里必须同步 gen-mitm-certs.mjs 的 HOSTS 并重新生成证书，否则 SAN 不匹配。
  'i.meituan.com'
] as const

/** 是否属于解密范围（含子域名） */
export function isMitmHost(host: string): boolean {
  const h = host.toLowerCase()
  return MITM_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

/** 订单接口特征（用于过滤静态资源，避免把 js/css/图片读进内存） */
const ORDER_HINTS = ['order', 'trade', 'mtop', 'list', 'detail', 'bought', 'sold', 'purchase', 'dataline']

/**
 * 是否值得把这个响应交给捕获引擎。
 *
 * 只按「内容类型 + URL 特征」判断，**不看内容**：
 * - 静态资源（js/css/图片/字体）直接跳过，避免缓冲几 MB 的无用数据
 * - 其它响应里，JSON 或 URL 含订单特征词的才抓
 */
export function shouldCapture(url: string, contentType: string | undefined): boolean {
  const type = (contentType ?? '').toLowerCase()
  if (/javascript|css|image\/|font\/|video\/|audio\//.test(type)) return false
  if (type.includes('json')) return true
  const lower = url.toLowerCase()
  return ORDER_HINTS.some((k) => lower.includes(k))
}

/** 响应体上限：超过就放弃抓取（正常订单列表远小于这个值） */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/**
 * 把响应体转成捕获引擎要的 `body`。
 * - 标准 JSON → 对象
 * - JSONP（`cb({...})`）→ 剥壳后再 parse
 * - 其它 → 原字符串（适配器自己决定怎么处理）
 */
export function parseBody(raw: string): unknown {
  const text = raw.trim()
  if (!text) return ''
  try {
    return JSON.parse(text)
  } catch {
    /* 继续尝试 JSONP */
  }
  const jsonp = /^[\w$.[\]]+\(([\s\S]*)\);?$/.exec(text)
  if (jsonp) {
    try {
      return JSON.parse(jsonp[1])
    } catch {
      return text
    }
  }
  return text
}
