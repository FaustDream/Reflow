<template>
  <div class="order-table" v-loading="loading" element-loading-text="正在加载订单，请稍候…">
    <!-- 虚拟滚动表格（el-table-v2）：万行级也只渲染可视区，切换平台不再卡顿 -->
    <div v-if="orders.length" class="table-area">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2
            ref="tableV2Ref"
            :columns="v2Columns"
            :data="displayRows"
            :width="width"
            :height="height"
            row-key="id"
            fixed
            :row-height="36"
            :header-height="36"
            :sort-state="v2SortState"
            :header-class="headerClass"
            @column-sort="v2OnColumnSort"
          />
        </template>
      </el-auto-resizer>
    </div>
    <!-- 空表：除了文案，允许调用方塞一个动作（筛选无结果时的「清空筛选」） -->
    <el-empty v-else :description="emptyText" :image-size="70">
      <slot name="empty-extra" />
    </el-empty>

    <!-- 分页条：固定在表格下方，不随表格滚动 -->
    <footer v-if="orders.length" class="table-foot">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="PAGE_SIZES"
        :total="orders.length"
        layout="total, sizes, prev, pager, next, jumper"
        background
        size="small"
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { ElTag } from 'element-plus'
import type { ColumnSortHandler, Columns, SortState } from 'element-plus'
import { amountOf, orderStateOfStatus } from '@renderer/utils/order-stats'
import { useColumnOrder } from '@renderer/composables/useColumnOrder'
import type { Order } from '@shared/types'

const props = withDefaults(
  defineProps<{
    orders: Order[]
    loading?: boolean
    /** 是否显示勾选列（勾选后可只导出选中行） */
    selectable?: boolean
    /** 空表文案（筛选无结果时由调用方给出更贴切的说明） */
    emptyText?: string
  }>(),
  {
    loading: false,
    selectable: false,
    emptyText: '暂无订单 — 点左侧登录后，在平台页面中浏览订单即可自动捕获'
  }
)

const emit = defineEmits<{
  (e: 'selection-change', rows: Order[]): void
}>()

const tableRef = ref<{ clearSelection: () => void } | null>(null)
void tableRef

// ---------------------------------------------------------------------------
// 勾选：el-table-v2 不带内置 selection 列，用 cellRenderer 自实现
// key = 订单号（空单号按行序兜底，仅影响极少数历史导入行）
// ---------------------------------------------------------------------------
const selectedIds = ref<Set<string>>(new Set())

const keyOf = (o: Order, i: number): string => o.orderId || `__noId_${i}`

function toggleRow(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const pageRowIds = computed(() => displayRows.value.map((r) => r.id))
const allSelected = computed(
  () => pageRowIds.value.length > 0 && pageRowIds.value.every((id) => selectedIds.value.has(id))
)
const someSelected = computed(() => pageRowIds.value.some((id) => selectedIds.value.has(id)))

/** 表头勾选框只管当前页；跨页已选的不会因此被清掉（导出仍按全部已选） */
function toggleAll(): void {
  const next = new Set(selectedIds.value)
  if (allSelected.value) {
    for (const id of pageRowIds.value) next.delete(id)
  } else {
    for (const id of pageRowIds.value) next.add(id)
  }
  selectedIds.value = next
}

watch(selectedIds, () => {
  emit('selection-change', props.orders.filter((o) => selectedIds.value.has(o.orderId)))
})

/** 供父组件在切换平台/筛选后清空勾选 */
function clearSelection(): void {
  selectedIds.value = new Set()
}
defineExpose({ clearSelection })

// ---------------------------------------------------------------------------
// 排序：v2 只报事件，排序由我们对数据自行执行
// ---------------------------------------------------------------------------
type SortOrder = 'asc' | 'desc'
const sortState = ref<{ key?: string; order?: SortOrder }>({})

function compare(a: Order, b: Order, key: string): number {
  if (key === 'paidAmount') return amountOf(a) - amountOf(b)
  if (key === 'quantity') return (a.quantity ?? 0) - (b.quantity ?? 0)
  if (key === 'createdAt') return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
  return 0
}

function onColumnSort({ key, order }: { key: string; order: SortOrder }): void {
  sortState.value = { key, order }
}

/** 排序 + 包装 id（v2 需要 row-key 字段；选择/渲染都基于包装行） */
const sortedRows = computed(() => {
  const list = props.orders.map((o, i) => ({ ...o, id: keyOf(o, i) }))
  const { key, order } = sortState.value
  if (key && order) {
    const dir = order === 'asc' ? 1 : -1
    list.sort((a, b) => dir * compare(a, b, key))
  }
  return list
})

// ---------------------------------------------------------------------------
// 分页（2026-11-11）
//
// 虚拟表本身画万行也不卡，但「第几页 / 共多少条」是查旧单时最自然的定位方式，
// 老版本用「再显示 100 单」往上堆，翻到第 800 行就找不着北了。
// 排序在**整表**上做，分页只切窗口 —— 否则每页内部各自排序，翻页结果会错乱。
// ---------------------------------------------------------------------------
const PAGE_SIZES = [50, 100, 200, 500]
const DEFAULT_PAGE_SIZE = 100
const page = ref(1)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const tableV2Ref = ref<{ scrollTo?: (p: { scrollTop?: number }) => void } | null>(null)

const totalPages = computed(() => Math.max(1, Math.ceil(props.orders.length / pageSize.value)))

const displayRows = computed(() => {
  const all = sortedRows.value
  if (all.length <= pageSize.value) return all
  const start = (page.value - 1) * pageSize.value
  return all.slice(start, start + pageSize.value)
})

/** 换平台 / 改筛选 / 进新单 → 回到第 1 页（用户看的永远是「最新的那批」） */
watch(
  () => props.orders,
  () => {
    page.value = 1
  }
)

/** 数据变少（比如筛选收窄）时把页码夹回有效范围，否则会停在一张空页上 */
watch(totalPages, (n) => {
  if (page.value > n) page.value = n
})

function onPageChange(): void {
  // 换页后滚回顶部：虚拟表会沿用上一页的 scrollTop，不重置看起来像「没翻页」
  tableV2Ref.value?.scrollTo?.({ scrollTop: 0 })
}

function onSizeChange(): void {
  page.value = 1
}

function moneyCell(v: unknown): string {
  const s = String(v ?? '').trim()
  if (s === '') return '—'
  const n = Number(s.replace(/[^\d.-]/g, ''))
  if (!Number.isFinite(n)) return s
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const statusTagType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  switch (orderStateOfStatus(status)) {
    case 'success':
      return 'success'
    case 'refunded':
      return 'danger'
    case 'refunding':
      return 'warning'
    case 'closed':
      return 'info'
    default:
      return 'warning'
  }
}

const ellipsis = (text: unknown): ReturnType<typeof h> =>
  h(
    'div',
    { class: 'cell-ellipsis', title: String(text ?? '') },
    String(text ?? '') || '—'
  )

interface V2Column {
  key: string
  dataKey: string
  title: string
  width: number
  align?: 'left' | 'right' | 'center'
  flexGrow?: number
  fixed?: 'left' | 'right'
  sortable?: boolean
  cellRenderer?: (p: { cellData: unknown; rowData: Order & { id: string } }) => ReturnType<typeof h> | string
  headerCellRenderer?: (p: { column: { key: string } }) => ReturnType<typeof h>
}

/**
 * 列定义：cellRenderer 里的 h() 渲染；商品/店铺用 flexGrow 吃掉剩余宽度。
 *
 * 顺序**不在这里写死**（工单 043）：由 `useColumnOrder()` 的全局列顺序决定，
 * 用户可在「列顺序」面板拖拽调整，所有平台共用同一套顺序。
 * 勾选列例外 —— 它不参与排序，永远钉在最左。
 */
const { order: columnOrder } = useColumnOrder()

/** 勾选列：el-table-v2 不带内置 selection 列，用 cellRenderer 自实现 */
function buildSelectionColumn(): V2Column {
  return {
    key: 'selection',
    dataKey: 'selection',
    title: '',
    width: 40,
    fixed: 'left',
    cellRenderer: ({ rowData }) =>
      h('label', { class: 'sel-cell', onClick: (e: Event) => e.stopPropagation() }, [
        h('input', {
          type: 'checkbox',
          checked: selectedIds.value.has(rowData.id),
          onChange: () => toggleRow(rowData.id)
        })
      ]),
    headerCellRenderer: () =>
      h('label', { class: 'sel-cell' }, [
        h('input', {
          type: 'checkbox',
          checked: allSelected.value,
          // 半选态用 indeterminate 属性表达
          ...(someSelected.value && !allSelected.value ? { indeterminate: true } : {}),
          onChange: toggleAll
        })
      ])
  }
}

/** 数据列定义：key 必须与 utils/column-order 的 TABLE_COLUMN_KEYS 一致 */
const dataColumnDefs: Record<string, V2Column> = {
  orderId: {
    key: 'orderId',
    dataKey: 'orderId',
    title: '订单号',
    width: 160,
    cellRenderer: ({ cellData }) => ellipsis(cellData)
  },
  title: {
    key: 'title',
    dataKey: 'title',
    title: '商品',
    width: 200,
    flexGrow: 3,
    cellRenderer: ({ cellData }) => ellipsis(cellData)
  },
  paidAmount: {
    key: 'paidAmount',
    dataKey: 'paidAmount',
    title: '实付',
    width: 100,
    align: 'right',
    sortable: true,
    cellRenderer: ({ cellData }) => moneyCell(cellData)
  },
  quantity: {
    key: 'quantity',
    dataKey: 'quantity',
    title: '数量',
    width: 64,
    align: 'right',
    sortable: true,
    cellRenderer: ({ cellData }) =>
      cellData === null || cellData === undefined ? '' : String(cellData)
  },
  status: {
    key: 'status',
    dataKey: 'status',
    title: '状态',
    width: 104,
    cellRenderer: ({ cellData }) =>
      cellData
        ? h(
            ElTag,
            { size: 'small', effect: 'plain', type: statusTagType(String(cellData)) },
            { default: () => String(cellData) }
          )
        : h('span', { class: 'muted' }, '—')
  },
  createdAt: {
    key: 'createdAt',
    dataKey: 'createdAt',
    title: '下单时间',
    width: 150,
    sortable: true,
    cellRenderer: ({ cellData }) => ellipsis(cellData)
  },
  shopName: {
    key: 'shopName',
    dataKey: 'shopName',
    title: '店铺',
    width: 140,
    flexGrow: 2,
    cellRenderer: ({ cellData }) => ellipsis(cellData)
  }
}

const columns = computed<V2Column[]>(() => {
  const cols: V2Column[] = []
  if (props.selectable) cols.push(buildSelectionColumn())
  for (const key of columnOrder.value) {
    const def = dataColumnDefs[key]
    if (def) cols.push(def)
  }
  return cols
})

// el-table-v2 的公开类型用字符串枚举（FixedDir/SortOrder），本文件的列定义与排序
// 逻辑用同值字面量（'left' / 'asc'）自洽 —— TS 不允许字面量赋给字符串枚举，
// 在绑定边界断言一次即可，内部逻辑与类型保持不动。
const v2Columns = computed(() => columns.value as unknown as Columns<any>)
const v2SortState = computed(() => sortState.value as unknown as SortState)
const v2OnColumnSort = onColumnSort as unknown as ColumnSortHandler<any>

const headerClass = 'order-v2-header'
</script>

<style scoped>
.order-table {
  height: 100%;
  /* 表格吃满剩余高度，分页条固定在底部 */
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.table-area {
  flex: 1;
  min-height: 0;
}

.table-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding: 6px 4px 0;
  margin-top: 6px;
  border-top: 1px solid var(--el-border-color-lighter);
}

/* v2 单元格默认不省略：统一加省略号（cellRenderer 里带 title 原文） */
.order-table :deep(.cell-ellipsis) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 8px;
  line-height: 34px;
}

.order-table :deep(.sel-cell) {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.order-table :deep(.sel-cell input[type='checkbox']) {
  accent-color: var(--el-color-primary);
  cursor: pointer;
}

.order-table :deep(.order-v2-header .el-table-v2-header-cell) {
  background: var(--el-fill-color-light);
}

.muted {
  color: var(--el-text-color-placeholder);
  padding: 0 8px;
}
</style>
