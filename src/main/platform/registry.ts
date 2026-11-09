/**
 * 工单 003：适配器注册表。
 * - 按 id 注册 / 查询；重复注册抛错（防止两个平台撞 id 静默覆盖）；
 * - 按「URL + method + 请求形态」路由到适配器（捕获引擎 005 的路由核心）；
 * - 全部平台在这里集中注册（006 起每平台一行）。
 */
import type { CaptureKind } from '../../shared/types'
import { matchRuleMatches, type MatchRule, type PlatformAdapter } from './adapter'
import { mockAdapter } from './mock-adapter'
import { xianyuAdapter } from './xianyu'
import { jdAdapter } from './jd'
import { taobaoAdapter } from './taobao'
import { pddAdapter } from './pdd'
import { meituanAdapter } from './meituan'
import { meituanPlatformAdapter } from './meituan-platform'

export interface RoutedCapture {
  adapter: PlatformAdapter
  rule: MatchRule
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>()

  /** 注册适配器；id 重复抛错 */
  register(adapter: PlatformAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`平台适配器 id 冲突：'${adapter.id}' 已注册`)
    }
    if (!adapter.matchRules.length) {
      throw new Error(`适配器 '${adapter.id}' 未声明任何 matchRules`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): PlatformAdapter[] {
    return [...this.adapters.values()]
  }

  /** 按 URL 路由；命中多条规则时取最先注册平台的第一条命中规则（声明顺序即优先级） */
  route(url: string, method?: string, kind?: CaptureKind): RoutedCapture | null {
    for (const adapter of this.adapters.values()) {
      const rules = this.rulesFor(adapter)
      for (const rule of rules) {
        if (matchRuleMatches(rule, url, method, kind)) return { adapter, rule }
      }
    }
    return null
  }

  /** 当前生效的匹配规则 */
  rulesFor(adapter: PlatformAdapter): MatchRule[] {
    return adapter.matchRules
  }
}

/** 主进程全局注册表单例。 */
export const adapterRegistry = new AdapterRegistry()

/** 集中注册所有内置平台。新增平台在此追加一行（注册顺序即 URL 路由优先级）。 */
export function registerBuiltinAdapters(registry: AdapterRegistry = adapterRegistry): void {
  // mock 仅供「验证面板」演示，不占平台 Tab（渲染层过滤）
  registry.register(mockAdapter)
  registry.register(xianyuAdapter)
  registry.register(jdAdapter)
  registry.register(taobaoAdapter)
  registry.register(pddAdapter)
  // 美团规则为域名宽匹配（wx.waimai.meituan.com），靠响应结构 digestlist 判定，必须最后注册
  registry.register(meituanAdapter)
  registry.register(meituanPlatformAdapter)
}
