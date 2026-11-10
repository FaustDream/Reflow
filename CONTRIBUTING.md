# 参与贡献

感谢你愿意花时间。这个项目的维护者只有一个人，所以下面的规则都是为了让一个 PR 尽量一次过。

## 一、怎么跑起来

需要 Node.js 22 或更高。

```bash
npm ci
npm run dev:web
```

打开 <http://localhost:5173>。Electron 主进程由同一命令拉起，抓取能力都走 `127.0.0.1:9478` 的 web-bridge。

- GPU 驱动异常（虚拟机 / RDP）导致 Electron 静默退出：改用 `npm run dev:web:sw`
- 没有平台账号：`npm run dev:web:demo` 会用合成订单起一个隔离的 `userData`（`%TEMP%/reflow-demo`），不会碰你的真实数据
- 不要把 9478 改成 `0.0.0.0`：桥没有环回以外的鉴权

## 二、怎么测

```bash
npm run typecheck   # node + preload + web
npm test            # vitest
npm run build       # 先 typecheck，再 electron-vite build
```

这四条就是 CI 的全部内容，本地全绿基本等于 CI 全绿。

两个容易踩的点：

- **时区**：部分单测断言写死了 `+08:00`，机器不在东八区会失败。PowerShell 里先 `$env:TZ="Asia/Shanghai"`，bash 里 `TZ=Asia/Shanghai npm test`。
- **夹具**：解析相关的测试直接读 `testdata/*.json`。新增夹具请脱敏（订单号、用户 ID、店铺名都要换），不要提交真实响应。

## 三、提 PR 之前的三步自查

1. `npm run typecheck && npm test` 通过，且新增行为有对应测试。
2. `git diff` 里没有真实订单、Cookie、令牌、账号昵称、本机绝对路径、日志文件、截图原图。
3. 有用户可见的行为变更时，在 `CHANGELOG.md` 的 `Unreleased` 段加一条。

## 四、PR 需要满足什么

- **一个 PR 只做一件事。** 顺手重构会和真正的修复混在一起，review 成本翻倍。
- **checklist 与 CI 对齐**：类型检查、单测、构建，三样都要过。
- **抓取 / 解析改动**：附上脱敏后的响应片段或新夹具，说明字段的来自哪个接口。
- **新增平台适配器**：注册进 `src/main/platform/registry.ts`，在 `src/shared/platform-visibility.ts` 里明确「启用还是隐藏」，并至少补一组夹具单测。
- **界面改动**：贴一张改动后的截图。
- **不要引入图表库**：总览里的柱状、环形、仪表、热力都是手写 SVG/CSS，这是刻意的选择。
- **不要引入遥测、崩溃上报、远程配置**：这个项目的卖点是数据不出本机。

## 五、提交信息

中文，动词开头，一行说清「改了什么」，需要时第二段说「为什么」。参考 `git log` 里已有的写法。

## 六、许可

向本仓库提交代码即表示同意以 [MIT](LICENSE) 授权。
