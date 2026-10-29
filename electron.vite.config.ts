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
      AutoImport({
        resolvers: [ElementPlusResolver()],
        dts: 'src/renderer/src/auto-imports.d.ts'
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: 'src/renderer/src/components.d.ts'
      })
    ],
    build: {
      // 决策 D-3 / 028：生产构建不产出 sourcemap，避免体积膨胀与源码泄露
      sourcemap: false,
      minify: 'esbuild'
    }
  }
})
