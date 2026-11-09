/**
 * IconPark 单色图标（字节跳动开源，Apache-2.0）。
 *
 * 统一规格：48 网格、stroke-width 4、`stroke="currentColor"` —— 跟随 el-icon 的
 * 1em 尺寸与父元素文字颜色，与 Element Plus 图标完全互换（组件名保持一致，
 * 模板无需改动）。生成来源：`iconpark.py get <name> --mode mono --color currentColor`。
 *
 * 同一套视觉语言下新增图标：到 iconpark.oceanengine.com 选好后在
 * assets/icons/ 导出 SVG，把 <path> 内容追加进这里即可。
 */
import { h, type FunctionalComponent } from 'vue'

const make = (inner: string): FunctionalComponent =>
  (() =>
    h('svg', {
      viewBox: '0 0 48 48',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      innerHTML: inner
    })) as FunctionalComponent

/** 搜索（放大镜）—— 筛选条 */
export const Search = make(
  `<path d="M21 38C30.3888 38 38 30.3888 38 21C38 11.6112 30.3888 4 21 4C11.6112 4 4 11.6112 4 21C4 30.3888 11.6112 38 21 38Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M26.657 14.3431C25.2093 12.8954 23.2093 12 21.0001 12C18.791 12 16.791 12.8954 15.3433 14.3431" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33.2216 33.2217L41.7069 41.707" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 刷新 —— 侧栏重新加载 */
export const Refresh = make(
  `<path d="M42 8V24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 24L6 40" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 24C42 14.0589 33.9411 6 24 6C18.9145 6 14.3216 8.10896 11.0481 11.5M6 24C6 33.9411 14.0589 42 24 42C28.8556 42 33.2622 40.0774 36.5 36.9519" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 加载 —— 进行中指示（配合旋转动画使用） */
export const Loading = make(
  `<path d="M4 24C4 35.0457 12.9543 44 24 44V44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 24C36 17.3726 30.6274 12 24 12C17.3726 12 12 17.3726 12 24C12 30.6274 17.3726 36 24 36V36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 向下小箭头 —— 工具菜单下拉 */
export const ArrowDown = make(
  `<path d="M24.0083 35.8995V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 24L24 36L12 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 仪表盘 —— 数据总览入口 */
export const DataAnalysis = make(
  `<path d="M8.44365 41.5564C4.46243 37.5751 2 32.0751 2 26C2 13.8497 11.8497 4 24 4C36.1503 4 46 13.8497 46 26C46 32.0751 43.5376 37.5751 39.5564 41.5564" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.1005 35.8995C11.567 33.366 10 29.866 10 26C10 18.268 16.268 12 24 12" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M24 26V18" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 运行日志 —— 侧栏日志入口（列表点线形） */
export const Logs = make(
  `<circle cx="9" cy="12" r="2.6" fill="currentColor"/><circle cx="9" cy="24" r="2.6" fill="currentColor"/><circle cx="9" cy="36" r="2.6" fill="currentColor"/><path d="M18 12H42" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M18 24H42" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M18 36H42" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`
)

/** 向上箭头 —— 列顺序上移（与 ArrowDown 同一几何，方向相反） */
export const ArrowUp = make(
  `<path d="M24.0083 12.1005V36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 24L24 12L36 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)

/** 列顺序 —— 表格列设置入口（表头行 + 左侧竖列） */
export const ColumnOrder = make(
  `<rect x="5" y="9" width="9" height="30" rx="2.5" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M22 13H43" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M22 24H43" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M22 35H43" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`
)

/** 拖拽手柄 —— 列顺序列表的抓取点（两列圆点） */
export const DragHandle = make(
  `<circle cx="18" cy="14" r="3" fill="currentColor"/><circle cx="18" cy="24" r="3" fill="currentColor"/><circle cx="18" cy="34" r="3" fill="currentColor"/><circle cx="30" cy="14" r="3" fill="currentColor"/><circle cx="30" cy="24" r="3" fill="currentColor"/><circle cx="30" cy="34" r="3" fill="currentColor"/>`
)
