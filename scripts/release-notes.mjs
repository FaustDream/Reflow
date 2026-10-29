#!/usr/bin/env node
/**
 * 从 docs/CHANGELOG.md 里抽出指定版本的段落，拼成 GitHub Release 的说明正文。
 *
 * 用法：node scripts/release-notes.mjs 0.2.0 > release-notes.md
 *
 * 为什么要脚本：发版说明只该有一个来源（CHANGELOG），Release 页面不该另写一份，
 * 否则两边必然漂移。这里只做「截取 + 补下载说明」，不加工正文。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = (process.argv[2] || '').replace(/^v/, '')

if (!version) {
  console.error('用法：node scripts/release-notes.mjs <version>，例如 0.2.0')
  process.exit(1)
}

const md = readFileSync(join(ROOT, 'docs', 'CHANGELOG.md'), 'utf-8')
const lines = md.split(/\r?\n/)

// 标题形如 `## 0.2.0（2026-10-29）`；用 \b 边界避免 0.2 匹配到 0.2.0
const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(?![\\d.])`)
const start = lines.findIndex((line) => heading.test(line))

if (start === -1) {
  console.error(`CHANGELOG.md 里找不到版本 ${version} 的段落（应形如 "## ${version}（YYYY-MM-DD）"）`)
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

// 正文里的一级标题降为三级，避免和 Release 页面的排版打架
const body = section.replace(/^##\s+(.*)$/m, '### $1')

process.stdout.write(`${body}

---

### 下载哪个

| 你的系统 | 选这个 |
|---|---|
| Windows 10/11 | \`回流 Reflow-${version}-win-x64.exe\`（安装包）或 \`-portable.exe\`（免安装） |
| macOS（Apple Silicon / M 系列） | \`回流 Reflow-${version}-mac-arm64.dmg\` |
| macOS（Intel） | \`回流 Reflow-${version}-mac-x64.dmg\` |
| Linux（Debian/Ubuntu） | \`回流 Reflow-${version}-linux-amd64.deb\` |
| Linux（通用便携） | \`回流 Reflow-${version}-linux-x86_64.AppImage\` 或 \`-linux-x64.tar.gz\` |

### 安装提示

- **未做代码签名**：Windows 首次运行会弹 SmartScreen「Windows 已保护你的电脑」→ 更多信息 → 仍要运行；
  macOS 首次打开要右键 →「打开」，或执行 \`xattr -dr com.apple.quarantine "/Applications/回流 Reflow.app"\`
- **Linux 沙箱**：若提示 \`The SUID sandbox helper binary was found, but is not configured correctly\`，
  用 \`--no-sandbox\` 启动（Ubuntu 23.10+ 默认禁用非特权 user namespace）
- 校验值见同页的 \`SHA256SUMS.txt\`
`)
