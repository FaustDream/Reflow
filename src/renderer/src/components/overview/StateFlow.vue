<template>
  <!--
    五个状态卡：金额、占比、单数三层信息，点任意一张按该状态筛选，再点一次取消。
    刻意不带标题、说明和堆叠条 —— 卡上的金额与占比已经说清了结构，
    再加一条 100% 横条只是把同样的数字画第二遍。
  -->
  <div class="state-cards" role="group" aria-label="按交易状态查看订单">
    <button
      v-for="s in slices"
      :key="s.key"
      type="button"
      class="state-card"
      :class="{ 'is-active': isActive(s.key), 'is-empty': s.count === 0 }"
      :aria-pressed="isActive(s.key)"
      :disabled="s.count === 0"
      :title="`${s.meta.label}：${s.meta.hint}`"
      @click="emit('pick', s.key)"
    >
      <span class="sc-top">
        <i class="sc-dot" :style="{ background: s.meta.color }" />
        <span class="sc-name">{{ s.meta.short }}</span>
        <span class="sc-share">{{ pct(s.amountShare) }}</span>
      </span>
      <span class="sc-amount">{{ money(s.amount) }}</span>
      <span class="sc-meta">
        {{ s.count }} 单<template v-if="s.avg > 0"> · 均 {{ money(s.avg) }}</template>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { type StateSlice } from '@renderer/utils/overview-model'
import type { OrderState } from '@renderer/utils/order-stats'

const props = defineProps<{
  slices: StateSlice[]
  /** 已选中的状态（空 = 不过滤） */
  active: OrderState[]
}>()

const emit = defineEmits<{
  pick: [key: OrderState]
}>()

function isActive(key: OrderState): boolean {
  return props.active.includes(key)
}

function pct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%'
  const n = v * 100
  return `${n.toFixed(n < 1 ? 1 : 0)}%`
}

function money(n: number): string {
  if (!n) return '¥0'
  if (n >= 10000) return `¥${(n / 10000).toFixed(1)}万`
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}
</script>

<style scoped>
.state-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  flex: none;
}

.state-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  text-align: left;
  cursor: pointer;
  min-width: 0;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}

.state-card:hover {
  border-color: var(--el-border-color);
  background: var(--el-fill-color-lighter);
}

/* 选中：主色描边 + 极浅底，不用阴影，避免和旁边卡片抢注意力 */
.state-card.is-active {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
  box-shadow: inset 0 0 0 1px var(--el-color-primary-light-7);
}

.state-card.is-empty {
  opacity: 0.45;
  cursor: not-allowed;
}

.sc-top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.sc-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 2px;
}

.sc-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-share {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.sc-amount {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sc-meta {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 1080px) {
  .state-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
