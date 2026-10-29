/**
 * 应用身份信息：作者水印与项目主页的唯一来源。
 *
 * 为什么单独抽一个文件 —— 状态栏、关于对话框、导出文件元数据都要用，
 * 分散写死容易出现「界面改了、导出还是旧署名」。
 *
 * 注意：这里用的是 GitHub 账号名，不是真实姓名。仓库是公开的，
 * 水印只用来标明来源、避免被抹掉作者后二次分发，不承载任何个人身份信息。
 */
export const APP_NAME = 'Reflow'
export const APP_NAME_CN = '回流'

/** 作者署名（GitHub 账号） */
export const AUTHOR = 'FaustDream'

/** 项目主页 */
export const REPO_URL = 'https://github.com/FaustDream/Reflow'

/** 写进导出文件元数据 / 关于页的完整署名 */
export const SIGNATURE = `${APP_NAME} by ${AUTHOR} · ${REPO_URL}`
