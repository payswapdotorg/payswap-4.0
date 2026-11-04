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
- **MCP 进程无金融状态**：server 进程不持有凭据、账本访问或金融数据；它只做注册与
  typed refusal（Wave 1 为启动 env 快照判定）。真实数据与 live 状态判定属于 Wave 2+ 的
  认证 broker 桥（附录 §3），工具永远经 broker 访问 host 金融服务。
- **Class A only**：`ui.surfaces[]` 只声明信息性表面；authorization 卡是 Class B，由
  host 渲染，永不声明为插件表面（N25）。面板是静态骨架：零外部依赖，不渲染任何占位
  金融数据；面板数据管线随 Wave 2+ 落地。
- **构建必定产出** `contract.ts` 的 `PAYSWAP_PLUGIN_OUTPUTS`
  （`.zcode-plugin/plugin.json` + `dist/server.mjs`）。官方定义的 `requiredSeedPaths`、
  seed 完整性检查与此对齐；`dist/` 是构建产物（git 忽略），打包时由
  `scripts/build.mjs`（esbuild bundle，与 office-runtime 同参数）生成。
- **插件名** `payswap` 取自 `.zcode-plugin/plugin.json`；运行时 MCP server 名为
  `plugin:payswap:gateway`（workspace isolation）。三处版本（package.json / manifest /
  bootstrap 定义）保持一致，由 bootstrap 单测机械校验。
