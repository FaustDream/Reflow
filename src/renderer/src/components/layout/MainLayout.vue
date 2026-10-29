<template>
  <el-container class="shell">
    <el-header class="shell-header" height="48px">
      <Titlebar />
    </el-header>

    <el-main class="shell-main">
      <!-- 工单 006：平台 Tab（闲鱼起逐平台接入）；mock 仅供验证面板演示，不占平台 Tab -->
      <el-tabs
        v-if="platformTabs.length"
        v-model="activeTab"
        class="main-tabs"
      >
        <el-tab-pane v-for="a in platformTabs" :key="a.id" :name="`platform-${a.id}`" lazy>
          <template #label>{{ a.displayName }}</template>
          <PlatformPane :adapter="a" />
        </el-tab-pane>

        <el-tab-pane name="bridge" lazy>
          <template #label>验证面板</template>
          <el-container class="bridge">
            <el-aside width="52%" class="bridge-left">
              <div class="bridge-toolbar">
                <el-input
                  v-model="targetUrl"
                  size="small"
                  placeholder="加载任意页面验证注入桥，如 https://example.com"
                  @keyup.enter="load"
                />
                <el-button size="small" type="primary" @click="load">加载</el-button>
                <el-tooltip content="启动 dev-fixtures/mock-platform 本地服务后可用，用于 005 管道演示">
                  <el-button size="small" @click="loadMock">mock 平台</el-button>
                </el-tooltip>
              </div>
              <BrowserPane
                v-if="loadedUrl"
                :key="loadedUrl + partition"
                :src="loadedUrl"
                :partition="partition"
                @ready="onWebviewReady"
                @fail="onWebviewFail"
              />
              <el-empty v-else description="尚未加载页面" :image-size="64" />
            </el-aside>
            <el-aside width="48%" class="bridge-right">
              <el-tabs v-model="rightTab" class="bridge-tabs">
                <el-tab-pane name="log">
                  <template #label>捕获日志（{{ captureStore.count }}）</template>
                  <CaptureLog />
                </el-tab-pane>
                <el-tab-pane name="orders" lazy>
                  <template #label>订单表格（{{ ordersStore.total }}）</template>
                  <OrdersTable />
                </el-tab-pane>
              </el-tabs>
            </el-aside>
          </el-container>
        </el-tab-pane>
      </el-tabs>

      <el-empty v-else description="正在加载平台适配器…" :image-size="64" />
    </el-main>

    <el-footer class="shell-footer" height="28px">
      <StatusBar />
    </el-footer>
  </el-container>
</template>

<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import Titlebar from './Titlebar.vue'
import StatusBar from './StatusBar.vue'
import BrowserPane from '../platform/BrowserPane.vue'
import CaptureLog from '../platform/CaptureLog.vue'
import OrdersTable from '../platform/OrdersTable.vue'
import PlatformPane from '../platform/PlatformPane.vue'
import { useCaptureStore } from '@renderer/stores/capture'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import { MOCK_PLATFORM_ORIGIN } from '@shared/mock-platform'

const captureStore = useCaptureStore()
const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()

const activeTab = ref('')
const rightTab = ref<'log' | 'orders'>('log')

/**
 * 平台 Tab 列表：排除 mock（验证面板专用）；
 * 闲鱼卖家不单列 Tab —— 工单 011 在闲鱼 Tab 内以「买到的/卖出的」子页签承载，
 * xianyu-sold 适配器仍正常注册（被动捕获路由 / 订单分表不受影响）。
 */
const HIDDEN_STANDALONE_TABS = new Set(['mock', 'xianyu-sold'])
const platformTabs = computed(() =>
  platformsStore.adapters.filter((a) => !HIDDEN_STANDALONE_TABS.has(a.id))
)

// 适配器列表就绪后默认进入第一个平台 Tab（闲鱼）
watch(
  () => platformTabs.value.length,
  (n) => {
    if (n > 0 && !activeTab.value) {
      activeTab.value = `platform-${platformTabs.value[0].id}`
    }
  },
  { immediate: true }
)

const targetUrl = ref('https://example.com')
const loadedUrl = ref('')
const webviewId = ref<number | null>(null)
// 工单 004：独立会话分区；021 多账号时按账号切换
const partition = 'persist:reflow-verify'

function load(): void {
  const raw = targetUrl.value.trim()
  if (!raw) return
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    loadedUrl.value = u.href
    webviewId.value = null
  } catch {
    ElMessage.error('URL 不合法')
  }
}

function loadMock(): void {
  targetUrl.value = MOCK_PLATFORM_ORIGIN
  load()
}

function onWebviewReady(id: number): void {
  webviewId.value = id
  ElMessage.success(`注入桥已挂载（webview #${id}）`)
}

function onWebviewFail(detail: { code: number; description: string; url: string }): void {
  ElMessage.error(`页面加载失败 ${detail.code}: ${detail.description}`)
}

// 首批订单到达时自动切到订单表格，演示管道贯通
watch(
  () => ordersStore.total,
  (now, before) => {
    if (now > 0 && before === 0) rightTab.value = 'orders'
  }
)

// 解析异常只在第一次提醒，完整列表在订单表格头部
watch(
  () => ordersStore.parseErrors.length,
  (now, before) => {
    if (now > 0 && before === 0) {
      ElMessage.warning(`适配器解析异常：${ordersStore.parseErrors[0].message}`)
    }
  }
)

onMounted(() => {
  captureStore.init()
  ordersStore.init()
  platformsStore.init()
})
</script>

<style scoped>
.shell {
  height: 100%;
}

.shell-header {
  padding: 0;
  border-bottom: 1px solid var(--el-border-color-light);
}

.shell-main {
  padding: 0;
  background: var(--el-bg-color-page);
}

.shell-main > .el-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.shell-footer {
  padding: 0;
  border-top: 1px solid var(--el-border-color-light);
}

/* 平台 Tab 撑满主区 */
.main-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 10px;
}

.main-tabs > :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.main-tabs > :deep(.el-tabs__content) .el-tab-pane {
  height: 100%;
  overflow: hidden;
}

.bridge {
  height: 100%;
}

.bridge-left,
.bridge-right {
  display: flex;
  flex-direction: column;
  padding: 10px;
  overflow: hidden;
}

.bridge-right :deep(.bridge-tabs) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bridge-right :deep(.bridge-tabs > .el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.bridge-right :deep(.bridge-tabs .el-tab-pane) {
  height: 100%;
  overflow: hidden;
}

.bridge-left {
  border-right: 1px solid var(--el-border-color-light);
}

.bridge-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex: none;
}

.bridge-left :deep(.pane-webview),
.bridge-left :deep(.el-empty) {
  flex: 1;
  min-height: 0;
}
</style>
