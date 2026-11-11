# 参与贡献

感谢你愿意花时间。维护者只有一个人，下面这些规则都是为了让一个 PR 尽量一次过。

## 一、怎么跑起来

需要 Node.js 22 或更高。

```bash
npm ci
npm run dev:web          # 打开 http://localhost:5173
```

Electron 主进程由同一命令拉起，抓取能力都走 `127.0.0.1:9478` 的 web-bridge。

- GPU 驱动异常（虚拟机 / RDP）导致 Electron 静默退出：改用 `npm run dev:web:sw`
- 没有平台账号：`npm run dev:web:demo` 会用合成订单起一个隔离的 `userData`（`%TEMP%/reflow-demo`），不碰真实数据
- 不要把 9478 改成 `0.0.0.0`：桥没有环回以外的鉴权

## 二、怎么测

```bash
npm run typecheck   # node + preload + web
npm test            # vitest
npm run build       # 先 typecheck，再 electron-vite build
```

这三条就是 CI 的全部内容，本地全绿基本等于 CI 全绿。

两个容易踩的点：

- **时区**：部分单测断言写死了 `+08:00`，不在东八区会失败。bash 里 `TZ=Asia/Shanghai npm test`，PowerShell 里先 `$env:TZ="Asia/Shanghai"`。
- **夹具**：解析相关的测试直接读 `testdata/*.json`。新增夹具请脱敏（订单号、用户 ID、店铺名都要换），不要提交真实响应。

## 三、打包与发版

```bash
npm run build:win      # dist-release/ 下出安装包与免安装版
npm run build:mac      # 须在 macOS 上执行
npm run build:linux    # 须在 Linux 上执行
```

正式发布由 CI 完成，不要手工上传产物：

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部把 `Unreleased` 段整理成该版本并补日期。
2. 提交并推 tag：`git tag v1.0.0 && git push origin v1.0.0`。
3. `.github/workflows/release.yml` 会校验 tag 与 `package.json` 是否一致，然后构建 Windows 产物（安装包 + 免安装版）、生成 `SHA256SUMS.txt`、按 CHANGELOG 生成说明并创建 Release。mac/linux 的打包脚本保留在本机使用，不进发布流水线。

## 四、提 PR 之前

1. `npm run typecheck && npm test` 通过，且新增行为有对应测试。
2. `git diff` 里没有真实订单、Cookie、令牌、账号昵称、本机绝对路径、日志文件、截图原图。
3. 有用户可见的行为变更时，在 `CHANGELOG.md` 的 `Unreleased` 段加一条。

PR 还需要满足：

- **一个 PR 只做一件事。** 顺手重构会和真正的修复混在一起，review 成本翻倍。
- **抓取 / 解析改动**：附上脱敏后的响应片段或新夹具，说明字段来自哪个接口。
- **新增平台适配器**：注册进 `src/main/platform/registry.ts`，在 `src/shared/platform-visibility.ts` 里明确「启用还是隐藏」，并至少补一组夹具单测。
- **界面改动**：贴一张改动后的截图。
- **不要引入图表库**：总览里的柱状、环形、仪表、热力都是手写 SVG/CSS，这是刻意的选择。
- **不要引入遥测、崩溃上报、远程配置**：这个项目的卖点是数据不出本机。

## 五、提交信息

中文，动词开头，一行说清「改了什么」，需要时第二段说「为什么」。参考 `git log` 里已有的写法。

## 六、许可

向本仓库提交代码即表示同意以 [MIT](LICENSE) 授权。
