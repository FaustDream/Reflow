/**
 * 工单 031 自检：隔离 userData 灌入样例订单 → 主界面截图 → 打开导出中心截图。
 * 运行：npx electron .scratch/ui-shot-031.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), `reflow-shot-031-${process.pid}`)
fs.rmSync(USER_DATA, { recursive: true, force: true })
fs.mkdirSync(path.join(USER_DATA, 'orders'), { recursive: true })
app.setPath('userData', USER_DATA)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('disable-features', 'Vulkan')
app.on('window-all-closed', () => {})
process.env.REFLOW_SHOT = '1'

const THUMB =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#c7d7ff"/><circle cx="40" cy="34" r="16" fill="#6b8cff"/><rect x="16" y="56" width="48" height="10" rx="5" fill="#8fa8ff"/></svg>'
  ).toString('base64')

const order = (platform, account, id, title, paid, qty, status, shop, created, extra = {}) => ({
  platform,
  account,
  orderId: id,
  createdAt: created,
  title,
  imageUrl: THUMB,
  unitPrice: paid,
  paidAmount: paid,
  quantity: qty,
  status,
  shopName: shop,
  receiverName: '张三',
  receiverAddress: '浙江省杭州市余杭区文一西路 969 号',
  receiverPhone: '138****0000',
  logisticsCompany: '顺丰速运',
  trackingNo: 'SF' + id.slice(-8),
  paidAt: created,
  shippedAt: null,
  completedAt: null,
  extra
})

const cache = (platform, orders) =>
  JSON.stringify({ version: 1, platform, savedAt: Date.now(), orders }, null, 1)

const NOW = new Date()
const daysAgo = (n) => {
  const d = new Date(NOW.getTime() - n * 86400000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 12:30:00`
}

app.whenReady().then(async () => {
  fs.writeFileSync(
    path.join(USER_DATA, 'onboarding.json'),
    JSON.stringify({ version: 1, completed: true, completedAt: Date.now(), platforms: [] })
  )
  fs.writeFileSync(
    path.join(USER_DATA, 'orders', 'xianyu.json'),
    cache('xianyu', [
      order('xianyu', 'xianyu#0', '3021887766001234', 'AirPods Pro 2 降噪耳机 国行正品', '1299.00', 1, '交易成功', '数码小铺', daysAgo(1), { itemId: 'I-1', sellerId: 'S-9' }),
      order('xianyu', 'xianyu#0', '3021887766005678', '罗技 MX Master 3S 无线鼠标', '489.00', 1, '待收货', '外设仓库', daysAgo(3), { itemId: 'I-2' }),
      order('xianyu', 'xianyu#0', '3021887766009012', '宜家 MARKUS 办公椅 深灰', '699.00', 2, '退款中', '家居闲置', daysAgo(12), { itemId: 'I-3' })
    ])
  )
  fs.writeFileSync(
    path.join(USER_DATA, 'orders', 'jd.json'),
    cache('jd', [
      order('jd', 'jd#0', '28765432109', '小米 14 Ultra 16+512 白色', '6499.00', 1, '已完成', '小米京东自营', daysAgo(5)),
      order('jd', 'jd#0', '28765432110', '尼康 Z6III 机身', '15999.00', 1, '待付款', '尼康京东自营', daysAgo(40))
    ])
  )
  fs.writeFileSync(
    path.join(USER_DATA, 'orders', 'taobao.json'),
    cache('taobao', [
      order('taobao', 'taobao#0', '3987654321098765432', '优衣库 摇粒绒外套 L 码', '199.00', 1, '交易成功', '优衣库官方旗舰店', daysAgo(8))
    ])
  )

  require(path.join(ROOT, 'out/main/index.js'))
  await new Promise((r) => setTimeout(r, 3000))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('NO WINDOW')
    app.quit()
    return
  }
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 2500))

  const shot = async (name) => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(ROOT, '.scratch', name), img.toPNG())
  }

  await shot('ui-031.png')

  // 打开页面分栏（原版作法：页面就在界面上）
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '打开页面')
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await new Promise((r) => setTimeout(r, 2500))
  await shot('ui-031-page.png')
  const split = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.page-pane')
    const main = document.querySelector('.content')
    return { pane: pane?.getBoundingClientRect().width, content: main?.getBoundingClientRect().width }
  })()`)
  console.log('SPLIT:', JSON.stringify(split))
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '收起页面')
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  // 搜索筛选
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.filter-search input')
    input.value = '鼠标'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  const filtered = await win.webContents.executeJavaScript(
    `document.querySelector('.filter-bar').innerText.replace(/\\s+/g,' ') + ' | rows=' + document.querySelectorAll('.el-table__body tr').length`
  )
  console.log('FILTER:', filtered)
  await shot('ui-031-filter.png')

  // 勾选第一行
  await win.webContents.executeJavaScript(`(() => {
    const cb = document.querySelector('.el-table__body .el-checkbox__original')
    if (cb) { cb.click(); return true }
    return false
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  const selected = await win.webContents.executeJavaScript(
    `document.querySelector('.filter-bar').innerText.replace(/\\s+/g,' ')`
  )
  console.log('SELECTED:', selected)
  await shot('ui-031-select.png')

  // 清空搜索，回到全量
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.filter-search input')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  const info = await win.webContents
    .executeJavaScript(`(() => ({
      platforms: [...document.querySelectorAll('.platform-item')].map(e => e.innerText.replace(/\\s+/g, ' ')),
      head: document.querySelector('.content-head')?.innerText.replace(/\\s+/g, ' '),
      filters: document.querySelector('.filter-bar')?.innerText.replace(/\\s+/g, ' '),
      rows: document.querySelectorAll('.el-table__body tr').length,
      footer: document.querySelector('.el-table__footer')?.innerText.replace(/\\s+/g, ' '),
      statusbar: document.querySelector('.statusbar')?.innerText.replace(/\\s+/g, ' ')
    }))()`)
    .catch((e) => ({ err: e.message }))
  console.log('UI:', JSON.stringify(info, null, 1))

  // 打开导出中心
  const opened = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '导出')
    if (!btn) return 'no-button'
    btn.click()
    return 'clicked'
  })()`)
  console.log('OPEN:', opened)
  await new Promise((r) => setTimeout(r, 1500))
  await shot('export-dialog-031.png')

  const dialog = await win.webContents
    .executeJavaScript(`(() => {
      const d = document.querySelector('.export-dialog')
      return {
        title: d?.querySelector('.el-dialog__title')?.innerText,
        text: d?.innerText.replace(/\\s+/g, ' ').slice(0, 700),
        groups: [...document.querySelectorAll('.export-dialog .el-collapse-item__header')].map(e => e.innerText.replace(/\\s+/g, ' ')),
        checks: document.querySelectorAll('.export-dialog .el-checkbox').length
      }
    })()`)
    .catch((e) => ({ err: e.message }))
  console.log('DIALOG:', JSON.stringify(dialog, null, 1))

  // 关掉导出中心
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.export-dialog button')].find(b => b.innerText.trim() === '取消')
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  // 真跑一次导出（带 targetPath，跳过保存对话框），用于验证导出记录
  const demoOrders = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'orders', 'xianyu.json'), 'utf-8')).orders
  const demoPath = path.join(USER_DATA, 'history-demo.xlsx').replace(/\\/g, '\\\\')
  const exported = await win.webContents.executeJavaScript(
    `window.api.exportExcel(${JSON.stringify(demoOrders)}, ['xianyu'], false, { targetPath: '${demoPath}', layout: 'single', coreKeys: ['orderId','paidAmount','status'], columnKeys: ['itemId'] })`
  )
  console.log('EXPORT:', JSON.stringify(exported))

  // 工具 → 导出记录
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('工具'))
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find(i => i.innerText.includes('导出记录'))
    if (!item) return 'no-item'
    item.click()
    return 'ok'
  })()`)
  await new Promise((r) => setTimeout(r, 1200))
  const history = await win.webContents.executeJavaScript(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.innerText.includes('导出记录'))
    return d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 400) : 'no-dialog'
  })()`)
  console.log('HISTORY(', clicked, '):', history)
  await shot('export-history-031.png')

  // 关闭导出记录 → 打开 MITM 设置
  await win.webContents.executeJavaScript(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.innerText.includes('导出记录'))
    const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.innerText.trim() === '关闭')
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('工具'))
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  const mitmOpened = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find(i => i.innerText.includes('MITM'))
    if (!item) return 'no-item'
    item.click()
    return 'ok'
  })()`)
  await new Promise((r) => setTimeout(r, 1200))
  const mitmText = await win.webContents.executeJavaScript(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.innerText.includes('MITM'))
    return d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 320) : 'no-dialog'
  })()`)
  console.log('MITM(', mitmOpened, '):', mitmText)
  await shot('mitm-settings.png')

  app.quit()
})
