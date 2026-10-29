# 回流 Reflow

把散落在各电商平台的订单数据，回流到你自己手上。

整合自 5 个独立的「魔猫」系订单导出工具（京东 / 拼多多 / 淘宝·1688 / 闲鱼 / 魔猫g 多平台），
合并为单一安装包；早期覆盖 8+ 平台，现收敛为 4 个购物平台的订单捕获与 Excel/CSV 导出。

> **当前在用的 4 个平台**：闲鱼（买/卖）、京东、淘宝、拼多多。
>
> **已下架**：美团外卖（2026-10-29，用户要求「只留 4 个购物平台」）、
> 淘宝闪购（原饿了么，网页端已无可用登录入口）、快手小店、得物、1688（2026-10-27）。
> 适配器代码与已抓订单都保留，只是不在界面显示；
> 要恢复某个平台，把它从 `src/shared/platform-visibility.ts` 的 `HIDDEN_PLATFORMS` 里删掉即可。

> 开发过程中的工单记录（决策依据、平台改版取证过程）**未随仓库发布**，
> 代码注释里保留了关键结论，够看懂为什么这么写。

> **许可**：可自由使用与修改，**保留作者署名、禁止商业售卖**。
> 详见 [LICENSE](LICENSE)。作者：**FaustDream** · [项目主页](https://github.com/FaustDream/Reflow)

---

## 下载

最新版在 [Releases](https://github.com/FaustDream/Reflow/releases/latest)：

| 你的系统 | 选这个 |
|---|---|
| Windows 10/11 | `Reflow-x.y.z-win-x64.exe`（安装包，装到当前用户目录，**不需要管理员**）或 `Reflow-x.y.z-portable.exe`（免安装） |
| macOS（Apple Silicon / M 系列） | `Reflow-x.y.z-mac-arm64.dmg` |
| macOS（Intel） | `Reflow-x.y.z-mac-x64.dmg` |
| Linux（Debian / Ubuntu） | `Reflow-x.y.z-linux-amd64.deb` |
| Linux（通用） | `Reflow-x.y.z-linux-x86_64.AppImage`（`chmod +x` 后直接运行） |

安装包**未做代码签名**：Windows 首次运行会弹 SmartScreen，点「更多信息 → 仍要运行」；
macOS 首次打开要右键 →「打开」。各文件的 SHA256 见 Release 页的 `SHA256SUMS.txt`。

---

## 界面

**一屏搞定**：左侧平台列表 + 右侧当前平台的订单表，没有多层 Tab。

```
┌──────────────────────────────────────────────────────────────┐
│ 回流 Reflow                                   共 128 单 [导出] │
├──────────┬───────────────────────────────────────────────────┤
│ 平台 8 个 │ 闲鱼 [买到的|卖出的] 已登录  [打开页面][抓取订单]   │
│ 闲鱼 32单●│ ┌───────────────────────────────────────────────┐ │
│ 京东 18单●│ │ 图  订单号    商品     实付  数量  状态 …      │ │
│ 淘宝 25单●│ │ …                                             │ │
│ 拼多多 12单●│ └───────────────────────────────────────────────┘ │
│ 得物  8单●│                                                   │
│ 快手小店 6单●│                                                │
│ 饿了么 11单●│                                                │
│ 美团外卖 7单●│                                                │
└──────────┴───────────────────────────────────────────────────┘
```

左侧列表只有平台与订单数，**不挂任何登录/清空按钮**（清空收进顶部「工具」菜单）；
登录入口在点开「打开页面」之后的页面面板里。

**筛选条**：搜索（订单号/商品/店铺/收货人/运单号/状态）+ 时间范围（全部 / 7 / 30 / 90 天）+
状态下拉（只列该平台真实出现过的状态，带条数）+ 重置；右侧常显 `n 单 · 合计 ¥x`。

**导出两种粒度**：
- **导出本平台** — 只导出当前选中平台（**含当前筛选结果**），列只含该平台的扩展列
- **导出勾选** — 表格勾选若干行后可只导这些行，实时显示 `已选 n 单 · ¥x`

> 2026-10-26 决策：不再提供「全部平台合并导出」。跨平台合并会让列语义打架（同名不同义），
> 各平台本来就应该各导各的 —— 这也更贴近原版。

**页面分栏（原版作法）**：点「打开页面」在右侧停靠平台真实页面（边逛边抓），可收起。
收起后 webview **移到窗口外但保持 1280×900 正常视口**（不是 1px）——1px 会让页面懒加载
与 IntersectionObserver 失效，后台翻页就抓不到东西；配合 `backgroundThrottling=no`
保证定时器/rAF 不被降频。抓取全程在后台跑，**不再自动弹出页面**。

**抓取两种通道**：
- **接口翻页**（闲鱼/京东/淘宝/1688）：走页面官方 SDK 或页面内同源请求逐页取，页面无需可见
- **后台翻页**（拼多多/得物/快手/饿了么/美团）：这些平台没有可复用的官方接口，
  在隐藏页面里触发它自己的加载逻辑，同样不弹页面给用户看

## 登录：不用打开一堆登录网页

登录入口在**顶部工具栏**，不需要先打开页面：

- 未登录 → 一个「登录」按钮；已登录 → 账号名标签可点开（重新登录 / 退出登录）
- 点「登录」按平台能力自动分流：
  - **淘宝 / 闲鱼 / 1688**（原生二维码接口）→ 直接弹二维码窗，不加载页面
  - **京东 / 拼多多 / 快手** → 自动展开页面面板并导航到平台登录页，扫页面里那唯一一张码
  - **得物 / 饿了么 / 美团** → 同上（网页端没有登录二维码，只能页面里登录）

| 方式 | 平台 | 做法 |
|---|---|---|
| **原生二维码接口** | 淘宝 / 闲鱼 / 1688 | 直接调阿里 `qrlogin.taobao.com` 接口。无页面渲染；扫码成功后 Set-Cookie 自动写入对应 partition（已实测验证） |
| **页面内扫码** | 京东 / 拼多多 / 快手 | 登录页就在右侧页面面板里，扫码后页面自己完成跳转与 Cookie 写入 |
| **小窗登录** | 得物 / 饿了么 / 美团 | 这些平台网页端**确实没有登录二维码**，退而在 520×680 小窗口打开其官方登录页，登录完成自动关闭 |

> 原版魔猫的主窗口**本身就是一个最大化的内嵌浏览器**，登录页就是主界面，
> 压根没有「先打开页面」这一步。我们把页面做成了可收起的侧栏，
> 所以让登录动作自己负责「展开面板 + 导航到登录页」，行为上对齐原版。

> **京东这类为什么不再弹「只看二维码」的窗**：它们的扫码状态靠 `QRCodeKey` 这一个
> Cookie 关联，而弹窗的隐藏窗口与页面面板共用同一个 partition —— 两个页面各有一张码，
> 会互相覆盖 `QRCodeKey`。手机端提示扫码成功，PC 端永远等不到确认，
> 表现就是「扫码成功但没反应」（2026-10-26 用户实测）。所以这类平台只保留页面里那一张码。
>
> 弹窗侧的状态回传也补了：二维码被页面换新时会把新图推给界面
> （`QrLoginStatus.qrImage`），并回传「已扫描，请在手机上确认」——
> 否则用户看到的永远是第一张、扫的是作废的码。

**登录成功之后全自动**：`login.loggedIn` 由 false 变 true 时统一收尾 ——
自动收起页面面板 → webview 导航到订单页 → 后台全量抓取（不弹页面、不用再点按钮）。
弹窗扫码和页面内扫码都收敛到这一个 watch，所以两条路都不会漏。

### 为什么剩 3 个做不到纯二维码（实测证据）

| 平台 | 实测结果 |
|---|---|
| 得物 | `m.dewu.com/login` 502；`www.dewu.com` 只有「扫码下载 App」的二维码，**没有登录码** |
| 饿了么 | `h5.ele.me/login` 已是空壳页（无 JS、无二维码元素）；`tb.ele.me` 返回 404；必须走淘宝闪购/小程序 |
| 美团 | `passport.meituan.com` 只提供手机动态码/账号密码登录，无二维码入口 |

策略表在 `src/main/qr-login.ts`，有 11 条回归测试固化上述分类（防止以后误改）。
实测脚本：`scripts/login-probe*.cjs`（能力探测）、`scripts/login-ui-shot.cjs <平台名>`（UI 验证）。

## 抓取通道：注入（默认）+ MITM（可选）

| 通道 | 原理 | 覆盖 | 代价 |
|---|---|---|---|
| **WebView 注入**（默认） | 平台页面里挂 preload，拦页面自己发出的 XHR/fetch/JSONP | 全部平台 | 页面得在跑（可移到窗口外后台跑） |
| **MITM**（可选） | 改系统代理 + 装本地根证书，解密订单域名流量 | 白名单 10 个订单域名（含拼多多） | 需装证书、改系统代理（可一键还原） |

两条通道最终都进**同一个捕获引擎**（路由 → 解析 → 去重 → 导出），适配器不用写第二遍。

启用：**工具 → 抓取通道（MITM）** → 安装证书 → 开启 MITM 抓取。
「测试通道」只在本机临时起代理走一遍 CONNECT→TLS→GET，**不装证书、不改系统代理**，可随时点。

安全边界：只解密白名单域名（其余隧道透传）、只观察不改写、证书只装「当前用户」、
退出/崩溃自动还原代理。证书由 `node scripts/gen-mitm-certs.mjs` 生成到 `resources/mitm/`
（`ca.key` 不进安装包）。

## 抓取：进平台就自动开抓（原版作法）

切到**已登录**（或已有历史订单）的平台后，页面就绪即自动导航到订单页并开始抓取，
不需要点任何按钮；抓取期间页面分栏自动展开、顶部显示进度条（可随时停止）。

| 平台 | 翻页方式 |
|---|---|
| 京东 | 页面内逐年切换时间范围 + 每年点「下一页」（订单页已 SPA 化，数据靠被动捕获） |
| 淘宝 | 原版作法：mtop 按月分页循环 |
| 闲鱼 | 代码侧 mtop 分页（列表 → 详情两段） |
| 得物/快手/饿了么/美团/拼多多 | 模拟滚动加载（连续 6 次无新内容自动停） |

> **平台显示可自定义**：工具 →「显示的平台」勾选，选择存在本地
> （`localStorage.reflow.visible-platforms`，全选等价于未设置）。
> 取消勾选只隐藏左侧入口，已抓订单仍留在本地。
> 1688 已恢复显示（2026-10-26），抓取走原版「点下一页」+ 官方 50 列导出。

## 本地缓存

订单自动存到 `%APPDATA%/回流 Reflow/orders/<platform>.json`：

- 按平台分文件，单个损坏不影响其他
- 原子写入（先 `.tmp` 再 rename），断电不留半个文件
- **只存统一模型的订单字段**，不存 Cookie/令牌（D-4 隐私门禁）
- 关应用前 flush 待写数据；「清空」会一并删磁盘缓存

## 账号：每个平台一个

每个平台**只保留一个账号**（2026-10-26 用户要求：多账号太复杂，去掉）。

- 会话分区固定为 `persist:platform-<id>`，与 `watchCookieLogin` 监听的 session **完全一致**；
  登录写进去的 Cookie 立刻被监听到，界面同步变「已登录」。
- 登录入口只有一处：点「打开页面」后，页面面板头部的「扫码登录」（或直接在页面里登录）。
- 曾经的多账号（`persist:platform-<id>-1`…）已停用。它有两个真实故障：
  1. 登录写进 `-1` 分区，而登录态监听只看 `persist:platform-<id>` → **扫码成功却一直显示未登录**；
  2. 活动槽位只存在内存里，重启归零，webview 又切回 slot 0 → 登录态凭空消失。
- `accounts.json` 与相关 IPC 保留（不参与分区选择），删掉旧条目不影响使用。

## 导出

点「导出全部」或「导出本平台」打开**导出中心**（`components/export/ExportDialog.vue`）：

| 选项 | 说明 |
|---|---|
| **范围** | 当前平台（**已应用筛选**）/ 表格勾选 —— **不做跨平台合并**（按平台各自导出，2026-10-26 决策） |
| **Excel 单表** | 所有平台合并到一张表，跨平台列冲突自动消歧 |
| **Excel 多表** | 每个平台一张工作表，可附带「汇总」表（单数 / 实付合计 / 时间范围 + 合计行） |
| **CSV** | 带 UTF-8 BOM（Excel 直接打开中文不乱码）、RFC 4180 转义 |
| **列选择** | 声明了原版列序的平台（闲鱼 17 / 京东 15 / 拼多多 25）显示为「平台列（原版列序）」；其余平台是核心列 19 + 扩展列分组 |
| **含图** | 内嵌 60×60 缩略图，带下载进度与失败计数（不再「点了没反应」） |

导出的表带**自动筛选**（表头）与**冻结首行首列**；列勾选、含图开关记在 localStorage。
「工具 → 导出记录」可回看最近 20 次导出（只记路径/行数/平台/时间，不含订单内容），
下次保存对话框默认停在上次导出的目录。

## 包体积

renderer bundle：JS **511KB**、CSS **141KB** —— Element Plus 按需引入（unplugin-vue-components）。

打包后实测（v0.2.0，electron 44.7）：`app.asar` **21.5MB**（exceljs + @jsquash wasm 占大头）、
NSIS 安装包 **114.7MB**、免安装版 **114.4MB**、Linux tar.gz **129.7MB**。
体积预算 130MB，超了 `scripts/release.mjs` 会以非零码退出。

## 首次启动引导

首次打开显示一屏说明：数据只在本机、不需要证书/管理员权限、SmartScreen 提示，
并可选常用平台（之后左侧只显示这些平台，可随时改）。完成后不再打扰。

## 订单不够全？用官方导出导入

网页端订单列表往往只是子集（实测美团 h5 滚到底 78 单，淘宝订单页走 SPA）。
要拿全量，最稳的做法是让平台自己导出：

1. 点左侧平台旁的刷新图标 **或** 打开该平台页面
2. 在平台页面里用它的「导出订单」功能（淘宝：已买到的宝贝 → 导出订单）
3. 回到应用：「工具 → 导入订单文件…」选刚导出的 xlsx / csv

导入的订单直接并进本地库（按订单号去重、按时间倒序），**下次启动自动恢复，不会重复拉取**。
表头做了模糊匹配，`订单编号 / 商品标题 / 实付款 / 订单创建时间 / 店铺名称` 这类列名都能识别，
金额里的 `¥` 和千分位逗号会自动清掉。

每个平台左侧还有一个**独立的刷新按钮**：滚动型平台（拼多多/美团/京东）跑在隐藏窗口里，
抓取期间可以随意切换其它平台，互不打断。

## 诊断

标题栏「诊断」按钮输出只读快照：版本、适配器状态、登录能力、缓存情况、内存订单数、最近解析错误。
**不含 Cookie / 令牌 / 订单内容 / 收货地址**（有自动化检查断言这一点）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 宿主 | Electron | 决策 D-E：需要 `webview` + per-webview preload 注入能力 |
| 构建 | electron-vite 5 + Vite 7 | ⚠ electron-vite@5 **不支持 Vite 8**，勿升级 vite 到 8.x |
| 分发 | electron-builder 26 | Windows / macOS / Linux 三平台，产物在 `dist-release/` |
| 前端 | Vue 3 + TypeScript + Element Plus | |
| 语言 | TypeScript **5.9** | ⚠ vue-tsc 3.x 未适配 TypeScript 7，勿升级 |

## 快速开始

需要 **Node.js 18+**（推荐 20 / 22）。

```bash
git clone https://github.com/FaustDream/Reflow.git
cd Reflow
npm install
npm run dev:sw
```

`dev:sw` 走软件渲染，没有独立显卡的机器、虚拟机、远程桌面都能正常起窗口；
有正常显卡时可以试 `npm run dev`（启动更快，但 GPU 驱动异常时会直接崩在 `GPU process isn't usable`）。

首次运行**不需要任何配置**：登录态、订单缓存都落在本机 `%APPDATA%\回流 Reflow`，
每个平台首次点「登录」扫码即可，订单会自动抓取。

> **MITM 抓取通道是可选的**，默认走页面自带的官方 SDK，不需要证书。
> 仓库只带公钥（`ca.crt` / `leaf.crt`），私钥不入库 —— 想用 MITM 通道时
> 跑一次 `node scripts/gen-mitm-certs.mjs` 生成本机证书，再到「工具 → 抓取通道」里装。

## 开发

```bash
npm install
npm run dev          # 热重载开发
npm run dev:demo     # 带样例订单的隔离演示实例（userData 指向 %TEMP%/reflow-demo，不碰真实数据）
npm run dev:sw       # 无 GPU 的虚拟机/远程桌面：改用软件渲染启动（否则 GPU 进程会崩）
node scripts/gen-mitm-certs.mjs   # 生成 MITM 证书（可选通道，私钥不入库，需自己跑）
npm run typecheck    # node + preload + web 三份类型检查
npm run icon         # 重新生成应用图标（build/icons/reflow.ico，多尺寸）
npm run shortcut     # 重建桌面 / 开始菜单快捷方式（带图标）
```

开发态启动入口是根目录的 `launch.js`：它用 `electron-vite dev` 直接跑源码，
改代码即时生效，不需要先构建。

桌面快捷方式「回流 Reflow」指向 `electron.exe launch.js`：`electron.exe` 是 GUI 子系统
程序不会弹控制台，`launch.js` 以 Electron 主进程身份运行、**不建窗口**，只负责拉起 dev
server 并常驻，用户关掉应用后它自己退出。

> `启动.js` 只是转发到 `launch.js` 的兼容壳 —— `.lnk` 的参数里中文会被写坏
> （`"D:\reflow\reflow\启动.js"` 存进去后「启动」两个字丢失、双击毫无反应），
> 所以快捷方式必须指向 ASCII 路径。

`out/` 是 electron-vite 的构建产物目录：开发时由 vite 现编主进程/preload，
`npm run build` 会产出可分发版本（含 `out/renderer`），删掉都会自己长回来。

## 打包（三平台）

产物统一落在 `dist-release/`（已 gitignore）。

```bash
npm run build:win     # Windows：NSIS 安装包 + 免安装 portable
npm run build:mac     # macOS：dmg + zip（x64 / arm64）
npm run build:linux   # Linux：AppImage + deb
npm run build:unpack  # 只解包不封装，用来快速验证产物
```

⚠ **macOS 的 .app/.dmg 只能在 macOS 上构建**（electron-builder 会直接拒绝：
`Build for macOS is supported only on macOS`）；Linux 的 AppImage 需要 Linux 侧的
`mksquashfs`。在 Windows 上能完整打出的只有 Windows 包，以及 Linux 的 `tar.gz` 便携包：

```bash
npx electron-builder --linux tar.gz
node scripts/fix-linux-tar.mjs "dist-release/Reflow-0.2.0-linux-x64.tar.gz"
```

Windows 宿主打出的 tar 不保留可执行位，第二步会把 `reflow` / `chrome-sandbox` /
`chrome_crashpad_handler` 改成 0755 —— 不做这步，Linux 上解压后双击毫无反应。

要在非 macOS 机器上出 mac/Linux 原生产物，用仓库里的 GitHub Actions：
`.github/workflows/build.yml`（Actions → 打包三平台 → Run workflow），
三个 runner 分别产出 win/mac/linux，产物在当次运行的 Artifacts 里。

### 打包时容易踩的坑

- **`files` 里不要排除 `node_modules/**/doc/**`**：exceljs 的模块就叫
  `exceljs/lib/doc/workbook.js`，排掉之后主进程 `require('exceljs')` 直接崩 ——
  表现是双击后只弹一个 "Error" 对话框、主窗口根本不出现。
- **国内网络**：electron 与 electron-builder 的二进制默认走 GitHub，拉不动时设
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- **MITM 证书**：`resources/mitm/*.key` 不入库，打包前若没有就先跑
  `node scripts/gen-mitm-certs.mjs`，否则装出来的包「工具 → 抓取通道（MITM）」装不了证书
  （WebView 注入通道不受影响，抓取照常）。
- **未签名**：Windows 首次运行会弹 SmartScreen「Windows 已保护你的电脑」→ 更多信息 → 仍要运行；
  macOS 首次打开要右键「打开」，或执行
  `xattr -dr com.apple.quarantine "/Applications/回流 Reflow.app"`。
- **MITM 只有 Windows 实现**：macOS / Linux 上改系统代理与装根证书需要提权，
  与「不要管理员权限」的约束冲突，界面上会直接显示不支持；抓取与导出照常可用。
- **Linux 沙箱**：解压 tar.gz 后若报 `The SUID sandbox helper binary was found, but is not
  configured correctly`，用 `./reflow --no-sandbox` 启动（Ubuntu 23.10+ 默认禁用了非特权
  user namespace）。

### 发版流程（版本管理）

版本号只有一个来源：`package.json` 的 `version`；发版说明只有一个来源：`docs/CHANGELOG.md`。

1. 改 `package.json` 的 `version`，并在 `docs/CHANGELOG.md` 顶部加一段
   `## x.y.z（YYYY-MM-DD）`（同时更新文件顶部「当前版本」摘要）
2. 提交：`git commit -am "release: v0.2.1"`
3. 打 tag 并推送：`git tag v0.2.1 && git push origin main --tags`
4. Actions 自动跑完：三平台构建 → 校验 tag 与 `version` 一致 → 从 CHANGELOG 截取发布说明
   → 生成 `SHA256SUMS.txt` → 创建 Release 并上传全部产物

tag 与 `package.json` 对不上时，构建第一步就会失败，不会发出错位的包；重复跑同一次发布是幂等的
（Release 已存在则覆盖资产）。

不推 tag 只想拿包：Actions →「打包三平台」→ Run workflow，产物在当次运行的 Artifacts 里，不发版。

## 目录

```
src/
├── main/          Electron 主进程
├── preload/       预加载桥（contextBridge 暴露 window.api）
└── renderer/      Vue 3 渲染进程
    └── src/components/layout/   MainLayout / Titlebar / StatusBar
scripts/
└── record-artifacts.mjs         体积与哈希记录（工单 028 防退化基线）
```

## 当前进度

- **001 骨架与构建管线** ✅
- **004 WebView 注入桥** ✅（XHR/fetch/JSONP 三形态捕获 + 经页面官方 SDK 的下行通道）
- **003 适配器接口与统一订单模型** ✅（`src/main/platform/` + `src/shared/types/order.ts`，vitest 门禁）
- **005 mock 平台贯通捕获管道** ✅（捕获引擎：路由 → 解析 → 去重 → 渲染层表格，管道定型）
- **006 闲鱼列表捕获与登录态** ✅（闲鱼适配器 + SDK 登录检测 + 平台 Tab UI）
- **007 统一 Excel 导出** ★ ✅（主进程 exceljs：19 核心列 + 平台扩展列、保存对话框、D-3 时间护栏）
- **012 京东 / 013 淘宝 / 015 拼多多适配器** ✅（列表捕获 + Cookie 登录态 + 统一导出；PDD 接口契约待真机观察校准）
- **008 闲鱼订单详情二次抓取** ✅（经页面官方 mtop SDK 串行限速：收货地址/运费/闲鱼币/支付宝交易号/付款·发货·成交时间）
- **009 商品图片下载与 Excel 内嵌** ✅（魔数判定、webp→jpeg wasm 转码、60×60 内嵌/行高 80，全平台；「含图片」开关）
- **京东/淘宝主动批量抓取** ✅（京东页面内同源 fetch **逐年翻页、默认近 5 年**
  `d=2&s=4096` 今年 / `d=<year>&s=4096` 往年，空页换下一年；淘宝官方 mtop 按月分批；
  响应复用同一捕获引擎，可随时停止）
- **016 得物 / 017 快手小店 / 018 饿了么 / 020 美团外卖** ✅
  （四个平台的接口契约与字段映射均从 momao-g 1.0.37 内嵌前端 bundle **源码级取证**，
  含各平台精确归一化函数与导出列定义；饿了么与美团共用 `local-life.ts` 本地生活列语义）
- **导出完整性加固** ✅
  - 跨平台列冲突消解：同名表头加平台后缀；同 key 异义（如 `sellerId` 买卖反转）拆列并按平台填值
  - 16+ 位订单号精度保护：注入层 `protectBigInts` 阻止 `JSON.parse` 静默舍入（否则导出的单号是错的）
- **010 后台翻页** ✅（滚动加载平台在窗口外隐藏页面里触发自身加载，连续无新内容自动停；
  抓取全程不弹出页面。有接口能力的平台走接口逐页取）
- **021 单账号（原多账号聚合已停用）** ✅（每平台固定 `persist:platform-<id>`，
  修掉「登录分区 ≠ 登录态监听分区」导致扫码无反应的故障）
- **022 统一导出中心** ✅（Excel 单表/多 Sheet + CSV 带 BOM、列与格式可选）
- **023 本地缓存** ✅（分平台文件、原子写入、退出前 flush、启动恢复）
- **024 首次启动引导** ✅（原理说明 / SmartScreen 提示 / 选常用平台）
- **025 诊断面板** ✅（只读快照，无敏感字段）
- **026 无授权限制** ✅（7 条回归测试钉死「导出行数恒等于捕获行数」）
- **027 自动更新** ❌ 已移除（2026-10-26 用户要求）：客户端版本检查与平台规则热更新一并删掉，
  「工具 → 检查更新」不再出现，相关 IPC / preload API / 规则包模块已删除。
- **028 体积优化** ✅（Element Plus 按需引入：renderer JS 1033→412KB **-60%**、CSS 367→96KB **-74%**）
- **029 性能护栏** ✅（10000 单导出 1.4s / 分批写入不丢行 / CSV 转义正确）
- **031 导出中心与界面打磨** ✅（导出中心：范围/格式/列勾选/含图进度/汇总表；导出历史 + 默认目录记忆；
  筛选条（搜索/时间/状态）+ 勾选导出 + 状态栏；见 `docs/031-导出中心与界面打磨.md`）
- **030 发布链路** 🟡（`scripts/release.mjs` 已代码化；出包需联网环境拉 winCodeSign）
- 拼多多维持被动捕获：接口契约待真机观察校准（决策 D-1），校准后按既有编排器模式增补

**全部 31 张工单已处理完毕。** 剩余为真实环境动作：出包、SmartScreen 实测、杀软抽查。

测试：`npm test`（vitest，**317 个**）。mock 平台演示：`node dev-fixtures/mock-platform/server.mjs` 后在应用「验证面板」点「mock 平台」。

自检脚本见 `scripts/README.md`，常用：
- `npx electron scripts/ui-shot-full.cjs` — 主界面截图 + 平台列表
- `npx electron scripts/login-ui-shot.cjs 淘宝` — 登录弹窗二维码
- `npx electron scripts/features-check.cjs` — 缓存/诊断/自动翻页
- `npx vite-node scripts/dump-parsed-orders.mts && npx electron scripts/export-ipc-check.cjs` — 导出双粒度

## 红线与安全边界（2026-10-26 修订，见 `docs/033`）

用户明确本软件自用、不外泄，**解禁系统级 MITM**。修订后的约束：

1. **抓取仍以 WebView 注入为主通道**；MITM 是**可选**补充通道（默认关闭，需显式开启）。
   开启后必须满足：只解密订单域名白名单（其余域名隧道透传、不解密不记录）；
   证书只装进「当前用户」存储；退出/崩溃自动还原代理；一键卸载。
   *（这条替代了原「不装根证书/不改系统代理」的红线）*
2. **不自行构造或伪造任何带签名的平台请求。**
   需要主动请求时，必须经页面自身官方 SDK（如闲鱼 `window.lib.mtop.request`）发出，`sign` 由官方 SDK 计算。
   MITM 通道只做**观察与解密**，不发起、不改写请求。
3. **任何 fixture / 测试数据入库前必须脱敏。**
   原版曾把含真实姓名、手机号、住址的 541KB 测试 xlsx 打进正式分发包 —— 此为已发生的隐私事故，不得重演。

## 已知待优化

- 导出历史只支持「看 + 打开」，还没做「一键重复上次导出（同列同格式）」（IPC 的 `targetPath` 已就绪）。
- 列勾选只能记住一套，没有多套命名预设。
- 不签名（决策 D-C）：首次运行会触发 Windows SmartScreen，需按工单 024 提供图文引导。
