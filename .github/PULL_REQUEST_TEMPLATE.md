## 这个 PR 做了什么

<!-- 一句话说清。修 Bug 请附 Issue 编号。 -->

## 检查清单

CI 会逐条跑前四项，本地能过基本就等于能合：

- [ ] `npm run typecheck` 通过（node / preload / web 三个工程）
- [ ] `npm test` 通过，且新增行为有对应测试
- [ ] `npx electron-vite build` 通过
- [ ] 无用户可见变更时，确认不需要改 `CHANGELOG.md`；有变更时已在 `Unreleased` 段加一条

人工确认项：

- [ ] `git diff` 里没有真实订单、Cookie、令牌、账号昵称、本机绝对路径、日志文件或未脱敏截图
- [ ] 解析相关改动附了脱敏夹具或响应片段，并说明字段来自哪个接口
- [ ] 新增平台适配器已注册到 `src/main/platform/registry.ts`，并在 `src/shared/platform-visibility.ts` 里明确启用还是隐藏
- [ ] 没有引入遥测、崩溃上报、远程配置或图表库
- [ ] 没有把 web-bridge 改成监听 `0.0.0.0`

## 界面改动

<!-- 有 UI 改动请贴改动后的截图；没有可删掉本节。 -->
