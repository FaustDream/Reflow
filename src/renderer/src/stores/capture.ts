import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { CaptureEvent, CaptureErrorEvent, DeepLinkBlockedEvent } from '@shared/types'

const MAX_KEPT = 500

/**
 * 工单 004：捕获事件的渲染层汇聚点。
 * 存的是「原始响应」，尚未解析为 Order —— 解析是各平台适配器（006 起）的职责。
 */
export const useCaptureStore = defineStore('capture', () => {
  const events = ref<CaptureEvent[]>([])
  const errors = ref<CaptureErrorEvent[]>([])
  const blockedDeepLinks = ref<DeepLinkBlockedEvent[]>([])
  const initialized = ref(false)

  const count = computed(() => events.value.length)
  const lastError = computed(() => errors.value[0] ?? null)

  function init(): void {
    if (initialized.value) return
    initialized.value = true

    window.api.onCapture((payload) => {
      events.value.unshift(payload)
      if (events.value.length > MAX_KEPT) events.value.length = MAX_KEPT
    })
    window.api.onCaptureError((payload) => {
      errors.value.unshift(payload)
      if (errors.value.length > MAX_KEPT) errors.value.length = MAX_KEPT
    })
    window.api.onDeepLinkBlocked((payload) => {
      blockedDeepLinks.value.unshift(payload)
      if (blockedDeepLinks.value.length > MAX_KEPT) blockedDeepLinks.value.length = MAX_KEPT
    })
  }

  function clear(): void {
    events.value = []
    errors.value = []
    blockedDeepLinks.value = []
  }

  return { events, errors, blockedDeepLinks, count, lastError, init, clear }
})
