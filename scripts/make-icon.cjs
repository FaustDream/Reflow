/**
 * 生成应用图标：SVG → Electron 离屏渲染 → 多尺寸 PNG → ICO
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/make-icon.cjs
 *
 * 设计：与「AI Manager」同一套视觉语言（圆角方底 + 单一白色符号），
 * 符号换成「回流环」—— 表达各平台订单流回本地一个库。
 *
 * 两套几何：
 * - 完整版（48 以上）：环 + 中心三条订单线
 * - 简化版（32 / 16）：去掉中心线、环更粗更大 —— 小尺寸下细节只会糊成一团
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

app.disableHardwareAcceleration()
app.setPath('userData', path.join(os.tmpdir(), `reflow-icon-${Date.now()}`))
app.on('window-all-closed', () => {})

const SIZE = 1024
const SIZES = [512, 256, 128, 64, 48, 32, 16]
/** 32 及以下用简化版 */
const SIMPLE_MAX = 32

/** 回流环：两段对称弧 + 沿切线的箭头，形成「订单流回本地」的闭环。角度按 SVG 约定（0°=右，顺时针增大） */
function ring({ r, sw, arrowScale }) {
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180
    return [r * Math.cos(a), r * Math.sin(a)]
  }
  const arc = (from, to) => {
    const [x1, y1] = pt(from)
    const [x2, y2] = pt(to)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }
  const arrow = (deg) => {
    const w = 16 * arrowScale
    const h = 19 * arrowScale
    const b = 10 * arrowScale
    return `<g transform="rotate(${deg}) translate(${r} 0) rotate(90)">
      <path d="M 0 ${-h.toFixed(1)} L ${w.toFixed(1)} ${b.toFixed(1)} L ${(-w).toFixed(1)} ${b.toFixed(1)} Z" fill="#ffffff"/>
    </g>`
  }
  return {
    paths: `<path d="${arc(196, 336)}"/><path d="${arc(16, 156)}"/>`,
    arrows: arrow(336) + arrow(156),
    sw
  }
}

function buildSvg({ r, sw, arrowScale, withCenter }) {
  const g = ring({ r, sw, arrowScale })
  const center = withCenter
    ? `<circle r="33" fill="#ffffff" fill-opacity="0.15"/>
    <g stroke="#ffffff" stroke-width="8.5" stroke-linecap="round">
      <path d="M -18 -12 H 18"/>
      <path d="M -18 0 H 18"/>
      <path d="M -18 12 H 4"/>
    </g>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0.12" y1="0" x2="0.88" y2="1">
      <stop offset="0%" stop-color="#5AA0FF"/>
      <stop offset="52%" stop-color="#2F6BE8"/>
      <stop offset="100%" stop-color="#1B3FC4"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="256" height="256" rx="60" fill="url(#bg)"/>
  <rect width="256" height="128" rx="60" fill="url(#gloss)"/>

  <g transform="translate(128 128)">
    ${center}
    <g fill="none" stroke="#ffffff" stroke-width="${g.sw}" stroke-linecap="round">${g.paths}</g>
    ${g.arrows}
  </g>
</svg>`
}

/** 完整版：环细一点，留出中心空间 */
const SVG_FULL = buildSvg({ r: 74, sw: 21, arrowScale: 1, withCenter: true })
/** 简化版：环更粗更大，没有中心内容 —— 32/16 像素下只有轮廓能活下来 */
const SVG_SIMPLE = buildSvg({ r: 78, sw: 27, arrowScale: 1.25, withCenter: false })

async function render(svgMarkup) {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, sandbox: true }
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
    svg{width:${SIZE}px;height:${SIZE}px;display:block}
  </style></head><body>${svgMarkup}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 700))
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  win.destroy()
  if (shot.isEmpty()) throw new Error('capture 为空')
  return shot
}

app.whenReady().then(async () => {
  try {
    const full = await render(SVG_FULL)
    const simple = await render(SVG_SIMPLE)

    const outDir = path.join(__dirname, '..', 'build', 'icons')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'icon-1024.png'), full.toPNG())

    const frames = []
    for (const s of SIZES) {
      const src = s <= SIMPLE_MAX ? simple : full
      const png = src.resize({ width: s, height: s, quality: 'best' }).toPNG()
      fs.writeFileSync(path.join(outDir, `icon-${s}.png`), png)
      // electron-builder 找 Linux 图标只认 `<宽>x<高>.png` 这种命名，
      // 缺了会退回默认 Electron 图标（并在 AppImage 阶段报 undefined.file）
      fs.writeFileSync(path.join(outDir, `${s}x${s}.png`), png)
      // ICO 只放 256 及以下：更大的帧写进 ICO 会把尺寸字段压成 0，Windows 上显示会乱
      if (s <= 256) frames.push({ size: s, png })
    }

    // 打包 ICO：全部用 PNG 帧（Vista 起支持，Win10/11 显示正常）
    const header = Buffer.alloc(6)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(frames.length, 4)

    const entries = []
    let offset = 6 + frames.length * 16
    for (const f of frames) {
      const e = Buffer.alloc(16)
      e.writeUInt8(f.size >= 256 ? 0 : f.size, 0)
      e.writeUInt8(f.size >= 256 ? 0 : f.size, 1)
      e.writeUInt8(0, 2)
      e.writeUInt8(0, 3)
      e.writeUInt16LE(1, 4)
      e.writeUInt16LE(32, 6)
      e.writeUInt32LE(f.png.length, 8)
      e.writeUInt32LE(offset, 12)
      offset += f.png.length
      entries.push(e)
    }

    const ico = Buffer.concat([header, ...entries, ...frames.map((f) => f.png)])
    const icoPath = path.join(outDir, 'reflow.ico')
    fs.writeFileSync(icoPath, ico)

    console.log('sizes:', SIZES.map((s) => `${s}${s <= SIMPLE_MAX ? '(简单)' : ''}`).join(', '))
    console.log('ico:', icoPath, ico.length, 'bytes')
    app.exit(0)
  } catch (err) {
    console.error('失败:', err.message)
    app.exit(1)
  }
})
