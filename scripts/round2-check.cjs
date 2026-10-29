/**
 * 本轮新功能真实验证：多账号 / CSV / 多 Sheet / 首次引导。
 * 运行：npx electron scripts/round2-check.cjs
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const ExcelJS = require('exceljs')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.scratch')
fs.mkdirSync(OUT, { recursive: true })

const saved = []
dialog.showSaveDialog = async () => {
  const filePath = path.join(OUT, `r2-${saved.length + 1}`)
  saved.push(filePath)
  return { canceled: false, filePath }
}

app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  require(path.join(ROOT, 'out/main/index.js'))
  await new Promise((r) => setTimeout(r, 2500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('NO WINDOW')
    app.quit()
    return
  }
  await new Promise((r) => setTimeout(r, 1500))
  const js = (code) => win.webContents.executeJavaScript(code)

  // ---------- 1. 首次引导 ----------
  const onboard = await js(`window.api.loadOnboarding()`)
  console.log('[引导] 状态:', JSON.stringify(onboard))

  // ---------- 2. 多账号 ----------
  await js(`window.api.ensureAccount('dewu')`)
  let accts = await js(`window.api.listAccounts()`)
  console.log('[账号] 初始:', accts.map((a) => `${a.id}(${a.displayName})`).join(', '))

  const added = await js(`window.api.addAccount('dewu')`)
  accts = await js(`window.api.listAccounts()`)
  console.log('[账号] 新增后:', accts.map((a) => `${a.id}(${a.displayName}) active=${a.active}`).join(', '))
  console.log('[账号] 新账号分区:', added?.account?.partition)

  // 分区必须不同
  const partitions = accts.filter((a) => a.platform === 'dewu').map((a) => a.partition)
  console.log('[账号] 分区互异:', new Set(partitions).size === partitions.length ? 'YES' : 'NO ' + partitions)

  // 切换 + 重命名
  const second = accts.find((a) => a.platform === 'dewu' && a.slot === 1)
  await js(`window.api.activateAccount('${second.id}')`)
  await js(`window.api.renameAccount('${second.id}', '副号')`)
  accts = await js(`window.api.listAccounts()`)
  console.log(
    '[账号] 切换+重命名:',
    accts.filter((a) => a.platform === 'dewu').map((a) => `${a.id}(${a.displayName}) active=${a.active}`).join(', ')
  )

  // 清理：删掉第二个账号
  const removed = await js(`window.api.removeAccount('${second.id}')`)
  console.log('[账号] 删除第二个:', JSON.stringify(removed))

  // ---------- 3. 导出：CSV / 多 Sheet ----------
  const parsed = JSON.parse(fs.readFileSync(path.join(OUT, 'parsed-orders.json'), 'utf-8'))
  const all = parsed.flatMap((p) => p.orders)
  const platforms = [...new Set(all.map((o) => o.platform))]

  // CSV
  const csvResult = await js(
    `window.api.exportExcel(${JSON.stringify(all)}, ${JSON.stringify(platforms)}, false, { format: 'csv' })`
  )
  console.log('[导出 CSV]', JSON.stringify(csvResult))
  if (csvResult.path) {
    // dialog 拦截返回无扩展名，这里补上实际文件名
    const buf = fs.readFileSync(csvResult.path)
    const text = buf.toString('utf-8')
    console.log('  BOM:', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 'YES' : 'NO')
    console.log('  行数:', text.replace(/^\ufeff/, '').split('\r\n').length, '(表头+21单)')
    console.log('  含中文表头:', text.includes('订单号') ? 'YES' : 'NO')
  }

  // 多 Sheet
  const sheetResult = await js(
    `window.api.exportExcel(${JSON.stringify(all)}, ${JSON.stringify(platforms)}, false, { layout: 'multi-sheet' })`
  )
  console.log('[导出多Sheet]', JSON.stringify(sheetResult))
  if (sheetResult.path) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(sheetResult.path)
    console.log('  工作表:', wb.worksheets.map((w) => `${w.name}(${w.rowCount - 1}行)`).join(', '))
  }

  app.quit()
})
