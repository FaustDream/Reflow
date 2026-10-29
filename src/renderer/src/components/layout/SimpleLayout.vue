<template>
  <el-container class="shell">
    <el-header class="shell-header" height="44px">
      <div class="titlebar">
        <span class="brand">Reflow</span>
        <div class="spacer" />
        <span class="summary">共 {{ visibleTotal }} 单</span>
        <el-dropdown trigger="click" @command="onToolCommand">
          <el-button size="small" text>
            工具
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="history">导出记录</el-dropdown-item>
              <el-dropdown-item command="import" divided>导入订单文件…</el-dropdown-item>
              <el-dropdown-item command="mitm">抓取通道（MITM）</el-dropdown-item>
              <el-dropdown-item command="platforms">显示的平台</el-dropdown-item>
              <el-dropdown-item command="capture-log">捕获日志</el-dropdown-item>
              <el-dropdown-item command="diagnostics">诊断信息</el-dropdown-item>
              <el-dropdown-item command="clear" divided>清空数据</el-dropdown-item>
              <el-dropdown-item command="about" divided>关于</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          size="small"
          type="primary"
          :disabled="!filteredOrders.length"
          @click="openExport('current')"
        >
          导出
        </el-button>
      </div>
    </el-header>

    <el-container class="shell-body">
      <!-- 左侧：平台列表（唯一导航，替代原来的 11 个 Tab） -->
      <el-aside width="240px" class="sidebar">
        <div class="sidebar-head">
          <span>平台</span>
          <span class="sidebar-total">{{ platforms.length }} 个</span>
        </div>
        <div class="platform-list">
          <!-- 用 div 而非 button：里面还要放一个「重新加载」小按钮，button 不能嵌套 -->
          <div
            v-for="p in platforms"
            :key="p.id"
            class="platform-item"
            :class="{ active: activeId === p.id }"
            role="button"
            tabindex="0"
            @click="selectPlatform(p.id)"
            @keydown.enter="selectPlatform(p.id)"
          >
            <span class="platform-avatar" :class="{ 'is-off': !p.loggedIn }">
              {{ initialOf(p.displayName) }}
            </span>
            <span class="platform-name">{{ p.displayName }}</span>
            <span class="platform-meta" :class="{ 'has-orders': p.count > 0 }">
              {{ p.count > 0 ? `${p.count} 单` : '—' }}
            </span>
            <el-icon
              class="platform-reload"
              :class="{ spinning: !!reloading[p.id] }"
              :title="`重新加载${p.displayName}订单（后台进行，不影响其他平台）`"
              @click.stop="reloadPlatform(p.id)"
            >
              <Refresh />
            </el-icon>
            <span class="platform-dot" :class="p.loggedIn ? 'is-on' : 'is-off'" />
          </div>
        </div>
      </el-aside>

      <!-- 右侧：当前平台的一张表 + 筛选条 -->
      <el-main class="content">
        <div class="content-head">
          <span class="content-title">{{ active?.displayName ?? '—' }}</span>
          <!-- 闲鱼买/卖视角切换（两个视角共用登录态与页面） -->
          <el-radio-group v-if="activeId === 'xianyu'" v-model="xianyuSeller" size="small">
            <el-radio-button :value="false">买到的</el-radio-button>
            <el-radio-button :value="true">卖出的</el-radio-button>
          </el-radio-group>
          <!--
            登录态 + 登录入口。
            原版魔猫的主窗口本身就是内嵌浏览器，登录页就是主界面，不存在「先打开页面」这一步；
            我们把页面做成了可收起的侧栏，所以登录动作要自己把页面打开并跳到登录页。
          -->
          <el-dropdown v-if="login.loggedIn" trigger="click" @command="onAccountMenu">
            <el-tag size="small" type="success" effect="plain" class="account-tag">
              {{ login.nickname || login.userId || '已登录' }}
            </el-tag>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="relogin">重新登录</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tag v-else-if="capturedCount > 0" size="small" type="success" effect="plain">
            已捕获订单
          </el-tag>
          <el-tag v-else size="small" type="info" effect="plain">未登录</el-tag>
          <el-button
            v-if="!login.loggedIn"
            size="small"
            type="primary"
            :disabled="!active"
            @click="startLoginFlow"
          >
            登录
          </el-button>

          <div class="spacer" />

          <!-- 原版作法：平台页面就在界面上（右侧分栏），边逛边抓；收起后在后台继续捕获 -->
          <el-button size="small" :type="pageShown ? 'default' : 'primary'" :plain="!pageShown" @click="togglePagePane" :disabled="!active">
            {{ pageShown ? '收起页面' : '打开页面' }}
          </el-button>
          <!-- 接口型平台：手动重新抓取（后台逐页取，不弹页面） -->
          <el-button
            v-if="fetchable"
            size="small"
            :disabled="webviewId === null || captureRunning"
            @click="startAutoCapture"
          >
            {{ captureRunning ? '抓取中…' : '抓取订单' }}
          </el-button>
          <!-- 工单 010：滚动加载型平台的后台翻页 -->
          <el-button
            v-if="scrollable"
            size="small"
            :type="scrollRunning ? 'warning' : 'default'"
            :plain="scrollRunning"
            :disabled="webviewId === null"
            @click="toggleAutoScroll"
          >
            {{ scrollRunning ? `停止翻页（${scrollSteps}）` : '后台翻页' }}
          </el-button>
        </div>

        <!-- 抓取进度：原版是「页面就在眼前」，这里补一条明确的状态，避免以为没在抓 -->
        <div v-if="captureRunning" class="capture-bar">
          <el-icon class="capture-spin"><Loading /></el-icon>
          <span class="capture-text">{{ captureText }}</span>
          <el-button link size="small" @click="stopCapture">停止</el-button>
        </div>

        <!-- 筛选条：搜索 / 时间 / 状态 + 统计 + 导出入口 -->
        <div class="filter-bar">
          <el-input
            v-model="keyword"
            size="small"
            placeholder="搜索订单号 / 商品 / 店铺 / 收货人"
            clearable
            class="filter-search"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-select v-model="timeRange" size="small" class="filter-time">
            <el-option label="全部时间" value="all" />
            <el-option label="近 7 天" value="7" />
            <el-option label="近 30 天" value="30" />
            <el-option label="近 90 天" value="90" />
          </el-select>
          <el-select v-model="statusFilter" size="small" class="filter-status" placeholder="全部状态">
            <el-option label="全部状态" value="" />
            <el-option
              v-for="s in statusOptions"
              :key="s.value"
              :label="`${s.value}（${s.count}）`"
              :value="s.value"
            />
          </el-select>
          <el-button v-if="hasFilter" link size="small" @click="resetFilters">重置</el-button>

          <div class="spacer" />

          <span class="stat">
            <template v-if="hasFilter">{{ filteredOrders.length }} / {{ currentOrders.length }} 单</template>
            <template v-else>{{ currentOrders.length }} 单</template>
            · 合计 <b>¥{{ filteredAmount }}</b>
          </span>
          <span v-if="selectedOrders.length" class="stat stat-selected">
            已选 {{ selectedOrders.length }} 单 · ¥{{ selectedAmount }}
          </span>
          <el-button
            v-if="selectedOrders.length"
            size="small"
            @click="openExport('selected')"
          >
            导出勾选（{{ selectedOrders.length }}）
          </el-button>
          <el-button
            size="small"
            type="primary"
            :disabled="!filteredOrders.length"
            @click="openExport('current')"
          >
            导出本平台（{{ filteredOrders.length }}）
          </el-button>
        </div>

        <OrderTable
          ref="tableRef"
          :orders="filteredOrders"
          :loading="false"
          :selectable="true"
          :empty-text="emptyText"
          @selection-change="onSelectionChange"
        />
      </el-main>

      <!--
        平台页面（原版作法：页面就在界面上，边逛边抓）。
        收起时不卸载 webview —— 缩成 1px 继续跑，登录态与被动捕获不断。
      -->
      <div class="page-pane" :class="{ collapsed: !pageShown }">
        <div v-if="pageShown" class="page-pane-head">
          <span class="page-pane-title">{{ active?.displayName }} 页面</span>
          <el-tag v-if="captureRunning" size="small" type="warning" effect="plain">后台抓取中</el-tag>
          <!--
            登录只存在于「打开页面」之后：未登录时在这里扫码，或直接在页面里登录。
            左侧列表不再挂任何登录入口（2026-10-26 用户要求）。
          -->
          <!--
            登录入口统一在顶部工具栏（点「登录」会自动打开本面板并跳到登录页）。
            这里只显示状态提示，不再放按钮 —— 免得同一个动作有两个入口。
          -->
          <template v-if="!login.loggedIn">
            <el-tag size="small" type="info" effect="plain">未登录</el-tag>
            <span class="page-login-tip">{{ pageLoginTip }}</span>
          </template>
          <div class="spacer" />
          <el-button size="small" text @click="paneRef?.reload()">刷新</el-button>
          <el-button size="small" text @click="togglePagePane">收起</el-button>
        </div>
        <BrowserPane
          v-if="active"
          :key="webviewKey"
          ref="paneRef"
          :src="active.homeUrl"
          :partition="partitionOf(active)"
          :useragent="paneUserAgent"
          @ready="onWebviewReady"
        />
      </div>
    </el-container>

    <el-footer height="26px" class="shell-footer">
      <StatusBar />
    </el-footer>

    <LoginDialog
      v-if="active"
      v-model="loginVisible"
      :platform-id="active.id"
      :platform-name="active.displayName"
      @success="onLoginSuccess"
    />

    <!-- 工单 031：导出中心（范围 / 格式 / 列 / 含图 / 汇总） -->
    <ExportDialog
      v-model="exportVisible"
      :active-platform-id="activeId"
      :active-platform-name="active?.displayName ?? ''"
      :current-orders="filteredOrders"
      :selected-orders="selectedOrders"
      :default-scope="exportScope"
    />

    <!-- 平台显示设置：不需要的平台勾掉即可，数据仍留在本地 -->
    <el-dialog v-model="platformsVisible" title="显示哪些平台" width="560px">
      <p class="plat-hint">取消勾选只是隐藏左侧入口，已抓的订单仍保存在本地；重新勾上就能看到。</p>
      <el-checkbox-group v-model="platformDraft" class="plat-group">
        <el-checkbox v-for="p in selectablePlatforms" :key="p.id" :value="p.id" class="plat-item">
          {{ p.displayName }}
          <span class="plat-count">{{ ordersStore.byPlatform[p.id]?.length ?? 0 }} 单</span>
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button size="small" @click="platformDraft = selectablePlatforms.map((p) => p.id)">
          全部显示
        </el-button>
        <el-button size="small" @click="platformsVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="savePlatforms">保存</el-button>
      </template>
    </el-dialog>

    <!--
      捕获日志：把「没数据」变成可诊断的事实 ——
      到底是没捕获到请求、还是没匹配上平台规则、还是匹配了但解析失败。
    -->
    <el-dialog v-model="captureLogVisible" title="捕获日志（最近 150 条）" width="860px">
      <div class="cap-log-bar">
        <span class="cap-log-hint">
          已入库 = 命中平台规则并解析出订单；解析失败 = 命中了但字段不对；无关 = 与订单无关的网页流量
        </span>
        <div class="spacer" />
        <el-button size="small" @click="refreshCaptureLog">刷新</el-button>
      </div>
      <el-table
        :data="captureLog"
        size="small"
        height="420"
        empty-text="还没有捕获记录 — 先在右侧页面里登录并打开订单列表"
      >
        <el-table-column label="时间" width="86">
          <template #default="{ row }">{{ clockOf(row.ts) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="92">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.outcome === 'ok' ? 'success' : row.outcome === 'error' ? 'danger' : 'info'"
            >
              {{ row.outcome === 'ok' ? '已入库' : row.outcome === 'error' ? '解析失败' : '无关' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="平台" width="80">
          <template #default="{ row }">{{ row.platform || '—' }}</template>
        </el-table-column>
        <el-table-column label="说明" width="190" prop="detail" show-overflow-tooltip />
        <el-table-column label="URL" min-width="300">
          <template #default="{ row }">
            <span class="cap-log-url">{{ row.url }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <ExportHistoryDialog v-model="historyVisible" />
    <MitmSettingsDialog v-model="mitmVisible" />
    <AboutDialog v-model="aboutVisible" />

    <!-- 首屏：等历史订单全部读进内存再显示，避免先闪「暂无订单」再跳出几百条 -->
    <div v-if="ordersStore.cacheLoading" class="boot-mask">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <p class="boot-text">正在加载历史订单…</p>
      <p class="boot-sub">首次启动要读完本地全部缓存，请稍候</p>
    </div>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowDown, Loading, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import BrowserPane from '../platform/BrowserPane.vue'
import LoginDialog from '../platform/LoginDialog.vue'
import OrderTable from '../platform/OrderTable.vue'
import ExportDialog from '../export/ExportDialog.vue'
import ExportHistoryDialog from '../export/ExportHistoryDialog.vue'
import AboutDialog from './AboutDialog.vue'
import MitmSettingsDialog from '../settings/MitmSettingsDialog.vue'
import StatusBar from './StatusBar.vue'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import type { AdapterSummary, Order } from '@shared/types'
import { HIDDEN_PLATFORMS } from '@shared/platform-visibility'

defineProps<{
  /**
   * 工单 024：引导里选的常用平台。
   * 已不再用于过滤（用户要「默认全部显示，不需要的自己藏」），保留仅为兼容调用方。
   */
  onlyPlatforms?: string[]
}>()

const ordersStore = useOrdersStore()
const platformsStore = usePlatformsStore()

// 不单列的平台见 shared/platform-visibility（mock / 闲鱼卖家 / 已停用的 1688）
const HIDDEN = HIDDEN_PLATFORMS

const activeId = ref('')
const loginVisible = ref(false)
/**
 * 平台页面分栏（原版作法：页面就在界面上）。
 * `pageVisible` 是用户选择（记 localStorage）。
 *
 * 抓取不再「临时展开」页面：无论接口翻页还是滚动翻页，全程在后台跑，
 * 用户看不到网页自己动（2026-10-26 用户要求）。想边逛边抓时手动「打开页面」。
 */
const PAGE_PANE_KEY = 'reflow.ui.pagePane'
const pageVisible = ref(localStorage.getItem(PAGE_PANE_KEY) === 'shown')
const pageShown = computed(() => pageVisible.value)

function togglePagePane(): void {
  pageVisible.value = !pageVisible.value
  localStorage.setItem(PAGE_PANE_KEY, pageVisible.value ? 'shown' : 'hidden')
}
const webviewId = ref<number | null>(null)
const paneRef = ref<{
  reload: () => void
  navigate: (url: string) => void
  currentUrl: () => string
} | null>(null)
/** 闲鱼买/卖切换 */
const xianyuSeller = ref(false)

// ---- 工单 031：筛选 / 勾选 / 导出中心 ----
const keyword = ref('')
const timeRange = ref<'all' | '7' | '30' | '90'>('all')
const statusFilter = ref('')
const selectedOrders = ref<Order[]>([])
const tableRef = ref<{ clearSelection: () => void } | null>(null)
const exportVisible = ref(false)
const exportScope = ref<'current' | 'selected'>('current')
const historyVisible = ref(false)
const aboutVisible = ref(false)

/**
 * webview 的 User-Agent：伪装成普通 Chrome，去掉 `Electron/44.x` 与 `回流Reflow/0.1.0`。
 *
 * Electron 默认 UA 里带应用名和 Electron 版本，服务端一眼能认出「不是真浏览器」。
 * 实测美团订单数没变化（38 单是平台上限，见 2026-10-29 排查），但去掉标识更不容易
 * 被风控当成爬虫，属于低成本的通用改进。
 * Chrome 主版本跟运行时 Chromium 对齐，否则比真实浏览器还容易被判异常。
 */
const paneUserAgent = computed(
  () =>
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${(window.navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '152')}.0.0.0 Safari/537.36`
)
const mitmVisible = ref(false)

/** 捕获日志：最近捕获的请求与结果（诊断「为什么没数据」） */
interface RecentCaptureRow {
  url: string
  kind: string
  status: number
  ts: number
  platform: string | null
  outcome: 'ok' | 'error' | 'unmatched'
  detail: string
}
const captureLogVisible = ref(false)
const captureLog = ref<RecentCaptureRow[]>([])

async function refreshCaptureLog(): Promise<void> {
  try {
    captureLog.value = await window.api.getRecentCaptures()
  } catch (e) {
    ElMessage.error(`读取捕获日志失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

interface PlatformRow extends AdapterSummary {
  count: number
  loggedIn: boolean
}

const platforms = computed<PlatformRow[]>(() => {
  const rows = platformsStore.adapters
    .filter((a) => !HIDDEN.has(a.id))
    .filter((a) => {
      // 默认全显示；只有用户手动勾选过才按他的选择来。
      // （不再用引导里的「常用平台」做过滤 —— 那会把 1688/得物/快手 这类挡掉，
      //  而用户明确要的是「默认都在，不需要的自己藏」。）
      if (visibleIds.value) return visibleIds.value.includes(a.id)
      return true
    })
    .map((a) => {
      const login = platformsStore.loginOf(a.id)
      // 闲鱼数量含卖家单（同一平台的两个视角）
      const count =
        a.id === 'xianyu'
          ? (ordersStore.byPlatform.xianyu?.length ?? 0) +
            (ordersStore.byPlatform['xianyu-sold']?.length ?? 0)
          : (ordersStore.byPlatform[a.id]?.length ?? 0)
      return { ...a, count, loggedIn: login.loggedIn }
    })
  return rows
})

/** 可勾选的平台（技术性隐藏的不参与） */
const selectablePlatforms = computed(() => platformsStore.adapters.filter((a) => !HIDDEN.has(a.id)))

// ---- 平台显示设置 ----
const PLATFORM_VISIBLE_KEY = 'reflow.visible-platforms'
const platformsVisible = ref(false)
const platformDraft = ref<string[]>([])

function readVisibleIds(): string[] | null {
  try {
    const raw = localStorage.getItem(PLATFORM_VISIBLE_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') ? (arr as string[]) : null
  } catch {
    return null
  }
}

/** null = 未设置（显示全部） */
const visibleIds = ref<string[] | null>(readVisibleIds())

function setVisibleIds(ids: string[] | null): void {
  visibleIds.value = ids
  if (ids === null) localStorage.removeItem(PLATFORM_VISIBLE_KEY)
  else localStorage.setItem(PLATFORM_VISIBLE_KEY, JSON.stringify(ids))
}

function openPlatformsDialog(): void {
  platformDraft.value = platforms.value.map((p) => p.id)
  platformsVisible.value = true
}

function savePlatforms(): void {
  const all = selectablePlatforms.value.map((p) => p.id)
  const picked = platformDraft.value.filter((id) => all.includes(id))
  // 全选等价于「未设置」，以后新增平台也能自动出现
  setVisibleIds(picked.length === all.length ? null : picked)
  platformsVisible.value = false
  // 当前平台被藏起来时，切到第一个可见的
  if (!platforms.value.some((p) => p.id === activeId.value)) {
    const first = platforms.value[0]
    if (first) selectPlatform(first.id)
  }
}

/** 可见平台的订单合计（下架平台的订单不计入顶部汇总，数据仍在本地） */
const visibleTotal = computed(() => platforms.value.reduce((sum, p) => sum + p.count, 0))

const active = computed(() => platforms.value.find((p) => p.id === activeId.value) ?? null)
const login = computed(() => platformsStore.loginOf(activeId.value))
const capturedCount = computed(() => ordersStore.byPlatform[activeId.value]?.length ?? 0)

/** 侧栏头像：平台名首字（「1688」这类纯数字取前两位） */
function initialOf(name: string): string {
  if (!name) return '·'
  return /^\d/.test(name) ? name.slice(0, 2) : name.slice(0, 1)
}

/**
 * 登录方式由主进程的平台能力表决定：
 * pureQr（淘宝/闲鱼/1688/京东/拼多多）→ 弹窗只显示二维码
 * page（得物/快手/饿了么/美团）→ 打开小窗口登录（这些平台网页端确实没有登录二维码）
 */
const loginCaps = ref<
  Record<string, { pureQr: boolean; source: 'native' | 'dom' | 'page'; loginUrl: string }>
>({})
const loginSource = computed(() => loginCaps.value[activeId.value]?.source ?? 'page')
/** 页面面板内的登录提示（登录入口已从左侧列表移到「打开页面」里） */
const pageLoginTip = computed(() => {
  if (loginSource.value === 'page') return '该平台需在页面中登录'
  if (loginSource.value === 'dom') return '请在右侧页面扫码登录'
  return '也可在页面中直接登录'
})

/**
 * 直接开始登录 —— 不必先手动「打开页面」。
 *
 * 原版魔猫的主窗口本身就是内嵌浏览器（最大化加载平台页面），登录页就是主界面，
 * 压根没有「先打开页面」这一步。我们把页面做成了可收起的侧栏，
 * 于是登录动作要自己负责：展开面板 + 导航到平台登录页。
 */
async function startLoginFlow(): Promise<void> {
  const a = active.value
  if (!a) return
  // 能力表没回来时先等它：否则 `loginSource` 会落到默认值 'page'，
  // 淘宝就被带进「页面里扫码」，和弹窗里的二维码抢同一个分区
  if (!loginCaps.value[a.id]) await loadLoginCaps().catch(() => undefined)
  const src = loginCaps.value[a.id]?.source ?? 'page'

  // 原生二维码平台（淘宝/闲鱼/1688）：直接弹二维码，不加载页面
  if (src === 'native' || src === 'dom') {
    // 先把页面面板收起来：同一个 partition 里页面自己也会生成一张码，
    // 两张码会互相覆盖（京东/拼多多/淘宝都有这个坑），扫码后 PC 端等不到确认
    if (pageVisible.value) {
      pageVisible.value = false
      localStorage.setItem(PAGE_PANE_KEY, 'hidden')
    }
    loginVisible.value = true
    return
  }
  const loginUrl = loginCaps.value[a.id]?.loginUrl || a.homeUrl
  pageVisible.value = true
  localStorage.setItem(PAGE_PANE_KEY, 'shown')
  // webview 可能刚挂载/正在加载，稍等再导航
  window.setTimeout(() => paneRef.value?.navigate(loginUrl), 400)
  ElMessage.info(`已打开${a.displayName}登录页，请扫码登录`)
}

/** 顶部账号标签的下拉菜单：重新登录 / 退出登录 */
async function onAccountMenu(cmd: string): Promise<void> {
  if (cmd === 'relogin') {
    void startLoginFlow()
    return
  }
  if (cmd !== 'logout') return

  const platform = activeId.value
  const name = active.value?.displayName ?? ''
  try {
    await ElMessageBox.confirm(
      `退出 ${name} 会清除本机登录态，需要重新扫码登录。`,
      '退出登录？',
      { confirmButtonText: '退出', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await window.api.logoutPlatform(platform)
  ElMessage.success('已退出登录')
  // 直接带到登录页，方便马上换账号
  void startLoginFlow()
}

/**
 * 滚动/点击翻页型平台 —— 靠页面自身加载逻辑取数（后台隐藏页面里跑，不弹给用户看）。
 * 京东 2026-10 起也在这里：`list.action` 已返回 HTML 壳（SPA），
 * 数据走 `pcorder_center_list`，只能靠页面翻页触发 + 被动捕获。
 */
// 淘宝订单页（buyertrade）没有 mtop SDK（实测 window.Qr === false），
// 主动接口抓取是死路；改走页面自身分页/滚动 + 被动捕获。
const SCROLL_PLATFORMS = new Set(['meituan', 'pdd', 'jd', 'taobao'])
const scrollable = computed(() => SCROLL_PLATFORMS.has(activeId.value))

/**
 * 有代码侧接口翻页能力的平台：闲鱼/淘宝走页面官方 SDK，1688 走 mtop 分页。
 * 这些平台全程后台，页面无需可见。
 */
const FETCH_PLATFORMS = new Set(['xianyu', 'xianyu-sold'])
const fetchable = computed(() => FETCH_PLATFORMS.has(activeId.value))
const scrollRunning = ref(false)
const scrollSteps = ref(0)

/** 当前抓取目标平台（闲鱼按买/卖视角） */
const capturePlatform = computed(() =>
  activeId.value === 'xianyu' ? (xianyuSeller.value ? 'xianyu-sold' : 'xianyu') : activeId.value
)
const fetchInfo = computed(() => ordersStore.fetchStateOf(capturePlatform.value))
const captureRunning = computed(() => fetchInfo.value.running || scrollRunning.value)
const captureText = computed(() => {
  if (fetchInfo.value.running) return fetchInfo.value.message || '正在抓取订单…'
  if (scrollRunning.value) {
    return scrollSteps.value > 0
      ? `后台翻页中 · 已处理 ${scrollSteps.value} 批`
      : '后台翻页中…'
  }
  return ''
})

/** 停止当前抓取（主动抓取与自动翻页都停） */
async function stopCapture(): Promise<void> {
  const p = capturePlatform.value
  if (fetchInfo.value.running) {
    if (p === 'jd' || p === 'taobao' || p === 'xianyu' || p === 'xianyu-sold') {
      await window.api.cancelFetchOrders(p).catch(() => undefined)
    }
  }
  if (scrollRunning.value) {
    await window.api.stopAutoScroll(p).catch(() => undefined)
  }
}

function toggleAutoScroll(): void {
  const platform = activeId.value
  if (webviewId.value === null) return
  if (scrollRunning.value) {
    void window.api.stopAutoScroll(platform)
    return
  }
  scrollSteps.value = 0
  void window.api.startAutoScroll(platform, webviewId.value).then((r) => {
    if (!r.ok) {
      ElMessage.warning(r.message ?? '无法开始后台翻页')
      return
    }
    scrollRunning.value = true
  })
}

// 自动翻页进度
const unsubScroll = window.api.onAutoScrollEvent((payload) => {
  if (payload.platform !== activeId.value) return
  if (payload.phase === 'started') {
    scrollRunning.value = true
    scrollSteps.value = 0
  } else if (payload.phase === 'progress') {
    scrollSteps.value = payload.steps ?? scrollSteps.value
  } else {
    scrollRunning.value = false
    if (payload.error) {
      ElNotification.error({ title: '后台翻页失败', message: payload.error, duration: 0 })
    } else if (payload.cancelled) {
      ElMessage.info('已停止后台翻页')
    } else {
      // 用户要求「全部完成后再明确提醒」：翻完给一条常驻通知，带本平台订单数
      const n = ordersStore.byPlatform[activeId.value]?.length ?? 0
      ElNotification.success({
        title: '订单已全部加载完成',
        message: `${active.value?.displayName ?? ""}：本地共 ${n} 单（已翻到底）`,
        duration: 8000
      })
    }
  }
})
onUnmounted(() => unsubScroll())

/**
 * 兜底：脚本若因页面改版中途哑掉，按钮不能永远停在「停止翻页」。
 * 京东是「8 年 × 每年最多 25 页」，给 5 分钟上限。
 */
let scrollWatchdog: number | null = null
watch(scrollRunning, (on) => {
  if (scrollWatchdog) {
    clearTimeout(scrollWatchdog)
    scrollWatchdog = null
  }
  if (on) {
    scrollWatchdog = window.setTimeout(() => {
      scrollRunning.value = false
      ElMessage.info('后台翻页已结束')
    }, 300_000)
  }
})

/** 当前平台订单（闲鱼按买/卖视角过滤） */
const currentOrders = computed<Order[]>(() => {
  const id = activeId.value
  if (!id) return []
  if (id === 'xianyu') {
    const bought = ordersStore.byPlatform.xianyu ?? []
    const sold = ordersStore.byPlatform['xianyu-sold'] ?? []
    return xianyuSeller.value ? sold : bought
  }
  return ordersStore.byPlatform[id] ?? []
})

// ---------------------------------------------------------------------------
// 工单 031：筛选（搜索 / 时间 / 状态）
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD HH:mm:ss` → 时间戳（解析失败返回 null） */
function timeOf(order: Order): number | null {
  if (!order.createdAt) return null
  const t = Date.parse(order.createdAt.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

const timeCutoff = computed<number | null>(() => {
  if (timeRange.value === 'all') return null
  const days = Number(timeRange.value)
  return Date.now() - days * 24 * 60 * 60 * 1000
})

const filteredOrders = computed<Order[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const cutoff = timeCutoff.value
  const status = statusFilter.value
  if (!kw && cutoff === null && !status) return currentOrders.value

  return currentOrders.value.filter((o) => {
    if (status && o.status !== status) return false
    if (cutoff !== null) {
      const t = timeOf(o)
      // 时间筛选下「无下单时间」的订单无法判断，按不符合处理（避免混进错误区间）
      if (t === null || t < cutoff) return false
    }
    if (!kw) return true
    return (
      o.orderId.toLowerCase().includes(kw) ||
      o.title.toLowerCase().includes(kw) ||
      o.shopName.toLowerCase().includes(kw) ||
      o.receiverName.toLowerCase().includes(kw) ||
      o.trackingNo.toLowerCase().includes(kw) ||
      o.status.toLowerCase().includes(kw)
    )
  })
})

const hasFilter = computed(
  () => Boolean(keyword.value.trim()) || timeRange.value !== 'all' || Boolean(statusFilter.value)
)

/** 状态下拉：只列当前平台真实出现过的状态（带条数） */
const statusOptions = computed(() => {
  const counter = new Map<string, number>()
  for (const o of currentOrders.value) {
    if (!o.status) continue
    counter.set(o.status, (counter.get(o.status) ?? 0) + 1)
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }))
})

const filteredAmount = computed(() => sumOf(filteredOrders.value))

/** 勾选行的实付合计（勾选后可只导这部分，金额心里有数） */
const selectedAmount = computed(() => sumOf(selectedOrders.value))

function sumOf(list: Order[]): string {
  const sum = list.reduce((acc, o) => {
    const n = Number(String(o.paidAmount ?? '').replace(/[^\d.-]/g, ''))
    return acc + (Number.isFinite(n) ? n : 0)
  }, 0)
  return sum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const emptyText = computed(() =>
  currentOrders.value.length
    ? '没有匹配筛选条件的订单 — 试试清空搜索或切回「全部时间」'
    : '暂无订单 — 点左侧登录后，在平台页面中浏览订单即可自动捕获'
)

function resetFilters(): void {
  keyword.value = ''
  timeRange.value = 'all'
  statusFilter.value = ''
}

function onSelectionChange(rows: Order[]): void {
  selectedOrders.value = rows
}

// 换平台 / 改筛选 → 勾选失效（否则会导出「看不见的行」）
watch([activeId, xianyuSeller, keyword, timeRange, statusFilter], () => {
  selectedOrders.value = []
  tableRef.value?.clearSelection()
})

// ---------------------------------------------------------------------------
// 工单 031：导出中心
// ---------------------------------------------------------------------------

function openExport(scope: 'current' | 'selected'): void {
  exportScope.value = scope
  exportVisible.value = true
}

/**
 * 会话分区：单账号模式，每个平台固定一个持久分区。
 * 必须与主进程 `activePartition()` 完全一致（它固定 slot 0），
 * 否则登录写进的分区与 webview 用的分区不同 → 扫码成功也显示未登录。
 */
function partitionOf(a: AdapterSummary): string {
  return a.partition ?? `persist:platform-${a.id}`
}

/** webview 的 key：平台 + 分区（换平台即重建） */
const webviewKey = computed(() => {
  const a = active.value
  if (!a) return 'none'
  return `${a.id}|${partitionOf(a)}`
})

function selectPlatform(id: string): void {
  if (activeId.value === id) return
  activeId.value = id
  webviewId.value = null
}

/** 每个平台独立的「重新加载」状态（后台进行，互不影响） */
const reloading = ref<Record<string, boolean>>({})

/**
 * 一键重新加载某平台订单。
 *
 * 滚动型平台（拼多多/美团/京东）走**独立隐藏窗口**：抓取期间随便切平台都不打断，
 * 这是「美团只抓到 39 单」的根因（原来一切平台，共享 webview 就被销毁重建）。
 *
 * 接口型平台（淘宝/闲鱼）必须借该平台页面里的 SDK 算签名，只能切过去抓；
 * 淘宝是 60 个月 × 每月翻页，耗时较长，期间请留在该平台。
 */
async function reloadPlatform(id: string): Promise<void> {
  if (reloading.value[id]) return
  reloading.value = { ...reloading.value, [id]: true }
  const name = platforms.value.find((p) => p.id === id)?.displayName ?? id
  const before = ordersStore.byPlatform[id]?.length ?? 0
  try {
    // 缓存新鲜度检测：10 分钟内抓过且订单数没变 → 跳过重新请求，避免频繁抓取卡顿
    if (ordersStore.isCacheFresh(id) && before > 0) {
      ElNotification.info({
        title: `${name}：数据已是最新`,
        message: `本地已有 ${before} 单（10 分钟内同步过），跳过重新抓取。如需强制刷新，请稍后再试。`,
        duration: 4000
      })
      return
    }
    // 淘宝：走页面内 lib.mtop 全量抓取（魔猫同款做法），需要页面已打开
    if (id === 'taobao') {
      selectPlatform('taobao')
      // 切平台后 webviewId 会被置 null，要等 onWebviewReady 回填（最多 15 秒）
      for (let i = 0; i < 30 && !webviewId.value; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!webviewId.value) {
        ElNotification.warning({
          title: '需要先打开淘宝页面',
          message: '点右上角「打开页面」，等页面加载完再点这个刷新按钮'
        })
        return
      }
      const r = await window.api.taobaoFetchAll(webviewId.value)
      if (!r.ok) {
        ElNotification.error({ title: '淘宝全量抓取失败', message: r.message ?? '未知错误' })
        return
      }
      await ordersStore.reloadCache()
      ordersStore.markSynced('taobao')
      const after = ordersStore.byPlatform['taobao']?.length ?? 0
      ElNotification.success({
        title: '淘宝订单已全部加载',
        message: `本地共 ${after} 单（${r.totalPage} 页）`,
        duration: 8000
      })
      return
    }

    if (FETCH_PLATFORMS.has(id)) {
      selectPlatform(id)
      await new Promise((r) => setTimeout(r, 1500))
      await startAutoCapture()
      return
    }
    const r = await window.api.bgReloadOrders(id)
    if (!r.ok) {
      ElNotification.error({ title: '重新加载失败', message: `${name}：${r.message ?? '未知错误'}` })
      return
    }
    const after = ordersStore.byPlatform[id]?.length ?? 0
    const gained = after - before
    ordersStore.markSynced(id)
    if (gained > 0) {
      ElNotification.success({
        title: '订单已全部加载完成',
        message: `${name}：新增 ${gained} 单，本地共 ${after} 单`,
        duration: 8000
      })
    } else {
      // 后台跑完却没有新增 —— 不是失败，而是该平台网页端能加载的就这么多。
      // 说清楚原因，别让人以为是程序坏了。
      ElNotification.warning({
        title: `${name}：没有新增订单（共 ${after} 单）`,
        message: '该平台网页版只展示部分订单。如需更多，点「打开页面」往下翻，浏览时订单会自动捕获。',
        duration: 10000
      })
    }
  } catch (err) {
    ElNotification.error({
      title: '重新加载失败',
      message: `${name}：${err instanceof Error ? err.message : String(err)}`
    })
  } finally {
    reloading.value = { ...reloading.value, [id]: false }
  }
}

function onWebviewReady(id: number): void {
  webviewId.value = id
}

/**
 * 原版作法：进平台就自动开抓，不需要用户点任何按钮。
 * 已登录（或有历史订单）时，切到该平台 → 页面就绪 → 自动导航订单页 + 开抓。
 * 每个平台每次运行只自动触发一次，避免来回切换时反复打断。
 */
const autoStarted = new Set<string>()

function maybeAutoCapture(): void {
  const id = activeId.value
  if (!id || webviewId.value === null || autoStarted.has(id)) return
  const logged =
    platformsStore.loginOf(id).loggedIn || (ordersStore.byPlatform[id]?.length ?? 0) > 0
  if (!logged) return
  autoStarted.add(id)
  void startAutoCapture()
}

watch([activeId, webviewId], maybeAutoCapture)

/**
 * 登录成功后的统一收尾（弹窗扫码与页面内扫码都收敛到这里）：
 * 收起登录页面 → 导航订单页 → 后台全量抓取。
 *
 * 只由 `login.loggedIn` 由 false 变 true 触发一次 —— 这样两种登录方式
 * 都不会漏掉，也不会重复抓。京东改成就地扫码后，原来只挂在弹窗
 * success 事件上的抓取就再也不会触发了（登录成功却一条也不抓）。
 */
function onLoggedIn(): void {
  ElMessage.success('登录成功，正在后台抓取订单…')
  // 收起登录页面：抓取在后台跑，用户不用盯着网页
  if (pageVisible.value) {
    pageVisible.value = false
    localStorage.setItem(PAGE_PANE_KEY, 'hidden')
  }
  void startAutoCapture()
}

watch(
  () => login.value.loggedIn,
  (ok, prev) => {
    if (!ok || prev === true) return
    onLoggedIn()
  }
)

/** 弹窗（原生二维码）登录成功：收起页面即可，抓取由上面的 watch 统一触发 */
function onLoginSuccess(): void {
  if (pageVisible.value) {
    pageVisible.value = false
    localStorage.setItem(PAGE_PANE_KEY, 'hidden')
  }
}

// ---------------------------------------------------------------------------
// 登录成功后的自动抓取链路
// ---------------------------------------------------------------------------

/**
 * 各平台「订单列表页」URL：登录成功后 webview 自动导航到这里，
 * 页面自己发出的订单接口响应会被被动捕获管道接住。
 * 有代码侧抓取的平台（闲鱼/京东/淘宝/1688）随后直接调抓取 API，不依赖页面滚动。
 */
const ORDER_PAGE_URLS: Record<string, string> = {
  jd: 'https://order.jd.com/center/list.action',
  taobao: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  pdd: 'https://mobile.yangkeduo.com/order.html?tab=all',
  meituan: 'https://h5.waimai.meituan.com/waimai/mindex/olist'
}

/** 抓取互斥：登录回调和「进入平台自动抓」可能同时进来，重复导航会把请求打断 */
let captureBusy = false

/**
 * 等 webview 真正停在目标页再抓。
 * 登录成功后平台自己会跳几次（passport → 首页 → 订单页），固定 sleep 很容易
 * 在导航中途就发请求 —— 表现就是一堆 ERR_ABORTED + 抓不到数据。
 */
async function waitForUrl(target: string, timeoutMs = 12000): Promise<boolean> {
  const want = target.split('?')[0]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cur = paneRef.value?.currentUrl() ?? ''
    if (cur.startsWith(want)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/** 登录成功 → 导航订单页 → 等页面真正就位 → 启动主动抓取或自动翻页 */
async function startAutoCapture(): Promise<void> {
  const platform = activeId.value
  if (!platform || webviewId.value === null) return
  if (captureBusy) return
  // 未登录时不静默抓空，提示去登录
  // 被动捕获型平台没有 Cookie 登录信号，以「已有订单」反证已登录。
  const logged =
    platformsStore.loginOf(platform).loggedIn || (ordersStore.byPlatform[platform]?.length ?? 0) > 0
  if (!logged) {
    ElMessage.warning(`请先点顶部「登录」登录${active.value?.displayName ?? ''}`)
    return
  }

  captureBusy = true
  try {
    // 闲鱼按买/卖视角决定订单页与抓取目标
    const fetchPlatform =
      platform === 'xianyu' ? (xianyuSeller.value ? 'xianyu-sold' : 'xianyu') : platform
    // 1. 导航到订单页（翻页/滚动都在这个页面上发生）
    const orderUrl =
      platform === 'xianyu'
        ? xianyuSeller.value
          ? 'https://www.goofish.com/sold'
          : 'https://www.goofish.com/bought'
        : ORDER_PAGE_URLS[platform]
    if (orderUrl) {
      paneRef.value?.navigate(orderUrl)
      await waitForUrl(orderUrl)
      // URL 到位不等于渲染完成：SPA 订单页（京东）还要等分页器挂出来
      await new Promise((r) => setTimeout(r, 1500))
    }

    // 2a. 有代码侧接口翻页：直接全量抓（响应复用捕获引擎，最快最稳，页面无需可见）
    if (FETCH_PLATFORMS.has(fetchPlatform)) {
      try {
        // 京东已不在接口抓取之列（订单页 SPA 化），这里只剩淘宝按月分批
        // 淘宝只按「近 12 个月」抓会把历史订单切掉（用户反馈「不可能才几十单」），
        // 放宽到 60 个月（5 年），与京东的覆盖口径对齐；接口本身支持按月翻页，只是慢一些。
        const options = fetchPlatform === 'taobao' ? { months: 60 } : undefined
        const result = await window.api.fetchAllOrders(
          fetchPlatform as 'jd' | 'taobao' | 'xianyu' | 'xianyu-sold',
          webviewId.value,
          options
        )
        if (result.ok) {
          const n = ordersStore.byPlatform[fetchPlatform]?.length ?? 0
          ElNotification.success({
            title: '订单已全部加载完成',
            message: `${active.value?.displayName ?? ""}：本地共 ${n} 单`,
            duration: 8000
          })
        } else if (!result.cancelled && result.message) {
          ElMessage.warning(result.message)
        }
        return
      } catch {
        // 抓取失败不阻断：页面已停在订单页，用户手动浏览仍会触发被动捕获
      }
    }

    // 2b. 滚动加载型平台：后台翻页（在隐藏页面里触发它自己的加载，不弹页面给用户看）
    if (SCROLL_PLATFORMS.has(fetchPlatform) && !scrollRunning.value) {
      scrollSteps.value = 0
      const result = await window.api.startAutoScroll(fetchPlatform, webviewId.value)
      if (result.ok) {
        scrollRunning.value = true
        ElMessage.info('后台翻页中，可随时点「停止翻页」')
      }
    }
  } finally {
    captureBusy = false
  }
}

async function onClear(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空所有平台已捕获的订单，并删除本机缓存文件。此操作不可撤销。',
      '清空全部订单？',
      { confirmButtonText: '清空', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await ordersStore.clear()
  selectedOrders.value = []
  ElMessage.success('已清空')
}

/** 工具菜单（诊断 / 检查更新） */
async function onToolCommand(cmd: string): Promise<void> {
  if (cmd === 'history') {
    historyVisible.value = true
    return
  }
  if (cmd === 'import') {
    const platform = activeId.value
    if (!platform) return
    const name = active.value?.displayName ?? platform
    const r = await window.api.importOrdersFile(platform)
    if (!r.ok) {
      if (r.message !== '已取消') {
        ElNotification.error({ title: '导入失败', message: r.message ?? '未知错误' })
      }
      return
    }
    await ordersStore.reloadCache()
    ElNotification.success({
      title: '导入完成',
      message: `${name}：新增 ${r.imported} 单${r.skipped ? `，跳过 ${r.skipped} 行` : ''}`,
      duration: 8000
    })
    return
  }
  if (cmd === 'mitm') {
    mitmVisible.value = true
    return
  }
  if (cmd === 'platforms') {
    openPlatformsDialog()
    return
  }
  if (cmd === 'capture-log') {
    captureLogVisible.value = true
    void refreshCaptureLog()
    return
  }
  if (cmd === 'diagnostics') {
    await onDiagnostics()
    return
  }
  if (cmd === 'clear') {
    // 原来在侧栏底部，左侧列表不再放任何按钮后收进「工具」菜单
    await onClear()
    return
  }
  if (cmd === 'about') {
    aboutVisible.value = true
    return
  }
}

/** 工单 025：诊断面板 —— 只读快照 + 一键复制（不含 Cookie / 订单内容） */
async function onDiagnostics(): Promise<void> {
  try {
    const base = (await window.api.getDiagnostics()) as Record<string, unknown>
    const snapshot = {
      ...base,
      renderer: {
        inMemory: Object.fromEntries(
          Object.entries(ordersStore.byPlatform).map(([p, list]) => [p, list.length])
        ),
        parseErrors: ordersStore.parseErrors.slice(0, 10).map((e) => ({
          platformId: e.platformId,
          message: e.message
        })),
        scroll: { platform: activeId.value, running: scrollRunning.value, steps: scrollSteps.value },
        filter: { keyword: keyword.value, timeRange: timeRange.value, status: statusFilter.value }
      }
    }
    const text = JSON.stringify(snapshot, null, 2)
    await ElMessageBox.alert(
      `<pre style="max-height:52vh;overflow:auto;font-size:12px;line-height:1.5;text-align:left;white-space:pre-wrap">${escapeHtml(
        text
      )}</pre>`,
      '诊断信息（可全选复制）',
      { dangerouslyUseHTMLString: true, customClass: 'diag-box' }
    )
  } catch (e) {
    ElMessage.error(`读取诊断信息失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
}

watch(
  () => platforms.value.length,
  (n) => {
    if (n && !activeId.value) activeId.value = platforms.value[0].id
  },
  { immediate: true }
)

/**
 * 拉取各平台的登录方式（主进程的能力表）。
 *
 * 必须能 await：`startLoginFlow` 在能力表为空时**不能猜**，默认值 'page' 会把淘宝
 * 带进「在页面里扫码」，与弹窗里的原生二维码共用同一分区 → 两张码互相覆盖，
 * 用户扫码后 PC 端毫无反应（2026-10-26 实测故障）。
 */
async function loadLoginCaps(): Promise<void> {
  const list = await window.api.getLoginCapabilities()
  const map: Record<
    string,
    { pureQr: boolean; source: 'native' | 'dom' | 'page'; loginUrl: string }
  > = {}
  for (const item of list) {
    map[item.platformId] = {
      pureQr: item.pureQr,
      source: item.source,
      loginUrl: item.loginUrl
    }
  }
  loginCaps.value = map
}

onMounted(() => {
  ordersStore.init()
  platformsStore.init()
  void loadLoginCaps()
})
</script>

<style scoped>
/* 首屏加载遮罩：盖住整个窗口，读完缓存才撤 */
.boot-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--el-bg-color, #fff);
}
.boot-text {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--el-text-color-primary, #303133);
}
.boot-sub {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.shell-header {
  padding: 0;
  border-bottom: 1px solid var(--el-border-color-light);
  flex: none;
}

.titlebar {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
}

.brand {
  font-weight: 600;
  font-size: 14px;
}

.brand-sub {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  padding-left: 8px;
  border-left: 1px solid var(--el-border-color-lighter);
}

.spacer {
  flex: 1;
}

.summary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.shell-body {
  flex: 1;
  min-height: 0;
}

.shell-footer {
  flex: none;
  padding: 0;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.sidebar {
  flex: none;
  border-right: 1px solid var(--el-border-color-light);
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  overflow: hidden;
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.sidebar-total {
  color: var(--el-text-color-placeholder);
}

.platform-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px;
}

.platform-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  margin-bottom: 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--el-text-color-primary);
  transition: background 0.15s;
}

.platform-item:hover {
  background: var(--el-fill-color-light);
}

.platform-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

/* 平台首字头像：没有 Logo 素材时也比纯文字列表更容易扫读 */
.platform-avatar {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--el-color-primary);
}

.platform-item.active .platform-avatar {
  background: var(--el-color-primary);
}

.platform-avatar.is-off {
  background: var(--el-color-info-light-3);
  color: var(--el-text-color-secondary);
}

.platform-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.platform-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

/* 每个平台独立的「重新加载」小按钮：后台跑，不影响其它平台 */
.platform-reload {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  transition: color 0.15s;
}

.platform-reload:hover {
  color: var(--el-color-primary);
}

.platform-reload.spinning {
  color: var(--el-color-primary);
  animation: reflow-spin 1s linear infinite;
}

@keyframes reflow-spin {
  to {
    transform: rotate(360deg);
  }
}

.platform-meta.has-orders {
  color: var(--el-text-color-secondary);
}

.platform-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.platform-dot.is-on {
  background: var(--el-color-success);
}

.platform-dot.is-off {
  background: var(--el-border-color);
}

.content {
  flex: 1;
  min-width: 0;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.content-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex: none;
}

.content-title {
  font-weight: 600;
  font-size: 14px;
}

/* 已登录账号标签可点开：重新登录 / 退出登录 */
.account-tag {
  cursor: pointer;
}

.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin-bottom: 10px;
  flex: none;
}

.filter-search {
  width: 240px;
  flex: 0 1 240px;
  min-width: 150px;
}

.filter-time {
  width: 104px;
  flex: none;
}

.filter-status {
  width: 150px;
  flex: none;
}

.stat {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.stat b {
  color: var(--el-text-color-primary);
}

.stat-selected {
  color: var(--el-color-primary);
}

/*
 * 平台页面：停靠在右侧（原版作法）。
 * 收起后移到窗口外，但**保持正常视口尺寸**（不是 1px）：
 * 1px 会让页面懒加载 / IntersectionObserver 失效，后台翻页就抓不到东西。
 */
.page-pane {
  flex: 0 0 38%;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--el-border-color-light);
  background: #fff;
}

.page-pane.collapsed {
  position: fixed;
  top: 0;
  left: -20000px;
  width: 1280px;
  height: 900px;
  flex: none;
  min-width: 0;
  pointer-events: none;
  border: none;
  overflow: hidden;
}

.page-pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  flex: none;
  color: var(--el-text-color-secondary);
}

.page-pane-title {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.page-login-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 平台显示设置 */
.plat-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.plat-group {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 12px;
}

.plat-item {
  margin-right: 0;
}

.plat-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

/* 捕获日志面板 */
.cap-log-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.cap-log-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cap-log-url {
  font-size: 11px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.page-pane :deep(.pane-webview) {
  flex: 1;
  min-height: 0;
}

/* 抓取进度条 */
.capture-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -2px 0 8px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  flex: none;
}

.capture-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capture-spin {
  animation: capture-spin 1.2s linear infinite;
}

@keyframes capture-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
