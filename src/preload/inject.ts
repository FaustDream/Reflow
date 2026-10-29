/**
 * 工单 004：平台 webview 的预加载脚本（运行于 isolated 世界）。
 *
 * 职责：
 *  1. 生成一次性 nonce，把 hook-source 注入页面主世界（webFrame.executeJavaScript）
 *  2. 监听页面 postMessage，校验 nonce 后经 ipcRenderer 上报主进程
 *  3. 提供「经页面官方 SDK 发请求」的下行通道（ipc → webFrame → 页面主世界）
 *
 * 安全：contextIsolation 保持 true。页面 JS 无法触达 ipcRenderer；
 * 伪造的 postMessage 因 nonce 不匹配被丢弃。
 */
import { ipcRenderer, webFrame } from 'electron'
import { installPageHooks, protectBigInts } from './hook-source'
import { platformPageScripts } from '../shared/page-scripts'

// 注意：本 preload 运行在 sandbox:true 的 webview 中，Node 的 crypto 模块不可用，
// 只能用浏览器 Web Crypto（globalThis.crypto.getRandomValues）。
const nonceBytes = new Uint8Array(16)
globalThis.crypto.getRandomValues(nonceBytes)
const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * 关键：sandbox + contextIsolation 下，preload 运行在隔离世界（999），
 * `webFrame.executeJavaScript` 也在隔离世界求值 —— 那里看不到页面主世界的
 * `window.lib` 等对象，patch 原型也不会影响页面自身。
 * 必须用 executeJavaScriptInIsolatedWorld 显式指定 worldId=0（页面主世界），
 * 注入的 Hook / 页面脚本 / 下行 SDK 调用才与页面 JS 同世界。
 */
const MAIN_WORLD_ID = 0
const execInMainWorld = (code: string): Promise<unknown> =>
  webFrame.executeJavaScriptInIsolatedWorld(MAIN_WORLD_ID, [{ code }])

// 诊断/存活标记：DOM 跨世界共享，主世界探针据此确认 preload 已加载
const markPreloadReady = (): void => {
  document.documentElement?.setAttribute('data-reflow-preload', '1')
}
markPreloadReady()
document.addEventListener('DOMContentLoaded', markPreloadReady)

/** 注入链路错误同时落到 DOM（跨世界可读），供主世界诊断探针取回 */
const recordInjectError = (payload: unknown): void => {
  try {
    document.documentElement?.setAttribute(
      'data-reflow-inject-error',
      JSON.stringify(payload).slice(0, 500)
    )
  } catch {
    /* 属性写入失败不影响主链路 */
  }
  ipcRenderer.send('capture:error', payload)
}

// 页面主世界 → isolated 世界：捕获上报（004）
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __reflow?: string; payload?: unknown } | null
  if (!data || data.__reflow !== nonce) return
  ipcRenderer.send('capture:report', data.payload)
})

// 页面主世界 → isolated 世界：平台事件上报（006 登录态等）
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __reflowPlatform?: string; payload?: unknown } | null
  if (!data || data.__reflowPlatform !== nonce) return
  ipcRenderer.send('platform:event', data.payload)
})

// 注入 Hook。installPageHooks 以字符串形式序列化进页面主世界执行。
// 用 try/catch 包裹：executeJavaScriptInIsolatedWorld 在脚本抛错时不会 reject（Chromium 限制），
// 需由主世界脚本自己把错误经 postMessage 回传，isolated 侧校验 nonce 后转 IPC。
const wrapBootstrap = (body: string, errorStage: string, platform?: string): string => `
  try {
    ${body}
  } catch (error) {
    window.postMessage({
      __reflowInjectError: ${JSON.stringify(nonce)},
      payload: {
        stage: ${JSON.stringify(errorStage)},
        platform: ${JSON.stringify(platform ?? null)},
        message: error && error.message ? error.message : String(error)
      }
    }, '*')
  }
`
// 主世界没有模块系统：把订单号精度保护函数的源码一并传进去（16+ 位整数订单号的性命线，
// 直接 JSON.parse 会把 2100000000000000001 静默变成 2101648762899000000）
const hookSource = `(${installPageHooks.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(
  protectBigInts.toString()
)})`
void execInMainWorld(wrapBootstrap(hookSource, 'inject')).catch((error: unknown) => {
  recordInjectError({
    stage: 'inject',
    message: error instanceof Error ? error.message : String(error)
  })
})

// 注入各平台页面脚本（自护卫：仅在对应平台域生效）。
for (const script of platformPageScripts) {
  const source = `${script.source}(${JSON.stringify(nonce)})`
  void execInMainWorld(wrapBootstrap(source, 'inject-platform', script.platform)).catch(
    (error: unknown) => {
      recordInjectError({
        stage: 'inject',
        platform: script.platform,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  )
}

// 主世界脚本自报注入错误（经 nonce 校验，防页面伪造）
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __reflowInjectError?: string; payload?: unknown } | null
  if (!data || data.__reflowInjectError !== nonce) return
  recordInjectError(data.payload)
})

// 页面主世界 → isolated 世界：自动翻页进度（工单 010）
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __reflowAutoScroll?: string; payload?: unknown } | null
  if (!data || data.__reflowAutoScroll !== nonce) return
  const payload = data.payload as { platform: string; state: string; steps?: number; reason?: string }
  // 把页面侧的 state 映射成主进程事件阶段
  const phase =
    payload.state === 'started' ? 'started' : payload.state === 'progress' ? 'progress' : 'finished'
  ipcRenderer.send('autoscroll:report', {
    platform: payload.platform,
    phase,
    steps: payload.steps,
    ok: phase === 'finished' ? payload.state !== 'stopped' : undefined,
    cancelled: payload.state === 'stopped',
    reason: payload.reason
  })
})

// 主进程 → 页面主世界：经页面官方 SDK 发起请求（sign 由官方 SDK 计算，符合 D-2）
ipcRenderer.on('sdk:mtop-request', async (event, payload: { requestId: string; options: unknown }) => {
  const { requestId, options } = payload
  try {
    // 信封：隔离世界求值不传播脚本异常/ Promise rejection（结果会变 undefined），自行兜底
    const code = `(async () => {
      try {
        if (!window.__reflowPageSdk) throw new Error('页面 SDK 未就绪');
        return { ok: true, result: await window.__reflowPageSdk.mtopRequest(${JSON.stringify(options)}) };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    })()`
    const envelope = (await execInMainWorld(code)) as
      | { ok: true; result: unknown }
      | { ok: false; error: string }
      | undefined
    if (!envelope) throw new Error('主世界求值无返回（脚本可能提前被页面导航中断）')
    ipcRenderer.send('sdk:mtop-result', { requestId, ...envelope })
  } catch (error) {
    ipcRenderer.send('sdk:mtop-result', {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  // event 参数用于满足 ipcRenderer.on 签名；此处不需要 sender 信息
  void event
})

// 工单 012：主进程 → 页面主世界：同源 pageFetch（京东传统订单页分页）
ipcRenderer.on('sdk:page-fetch', async (event, payload: { requestId: string; url: string }) => {
  const { requestId, url } = payload
  try {
    const code = `(async () => {
      try {
        if (!window.__reflowPageSdk) throw new Error('页面 SDK 未就绪');
        return { ok: true, result: await window.__reflowPageSdk.pageFetch(${JSON.stringify(url)}) };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    })()`
    const envelope = (await execInMainWorld(code)) as
      | { ok: true; result: unknown }
      | { ok: false; error: string }
      | undefined
    if (!envelope) throw new Error('主世界求值无返回（脚本可能提前被页面导航中断）')
    ipcRenderer.send('sdk:page-fetch-result', { requestId, ...envelope })
  } catch (error) {
    ipcRenderer.send('sdk:page-fetch-result', {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  void event
})
