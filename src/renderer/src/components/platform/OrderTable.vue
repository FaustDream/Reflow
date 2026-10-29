<template>
  <div class="order-table">
    <el-table
      v-if="orders.length"
      v-loading="loading"
      element-loading-text="正在加载订单，请稍候…"
      element-loading-background="rgba(255, 255, 255, 0.72)"
      ref="tableRef"
      :data="orders"
      size="small"
      height="100%"
      class="table"
      row-key="orderId"
      @selection-change="onSelectionChange"
    >
      <!-- 工单 031：勾选后可「只导出选中」 -->
      <el-table-column v-if="selectable" type="selection" width="40" fixed />
      <el-table-column prop="orderId" label="订单号" width="170" show-overflow-tooltip />
      <!-- 工单 021：多账号时标注每行归属账号 -->
      <el-table-column
        v-if="showAccount"
        prop="account"
        label="账号"
        width="130"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <span>{{ accountLabel(row.account) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="商品" min-width="220" show-overflow-tooltip />
      <el-table-column
        prop="paidAmount"
        label="实付"
        width="100"
        align="right"
        sortable
        :sort-method="sortByPaid"
      >
        <template #default="{ row }">
          <span class="money">{{ formatMoney(row.paidAmount) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="quantity" label="数量" width="64" align="right" sortable />
      <el-table-column prop="status" label="状态" width="104" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag v-if="row.status" size="small" effect="plain" :type="statusType(row.status)">
            {{ row.status }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="下单时间" width="150" sortable />
      <el-table-column prop="shopName" label="店铺" min-width="130" show-overflow-tooltip />
      <el-table-column
        prop="receiverAddress"
        label="收货地址"
        min-width="180"
        show-overflow-tooltip
      />
    </el-table>
    <el-empty v-else :description="emptyText" :image-size="70" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { Order } from '@shared/types'
import { useAccountsStore } from '@renderer/stores/accounts'

withDefaults(
  defineProps<{
    orders: Order[]
    loading?: boolean
    /** 是否显示「账号」列（多账号场景） */
    showAccount?: boolean
    /** 是否显示勾选列（勾选后可只导出选中行） */
    selectable?: boolean
    /** 空表文案（筛选无结果时由调用方给出更贴切的说明） */
    emptyText?: string
  }>(),
  {
    loading: false,
    showAccount: false,
    selectable: false,
    emptyText: '暂无订单 — 点左侧登录后，在平台页面中浏览订单即可自动捕获'
  }
)

const emit = defineEmits<{
  (e: 'clear'): void
  (e: 'selection-change', rows: Order[]): void
}>()

const accountsStore = useAccountsStore()
const tableRef = ref<{ clearSelection: () => void } | null>(null)

function onSelectionChange(rows: Order[]): void {
  emit('selection-change', rows)
}

/** 供父组件在切换平台/筛选后清空勾选 */
function clearSelection(): void {
  tableRef.value?.clearSelection()
}

defineExpose({ clearSelection })

/** 订单的 account 是 `<platform>#<slot>`，转成用户看得懂的名字 */
function accountLabel(account: string | undefined): string {
  if (!account) return '—'
  const row = accountsStore.list.find((a) => a.id === account)
  return row?.displayName ?? account
}

/** 金额解析（平台原文可能带 ¥ / 千分位；解析不出来就原样显示，绝不显示 0） */
function amountOf(value: string | undefined): number | null {
  if (!value) return null
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function formatMoney(value: string | undefined): string {
  const n = amountOf(value)
  if (n === null) return value || '—'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 金额按数值排序（字符串排序会把 100 排在 20 前面） */
function sortByPaid(a: Order, b: Order): number {
  return (amountOf(a.paidAmount) ?? 0) - (amountOf(b.paidAmount) ?? 0)
}

/** 状态语义色：完成=成功、待处理=警告、退款/取消=异常、其余=默认 */
function statusType(status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (/退款|退货|退换/.test(status)) return 'danger'
  if (/取消|关闭|失败|异常/.test(status)) return 'info'
  if (/完成|成功|已签收|已收货|交易成功|已发货/.test(status)) return 'success'
  if (/待|未付款|未发货|处理中|进行中|运输中/.test(status)) return 'warning'
  return 'primary'
}

</script>

<style scoped>
.order-table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.table {
  flex: 1;
  min-height: 0;
}

.money {
  font-variant-numeric: tabular-nums;
}

.muted {
  color: var(--el-text-color-placeholder);
}
</style>
