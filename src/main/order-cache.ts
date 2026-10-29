/**
 * 工单 023：本地存储与订单缓存。
 *
 * 为什么需要：捕获的订单目前只在渲染层内存里，一关应用就没了。用户跨天分批抓单时
 * 必须一次抓完再导，非常不便。持久化后可以「今天抓一点、明天抓一点」。
 *
 * 设计取舍：
 * - **按平台分文件**（`orders/<platform>.json`），单平台损坏不影响其他平台
 * - **原子写入**（先写 .tmp 再 rename），避免断电/崩溃留下半个文件
 * - **只存订单数据，不存 Cookie/令牌**（D-4 隐私门禁）
 * - 写入采用**去抖**（默认 1.5s），避免每捕获一单就落一次盘
 */
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile, unlink, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Order } from '../shared/types/order'

/** 缓存格式版本：结构变化时递增，读到旧版本直接丢弃而不是崩溃 */
const CACHE_VERSION = 1

interface CacheFile {
  version: number
  platform: string
  savedAt: number
  orders: Order[]
}

export interface CacheSummary {
  platform: string
  count: number
  savedAt: number
}

const SAFE_ID = /^[a-z0-9-]+$/

function ordersDir(): string {
  return join(app.getPath('userData'), 'orders')
}

function fileFor(platform: string): string {
  // 平台 id 来自适配器注册表（受控），仍做白名单校验防止路径穿越
  const safe = SAFE_ID.test(platform) ? platform : 'unknown'
  return join(ordersDir(), `${safe}.json`)
}

/** 读取单个平台缓存；文件不存在/损坏/版本不符时返回空数组（不抛错） */
export async function loadPlatformCache(platform: string): Promise<Order[]> {
  try {
    const raw = await readFile(fileFor(platform), 'utf-8')
    const data = JSON.parse(raw) as CacheFile
    if (data?.version !== CACHE_VERSION || !Array.isArray(data.orders)) return []
    return data.orders
  } catch {
    return []
  }
}

/** 读取全部平台缓存（启动时恢复） */
export async function loadAllCache(): Promise<Record<string, Order[]>> {
  const result: Record<string, Order[]> = {}
  try {
    const files = await readdir(ordersDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const platform = basename(file, '.json')
      const orders = await loadPlatformCache(platform)
      if (orders.length) result[platform] = orders
    }
  } catch {
    /* 目录不存在 = 首次运行 */
  }
  return result
}

/** 原子写入单个平台缓存 */
export async function savePlatformCache(platform: string, orders: Order[]): Promise<void> {
  const dir = ordersDir()
  await mkdir(dir, { recursive: true })
  const target = fileFor(platform)
  const tmp = `${target}.tmp`
  const payload: CacheFile = {
    version: CACHE_VERSION,
    platform,
    savedAt: Date.now(),
    // 只保留统一模型的字段（防止上游塞入未知/敏感字段）
    orders: orders.map(sanitizeOrder)
  }
  await writeFile(tmp, JSON.stringify(payload), 'utf-8')
  await rename(tmp, target)
}

/** 删除单个平台缓存 */
export async function clearPlatformCache(platform: string): Promise<void> {
  try {
    await unlink(fileFor(platform))
  } catch {
    /* 不存在即视为已清除 */
  }
}

/** 清空全部缓存 */
export async function clearAllCache(): Promise<void> {
  try {
    const files = await readdir(ordersDir())
    for (const file of files) {
      if (file.endsWith('.json') || file.endsWith('.tmp')) {
        await unlink(join(ordersDir(), file)).catch(() => undefined)
      }
    }
  } catch {
    /* 目录不存在 */
  }
}

/** 汇总各平台缓存（给 UI 展示「有 N 单历史」） */
export async function cacheSummary(): Promise<CacheSummary[]> {
  const summaries: CacheSummary[] = []
  try {
    const files = await readdir(ordersDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const platform = basename(file, '.json')
      try {
        const raw = await readFile(join(ordersDir(), file), 'utf-8')
        const data = JSON.parse(raw) as CacheFile
        if (data?.version === CACHE_VERSION && Array.isArray(data.orders)) {
          summaries.push({ platform, count: data.orders.length, savedAt: data.savedAt })
        }
      } catch {
        /* 跳过损坏文件 */
      }
    }
  } catch {
    /* 首次运行 */
  }
  return summaries.sort((a, b) => b.savedAt - a.savedAt)
}

/** 只保留统一模型的已知字段（避免把平台的原始敏感数据写进磁盘） */
function sanitizeOrder(order: Order): Order {
  return {
    platform: order.platform,
    account: order.account,
    orderId: order.orderId,
    createdAt: order.createdAt,
    title: order.title,
    imageUrl: order.imageUrl,
    unitPrice: order.unitPrice,
    paidAmount: order.paidAmount,
    quantity: order.quantity,
    status: order.status,
    shopName: order.shopName,
    receiverName: order.receiverName,
    receiverAddress: order.receiverAddress,
    receiverPhone: order.receiverPhone,
    logisticsCompany: order.logisticsCompany,
    trackingNo: order.trackingNo,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    extra: order.extra
  }
}
