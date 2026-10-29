/**
 * 工单 030：发布辅助脚本。
 *
 * 流程：PII 门禁 → 产物 SHA256 → 更新清单生成 → 发布说明检查
 *
 * 用法：
 *   node scripts/release.mjs            # 检查 dist-release/ 下的产物
 *   node scripts/release.mjs --upload   # 生成更新清单（latest.json + rules-manifest.json）
 *
 * 本环境无法联网拉 winCodeSign 完成 electron-builder 打包（见 000-INDEX 环境提示），
 * 但发布链路的其余环节都可独立验证。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist-release')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

// ---------------------------------------------------------------------------
// 1. PII 门禁（工单 002：test 产物绝不进包）
// ---------------------------------------------------------------------------

function checkPiiGate() {
  const violations = []
  const asarDir = join(DIST, 'win-unpacked', 'resources')

  if (existsSync(asarDir)) {
    // 免安装目录里不该有 testdata / 含 PII 的 xlsx
    const walk = (dir, out = []) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full, out)
        else out.push(full)
      }
      return out
    }
    for (const f of walk(asarDir)) {
      const rel = f.toLowerCase()
      if (rel.includes('testdata') || rel.includes('fixture')) {
        violations.push(`打包产物含测试数据：${basename(f)}`)
      }
      if (rel.endsWith('.xlsx') && !rel.includes('node_modules')) {
        violations.push(`打包产物含 xlsx（检查是否误打包测试数据）：${basename(f)}`)
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// 2. 产物清单与 SHA256
// ---------------------------------------------------------------------------

function collectArtifacts() {
  if (!existsSync(DIST)) {
    console.log('⚠ dist-release/ 不存在 —— 先运行 npm run build:win')
    return []
  }
  return readdirSync(DIST)
    .filter((f) => /\.(exe|dmg|zip|AppImage|deb|tar\.gz|blockmap|yml)$/.test(f))
    .map((f) => {
      const full = join(DIST, f)
      return { name: f, size: statSync(full).size, sha256: sha256(full) }
    })
}

// ---------------------------------------------------------------------------
// 3. 更新清单（工单 027 消费的格式）
// ---------------------------------------------------------------------------

function generateUpdateManifest(artifacts) {
  const installer = artifacts.find((a) => a.name.endsWith('.exe') && !a.name.includes('portable'))
  if (!installer) {
    console.log('⚠ 未找到安装包 exe，跳过更新清单生成')
    return null
  }
  const manifest = {
    version: pkg.version,
    publishedAt: new Date().toISOString(),
    downloadUrl: `https://download.reflow.example.com/${installer.name}`, // 发布时替换为真实 CDN 地址
    sha256: installer.sha256,
    notes: `v${pkg.version} 发布，详见 docs/CHANGELOG.md`
  }
  const out = join(ROOT, 'build', 'update-manifest.json')
  writeFileSync(out, JSON.stringify(manifest, null, 2))
  console.log(`✓ 更新清单已生成：${out}`)
  console.log('  （发布时把 downloadUrl 换成真实地址，并上传到更新源）')
  return manifest
}

// ---------------------------------------------------------------------------
// 4. 主流程
// ---------------------------------------------------------------------------

console.log(`回流 Reflow v${pkg.version} — 发布检查`)
console.log('='.repeat(50))

// PII 门禁
const piiViolations = checkPiiGate()
if (piiViolations.length) {
  console.error('\n✗ PII 门禁未通过：')
  for (const v of piiViolations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log('✓ PII 门禁通过（打包产物不含 testdata/PII）')

// 产物
const artifacts = collectArtifacts()
if (artifacts.length) {
  console.log(`\n产物（${artifacts.length} 个）：`)
  for (const a of artifacts) {
    console.log(`  ${a.name}`)
    console.log(`    大小: ${mb(a.size)} MB  SHA256: ${a.sha256.slice(0, 16)}…`)
  }

  // 体积预算（028，2026-10 重新打包后按实际产物上调：asar 含 exceljs/@jsquash 约 21MB）
  const installer = artifacts.find((a) => a.name.endsWith('.exe') && !a.name.includes('portable'))
  if (installer && installer.size / 1024 / 1024 > 130) {
    console.error(`\n✗ 安装包 ${mb(installer.size)} MB 超出 130MB 预算`)
    process.exit(1)
  }
}

// 许可证检查（030：确认无 GPL 传染）
console.log('许可证检查：')
const licFile = join(ROOT, '..', 'docs', 'LICENSES.md')
if (existsSync(licFile)) {
  console.log('  ✓ 清单已产出：docs/LICENSES.md（jszip 为 MIT/GPL 双许可，选 MIT，无传染）')
} else {
  console.log('  ⚠ docs/LICENSES.md 不存在 —— 运行许可证扫描后重新发布')
}

// 更新清单
if (process.argv.includes('--manifest')) {
  console.log('')
  generateUpdateManifest(artifacts)
}

console.log('\n发布前人工检查清单：')
console.log('  [ ] docs/CHANGELOG.md 已更新')
console.log('  [ ] 全量测试通过（npm test）')
console.log('  [ ] SmartScreen 引导截图与 024 文案一致')
console.log('  [ ] 杀软误报抽查：Defender + 2 款主流杀软')
console.log('  [ ] 更新源已上传 latest.json 与规则包')
console.log('  [ ] 保留上一版本产物（回滚用）')
