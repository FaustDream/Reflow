// 工单 001 验收项：记录产物体积与 SHA256，作为工单 028 体积优化的基线与防退化依据。
//
// 预算依据（实测修正）：Electron 44 空壳骨架 win-unpacked 即约 320MB，
// 故 028 原定「安装后 ≤250MB」不成立，详见本脚本输出的 baseline 说明。
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'

const ROOT = process.cwd()
// 可用 REFLOW_RELEASE_DIR 覆盖输出目录：Windows 上 Defender 扫描新生成的 app.asar
// 会导致目录被锁（EBUSY），此时换个目录构建即可绕开，无需等待或强杀进程。
const RELEASE_DIR = join(ROOT, process.env.REFLOW_RELEASE_DIR || 'dist-release')
const UNPACKED_DIR = join(RELEASE_DIR, 'win-unpacked')
const OUT_FILE = join(ROOT, 'build', 'artifacts.json')

// 预算（工单 028）。installerMb 针对 NSIS 安装包；installedMb 针对 win-unpacked 总大小。
const BUDGET = { installerMb: 110, installedMb: 340 }

async function walk(dir) {
  const out = []
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    const full = join(dir, item.name)
    if (item.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const mb = (bytes) => Number((bytes / 1024 / 1024).toFixed(2))

async function dirSize(dir) {
  let total = 0
  for (const f of await walk(dir)) total += (await stat(f)).size
  return total
}

// 安装包 = dist-release 顶层的分发文件；win-unpacked 内的 exe 是应用本体，不是安装包
const topLevel = (await readdir(RELEASE_DIR, { withFileTypes: true })).filter((e) => e.isFile())
const installers = topLevel
  .map((e) => join(RELEASE_DIR, e.name))
  .filter((f) => /\.(exe|zip|blockmap|yml)$/i.test(f))

const artifacts = []
for (const file of installers) {
  const buf = await readFile(file)
  const info = await stat(file)
  artifacts.push({
    file: relative(ROOT, file).replaceAll('\\', '/'),
    bytes: info.size,
    mb: mb(info.size),
    sha256: sha256(buf)
  })
}
artifacts.sort((a, b) => b.bytes - a.bytes)

const installedBytes = await dirSize(UNPACKED_DIR)
const asarPath = join(UNPACKED_DIR, 'resources', 'app.asar')
let asarMb = null
try {
  asarMb = mb((await stat(asarPath)).size)
} catch {
  /* --dir 之外的构建可能无此文件 */
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const installer = artifacts.find((a) => /\.exe$/i.test(a.file))

const record = {
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  targets: {
    installerMb: installer ? installer.mb : null,
    installedMb: mb(installedBytes),
    appAsarMb: asarMb,
    budget: BUDGET
  },
  overBudget: {
    installer: installer ? installer.mb > BUDGET.installerMb : null,
    installed: mb(installedBytes) > BUDGET.installedMb
  },
  // 回归护栏：app.asar 不应包含被 Vite 打包过的依赖。
  // 曾因 vue/element-plus 误置于 dependencies 导致 asar 达 62MB（实际产物仅 1.4MB）。
  warnings: {
    asarTooLarge: asarMb !== null && asarMb > 8,
    prodDependencies: Object.keys(pkg.dependencies ?? {})
  },
  artifacts
}

await writeFile(OUT_FILE, JSON.stringify(record, null, 2), 'utf8')

console.log('\n=== 构建产物记录 (build/artifacts.json) ===')
console.log(`版本        : ${record.version}`)
console.log(
  `安装包      : ${record.targets.installerMb ?? '(本次为 --dir，无安装包)'} MB  (预算 ≤${BUDGET.installerMb} MB)`
)
console.log(`安装后      : ${record.targets.installedMb} MB  (预算 ≤${BUDGET.installedMb} MB)`)
console.log(`app.asar    : ${asarMb ?? 'n/a'} MB  (护栏 ≤8 MB)`)
console.log(`生产依赖    : ${record.warnings.prodDependencies.join(', ') || '(无)'}`)
for (const a of artifacts) console.log(`  ${a.mb} MB  ${a.file}`)

const problems = []
for (const [k, v] of Object.entries(record.overBudget)) if (v === true) problems.push(`体积超预算: ${k}`)
if (record.warnings.asarTooLarge) {
  problems.push(
    `app.asar ${asarMb}MB 超护栏 8MB —— 检查是否有本应被 Vite 打包的依赖误置于 dependencies`
  )
}

if (problems.length) {
  console.log(`\n⚠ ${problems.join('\n⚠ ')}`)
  process.exitCode = 1
} else {
  console.log('\n✓ 全部体积指标在预算内')
}
