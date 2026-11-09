/**
 * 导出 IPC 端到端验证（真实 Electron + 真实主进程）。
 *
 * 验证两件事：
 *  1.「导出本平台」只传当前平台 → 表里只有该平台的行、只有该平台的扩展列
 *  2.「导出全部」传全部平台 → 跨平台合并、表头无重复
 *
 * 运行：npx electron scripts/export-ipc-check.cjs
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const ExcelJS = require('exceljs')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.scratch')
fs.mkdirSync(OUT_DIR, { recursive: true })

const saved = []
dialog.showSaveDialog = async () => {
  const filePath = path.join(OUT_DIR, `ipc-export-${saved.length + 1}.xlsx`)
  saved.push(filePath)
  return { canceled: false, filePath }
}

app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()

const FIXTURES = [
  ['xianyu', 'xianyu-bought-list.json', 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/'],
  ['jd', 'jd-order-list.json', 'https://order.jd.com/center/list.action?page=1&__fetch__=1'],
  ['dewu', 'dewu-order-list.json', 'https://app.dewu.com/api/v1/h5/order-interfaces/h5/order/buyerOrderList'],
  ['kuaishou', 'kuaishou-order-list.json', 'https://mp.kwaixiaodian.com/rest/app/trade/c/gmp/v1/ks/order/list'],
  ['eleme', 'eleme-order-list.json', 'https://waimai-guide.ele.me/h5/mtop.alsc.personal.queryorderlist/1.0/'],
  ['meituan', 'meituan-order-list.json', 'https://wx.waimai.meituan.com/api/order/list']
]

app.whenReady().then(async () => {
  require(path.join(ROOT, 'out/main/index.js'))
  await new Promise((r) => setTimeout(r, 2500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('NO WINDOW')
    app.quit()
    return
  }
  await new Promise((r) => setTimeout(r, 800))

  // 在渲染层里：用真实适配器解析 fixture（通过 window.api 拿不到适配器，
  // 所以把解析好的订单直接作为 exportExcel 的入参 —— 这正是「导出本平台」按钮做的事）
  // 主进程被打包成单 bundle，无法直接 require 内部模块：
  // 改为读取由 scripts/dump-parsed-orders.mjs 预生成的解析结果
  const parsedPath = path.join(OUT_DIR, 'parsed-orders.json')
  if (!fs.existsSync(parsedPath)) {
    console.log('MISSING parsed-orders.json —— 先运行 npx vite-node scripts/dump-parsed-orders.mts')
    app.quit()
    return
  }
  const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf-8'))
  const totalOrders = parsed.reduce((n, p) => n + p.orders.length, 0)
  console.log('解析订单总数:', totalOrders, parsed.map((p) => `${p.id}:${p.orders.length}`).join(', '))

  // 调用导出 IPC —— 与 UI 按钮完全相同的调用
  const run = (orders, platforms) =>
    win.webContents.executeJavaScript(
      `window.api.exportExcel(${JSON.stringify(orders)}, ${JSON.stringify(platforms)}, false)`
    )

  // A. 导出本平台（得物）
  const dewu = parsed.find((p) => p.id === 'dewu').orders
  const one = await run(dewu, ['dewu'])
  console.log('\n[本平台导出]', JSON.stringify(one))

  // B. 导出全部
  const all = parsed.flatMap((p) => p.orders)
  const platforms = [...new Set(all.map((o) => o.platform))]
  const every = await run(all, platforms)
  console.log('[全部导出]', JSON.stringify(every))

  // 校验产物
  for (const [label, file] of [
    ['本平台', one.path],
    ['全部', every.path]
  ]) {
    if (!file || !fs.existsSync(file)) {
      console.log(`  ${label}: 文件不存在`)
      continue
    }
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)
    const sheet = wb.getWorksheet('订单')
    const headers = sheet.getRow(1).values.slice(1).filter(Boolean)
    const platformCol = headers.indexOf('平台') + 1
    const seen = new Set()
    for (let r = 2; r <= sheet.rowCount; r++) seen.add(sheet.getRow(r).getCell(platformCol).value)
    console.log(
      `  ${label}: ${sheet.rowCount - 1} 行 / ${headers.length} 列 / 平台=${[...seen].join(',')} / 表头唯一=${new Set(headers).size === headers.length}`
    )
    console.log(`       文件=${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(1)}KB)`)
  }

  app.quit()
})
