<template>
  <div class="onboarding">
    <div class="card">
      <h2 class="title">欢迎使用 回流 Reflow</h2>
      <p class="lead">把散落在各平台的订单，回流到你自己手上。</p>

      <div class="points">
        <div class="point">
          <span class="num">1</span>
          <div>
            <b>数据只在你本机</b>
            <p>应用内嵌浏览器，你登录自己的账号后，订单只在本机读取和导出，<b>不上传任何服务器</b>。</p>
          </div>
        </div>
        <div class="point">
          <span class="num">2</span>
          <div>
            <b>不需要证书，也不需要管理员权限</b>
            <p>不会修改系统代理、不会安装根证书、不会索取系统密码。</p>
          </div>
        </div>
        <div class="point">
          <span class="num">3</span>
          <div>
            <b>首次运行可能遇到 Windows 提示</b>
            <p>
              本应用未做代码签名。若出现「Windows 已保护你的电脑」，
              点 <b>更多信息</b> → <b>仍要运行</b> 即可。这不影响数据安全。
            </p>
          </div>
        </div>
      </div>

      <div class="platforms">
        <div class="section-title">选择常用平台（只影响左侧列表显示，可随时改）</div>
        <div class="chips">
          <button
            v-for="p in allPlatforms"
            :key="p.id"
            type="button"
            class="chip"
            :class="{ on: selected.includes(p.id) }"
            @click="toggle(p.id)"
          >
            {{ p.displayName }}
          </button>
        </div>
        <div class="hint">
          {{ selected.length ? `已选 ${selected.length} 个平台` : '不选 = 显示全部平台' }}
        </div>
      </div>

      <div class="actions">
        <el-button text @click="finish([])">跳过</el-button>
        <el-button type="primary" @click="finish(selected)">开始使用</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { isHiddenPlatform } from '@shared/platform-visibility'

const emit = defineEmits<{ (e: 'done'): void }>()

const allPlatforms = ref<Array<{ id: string; displayName: string }>>([])
const selected = ref<string[]>([])

function toggle(id: string): void {
  const at = selected.value.indexOf(id)
  if (at >= 0) selected.value.splice(at, 1)
  else selected.value.push(id)
}

async function finish(platforms: string[]): Promise<void> {
  // ⚠ 必须转成普通数组：Vue 的 reactive 数组是 Proxy，Electron IPC 的
  // structured clone 无法序列化 Proxy，会抛「An object could not be cloned」。
  const plain = [...platforms]
  try {
    await window.api.completeOnboarding(plain)
  } catch (e) {
    // 写入失败也要放行，不能让用户卡在引导页
    console.error('保存引导状态失败', e)
  }
  emit('done')
}

onMounted(async () => {
  const list = await window.api.getAdapters().catch(() => [])
  // 用统一的可见性表，别再手写一份 id 清单（否则下架平台会漏在这里）
  allPlatforms.value = list
    .filter((a) => !isHiddenPlatform(a.id))
    .map((a) => ({ id: a.id, displayName: a.displayName }))
})
</script>

<style scoped>
.onboarding {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color-page);
  overflow-y: auto;
  padding: 24px;
}

.card {
  width: 560px;
  max-width: 100%;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  padding: 28px 30px 22px;
  box-shadow: var(--el-box-shadow-light);
}

.title {
  margin: 0 0 6px;
  font-size: 20px;
}

.lead {
  margin: 0 0 22px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.points {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.point {
  display: flex;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
}

.point p {
  margin: 2px 0 0;
  color: var(--el-text-color-secondary);
}

.num {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}

.platforms {
  margin-top: 22px;
}

.section-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 5px 12px;
  border-radius: 14px;
  border: 1px solid var(--el-border-color);
  background: transparent;
  font-size: 12px;
  color: var(--el-text-color-primary);
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover {
  border-color: var(--el-color-primary-light-5);
}

.chip.on {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}
</style>
