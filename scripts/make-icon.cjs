#!/usr/bin/env node
/**
 * 把 build/icons 下的 PNG 打成 Windows 图标：`npm run icon`。
 *
 * 为什么要重做（2026-11-11）：
 * 上一版 ICO 的六个尺寸**全是 PNG 压缩帧**。Windows 的 shell 图标加载器只在
 * 256×256 这一档可靠地解 PNG 帧，任务栏 / 资源管理器要的是 16/32/48 ——
 * 拿到 PNG 帧就直接放弃，回落到系统通用的「空白文件」图标。
 * 实测 bin 里的 exe 资源完好（6 帧、dataSize 对得上），但 shell 渲染出来是灰白窗口。
 *
 * 现在的做法（微软的通行约定）：
 *   - 16 / 32 / 48 / 64 / 128 → 未压缩 32bpp BMP 帧（自带 AND 掩码）
 *   - 256 → 保留 PNG 帧（这一档 PNG 是官方支持的，且能把体积压下来）
 *
 * 只用 Node 内置模块（zlib），不依赖 Electron —— CI 上也能直接跑。
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { inflateSync } = require('node:zlib')

const ROOT = join(__dirname, '..')
const ICON_DIR = join(ROOT, 'build', 'icons')

/** 需要写进 ICO 的尺寸，与 build/icons 下的 PNG 一一对应 */
const DIB_SIZES = [16, 32, 48, 64, 128]
const PNG_SIZE = 256

// ---------------------------------------------------------------- PNG 解码
/** 解码 8bit / RGBA / 非隔行的 PNG，返回自顶向下的 RGBA 像素 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG')

  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []

  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`只支持 8bit 的 RGBA/RGB PNG（当前 bitDepth=${bitDepth} colorType=${colorType}）`)
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    raw.copy(line, 0, rowStart, rowStart + stride)
    unfilter(filter, line, prev, channels)
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = line[s]
      out[d + 1] = line[s + 1]
      out[d + 2] = line[s + 2]
      out[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    line.copy(prev)
  }
  return { width, height, rgba: out }
}

/** PNG 行过滤器的逆运算（原地修改 line） */
function unfilter(filter, line, prev, bpp) {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prev[i]
    const c = i >= bpp ? prev[i - bpp] : 0
    switch (filter) {
      case 0:
        break
      case 1:
        line[i] = (line[i] + a) & 0xff
        break
      case 2:
        line[i] = (line[i] + b) & 0xff
        break
      case 3:
        line[i] = (line[i] + ((a + b) >> 1)) & 0xff
        break
      case 4:
        line[i] = (line[i] + paeth(a, b, c)) & 0xff
        break
      default:
        throw new Error(`未知的 PNG 过滤器 ${filter}`)
    }
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

// ---------------------------------------------------------------- ICO 组装
/**
 * 把 RGBA 像素包成 ICO 里的 BMP 帧：BITMAPINFOHEADER + 自底向上的 BGRA + AND 掩码。
 * 32bpp 帧的可见性由 alpha 决定，掩码按惯例全 0 即可，但字节必须留出来。
 */
function toDibFrame({ width, height, rgba }) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // XOR 位图 + AND 掩码，高度翻倍
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(width * height * 4, 20)

  const xor = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4 // BMP 自底向上
    const dst = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = src + x * 4
      const d = dst + x * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  const maskStride = Math.ceil(width / 32) * 4
  const and = Buffer.alloc(maskStride * height, 0)
  return Buffer.concat([header, xor, and])
}

function buildIco(frames) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type = icon
  head.writeUInt16LE(frames.length, 4)

  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + dir.length
  frames.forEach((frame, i) => {
    const o = i * 16
    dir.writeUInt8(frame.width >= 256 ? 0 : frame.width, o)
    dir.writeUInt8(frame.height >= 256 ? 0 : frame.height, o + 1)
    dir.writeUInt8(0, o + 2) // 调色板数量
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bitCount
    dir.writeUInt32LE(frame.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += frame.data.length
  })

  return Buffer.concat([head, dir, ...frames.map((f) => f.data)])
}

// ---------------------------------------------------------------- 主流程
function main() {
  const frames = []

  for (const size of DIB_SIZES) {
    const path = join(ICON_DIR, `${size}x${size}.png`)
    const image = decodePng(readFileSync(path))
    if (image.width !== size || image.height !== size) {
      throw new Error(`${path} 尺寸是 ${image.width}×${image.height}，应为 ${size}×${size}`)
    }
    frames.push({ width: size, height: size, data: toDibFrame(image) })
    console.log(`  添加 ${size}×${size}  BMP 帧`)
  }

  const largePng = readFileSync(join(ICON_DIR, `${PNG_SIZE}x${PNG_SIZE}.png`))
  const large = decodePng(largePng)
  if (large.width !== PNG_SIZE) throw new Error('256 帧尺寸不对')
  frames.push({ width: PNG_SIZE, height: PNG_SIZE, data: largePng })
  console.log(`  添加 ${PNG_SIZE}×${PNG_SIZE} PNG 帧`)

  const ico = buildIco(frames)
  // build/icon.ico 是 electron-builder 的默认约定位置，build/icons/reflow.ico 是配置里显式指定的那个
  writeFileSync(join(ICON_DIR, 'reflow.ico'), ico)
  writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)
  console.log(`完成：${ico.length} 字节 → build/icons/reflow.ico、build/icon.ico`)
}

main()
