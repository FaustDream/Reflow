<template>
  <el-dialog
    v-model="visible"
    :title="`登录 ${platformName}`"
    width="380px"
    align-center
    :close-on-click-modal="false"
    :show-close="true"
    class="login-dialog"
    @closed="onClosed"
  >
    <div class="login-body">
      <!-- 纯二维码模式：只显示二维码，不显示任何网页 -->
      <template v-if="source === 'page'">
        <el-icon class="login-spinner" :size="28"><Loading /></el-icon>
        <p class="login-tip">已打开登录窗口，请完成登录…</p>
        <p class="login-sub">{{ platformName }} 需要在其官方页面登录，登录完成后会自动关闭</p>
      </template>

      <template v-else-if="qrImage">
        <img class="qr-img" :src="qrImage" alt="登录二维码" @error="onImageError" />
        <p class="login-tip">{{ statusText }}</p>
        <p v-if="statusHint" class="login-sub">{{ statusHint }}</p>
      </template>

      <template v-else-if="loading">
        <el-icon class="login-spinner is-loading" :size="28"><Loading /></el-icon>
        <p class="login-tip">正在获取二维码…</p>
        <p v-if="errorText" class="login-sub is-error">{{ errorText }}</p>
      </template>

      <template v-else>
        <p class="login-tip is-error">{{ errorText || '获取二维码失败' }}</p>
      </template>
    </div>

    <template #footer>
      <div class="login-footer">
        <el-button v-if="!loading" size="small" text @click="refresh">刷新二维码</el-button>
        <el-button size="small" @click="visible = false">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Loading } from '@element-plus/icons-vue'

const props = defineProps<{
  modelValue: boolean
  platformId: string
  platformName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'success'): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const loading = ref(false)
/** 防止重复启动（打开弹窗与点「刷新」可能同时触发） */
let starting = false
const qrImage = ref('')
const source = ref<'native' | 'dom' | 'page'>('native')
const state = ref<'idle' | 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'>('idle')
const statusMessage = ref('')
const errorText = ref('')

const statusText = computed(() => {
  if (state.value === 'scanned') return statusMessage.value || '已扫描，请在手机上确认'
  if (state.value === 'success') return '登录成功'
  if (state.value === 'expired') return '二维码已过期'
  return statusMessage.value || '请使用手机 App 扫描二维码'
})

const statusHint = computed(() => {
  if (state.value === 'expired') return '点击下方「刷新二维码」重新获取'
  if (source.value === 'native') return '扫码后请在手机上确认登录'
  return ''
})

/** 订阅主进程推来的登录状态 */
const unsubscribe = window.api.onLoginStatus((payload) => {
  if (payload.platformId !== props.platformId) return
  state.value = payload.state
  statusMessage.value = payload.message
  // 二维码被页面换新（过期重发）：必须换图，否则用户扫的是作废的码
  if (payload.qrImage) {
    qrImage.value = payload.qrImage
    errorText.value = ''
  }
  if (payload.state === 'success') {
    emit('success')
    // 成功后稍等片刻关闭，让用户看到「登录成功」
    setTimeout(() => {
      visible.value = false
    }, 700)
  } else if (payload.state === 'expired' || payload.state === 'failed') {
    errorText.value = payload.message
  }
})
onUnmounted(() => unsubscribe())

async function refresh(): Promise<void> {
  if (starting) return
  starting = true
  loading.value = true
  qrImage.value = ''
  errorText.value = ''
  state.value = 'idle'
  statusMessage.value = ''
  try {
    const result = await window.api.startLogin(props.platformId)
    if (!result.ok) {
      errorText.value = result.message ?? '启动登录失败'
      return
    }
    source.value = result.source ?? 'native'
    if (result.qrImage) {
      qrImage.value = result.qrImage
    } else if (result.source === 'page') {
      // page 模式：主进程已打开独立小窗，弹窗只提示
      statusMessage.value = '请在弹出的窗口中完成登录'
    } else {
      // 主进程说成功了却没给二维码：必须明说，否则界面只剩一句「获取二维码失败」，
      // 用户不知道该重试还是换方式（2026-10-26 用户实测就是这个状态）
      errorText.value = '没有拿到二维码，请点「刷新二维码」重试'
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    starting = false
  }
}

function onImageError(): void {
  // 远端图片可能因防盗链失败：转成提示而不是碎图
  if (qrImage.value.startsWith('http')) {
    // 阿里二维码图走 alicdn，通常可直连；失败时提示刷新
    errorText.value = '二维码图片加载失败，请刷新重试'
  }
}

function onClosed(): void {
  void window.api.cancelLogin(props.platformId)
  qrImage.value = ''
  state.value = 'idle'
  statusMessage.value = ''
  errorText.value = ''
}

// 打开时自动拉取二维码。
// `immediate` 是必须的：父组件用 `v-if` 挂着这个弹窗，平台列表刷新/切平台会重建组件，
// 重建时 `modelValue` 已经是 true，watch 不会触发 → 弹窗永远停在「获取二维码失败」
// （2026-10-26 用户实测：扫码后弹窗就是这个状态，二维码根本没显示出来）。
watch(
  () => props.modelValue,
  (open) => {
    if (open) void refresh()
  },
  { immediate: true }
)
</script>

<style scoped>
.login-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
  min-height: 220px;
  justify-content: center;
}

.qr-img {
  width: 200px;
  height: 200px;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter);
}

.login-tip {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
  text-align: center;
}

.login-sub {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.login-sub.is-error,
.login-tip.is-error {
  color: var(--el-color-danger);
}

.login-spinner {
  color: var(--el-color-primary);
}

.login-spinner.is-loading {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.login-footer {
  display: flex;
  justify-content: space-between;
}
</style>
