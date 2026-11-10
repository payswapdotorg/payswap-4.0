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
