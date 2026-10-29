#!/usr/bin/env node
/**
 * 修复「在 Windows 上打出来的 Linux tar.gz」的可执行位。
 *
 * 背景：electron-builder 的 tar.gz target 在 Windows 宿主上打包时，
 * 文件模式一律写成 0644（Windows 没有 Unix 权限位）。解压到 Linux 后
 * `reflow` 与 `chrome-sandbox` 没有 +x，双击/命令行都起不来，
 * 表现为「打包了但用不了」。
 *
 * 做法：直接改 tar 头里的 mode 字段（并重算 checksum），只给真正需要执行的
 * 文件加 0755，其余保持 0644。不依赖宿主平台的 chmod。
 *
 * 用法：node scripts/fix-linux-tar.mjs <file.tar.gz>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { basename } from 'node:path'
import process from 'node:process'

const EXECUTABLES = new Set(['reflow', 'chrome-sandbox', 'chrome_crashpad_handler'])

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/fix-linux-tar.mjs <file.tar.gz>')
  process.exit(1)
}

const tar = gunzipSync(readFileSync(file))
let offset = 0
let patched = 0

const readString = (buf, start, len) => {
  const slice = buf.subarray(start, start + len)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? len : end).toString('utf8')
}

/** 重算 tar header 的 checksum（chksum 字段本身按空格计算） */
function writeChecksum(header) {
  header.fill(0x20, 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  const octal = sum.toString(8).padStart(6, '0')
  header.write(octal + '\0 ', 148, 'latin1')
}

while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512)
  // 全零块 = 归档结束
  if (header.every((b) => b === 0)) break

  const name = readString(header, 0, 100)
  const prefix = readString(header, 345, 155)
  const fullName = prefix ? `${prefix}/${name}` : name
  const type = String.fromCharCode(header[156] || 0x30)
  const size = parseInt(readString(header, 124, 12).trim() || '0', 8)

  // 只处理普通文件（'0' 或 '\0'）；跳过 pax/global 头与目录
  if ((type === '0' || type === '\0') && EXECUTABLES.has(basename(fullName))) {
    header.write('0000755\0', 100, 'latin1')
    writeChecksum(header)
    patched++
  }

  offset += 512 + Math.ceil(size / 512) * 512
}

writeFileSync(file, gzipSync(tar, { level: 9 }))
console.log(`[tar] 已设置可执行位：${patched} 个文件 → ${file}`)
