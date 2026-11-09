// Web 调试模式（浏览器打开 vite dev server）：window.api 不存在时由本模块装上
// HTTP/SSE 桥。必须在所有业务 import 之前 —— 它决定 stores 拿到的是哪个 api。
import './web-api'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'

// 工单 028：Element Plus **按需引入**。
// 组件与样式由 electron.vite.config.ts 里的 unplugin-vue-components / unplugin-auto-import
// 按实际使用情况自动注入；不再 `use(ElementPlus)` 整包注册，也不再引整包 CSS。
// 中文 locale 由 App.vue 的 <el-config-provider :locale="zhCn"> 提供。

// ⚠️ 工单 042：JS API 调用的组件不走模板编译，unplugin 系列不会为它们引入样式——
// 必须手动引，否则 ElMessageBox（确定窗口）没有定位/遮罩样式、贴在左上角，
// ElNotification/ElMessage/v-loading 同理（2026-11-01 用户实测确认全部烂掉）。
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/notification/style/css'
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/overlay/style/css'

createApp(App).use(createPinia()).mount('#app')
