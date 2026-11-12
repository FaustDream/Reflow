<template>
  <el-dialog
    v-model="visible"
    title="检查更新"
    width="560px"
    align-center
    class="update-dialog"
    @open="run"
    @closed="reset"
  >
    <div class="update">
      <div class="head">
        <img v-if="!logoBroken" class="logo" src="@renderer/assets/logo.png" alt="" @error="logoBroken = true" />
        <div v-else class="logo-fallback">{{ APP_NAME }}</div>
        <div class="head-text">
          <div class="current">当前版本 <b>v{{ result?.current || currentVersion || '—' }}</b></div>
          <div class="state-line">
            <template v-if="status === 'checking'">
              <el-icon class="is-loading"><Loading /></el-icon>
              <span>正在连接 GitHub 查询最新版本…</span>
            </template>
            <template v-else-if="status === 'done' && result?.hasUpdate">
              <span class="badge-new">有新版本</span>
              <span class="version-new">v{{ result.latest }}</span>
              <span v-if="publishedAt" class="published">{{ publishedAt }} 发布</span>
            </template>
            <template v-else-if="status === 'done'">
              <span class="badge-ok">已是最新</span>
              <span class="published">
                最新发布 v{{ result?.latest || '—' }}{{ publishedAt ? ` · ${publishedAt}` : '' }}
              </span>
            </template>
            <template v-else-if="status === 'error'">
              <span class="badge-warn">检查失败</span>
            </template>
          </div>
        </div>
      </div>

      <!--
        有新版：把该版本说明带上，省得用户还要跳到网页才知道改了什么。
        注意「有新版但没有说明」是合法情况（Release 正文可以为空），
        不能落到下面「已是最新」那一支。
      -->
      <div v-if="status === 'done' && result?.hasUpdate" class="update-body">
        <div v-if="result.notes" class="notes">
          <div class="notes-title">这个版本改了什么</div>
          <div class="notes-body markdown" v-html="renderMarkdownLite(result.notes)" />
        </div>
        <p v-else class="ok-text">这个版本没有附说明，点「前往下载」到 Release 页面查看。</p>
      </div>

      <div v-else-if="status === 'error'" class="error">
        <p class="error-text">{{ result?.message || '检查更新失败，请稍后再试。' }}</p>
        <p class="error-hint">
          也可以直接到项目主页的 Release 页面手动查看与下载。
        </p>
      </div>

      <p class="privacy">更新只比对版本号，不会上传任何订单数据。</p>
    </div>

    <template #footer>
      <div class="footer">
        <el-button size="small" text @click="openChangelog">更新记录</el-button>
        <div class="footer-right">
          <el-button v-if="status === 'error'" size="small" @click="openReleases">项目主页</el-button>
          <el-button size="small" :loading="status === 'checking'" @click="run">
            {{ status === 'checking' ? '检查中' : '重新检查' }}
          </el-button>
          <el-button
            v-if="status === 'done' && result?.hasUpdate"
            size="small"
            type="primary"
            @click="openReleases"
          >
            前往下载
          </el-button>
          <el-button v-else size="small" @click="visible = false">关闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 检查更新（2026-11-12）。
 *
 * 只做「有没有新版」：比对 GitHub Release 的最新 tag，有更新就把说明和下载入口摆出来。
 * 不下载、不替换文件 —— 安装包未签名、还有免安装版，静默替换不是这里该做的事
 * （electron-builder.yml 里刻意 publish: null，没有走 electron-updater 的通道）。
 */
import { computed, ref } from 'vue'
import { Loading } from '../icons'
import { APP_NAME } from '@shared/app-meta'
import type { UpdateCheckResult } from '@shared/types'
import { renderMarkdownLite } from '../../utils/markdown-lite'

const emit = defineEmits<{ (e: 'open-changelog'): void }>()
const visible = defineModel<boolean>({ required: true })

const status = ref<'idle' | 'checking' | 'done' | 'error'>('idle')
const result = ref<UpdateCheckResult | null>(null)
const currentVersion = ref('')
const logoBroken = ref(false)
/** 打开期间只保留最后一次检查的结果，避免连续点击时旧结果覆盖新结果 */
let seq = 0

const publishedAt = computed(() => {
  const iso = result.value?.publishedAt
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

async function run(): Promise<void> {
  const mine = ++seq
  status.value = 'checking'
  result.value = null
  try {
    const info = await window.api.getAppInfo()
    currentVersion.value = info.version
  } catch {
    /* 版本号拿不到时，主进程返回的 current 仍可用 */
  }
  try {
    const res = await window.api.checkUpdate()
    if (mine !== seq) return
    result.value = res
    status.value = res.ok ? 'done' : 'error'
  } catch (err) {
    if (mine !== seq) return
    result.value = {
      ok: false,
      current: currentVersion.value,
      message: `检查更新失败：${err instanceof Error ? err.message : String(err)}`
    }
    status.value = 'error'
  }
}

function openReleases(): void {
  const url = result.value?.releaseUrl
  // 只放行 https：releaseUrl 来自主进程，但仍按不可信输入处理
  if (url && /^https:/i.test(url)) window.open(url, '_blank')
}

function openChangelog(): void {
  visible.value = false
  emit('open-changelog')
}

function reset(): void {
  // 关掉就清空：下次打开要显示「正在检查」，而不是上一轮的「已是最新」
  status.value = 'idle'
  result.value = null
  seq += 1
}
</script>

<style scoped>
.update {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  gap: 12px;
  align-items: center;
}

.logo {
  width: 48px;
  height: 48px;
  border-radius: 11px;
  object-fit: contain;
}

.logo-fallback {
  width: 48px;
  height: 48px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #5aa0ff, #1b3fc4);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.current {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.current b {
  color: var(--el-text-color-primary);
}

.state-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.badge-new,
.badge-ok,
.badge-warn {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
}

.badge-new {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.badge-ok {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}

.badge-warn {
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.version-new {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.published {
  color: var(--el-text-color-placeholder);
}

.notes {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.notes-title {
  padding: 7px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}

.notes-body {
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 12px;
}

.error {
  padding: 12px;
  border-radius: 8px;
  background: var(--el-color-warning-light-9);
}

.error-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

.error-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.ok-text {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.privacy {
  margin: 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.notes-body :deep(p) {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

.notes-body :deep(ul),
.notes-body :deep(ol) {
  margin: 0;
  padding-left: 18px;
}

.notes-body :deep(li) {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  margin-bottom: 5px;
}

.notes-body :deep(strong) {
  color: var(--el-text-color-primary);
}

.notes-body :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--el-fill-color);
}

.notes-body :deep(h4),
.notes-body :deep(h5) {
  margin: 8px 0 6px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.footer-right {
  display: inline-flex;
  gap: 8px;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
