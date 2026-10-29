/**
 * 平台可见性：哪些适配器「注册了但不在界面单列」。
 *
 * 只放技术性隐藏：
 * - `mock`：仅验证面板用
 * - `xianyu-sold`：闲鱼卖家视角，并入「闲鱼」同一个页面（买/卖切换）
 *
 * 2026-10-27 已下架并删除代码的平台：淘宝闪购（eleme）、快手小店（kuaishou）、
 * 得物（dewu）、1688（ali1688）。若将来要恢复，从 git 历史找回适配器文件重新注册即可。
 */
export const HIDDEN_PLATFORMS: ReadonlySet<string> = new Set(['mock', 'xianyu-sold'])

export function isHiddenPlatform(platformId: string): boolean {
  return HIDDEN_PLATFORMS.has(platformId)
}
