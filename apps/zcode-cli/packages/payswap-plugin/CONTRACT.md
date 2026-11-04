# payswap-plugin

官方 PaySwap 插件（P0 批准后的第一个 P1 增量，roadmap Wave 1）。提供六个 `payswap_*` MCP 工具
（thin proxy）与三个 Class A 信息性 `ui.surfaces`（金融工作区 / 路线计划 / 证据），全部在
`userConfig.financialWorkspace`（默认 false）的显式 opt-in 之后才有数据。工具语义、typed
refusal 码与表面纪律见 [src/contract.ts](src/contract.ts) 与 P0 附录
`docs/payswap/p0/11-architecture-addendum.md`（§1.6.0 / §2 / §9，normative）。

不变量：

- **opt-in 默认关闭**：`financialWorkspace` 默认 `false`（S1 语义）。打开前所有工具返回
  typed `not_opted_in`；打开后、无账户连接时返回 `not_connected`（S2 语义）。三个 typed
  code 的语义与可达性以附录 §2.1 为准。
- **launcher 可见性 ≠ 数据可达性**（评审钉住的验收区分）：`listUiSurfaces` 只按
  `plugin.enabled` 过滤、不读 `userConfig`——S1（已启用、未 opt-in）下三个面板入口照常
  出现在 launcher（P0 S1 行的预期行为），这只是入口可见性。受保护金融数据的可达性由
  另一条边界证明：面板资源是静态骨架（零占位数据），数据工具在未 opt-in 时全部
  typed refusal；两端断言由 bootstrap 的启动路径验收
  （`tests/payswap-launch-path.test.ts`）在真实 stdio 进程上钉住。**T7 的数据臂**
  （opt-out 销毁已渲染的受保护数据）在 Wave 2+ 面板承载真实数据后才是可验收对象——
  属认证 broker 里程碑的发布门，本插件届时实现 surface-content 注册与销毁回调。
- **MCP 进程无金融状态**：server 进程不持有凭据、账本访问或金融数据；它只做注册与
  typed refusal（Wave 1 为启动 env 快照判定）。真实数据与 live 状态判定属于 Wave 2+ 的
  认证 broker 桥（附录 §3），工具永远经 broker 访问 host 金融服务。
- **env 命名 = 插件自有命名空间 `PAYSWAP_`**：manifest `mcpServers.*.env` 注入的是
  插件子进程的 env（经 `${user_config.*}` 从插件设置解析），属插件自有变量，命名跟随
  既有官方插件先例（`ANDROID_PLUGIN_SDK_PATH` / `IOS_SIM_DEFAULT_DEVICE`），统一
  `PAYSWAP_` 前缀；CLI `AGENTS.md` 的 `ZCODE_` 前缀规则约束的是**项目自有**（宿主进程）
  环境变量，不覆盖插件子进程注入。本插件新增的任何 env 键必须以 `PAYSWAP_` 开头
  （`src/contract.ts` 的 `FINANCIAL_WORKSPACE_ENV` 为单一事实源，契约测试钉住前缀）。
- **Class A only**：`ui.surfaces[]` 只声明信息性表面；authorization 卡是 Class B，由
  host 渲染，永不声明为插件表面（N25）。面板是静态骨架：零外部依赖，不渲染任何占位
  金融数据；面板数据管线随 Wave 2+ 落地。
- **构建必定产出** `contract.ts` 的 `PAYSWAP_PLUGIN_OUTPUTS`
  （`.zcode-plugin/plugin.json` + `dist/server.mjs`）。官方定义的 `requiredSeedPaths`、
  seed 完整性检查与此对齐；`dist/` 是构建产物（git 忽略），打包时由
  `scripts/build.mjs`（esbuild bundle，与 office-runtime 同参数）生成。完整启动路径
  （定义 → 构建 → seed → manifest 解析 → stdio → MCP 调用）由 bootstrap 的
  `tests/payswap-launch-path.test.ts` 在真实管线上验收；**生产宿主派发链**（真实构建的
  `zcode.cjs` 入口 + `__zcode-plugin-host` 派发 + 解析器 env → 本插件 server）由
  `tests/payswap-host-launch.test.ts` 逐字执行解析器产出的完整生产命令验收（P1 PR #3
  架构师评审第 2 轮第 3 项）。
- **插件名** `payswap` 取自 `.zcode-plugin/plugin.json`；运行时 MCP server 名为
  `plugin:payswap:gateway`（workspace isolation）。三处版本（package.json / manifest /
  bootstrap 定义）保持一致，由 bootstrap 单测机械校验。
