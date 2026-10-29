<template>
  <div class="orders-table">
    <div class="toolbar">
      <span class="summary">
        已捕获 <b>{{ rows.length }}</b> 单
        <template v-for="s in summaries" :key="s.platform">
          · {{ s.platform }} {{ s.count }}<template v-if="s.pageInfo">/{{ s.pageInfo.totalCount ?? '?' }}</template>
        </template>
        <template v-if="store.duplicatesTotal"> · 重复丢弃 {{ store.duplicatesTotal }}</template>
      </span>
      <!-- 工单 006/011/012/013/014：主动批量抓取（闲鱼买/卖、京东、淘宝、1688） -->
      <template v-if="fetchable">
        <el-button
          v-if="!fetchInfo.running"
          size="small"
          :disabled="webviewId === null"
          @click="onFetchAll"
        >
          抓取订单
        </el-button>
        <el-button v-else size="small" type="warning" plain @click="onCancelFetch">
          停止抓取
        </el-button>
      </template>
      <el-button size="small" text type="danger" :disabled="!rows.length" @click="onClear">
        清空
      </el-button>
      <!-- 工单 008：闲鱼详情二次抓取（地址/运费/闲鱼币/交易号/三个时间） -->
      <template v-if="platform === 'xianyu'">
        <el-button
          v-if="!detailRunning"
          size="small"
          :disabled="!pendingDetails.length || webviewId === null"
          :loading="fetchingDetails"
          @click="onFetchDetails"
        >
          提取详情{{ pendingDetails.length ? `（${pendingDetails.length} 单待提取）` : '' }}
        </el-button>
        <el-button v-else size="small" type="warning" plain @click="onCancelDetails">
          取消提取 {{ detailProgress.done }}/{{ detailProgress.total }}
        </el-button>
      </template>
      <el-button size="small" type="primary" :loading="exporting" @click="onExport">
        导出 Excel
      </el-button>
    </div>

    <!-- 主动抓取状态（闲鱼买/卖、京东、淘宝、1688） -->
    <el-alert
      v-if="fetchable && (fetchInfo.running || fetchInfo.error)"
      :type="fetchInfo.error ? 'error' : 'info'"
      :closable="false"
      class="parse-alert"
      :title="fetchInfo.error || fetchInfo.message"
    />

    <!-- 工单 008：详情抓取进度 / 结果提示 -->
    <el-progress
      v-if="platform === 'xianyu' && (detailRunning || detailProgress.total)"
      :percentage="detailProgress.total ? Math.round((detailProgress.done / detailProgress.total) * 100) : 0"
      :stroke-width="10"
      :status="detailRunning ? undefined : detailProgress.failed.length ? 'exception' : 'success'"
    />
    <el-alert
      v-if="platform === 'xianyu' && detailProgress.pausedMessage"
      type="warning"
      :closable="false"
      class="parse-alert"
      :title="`详情提取暂停：${detailProgress.pausedMessage}`"
    />
    <el-alert
      v-else-if="platform === 'xianyu' && !detailRunning && detailProgress.failed.length"
      type="error"
      :closable="false"
      class="parse-alert"
    >
      {{ detailProgress.failed.length }} 单详情失败，最近：{{ detailProgress.failed[0].message }}（可再次点击「提取详情」仅重试缺失项）
    </el-alert>

    <el-alert
      v-if="store.parseErrors.length"
      type="warning"
      :closable="false"
      class="parse-alert"
    >
      解析异常 {{ store.parseErrors.length }} 次，最近：{{ store.parseErrors[0].message }}
    </el-alert>

    <el-table
      v-if="rows.length"
      v-loading="loading"
      :element-loading-text="loadingText || '正在加载订单，请稍候…'"
      element-loading-background="rgba(255, 255, 255, 0.72)"
      :data="rows"
      size="small"
      height="100%"
      class="table"
      empty-text="暂无订单"
    >
      <el-table-column prop="platform" label="平台" width="80" />
      <el-table-column prop="orderId" label="订单号" width="150" show-overflow-tooltip />
      <el-table-column prop="title" label="商品标题" min-width="180" show-overflow-tooltip />
      <el-table-column prop="paidAmount" label="实付" width="90" align="right" />
      <el-table-column prop="quantity" label="数量" width="60" align="right" />
      <el-table-column prop="status" label="状态" width="90" />
      <el-table-column prop="createdAt" label="下单时间" width="150" />
      <el-table-column prop="shopName" label="店铺" min-width="120" show-overflow-tooltip />
      <el-table-column prop="receiverAddress" label="收货地址" width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.receiverAddress">{{ row.receiverAddress }}</span>
          <el-tag
            v-else-if="platform === 'xianyu' && row.extra.idleBizCode === '6'"
            size="small"
            type="warning"
          >
            待提取
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="扩展列" width="80" align="center">
        <template #default="{ row }">
          <el-tooltip
            v-if="Object.keys(row.extra).length"
            :content="Object.entries(row.extra).map(([k, v]) => `${k}: ${v}`).join('；')"
          >
            <el-tag size="small" type="info">{{ Object.keys(row.extra).length }}</el-tag>
          </el-tooltip>
          <span v-else>—</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty
      v-else
      :description="fetchable ? '暂无订单 — 登录后点击「抓取订单」自动拉取全部订单' : '暂无订单 — 在左侧页面浏览订单时自动捕获'"
      :image-size="60"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useOrdersStore } from '@renderer/stores/orders'
import type { Order } from '@shared/types'

type FetchablePlatform = 'jd' | 'taobao' | 'xianyu' | 'xianyu-sold'
const FETCHABLE_PLATFORMS = new Set<FetchablePlatform>([
  'jd',
  'taobao',
  'xianyu',
  'xianyu-sold'
])

const props = defineProps<{
  /** 不传则显示全部平台 */
  platform?: string
  /** 平台 webview id（工单 008 详情抓取 / 012·013 主动抓取需要） */
  webviewId?: number | null
  /** 登录态（用于闲鱼登录成功后自动抓取全量） */
  loggedIn?: boolean
  /** 为 true 且 loggedIn 变真时自动抓取一次（每个平台仅一次） */
  autoFetch?: boolean
  /** 抓取进行中：表格遮罩 + 不可操作，避免用户在半成品数据上做导出/勾选 */
  loading?: boolean
  /** 遮罩文案（默认「正在加载订单，请稍候…」） */
  loadingText?: string
}>()

const store = useOrdersStore()

const exporting = ref(false)
const fetchingDetails = ref(false)

const rows = computed<Order[]>(() =>
  props.platform ? (store.byPlatform[props.platform] ?? []) : Object.values(store.byPlatform).flat()
)

const summaries = computed(() =>
  props.platform ? store.platformSummaries.filter((s) => s.platform === props.platform) : store.platformSummaries
)

// 工单 008：闲鱼详情进度
const detailProgress = computed(() =>
  props.platform ? store.detailState(props.platform) : { running: false, total: 0, done: 0, failed: [], pausedMessage: '' }
)
const detailRunning = computed(() => detailProgress.value.running)

// 主动抓取状态（闲鱼买/卖、京东、淘宝、1688）
const fetchPlatform = computed<FetchablePlatform | null>(() =>
  props.platform && FETCHABLE_PLATFORMS.has(props.platform as FetchablePlatform)
    ? (props.platform as FetchablePlatform)
    : null
)
const fetchable = computed(() => fetchPlatform.value !== null)
const fetchInfo = computed(() =>
  props.platform ? store.fetchStateOf(props.platform) : { running: false, message: '', error: '' }
)
async function onFetchAll(): Promise<void> {
  if (props.webviewId === null || props.webviewId === undefined) {
    ElMessage.warning('页面尚未就绪，稍后再试')
    return
  }
  const platform = fetchPlatform.value
  if (!platform) return
  const options =
    platform === 'taobao'
      ? { months: 12 }
      : platform === 'jd'
        ? { range: 'current' as const }
        : undefined
  const result = await window.api.fetchAllOrders(platform, props.webviewId, options)
  if (!result.ok && !result.cancelled && result.message) ElMessage.warning(result.message)
}
async function onCancelFetch(): Promise<void> {
  const platform = fetchPlatform.value
  if (platform) await window.api.cancelFetchOrders(platform)
}

// 闲鱼：登录成功且页面就绪后自动抓取全量（每个平台仅自动一次；手动可随时再点）
const autoFetched = new Set<string>()
watch(
  [() => props.loggedIn, () => props.webviewId, () => props.platform],
  ([loggedIn, wvId, platform]) => {
    if (!props.autoFetch || !loggedIn || wvId == null || !platform) return
    if (autoFetched.has(platform)) return
    if (store.fetchStateOf(platform).running) return
    autoFetched.add(platform)
    void onFetchAll()
  },
  { immediate: true }
)

/** 仅实物商品（idleBizCode=6）且尚未成功提取过详情的订单 */
const pendingDetails = computed(() =>
  props.platform === 'xianyu'
    ? rows.value
        .filter((o) => o.extra.idleBizCode === '6' && o.extra.detailFetched !== 'true')
        .map((o) => ({ orderId: o.orderId, idleBizCode: o.extra.idleBizCode }))
    : []
)

async function onClear(): Promise<void> {
  await store.clear()
}

async function onFetchDetails(): Promise<void> {
  if (props.webviewId === null || props.webviewId === undefined) {
    ElMessage.warning('页面尚未就绪，稍后再试')
    return
  }
  const items = pendingDetails.value
  if (!items.length) return
  fetchingDetails.value = true
  try {
    const result = await window.api.fetchXianyuDetails(props.webviewId, items)
    if (!result.ok && result.message) ElMessage.warning(result.message)
  } finally {
    fetchingDetails.value = false
  }
}

async function onCancelDetails(): Promise<void> {
  if (props.webviewId !== null && props.webviewId !== undefined) {
    await window.api.cancelXianyuDetails(props.webviewId)
  }
}

async function onExport(): Promise<void> {
  if (!rows.value.length) {
    ElMessage.warning('没有可导出的订单')
    return
  }
  exporting.value = true
  try {
    const platforms = [...new Set(rows.value.map((o) => o.platform))]
    // 转普通数组：Vue reactive 的 Proxy 无法被 IPC 的 structured clone 序列化
    const result = await window.api.exportExcel([...rows.value], platforms, false)
    if (result.cancelled) return
    if (!result.ok) {
      ElMessage.error(`导出失败：${result.message ?? result.reason}`)
      return
    }
    await ElMessageBox.confirm(
      `已导出 ${rows.value.length} 单至：${result.path}`,
      '导出完成',
      {
        confirmButtonText: '打开文件',
        cancelButtonText: '打开目录',
        distinguishCancelAndClose: true,
        type: 'success'
      }
    )
      .then(() => window.api.openPath(result.path as string))
      .catch((action: string) => {
        if (action === 'cancel') window.api.showInFolder(result.path as string)
      })
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.orders-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
}

.summary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.summary b {
  color: var(--el-color-primary);
}

.parse-alert {
  flex: none;
  padding: 4px 8px;
}

.table {
  flex: 1;
  min-height: 0;
}
</style>
