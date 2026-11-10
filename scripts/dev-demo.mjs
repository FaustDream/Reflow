#!/usr/bin/env node
/**
 * 演示模式：带样例订单启动开发版，userData 指向临时目录。
 *
 * 为什么需要：本机没有真实抓过单时，主界面是空表，看不出筛选 / 导出中心 / 导出记录的效果。
 * 直接把样例单写进 `%APPDATA%\Reflow` 会污染真实订单与登录态，所以这里：
 *   1. 在 `%TEMP%/reflow-demo` 准备一份隔离 userData（引导已完成 + 四平台样例单）
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

// ---------------------------------------------------------------------------
// 样例订单：每平台一份商品表 + 一套状态轮转，按索引铺开到约一年半
// （日期与状态只由索引决定，不随机 —— 每次启动数据一致，方便对照文档与截图）
// ---------------------------------------------------------------------------

/** [标题, 店铺, 实付单价, 数量] */
const CATALOG = {
  xianyu: [
    ['AirPods Pro 2 降噪耳机 国行正品', '数码小铺', '1299.00', 1],
    ['罗技 MX Master 3S 无线鼠标', '外设仓库', '489.00', 1],
    ['宜家 MARKUS 办公椅 深灰', '家居闲置', '699.00', 1],
    ['Kindle Paperwhite 5 8G', '书虫二手', '520.00', 1],
    ['索尼 WH-1000XM4 头戴降噪', '耳机收藏', '1150.00', 1],
    ['明基 ScreenBar 显示器挂灯', '桌搭小站', '799.00', 1],
    ['尼康 Z 24-70 F4 S 镜头', '摄友转让', '3480.00', 1],
    ['德龙 全自动咖啡机 二手', '咖啡器具', '1980.00', 1],
    ['宜家 POÄNG 单人沙发 米色', '搬家清仓', '350.00', 1],
    ['机械键盘 87 键 静音红轴', '键盘工坊', '268.00', 1]
  ],
  jd: [
    ['小米 14 Ultra 16+512 白色', '小米京东自营', '6499.00', 1],
    ['尼康 Z6III 机身', '尼康京东自营', '15999.00', 1],
    ['戴森 V12 无线吸尘器', '戴森京东自营', '2990.00', 1],
    ['罗技 MX Keys S 无线键盘', '罗技京东自营', '699.00', 1],
    ['索尼 WH-1000XM5 头戴耳机', '索尼京东自营', '2699.00', 1],
    ['米家 净水器 1000G', '小米京东自营', '1799.00', 1],
    ['LG 27UP850 4K 显示器', 'LG京东自营', '2599.00', 1],
    ['三星 T7 移动固态硬盘 2T', '三星京东自营', '999.00', 1],
    ['美的 空气炸锅 5L', '美的京东自营', '299.00', 2],
    ['华为 WATCH GT5 46mm', '华为京东自营', '1588.00', 1]
  ],
  taobao: [
    ['优衣库 摇粒绒外套 L 码', '优衣库官方旗舰店', '199.00', 1],
    ['三顿半 超即溶咖啡 24 颗', '三顿半旗舰店', '159.00', 2],
    ['小米 移动电源 20000mAh', '小米官方旗舰店', '129.00', 1],
    ['飞利浦 电动牙刷替换刷头 8 支', '飞利浦官方旗舰店', '189.00', 1],
    ['记忆棉 护颈枕 中高型', '睡眠研究所', '238.00', 1],
    ['Keep 瑜伽垫 加厚防滑', 'Keep 旗舰店', '159.00', 1],
    ['网易严选 全价猫粮 7.2kg', '网易严选', '329.00', 1],
    ['书客 护眼台灯 L1 Pro', '书客旗舰店', '499.00', 1],
    ['安踏 跑步鞋 男款 42 码', '安踏官方旗舰店', '399.00', 1],
    ['绿联 氮化镓充电器 65W', '绿联数码旗舰店', '99.00', 2]
  ],
  pdd: [
    ['洗衣凝珠 4 合 1 深层洁净 52 颗', '洁净日用旗舰店', '39.90', 1],
    ['收纳箱 特大号 加厚 可折叠', '家居收纳专营店', '69.00', 2],
    ['不锈钢保温杯 500ml 带茶隔', '杯子工厂店', '45.80', 1],
    ['抽纸 30 包整箱 原生木浆', '纸品直营店', '32.50', 1],
    ['玻璃保鲜盒 三件套 微波炉可用', '厨具工厂店', '58.00', 1],
    ['加厚垃圾袋 45×50 共 300 只', '日用品工厂店', '19.90', 1],
    ['无痕衣架 防滑 20 只装', '衣柜整理店', '25.80', 2],
    ['棉拖鞋 居家防滑 情侣款', '家居鞋类店', '29.90', 2],
    ['湿巾 80 抽 6 包', '母婴日用店', '35.60', 1],
    ['数据线 Type-C 快充 2 米', '数码配件店', '15.90', 3]
  ]
}

/** 淘宝外卖 / 本地生活样例：靠 extra.bizType=5000 归到「外卖」页签 */
const TAOBAO_LOCAL = [
  ['香辣鸡腿中国汉堡 + 冰柠可乐 套餐', '塔斯汀·中国汉堡(文一西路店)', '29.90', 1],
  ['招牌老母鸡汤 + 米饭', '老乡鸡(余杭店)', '38.00', 1],
  ['4 元柠檬水 大杯', '蜜雪冰城(文一西路店)', '8.00', 2]
]

/** 状态轮转：按索引取，保证约七成成功、一成退款、两成进行中 */
const STATUS = {
  xianyu: ['交易成功', '交易成功', '待收货', '退款中', '交易成功', '交易成功', '已发货', '退款成功', '交易成功', '交易关闭'],
  jd: ['已完成', '已完成', '已发货', '已完成', '退款成功', '已完成', '已完成', '待收货', '已完成', '已取消'],
  taobao: ['交易成功', '交易成功', '待发货', '交易成功', '退款成功', '交易成功', '已发货', '交易成功', '交易成功', '交易关闭'],
  pdd: ['交易成功', '交易成功', '已发货', '交易成功', '退款成功', '交易成功', '待收货', '交易成功', '交易成功', '已取消']
}

/** 订单号：纯数字 + 平台前缀，长度接近真实值（表格里会被截断成省略号） */
const orderIdOf = (platform, i) => {
  const prefix = { xianyu: '30', jd: '28', taobao: '39', pdd: '25' }[platform]
  return `${prefix}${880000000000 + i * 137}`
}

/** 日期铺开到约一年半：既能跨年度对比，也能让热力图有分布 */
const dateOf = (i) => daysAgo(2 + i * 54 + (i % 3) * 11)

function platformOrders(platform) {
  const account = `${platform}#0`
  return CATALOG[platform].map(([title, shop, paid, qty], i) => {
    const extra =
      platform === 'xianyu' ? { itemId: `I-${1000 + i}`, sellerId: `S-${90 + i}` } : {}
    return order(
      platform,
      account,
      orderIdOf(platform, i),
      title,
      paid,
      qty,
      STATUS[platform][i % STATUS[platform].length],
      shop,
      dateOf(i),
      extra
    )
  })
}

const taobaoOrders = platformOrders('taobao').concat(
  TAOBAO_LOCAL.map(([title, shop, paid, qty], i) =>
    order(
      'taobao',
      'taobao#0',
      orderIdOf('taobao', 40 + i),
      title,
      paid,
      qty,
      i === 2 ? '退款成功' : '交易成功',
      shop,
      daysAgo(4 + i * 9),
      { bizType: '5000', itemCount: String(qty) }
    )
  )
)

const allOrders = {
  xianyu: platformOrders('xianyu'),
  jd: platformOrders('jd'),
  taobao: taobaoOrders,
  pdd: platformOrders('pdd')
}

for (const [platform, orders] of Object.entries(allOrders)) {
  writeFileSync(join(ORDERS_DIR, `${platform}.json`), cache(platform, orders))
}

const summary = Object.entries(allOrders)
  .map(([platform, orders]) => `${platform} ${orders.length}`)
  .join(' / ')
console.log(`[demo] userData → ${USER_DATA}`)
console.log(`[demo] 样例订单：${summary}（共 ${Object.values(allOrders).flat().length} 单，含淘宝外卖 3 单）`)

const env = { ...process.env, REFLOW_USER_DATA: USER_DATA }
// 这两个变量是当前终端环境注入的：前者让 electron 以纯 Node 运行，后者是文件删除守卫
// （vite 依赖预构建需要清理自己的临时目录，守卫会拦下来）。只对本子进程去掉。
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

const isWin = process.platform === 'win32'
// --web：追加 Web 调试模式（主进程隐藏窗口 + web-bridge，浏览器打开 dev server 测试）
const extraArgs = process.argv.includes('--web') ? ['--web'] : []
if (extraArgs.length) console.log('[demo] Web 调试模式：浏览器打开 vite 输出的地址（默认 http://localhost:5173）')
const child = spawn(
  isWin ? 'npx.cmd' : 'npx',
  [
    'electron-vite',
    'dev',
    '--',
    ...extraArgs,
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
