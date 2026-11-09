import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 构建时注入应用版本号（dev 下 app.getVersion() 返回 Electron 的版本而非应用的）
const APP_VERSION: string = JSON.parse(readFileSync('package.json', 'utf-8')).version
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // 两个 preload：index（主窗口桥）与 inject（平台 webview 注入桥，工单 004）
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          inject: resolve('src/preload/inject.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // Electron 的 <webview> 是自定义元素，交给运行时而非 Vue 解析
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      }),
      // 工单 028：Element Plus 按需引入。
      // 整包引入时 renderer 为 JS 1.03MB + CSS 367KB；按需后只打包实际用到的组件与样式。
      // ⚠ unplugin 的 dts 相对 renderer root（src/renderer/）解析：写成项目根路径
      // 会把声明文件生成到 src/renderer/src/renderer/（2026-11-08 已纠正的历史坑）。
      AutoImport({
        resolvers: [ElementPlusResolver()],
        dts: 'src/auto-imports.d.ts'
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: 'src/components.d.ts'
      })
    ],
    build: {
      // 决策 D-3 / 028：生产构建不产出 sourcemap，避免体积膨胀与源码泄露
      sourcemap: false,
      minify: 'esbuild'
    },
    /**
     * dev 首屏预热（2026-11-02 启动优化）。
     *
     * 默认情况下 vite 要等**浏览器请求到某个模块**才开始 transform 它 —— 首屏那条
     * main.ts → App.vue → SimpleLayout.vue → 各 Element Plus 组件的链子就一个接一个地
     * 现场编译，界面自然白得久。这里让 dev server 起来后先在后台把这几个入口链
     * 编译好，浏览器连上来时直接命中缓存。
     *
     * 只列入口文件，不列具体组件：链上的组件由 vite 自己顺着 import 走。
     */
    server: {
      // 路径相对 renderer root（src/renderer/），写全前缀会在 dev 启动时报 Pre-transform error
      warmup: {
        clientFiles: [
          'src/main.ts',
          'src/App.vue',
          'src/components/layout/SimpleLayout.vue',
          'src/components/overview/OverviewPane.vue'
        ]
      },
      // Web 调试模式（npm run dev:web）：浏览器打开本 dev server，
      // /api/* 由 vite 代理到主进程的 web-bridge（127.0.0.1:9478，见 src/main/web-bridge.ts）。
      // Electron 窗口内的渲染层不走这些路径，仅浏览器访问；生产构建不受影响。
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:9478',
          changeOrigin: true
        }
      }
    }
  }
})
