# services-payswap

PaySwap P2.2 的账户服务模块（deliverable 06 §2.2「PSP account & credential
management」；deliverable 05 §5 认证面的 host-service 半）。法则（schema/模板/
投影/authSpec/typed refusal）住 `@zcode/shared/payswap` 的 `account-connection.ts`
—— 本模块只做编排：凭据端口 + 连接记录 store + 时间/随机性注入。

不变量（违反即实现缺陷）：

- **单一写者**：连接记录与 PSP 秘密的写路径只经
  `createPayswapAccountService`（doc 06 §2.2）。UI 投影读、adapter 进程内读 ——
  都不是写者。
- **秘密只落 ICredentialService**：`payswap:psp:<providerId>:<connectionId>:
  <secretKind>` 键，Gate E2 键级政策（safeStorage 键 / `ZCODE_CREDENTIAL_SECRET`
  / 否则 fail-closed typed 拒绝）在 credentialService 侧执行；本模块永不缓存、
  永不日志、永不投影秘密。
- **拒绝先于记录**（connect）：凭据 store 拒绝 → 零落盘（连接记录也不写）；
  记录写失败 → 尽力删除已存秘密（不留孤儿 PSP 密文）后原错误上抛。
- **先标 revoked 再删秘密**（revoke）：任何中间态绝不留下失真的 connected；
  幂等重撤销补清残留秘密。Stripe 是 delete-local-only（doc 04）；provider 侧
  deauthorize（`delete-and-provider-deauthorize`）随该 provider 的证据落地。
- **投影面**：对 UI/模型的返回只有五字段状态投影（shared schema）—— 秘密在
  类型面上不可达。
- **格式检查是防御性的**：formatCheck 通过 ≠ 凭据有效；最终权威是 provider
  read-back（refreshEvidence，下一条）。
- **refreshEvidence（provider read-back，slice 2）**：注入的读回端口
  （`PayswapAccountReadBackPort`，host 进程内）三值结局驱动状态机 ——
  `verified`（`expired`→`connected` 恢复行；`connected` 保持）/ `auth-failed`
  （`connected`→`expired` —— 唯一的 expiry 证据是 provider 的拒绝，
  doc 05 §5「A revoked connection can never keep a stale connected status」
  的 expired 对偶）/ `unavailable`（typed `read_back_unavailable` 拒绝，状态
  不变 —— unknown ≠ expired，doc 05 §6.4 读回权威纪律）。revoked 终态：不触
  端口、不读秘密，直回投影。**状态变更才写记录**（无变更不写 —— 记录无
  churn，与单一写者纪律一致）；秘密读取走凭据端口 `load`（Gate E2 fail-closed
  拒绝映射 typed refusal，code 逐字复用）；秘密缺失（记录 connected 而键不在）
  = 本地不一致行 —— typed 拒绝、状态不变（无 provider 证据不翻状态；操作员
  revoke 或重连处置）。端口缺席 = fail-closed typed 拒绝（无 adapter 即无
  读回，不猜）。原始 read-back 证据落账（ledger seq、能力记录引用）随 P2
  能力注册表切片，本切片只落状态迁移。

连接记录 store（`accounts/connectionRecordStore.ts`）：非秘密 JSON store（app
配置目录 `payswap-connections.json`，0600 原子写 + 跨进程文件锁）；
corrupt-refuse-overwrite（typed `PAYSWAP_CONNECTIONS_STORE_CORRUPT`，绝不自动
覆盖）；IO 全注入。

真实 Stripe 读回 adapter（`providers/stripe/readBackAccount.ts`，slice 3，doc 06
§2.9 provider 运行时的 Stripe 落地）：

- **端口实现**：`createStripeAccountReadBackPort(deps)` 返回 shared 法则的
  `PayswapAccountReadBackPort`。HTTP Bearer 验证 `GET https://api.stripe.com/v1/account`
  （doc 04 §1.1：test/live 同端点、模式由键前缀区分 —— 模式不切端
  点，不发明）。
- **结局映射（doc 05 §6.4 unknown 纪律）**：200 + 非空 `id` →
  `verified{providerAccountId}`；**401 是唯一的 auth-failed 证据**（provider 拒绝
  凭据）；其余一切（非 200/非 401、非 JSON、缺 id、传输异常、超时）→
  `unavailable`（unknown ≠ expired，读回失败永不假装成功也永不假装 auth 失败）。
- **装配防线（先于任何网络触达）**：`providerId ≠ "stripe"` 或
  `secretKind ≠ "api-key"` = 装配错误 → 抛出（accountService 映射为
  `read_back_unavailable` typed 拒绝，状态不变）；秘密前缀推导的模式与记录
  `mode` 不一致 = 本地不一致 → `unavailable`（不触网 —— 无 provider 证据不翻
  状态）。
- **零秘密外泄**：秘密只入 `Authorization` 头；任何 detail/message 永不携带
  秘密材料；adapter 不日志、不持久化。
- **IO 全注入**：transport 经 `ApiClient`（`@zcode/shared` 既有抽象，
  `timeoutMs` 随 init 传递 —— 执行归实现，与 NodeApiClient 同一契约）；缺省
  = `globalThis.fetch` + AbortController 超时执行（缺省 10 s，可注入）。

P2.2 后续切片已全部落地（slice 5-9；ADR-P2-2 定案 —— 法则与模块先行、入口
接线随活的窗口证明）：

- additive RPC channel（连接 UI 的 renderer→main 面，slice 7）与连接 UI
  （slice 8）已落地；`ZCODE_PAYSWAP_PSP_KEY` 的交付按 ADR-P2-2 Decision 2
  收窄为 desktop main 内账户运行时的**进程内 env 视图**（不再
  hostProcessLocalEnv 跨进程注入 —— host 永不接触 PSP 秘密材料）；
- desktop main 入口接线（app-ready 预热 + 桥入口 spawn 端口转移，slice 8/9）
  与连接流的 desktop Browser E2E 臂（payswap-connection-ui.test.ts）已落地。

**ADR-P2-1 只读数据面（slice 4）**：

- **Stripe 数据 adapter**（`providers/stripe/readAccountData.ts`，
  `PayswapAccountDataReadPort` 实现）：四闭集类别 → `GET /v1/balance`、
  `GET /v1/charges?limit=10`、`GET /v1/customers?limit=10`、
  `GET /v1/disputes?limit=10`（全部 GET —— no-write 的 wire 证明；Bearer；
  固定近因窗口；事实清单 `docs/payswap/provider-facts/stripe-readonly-endpoints.md`）。
  结局映射：200 → strict redacted 解析（白名单拷贝 —— PII 永不进数据面）；401 →
  `auth-failed`；403 → `refused{insufficient_permission}`；其余 → `unavailable`。
  装配防线（providerId/secretKind/类别路由错配 → 抛出；前缀模式与记录 mode 不一致
  → 不触网 unavailable）与读回半同款。
- **能力证据捕获**（`readBackAccount.ts` 扩展）：/v1/account 200 时从
  `capabilities` + `requirements` 捕获 `PayswapAccountCapabilityEvidence`（排序、
  计数摘要、disabledReason）；全有或全无 —— 任一半畸形 → verified 不携带证据
  （认证语义不变；概览 detail 面对缺席证据 fail-closed 拒绝）。
- **`getOverviewData` 编排半**（`accountService.ts`）：验证读先于数据读（复用
  refreshEvidence 同一状态机：401 翻 expired 持久化后答 `expired`、verified 翻回
  connected；状态变更才写）；**能力面答案在场才读四类别**（全部现读、固定顺序）：
  读回证据 `evidence` 照原样入 detail；adapter 显式声明的 `capabilityGap` 以
  `capabilityRefusal` 入 detail（shared CONTRACT「P3 provider 缺席面」）；二者皆
  缺席 → detail fail-closed 拒绝（不变）；类别 403 → 该类别 typed 拒绝、其余照读；
  数据端口缺席 → 四类别诚实 `unavailable`；revoked/unknown 终态零端口触达。
- **broker detail 面**（`bootstrap payswap-broker/dispatch.ts`）：新注入面
  `accountDetailReader`（与 `accountOverviewReader` 同门）—— `connectionId`
  收窄且三码法则已过时被咨询；typed detail 联合原样入
  `PayswapAccountOverviewData.account`；抛错 → `internal_error`（§6.3）。

**P3 读回 adapter 的缺席面声明**（shared CONTRACT「P3 provider 缺席面」的实现半；
每个缺口都是 adapter 对已钉住官方事实的显式声明）：

- **Paystack**（`providers/paystack/readBackAccount.ts`）：`/balance` 200 + 官方封套
  = provider 认证了凭据 → `verified`，携 `providerAccountId: null` + `identityGap`
  （官方无 merchant/business self-identity 端点，pin 在案）+ `capabilityGap`（官方
  无能力读回面）。原「身份缺口 = `unavailable`」映射作废：读回并未失败，再拒绝会
  把四类别对话读永久挡在门外。401 仍是唯一的 auth-failed 证据；其余结局不变。
- **PayPal**（`providers/paypal/readBackAccount.ts`）：token 交换 200 + `app_id` →
  `verified{providerAccountId: app_id}` + `capabilityGap`（token `scope` → PaySwap
  操作能力的映射没有官方事实源，不编码）。直连与托管（custodian token 代理）两路
  共用同一映射函数 —— 缺口声明不会在两路之间漂移。
- **Stripe**：不变 —— 既不声明 `identityGap` 也不声明 `capabilityGap`；
  `verified` 不带 `evidence` 时概览 detail 面照旧 fail-closed 拒绝。

**P2.2 slice 5 —— 生产装配半（模块级）**：

- **账户运行时**（`runtime.ts`，`createPayswapAccountRuntime`）：单一
  `PayswapAccountService` 实例 + broker 的两个绑定 reader 面
  （`accountOverviewReader` = listConnections、`accountDetailReader` =
  getOverviewData —— 同一实例，无第二个写者）；凭据通道经 env 交付
  （`ZCODE_PAYSWAP_PSP_KEY` 的 services-reader 契约；env 缺席 → 装配照常、
  拒绝在操作面）；真实 Stripe 双 adapter（读回 + 数据）接进服务；IO 全注入。
- **desktop 键预热**（desktop-payswap `accountWarmup.ts`，
  `warmupPayswapPspRuntimeEnv`）：app-ready 现读键 store → `buildPayswapPspHostEnv`
  组装恰 `ZCODE_PAYSWAP_PSP_KEY`（desktop main 内账户运行时的进程内 env 视图
  —— ADR-P2-2 Decision 2）；fail-safe（不可用/后端不在认可闭集/解包失败 →
  空集 + 上报，永不阻断启动）；每次现读（safeStorage 恢复后免重启）。
- **协调器透传**（bootstrap `spawn-wiring.ts`）：`accountOverviewReader`/
  `accountDetailReader` 经协调器选项透传到 broker boot 选项（生产装配的接缝）。
- **放置决策已定案**（ADR-P2-2，Option A）：账户运行时住 desktop main，
  broker 的 reader 面是类型化跨进程桥（host 进程永不接触 PSP 秘密材料）；
  additive RPC channel（连接 UI 的 renderer 面）住 main —— 已随 slice 6-9 落地。

**P3 协议宿主边界**（`protocols/`；addendum §10 + doc 12 §6；shared CONTRACT
「P3 协议适配器边界」的宿主半 —— 消息面法则住 shared，本模块是其**唯一生产
调用面**）：

- **一个宿主、一个实例**（`protocolRuntime.ts`）：生产装配只经
  `createPayswapProtocolRuntime` —— 证据权威、challenge 注册表、三个已落地
  消息面（登记表 `createPayswapProtocolMessageFaces`）与协议宿主成套创建。
  返回面只有 `protocolHost`：证据签发能力（`issue`）留在闭包内。desktop main
  经既有的受监督账户运行时持有它（一个 PaySwap 运行时，不另起第二个）。
- **适配器只是不受信消息解释器**（`host.ts` 法则 1）：只有协议宿主调用
  `translateInbound` / `emitReceipt`；每个协议恰一个适配器（重复 = 装配抛错）。
  适配器不持有 challenge 注册表、证据权威或 provider 凭据。
- **宿主时钟是唯一时间源**（`host.ts` 法则 3）：进站调用不接收时间参数；
  过期裁决不可能被调用方供时影响。缺省系统时钟，测试注入。
- **challenge 关联与单次消费在宿主裁决**（`challengeRegistry.ts`）：
  - 注册表生命周期 = 宿主金融服务的进程生命周期（addendum §3.5(7) 同款：
    dedupe scope 是实例，不是连接）。适配器/agent 重连、账户运行时因钥匙串
    事件重建，都**不**重建它；宿主进程重启 = 一切旧 challenge 答 unknown
    （fail-closed）。全内存、无 IO —— 不是账本，不记录资金事实。
  - **MPP**：`issueMppChallenge` 要求 wire challenge 过 pinned schema、携 RFC
    3339 `expires` 且签发时刻未过期（宿主策略）、id 在存活期内唯一。凭据回显
    经适配器后给出 `mpp-challenge-echo`；宿主把回显按规范绑定字段投影
    （id/realm/method/intent/request/expires/digest/opaque/header；
    `description` 与未知参数不入绑定）重算 canonical 摘要，与签发记录逐字
    比对。裁决次序：unknown → method/intent 错配 → 绑定错配 → consumed →
    expired → 消费（「已消费」先于「已过期」：重放事实不被过期掩盖；过期不
    消费记录）。
  - **x402**（wire 上没有 challenge id —— 两个身份分开）：`issueX402Payment-
    Required` 把 402 的每个 accepts 条目按 canonical 摘要**广告**（幂等：重发
    刷新有效期；有效期 = 广告时刻 + 该条目 `maxTimeoutSeconds` —— **宿主
    策略**，spec 对 stale-402 服务端行为沉默），条目必须落在 supported subset
    内（宿主不得广告自己无法承兑的 requirements）。进站付款载荷：选中的
    requirements 必须命中一条在有效期内的已广告记录（否则 unknown / expired），
    且付款授权身份（network + from + nonce —— **不含签名字节**，ECDSA 可延展）
    恰好消费一次（否则 consumed）；消费记录保留至该授权的 `validBefore` 或
    保留上限（`PAYSWAP_X402_CONSUMED_CREDENTIAL_RETENTION_MAX`）。同一
    requirements 的第二笔合法付款不是重放。
  - **原子 check-and-set**：检查与置位之间没有 await —— 并发重复提交恰有一个
    成功。清理按规模阈值摊还（`maybeSweep`），长期运行不退化成每次 O(n)。
  - **AP2**：mandate / receipt 不是宿主签发的 challenge —— 进站只是不可信
    提案，不产生宿主状态；本宿主不假装拥有其单次使用语义。
- **消费 ≠ 认证**（`host.ts` 法则 4）：消费成功的结局是 `challenge-consumed`
  且 `credential: "unverified"`。P3 不做密码学验签（shared CONTRACT「签名
  姿态」）—— 履行前必须经网络 / facilitator 验证；结局里没有任何
  verified / authenticated / settled 位可被下游读取。
- **收据只从宿主证据权威签发过的证据发出**（`host.ts` 法则 5 +
  `evidenceAuthority.ts`）：调用方只能给 `evidenceRef`，宿主按引用取回本宿主
  签发的记录再交给适配器；伪造引用 → `protocol_receipt_unavailable`，跨协议
  复用 → `protocol_evidence_untrusted`（evidence-gate）。不可伪造性 = 进程内
  能力（对象身份即签发记录：克隆 / 序列化往返 / 另一权威实例的对象都不在册）
  —— 与 P1 grant ledger 的配对 minter 同一纪律；`issue` 只接受收据门会接受
  的形状（签发即合形）。
- **P3 的生产姿态：发不出任何收据**。P3 没有结算事实的签发者（P7 的执行/
  对账权威才接管 `issue`）—— 生产宿主对任何协议、任何证据引用都 typed 拒绝。
  这是设计结论，不是缺陷：API acceptance ≠ settlement。
- **不是第二个账本**：本目录不持久化、不写任何账本；challenge 注册表是有界的
  传输/重放状态（doc 12 §6「Protocol transport state may be bounded adapter
  state；financial facts remain in the one PaySwap ledger」）。
