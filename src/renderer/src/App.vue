<template>
  <el-config-provider :locale="zhCn">
    <!-- 工单 024：首次启动显示引导（完成后不再出现） -->
    <OnboardingView v-if="showOnboarding" @done="onOnboardingDone" />
    <SimpleLayout v-else :only-platforms="favoritePlatforms" />
  </el-config-provider>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import OnboardingView from '@renderer/components/layout/OnboardingView.vue'
import SimpleLayout from '@renderer/components/layout/SimpleLayout.vue'

const showOnboarding = ref(false)
/** 引导里选的常用平台（空 = 全部显示） */
const favoritePlatforms = ref<string[]>([])

onMounted(async () => {
  try {
    const state = await window.api.loadOnboarding()
    favoritePlatforms.value = state.platforms ?? []
    showOnboarding.value = !state.completed
  } catch {
    // 读取失败不阻塞使用：直接进主界面
    showOnboarding.value = false
  }
})

function onOnboardingDone(): void {
  showOnboarding.value = false
  // 重新读取用户刚选的平台
  void window.api
    .loadOnboarding()
    .then((s) => {
      favoritePlatforms.value = s.platforms ?? []
    })
    .catch(() => undefined)
}
</script>
