<template>
  <el-container class="pane">
    <el-aside width="100%" class="pane-right">
      <div class="pane-toolbar workspace-bar">
        <!-- 工单 011：闲鱼 Tab 内买家/卖家子页签（同分区共享登录态，订单天然分表） -->
        <el-radio-group v-if="isXianyu" v-model="sellerMode" size="small">
          <el-radio-button :value="false">买到的</el-radio-button>
          <el-radio-button :value="true">卖出的</el-radio-button>
        </el-radio-group>
        <el-tag v-if="login.loggedIn" type="success" effect="plain" class="login-badge">
          {{ login.nickname || login.userId || '已登录' }}
        </el-tag>
        <!-- 被动捕获型平台（得物/快手/饿了么/美团）无 Cookie 登录态信号：
             以「已捕获到订单」反证已登录，避免一直显示「检测登录态…」 -->
        <el-tag v-else-if="capturedLogin" type="success" effect="plain" class="login-badge">
          已捕获订单
        </el-tag>
        <el-tag v-else-if="login.needsLogin" type="warning" effect="plain">请扫码登录</el-tag>
        <el-tag v-else type="info" effect="plain">
          {{ passiveCapture ? '在页面中登录后可捕获' : '检测登录态…' }}
        </el-tag>
        <span class="count">已捕获 {{ orders.count }} 单<template v-if="orders.totalCount"> / 共 {{ orders.totalCount }}</template></span>
        <div class="spacer" />
        <el-button v-if="isDev" size="small" type="warning" plain @click="onProbe">诊断</el-button>
        <el-button
          v-if="!passiveCapture"
          size="small"
          :type="login.loggedIn ? 'default' : 'primary'"
          @click="loginVisible = true"
        >
          {{ login.loggedIn ? '重新登录' : '登录' }}
        </el-button>
      </div>
      <OrdersTable
        :platform="activePlatform"
        :webview-id="webviewId"
        :logged-in="login.loggedIn"
        :auto-fetch="true"
      />
    </el-aside>

    <!--
      唯一的平台 webview：始终挂载（Cookie/官方 SDK 保活，主动抓取依赖它）。
      扫码型平台（闲鱼/京东/淘宝/拼多多）：平时 1px 不可见，需要登录时展开浮层。
      被动捕获型平台（得物/快手/饿了么/美团）：页面内自行登录，故始终以浮层显示，
      用户可直接操作页面（包含小程序跳转后的订单页）。
      不随闲鱼买/卖切换重建（两个模式共用同一会话与 SDK）。
    -->
    <div v-if="loginVisible && !passiveCapture" class="login-mask" @click.self="loginVisible = false" />
    <div
      class="webview-host"
      :class="passiveCapture || loginVisible ? 'is-login' : 'is-hidden'"
    >
      <div v-if="loginVisible && !passiveCapture" class="login-head">
        <span class="login-title">{{ adapter.displayName }}登录</span>
        <span class="login-tip">请使用手机 {{ adapter.displayName }} App 扫码登录，登录成功后自动关闭</span>
        <div class="spacer" />
        <el-button text size="small" @click="loginVisible = false">关闭</el-button>
      </div>
      <div v-else-if="passiveCapture" class="login-head">
        <span class="login-title">{{ adapter.displayName }}</span>
        <span class="login-tip">{{ passiveTip }}</span>
      </div>
      <BrowserPane
        ref="paneRef"
        :key="adapter.id + partition"
        :src="adapter.homeUrl"
        :partition="partition"
        @ready="onWebviewReady"
        @fail="onFail"
      />
    </div>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import BrowserPane from './BrowserPane.vue'
import OrdersTable from './OrdersTable.vue'
import { usePlatformsStore } from '@renderer/stores/platforms'
import { useOrdersStore } from '@renderer/stores/orders'
import type { AdapterSummary } from '@shared/types'

const props = defineProps<{ adapter: AdapterSummary }>()

const platformsStore = usePlatformsStore()
const ordersStore = useOrdersStore()

const webviewId = ref<number | null>(null)
const paneRef = ref<InstanceType<typeof BrowserPane> | null>(null)
const loginVisible = ref(false)

/** 工单 011：闲鱼 Tab 内买家/卖家切换（只影响表格分表与抓取 API，不重建 webview） */
const sellerMode = ref(false)
const activePlatform = computed(() =>
  props.adapter.id === 'xianyu' && sellerMode.value ? 'xianyu-sold' : props.adapter.id
)

// 登录事件来源平台：卖家单复用 xianyu 的登录态
const loginPlatform = computed(() => {
  if (activePlatform.value === 'xianyu-sold') return 'xianyu'
  return activePlatform.value
})
const login = computed(() => platformsStore.loginOf(loginPlatform.value))
const partition = computed(() => props.adapter.partition ?? `persist:platform-${props.adapter.id}`)
const isXianyu = computed(() => props.adapter.id === 'xianyu')

/**
 * 被动捕获型平台：没有 Cookie 登录态信号，也没有页面脚本登录轮询
 *（美团外卖就是这种，登录发生在页面自己身上）。
 * 对它们不能强行弹「扫码登录」浮层 —— 用户是在 webview 里正常登录的，
 * 浮层只会挡住页面。改为：页面始终可见，登录后订单自然进来。
 */
const PASSIVE_LOGIN_PLATFORMS = new Set(['meituan'])
const passiveCapture = computed(() => PASSIVE_LOGIN_PLATFORMS.has(activePlatform.value))
/** 被动型平台以「已捕获到订单」作为已登录的实证 */
const capturedLogin = computed(
  () => passiveCapture.value && (ordersStore.byPlatform[activePlatform.value]?.length ?? 0) > 0
)

/** 被动型平台的操作提示（原版指引来源：momao-g 各平台 Vue 组件的步骤说明） */
const PASSIVE_TIPS: Record<string, string> = {
  meituan: '在下方页面登录美团外卖后点击「订单」并向下滑动，订单会自动捕获'
}
const passiveTip = computed(() => PASSIVE_TIPS[activePlatform.value] ?? '请在页面中登录后浏览订单')

const orders = computed(() => {
  const list = ordersStore.byPlatform[activePlatform.value] ?? []
  const page = ordersStore.pageInfoByPlatform[activePlatform.value]
  return { count: list.length, totalCount: page?.totalCount }
})

function onWebviewReady(id: number): void {
  webviewId.value = id
}

// 登录成功自动收起浮层；登出（含会话失效）后重新弹出
watch(
  () => login.value.loggedIn,
  (ok) => {
    if (passiveCapture.value) return // 被动型平台页面常驻，不因登录事件收起
    if (ok) {
      loginVisible.value = false
      // 拼多多暂无主动抓取编排器：登录后让后台订单页重新加载一次，触发其自身订单请求（被动捕获）
      if (props.adapter.id === 'pdd') {
        setTimeout(() => paneRef.value?.reload(), 500)
      }
    } else {
      loginVisible.value = true
    }
  }
)
// 页面明确出现登录框（闲鱼页面脚本上报）
watch(
  () => login.value.needsLogin,
  (needs) => {
    if (needs && !login.value.loggedIn && !passiveCapture.value) loginVisible.value = true
  }
)

onMounted(() => {
  // 被动捕获型平台：页面直接展开，用户在小程序页里自行登录（无扫码浮层）
  if (passiveCapture.value) {
    loginVisible.value = true
    return
  }
  // 启动时给存量登录态检查（Cookie 存量/页面 SDK 轮询）一点时间，仍未登录再弹扫码层，避免已登录用户看到一闪
  setTimeout(() => {
    if (!login.value.loggedIn) loginVisible.value = true
  }, 1200)
})

function onFail(detail: { code: number; description: string; url: string }): void {
  ElMessage.error(`${props.adapter.displayName} 页面加载失败 ${detail.code}: ${detail.description}`)
}

// 仅 dev：诊断 webview 主世界真实状态
const isDev = import.meta.env.DEV
async function onProbe(): Promise<void> {
  const probeFn = function probe(): Promise<unknown> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
      const w = window as unknown as Record<string, unknown>
      const lib = (w.lib ?? {}) as { mtop?: Record<string, unknown> }
      const xhrOpen = XMLHttpRequest.prototype.open.toString()
      const xhrSend = XMLHttpRequest.prototype.send.toString()
      const fetchStr = window.fetch.toString()
      const out: Record<string, unknown> = {
        href: location.href,
        host: location.hostname,
        preloadLoaded: document.documentElement?.getAttribute('data-reflow-preload') === '1',
        installed: !!w.__reflowXianyuInstalled,
        pageSdk: !!w.__reflowPageSdk,
        xhrHooked: !/\[native code\]/.test(xhrOpen),
        xhrIsOurs: xhrSend.includes('__reflow'),
        fetchHooked: !/\[native code\]/.test(fetchStr),
        injectError: document.documentElement?.getAttribute('data-reflow-inject-error'),
        hasLib: !!lib.mtop,
        mtopRequestType: typeof lib.mtop?.request,
        loginBox: !!document.querySelector('#alibaba-login-box'),
        cookieNames: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean)
      }
      // mtop 登录探测仅对阿里系（闲鱼/淘宝/1688）页面执行
      const isAlibaba = /goofish\.com|taobao\.com|1688\.com$/.test(location.hostname)
      if (!isAlibaba || typeof lib.mtop?.request !== 'function') {
        resolve(out)
        return
      }
      try {
        const resp = await new Promise((res, rej) => {
          const maybe = (lib.mtop as { request: (o: unknown, ok: (r: unknown) => void, err: (e: unknown) => void) => unknown }).request(
            {
              v: '1.0',
              type: 'POST',
              api: 'mtop.taobao.idlemessage.pc.loginuser.get',
              appKey: '34839810',
              accountSite: 'xianyu',
              dataType: 'json',
              timeout: 20000,
              needLoginPC: false,
              showErrorToast: false,
              valueType: 'string',
              needLogin: false,
              sessionOption: 'AutoLoginOnly',
              ecode: 0,
              data: {}
            },
            res,
            rej
          )
          if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
            ;(maybe as Promise<unknown>).then(res, rej)
          }
        })
        const r = resp as { ret?: unknown; data?: { userId?: unknown } } | null
        out.apiRet = r?.ret
        out.userId = r?.data?.userId ?? null
      } catch (e) {
        out.apiError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }
      resolve(out)
    })
  }
  try {
    const result = (await paneRef.value?.probe(`(${probeFn.toString()})()`)) as Record<string, unknown>
    // 主进程读取的分区 Cookie（含 httpOnly，页面 JS 看不到 thor/pin 这类）
    const partitionCookies = await window.api.debugPartitionCookies(partition.value)
    const merged = { ...result, loginEvent: { ...login.value }, partitionCookies }
    console.log('[reflow probe]', merged)
    ElMessageBox.alert(
      JSON.stringify(merged, null, 2),
      '诊断（主世界 + 分区Cookie + 登录事件）',
      { customStyle: { fontSize: '12px' } }
    )
  } catch (e) {
    ElMessage.error(`诊断失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

defineExpose({ getWebviewId: () => webviewId.value })
</script>

<style scoped>
.pane {
  height: 100%;
}

.pane-right {
  display: flex;
  flex-direction: column;
  padding: 10px;
  overflow: hidden;
}

.workspace-bar {
  margin-bottom: 10px;
}

.pane-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.login-badge {
  display: inline-flex;
  align-items: center;
}

.count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.spacer {
  flex: 1;
}

/* 后台保活 webview：1px 隐藏但不 display:none，保证官方 SDK/网络持续可用 */
.webview-host {
  display: flex;
  flex-direction: column;
  background: #fff;
  overflow: hidden;
}

.webview-host.is-hidden {
  position: fixed;
  width: 1px;
  height: 1px;
  top: -10px;
  left: -10px;
  opacity: 0;
  pointer-events: none;
  border: 0;
}

.webview-host.is-login {
  position: fixed;
  z-index: 3000;
  top: 6vh;
  right: 8%;
  bottom: 6vh;
  left: 8%;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-dark);
}

.login-mask {
  position: fixed;
  z-index: 2999;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}

.login-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex: none;
}

.login-title {
  font-weight: 600;
}

.login-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.webview-host :deep(.pane-webview) {
  flex: 1;
  min-height: 0;
}
</style>
