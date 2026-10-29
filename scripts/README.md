# 自检脚本

这些脚本用于**在真实 Electron 环境**中验证难以用单测覆盖的部分（IPC、窗口、真实网络）。
不是常规 CI 的一部分，手动运行。

| 脚本 | 用途 |
|---|---|
| `ui-shot-full.cjs` | 启动真实主进程 → 截图主界面 → 打印平台列表与界面文案，确认布局正确 |
| `login-ui-shot.cjs <平台名>` | 点平台 → 点登录 → 截图登录弹窗，验证二维码是否真的显示出来 |
| `login-capability-probe.cjs` | 探测各平台登录能力（是否有二维码接口/登录页路由），产出能力表 |
| `features-check.cjs` | 验证缓存持久化、诊断快照（含敏感字段泄漏检查）、自动翻页按钮 |
| `round2-check.cjs` | 验证多账号（分区隔离/切换/重命名/删除）、CSV 带 BOM、多 Sheet 导出 |
| `release.mjs` | 发布检查：PII 门禁（testdata/xlsx 不进包）→ 产物 SHA256 → 体积预算 → 更新清单生成 |
| `export-ipc-check.cjs` | 走真实导出 IPC，分别验证「导出本平台」与「导出全部」，读回 xlsx 校验行列与表头唯一性 |
| `gen-mitm-certs.mjs` | 构建期生成 MITM 的 CA 与叶子证书（SAN 覆盖 10 个订单域名）→ `resources/mitm/` |
| `mitm-spike.mjs` | MITM 可行性验证：本机起 TLS 代理 + curl 自测；`--install/--restore` 改/还原系统代理与证书 |
| `dev-demo.mjs` | 演示模式：准备隔离 userData（引导完成 + 三平台样例单）→ 以软件渲染启动 dev，用于「看效果」而不污染真实订单 |
| `ui-shot-031.cjs` | 隔离 userData 灌样例订单 → 截图主界面/筛选/勾选/导出中心/导出记录，验证 031 的 UI 改动 |
| `export-ipc-031.cjs` | 验证 `export:columns` 列清单、多表+汇总+列白名单、CSV 列白名单、零列导出报错 |
| `dump-parsed-orders.mts` | 用真实适配器解析全部 fixture，产出 `.scratch/parsed-orders.json`（上一条脚本的输入） |
| `export-demo.mts` | 纯 Node 端跑「解析 → 建表 → 落 xlsx」，打印各平台抽样，用于快速核对字段 |

## 典型用法

```bash
# 1. 先构建
npx electron-vite build

# 2. 界面与平台列表
npx electron scripts/ui-shot-full.cjs

# 3. 二维码登录（原生接口 / DOM 提取）
npx electron scripts/login-ui-shot.cjs 淘宝
npx electron scripts/login-ui-shot.cjs 京东
npx electron scripts/login-ui-shot.cjs 拼多多
npx electron scripts/login-ui-shot.cjs 快手小店

# 4. 缓存 / 诊断 / 自动翻页
npx electron scripts/features-check.cjs

# 5. 多账号 / CSV / 多 Sheet
npx electron scripts/round2-check.cjs

# 6. 导出两种粒度
npx vite-node scripts/dump-parsed-orders.mts
npx electron scripts/export-ipc-check.cjs

# 7. 导出中心（列选择 / 汇总表 / 导出历史）
npx electron scripts/export-ipc-031.cjs
npx electron scripts/ui-shot-031.cjs
```

> 本机若设置了 `ELECTRON_RUN_AS_NODE=1`，需先 `env -u ELECTRON_RUN_AS_NODE` 再执行，
> 否则 `require('electron')` 返回的是可执行文件路径而不是 API。

产物落在 `.scratch/`（已 gitignore）。
