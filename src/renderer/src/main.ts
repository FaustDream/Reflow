import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'

// 工单 028：Element Plus **按需引入**。
// 组件与样式由 electron.vite.config.ts 里的 unplugin-vue-components / unplugin-auto-import
// 按实际使用情况自动注入；不再 `use(ElementPlus)` 整包注册，也不再引整包 CSS。
// 中文 locale 由 App.vue 的 <el-config-provider :locale="zhCn"> 提供。
createApp(App).use(createPinia()).mount('#app')
