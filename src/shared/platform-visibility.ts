/**
 * 平台可见性：哪些适配器「注册了但不在界面单列」。
 *
 * 只放技术性隐藏：
 * - `mock`：仅验证面板用
 * - `xianyu-sold`：闲鱼卖家视角，并入「闲鱼」同一个页面（买/卖切换）
 * - `meituan-platform`：美团综合订单（酒店/电影/团购）。2026-10-29 实测确认
 *   **C 端没有可用的 Web 入口**（详情见 `src/main/platform/meituan-platform.ts` 文件头），
 *   网页通道抓不到任何数据，先隐藏避免空壳误导；适配器代码保留，将来美团若开放入口
 *   或走 MITM 抓 App 时，从这里移出即可恢复。
 *
 * 2026-10-29 用户决定**只留 4 个购物平台**（闲鱼 / 京东 / 淘宝 / 拼多多），
 * 外卖类全部下架：
 * - `meituan`（美团外卖）：适配器代码保留（`meituan.ts`），只是不在界面单列。
 *   历史抓到的订单仍在本地缓存里，只是不再计入顶部合计与总览统计。
 *
 * 2026-10-27 已下架并删除代码的平台：淘宝闪购（eleme）、快手小店（kuaishou）、
 * 得物（dewu）、1688（ali1688）。若将来要恢复，从 git 历史找回适配器文件重新注册即可。
 */
export const HIDDEN_PLATFORMS: ReadonlySet<string> = new Set([
  'mock',
  'xianyu-sold',
  'meituan-platform',
  'meituan'
])

export function isHiddenPlatform(platformId: string): boolean {
  return HIDDEN_PLATFORMS.has(platformId)
}
