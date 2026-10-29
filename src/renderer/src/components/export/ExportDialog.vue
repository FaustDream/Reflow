<template>
  <el-dialog
    v-model="visible"
    :title="result ? '导出完成' : '导出订单'"
    width="700px"
    top="6vh"
    :close-on-click-modal="false"
    class="export-dialog"
    @closed="onClosed"
  >
    <!-- 导出完成：给出文件位置与下一步动作 -->
    <div v-if="result" class="result">
      <el-result icon="success" :title="`已导出 ${result.rowCount ?? rows.length} 单`">
        <template #sub-title>
          <div class="result-path" :title="result.path">{{ result.path }}</div>
          <div v-if="imageFailures" class="result-warn">
            {{ imageFailures }} 张商品图下载失败，其余内容已正常写入
          </div>
        </template>
        <template #extra>
          <el-button type="primary" @click="openFile">打开文件</el-button>
          <el-button @click="openFolder">打开所在目录</el-button>
          <el-button text @click="resetResult">再导一次</el-button>
        </template>
      </el-result>
    </div>

    <div v-else class="body">
      <!-- 范围 -->
      <section class="block">
        <div class="block-title">导出范围</div>
        <el-radio-group v-model="scope" size="small" class="scope-group">
          <el-radio-button value="current">当前平台（{{ currentOrders.length }}）</el-radio-button>
          <el-radio-button value="selected" :disabled="!selectedOrders.length">
            已勾选（{{ selectedOrders.length }}）
          </el-radio-button>
        </el-radio-group>
        <div class="block-hint">
          {{ scopeLabel }}：<b>{{ rows.length }}</b> 单 · 实付合计
          <b>¥{{ totalAmount }}</b>
          <span v-if="!rows.length" class="warn">（该范围没有订单）</span>
        </div>
      </section>

      <!-- 格式 -->
      <section class="block">
        <div class="block-title">格式</div>
        <div class="format-list">
          <label
            v-for="f in FORMATS"
            :key="f.value"
            class="format-item"
            :class="{ active: format === f.value }"
          >
            <el-radio v-model="format" :value="f.value">
              <span class="format-name">{{ f.name }}</span>
              <span class="format-desc">{{ f.desc }}</span>
            </el-radio>
          </label>
        </div>
      </section>

      <!-- 选项 -->
      <section class="block options">
        <el-checkbox v-model="includeImages" :disabled="isCsv">
          内嵌商品图
          <span class="opt-hint">60×60 缩略图，会先下载图片</span>
        </el-checkbox>
        <el-checkbox v-model="summary" :disabled="!isMulti">
          附带汇总表
          <span class="opt-hint">各平台单数与金额合计</span>
        </el-checkbox>
      </section>

      <!-- 列选择 -->
      <section class="block">
        <div class="block-title">
          导出列
          <span class="block-sub">{{ checkedCount }} / {{ allColumns.length }} 列</span>
          <div class="spacer" />
          <el-button link size="small" @click="selectAll">全选</el-button>
          <el-button link size="small" @click="selectCore">仅核心列</el-button>
          <el-button link size="small" @click="clearAll">清空</el-button>
        </div>

        <el-collapse v-model="openPanels" class="cols">
          <el-collapse-item name="core">
            <template #title>
              {{ columns.custom ? '平台列（原版列序）' : '核心列' }}
              <span class="panel-count">{{ coreKeys.length }}/{{ columns.core.length }}</span>
            </template>
            <el-checkbox-group v-model="coreKeys" class="col-grid">
              <el-checkbox v-for="c in columns.core" :key="c.key" :value="c.key" :label="c.header" />
            </el-checkbox-group>
          </el-collapse-item>

          <el-collapse-item v-for="g in extendedGroups" :key="g.name" :name="g.name">
            <template #title>
              {{ g.name }} 扩展列
              <span class="panel-count">{{ g.checked }}/{{ g.columns.length }}</span>
            </template>
            <el-checkbox-group v-model="extKeys" class="col-grid">
              <el-checkbox
                v-for="c in g.columns"
                :key="c.key"
                :value="c.key"
                :label="c.header"
              />
            </el-checkbox-group>
          </el-collapse-item>
        </el-collapse>
      </section>

      <!-- 含图导出的下载进度 -->
      <div v-if="exporting && includeImages && !isCsv" class="progress">
        <el-progress
          :percentage="percent"
          :stroke-width="6"
          :status="progress && progress.failed ? 'warning' : undefined"
        />
        <span class="progress-text">
          {{ progress ? `下载图片 ${progress.done}/${progress.total}` : '正在准备图片…' }}
          <template v-if="progress?.failed">（失败 {{ progress.failed }}）</template>
        </span>
      </div>
    </div>

    <template #footer>
      <template v-if="result">
        <el-button @click="visible = false">关闭</el-button>
      </template>
      <template v-else>
        <span class="footer-hint">{{ footerHint }}</span>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="exporting" :disabled="!canExport" @click="doExport">
          开始导出
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 工单 031：导出中心。
 *
 * 之前的导出只有一个下拉菜单（单表/多表/CSV），用户无法控制列、无法只导勾选的订单，
 * 含图导出时界面还会假死（图片下载没有进度反馈）。这里把导出收敛成一个对话框：
 *
 * - 范围：当前平台（已应用筛选）/ 表格勾选 / 全部平台
 * - 格式：xlsx 单表 / xlsx 多表 / CSV
 * - 列：核心列 + 各平台扩展列逐项勾选（列清单由主进程算，与真正导出的表头同源）
 * - 选项：内嵌商品图（带下载进度）、多表附带汇总表
 * - 结果：直接给出路径 + 打开文件 / 打开目录
 *
 * 用户的勾选记在 localStorage，下次打开沿用；没有保存过时默认全选。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ExportColumn, Order } from '@shared/types'

type Scope = 'current' | 'selected'
type Format = 'xlsx-single' | 'xlsx-multi' | 'csv'

interface ExportResultView {
  path?: string
  rowCount?: number
  imageFailures?: number
}

const props = defineProps<{
  activePlatformId: string
  activePlatformName: string
  /** 当前平台 + 当前筛选后的订单 */
  currentOrders: Order[]
  /** 表格中勾选的订单 */
  selectedOrders: Order[]
  /** 打开时的默认范围 */
  defaultScope?: Scope
}>()

const visible = defineModel<boolean>({ required: true })

const FORMATS: Array<{ value: Format; name: string; desc: string }> = [
  { value: 'xlsx-single', name: 'Excel 单表', desc: '所有平台合并到一张表，列冲突自动消歧' },
  { value: 'xlsx-multi', name: 'Excel 多表', desc: '每个平台一张工作表，可附汇总表' },
  { value: 'csv', name: 'CSV', desc: '带 BOM，Excel 直接打开不乱码' }
]

const PREFS_KEY = 'reflow.export.prefs'

const scope = ref<Scope>('current')
const format = ref<Format>('xlsx-single')
const includeImages = ref(false)
const summary = ref(true)
const exporting = ref(false)
const progress = ref<{ done: number; total: number; failed: number } | null>(null)
const result = ref<ExportResultView | null>(null)
const openPanels = ref<string[]>(['core'])

const columns = ref<{ core: ExportColumn[]; extended: ExportColumn[]; custom?: boolean }>({
  core: [],
  extended: []
})
const coreKeys = ref<string[]>([])
const extKeys = ref<string[]>([])

const isCsv = computed(() => format.value === 'csv')
const isMulti = computed(() => format.value === 'xlsx-multi')

/** 当前范围对应的订单 */
const rows = computed<Order[]>(() => {
  if (scope.value === 'selected') return props.selectedOrders
  return props.currentOrders
})

const platformIds = computed(() => [...new Set(rows.value.map((o) => o.platform))])

const scopeLabel = computed(() => {
  if (scope.value === 'current') return `${props.activePlatformName || '当前平台'}（当前筛选）`
  return '表格勾选'
})

/** 实付合计（只做展示，不参与导出计算；解析失败按 0 计） */
const totalAmount = computed(() => {
  const sum = rows.value.reduce((acc, o) => {
    const n = Number(String(o.paidAmount ?? '').replace(/[^\d.-]/g, ''))
    return acc + (Number.isFinite(n) ? n : 0)
  }, 0)
  return sum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

const imageFailures = computed(() => result.value?.imageFailures ?? 0)

const allColumns = computed(() => [...columns.value.core, ...columns.value.extended])
const checkedCount = computed(() => coreKeys.value.length + extKeys.value.length)

const canExport = computed(
  () => rows.value.length > 0 && checkedCount.value > 0 && !exporting.value
)

const footerHint = computed(() => {
  if (!rows.value.length) return '当前范围没有订单'
  if (!checkedCount.value) return '至少勾选一列'
  if (includeImages.value && !isCsv.value) return `将下载 ${rows.value.filter((o) => o.imageUrl).length} 张商品图`
  return ''
})

const percent = computed(() => {
  const p = progress.value
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

/** 扩展列按平台分组（未标注平台的归入「通用」） */
const extendedGroups = computed(() => {
  const groups = new Map<string, ExportColumn[]>()
  for (const col of columns.value.extended) {
    const name = col.platformName ?? col.platformId ?? '通用'
    const list = groups.get(name) ?? []
    list.push(col)
    groups.set(name, list)
  }
  return [...groups.entries()].map(([name, list]) => ({
    name,
    columns: list,
    checked: list.filter((c) => extKeys.value.includes(c.key)).length
  }))
})

function readPrefs(): { coreKeys?: string[]; extKeys?: string[]; includeImages?: boolean; summary?: boolean } | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        coreKeys: coreKeys.value,
        extKeys: extKeys.value,
        includeImages: includeImages.value,
        summary: summary.value
      })
    )
  } catch {
    /* 隐私模式等场景下写不进去，不影响导出 */
  }
}

/** 拉取列清单：跟随当前范围的平台变化（列由主进程按同一套消歧规则算出） */
async function loadColumns(): Promise<void> {
  const ids = platformIds.value
  try {
    const res = await window.api.getExportColumns(ids)
    // 声明了原版列序的平台：整份列表就是一个列组（不再区分核心/扩展）
    columns.value = res.custom
      ? { core: res.extended, extended: [], custom: true }
      : { core: res.core, extended: res.extended }
    const pref = readPrefs()
    const coreAvailable = columns.value.core.map((c) => c.key)
    const extAvailable = columns.value.extended.map((c) => c.key)
    // 偏好里出现过的 key 才沿用；新平台/新列默认勾上（否则用户会「导出后少了一列」）
    coreKeys.value = pref?.coreKeys
      ? coreAvailable.filter((k) => pref.coreKeys!.includes(k))
      : coreAvailable
    extKeys.value = pref?.extKeys ? extAvailable.filter((k) => pref.extKeys!.includes(k)) : extAvailable
    if (pref && typeof pref.includeImages === 'boolean') includeImages.value = pref.includeImages
    if (pref && typeof pref.summary === 'boolean') summary.value = pref.summary
  } catch (e) {
    ElMessage.error(`读取导出列失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function selectAll(): void {
  coreKeys.value = columns.value.core.map((c) => c.key)
  extKeys.value = columns.value.extended.map((c) => c.key)
}

function selectCore(): void {
  coreKeys.value = columns.value.core.map((c) => c.key)
  extKeys.value = []
}

function clearAll(): void {
  coreKeys.value = []
  extKeys.value = []
}

async function doExport(): Promise<void> {
  if (!canExport.value) return
  exporting.value = true
  progress.value = null
  try {
    const res = await window.api.exportExcel([...rows.value], platformIds.value, includeImages.value, {
      format: isCsv.value ? 'csv' : 'xlsx',
      layout: isMulti.value ? 'multi-sheet' : 'single',
      columnKeys: extKeys.value,
      coreKeys: coreKeys.value,
      summary: summary.value
    })
    if (res.cancelled) return
    if (!res.ok) {
      ElMessage.error(`导出失败：${res.message ?? res.reason ?? '未知错误'}`)
      return
    }
    savePrefs()
    result.value = { path: res.path, rowCount: res.rowCount, imageFailures: res.imageFailures }
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    exporting.value = false
  }
}

function openFile(): void {
  if (result.value?.path) void window.api.openPath(result.value.path)
}

function openFolder(): void {
  if (result.value?.path) void window.api.showInFolder(result.value.path)
}

function resetResult(): void {
  result.value = null
}

function onClosed(): void {
  result.value = null
  progress.value = null
  exporting.value = false
}

// 打开时按调用方的默认范围初始化，并（重新）拉列清单
watch(visible, (open) => {
  if (!open) return
  scope.value = props.defaultScope ?? 'current'
  result.value = null
  void loadColumns()
})

// 范围内平台变了（如切到「全部平台」）→ 扩展列需要重算
watch(platformIds, () => {
  if (visible.value && !result.value) void loadColumns()
})

const unsubProgress = window.api.onImageProgress((p) => {
  progress.value = p
})

onUnmounted(() => unsubProgress())
</script>

<style scoped>
.body {
  max-height: 66vh;
  overflow-y: auto;
  padding-right: 4px;
}

.block {
  margin-bottom: 16px;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}

.block-sub {
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.block-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.block-hint b {
  color: var(--el-text-color-primary);
}

.warn {
  color: var(--el-color-warning);
}

.spacer {
  flex: 1;
}

.scope-group {
  width: 100%;
}

.format-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.format-item {
  display: block;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.format-item:hover {
  border-color: var(--el-color-primary-light-5);
}

.format-item.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.format-name {
  font-size: 13px;
}

.format-desc {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.options {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}

.opt-hint {
  margin-left: 4px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.cols {
  border-top: 1px solid var(--el-border-color-lighter);
}

.panel-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.col-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px 8px;
}

.col-grid :deep(.el-checkbox) {
  margin-right: 0;
  height: 24px;
}

.col-grid :deep(.el-checkbox__label) {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.progress-text {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.footer-hint {
  float: left;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 32px;
}

.result-path {
  max-width: 560px;
  margin: 0 auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-warn {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-color-warning);
}
</style>
