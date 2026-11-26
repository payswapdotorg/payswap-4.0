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
- Gate E3 受控 provider-authorization Browser 流（addendum §5.3，P1.8；
  `browser-admission.ts`）三条款决策表：
  - **条款 1（模型臂）**：金融模式开（S2，同一 `isPayswapFinancialModeActive` 投影——
    与 E1/broker 永不漂移）时，模型控制的导航到 PSP API host 一律拒绝
    （`psp_api_host_blocked`）；URL 不可解析 = 无法证明非 PSP host → fail-closed 拒绝。
  - **条款 2（host-initiated 臂）**：provider 授权流（OAuth redirect / dashboard
    onboarding）只导航到**该 provider** authSpec 派生的官方授权 host 白名单
    （`derivePayswapProviderAuthorizationHosts`，authorizeUrl/tokenUrl/rotationUrl 的
    host），白名单外一律拒绝（`authorization_host_not_allowed`）—— allowlist，不是
    blocklist；空白名单 = 全拒（approval-origin 空受信集同款 fail-closed）。URL 永远
    不来自模型。
  - **条款 3（保真臂）**：金融模式关 = 与上游完全一致（零回归，E1 臂 1 同款）；开时
    非 PSP host 照常放行 —— Browser 行为只按 host 分类变化，非 PSP 域不变。
  - **host 匹配纪律**：精确 host 等值（小写规范化 + 去单个尾点——DNS 等价），无通配/
    无后缀/无子域传播；端口无关（`api.stripe.com:8443` 仍是该 host）；userinfo 不参与
    （`https://evil.test@api.stripe.com/` 的目标是 api.stripe.com；反向亦然）。与 E1
    的权威 id 精确匹配同款纪律。
  - **种子记录（数据驱动，非代码分支）**：`PAYSWAP_SEED_PSP_PROVIDER_HOSTS` ——
    API host denylist = deliverable 04 §195 记录的三家四 host（api.stripe.com /
    api.paystack.co / api-m.paypal.com / api-m.sandbox.paypal.com，doc 04 的 dated
    evidence；P2/P3 按 dated-evidence 纪律复验扩表）；authorizationHosts P1 为空
    （P1 无 host-initiated provider flow —— account service 是 P2 落地，空表 =
    fail-closed 全拒是正确生产行为），P2 的 authSpec 派生填充。
  - **判定时机**：per-command live 读（fresh config → `isPayswapFinancialModeActive`），
    与 broker §7.3 三码法则、T2 拒绝码即时翻转同款纪律；包装层只对 URL 携带的
    导航命令（`navigate`）求值，其余命令零开销直通（保真面最小化）。
- **T 系表面生命周期法则（addendum §2.2 T3 卡臂 + §2.3 item 1 臂 (b)/item 3，P1.8；
  `approval-flow.ts` 的两个新臂 + `surface-revocation.ts`）：
  - **T3 卡臂**：`issueProposal` 装配 `financialMode: () => { active }` live 读
    （每次发卡现读）；非 S2 一律拒发 typed `financial_mode_inactive`，门在最外层
    （先于 tuple 过期评估，零副作用）；缺省 reader = 无法证明 S2 → fail-closed
    拒发（`readPayswapFinancialModeFromConfig` 的缺省姿态同款）。S2 行为不变。
  - **T7 item 3**：`revokePendingProposals()` 批量失效 pending proposal 及其
    一次性 challenge（只扫 pending —— approved/denied 审计历史不重写）；事后到达的
    approve/deny → `proposal_not_pending`（N15 无 live challenge 臂）。
  - **表面内容注册表**（`surface-revocation.ts`）：实例按捕获租约
    （sandboxId/initId + appIdentity 租约三元组；token 不入册）+
    has-ever-received-protected-data 标记追踪；注册面 fail-closed —— 仅结构上属于
    官方插件的键（buildPluginUiSurfaceKey 同构：[sessionKey, pluginId, server,
    resourceUri, scopeId]，pluginId === PAYSWAP_OFFICIAL_PLUGIN_ID）可入册，外来/
    畸形键抛错（恰自有键纪律）。计划：标记 → dispose；标记 + 锚点占位 →
    dispose_and_replace；未标记 → best_effort_event（无安全属性依赖，§2.3 item 5）；
    已关闭实例无拆除动作但键仍在清除集（feed 快照跨关闭存留）。
  - **撤销执行器**（`runPayswapSurfaceOptOutRevocation`）：串行（首注册序）、每实例
    有界守护窗（`teardownGuardMs` 必填 —— D12.7 以上游 MCP_APPS_TEARDOWN_TIMEOUT_MS
    同源值供给）—— 页面永不合作 → 窗到期推进；
    teardown 拒绝不中止整批；替换租约的 **sandboxId 必须新**（复用 = fail-closed
    抛错；initId 不是新鲜性信号 —— 上游注册表每次新登记铸造常量 initId=1）；
    替换实例重新入册；retention 恰按计划键集两 store 都清。接线缝（D12.7）：
    teardownInstance ↔ runPluginUiHostTeardown；clearSurfaceFeed/clearWidgetState ↔
    clearPluginUiSurfaceFeed/clearPluginUiWidgetState。
- **桌面批准卡接线法则（addendum §1.6.2 items 1–4 的接线半，P1.8 D12.7；
  `approval-desktop.ts`）：
  - **真实 IPC 映射**：`mapPayswapDesktopApprovalSender` 把 Electron ipcMain 事件的
    结构面（sender.id / senderFrame / sender.mainFrame 的**对象同一性**）映射到
    `PayswapDesktopFrameSender`（不 import electron —— 真实 `IpcMainInvokeEvent`
    结构满足该面；缺 senderFrame / 缺 mainFrame = 无法证明主框架 → fail-closed）。
    三检本体仍在 approval-origin 法则内执法。
  - **生产受信 origin 值**：`derivePayswapTrustedAppOrigins` 从主窗口自身当前 URL
    派生（`payswapFrameOriginOf` 单一实现 —— 与三检第 3 检的提取字节一致）；
    空/空白 = 空集 fail-closed。
  - **桌面批准 host**（`createPayswapDesktopApprovalHost`）：flow + 卡实例 challenge
    存储 + ledger/minter 配对装配；发卡 = card_instance bearer（operator_session 是
    server host 形状）；解析 = 映射 + `flow.resolveApproval`，**每次解析前现读主窗口
    URL** 刷新受信 origin 集（per-event live read）；N18 `invalidateProposal` 与
    T7 item 3 `revokePendingProposals` 透传流法则。通道常量
    `PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL`（desktop main 的 ipcMain.handle 注册名）。

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
- `@zcode/bootstrap` create-app（P1.8）：Gate E3 的接线点 —— `options.browserControlPort`
  在 app 装配处一次性包上准入包装（`wrapBrowserControlPortWithPayswapBrowserAdmission`，
  `src/app/payswap-browser-admission.ts`）：模型控制的 `navigate` 命令过
  `admitPayswapModelBrowserNavigation`，拒绝映射为 Browser 面已有的 typed
  `navigation_blocked` 错误码（上游 managed-browser URL 检查同码），内层端口不被调用；
  其余命令/方法直通；`forChildSession` 派生的子端口同样过门（子代理导航不得绕过）。
  host-initiated 臂（条款 2）的法则与派生在 shared，驱动方是 P2 的 account service
  （authSpec）—— P1 只落法则与 fail-closed 空白名单语义。
- `@zcode/server` payswap（P1.7）：approval host 以 registry challenge 适配器
  （issue/resolve 经 P1.6 法则）+ 角色端口（`authorizeAction`）+ grant ledger handle
  装配 `createPayswapApprovalFlow`；challenge 的 proposal 失效在 server 侧由注册表
  级联拥有（适配器 no-op，流状态轴兜底）。P1.8：host 透传 `financialMode` reader
  （entry-http 在 N27 activated 分支内以同一 env 投影供给 —— T3 卡臂）并暴露
  `revokePendingProposals`（T7 item 3 的 in-process host API）。
- `@zcode/ui` payswap（P1.8 D12.7，`packages/ui/src/payswap` managed 模块）：
  表面撤销接线的绑定 owner —— `bindPayswapSurfaceRevocationDeps` 把执行器 deps 绑到
  真实原语（两 store 逐键清除经 plugin-ui 公开入口 hostPrimitives；守护窗 =
  teardownTimeoutMs + 100 与上游拆除内窗同源同式）；`buildPayswapOwnSurfaceKey`
  字节等价委托真实 `buildPluginUiSurfaceKey`（T-series 电池登记的复验欠条）；
  `leaseFromPluginSandboxHandle` 提取捕获租约（token 不入册）。
- `@zcode/desktop` main payswap（P1.8 D12.7，`packages/desktop/src/main/payswap`
  managed 模块）：桌面批准通道的 Electron main 装配 —— `installPayswapDesktopApprovalIpc`
  把真实 `IpcMainInvokeEvent` 交给 `host.handleApprovalResolution`（结构满足映射面，
  typecheck 即证明）；`getMainWindowFrameUrl` 供给生产受信 origin 值；真实窗口的
  注册与 `financialMode` reader 由 desktop Browser E2E 臂接线。
- Gate E2 PSP 凭据安全法则（addendum §5.2，P2；`credential-security.ts`）：
  `payswap:psp:*` 键的权威命名空间谓词（前缀精确 `payswap:psp:`；`payswap:psp`
  无尾冒号不在内；退化空段在内 —— fail-closed）+ per-platform 决策表
  （safeStorage 键在位 → `safe_storage`〔desktop 行，OS 钥匙串优先于 secret〕；
  否则 `ZCODE_CREDENTIAL_SECRET` 在位 → `secret`〔server 行〕；否则
  `fail_closed`〔neither 行 —— 确定性 fallback 派生键对 PSP 键永不可用〕）+
  两类不重叠的 typed 失败（`PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE` = 存储通道
  缺失的 fail-closed 拒绝；`PAYSWAP_PSP_KEY_UNWRAP_FAILED` = 键仓包裹解不开，
  无静默轮换）+ host env 键契约（`ZCODE_PAYSWAP_PSP_KEY` —— desktop main 写侧
  与 services 读侧的单一事实源）+ `buildPayswapPspHostEnv` 交付组装（null →
  空对象 = 不注入即拒）。消费方：`@zcode/services` credentialService 的键级
  cipher 解析（PSP 键：注入/env safeStorage 键优先，secret 在位且默认通道未被
  替换时走默认通道，否则触盘前 typed 拒绝；非 PSP 键恒默认通道 —— 上游行为
  零变更）与 `@zcode/desktop` main 的 safeStorage 键仓
  （`pspCredentialKeyStore.ts`：at-rest 只落包裹产物、0600、ensure 串行去重、
  memoize 成功不 memoize 不可用；入口接线随 P2.2 账户服务连接流与其 desktop
  Browser E2E 臂落地）。
- P2.2 账户连接法则（doc 05 §5 + doc 06 §2.2，`account-connection.ts`）：PSP 存储
  键模板 `payswap:psp:<providerId>:<connectionId>:<secretKind>`（段空/含冒号 =
  编程错误，fail-closed 抛出）；连接记录与状态投影 schema `.strict()`（投影 =
  记录的去秘密子集，恰五字段；秘密形载荷 schema 级拒绝 —— 渲染层/模型侧在
  类型面上拿不到秘密）；Stripe authSpec 事实（doc 04，检索日期在案；
  oauth/client-credentials 形态随 P3 的 provider 评估落地，不提前发明）；
  typed refusal 词汇（`validation_failed` 逐字 doc 05 §6.6；`unsupported_provider`/
  `unknown_connection` 是 host-service 范围码；存储 fail-closed 逐字复用 Gate E2
  常量）。**读回半（slice 2）**：状态词汇补全 `expired`（connected | expired |
  revoked —— doc 05 §5「expiry is projected as connection status」；`expired` ⇄
  `connected` 经 refreshEvidence 证据翻转，`revoked` 终态）；provider 读回端口
  `PayswapAccountReadBackPort`（host 进程内执行；输入携带秘密值 —— 端口永不
  持久化/日志/投影秘密）产出三值结局：`verified`（携带 `providerAccountId`
  非秘密证据摘要）/ `auth-failed`（provider 拒绝凭据 —— 唯一能把状态翻到
  `expired` 的证据）/ `unavailable`（网络/未知结局 —— 不是 expiry 证据，
  doc 05 §6.4/§6.6 的 unknown 纪律）；refresh 结果四值 `verified | expired |
  revoked | refused`；新拒绝码 `read_back_unavailable`（端口缺席、传输失败或
  秘密缺失 —— 状态不变，fail-closed 不猜）。原始 read-back 的证据落账
  （ledger seq、能力记录引用）随 P2 能力注册表切片，本切片只落状态迁移）。
  **overview wire 形状（slice 3）**：`get_account_overview` 的成功 data
  `PayswapAccountOverviewData`（`{kind:"overview", connections: 投影[]}`，与业务
  拒绝 data 对称）住 `operations.ts` —— broker dispatch 的 account-overview
  真数据半（§7.3「Read-only account data arrives with P2's Gate E2」的 P2.2
  兑现）与插件侧共用同一 wire 形状；空清单 / reader 缺席仍答三码法则的
  `not_connected`。

**ADR-P2-1 只读数据面（slice 4）**：`account-data.ts` 承载 P2 对话内只读面的全部
法则 —— 闭集类别枚举 `PAYSWAP_READONLY_CATEGORIES`（恰 `balance |
payment_objects | customers | disputes`，无 write 类别：类别与操作枚举都不含
doc 05 §6.1 的 write 动词集 `PAYSWAP_WRITE_OPERATION_VERBS` —— no-write 断言的
battery 单一事实源）；能力证据 `payswapAccountCapabilityEvidenceSchema`（doc 04
§1.2 capabilities + requirements 读回摘要，住 account-connection.ts 与读回结局
同源）；per-category redacted 数据 schema（strict 白名单：余额 minor-unit 整数
`{amount, currency}`；支付对象 `{id, amount, currency, status, created,
description}`；客户 `{id, created, description}` —— **PII（email/name/phone）永不
进数据面**；争议 `{id, amount, currency, status, reason, created}`）；四值类别
结局 `ok | auth-failed | refused | unavailable`（401 唯一拒绝证据；403 →
`refused{insufficient_permission}`；unknown ≠ failed）+ per-category strict
校验器；数据读端口 `PayswapAccountDataReadPort`；概览 detail 联合
`PayswapAccountOverviewDetail`（`detail | expired | revoked | refused` —— 与
refreshEvidence 结果词汇同构）。读回 `verified` 结局 additive 可选携带 `evidence`
（缺席时概览 detail 面 fail-closed 拒绝 —— 除非 adapter 显式声明能力缺口，见下）。

**P3 provider 缺席面 —— typed 缺口，不是 detail 拒绝（2026-11-24）**：依据 doc 05
§4「An adapter that cannot produce evidence for an operation **must** declare it
`unavailable` with a reason」「Unknown = `unavailable`, not optimistic defaults」与
register P2 验收「capabilities are answered from provider read-back evidence **with
typed refusals where unconfigured**」。Stripe 之外没有哪个 P3 provider 暴露 Stripe
式的自身份 / 能力读回面（Paystack 官方 API 无 merchant/business self-identity
端点；PayPal 的 client-credentials 读回没有已钉住的能力面 —— 两项事实 pin 与
检索日期在案）。原法则「`verified` 不带 `evidence` → 概览 detail 整体拒绝」把三件
事并成了一件：凭据是否有效（状态机）、provider 是否签发账户标识、provider 是否
暴露能力证据。三者分开作答，每一步仍是 evidence, never claims：

- **身份缺口**（`account-connection.ts` `payswapAccountIdentityGapSchema`，码
  `provider_identity_not_exposed`）：读回 `verified` 的 `providerAccountId` 可为
  `null` —— **当且仅当** `identityGap` 在场（schema 不变量：`null ⇔ identityGap`；
  非空 id 与 `identityGap` 并存 = 畸形结局）。「provider 认证了凭据」（例：
  Paystack `/balance` 200 + 官方封套）就是 `verified` 的事实来源；身份缺席只是
  「provider 未签发标识」，**不再**映射 `unavailable`（读回并没有失败）。refresh
  结果的 `verified` 携带同一对（`providerAccountId: string | null` + 可选
  `identityGap`）；恢复行（`expired` → `connected`）对身份缺口 provider 同样成立
  —— provider 接受凭据就是恢复证据（doc 05 §5）。
- **能力证据缺口**（`payswapAccountCapabilityRefusalSchema`，码
  `capability_evidence_not_exposed`）：读回 `verified` 可选携带 `capabilityGap`，
  与 `evidence` 互斥（并存 = 畸形结局）。它是 adapter 对**已钉住的官方事实**的
  显式声明，不是对 `evidence` 缺席的推断 —— 服务永不因「`evidence` 恰好是
  undefined」而放行。
- **概览 detail 的能力面答案恰一**：`evidence`（读回证据）或 `capabilityRefusal`
  （typed 能力缺口 —— 与类别读的 `refused` 同一词汇纪律：code + 零凭据 message，
  明示「能力未知，不得从余额 / 交易 / 客户数据推断」）。两者皆缺席 = 没有能力面
  答案（畸形 / 未携带）→ detail 面 **fail-closed 拒绝不变**（Stripe 行为逐字不变：
  `verified` 不带 `evidence` 且无 `capabilityGap` 仍拒）。`capabilityRefusal` 在场
  时四类别照读，类别各自 typed 作答（官方无面的类别仍是
  `refused{unsupported_operation}` / `unavailable`）。
- **下游（P4 起）**：`capabilityRefusal` 对 eligibility 的语义是 unknown =
  unavailable —— 没有证据的操作不得被判为可用；目录成员、余额、历史数据都不是
  能力证据。

**P3 协议适配器边界**（addendum §10「Payment-protocol adapters are not providers or
executors」+ doc 12 §6「Protocol interoperability at the boundary」+ doc 05 §13；
`protocols/`—— 纯类型 + zod schema + 摘要，无 IO、无凭据、无 runtime）：

- **事实注册表单一来源**（`protocol-facts.ts`）：每个协议 pin 携带 https 官方源
  URL、检索日期、精确版本串（`null` = 尚未从官方源验证到）、引文级已验证事实、
  `reverifyBeforeAdapter`（消息面实现前的再验证清单）与 `unsupportedCapabilities`
  （显式不支持能力清单）。适配器不得超出已验证事实编码 —— 未检索的不发明。
- **消息面实现门（法则 5，2026-11-23 修正）**：`reverifyBeforeAdapter` 非空 ⇒
  该协议的消息面不得落地，且注册门对一切适配器 typed 拒绝
  `protocol_reverify_pending`。修正依据：MPP（PR #89）与 x402（PR #93）的消息面
  落地时清单仍非空，而法则电池当时断言「仍被挡」—— 注册表、电池与源码树互相
  矛盾。修正后：未检索的 per-network 分册与 x402 五个 spec-silent 行改记
  `unsupportedCapabilities`，三个已落地协议的清单清空；电池按「已落地消息面 ⇒
  清单必空」钉住（`payswap-protocol-contract.test.ts`）。
- **显式不支持 ≠ 模拟**（doc 12 §6「Unsupported features are unavailable, not
  simulated as production support」）：`unsupportedCapabilities` 每项 = 能力 +
  官方状态 + typed refusal —— `protocol_feature_unsupported`（消息面对该面
  typed 拒绝），或 `null`（无 wire 行为被编码或拒绝：本面对该行不作任何声明，
  属宿主策略/未实现验证，不是「已支持」）。
- **消息面登记表**（`protocol-faces.ts`）：已落地消息面按 protocolId 登记为
  单一装配源；描述符由注册表 pin 派生（`payswapProtocolAdapterDescriptor` ——
  URL/检索日期/版本不在调用方手抄）。新增协议 = 注册表 + 登记表 + 法则电池
  同变更。
- **x402 supported subset** = `exact` on `eip155:*` via `eip3009`（缺省转账方法）+
  `authorization` 流（缺省）。官方示例逐字（x402-foundation/x402 @ `b711fa9f`，
  检索 2026-11-23：core §5.1–§5.3、§6.1、scheme `exact`/EVM §1–§3）：
  `payload` = `signature`（「The 65-byte signature」）+ `authorization`
  {`from`/`to`/`value`/`validAfter`/`validBefore`/`nonce`，全部 REQUIRED string；
  nonce =「32-byte random nonce to prevent replay attacks」}；
  `accepted.extra.name`/`version` REQUIRED（EIP-712 域）；`extra.assetTransferMethod`
  在案时 MUST 为 `eip3009`。其余 scheme、网络族、转账方法（`permit2`、
  `erc7710`）与付款流（`upfront`、`escrow`）= typed `protocol_feature_unsupported`
  —— `evaluatePayswapX402RequirementSupport` 是该判定的单一实现（消息面与 P6
  资格评估共用；PaymentRequired 广告未 pin 条目不使消息结构非法 —— 资格不是
  消息面的裁决）。结构违规（含授权的收款人/金额与 `accepted` 不一致、
  `validAfter ≥ validBefore`）= `protocol_message_unverifiable`；wire
  `x402Version` ≠ 2 = 未知形态，同码（消息级无版本码 —— `protocol_version_
  unsupported` 专指适配器 pin 与注册表不一致）。
- **进站结局永远是不可信提案**：`validated-untrusted-proposal` 只指「通过了
  pinned 结构 schema」—— 结构验证不是密码学验证，该结局不得被任何调用方解读
  为已认证、已授权或已结算。结局闭集里没有任何 verified/authenticated/settled
  位（API acceptance ≠ settlement；进站 SettlementResponse / MPP receipt 同为
  不可信提案）。
- **签名姿态（P3 诚实边界）**：三个消息面均**不做密码学验签**。addendum §10 /
  doc 12 §6 / doc 05 §13 要求适配器按协议验证 identity/signature/replay/expiry
  —— 该要求未撤回：验签所需前提在 P3 不在案（x402/MPP EVM 需 secp256k1 +
  keccak256 的审计依赖〔仓库未批准〕；MPP Stripe SPT 经 Stripe API 验证 =
  provider write〔P7 前 forbidden〕；AP2 SD-JWT 的受信发行者信任锚未供给）。
  故 P3 只做签名**形态**校验（缺席/畸形 = typed 拒绝），并按 addendum §10 末句
  「Integration remains disabled until its evidence and acceptance suite passes」
  保持集成禁用：在真实验签落地（P6 `verifyInbound`）之前，任何协议消息不得被
  映射为 PaySwap intent。
- **challenge 绑定是不受信声明**（`PayswapProtocolChallengeBinding`，宿主比对后
  才成为事实）：MPP = `{kind:"mpp-challenge-echo", challengeId, method, intent,
  request, echoedChallenge}`（wire 上有 id，回显逐字比对）；x402 =
  `{kind:"x402-requirements-binding", requirementsDigest, credentialDigest,
  accepted, authorization}` —— 无 challenge id，两个身份分开：`requirementsDigest`
  = 选中 requirements 的 canonical 摘要（绑定宿主签发的 402）；
  `credentialDigest` = 付款授权身份（network + from + nonce + signature）的
  canonical 摘要（单次使用的键 —— 同一 requirements 的第二笔合法付款是新授权，
  不是重放）。AP2 mandate/receipt 不携带绑定（不是宿主签发的 challenge）。
- **收据证据门**（`evidence-gate.ts`，三个消息面共用的唯一实现）：`emitReceipt`
  只接受**宿主证据权威签发**的结算证据 —— 证据缺席/畸形 = `protocol_receipt_
  unavailable`；结构合法但未经宿主签发、跨协议复用、或适配器未装配验证端口 =
  `protocol_evidence_untrusted`；状态非 `settled-verified` =
  `protocol_receipt_unavailable`。适配器只持有 `verify` 端口，结构上无法铸造
  自己的结算证据。

**P4 provider capability registry（doc 05 §4「Capability declaration — evidence, never
claims」+ doc 12 §3「Keep three catalogs distinct」+ §2.3「exactly one financial core」；
`capability/`—— 纯类型 + zod schema + 确定性纯函数，无 IO、无凭据、无 runtime）：

- **三目录分立**（doc 12 §3）：agent catalog、provider capability registry、protocol
  registry 是三个 schema、来源与读模型 —— 互不使对方记录成为权威。本模块只承载
  provider capability 半：它的唯一事实来源是** provider 读回证据**（P3 读回结局），
  绝不是 agent/模型/目录成员资格或任何声明。catalog 描述符可搜索但永不可执行；
  安装/信任留在既有 ZCode 生命周期。
- **能力记录 `PayswapCapabilityRecord`**（doc 05 §4 形状）：providerId + connectionId +
  schemaVersion + declaredAt + `evidence`（产出的原始读回引用 —— P4 波次 1 用读回
  结局的进程内引用；ledger seq 落账随 P7 证据账本切片）+ `operations[]`（每操作
  `OperationCapability`：closed §6.1 taxonomy 子集内的 operation id + 五值 status
  `enabled | available | pending | restricted | unavailable` + `restrictions[]`）。
  记录**不可变且按 revision 递增** —— 新证据 ⇒ 新记录；注册表保留历史（frozen
  views 纪律，镜像 packages/provider/src/registry.ts 的形状而非依赖它）。
- **证据映射法则（evidence, never claims 的机制化）**：读回 `verified` 携
  `evidence`（Stripe 式 capabilities+requirements 摘要）→ 逐操作映射：provider 读回
  的 capability 名按固定词汇表映射到 §6.1 操作 id，active/inactive/pending ⇒
  enabled/unavailable/pending，读回未提及的操作一律 `unavailable`（Unknown =
  unavailable，not optimistic defaults）；`requirements` 摘要进 restrictions 的
  `note`（带官方引用）。读回 `verified` 携 typed `capabilityGap`（P3 缺席面 ——
  Paystack/PayPal）或 `identityGap`：**全部操作 `unavailable`，每项 reason = 该
  typed 缺口**（doc 05 §4「must declare it unavailable with a reason」的注册表面）。
  读回 `auth-failed`/`unavailable`/缺口连接：无新记录（证据缺席不产生记录，也
  永不吊销既有记录 —— 记录由证据时间戳界定新旧）。
- **硬编码能力表禁止**（doc 05 §4）：静态 provider 知识只能进 restrictions 的
  `note`（带 fact-sheet 引用）；任何「Stripe 有 transfers 所以一定有」式声明 =
  实现缺陷。capability 名 → 操作 id 的词汇映射是唯一允许的固定表（它映射的是
  provider 自己读回的名字，不是猜测的能力）。
- **无权威外溢**：本模块不铸造 grant、不路由、不触 provider、不写 ledger —— 它是
  P4/P6 eligibility/routing 的**只读证据面**。catalog/agent 记录在 schema 层不可
  变换为 capability 记录（分离法则的机制化；battery 断言）。

**证据推导法则（wave 1 的操作状态判定；全部确定性纯函数）**：注册表从「读回结局 +
概览类别结果」推导操作状态 —— 两半都是 provider 证据（读回面 = 账户能力面；类别
读 = 该操作真实执行过一次的证据）：

- **类别读证据**（四闭集类别 → 只读操作）：`balance`→`balances.read`；
  `payment_objects`→`payment_objects.read`；`customers`→`customers.read`；
  `disputes`→`disputes.read`。类别 `ok` → `available`（证据 = 该读真实成功）；
  `refused{insufficient_permission}` → `restricted`（provider 权限边界证据）；
  `refused{unsupported_operation}` → `unavailable`（provider 缺席事实进 reason）；
  `auth-failed`/`unavailable` → `unavailable`（unknown ≠ failed —— 未知不写状态）。
- **Stripe 式能力旗证据**（verified + evidence.capabilities）：固定词汇表映射
  provider 读回的 capability 名 → 操作 id：`card_payments`→`collections.read`；
  `transfers`→`transfers.read`；`payouts`→`payouts.read`（读半 —— 写半随 P7）。
  active→`enabled`；pending→`pending`；inactive→`unavailable`。该词汇表映射的是
  provider 自己读回的名字，是唯一允许的固定表。能力旗与类别读对同一操作都给出
  证据时取**较保守**者（unavailable > restricted > pending > available > enabled
  的保守序 —— 证据冲突时低值胜，optimistic defaults 禁令）。
- **typed 缺口连接**（capabilityGap / identityGap 在场）：全部操作 `unavailable`，
  reason = 该 typed 缺口 message（不是猜测、不是空串）。
- **restriction 摘要**：`requirements` 摘要（Stripe 式）按 ADR-P2-1 修订 2026-11-17
  的 null 语义进 `currentlyDue/pastDue` 计数 restriction + `note`（带检索引用）；
  `note` 是唯一允许携带静态知识的位置（doc 05 §4）。

**词汇表修正（2026-11-25，GREEN 首跑暴露）**：一个 provider capability 名可映射到
**多个**操作 id —— `card_payments` → `{collections.read, payment_objects.read}`
（Stripe 的 charges 既是收款面也是支付对象面；两个操作都由该旗真实证据支撑）。
多值映射使「能力旗 × 类别读」对同一操作的真实重叠成为可能 —— 保守序因此有实际
裁决对象（例如旗 pending × 类别读 ok ⇒ pending）。

**P4 确定性 eligibility 引擎（doc 05 §7「Eligibility surface」+ doc 12 §3 + P4 验收
「purpose/country/currency/method/amount/product/entitlement/beneficiary and provider
restrictions return typed refusals」；`eligibility/`—— 纯确定性求值，无 IO、无凭据、
无 provider 触达）：

- **输入 = 证据 + 事实**：`evaluatePayswapEligibility({ query, record, now })` ——
  query = doc 05 §7 的 `PayswapEligibilityQuery`（closed §6.1 操作 id + connectionId +
  constraints）；record = wave 1 注册表的**能力记录**（唯一证据来源）。引擎不持
  connectionId → provider 的解析（那是宿主装配的事），不触 provider，不看 agent/模型
  输入 —— agent 提案不是证据。
- **basis 恒为 "evidence"**：wave 2 只实现证据半；live-check 是 doc 05 §7 的可选
  增强，缺席时引擎对 `basis: "live-check"` 请求 typed 拒绝（不假装、不实现半个）。
- **unknown ≠ ineligible（fail-closed 语义）**：查询无记录 / 记录 stale → **typed
  拒绝**（`eligibility_evidence_unavailable` / `eligibility_evidence_stale`），绝不
  答 `eligible: false + blockers: []`（那是一个「未连接 = 不可路由」式假话 —— 无证据
  是 unknown，不是 no）。
- **状态语义**：`enabled`/`available` → eligible（无状态 blocker）；`pending` →
  ineligible + blocker（capability pending）；`restricted`/`unavailable` →
  ineligible + 该操作记录的全部 restrictions（reasons 原样携带 —— P3 的 typed 缺口
  message 流入 blockers）。
- **约束求值 = 逐类 typed**：restriction schema additively 扩展 doc 05 §4 的结构化
  形（`allow?/deny?/min?/max?`）。约束维度（country/currency/amount/method/
  recipientKind + purpose/product/entitlement/beneficiary 语义随 P4 后续波次补
  schema）的裁决：记录有该类结构化 restriction → 按其裁决（deny 命中 / allow 未
  命中 / min-max 越界 → ineligible + **该类 blocker**，code 携带类名）；记录无该
  类结构化数据而 query 携带该约束 → **typed `eligibility_constraint_unevidenced`**
  （Unknown = unavailable，不乐观默认 —— doc 05 §4）；query 未携带的维度不裁决。
- **answer 形状**（doc 05 §7）：`eligible + basis + evidenceRef + checkedAt +
  blockers`，与 typed 拒绝并成 strict union（拒绝臂 = `{eligible: false,
  refused: {code, message}}` —— doc 05 §7 的 answer 是成功形状；typed 拒绝是
  PaySwap 词汇的失败形状，二者不能混）。
- **无权威外溢**：引擎不路由、不铸造、不写账 —— P6 routing 消费它的 answer；
  答案本身不是授权（doc 12 §2.2）。

**P4 支付参与方能力证据（doc 12 §3「payment capability graph」+ doc 06 §2.1 合同形状 +
P4 验收「sender and recipient identities and payment capabilities are evidence-backed
and separately scoped」/「participant descriptors are limited to financial role,
verified payment capability, authority and availability」；`parties.ts`—— 纯类型 +
zod schema，无 IO、无凭据、无 runtime）：**

- **三族证据分立（separately scoped 的机制化）**：发送方能力 = wave 1 能力记录的
  只读引用（`providerId + connectionId + revision`，本模块**不重建**该记录）；接收方
  能力 = `PayswapVerifiedRecipientEvidence`（本模块）；参与方能力 =
  `PayswapParticipantCapabilityEvidence`（本模块）。三族是三个 schema、三个来源、
  三个 authority —— 任何一族都不得充当另一族的证据；结构断言（电池持有）：wave 1
  记录不可变换/收编为任一参与方记录（doc 12 §3「must not become a generic provider
  marketplace」的 schema 层投影）。
- **verified-recipient 法则**（doc 12 §3 接收方行）：记录必须携带证据三元组
  `evidenceRef + source + verifiedAt` —— identity 与可接受的支付指令（acceptance
  条目）都从 provider/verified-recipient 边界产出；**用户/模型声明单独在场即
  unrepresentable**（superRefine：无证据三元组的记录拒绝）。acceptance 条目按
  rail 类别闭集结构化（class + 可选 provider 命名空间 detail + 可选
  currency/amount 边界），未知 rail 类不可表达。新鲜度：`verifiedAt +
  freshnessBoundMs ≥ now` 才是可用证据 —— 过期证据是 unknown（与 eligibility 的
  stale 纪律同构；本模块只判新鲜度，不产生裁决）。
- **participant 法则**（P4 验收措辞的逐字落地）：描述符恰含四类字段 ——
  `financialRole`（闭集：`rail_bridge | settlement_participant`；发送方/接收方是
  intent 的当事人而非参与者，schema 层排除）、`verifiedCapability`（证据引用，
  指向该参与方自己的授权账户证据 —— 「no general service listing」）、`authority`
  （该参与方显式授予本路由的权限范围，结构化闭集）、`availability`（证据盖章的
  可用性事实 + 新鲜度；可用性不是资金托管、不是承诺）。name/reputation/rating/
  listing/描述性自由文本等「marketplace 字段」一律 strict 拒绝；能力永不从名字/
  列表/模型陈述推断（doc 12 §3 不变量）。
- **Money / rail / purpose 字形**：Money = `{ value: decimal-string, currency:
  ISO-4217 ^[A-Z]{3}$ }` —— decimal string，永不 float（doc 04 §2.5 / doc 06
  §2.1）；intent 金额与 `maxTotalCost` 非负（refund/convert 的符号语义在 intent
  kind，不在 Money）。rail 引用 = 类别闭集（`card | bank | mobile_money | wallet
  | cash | psp_internal | blockchain`）+ 可选 provider 命名空间 detail；`blockchain`
  类受 addendum §13 约束（钱包连接 ≠ 签名/花费权限，本 schema 不携带任何权限位）。
  PurposeCode = 闭集 code + 可选 free text —— **裁决只看 code，free text 永不参与
  裁决**（wave 4 的 purpose 约束裁决消费 code）。
- **无权威外溢**（P4 验收「no agent, model, plugin or participant listing grants
  financial authority」）：本模块 schema 无 grant/mint/submit/route/ledger 面，无
  凭据字段（秘密键形态在 schema 层不可表达）；结构性电池断言与 wave 1/2 同款。
  参与方记录被列出/被引用都不产生任何权限 —— 权限只在 P7 的 host 授权与执行权威。
- **波次边界**：本切片只落 contract 层（schema + 法则 + 电池）。intent 编译器、
  purpose/product/entitlement/beneficiary 约束裁决、broker `check_eligibility`
  接线、P4 套件的 CI yml 注册随 wave 4（PR #98 证据记录在案的缺口）；参与方图
  组装随 wave 4/compiler 所需证据 join；路由消费随 P5。

TL decisions 2026-11-26: PurposeCode v1 uses the eight-code set (family_support, business_payment, payroll, tax, education, medical, supplier_payment, other); availability has two evidence facts (available, unavailable); freshnessBoundMs is explicit and schema-required per record, with no module default.

**P4 wave 4 —— money-movement intent 编译器 + check_eligibility 接线（doc 06 §2.4
「NL financial intent compiler」+ doc 05 §9 版本化工具面演化 + PR #98 记录在案的
缺口；`packages/services/src/payswap/intent/`—— 纯确定性编译 + 进程内不可变
intent 注册表；无 IO、无凭据、无 provider 触达）：**

- **边界（doc 06 §2.4 逐字落地）**：自然语言理解是模型的活；金融语义是确定性
  代码。模型经 `compile_intent` 提交 **draft**（v1 params 不变；v2 additive 可选
  结构字段：kind / senderConnectionId / recipientId / rail / purpose / deadline /
  maxTotalCost / privacy / allowPartial / fxToleranceBps / minimumReliability）；
  编译器把 draft 与证据（sender = wave 1 能力记录；recipient = wave 3
  verified-recipient 证据）对齐，产出三值 union：`{kind:"intent", intent,
  eligibilityQuery}` | `{kind:"clarification", requests[]}` | typed 拒绝。
  **物质字段缺失（kind/amount/currency/recipientId/senderConnectionId/purpose）
  = clarification 请求，不是 refusal；证据缺席 = typed 拒绝，不是 clarification**
  —— 二者永不混用（材料缺口可由操作者补，证据缺口只能由 provider 证据补）。
- **typed 拒绝闭集**：`intent_recipient_unverified`（recipientId 无 verified
  证据 —— doc 12 §3「user/model claims alone are insufficient」）、
  `intent_sender_evidence_unavailable`（sender 连接无能力记录，与
  eligibility_evidence_unavailable 同构）、`intent_amount_invalid` /
  `intent_currency_invalid`（Money 字形违规 —— decimal string，永不 float）、
  `intent_kind_unknown`（闭集外 kind）、`intent_rail_unsupported`（draft 声明的
  rail 不在 sender 能力记录的证据内 —— **用户 rail 偏好永不压过 provider 证据**，
  P4 验收逐字）、`intent_operation_unsupported`（draft 显式提名的 operation 不在
  sender 能力记录的证据内）。拒绝消息零凭据材料。
- **intent 形状**：doc 06 §2.1 `FinancialIntent` 的 P4 子集 —— intentId 由 host
  分配（UUIDv7；编译器不产 id 就不产 intent）；principal 来自 broker 已解析的
  会话（模型陈述永不是 principal）；sender 只携带 connected-account 引用 +
  capability revision；recipient 只携带 verified-recipient 引用；Money/purpose/
  sourceConstraints/constraints 按 wave 3 parties.ts 字形。intent **不可变**；
  注册表 revision 递增、历史保留、frozen views、stale 声明拒绝（wave 1 同款）。
- **eligibilityQuery 派生**：编译时从证据确定性地派生 `{ operation, connectionId,
  constraints }`。kind→§6.1 操作 id 的**版本化映射表 v1（TL 决定 2026-11-26）**：
  `send → collections.read`；`collect → collections.read`；`sweep → payouts.read`；
  `refund → payment_objects.read`；`convert`/`review` 无已证 read-half 操作 →
  clarification（除非 v2 的可选 `operation` 字段显式提名，提名值必须在 sender
  能力记录内有证据，否则 typed `intent_operation_unsupported`）。rail 偏好只在
  sender 能力记录支持时生效。`check_eligibility` 的
  `{ intentId }` 解析到这份已派生的 query —— PR #98 记录的「intentId 解析到
  typed intent facts」缺口在此闭合。
- **broker 接线**（`bootstrap payswap-broker/dispatch.ts`）：新注入面
  `intentEligibilityReader(intentId)`（与 accountOverviewReader/accountDetailReader
  同门装配）；三码法则照旧最先行；intent 未知 → typed `intent_unknown`
  **（TL 决定 2026-11-26：intent 解析失败是新 typed 码 —— 三码法则只描述连接/模式
  状态，不复用）**；命中 →
  `evaluatePayswapEligibility` 的 answer union 原样作业务 data
  `{kind:"eligibility", answer}`；clarification 作 `{kind:"clarification", requests}`
  业务 data **（TL 决定 2026-11-26：wire 面先行，elicitation UI 随后续切片）**。wire 形状单一事实源进
  `operations.ts`（broker 与插件共用，永不漂移）。六操作闭集不扩。
- **约束 schema 补全（PR #98 记录的另一半）**：wave 1 的
  `payswapCapabilityRestrictionSchema` 增加可选结构化形
  `allow?/deny?/min?/max?`（doc 05 §4 形状；decimal string）；query 侧约束维度
  增加 purpose/product/entitlement（beneficiary = 既有 recipientKind 维度）；
  裁决法则不变（记录无该类结构化数据而 query 携带 → 逐类 typed
  `eligibility_constraint_unevidenced`）。
- **无权威外溢**：编译器不铸造 grant、不路由（P5）、不提交（P7）、不写 ledger
  （P7 证据账本切片接手持久化 —— 进程内注册表是 P4 的 wire 面，边界如实记录）；
  intent/clarification/eligibility 任何答案都不是授权（doc 12 §2.2）。结构断言
  与 wave 1/2/3 同款。

**P4 wave 5 —— blockchain/wallet 约束证据（addendum §13 边界的 schema 层投影；
`packages/shared/src/payswap/chain.ts` —— 纯 schema + 纯函数；无 IO、无密钥材料、
无链上写面、无链表发明）：**
- **四族证据分立（§13.1「separate capabilities, not one crypto provider」的家族
  层投影）**：wallet address-control 证据是**第四族**，住独立模块、携带独立
  source 闭集（`address-proof-of-control`），与 wave 3 三族（sender 能力记录 /
  verified-recipient / participant）互不充当对方证据、互不可变换 —— 结构断言
  与 wave 3 同款延伸到四族。
- **canonical network identity（§13.3/§13.4）**：`{namespace, reference}` 形状
  （CAIP-2 对齐、namespace 无关 —— 不钉任何链表，链专属词汇随 adapter 切片且
  只从 provider 证据来）；canonical 字符串形 `namespace:reference`。
- **address proof-of-control（§13.2 逐字落地）**：记录必须携带 challenge 绑定
  证据（challengeId + evidenceRef + source + verifiedAt）、address、canonical
  chain id、freshnessBoundMs。成功连接**只证明挑战期内对该地址的控制** —— schema
  层不含也永不添加任何 spending/allowance/mandate 字段；seed phrase /
  private key / mnemonic 类字段 strict 拒绝（结构性禁令 —— §13.2 MUST NOT 的
  schema 投影）；拒绝与消息零密钥材料。
- **chain 约束维度**：eligibility query constraints 增加 `chain` 维度（值面与
  其他维度同纪律 —— 自由字符串；canonical 字形由本 wave 的
  `payswapCanonicalChainIdSchema` 承载，供 wallet 证据与未来 rail-detail 校验
  消费）；capability restriction kinds 闭集增加 `"chain"`（结构化 allow/deny
  照旧裁决 —— 通用逐维法则不变：记录无该类结构化数据而 query 携带 → typed
  `eligibility_constraint_unevidenced`，unknown ≠ optimistic）。
- **rail detail 联动（wave 3 已有的 schema 投影收紧点，本 wave 只记录法则）**：
  `class:"blockchain"` 的 rail detail 应为 canonical chain id 字符串 —— 校验
  随 compile-face 切片（wave 3 的 superRefine 保持原样，不在本 wave 收紧）。
- **无权威外溢（§13.3/§13.5）**：本 wave 不产 adapter 面、不产签名/广播/提交
  面、不产链表、不产 connector 实现 —— 它们各自随 §13.1 契约切片落地；P7
  authorization/reconciliation 门原样有效。结构断言与 wave 1–4 同款。
