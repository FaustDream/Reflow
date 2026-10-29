/**
 * 新功能真实验证：缓存持久化 / 诊断面板 / 自动翻页按钮。
 * 运行：npx electron scripts/features-check.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
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
  await new Promise((r) => setTimeout(r, 1200))

  // ---- 1. 缓存写入 + 读回 ----
  const fakeOrders = [
    {
      platform: 'dewu',
      account: 'u1',
      orderId: 'CACHE-TEST-1',
      createdAt: '2026-01-01 00:00:00',
      title: '缓存测试商品',
      imageUrl: '',
      unitPrice: '1',
      paidAmount: '1',
      quantity: 1,
      status: '已完成',
      shopName: '',
      receiverName: '',
      receiverAddress: '',
      receiverPhone: '',
      logisticsCompany: '',
      trackingNo: '',
      paidAt: null,
      shippedAt: null,
      completedAt: null,
      extra: {}
    }
  ]
  const saved = await win.webContents.executeJavaScript(
    `window.api.saveOrderCache('dewu', ${JSON.stringify(fakeOrders)})`
  )
  console.log('[缓存写入]', JSON.stringify(saved))
  await new Promise((r) => setTimeout(r, 2200)) // 等去抖 + 落盘

  const loaded = await win.webContents.executeJavaScript(`window.api.loadOrderCache()`)
  const dewuCount = loaded?.dewu?.length ?? 0
  console.log('[缓存读回] dewu 条数 =', dewuCount, '| 首单号 =', loaded?.dewu?.[0]?.orderId ?? '-')

  const summary = await win.webContents.executeJavaScript(`window.api.getCacheSummary()`)
  console.log('[缓存概览]', JSON.stringify(summary))

  // ---- 2. 诊断快照 ----
  const diag = await win.webContents.executeJavaScript(`window.api.getDiagnostics()`)
  console.log('[诊断] 版本 =', diag?.app?.electron, '| 适配器数 =', diag?.adapters?.length)
  console.log(
    '[诊断] 登录方式:',
    (diag?.adapters ?? [])
      .filter((a) => a.loginKind !== 'none')
      .map((a) => `${a.id}=${a.loginKind}`)
      .join(', ')
  )
  // 隐私检查：不应包含 cookie/token 字样
  const diagText = JSON.stringify(diag)
  const leaks = ['cookie', 'token', 'password', 'Authorization'].filter((k) =>
    new RegExp(k, 'i').test(diagText)
  )
  console.log('[诊断] 敏感字段检查:', leaks.length ? 'LEAK: ' + leaks.join(',') : 'clean ✓')

  // ---- 3. 界面元素 ----
  const ui = await win.webContents.executeJavaScript(`(() => ({
    hasDiagnosticsBtn: [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '诊断'),
    hasAutoScrollBtn: [...document.querySelectorAll('button')].some(b => /自动翻页|停止翻页/.test(b.innerText)),
    platformCount: document.querySelectorAll('.platform-item').length
  }))()`)
  console.log('[界面]', JSON.stringify(ui))

  // ---- 4. 清理测试缓存 ----
  await win.webContents.executeJavaScript(`window.api.clearPlatformCache('dewu')`)
  const after = await win.webContents.executeJavaScript(`window.api.loadOrderCache()`)
  console.log('[清理后] dewu 条数 =', after?.dewu?.length ?? 0)

  app.quit()
})
