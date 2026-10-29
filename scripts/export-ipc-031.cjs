/**
 * 工单 031 端到端：走真实 Electron + 真实导出 IPC，验证
 *  1. export:columns 返回核心列 + 已消歧扩展列
 *  2. 多表 + 汇总 + 列白名单 → 文件里的 sheet / 表头 / 汇总数字
 *  3. CSV 列白名单
 * 运行：npx electron .scratch/export-ipc-031.cjs
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const ExcelJS = require('exceljs')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.scratch')
const saved = []

dialog.showSaveDialog = async (_win, opts) => {
  const ext = opts.filters?.[0]?.extensions?.[0] ?? 'xlsx'
  const filePath = path.join(OUT_DIR, `ipc-031-${saved.length + 1}.${ext}`)
  saved.push(filePath)
  return { canceled: false, filePath }
}

app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

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

  const parsed = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'parsed-orders.json'), 'utf-8'))
  const all = parsed.flatMap((p) => p.orders)
  const platforms = [...new Set(all.map((o) => o.platform))]
  console.log('订单:', all.length, '平台:', platforms.join(','))

  // 1. 列清单
  const cols = await win.webContents.executeJavaScript(
    `window.api.getExportColumns(${JSON.stringify(platforms)})`
  )
  console.log(
    '\n[列清单] core=%d extended=%d 例:%s',
    cols.core.length,
    cols.extended.length,
    cols.extended.slice(0, 3).map((c) => c.header).join('/')
  )

  // 2. 多表 + 汇总 + 白名单
  const multi = await win.webContents.executeJavaScript(
    `window.api.exportExcel(${JSON.stringify(all)}, ${JSON.stringify(platforms)}, false, ${JSON.stringify({
      layout: 'multi-sheet',
      summary: true,
      coreKeys: ['orderId', 'createdAt', 'paidAmount', 'status'],
      columnKeys: ['itemId']
    })})`
  )
  console.log('\n[多表导出]', JSON.stringify(multi))
  if (multi.path && fs.existsSync(multi.path)) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(multi.path)
    console.log('  sheets:', wb.worksheets.map((s) => s.name).join(' | '))
    const first = wb.worksheets[0]
    console.log(
      '  首表表头:',
      first.getRow(1).values.slice(1).filter(Boolean).join(',')
    )
    for (let r = 1; r <= first.rowCount; r++) {
      console.log('  ', first.getRow(r).values.slice(1).join(' | '))
    }
    const detail = wb.worksheets[1]
    console.log(
      '  明细表头:',
      detail.getRow(1).values.slice(1).filter(Boolean).join(','),
      '/ 行数',
      detail.rowCount - 1
    )
    console.log('  自动筛选:', Boolean(detail.autoFilter), '| 冻结:', JSON.stringify(detail.views))
  }

  // 3. CSV 白名单
  const csv = await win.webContents.executeJavaScript(
    `window.api.exportExcel(${JSON.stringify(all.slice(0, 3))}, ${JSON.stringify(platforms)}, false, ${JSON.stringify(
      { format: 'csv', coreKeys: ['orderId', 'paidAmount'], columnKeys: [] }
    )})`
  )
  console.log('\n[CSV 导出]', JSON.stringify(csv))
  if (csv.path && fs.existsSync(csv.path)) {
    const text = fs.readFileSync(csv.path, 'utf-8').replace(/^\ufeff/, '')
    console.log('  前两行:\n' + text.split('\r\n').slice(0, 2).join('\n'))
    console.log('  BOM:', fs.readFileSync(csv.path).slice(0, 3).toString('hex'))
  }

  // 4. 一列不选 → 明确报错而不是生成空表
  const none = await win.webContents.executeJavaScript(
    `window.api.exportExcel(${JSON.stringify(all.slice(0, 1))}, ${JSON.stringify(platforms)}, false, ${JSON.stringify(
      { coreKeys: [], columnKeys: [] }
    )})`
  )
  console.log('\n[零列导出]', JSON.stringify(none))

  app.quit()
})
