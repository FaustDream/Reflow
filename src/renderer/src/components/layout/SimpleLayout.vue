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
          <!--
            总览入口固定在列表最上方：它统计的是**全部平台**的数据，
            所以不参与下面的「显示哪些平台」过滤，也不随平台切换消失。
          -->
          <div
            class="platform-item overview-item"
            :class="{ active: isOverview }"
            role="button"
            tabindex="0"
            @click="selectPlatform(OVERVIEW_ID)"
            @keydown.enter="selectPlatform(OVERVIEW_ID)"
          >
            <el-icon class="overview-icon"><DataAnalysis /></el-icon>
            <span class="platform-name">数据总览</span>
            <span class="platform-meta has-orders">{{ visibleTotal }} 单</span>
          </div>
          <!-- 仪表盘视图 2/3：趋势分析（时间维度）与平台对比（平台维度），与总览同源不同视角 -->
          <div
            class="platform-item overview-item"
            :class="{ active: isTrends }"
            role="button"
            tabindex="0"
            @click="selectPlatform(TRENDS_ID)"
            @keydown.enter="selectPlatform(TRENDS_ID)"
          >
            <el-icon class="overview-icon"><TrendCharts /></el-icon>
            <span class="platform-name">趋势分析</span>
          </div>
          <div
            class="platform-item overview-item"
            :class="{ active: isCompare }"
            role="button"
            tabindex="0"
            @click="selectPlatform(COMPARE_ID)"
            @keydown.enter="selectPlatform(COMPARE_ID)"
          >
            <el-icon class="overview-icon"><PieChart /></el-icon>
            <span class="platform-name">平台对比</span>
          </div>
          <div class="list-divider" />

          <!-- 用 div 而非 button：里面还要放一个「重新加载」小按钮，button 不能嵌套 -->
          <template v-for="p in platforms" :key="p.id">
            <div
              class="platform-item"
              :class="{
                active: activeId === p.id,
                dragging: draggingId === p.id,
                'drag-over': dragOverId === p.id && draggingId !== p.id
              }"
              role="button"
              tabindex="0"
              draggable="true"
              @click="selectPlatform(p.id)"
              @keydown.enter="selectPlatform(p.id)"
              @dragstart="onDragStart(p.id, $event)"
              @dragover="onDragOver(p.id, $event)"
              @dragleave="onDragLeave(p.id)"
              @drop="onDrop(p.id, $event)"
              @dragend="cleanupDrag"
            >
              <span class="platform-avatar" :class="{ 'is-off': !p.loggedIn }">
                {{ initialOf(p.displayName) }}
              </span>
              <span class="platform-name">{{ p.displayName }}</span>
              <span class="platform-meta" :class="{ 'has-orders': p.count > 0 }">
                {{ p.count > 0 ? `${p.count} 单` : '—' }}
              </span>
              <!-- 外卖栏是纯视图（数据随母平台抓取自动归类）：不提供刷新/抓取动作 -->
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
          </template>

          <!-- 运行日志：系统级日志（抓取/登录/导出/缓存），出问题先看这里 -->
          <div class="list-divider" />
          <div
            class="platform-item overview-item"
            :class="{ active: isLogs }"
            role="button"
            tabindex="0"
            @click="selectPlatform(LOGS_ID)"
            @keydown.enter="selectPlatform(LOGS_ID)"
          >
            <el-icon class="overview-icon"><Logs /></el-icon>
            <span class="platform-name">运行日志</span>
          </div>
        </div>
      </el-aside>

      <!-- 右侧：当前平台的一张表 + 筛选条 -->
      <el-main class="content">
        <!-- 总览页：跨平台聚合的年 / 月 / 日图表，不参与单平台表格的筛选与导出 -->
        <OverviewPane v-if="isOverview" :platform-ids="visiblePlatformIds" />
        <TrendsPane v-else-if="isTrends" :platform-ids="visiblePlatformIds" />
        <ComparePane v-else-if="isCompare" :platform-ids="visiblePlatformIds" />
        <LogPane v-else-if="isLogs" />
        <template v-else>
        <div class="content-head">
          <span class="content-title">{{ active?.displayName ?? '—' }}</span>
          <!--
            网购 / 外卖 分栏（淘宝、京东）：
            外卖单本来就在同一份订单里，只是业务线不同 —— 放在平台页内当标签页，
            不再从侧栏拆一条伪平台（`taobao-local` / `jd-local`）出来。
          -->
          <el-radio-group v-if="hasBizTabs" v-model="bizTab" size="small" class="biz-tabs">
            <el-radio-button value="shopping">网购 {{ bizCounts.shopping }}</el-radio-button>
            <el-radio-button value="local">外卖 {{ bizCounts.local }}</el-radio-button>
          </el-radio-group>
          <!--
            登录态 + 登录入口：一律二维码弹窗（2026-11-01 起「打开页面」整体下线）。
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
          <!--
            不再用「已捕获订单」盖住登录状态（2026-11-02）：本地有缓存 ≠ 已登录，
            之前头顶写着「已捕获订单」，用户以为登录没问题，反复点抓取反复失败。
          -->
          <el-tag v-else size="small" type="info" effect="plain">
            {{ capturedCount > 0 ? '未登录 · 显示本地缓存' : '未登录' }}
          </el-tag>
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

          <!--
            筛选结果概览 + 动作区。
            2026-11-02：统计与导出从筛选行挪到标题行 —— 筛选行只放控件，宽度可预期、
            不会因为「有没有退款」「有没有勾选」而抖动；统计右对齐后也不会被下拉挤走。
          -->
          <span class="head-stat">
            <template v-if="hasFilter">{{ filteredOrders.length }} / {{ currentOrders.length }} 单</template>
            <template v-else>{{ currentOrders.length }} 单</template>
            · 已完成 <b>¥{{ stateMoney.paid }}</b>
            <template v-if="stateMoney.refunded > 0">
              · 退款 <b class="stat-refund">¥{{ stateMoney.refunded }}</b>
              · 净 <b>¥{{ stateMoney.net }}</b>
            </template>
          </span>
          <!-- 激活筛选的可视化：光看下拉里的字，很难发现「其实还筛着某个条件」 -->
          <span v-if="activeFilterCount" class="filter-chip">已筛选 {{ activeFilterCount }} 项</span>
          <el-button
            v-if="fetchable"
            size="small"
            :disabled="captureRunning"
            title="后台抓取最新订单，不影响当前浏览；已抓到的订单会保留"
            @click="startAutoCapture"
          >
            {{ captureRunning ? '抓取中…' : '抓取订单' }}
          </el-button>
          <!-- 勾选相关的信息与动作放在表格上方的工具条里（贴着来源），这里只留整平台导出 -->
          <el-button
            size="small"
            text
            title="调整表格列顺序（所有平台统一生效）"
            @click="columnSettingsVisible = true"
          >
            <el-icon><ColumnOrder /></el-icon>
            <span class="col-order-text">列顺序</span>
          </el-button>
          <el-button
            size="small"
            :type="selectedOrders.length ? 'default' : 'primary'"
            :disabled="!filteredOrders.length"
            @click="openExport('current')"
          >
            导出{{ hasBizTabs ? (bizTab === 'local' ? '外卖' : '网购') : '本平台' }}（{{ filteredOrders.length }}）
          </el-button>
        </div>

        <!--
          抓取进度条：接口抓取的实时感知 —— 已抓页数 / 订单数 / 结构化位置
          （京东是「第 2/9 年 · 2024 年 第 3 页」这种）。总页数平台不给，
          所以条子用流动条纹表达「进行中」，数字表达「进展」。
        -->
        <div v-if="captureRunning" class="capture-bar">
          <div class="capture-bar-row">
            <el-icon class="capture-spin"><Loading /></el-icon>
            <span class="capture-title">{{ active?.displayName ?? '' }} 抓取中</span>
            <span v-if="capturePages || captureOrders" class="capture-count">
              已抓 <b>{{ capturePages || 0 }}</b> 页 · <b>{{ captureOrders || 0 }}</b> 单
            </span>
            <span class="capture-text">{{ captureText }}</span>
            <el-button link size="small" class="capture-stop" @click="stopCapture">停止</el-button>
          </div>
          <el-progress
            class="capture-progress"
            :percentage="100"
            :indeterminate="true"
            :duration="2"
            :show-text="false"
            :stroke-width="3"
          />
        </div>

        <!--
          筛选条（2026-11-02 重排）：只放筛选控件，且每个控件都有确定宽度。
          之前「年份 / 结果」两个下拉没设宽度，被 flex 拉成整行，整条筛选区被撑成
          4 行 114px；统计与导出已移到标题行，这里不再有 spacer 和按钮抢宽度。
        -->
        <div class="filter-bar">
          <el-input
            ref="searchRef"
            v-model="keywordInput"
            placeholder="搜索订单/商品/店铺/收货人"
            clearable
            class="filter-search"
            @keydown.esc="onSearchEsc"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-select
            v-model="timeRange"
            class="filter-time"
            :class="{ 'is-filtered': timeRange !== 'all' }"
          >
            <el-option label="全部时间" value="all" />
            <el-option label="近 7 天" value="7" />
            <el-option label="近 30 天" value="30" />
            <el-option label="近 90 天" value="90" />
          </el-select>
          <el-select
            v-model="yearFilter"
            class="filter-year"
            :class="{ 'is-filtered': !!yearFilter }"
            placeholder="全部年份"
          >
            <el-option label="全部年份" value="" />
            <el-option v-for="y in yearOptions" :key="y" :label="`${y} 年`" :value="String(y)" />
          </el-select>
          <!--
            「订单类型」（归一大类）与「平台状态」（平台原文）语义不同但容易混淆：
            两个下拉都用「全部」起始，类型只写大类名，原文只写状态名。
          -->
          <el-select
            v-model="stateClassFilter"
            class="filter-state"
            :class="{ 'is-filtered': !!stateClassFilter }"
            placeholder="订单类型"
          >
            <el-option label="全部类型" value="" />
            <el-option label="交易成功" value="success" />
            <el-option label="进行中（含退款中）" value="pending" />
            <el-option label="已退款" value="refunded" />
            <el-option label="已关闭/取消" value="closed" />
          </el-select>
          <el-select
            v-model="statusFilter"
            class="filter-status"
            :class="{ 'is-filtered': !!statusFilter }"
            placeholder="平台状态"
          >
            <el-option label="全部状态" value="" />
            <el-option
              v-for="s in statusOptions"
              :key="s.value"
              :label="`${s.value}（${s.count}）`"
              :value="s.value"
            />
          </el-select>
          <!-- 重置常驻右侧：只在有筛选时可用，位置固定不跳 -->
          <el-button class="filter-reset" link :disabled="!hasFilter" @click="resetFilters">
            重置
          </el-button>
        </div>

        <!--
          勾选工具条：贴着表格出现，让「勾了哪几行 → 导出勾选」的因果关系一眼可见
          （导出按钮已移到标题行，离表格远，需要这条就近确认）。
        -->
        <div v-if="selectedOrders.length" class="selection-bar">
          <span class="selection-text">
            已选 <b>{{ selectedOrders.length }}</b> 单 · 实付 ¥{{ selectedAmount }}
          </span>
          <el-button link size="small" @click="clearSelection">清空选择</el-button>
          <div class="spacer" />
          <el-button size="small" type="primary" @click="openExport('selected')">
            导出勾选（{{ selectedOrders.length }}）
          </el-button>
        </div>

        <OrderTable
          ref="tableRef"
          :orders="tableRows"
          :loading="false"
          :selectable="true"
          :empty-text="emptyText"
          @selection-change="onSelectionChange"
        >
          <template #empty-extra>
            <el-button v-if="hasFilter" size="small" @click="resetFilters">清空筛选</el-button>
            <!-- 外卖页签空的时候，把「去抓取」放在眼前：多数人不知道外卖要跟着抓一次 -->
            <el-button
              v-else-if="hasBizTabs && bizTab === 'local' && fetchable"
              size="small"
              type="primary"
              :disabled="captureRunning"
              @click="startAutoCapture"
            >
              {{ captureRunning ? '抓取中…' : '抓取订单' }}
            </el-button>
          </template>
        </OrderTable>
        <!-- 分块提示：表格只画前 N 行保证切换流畅；导出/合计/统计始终按全量 -->
        <div v-if="tableTruncated" class="table-more">
          <span class="table-more-hint">
            已显示前 {{ tableRows.length }} 单，共 {{ filteredOrders.length }} 单（导出与合计仍按全部）
          </span>
          <el-button size="small" @click="showMoreRows(false)">再显示 100 单</el-button>
          <el-button size="small" text @click="showMoreRows(true)">显示全部</el-button>
        </div>
        </template>
      </el-main>
    </el-container>

    <!--
      状态栏（注入桥 / 适配器数 / 版本 / 水印）2026-10-29 按用户要求整条隐藏。
      组件文件保留：改回来只要把 <el-footer> 这段放回来。
      署名没有丢 —— 工具 → 关于 里仍有作者与项目主页，导出的 Excel 属性也带 creator。
    -->

    <LoginDialog
      v-if="active"
      :key="activeId"
      v-model="loginVisible"
      :platform-id="active.id"
      :platform-name="active.displayName"
      @success="onLoginSuccess"
    />

    <!-- 工单 031：导出中心（范围 / 格式 / 列 / 含图 / 汇总） -->
    <ExportDialog
      v-model="exportVisible"
      :active-platform-name="active?.displayName ?? ''"
      :current-orders="filteredOrders"
      :selected-orders="selectedOrders"
      :default-scope="exportScope"
    />

    <!-- 工单 043：列顺序（拖拽 / 上下按钮，全局一套，持久化在 localStorage） -->
    <ColumnSettingsDialog v-model="columnSettingsVisible" />

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
          empty-text="还没有捕获记录 — 登录后点「抓取订单」，或开启 MITM 通道"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ColumnOrder, DataAnalysis, Loading, Logs, Refresh, Search } from '../icons'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import LoginDialog from '../platform/LoginDialog.vue'
import OrderTable from '../platform/OrderTable.vue'
import ColumnSettingsDialog from '../platform/ColumnSettingsDialog.vue'
import LogPane from '../log/LogPane.vue'
import OverviewPane from '../overview/OverviewPane.vue'
import TrendsPane from '../overview/TrendsPane.vue'
import ComparePane from '../overview/ComparePane.vue'
import ExportDialog from '../export/ExportDialog.vue'
import ExportHistoryDialog from '../export/ExportHistoryDialog.vue'
import AboutDialog from './AboutDialog.vue'
import MitmSettingsDialog from '../settings/MitmSettingsDialog.vue'
import { useOrdersStore } from '@renderer/stores/orders'
import { usePlatformsStore } from '@renderer/stores/platforms'
import type { AdapterSummary, FetchPlatform, Order } from '@shared/types'
import { HIDDEN_PLATFORMS } from '@shared/platform-visibility'
import { bizLineOf, orderStateOf, orderStateClassOf, stateMoneyOf, type OrderStateClass } from '@renderer/utils/order-stats'

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
/**
 * 总览页的伪平台 id。
 * 用 `__` 包裹的假 id 是为了让它**绝不**命中任何真实适配器：
 * 登录、抓取、导出都按 `activeId` 找平台，撞名会直接抓错平台的数据。
 */
const OVERVIEW_ID = '__overview__'
/**
 * 运行日志页的伪 id（2026-11-02）。和 OVERVIEW_ID 一样用 `__` 包裹，
 * 绝不会命中真实适配器 —— 否则登录/抓取会按这个 id 去找平台。
 */
const LOGS_ID = '__logs__'
/**
 * 趋势分析 / 平台对比页的伪 id（2026-11-08）。同样 `__` 包裹不命中真实适配器。
 */
const TRENDS_ID = '__trends__'
const COMPARE_ID = '__compare__'
const isOverview = computed(() => activeId.value === OVERVIEW_ID)
const isLogs = computed(() => activeId.value === LOGS_ID)
const isTrends = computed(() => activeId.value === TRENDS_ID)
const isCompare = computed(() => activeId.value === COMPARE_ID)

/**
 * 平台页内的「网购 / 外卖」分栏（2026-11-02）。
 *
 * 外卖单本来就在淘宝/京东的同一份订单里，只是业务线不同 —— 之前拆成
 * `taobao-local` / `jd-local` 两个伪平台放到侧栏，既多两行（还经常 0 单），
 * 又和真实的平台登录/抓取语义打架。现在收回平台页内当标签页。
 */
type BizTab = 'shopping' | 'local'
const bizTab = ref<BizTab>('shopping')
/** 只有这两个平台的订单里会混着外卖/本地生活单 */
const BIZ_TAB_PLATFORMS = new Set(['taobao', 'jd'])
const hasBizTabs = computed(() => BIZ_TAB_PLATFORMS.has(activeId.value))
/** 当前平台两条业务线各自的单量（标签页上直接显示） */
const bizCounts = computed(() => {
  const list = ordersStore.byPlatform[activeId.value] ?? []
  let local = 0
  for (const o of list) if (bizLineOf(o) === 'local') local += 1
  return { shopping: list.length - local, local }
})

const loginVisible = ref(false)
/** 列顺序面板（工单 043）：全局一套顺序，与当前平台无关 */
const columnSettingsVisible = ref(false)

/**
 * 用户动作写进系统日志（与主进程日志同一条时间线）。
 * 失败不提示：日志本身不该打断操作。
 */
function uiLog(scope: string, message: string, detail?: unknown, level: 'info' | 'warn' | 'error' = 'info'): void {
  void window.api.logs.write(level, scope, message, detail).catch(() => undefined)
}

// ---- 工单 031：筛选 / 勾选 / 导出中心 ----
// 搜索防抖：输入框即时回显，过滤延迟 250ms —— 大表上每次击键全量过滤非常卡
const keywordInput = ref('')
const keyword = ref('')
let keywordTimer: number | undefined
watch(keywordInput, (v) => {
  clearTimeout(keywordTimer)
  keywordTimer = window.setTimeout(() => {
    keyword.value = v
  }, 250)
})
const timeRange = ref<'all' | '7' | '30' | '90'>('all')
const yearFilter = ref('')
const stateClassFilter = ref<'' | OrderStateClass>('')
const statusFilter = ref('')
const selectedOrders = ref<Order[]>([])
const tableRef = ref<{ clearSelection: () => void } | null>(null)
/** 搜索框（Ctrl/⌘+F、`/` 聚焦，Esc 清空搜索） */
const searchRef = ref<{ focus: () => void } | null>(null)
const exportVisible = ref(false)
const exportScope = ref<'current' | 'selected'>('current')
const historyVisible = ref(false)
const aboutVisible = ref(false)
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

function rawCountOf(platformId: string): number {
  return ordersStore.byPlatform[platformId]?.length ?? 0
}

/** 侧栏平台行：计数=该平台全部订单（外卖只是页内分栏，不再从计数里扣走） */
const shoppingRows = computed<PlatformRow[]>(() => {
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
      return { ...a, count: rawCountOf(a.id), loggedIn: login.loggedIn }
    })
  // 用户拖拽的顺序（2026-11-01）：没排过的平台按注册顺序排在后面（sort 稳定）
  const idx = new Map(platformOrder.value.map((id, i) => [id, i]))
  return [...rows].sort(
    (a, b) => (idx.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (idx.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  )
})

// ---- 平台列表拖拽排序（HTML5 原生拖拽，不引依赖） ----
const PLATFORM_ORDER_KEY = 'reflow.platform-order'

function readPlatformOrder(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PLATFORM_ORDER_KEY) ?? '[]') as unknown
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') ? (arr as string[]) : []
  } catch {
    return []
  }
}

const platformOrder = ref<string[]>(readPlatformOrder())

function persistPlatformOrder(): void {
  localStorage.setItem(PLATFORM_ORDER_KEY, JSON.stringify(platformOrder.value))
}

/** 正在拖拽的平台 / 悬停目标（给模板做高亮） */
const draggingId = ref('')
const dragOverId = ref('')

function onDragStart(id: string, event: DragEvent): void {
  draggingId.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(id: string, event: DragEvent): void {
  if (!draggingId.value || draggingId.value === id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverId.value = id
}

function onDragLeave(id: string): void {
  if (dragOverId.value === id) dragOverId.value = ''
}

function onDrop(id: string, event: DragEvent): void {
  event.preventDefault()
  const from = draggingId.value
  cleanupDrag()
  if (!from || from === id) return
  const ids = platforms.value.map((p) => p.id)
  const fromAt = ids.indexOf(from)
  if (fromAt < 0 || !ids.includes(id)) return
  ids.splice(fromAt, 1)
  ids.splice(ids.indexOf(id), 0, from)
  platformOrder.value = ids
  persistPlatformOrder()
}

function cleanupDrag(): void {
  draggingId.value = ''
  dragOverId.value = ''
}

/** 侧栏里的平台（外卖不再是独立行，见 bizTab） */
const platforms = computed<PlatformRow[]>(() => shoppingRows.value)

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

/** 总览页只统计这些平台（与侧栏一致，下架平台的历史缓存不参与） */
const visiblePlatformIds = computed(() => platforms.value.map((p) => p.id))

const active = computed(() => platforms.value.find((p) => p.id === activeId.value) ?? null)
const login = computed(() => platformsStore.loginOf(activeId.value))
const capturedCount = computed(() => currentOrders.value.length)

/** 侧栏头像：平台名首字（「1688」这类纯数字取前两位） */
function initialOf(name: string): string {
  if (!name) return '·'
  return /^\d/.test(name) ? name.slice(0, 2) : name.slice(0, 1)
}

/**
 * 抓取错误分三类（2026-11-02 用户反馈「各平台不停弹登录失效」后重定）：
 *
 * 1. 真·会话失效（SESSION_EXPIRED / 明确要求扫码）→ 引导登录，但**每个平台每次运行只弹一次**
 * 2. 风控 / 人机验证 → 只提示，弹窗引导去扫码没用
 * 3. 其它（令牌引导失败、网络、接口结构变化）→ 通知里原样给出原因，别一律说成「登录失效」
 *
 * 之前所有带「登录」字样的错误都弹模态框，一次抓取失败就一个框，
 * 平台挨个点过去就是「不停弹」——用户看到的还都是同一句「登录已失效」。
 */
const SESSION_EXPIRED_RE = /SESSION_EXPIRED|登录态已失效|未登录|请先扫码|请先登录|重新扫码/i
const RISK_CONTROL_RE = /滑块|人机验证|USER_VALIDATE|RGV587|风控|被挤爆/i
/** 已经弹过「去登录」的平台：同一平台不再反复弹 */
const reloginPrompted = new Set<string>()
/** 已经提示过「仍未登录」的平台：同一次运行只说一次，别变着法儿打扰 */
const reloginNotified = new Set<string>()

/** 抓取遇到登录失效：别只甩一句错误文案，直接引导去扫码（同平台只弹一次） */
async function offerRelogin(platformId: string, name: string, message: string): Promise<void> {
  if (reloginPrompted.has(platformId)) {
    if (!reloginNotified.has(platformId)) {
      reloginNotified.add(platformId)
      ElNotification.warning({
        title: `${name} 仍未登录`,
        message: '点标题行的「登录」重新扫码；扫码成功后点「抓取订单」即可。',
        duration: 6000,
        // 提示的内容就是「点右上角按钮」，别把按钮本身盖住
        position: 'bottom-right'
      })
    }
    return
  }
  reloginPrompted.add(platformId)
  try {
    await ElMessageBox.confirm(message, `${name} 登录已失效`, {
      confirmButtonText: '去扫码登录',
      cancelButtonText: '稍后',
      type: 'warning'
    })
  } catch {
    return
  }
  if (activeId.value !== platformId) selectPlatform(platformId)
  startLoginFlow()
}

/** 抓取失败时的统一出口：按错误类型决定是引导登录、提示风控，还是原样报错 */
function handleFetchFailure(platformId: string, message: string): void {
  const name = platforms.value.find((pl) => pl.id === platformId)?.displayName ?? platformId
  if (RISK_CONTROL_RE.test(message)) {
    ElNotification.warning({
      title: `${name} 触发平台风控`,
      message: `${message}\n稍等几分钟再抓；多次触发时先在浏览器里正常浏览下单页再回来。`,
      duration: 10000,
      position: 'bottom-right'
    })
    return
  }
  if (SESSION_EXPIRED_RE.test(message)) {
    // 界面标记要跟着诚实：否则头顶还写着「已登录」，用户会反复点抓取
    platformsStore.markLoggedOut(platformId)
    void offerRelogin(platformId, name, message)
    return
  }
  ElNotification.error({
    title: `${name} 抓取失败`,
    message,
    duration: 8000,
    position: 'bottom-right'
  })
}

/**
 * 登录入口（唯一）：二维码弹窗。
 * 2026-11-01 起「打开页面」整体下线 —— 所有平台的登录都从弹窗扫码，
 * 弹窗内部自己处理原生二维码（淘宝/闲鱼）与页面提取二维码（京东/拼多多）两种来源。
 */
function startLoginFlow(): void {
  if (!active.value) return
  uiLog('ui', '打开登录弹窗', { platform: activeId.value })
  loginVisible.value = true
}

/** 顶部账号标签的下拉菜单：重新登录 / 退出登录 */
async function onAccountMenu(cmd: string): Promise<void> {
  if (cmd === 'relogin') {
    startLoginFlow()
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
 * 工单 040：拼多多/淘宝/京东为**接口直连**（主进程直接调订单 API）；
 * 工单 041：闲鱼走隐藏宿主页面 SDK。抓取全程后台，不再有「打开页面」。
 */
const API_FETCH_PLATFORMS = new Set(['taobao', 'pdd', 'jd'])
/** 页面 SDK 型（闲鱼）：抓取仍借页面里的官方 mtop SDK 算签名 */
const FETCH_PLATFORMS = new Set(['xianyu'])
const fetchable = computed(() => FETCH_PLATFORMS.has(activeId.value) || API_FETCH_PLATFORMS.has(activeId.value))

const capturePlatform = computed(() => activeId.value)
const fetchInfo = computed(() => ordersStore.fetchStateOf(capturePlatform.value))
const captureRunning = computed(() => fetchInfo.value.running)
/** 进度条上的累计计数（已抓页数 / 订单数） */
const capturePages = computed(() => fetchInfo.value.pages ?? 0)
const captureOrders = computed(() => fetchInfo.value.orders ?? 0)
const captureText = computed(() => {
  if (fetchInfo.value.running) {
    // 结构化位置优先（京东的「第 2/9 年 · 今年 第 3 页」最直观），message 兜底
    return fetchInfo.value.detail || fetchInfo.value.message || '正在抓取订单…'
  }
  return ''
})

async function stopCapture(): Promise<void> {
  const p = capturePlatform.value
  if (p === 'jd' || p === 'taobao' || p === 'pdd' || p === 'xianyu') {
    await window.api.cancelFetchOrders(p).catch(() => undefined)
  }
}

/** 当前平台订单：淘宝/京东按页内「网购 / 外卖」标签页切，其它平台给全量 */
const currentOrders = computed<Order[]>(() => {
  const id = activeId.value
  if (!id) return []
  const list = ordersStore.byPlatform[id] ?? []
  if (!BIZ_TAB_PLATFORMS.has(id)) return list
  const wantLocal = bizTab.value === 'local'
  return list.filter((o) => (bizLineOf(o) === 'local') === wantLocal)
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
  const t0 = performance.now()
  const kw = keyword.value.trim().toLowerCase()
  const cutoff = timeCutoff.value
  const status = statusFilter.value
  const year = yearFilter.value
  const stateClass = stateClassFilter.value
  let out: Order[]
  if (!kw && cutoff === null && !status && !year && !stateClass) {
    out = currentOrders.value
  } else {
    out = currentOrders.value.filter((o) => {
      if (status && o.status !== status) return false
      // 状态大类（归一状态机）：退款单/关闭单/进行中从「已完成」口径里分出来
      if (stateClass && orderStateClassOf(orderStateOf(o)) !== stateClass) return false
      // 年份筛选（createdAt 前缀匹配，避免每次 Date.parse）
      if (year && !(o.createdAt ?? '').startsWith(year)) return false
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
  }
  // 切换计时：这一段是「数据重算」耗时（渲染耗时由 selectPlatform 的 rAF 差值给出）
  filterEvalMs = performance.now() - t0
  return out
})

/** 年份下拉：当前平台订单里真实出现过的年份（倒序） */
const yearOptions = computed<number[]>(() => {
  const years = new Set<number>()
  for (const o of currentOrders.value) {
    const y = Number((o.createdAt || '').slice(0, 4))
    if (y >= 2000 && y <= 2100) years.add(y)
  }
  return [...years].sort((a, b) => b - a)
})

/** 金额分口径（2026-11-08 收紧）：已完成（仅交易成功）/ 退款（含退款中）/ 净额 —— 进行中与退款不再混进总计 */
const stateMoney = computed(() => stateMoneyOf(filteredOrders.value))

const hasFilter = computed(
  () =>
    Boolean(keyword.value.trim()) ||
    timeRange.value !== 'all' ||
    Boolean(statusFilter.value) ||
    Boolean(yearFilter.value) ||
    Boolean(stateClassFilter.value)
)

// ---------------------------------------------------------------------------
// 表格分块渲染（2026-11-01）：几百单 × 9 列全量渲染 DOM 是切平台卡顿的主因。
// 表格只画前 N 行；导出、合计、状态统计仍按 filteredOrders 全量。
// ---------------------------------------------------------------------------
const TABLE_CHUNK = 100
const visibleCount = ref(TABLE_CHUNK)
const tableRows = computed(() => filteredOrders.value.slice(0, visibleCount.value))
const tableTruncated = computed(() => filteredOrders.value.length > tableRows.value.length)

function showMoreRows(all: boolean): void {
  visibleCount.value = all ? filteredOrders.value.length : visibleCount.value + TABLE_CHUNK
}

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


/** 勾选行的实付合计（勾选后可只导这部分，金额心里有数） */
const selectedAmount = computed(() => sumOf(selectedOrders.value))

function sumOf(list: Order[]): string {
  const sum = list.reduce((acc, o) => {
    const n = Number(String(o.paidAmount ?? '').replace(/[^\d.-]/g, ''))
    return acc + (Number.isFinite(n) ? n : 0)
  }, 0)
  return sum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const emptyText = computed(() => {
  if (currentOrders.value.length) {
    return hasFilter.value
      ? `没有符合「${filterSummary.value}」的订单`
      : '没有匹配筛选条件的订单 — 试试清空搜索或切回「全部时间」'
  }
  if (hasBizTabs.value && bizTab.value === 'local') {
    return '这个平台还没有外卖/本地生活订单 — 抓取订单时会一并归类到这里'
  }
  return '暂无订单 — 登录后点「抓取订单」，全程后台自动抓取'
})

/** 状态大类的展示名（筛选摘要用，与下拉选项保持一致） */
const STATE_CLASS_LABEL: Record<OrderStateClass, string> = {
  success: '交易成功',
  pending: '进行中',
  refunded: '已退款',
  closed: '已关闭'
}

const TIME_RANGE_LABEL: Record<'7' | '30' | '90', string> = {
  '7': '近 7 天',
  '30': '近 30 天',
  '90': '近 90 天'
}

/**
 * 已激活的筛选条件数（含搜索框）。
 * 只靠下拉里的文字很难发现「其实还筛着东西」，标题行用一枚徽标把这个状态显性化。
 */
const activeFilterCount = computed(() => {
  let n = 0
  if (keyword.value.trim()) n += 1
  if (timeRange.value !== 'all') n += 1
  if (yearFilter.value) n += 1
  if (stateClassFilter.value) n += 1
  if (statusFilter.value) n += 1
  return n
})

/** 筛选条件摘要（空结果时告诉用户「被什么条件挡住了」，最多列 2 项） */
const filterSummary = computed(() => {
  const parts: string[] = []
  if (keyword.value.trim()) parts.push(`「${keyword.value.trim()}」`)
  if (timeRange.value !== 'all') parts.push(TIME_RANGE_LABEL[timeRange.value])
  if (yearFilter.value) parts.push(`${yearFilter.value} 年`)
  if (stateClassFilter.value) parts.push(STATE_CLASS_LABEL[stateClassFilter.value])
  if (statusFilter.value) parts.push(statusFilter.value)
  const head = parts.slice(0, 2).join(' · ')
  return parts.length > 2 ? `${head} 等 ${parts.length} 项条件` : head
})

function resetFilters(): void {
  uiLog('ui', '重置筛选条件', { platform: activeId.value })
  clearTimeout(keywordTimer)
  keywordInput.value = ''
  keyword.value = ''
  timeRange.value = 'all'
  yearFilter.value = ''
  stateClassFilter.value = ''
  statusFilter.value = ''
}

/** 清空勾选（勾选工具条、换平台、改筛选都走它） */
function clearSelection(): void {
  selectedOrders.value = []
  tableRef.value?.clearSelection()
}

function focusSearch(): void {
  searchRef.value?.focus()
}

/** 搜索框里按 Esc：只清搜索词，不打断其它筛选 */
function onSearchEsc(): void {
  if (!keywordInput.value) return
  clearTimeout(keywordTimer)
  keywordInput.value = ''
  keyword.value = ''
  focusSearch()
}

/** Ctrl/⌘+F 或 `/` 聚焦搜索（在输入框里按 `/` 不抢） */
function onGlobalKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const typing =
    !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    focusSearch()
    return
  }
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    focusSearch()
  }
}

function onSelectionChange(rows: Order[]): void {
  selectedOrders.value = rows
}

// 换平台 / 改筛选 → 勾选失效（否则会导出「看不见的行」）
watch(
  [activeId, keyword, timeRange, yearFilter, stateClassFilter, statusFilter],
  () => {
    selectedOrders.value = []
    visibleCount.value = TABLE_CHUNK
    tableRef.value?.clearSelection()
})

/**
 * 换平台时清掉「平台状态」（原文筛选项）。
 * 每个平台的 status 文案完全不同（「交易成功」vs「已签收」），留着上一个平台的值
 * 只会得到一张空表；时间/年份/类型/搜索是跨平台语义，保留。
 */
watch(activeId, () => {
  statusFilter.value = ''
  bizTab.value = 'shopping'
})

// 网购/外卖切换也是一条「指令」，出问题时要能对上时间线
watch(bizTab, (tab) => {
  uiLog('ui', '切换网购/外卖', { platform: activeId.value, tab })
})

// ---------------------------------------------------------------------------
// 工单 031：导出中心
// ---------------------------------------------------------------------------

function openExport(scope: 'current' | 'selected'): void {
  uiLog('ui', '打开导出中心', {
    scope,
    platform: activeId.value,
    orders: scope === 'selected' ? selectedOrders.value.length : filteredOrders.value.length
  })
  exportScope.value = scope
  exportVisible.value = true
}

// ---------------------------------------------------------------------------
// 切换性能计时（2026-11-01）：定位卡顿瓶颈。数字打 console 与诊断信息，
// 拆两段：数据（过滤/统计重算）+ 渲染（表格 DOM 提交）。
// ---------------------------------------------------------------------------
interface SwitchTiming {
  from: string
  to: string
  totalMs: number
  dataMs: number
  renderMs: number
  rows: number
  at: number
}
const switchTimings = ref<SwitchTiming[]>([])
let switchT0 = 0
let switchFrom = ''
let filterEvalMs = 0

function selectPlatform(id: string): void {
  if (activeId.value === id) return
  uiLog('ui', id === LOGS_ID ? '打开运行日志' : '切换平台', {
    from: activeId.value,
    to: id
  })
  switchFrom = activeId.value
  switchT0 = performance.now()
  activeId.value = id
  nextTick(() => {
    requestAnimationFrame(() => {
      const totalMs = performance.now() - switchT0
      const timing: SwitchTiming = {
        from: switchFrom,
        to: id,
        totalMs: Math.round(totalMs),
        dataMs: Math.round(filterEvalMs),
        renderMs: Math.round(totalMs - filterEvalMs),
        rows: tableRows.value.length,
        at: Date.now()
      }
      switchTimings.value = [timing, ...switchTimings.value].slice(0, 20)
      // eslint-disable-next-line no-console
      console.info(
        `[switch-perf] ${switchFrom} → ${id}: ${timing.totalMs}ms（数据 ${timing.dataMs}ms + 渲染 ${timing.renderMs}ms，${timing.rows} 行）`
      )
    })
  })
}

/** 每个平台独立的「重新加载」状态（后台进行，互不影响） */
const reloading = ref<Record<string, boolean>>({})

// ---------------------------------------------------------------------------
// 增量抓取（2026-11-01）：有本地数据时只抓新单，不再每次从头翻
// 主进程翻到「整页全是本地已知单」就停；旧单状态靠周期性的全量刷新兜底
// ---------------------------------------------------------------------------
const FULL_SYNC_DAYS = 7
const fullSyncKey = (p: string): string => `reflow.full-sync.${p}`

/** 有本地数据、且 7 天内做过全量 → 本次走增量；否则全量（顺带刷新旧单状态） */
function nextFetchIncremental(platform: string): boolean {
  if (!(ordersStore.byPlatform[platform]?.length ?? 0)) return false
  const last = Number(localStorage.getItem(fullSyncKey(platform)) ?? 0)
  return Date.now() - last < FULL_SYNC_DAYS * 86_400_000
}

function markFullSynced(platform: string): void {
  localStorage.setItem(fullSyncKey(platform), String(Date.now()))
}

/**
 * 一键重新加载某平台订单。
 *
 * 工单 040 起，拼多多/淘宝/京东为**接口直连**：主进程直接调订单 API，
 * 不需要打开页面，抓取期间随便切平台都不打断。
 * 闲鱼走主进程隐藏宿主（工单 041），同样无需界面页面。
 */
async function reloadPlatform(id: string): Promise<void> {
  if (reloading.value[id]) return
  reloading.value = { ...reloading.value, [id]: true }
  const name = platforms.value.find((p) => p.id === id)?.displayName ?? id
  try {
    // 缓存新鲜度检测：10 分钟内抓过且订单数没变 → 跳过重新请求，避免频繁抓取卡顿
    if (ordersStore.isCacheFresh(id) && (ordersStore.byPlatform[id]?.length ?? 0) > 0) {
      ElNotification.info({
        title: `${name}：数据已是最新`,
        message: `本地已有 ${ordersStore.byPlatform[id]?.length} 单（10 分钟内同步过），跳过重新抓取。如需强制刷新，请稍后再试。`,
        duration: 4000
      })
      return
    }
    const incremental = nextFetchIncremental(id)
    const r = await window.api.fetchAllOrders(id as FetchPlatform, undefined, {
      incremental
    })
    if (!r.ok) {
      if (r.message) handleFetchFailure(id, r.message)
      return
    }
    if (!incremental) markFullSynced(id)
    // 能抓到数据就说明会话是好的：把可能被误标的「未登录」补回来
    platformsStore.markLoggedIn(id)
    const after = ordersStore.byPlatform[id]?.length ?? 0
    const done = ordersStore.fetchStateOf(id)
    ordersStore.markSynced(id)
    ElNotification.success({
      title: `${name} 订单已全部加载`,
      message: `本地共 ${after} 单（本次 ${done.pages ?? '—'} 页 / ${done.orders ?? '—'} 单）`,
      duration: 8000
    })
  } catch (err) {
    ElNotification.error({
      title: '重新加载失败',
      message: `${name}：${err instanceof Error ? err.message : String(err)}`
    })
  } finally {
    reloading.value = { ...reloading.value, [id]: false }
  }
}

/**
 * 抓取时机（2026-11-02 用户反馈后重定）：
 * **只在用户明确要求时抓** —— 点「抓取订单」、点侧栏刷新图标、或刚扫码登录成功。
 *
 * 之前是「进平台就自动抓」，而且启动时读到的既有登录态会让 `login.loggedIn`
 * 从 false 翻成 true，等于**每次打开软件都自动跑一轮全量抓取**：
 * 用户只想看看昨天的订单，却要等后台跑完、还可能弹出「登录已失效」的框。
 * 订单有本地缓存，打开就能看；要不要更新由用户决定。
 */
function onLoginSuccess(): void {
  // 登录成功 → 自动补一次抓取（2026-11-02 第二次修正）。
  //
  // 之前因为「扫完码是假成功」，登录后自动抓必然失败、又弹「登录已失效」，形成死循环，
  // 所以当时改成了纯手动。现在扫码落地判定修好了（只认 unb，见工单 048），
  // 登录事件 = 会话确实可用，自动抓一次才符合预期 —— 否则用户扫完码看到空表，
  // 以为「登录了但没数据」。
  //
  // 防循环：延迟 800ms 等 store 收到登录事件；只在确实已登录时才抓。
  const id = activeId.value
  if (!id) return
  reloginPrompted.delete(id)
  reloginNotified.delete(id)
  ElNotification.success({
    title: '登录成功',
    message: '正在后台抓取订单（不影响当前浏览），抓完会自动刷新列表。',
    duration: 5000
  })
  window.setTimeout(() => {
    if (activeId.value !== id) return
    if (captureBusy) return
    if (!platformsStore.loginOf(id).loggedIn) return
    void startAutoCapture()
  }, 800)
}

// ---------------------------------------------------------------------------
// 登录成功后的自动抓取链路
// ---------------------------------------------------------------------------

/** 抓取互斥：登录回调和「进入平台自动抓」可能同时进来 */
let captureBusy = false

/** 登录成功 / 点「抓取订单」→ 启动主动抓取（全程后台，无需页面） */
async function startAutoCapture(): Promise<void> {
  const platform = activeId.value
  if (!platform) return
  if (captureBusy) return
  uiLog('ui', '点击「抓取订单」', { platform, incremental: ordersStore.isCacheFresh(platform) })
  // 未登录就直接引导登录，不要拿接口去撞（撞了必然 SESSION_EXPIRED → 又弹「登录失效」）
  // 之前这里还有「有历史订单也算可抓」的兜底，导致「已掉登录但本地有缓存」时
  // 每次点抓取都失败一次（淘宝就是这么反复弹框的）
  if (!platformsStore.loginOf(platform).loggedIn) {
    void offerRelogin(platform, active.value?.displayName ?? platform, '还没有登录这个平台，登录后才能抓取订单')
    return
  }

  captureBusy = true
  try {
    const fetchPlatform = platform
    const incremental = nextFetchIncremental(fetchPlatform)

    try {
      const result = await window.api.fetchAllOrders(
        fetchPlatform as FetchPlatform,
        undefined,
        { incremental }
      )
      if (result.ok) {
        platformsStore.markLoggedIn(fetchPlatform)
        if (!incremental) markFullSynced(fetchPlatform)
        const n = ordersStore.byPlatform[fetchPlatform]?.length ?? 0
        const done = ordersStore.fetchStateOf(fetchPlatform)
        ElNotification.success({
          title: '订单已全部加载完成',
          message: `${active.value?.displayName ?? ''}：本地共 ${n} 单（本次 ${done.pages ?? '—'} 页 / ${done.orders ?? '—'} 单）`,
          duration: 8000
        })
      } else if (!result.cancelled && result.message) {
        handleFetchFailure(fetchPlatform, result.message)
      }
    } catch (e) {
      handleFetchFailure(fetchPlatform, e instanceof Error ? e.message : String(e))
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
        switchTimings: switchTimings.value.slice(0, 10),
        inMemory: Object.fromEntries(
          Object.entries(ordersStore.byPlatform).map(([p, list]) => [p, list.length])
        ),
        parseErrors: ordersStore.parseErrors.slice(0, 10).map((e) => ({
          platformId: e.platformId,
          message: e.message
        })),
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

onMounted(() => {
  ordersStore.init()
  platformsStore.init()
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  clearTimeout(keywordTimer)
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

.platform-item.dragging {
  opacity: 0.4;
}

.platform-item.drag-over {
  box-shadow: inset 0 2px 0 var(--el-color-primary);
}

.platform-item {
  width: 100%;
  /* width:100% + padding 在 content-box 下会宽出 12px，把侧栏顶出横向滚动条 */
  box-sizing: border-box;
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

/* 总览入口：用图标而非首字头像，和下面的平台行区分开 */
.overview-item {
  font-weight: 500;
}

.overview-icon {
  flex: none;
  width: 18px;
  height: 18px;
  font-size: 14px;
  color: var(--el-color-primary);
}

.overview-item:not(.active) .overview-icon {
  color: var(--el-text-color-secondary);
}

.list-divider {
  height: 1px;
  margin: 4px 6px 6px;
  background: var(--el-border-color-lighter);
}

/* 网购 / 外卖 分组标题 */
.group-head {
  padding: 8px 8px 2px;
  font-size: 10px;
  line-height: 14px;
  letter-spacing: 0.5px;
  color: var(--el-text-color-placeholder);
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
  /* 窄窗口下允许换行：宁可多一行，也不要让按钮被挤出可视区 */
  flex-wrap: wrap;
  row-gap: 6px;
  min-height: 32px;
}

.content-title {
  font-weight: 600;
  font-size: 14px;
}

/* 已登录账号标签可点开：重新登录 / 退出登录 */
.account-tag {
  cursor: pointer;
}

/* 列顺序按钮：图标 + 文字，文字在窄窗口下跟着按钮一起换行 */
.col-order-text {
  margin-left: 4px;
}

/*
  平台页内的「网购 / 外卖」分栏（淘宝、京东）。
  做成分段按钮而不是大标签：它和筛选栏是两级东西，视觉上不能抢过筛选控件。
*/
.biz-tabs :deep(.el-radio-button__inner) {
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* 标题行右侧的统计：右对齐 + 等宽数字，切平台/筛选时不会左右跳 */
.head-stat {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.head-stat b {
  color: var(--el-text-color-primary);
  font-weight: 600;
}

/* 退款金额用警示色：它和实付是两个口径，不能混成一片灰 */
.head-stat .stat-refund {
  color: var(--el-color-danger);
}

/* 「已筛选 N 项」徽标：把隐性的筛选状态显性化 */
.filter-chip {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  white-space: nowrap;
}

/*
  筛选行：每个控件都有确定宽度。
  搜索框吃剩余宽度（160–360），四个下拉各占固定宽度 —— 之前缺宽度声明，
  下拉被 flex 拉成整行，这是「筛选区排成 4 行」的直接原因。
*/
.filter-bar {
  display: flex;
  align-items: center;
  /* 正常宽度（≥1080）下永远单行；wrap 只是极端 DPI/字体下的安全阀 */
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  flex: none;
}

.filter-search {
  /* basis 200：1080 宽（内容区 812）下六个控件刚好一行；宽窗口再让它长到 480 */
  flex: 1 1 200px;
  min-width: 160px;
  max-width: 480px;
}

.filter-time {
  flex: 0 0 108px;
  width: 108px;
}

.filter-year {
  /* 104 而不是 96：「全部年份」在 96 下会被截成「全部…」（实测 scrollWidth 56 > client 52） */
  flex: 0 0 104px;
  width: 104px;
}

.filter-state {
  flex: 0 0 120px;
  width: 120px;
}

.filter-status {
  flex: 0 0 170px;
  width: 170px;
}

.filter-reset {
  flex: none;
  /* 右端对齐：把这一行的「收尾动作」固定在右侧，宽窗口下不会显得左边堆一坨 */
  margin-left: auto;
  padding-left: 4px;
}

/* 激活态：浅主色底 + 主色描边，一眼看出这几个下拉在起作用 */
.filter-bar .is-filtered :deep(.el-select__wrapper) {
  background: var(--el-color-primary-light-9);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-7) inset;
}

.filter-bar .is-filtered :deep(.el-select__selected-item) {
  color: var(--el-color-primary);
  font-weight: 600;
}

/* 勾选工具条：贴在表格上方，交代「勾了几行、能导什么」 */
.selection-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  margin-bottom: 8px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-8);
}

.selection-text {
  font-size: 12px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.selection-text b {
  color: var(--el-color-primary);
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

/* 分块提示条：表格只画前 N 行时显示 */
.table-more {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cap-log-url {
  font-size: 11px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

/* 抓取进度条 */
.capture-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: -2px 0 8px;
  padding: 6px 10px 8px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  flex: none;
}

.capture-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.capture-title {
  font-weight: 600;
  flex: none;
}

/* 计数是最重要的感知点：页数 / 单数用大一点的加粗数字 */
.capture-count {
  flex: none;
  color: var(--el-text-color-primary);
}
.capture-count b {
  font-size: 13px;
  color: var(--el-color-warning-dark-2);
}

.capture-progress :deep(.el-progress-bar__outer) {
  background-color: var(--el-color-warning-light-8);
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
