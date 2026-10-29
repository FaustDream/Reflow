<template>
  <webview
    ref="webviewEl"
    class="pane-webview"
    :src="src"
    :partition="partition"
    :useragent="userAgent"
    :webpreferences="webPreferences"
    @dom-ready="onDomReady"
    @did-fail-load="onFailLoad"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  src: string
  /** 会话分区。多账号（021）用不同 partition 隔离 Cookie */
  partition?: string
  userAgent?: string
}>()

/**
 * 后台抓取关键开关：页面收起后会被移出可视区（屏幕外），
 * 若沿用默认 backgroundThrottling，定时器/rAF 会被降频，
 * 滚动翻页与页面自身的懒加载都会变慢甚至停住。
 * 安全项（preload / contextIsolation / nodeIntegration / sandbox）由主进程
 * will-attach-webview 强制，这里只关节流，渲染层无法越权。
 */
const webPreferences = 'backgroundThrottling=no'

const emit = defineEmits<{
  (e: 'ready', webviewId: number): void
  (e: 'fail', detail: { code: number; description: string; url: string }): void
}>()

const webviewEl = ref<HTMLElement | null>(null)
const webviewId = ref<number | null>(null)

function onDomReady(): void {
  const el = webviewEl.value as (HTMLElement & { getWebContentsId?: () => number }) | null
  if (el?.getWebContentsId) webviewId.value = el.getWebContentsId()
  if (webviewId.value !== null) emit('ready', webviewId.value)
}

function onFailLoad(event: Event): void {
  const detail = event as Event & {
    errorCode?: number
    errorDescription?: string
    validatedURL?: string
  }
  emit('fail', {
    code: detail.errorCode ?? -1,
    description: detail.errorDescription ?? 'unknown',
    url: detail.validatedURL ?? props.src
  })
}

/** 仅 dev 诊断：在页面主世界执行代码并取回结果（Electron <webview> 内建能力） */
async function probe(code: string): Promise<unknown> {
  const el = webviewEl.value as
    | (HTMLElement & { executeJavaScript?: (c: string) => Promise<unknown> })
    | null
  if (!el?.executeJavaScript) throw new Error('webview 不支持 executeJavaScript')
  return el.executeJavaScript(code)
}

function openDevTools(): void {
  const el = webviewEl.value as
    | (HTMLElement & { openDevTools?: () => void })
    | null
  el?.openDevTools?.()
}

/** 登录成功后自动抓取：导航到目标页（订单页），触发页面自身加载 */
function navigate(url: string): void {
  const el = webviewEl.value as (HTMLElement & { loadURL?: (u: string) => void }) | null
  if (el?.loadURL) el.loadURL(url)
  else if (el) el.setAttribute('src', url)
}

/** 当前实际地址（登录后平台会自己跳几次，抓取前要确认真的停在了订单页） */
function currentUrl(): string {
  const el = webviewEl.value as (HTMLElement & { getURL?: () => string }) | null
  return el?.getURL?.() ?? ''
}

defineExpose({
  getWebviewId: () => webviewId.value,
  reload: () => (webviewEl.value as (HTMLElement & { reload?: () => void }) | null)?.reload?.(),
  navigate,
  currentUrl,
  probe,
  openDevTools
})
</script>

<style scoped>
.pane-webview {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
</style>
