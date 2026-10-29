#!/usr/bin/env node
/**
 * 演示模式：带样例订单启动开发版，userData 指向临时目录。
 *
 * 为什么需要：本机没有真实抓过单时，主界面是空表，看不出筛选 / 导出中心 / 导出记录的效果。
 * 直接把样例单写进 `%APPDATA%\回流 Reflow` 会污染真实订单与登录态，所以这里：
 *   1. 在 `%TEMP%/reflow-demo` 准备一份隔离 userData（引导已完成 + 三平台样例单）
 *   2. 通过 REFLOW_USER_DATA 让主进程把 userData 指过去（见 src/main/index.ts）
 *   3. 起 electron-vite dev，并把软件渲染开关传给 Electron（无 GPU 的虚拟机/RDP 必需）
 *
 * 用法：npm run dev:demo
 * 清空样例：删掉 %TEMP%/reflow-demo 即可（每次启动都会重写）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USER_DATA = join(tmpdir(), 'reflow-demo')
const ORDERS_DIR = join(USER_DATA, 'orders')
mkdirSync(ORDERS_DIR, { recursive: true })

// 80×80 的占位商品图（data URI，离线也能显示）
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

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 12:30:00`
}

writeFileSync(
  join(USER_DATA, 'onboarding.json'),
  JSON.stringify({ version: 1, completed: true, completedAt: Date.now(), platforms: [] })
)

writeFileSync(
  join(ORDERS_DIR, 'xianyu.json'),
  cache('xianyu', [
    order('xianyu', 'xianyu#0', '3021887766001234', 'AirPods Pro 2 降噪耳机 国行正品', '1299.00', 1, '交易成功', '数码小铺', daysAgo(1), { itemId: 'I-1', sellerId: 'S-9' }),
    order('xianyu', 'xianyu#0', '3021887766005678', '罗技 MX Master 3S 无线鼠标', '489.00', 1, '待收货', '外设仓库', daysAgo(3), { itemId: 'I-2' }),
    order('xianyu', 'xianyu#0', '3021887766009012', '宜家 MARKUS 办公椅 深灰', '699.00', 2, '退款中', '家居闲置', daysAgo(12), { itemId: 'I-3' }),
    order('xianyu', 'xianyu#0', '3021887766003456', 'Kindle Paperwhite 5 8G', '520.00', 1, '交易成功', '书虫二手', daysAgo(45), { itemId: 'I-4' })
  ])
)

writeFileSync(
  join(ORDERS_DIR, 'jd.json'),
  cache('jd', [
    order('jd', 'jd#0', '28765432109', '小米 14 Ultra 16+512 白色', '6499.00', 1, '已完成', '小米京东自营', daysAgo(5)),
    order('jd', 'jd#0', '28765432110', '尼康 Z6III 机身', '15999.00', 1, '待付款', '尼康京东自营', daysAgo(40)),
    order('jd', 'jd#0', '28765432111', '戴森 V12 无线吸尘器', '2990.00', 1, '已发货', '戴森京东自营', daysAgo(9))
  ])
)

writeFileSync(
  join(ORDERS_DIR, 'taobao.json'),
  cache('taobao', [
    order('taobao', 'taobao#0', '3987654321098765432', '优衣库 摇粒绒外套 L 码', '199.00', 1, '交易成功', '优衣库官方旗舰店', daysAgo(8)),
    order('taobao', 'taobao#0', '3987654321098765433', '三顿半 超即溶咖啡 24 颗', '159.00', 2, '交易成功', '三顿半旗舰店', daysAgo(20))
  ])
)

console.log(`[demo] userData → ${USER_DATA}`)
console.log('[demo] 样例订单：闲鱼 4 / 京东 3 / 淘宝 2')

const env = { ...process.env, REFLOW_USER_DATA: USER_DATA }
// 这两个变量是当前终端环境注入的：前者让 electron 以纯 Node 运行，后者是文件删除守卫
// （vite 依赖预构建需要清理自己的临时目录，守卫会拦下来）。只对本子进程去掉。
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const isWin = process.platform === 'win32'
const child = spawn(
  isWin ? 'npx.cmd' : 'npx',
  [
    'electron-vite',
    'dev',
    '--',
    // 无 GPU 的虚拟机 / 远程桌面下，Electron 的 GPU 进程会直接崩溃退出，改走软件渲染
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--use-gl=swiftshader',
    '--use-angle=swiftshader'
  ],
  { stdio: 'inherit', env, shell: isWin }
)

child.on('exit', (code) => process.exit(code ?? 0))
