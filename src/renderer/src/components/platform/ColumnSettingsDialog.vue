<template>
  <el-dialog
    v-model="visible"
    title="列顺序"
    width="420px"
    append-to-body
    @open="onOpen"
  >
    <p class="col-hint">
      拖动左侧手柄调整顺序，也可以用右侧箭头逐格移动。顺序对所有平台统一生效，保存后自动记住。
    </p>

    <ul class="col-list">
      <li
        v-for="(key, index) in draft"
        :key="key"
        class="col-item"
        :class="{
          'is-dragging': dragIndex === index,
          'is-over': overIndex === index && dragIndex !== index
        }"
        draggable="true"
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent="onDragOver(index)"
        @dragleave="onDragLeave(index)"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <el-icon class="col-grip"><DragHandle /></el-icon>
        <span class="col-name">{{ COLUMN_LABELS[key] }}</span>
        <span class="col-index">{{ index + 1 }}</span>
        <el-button
          link
          size="small"
          title="上移"
          :disabled="index === 0"
          @click="moveBy(index, -1)"
        >
          <el-icon><ArrowUp /></el-icon>
        </el-button>
        <el-button
          link
          size="small"
          title="下移"
          :disabled="index === draft.length - 1"
          @click="moveBy(index, 1)"
        >
          <el-icon><ArrowDown /></el-icon>
        </el-button>
      </li>
    </ul>

    <template #footer>
      <div class="col-footer">
        <el-button link :disabled="isDraftDefault" @click="restoreDefault">恢复默认</el-button>
        <div class="spacer" />
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowUp, DragHandle } from '../icons'
import { useColumnOrder } from '@renderer/composables/useColumnOrder'
import {
  COLUMN_LABELS,
  DEFAULT_COLUMN_ORDER,
  isSameColumnOrder,
  moveColumn,
  moveColumnByKey,
  type TableColumnKey
} from '@renderer/utils/column-order'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const { order, setOrder } = useColumnOrder()

/** 草稿：面板里的改动不立刻生效，点「保存」才落盘 —— 避免拖错一次就改掉真实顺序 */
const draft = ref<TableColumnKey[]>([...order.value])
const isDraftDefault = computed(() => isSameColumnOrder(draft.value, DEFAULT_COLUMN_ORDER))

const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

/** 每次打开都从已保存的顺序重建草稿（上次点了取消的改动不该留下来） */
function onOpen(): void {
  draft.value = [...order.value]
  dragIndex.value = null
  overIndex.value = null
}

function moveBy(index: number, delta: number): void {
  const key = draft.value[index]
  if (!key) return
  draft.value = moveColumnByKey(draft.value, key, delta)
}

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox 不设 data 就不会触发 drag
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(index: number): void {
  if (dragIndex.value !== null) overIndex.value = index
}

function onDragLeave(index: number): void {
  if (overIndex.value === index) overIndex.value = null
}

function onDrop(index: number): void {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  draft.value = moveColumn(draft.value, from, index)
}

function onDragEnd(): void {
  dragIndex.value = null
  overIndex.value = null
}

function restoreDefault(): void {
  draft.value = [...DEFAULT_COLUMN_ORDER]
}

function save(): void {
  setOrder(draft.value)
  visible.value = false
  ElMessage.success('列顺序已保存')
}
</script>

<style scoped>
.col-hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.col-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
}

.col-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 10px;
  height: 38px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: grab;
  transition: background-color 0.15s, box-shadow 0.15s;
}

.col-item:last-child {
  border-bottom: none;
}

.col-item:hover {
  background: var(--el-fill-color-light);
}

.col-item.is-dragging {
  opacity: 0.45;
  cursor: grabbing;
}

/* 落点提示：顶部一条主色线，比整行高亮更不容易看错位置 */
.col-item.is-over {
  box-shadow: inset 0 2px 0 var(--el-color-primary);
}

.col-grip {
  color: var(--el-text-color-placeholder);
  flex: none;
}

.col-name {
  flex: 1;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.col-index {
  min-width: 18px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  text-align: right;
}

.col-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.col-footer .spacer {
  flex: 1;
}
</style>
