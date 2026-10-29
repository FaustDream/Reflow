/**
 * 工单 004：注入到平台页面「主世界」的 Hook 源码。
 *
 * 以真实函数形式编写（获得 TypeScript 类型检查），由 inject preload 通过
 * `webFrame.executeJavaScript('(' + installPageHooks.toString() + ')(' + nonce + ')')`
 * 注入执行。函数必须自包含：不得引用任何 import / 闭包外部变量。
 *
 * 安全设计（相对原版的改进）：
 * - 原版闲鱼/淘宝将 webview 的 contextIsolation 设为 false，使页面 JS 与 preload 同世界，
 *   页面因此可直接触达 ipcRenderer —— 恶意平台页面可伪造任意 IPC 消息。
 * - 本实现保持 contextIsolation: true。Hook 运行在页面主世界（才能 patch 原型与调用页面 SDK），
 *   但回传通道是 postMessage + 一次性随机 nonce（闭包持有，页面读不到），
 *   isolated 世界的 preload 校验 nonce 后才转发 IPC。
 *
 * 决策 D-2：本文件只「观察」页面自身发出的请求，或经页面自带 SDK 发起请求；
 * 绝不自行构造带签名的 HTTP 请求。
 */

export interface PageHookReport {
  kind: 'xhr' | 'fetch' | 'jsonp'
  url: string
  method?: string
  /** 已解析的响应体：对象（JSON 成功时）或字符串 */
  body: unknown
  status?: number
  ts: number
}

/**
 * 订单号精度保护（关键）。
 *
 * 平台响应里的订单号常是 18~19 位整数（美团 `wm_order_id: 2100000000000000001`、
 * 得物 `orderNo: 130000000000000001`）。这些值超过 JS 安全整数上限
 * （9007199254740991），`JSON.parse` 会**静默丢精度**：末几位被抹成 0，
 * 导出到 Excel 的单号就是错的，且无法从已解析对象反推回原值。
 *
 * 修法：解析前把「整数字面量且超出安全范围」的 token 加双引号变成字符串。
 * 只在 token 层面替换（键名后的数字、数组/对象里的数字），不影响字符串内容。
 * 正则里用前导边界避免误改 `"a":123` 的 `a`，并跳过字符串内部（见下）。
 */
export function protectBigInts(text: string): string {
  // 逐字符扫描，避免正则误伤字符串内部的数字片段
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      // 原样复制整个字符串字面量（含转义）
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') j += 2
        else if (text[j] === '"') {
          j++
          break
        } else j++
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    // 数字起始：前一个非空白字符是 : [ , 或开头
    if ((ch >= '0' && ch <= '9') || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let prev = i - 1
      while (prev >= 0 && /\s/.test(text[prev])) prev--
      const boundary = prev < 0 || ':,[{'.includes(text[prev])
      let j = i + (ch === '-' ? 1 : 0)
      let digits = 0
      while (j < n && text[j] >= '0' && text[j] <= '9') {
        digits++
        j++
      }
      const isInt = j >= n || !'.eE'.includes(text[j])
      if (boundary && isInt && digits >= 16) {
        const literal = text.slice(i, j)
        // 只有真正超安全范围才加引号（16 位以内仍在安全区）
        const asNumber = Number(literal)
        if (!Number.isSafeInteger(asNumber)) {
          out += `"${literal}"`
          i = j
          continue
        }
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 安装页面 Hook。
 *
 * ⚠ 本函数会被 `toString()` 序列化后在页面主世界执行，**不能引用任何模块作用域变量**。
 * `protectBigIntsSource` 是 `protectBigInts.toString()` 的源码字符串：
 * 主世界没有模块系统，只能把依赖函数的源码当参数传进来再 eval 成局部函数。
 */
export function installPageHooks(nonce: string, protectBigIntsSource?: string): void {
  // 把本次注入的 nonce 暴露到主世界：主进程用 executeJavaScript 注入的脚本
  //（自动翻页/年份遍历）必须用它来 postMessage，否则 preload 侧校验不过，进度与结束事件全被丢弃。
  try {
    ;(window as unknown as Record<string, unknown>).__reflowNonce = nonce
  } catch {
    /* 忽略 */
  }

  // 从源码字符串恢复精度保护函数（主世界无 import）
  const protectBigInts: (text: string) => string = protectBigIntsSource
    ? (new Function(`return (${protectBigIntsSource})`)() as (text: string) => string)
    : (text: string): string => text

  const report = (payload: Omit<PageHookReport, 'ts'>): void => {
    try {
      window.postMessage({ __reflow: nonce, payload: { ...payload, ts: Date.now() } }, '*')
    } catch {
      /* 页面卸载等场景下 postMessage 可能抛错，忽略 */
    }
  }

  const looksLikeJson = (text: string): boolean => {
    const t = text.trim()
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
  }

  const safeParse = (text: string): unknown => {
    try {
      return JSON.parse(protectBigInts(text))
    } catch {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
  }

  // ---------- XHR ----------
  const RawXHR = window.XMLHttpRequest
  const rawOpen = RawXHR.prototype.open
  const rawSend = RawXHR.prototype.send

  RawXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    ;(this as XMLHttpRequest & { __reflow?: { method: string; url: string } }).__reflow = {
      method: String(method).toUpperCase(),
      url: String(url)
    }
    return rawOpen.apply(this, [method, url, ...rest] as Parameters<typeof rawOpen>)
  }

  RawXHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const meta = (this as XMLHttpRequest & { __reflow?: { method: string; url: string } }).__reflow
    if (meta) {
      this.addEventListener('loadend', () => {
        try {
          const text = this.responseText
          if (!text) return
          report({
            kind: 'xhr',
            url: meta.url,
            method: meta.method,
            status: this.status,
            body: looksLikeJson(text) ? safeParse(text) : text
          })
        } catch {
          /* responseType 为 arraybuffer/blob 时 responseText 抛错，跳过 */
        }
      })
    }
    return rawSend.apply(this, args as Parameters<typeof rawSend>)
  }

  // ---------- fetch ----------
  const rawFetch = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const promise = rawFetch.apply(window, [input, init] as Parameters<typeof rawFetch>)
    promise
      .then((response) => {
        // clone 后读取，避免消耗页面自己的 body
        response
          .clone()
          .text()
          .then((text) => {
            if (!text) return
            report({
              kind: 'fetch',
              url,
              method,
              status: response.status,
              body: looksLikeJson(text) ? safeParse(text) : text
            })
          })
          .catch(() => undefined)
      })
      .catch(() => undefined)
    return promise
  }

  // ---------- JSONP（MutationObserver 观察 <script> 注入 + 包装回调） ----------
  const CALLBACK_PARAM = /[?&](?:callback|cb|jsonp|jsonpCallback)=([^&]+)/i

  const wrapJsonpCallback = (script: HTMLScriptElement): void => {
    const src = script.src
    if (!src) return
    const m = CALLBACK_PARAM.exec(src)
    if (!m) return
    const cbName = decodeURIComponent(m[1])
    // 支持 a.b.c 形式的命名空间回调
    const parts = cbName.split('.')
    let holder: Record<string, unknown> = window as unknown as Record<string, unknown>
    for (let i = 0; i < parts.length - 1; i++) {
      holder = holder[parts[i]] as Record<string, unknown>
      if (!holder) return
    }
    const leaf = parts[parts.length - 1]
    const original = holder[leaf]
    if (typeof original !== 'function') return
    const originalFn = original as (...args: unknown[]) => unknown
    let fired = false
    holder[leaf] = function (...cbArgs: unknown[]): unknown {
      if (!fired) {
        fired = true
        report({ kind: 'jsonp', url: src, body: cbArgs[0] })
      }
      return originalFn.apply(this, cbArgs)
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLScriptElement) wrapJsonpCallback(node)
      }
    }
  })
  observer.observe(document, { childList: true, subtree: true })

  // 供后续工单（008 详情抓取等）经页面官方 SDK 发起请求的窄入口。
  // 刻意不做通用 eval：只暴露结构化调用，sign 仍由页面官方 SDK 计算（决策 D-2）。
  // 新增平台 SDK 时在此扩展 kind，而不是开放任意表达式求值。
  ;(window as unknown as Record<string, unknown>).__reflowPageSdk = {
    /** 闲鱼/淘宝系 mtop：调用页面自带的 window.lib.mtop.request */
    mtopRequest: (options: Record<string, unknown>): Promise<unknown> => {
      const lib = (window as unknown as { lib?: { mtop?: { request?: unknown } } }).lib
      const request = lib?.mtop?.request
      if (typeof request !== 'function') {
        return Promise.reject(new Error('window.lib.mtop.request 不存在（页面 SDK 未就绪）'))
      }
      return new Promise((resolve, reject) => {
        try {
          const maybePromise = (
            request as (
              o: Record<string, unknown>,
              ok: (r: unknown) => void,
              err: (e: unknown) => void
            ) => unknown
          )(
            options,
            (response) => resolve(response),
            (error) => reject(error)
          )
          if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
            ;(maybePromise as Promise<unknown>).then(resolve).catch(reject)
          }
        } catch (error) {
          reject(error)
        }
      })
    },
    /**
     * 工单 012：页面内同源 GET（相对路径或同 origin）。
     * 浏览器自动携带该平台 Cookie，等价于用户在页面内点分页；
     * 刻意禁止跨域，避免宿主把页面当成开放代理（D-2：不自行构造跨站签名请求）。
     */
    pageFetch: async (input: string): Promise<{ status: number; url: string; text: string }> => {
      const url = new URL(input, location.href)
      if (url.origin !== location.origin) {
        throw new Error('pageFetch 仅允许同源或相对路径请求')
      }
      const response = await fetch(url.href, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
        redirect: 'manual'
      })
      // 302 多为登录跳转；redirect:'manual' 时 status=0（opaque），交给调用方判定
      const text = await response.text().catch(() => '')
      return { status: response.status, url: url.href, text }
    }
  }
}
