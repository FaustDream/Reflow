<template>
  <el-dialog
    v-model="visible"
    title="关于"
    width="420px"
    align-center
    class="about-dialog"
    @closed="onClosed"
  >
    <div class="about">
      <div class="brand">
        <img class="logo" src="@renderer/assets/logo.png" alt="" @error="logoBroken = true" v-if="!logoBroken" />
        <div v-else class="logo-fallback">{{ APP_NAME }}</div>
        <div class="titles">
          <div class="name">{{ APP_NAME_CN }} {{ APP_NAME }}</div>
          <div class="ver">v{{ version }}</div>
        </div>
      </div>

      <p class="desc">把散落在各电商平台的订单数据，回流到你自己手上。</p>

      <div class="rows">
        <div class="row">
          <span class="k">作者</span>
          <span class="v">{{ AUTHOR }}</span>
        </div>
        <div class="row">
          <span class="k">项目主页</span>
          <span class="v link" @click="openRepo">{{ REPO_URL.replace('https://', '') }}</span>
        </div>
        <div class="row">
          <span class="k">数据存放</span>
          <span class="v">仅本机，不上传任何服务器</span>
        </div>
      </div>

      <div class="notice">
        <p>本软件可自由使用与修改。<strong>请勿去除作者标识后二次分发</strong>，也请勿用于商业售卖。</p>
        <p class="copyright">© {{ year }} {{ AUTHOR }} · 保留署名权</p>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { APP_NAME, APP_NAME_CN, AUTHOR, REPO_URL } from '@shared/app-meta'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = ref(props.modelValue)
const version = ref('—')
const logoBroken = ref(false)
const year = new Date().getFullYear()

watch(
  () => props.modelValue,
  (v) => {
    visible.value = v
  }
)
watch(visible, (v) => emit('update:modelValue', v))

// 打开时再取版本：避免和状态栏重复请求
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    try {
      const info = await window.api.getAppInfo()
      version.value = info.version
    } catch {
      version.value = '—'
    }
  },
  { immediate: true }
)

function openRepo(): void {
  window.open(REPO_URL, '_blank')
}

function onClosed(): void {
  logoBroken.value = false
}
</script>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  object-fit: contain;
}

.logo-fallback {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #5aa0ff, #1b3fc4);
}

.titles .name {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.titles .ver {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.desc {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.row {
  display: flex;
  gap: 12px;
  font-size: 12px;
  line-height: 1.5;
}

.row .k {
  flex: 0 0 56px;
  color: var(--el-text-color-secondary);
}

.row .v {
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.row .link {
  color: var(--el-color-primary);
  cursor: pointer;
}

.row .link:hover {
  text-decoration: underline;
}

.notice {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
}

.notice p {
  margin: 0;
}

.notice strong {
  color: var(--el-text-color-regular);
}

.copyright {
  margin-top: 6px;
  color: var(--el-text-color-placeholder);
}
</style>
