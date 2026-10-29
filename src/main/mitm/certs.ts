/**
 * 内置 MITM 证书的读取（构建期由 `scripts/gen-mitm-certs.mjs` 生成）。
 *
 * 为什么预生成：运行时生成需要 node-forge 之类的库；白名单固定，
 * 一张 SAN 覆盖全部域名的叶子证书就够，随包分发即可。
 *
 * 路径说明：`resources/**` 被打进 app.asar，`fs.readFileSync` 可直接读；
 * 开发态 `app.getAppPath()` 就是项目根目录，两种形态同一套路径。
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MitmCerts {
  caPath: string
  cert: Buffer
  key: Buffer
}

/**
 * 证书目录。三种运行形态都要能命中：
 * - 开发（electron-vite）：`__dirname` = `<项目>/out/main` → `../../resources/mitm`
 * - 打包：`__dirname` = `app.asar/out/main` → `app.asar/resources/mitm`
 * - 自检脚本 require 主进程 bundle：同上（`__dirname` 仍指向 out/main）
 * 兜底再试 `app.getAppPath()`（某些启动方式下 __dirname 会被改写）。
 */
export function certDir(): string {
  const candidates = [
    join(__dirname, '../../resources/mitm'),
    join(app.getAppPath(), 'resources/mitm')
  ]
  return candidates.find((dir) => existsSync(join(dir, 'leaf.crt'))) ?? candidates[0]
}

export function caCertPath(): string {
  return join(certDir(), 'ca.crt')
}

/** 读取代理握手用的证书；缺失时抛错（提示重新生成） */
export function loadCerts(): MitmCerts {
  const dir = certDir()
  try {
    return {
      caPath: join(dir, 'ca.crt'),
      cert: readFileSync(join(dir, 'leaf.crt')),
      key: readFileSync(join(dir, 'leaf.key'))
    }
  } catch (err) {
    throw new Error(
      `MITM 证书缺失（${dir}）：请运行 node scripts/gen-mitm-certs.mjs 重新生成。` +
        (err instanceof Error ? ` 原因：${err.message}` : '')
    )
  }
}
