# shared-payswap

PaySwap broker 协议的**唯一共享实现**（w2-01 §6.4(5)）：canonical JSON（RFC 8785）、签名
响应信封（Ed25519, RFC 8032）、请求行摘要（SHA-256, FIPS 180-4）、五键凭据组、per-boot
身份铸造、append-only 实例注册表、六操作 per-op params schema + §6.1 请求 schema +
三码业务拒绝（Step 4 的 `operations.ts`）。host 与 child 用同一份代码 —— 漂移即违约。

## 不变量

- 信封绑定字段 request-attributed、never claim-echoed（§6.4(3)，F1）：pre-binding 拒绝
  null-bound；null-bound 永不满足子进程 §6.5(3d–f) 绑定。
- `requestDigest` 字节区间：精确请求行、不含结尾换行（§6.4(2)，F4）；结尾换行按行定界符
  规范化（`requestLineDigest(line) === requestLineDigest(line + "\n")`）。
- v1 无未签名响应模式（§6.5(2)）；emission cap：超过 1 MiB 的信封拒绝签发（§6.4(4)，F7）。
- 五键凭据组 all-or-nothing（§4.4(1)）+ 双表剔除纪律（§4.3(1)，F5：strip list 与
  tool-env-passthrough blocklist 同时登记）。
- 验签失败原因闭集 `PayswapBrokerResponseRejectionReason`，每步互不相同；验签永不抛裸
  错误、被拒响应字段永不外露（§6.5(3)）。
- 注册表 append/tombstone-only，tombstone 原因一次性设定（§10.2，F13）；未知 id 不产生
  状态（§10.1）。
- G = 64 为冻结协议常量（§9.4/ADR-2）；重放两侧引擎自 Step 6 起以 `replay.ts` 落在
  本模块（broker seen-record 引擎 §9.3 + child 发送边界分配器 §9.3(5)，ADR-9 D9.3）——
  共享单一实现纪律（与 canonical-json/envelope 同源），无任何可配置 surface。
- per-op params schema 与 Wave 1 工具面 1:1（§6.1(3)/§7.1，deliverable 05 §9）：
  `.strict()`，无第七操作；`authorizationId` 不是 Wave 1 已知键 —— §7.4 的 dormant
  grant hook 只存在于 dispatch 层预留设计（schema 层即拒，Step 7 断言其不到达 grant 逻辑）。
- 三码业务拒绝（§7.3）的 broker 侧单一实现是 `payswapBusinessRefusal`；消息与
  payswap-plugin 的 Wave 1 `snapshotRefusal` 同文（单一事实源注释在 operations.ts）。
- P1.7 grant 法则（addendum §1.3/§1.6）：tuple schema `.strict()`（无任何自报 display
  位）；digest = canonical JSON 的 SHA-256（键序无关）；绑定法则按固定字段序报告首个
  偏差。grant ledger 单一铸造入口只接受本实例配对 minter 的 mint（per-instance CSPRNG
  nonce + digest 一致性重算 —— 伪造/异源/漂移 mint = `unauthorized_mint` 抛错，ledger
  不动）；authorizationId/sequence 全部 host 分配。拒绝码族两枚（§7.4）：无呈现 =
  `authorization_required`；呈现而不获授权（unknown/expired/consumed/偏差）=
  `authorization_mismatch`（审计 reason 区分）—— N1–N9 的上下文全集只是审计注记，
  裁决永不变。批准卡 payload 单一派生路径（`buildPayswapAuthorizationCardPayload`），
  展示投影与 proposal 记录 byte-equal（N14），schema 无 display 位（permission prompt
  的有意 delta）。发送者三检 fail-closed（空受信 origin 集 = 全拒）。批准事件形状
  strict（无 tuple 呈现位）；plugin 回调形状/`ui://`/模型文本不是批准事件（N26/N17）。
  批准流解析顺序固定：事件判别 → 发送者/proposal 状态 → challenge 绑定 → port 解析
  （认证法则先行）→ deny → 角色端口 → 铸造（digest 从 host 自身状态重算）。
- `authorizationId` 仍不是六操作 params 的已知键（§7.4 dormant hook 维持）—— P1.7
  落地的是 grant 机制与批准边界，dispatch 层的 grant 校验接线在 P2+/P7 激活。
- Gate E1 hook 准入（addendum §5.1，P1.8；`hook-admission.ts`）：金融模式关 =
  恒放行（上游行为不变）；开（S2）= 仅 official / 显式白名单（`plugins.financialHookTrust`，
  权威 id 精确匹配，无通配/前缀/跨市场）。金融模式投影（`readPayswapFinancialModeFromConfig`
  pair + `isPayswapFinancialModeActive` AND）是单一实现—— broker live reader
  （spawn-wiring）自 P1.8 起委托本模块，hook 门与三码法则的「金融模式」永不漂移。
  只门 hook，不判插件生命周期（skills/commands/MCP servers 不受影响）。

## 模块交集

- `@zcode/shared` runtimeEnv（host 进程）：五键剔除 + capture-before-sanitization 快照
  （§4.3/§4.4）—— hook 点在 `runtimeEnv.ts` 的 strip/capture 列表，不在本目录。
- `@zcode/bootstrap` mcp-config：受信注入（reference-identity 门，§4.2）—— hook 点
  `injectPayswapBrokerMcpServers`；本模块只提供凭据组类型与形状校验。
- `@zcode/cli` plugin-host-command：启动断言（上下文 + 时效，§4.4(2) rev 2a）——
  hook 点 `assertCapturedPayswapBrokerLaunchIsAuthorized`。
- payswap-plugin（child 侧）：Step 4+ 的 bridge client 消费 `verifyResponseEnvelope`
  与受信注入的五键 env；本模块不 import 插件包（方向：插件侧经 `@zcode/shared/payswap`
  子路径取用，与 host 侧同一份代码）。
- `@zcode/adapters` plugins（P1.8）：Gate E1 的接线点 —— `canRunPluginHooks` 按源注释
  命名的升级路径收回判断并调用 `isPayswapPluginHookAdmitted`；白名单键
  `plugins.financialHookTrust` 的 schema/装配在 adapters config（contracts 的
  PluginConfig/ConfigKey 声明形状）。判定在插件解析期，随上游 per-session 快照语义。
- `@zcode/server` payswap（P1.7）：approval host 以 registry challenge 适配器
  （issue/resolve 经 P1.6 法则）+ 角色端口（`authorizeAction`）+ grant ledger handle
  装配 `createPayswapApprovalFlow`；challenge 的 proposal 失效在 server 侧由注册表
  级联拥有（适配器 no-op，流状态轴兜底）。
