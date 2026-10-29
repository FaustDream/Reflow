<template>
  <el-dialog v-model="visible" title="抓取通道（MITM）" width="640px" @open="refresh">
    <div class="warn-box">
      <b>开启后会修改系统代理，并安装一张仅本机信任的根证书。</b>
      证书只装在「当前用户」存储（不需要管理员），只解密下列订单域名；
      其它网站的流量一律隧道透传、不解密不记录。关闭应用或点「关闭并还原」会自动恢复。
    </div>

    <div class="rows">
      <div class="row">
        <span class="label">通道状态</span>
        <el-tag :type="status?.running ? 'success' : 'info'" size="small" effect="plain">
          {{ status?.running ? `运行中 · 127.0.0.1:${status.port}` : '已关闭（用 WebView 注入通道）' }}
        </el-tag>
      </div>
      <div class="row">
        <span class="label">根证书</span>
        <el-tag :type="status?.certInstalled ? 'success' : 'warning'" size="small" effect="plain">
          {{ status?.certInstalled ? '已安装（当前用户）' : '未安装' }}
        </el-tag>
      </div>
      <div class="row">
        <span class="label">系统代理</span>
        <span class="value">
          {{ status?.systemProxy.enabled ? `已启用 · ${status.systemProxy.server || '—'}` : '未启用' }}
        </span>
      </div>
      <div v-if="status?.running" class="row">
        <span class="label">本次会话</span>
        <span class="value">
          解密 {{ status.stats.intercepted }} 个连接 · 命中订单接口 {{ status.stats.captured }} 次
        </span>
      </div>
      <div v-if="selftest" class="row">
        <span class="label">自测结果</span>
        <span class="value" :class="{ muted: !selftest.ok }">{{ selftest.text }}</span>
      </div>
      <div v-if="status?.lastError" class="row">
        <span class="label">最近消息</span>
        <span class="value muted">{{ status.lastError }}</span>
      </div>
    </div>

    <div class="section-title">解密域名白名单（{{ status?.whitelist.length ?? 0 }}）</div>
    <div class="hosts">
      <el-tag v-for="h in status?.whitelist ?? []" :key="h" size="small" effect="plain" class="host">
        {{ h }}
      </el-tag>
    </div>

    <template #footer>
      <div class="footer">
        <el-button v-if="!status?.certInstalled" size="small" @click="onInstallCert">安装证书</el-button>
        <el-button
          v-else-if="!status?.running"
          size="small"
          text
          type="danger"
          @click="onRemoveCert"
        >
          卸载证书
        </el-button>
        <el-button size="small" text @click="onSelftest" :loading="testing">测试通道</el-button>
        <div class="spacer" />
        <el-button v-if="status?.running" size="small" @click="onDisable">关闭并还原</el-button>
        <el-button
          v-else
          size="small"
          type="primary"
          :disabled="!status?.certInstalled"
          @click="onEnable"
        >
          开启 MITM 抓取
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 工单 034：MITM 通道设置。
 *
 * 设计原则：把「会改什么、能还原、只解密哪些域名」写在最显眼的位置。
 * 未装证书时「开启」按钮不可点 —— 避免开了代理却没有证书，导致整机 HTTPS 报错。
 */
import { onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MitmStatus } from '@shared/types'

const visible = defineModel<boolean>({ required: true })
const status = ref<MitmStatus | null>(null)
const busy = ref(false)
const testing = ref(false)
const selftest = ref<{ ok: boolean; text: string } | null>(null)

async function refresh(): Promise<void> {
  try {
    status.value = await window.api.getMitmStatus()
  } catch {
    status.value = null
  }
}

let timer: ReturnType<typeof setInterval> | null = null
timer = setInterval(() => {
  if (visible.value && !busy.value) void refresh()
}, 2000)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/** 自测：只在本机起临时代理走一遍，不碰系统设置 */
async function onSelftest(): Promise<void> {
  testing.value = true
  try {
    const r = await window.api.selftestMitm()
    selftest.value = r.ok
      ? {
          ok: true,
          text: `链路正常（HTTP ${r.status ?? '?'}，命中订单接口 ${r.captured ?? 0} 次）`
        }
      : { ok: false, text: r.message ?? '自测失败' }
  } finally {
    testing.value = false
  }
}

async function onInstallCert(): Promise<void> {
  busy.value = true
  try {
    const r = await window.api.installMitmCert()
    if (r.ok) ElMessage.success('证书已安装到「当前用户/受信任的根证书颁发机构」')
    else ElMessage.error(r.message ?? '安装失败')
  } finally {
    busy.value = false
    await refresh()
  }
}

async function onRemoveCert(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '卸载后，之前通过 MITM 抓到的页面会提示证书不受信任（关掉 MITM 就恢复正常）。确定卸载？',
      '卸载根证书',
      { type: 'warning', confirmButtonText: '卸载', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busy.value = true
  try {
    await window.api.removeMitmCert()
    ElMessage.success('证书已卸载')
  } finally {
    busy.value = false
    await refresh()
  }
}

async function onEnable(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '即将：① 把系统代理指向本机 127.0.0.1:' +
        (status.value?.port ?? 8899) +
        '；② 开始解密订单域名的 HTTPS 流量。\n\n关闭应用或点「关闭并还原」会自动恢复系统代理。',
      '开启 MITM 抓取',
      { type: 'warning', confirmButtonText: '开启', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busy.value = true
  try {
    const r = await window.api.enableMitm()
    if (r.ok) ElMessage.success('MITM 通道已开启')
    else ElMessage.error(r.message ?? '开启失败')
  } finally {
    busy.value = false
    await refresh()
  }
}

async function onDisable(): Promise<void> {
  busy.value = true
  try {
    await window.api.disableMitm()
    ElMessage.success('已关闭并还原系统代理')
  } finally {
    busy.value = false
    await refresh()
  }
}
</script>

<style scoped>
.warn-box {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 12px;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.label {
  width: 72px;
  flex: none;
  color: var(--el-text-color-secondary);
}

.value {
  color: var(--el-text-color-primary);
}

.value.muted {
  color: var(--el-text-color-placeholder);
}

.section-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.hosts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.host {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}

.footer {
  display: flex;
  align-items: center;
}

.spacer {
  flex: 1;
}
</style>
