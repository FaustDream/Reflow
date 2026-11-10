#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出指定版本的段落，拼成 GitHub Release 的说明正文。
 *
 * 用法：node scripts/release-notes.mjs 1.0.0 > release-notes.md
 *
 * 发版说明只该有一个来源（CHANGELOG），Release 页面不再另写一份，
 * 否则两边必然漂移。这里只做「截取 + 补下载说明」，不加工正文。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = (process.argv[2] || '').replace(/^v/, '')

if (!version) {
  console.error('用法：node scripts/release-notes.mjs <version>，例如 1.0.0')
  process.exit(1)
}

const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8').split(/\r?\n/)

// 标题形如 `## [1.0.0] - 2026-11-10`；负向断言避免 1.0 命中 1.0.0
const heading = new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?(?![\\d.])`)
const start = lines.findIndex((line) => heading.test(line))

if (start === -1) {
  console.error(`CHANGELOG.md 里找不到 ${version} 的段落（应形如 "## [${version}] - YYYY-MM-DD"）`)
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}

const section = lines.slice(start, end).join('\n').trim()
// 正文里的二级标题降为三级，并去掉版本号外面的方括号，避免与 Release 页面排版打架
const body = section.replace(/^##\s+(.*)$/m, (_, title) => `### ${title.replace(/^\[([^\]]+)\]/, '$1')}`)

process.stdout.write(`${body}

### 下载哪个

| 你的系统 | 选这个 |
|---|---|
| Windows 10/11 | \`Reflow-${version}-win-x64.exe\`（安装包）或 \`Reflow-${version}-portable.exe\`（免安装） |
| macOS（Apple Silicon） | \`Reflow-${version}-mac-arm64.dmg\` |
| macOS（Intel） | \`Reflow-${version}-mac-x64.dmg\` |
| Linux（Debian / Ubuntu） | \`Reflow-${version}-linux-*.deb\` |
| Linux（通用） | \`Reflow-${version}-linux-*.AppImage\`（chmod +x 后直接运行） |

校验完整性：下载目录里附有 \`SHA256SUMS.txt\`，Windows 上 \`certutil -hashfile <文件> SHA256\` 即可比对。

> 安装包未做代码签名，Windows SmartScreen 与 macOS Gatekeeper 会拦一次：
> Windows 点「更多信息 → 仍要运行」；macOS 右键「打开」，或
> \`xattr -dr com.apple.quarantine "/Applications/Reflow.app"\`。
`)
