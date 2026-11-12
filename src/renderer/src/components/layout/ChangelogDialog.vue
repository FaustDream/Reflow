<template>
  <el-dialog
    v-model="visible"
    title="更新记录"
    width="880px"
    top="6vh"
    class="changelog-dialog"
    @open="load"
  >
    <div v-if="releases.length" class="changelog">
      <!--
        左侧版本列表、右侧正文：CHANGELOG 有 7 个版本、上千字，
        一条条堆叠要滚很久才能翻到旧版本。
      -->
      <aside class="versions">
        <div
          v-for="item in releases"
          :key="item.version"
          class="version-item"
          :class="{ active: item.version === activeVersion }"
          role="button"
          tabindex="0"
          @click="activeVersion = item.version"
          @keydown.enter="activeVersion = item.version"
        >
          <span class="version-no">v{{ item.version }}</span>
          <span v-if="item.version === currentVersion" class="version-tag">当前</span>
          <span class="version-date">{{ item.date || '—' }}</span>
        </div>
      </aside>

      <section ref="bodyRef" class="entries">
        <div v-if="activeRelease" class="entry">
          <div class="entry-head">
            <span class="entry-version">v{{ activeRelease.version }}</span>
            <span class="entry-date">{{ activeRelease.date }}</span>
            <span v-if="activeRelease.version === currentVersion" class="entry-current">你正在用这个版本</span>
          </div>
          <div
            v-for="(section, index) in activeRelease.sections"
            :key="index"
            class="section"
          >
            <h4 v-if="section.title" class="section-title">{{ section.title }}</h4>
            <div class="markdown" v-html="renderMarkdownLite(section.body)" />
          </div>
        </div>
      </section>
    </div>

    <el-empty v-else-if="loaded" description="没读到更新记录（当前安装包可能未包含 CHANGELOG）" :image-size="70" />
    <div v-else class="loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在读取更新记录…</span>
    </div>

    <template #footer>
      <el-button size="small" text @click="openRepo">项目主页</el-button>
      <el-button size="small" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 更新记录（2026-11-12）。
 *
 * 数据来自随包的 CHANGELOG.md（主进程解析成结构化段落），与 GitHub Release 的说明正文
 * 同源 —— 界面上不再维护第二份「更新了什么」的文案。
 */
import { computed, nextTick, ref } from 'vue'
import { Loading } from '../icons'
import { REPO_URL } from '@shared/app-meta'
import type { ChangelogRelease } from '@shared/types'
import { renderMarkdownLite } from '../../utils/markdown-lite'

const visible = defineModel<boolean>({ required: true })
const releases = ref<ChangelogRelease[]>([])
const loaded = ref(false)
const activeVersion = ref('')
const currentVersion = ref('')
const bodyRef = ref<HTMLElement | null>(null)

const activeRelease = computed(() => releases.value.find((r) => r.version === activeVersion.value))

async function load(): Promise<void> {
  loaded.value = false
  try {
    const info = await window.api.getAppInfo()
    currentVersion.value = info.version
  } catch {
    currentVersion.value = ''
  }
  try {
    releases.value = await window.api.getChangelog()
  } catch {
    releases.value = []
  }
  // 默认停在当前版本：用户通常关心「我这个版本改了什么」
  const preferred =
    releases.value.find((r) => r.version === currentVersion.value) ?? releases.value[0]
  activeVersion.value = preferred?.version ?? ''
  loaded.value = true
  await nextTick()
  if (bodyRef.value) bodyRef.value.scrollTop = 0
}

function openRepo(): void {
  window.open(`${REPO_URL}#readme`, '_blank')
}
</script>

<style scoped>
.changelog {
  display: flex;
  gap: 16px;
  height: 62vh;
  min-height: 320px;
}

.versions {
  flex: 0 0 158px;
  overflow-y: auto;
  border-right: 1px solid var(--el-border-color-lighter);
  padding-right: 8px;
}

.version-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}

.version-item:hover {
  background: var(--el-fill-color-lighter);
}

.version-item.active {
  background: var(--el-color-primary-light-9);
}

.version-no {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.version-item.active .version-no {
  color: var(--el-color-primary);
}

.version-tag {
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-8);
}

.version-date {
  flex: 0 0 100%;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.entries {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
}

.entry-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.entry-version {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.entry-date {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.entry-current {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-color-primary);
}

.section + .section {
  margin-top: 18px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

/* v-html 内容没有 scoped 属性，用 :deep 落样式 */
.markdown :deep(p) {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--el-text-color-regular);
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0;
  padding-left: 20px;
}

.markdown :deep(li) {
  font-size: 13px;
  line-height: 1.75;
  color: var(--el-text-color-regular);
  margin-bottom: 6px;
}

.markdown :deep(li > ul),
.markdown :deep(li > ol) {
  margin-top: 6px;
}

.markdown :deep(strong) {
  color: var(--el-text-color-primary);
  font-weight: 600;
}

.markdown :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.markdown :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.markdown :deep(a:hover) {
  text-decoration: underline;
}

.markdown :deep(table) {
  border-collapse: collapse;
  margin: 4px 0 10px;
  font-size: 12px;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--el-border-color-lighter);
  padding: 4px 10px;
  text-align: left;
  color: var(--el-text-color-regular);
}

.markdown :deep(th) {
  background: var(--el-fill-color-lighter);
  font-weight: 600;
}

.markdown :deep(blockquote) {
  margin: 6px 0;
  padding: 6px 10px;
  border-left: 3px solid var(--el-border-color);
  background: var(--el-fill-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.markdown :deep(h4),
.markdown :deep(h5) {
  margin: 10px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 200px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
