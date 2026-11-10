# 自检脚本

这些脚本用于验证难以用单测覆盖的部分（主进程 IPC、真实网络、平台接口），主进程侧的脚本照常可用。

| 脚本 | 用途 |
|---|---|
| `dev-demo.mjs` | 演示模式：准备隔离 userData（引导完成 + 四平台样例单）→ 以软件渲染启动 dev（`--web` 则浏览器打开），用于「看效果」而不污染真实订单 |
| `login-capability-probe.cjs` | 探测各平台登录能力（是否有二维码接口/登录页路由），产出能力表 |
| `qr-extract-probe.cjs` | 验证二维码提取脚本（SCRIPT_FIND_QR）在淘宝登录页上的表现，产出 `.scratch/` 截图供人眼确认 |
| `taobao-login-probe.cjs` | 淘宝登录取证：原生接口与页面路径的真实返回结构 |
| `net-cookie-probe.cjs` | 验证 `net.request({ session, useSessionCookies })` 能否把 Set-Cookie 写进 partition |
| `dump-platform-api.cjs` | 订单接口取证（诊断用）：用真实分区在隐藏窗口里打开平台订单页，dump 页面自己的订单 XHR/Fetch 响应体 |
| `features-check.cjs` | 验证缓存持久化、诊断快照（含敏感字段泄漏检查）、自动翻页按钮 |
| `round2-check.cjs` | 验证多账号（分区隔离/切换/重命名/删除）、CSV 带 BOM、多 Sheet 导出 |
| `export-ipc-check.cjs` | 走真实导出 IPC，分别验证「导出本平台」与「导出全部」，读回 xlsx 校验行列与表头唯一性 |
| `export-ipc-031.cjs` | 验证 `export:columns` 列清单、多表+汇总+列白名单、CSV 列白名单、零列导出报错 |
| `dump-parsed-orders.mts` | 用真实适配器解析全部 fixture，产出 `.scratch/parsed-orders.json`（上一条脚本的输入） |
| `export-demo.mts` | 纯 Node 端跑「解析 → 建表 → 落 xlsx」，打印各平台抽样，用于快速核对字段 |
| `mitm-spike.mjs` | MITM 可行性验证（早期 spike）：本机起 TLS 代理 + curl 自测；`--install/--restore` 改/还原系统代理与证书 |

## 典型用法

```bash
# 1. 先构建
npx electron-vite build

# 2. 缓存 / 诊断 / 自动翻页
npx electron scripts/features-check.cjs

# 3. 多账号 / CSV / 多 Sheet
npx electron scripts/round2-check.cjs

# 4. 导出两种粒度
npx vite-node scripts/dump-parsed-orders.mts
npx electron scripts/export-ipc-check.cjs

# 5. 导出中心（列选择 / 汇总表 / 导出历史）
npx electron scripts/export-ipc-031.cjs
```

> 本机若设置了 `ELECTRON_RUN_AS_NODE=1`，需先 `env -u ELECTRON_RUN_AS_NODE` 再执行，
> 否则 `require('electron')` 返回的是可执行文件路径而不是 API。

产物落在 `.scratch/`（已 gitignore）。
