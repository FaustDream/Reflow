/**
 * macOS 未签名兜底：给 .app 做 ad-hoc 签名（`codesign -s -`）。
 *
 * 为什么需要：
 * - Apple Silicon（arm64）上，内核要求所有可执行文件至少有 ad-hoc 签名，
 *   完全没签名的 .app 打开会直接报「应用已损坏，移到废纸篓」
 * - 我们没有 Apple 开发者证书（$99/年），electron-builder 在 `identity: null` 时
 *   直接跳过签名，产出的包就是「未签名」状态
 *
 * ad-hoc 签名解决的是「能不能启动」；Gatekeeper 的「无法验证开发者」仍然存在，
 * 首次打开需要右键 →「打开」，或 `xattr -dr com.apple.quarantine` 去掉隔离标记。
 * 等有证书了把 electron-builder.yml 里的 `identity: null` 删掉即可，本钩子自动让位。
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // 已经有正式证书签名时不要再动它
  const identity = context.packager.platformSpecificBuildOptions?.identity
  if (identity !== null && identity !== undefined) return

  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`[mac] ad-hoc 签名完成：${appPath}`)
}
