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

尚未落地（随 P2.2 后续切片，D12.7 同款纪律——法则与模块先行，入口接线随活的
窗口证明）：

- additive RPC channel（连接 UI 的 host 暴露面）与平台壳 onboarding UI；
- desktop main 入口接线（app-ready 预热 + `ZCODE_PAYSWAP_PSP_KEY` 的
  hostProcessLocalEnv 注入 —— desktop-payswap/CONTRACT.md 的 P2 交付段；
  生产装配把本切片的 Stripe adapter 与 accountOverviewReader 接进 broker）；
- 连接流的 desktop Browser E2E 臂 —— 随活的窗口证明切片。

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
  connected；状态变更才写）；证据在场才读四类别（全部现读、固定顺序）；类别
  403 → 该类别 typed 拒绝、其余照读；数据端口缺席 → 四类别诚实 `unavailable`；
  revoked/unknown 终态零端口触达。
- **broker detail 面**（`bootstrap payswap-broker/dispatch.ts`）：新注入面
  `accountDetailReader`（与 `accountOverviewReader` 同门）—— `connectionId`
  收窄且三码法则已过时被咨询；typed detail 联合原样入
  `PayswapAccountOverviewData.account`；抛错 → `internal_error`（§6.3）。
