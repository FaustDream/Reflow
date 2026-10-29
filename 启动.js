/**
 * 兼容旧入口：真正的实现在 `launch.js`。
 *
 * 为什么不把逻辑留在这里 —— Windows 快捷方式（.lnk）的参数里，
 * 中文文件名会被写坏（实测 `"D:\reflow\reflow\启动.js"` 存进去后
 * 「启动」两个字丢失，双击毫无反应）。快捷方式必须指向 ASCII 路径。
 *
 * 手动启动时用哪个都行：`electron.exe 启动.js` 和 `electron.exe launch.js` 等价。
 */
require('./launch.js')
