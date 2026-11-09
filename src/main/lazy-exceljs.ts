/**
 * exceljs 按需加载（2026-11-02 启动优化）。
 *
 * `require('exceljs')` 实测约 600ms —— 对一个「打开就要看到订单」的桌面应用来说，
 * 这笔钱花在每次启动上很不划算：导出/导入是低频动作，绝大多数启动根本用不到。
 *
 * 所以全项目只在**真正要用 exceljs 的那一刻**通过这里加载，一次运行内复用同一个
 * Promise（并发导出不会重复加载）。主进程首屏因此少 ~600ms。
 *
 * 注意：本文件只允许 `import type` 引 exceljs 类型 —— 任何值导入都会把它拖回启动路径，
 * 优化立即归零。
 */

export type ExcelJSModule = typeof import('exceljs')

let exceljsPromise: Promise<ExcelJSModule> | null = null

export function loadExcelJS(): Promise<ExcelJSModule> {
  if (!exceljsPromise) {
    // CJS 产物下 `import('exceljs')` 的命名空间形状随打包器/加载器而变：
    // 有 default 就用 default，没有就整体当模块用（两种都实测可用）
    exceljsPromise = import('exceljs').then(
      (m) => ((m as unknown as { default?: ExcelJSModule }).default ?? m) as ExcelJSModule
    )
  }
  return exceljsPromise
}

/** 便捷入口：拿到 `new Workbook()` 用的构造器（绝大多数调用方只需要这个） */
export async function loadWorkbookCtor(): Promise<ExcelJSModule['Workbook']> {
  return (await loadExcelJS()).Workbook
}
