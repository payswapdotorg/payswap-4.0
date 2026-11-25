# ADR-P2-1 — P2 只读工具面（the read-only conversational tool surface）

- **Status:** Accepted (TL, P2.2 slice 4)
- **Date:** 2026-11-13
- **Scope:** PaySwap P2（Stripe read-only vertical）的工具面形状 —— 「read-only ops
  (balances, payment objects, customers, disputes…) run conversationally」与「NO
  write operation exists in the tool surface yet」（register P2 验收）在既有法则下的
  落地方式。
- **Normative anchors:** deliverable 05 §6.1（operation taxonomy）/§6.6（typed
  refusals）/§9（agent-facing surface）；broker contract w2-01 §7.1（六操作闭集）/
  §7.2（N21 无第七操作）；deliverable 06 §2.2/§2.9；doc 04 §1.1–§1.3、§1.7。

## Context

P2 验收要求对话内只读操作（balances、payment objects、customers、disputes…）与
能力面（「capabilities are answered from provider read-back evidence with typed
refusals where unconfigured」），同时「NO write operation exists in the tool
surface yet」。工具面已有两条硬法则：

1. **闭集六操作**（w2-01 §7.1/N21）：`compile_intent · check_eligibility ·
   discover_routes · request_authorization · get_execution_status ·
   get_account_overview` —— dispatch 是代码里的闭集 enum→handler map，**无第七操作**。
2. **per-op params schema 1:1**（§6.1(3)）：工具的 params schema 就是操作的
   params schema，`.strict()`，住 shared。

## Decision

1. **`get_account_overview` 是 P2 的只读对话面**（THE read surface）：无
   `connectionId` → 连接投影清单（slice 3 既有行为原样保留）；携带 `connectionId`
   → **detail 模式**：`PayswapAccountOverviewData.account` 携带 typed detail 联合
   （`detail | expired | revoked | refused`，法则住 shared `account-data.ts`）——
   连接投影 + **能力证据**（`PayswapAccountCapabilityEvidence`：capabilities[] +
   requirements 摘要，doc 04 §1.2「exactly the evidence the capability registry
   should consume」）+ **四闭集类别**的只读数据（`balance | payment_objects |
   customers | disputes`）。不新增第七操作、不新增 params 键（`connectionId` 是
   slice 3 已有键）。
2. **类别枚举闭集**：`PAYSWAP_READONLY_CATEGORIES` 恰四类。**无 write 类别**是
   结构性的：类别枚举与操作枚举都不含 doc 05 §6.1 的 write 动词集
   （`PAYSWAP_WRITE_OPERATION_VERBS`，battery 断言的单一事实源）。
3. **四值类别结局**：`ok | auth-failed | refused | unavailable`（doc 05 §6.4
   unknown ≠ failed + §6.6 typed refusals）：401 是唯一 auth-failed 证据；403 →
   `refused{insufficient_permission}`（restricted key per-resource 权限边界，
   doc 04 §1.3 —— 「typed refusals where unconfigured」的 provider 证据语义）；
   其余一律 `unavailable`。
4. **redaction-by-construction**：类别数据 schema 白名单字段（strict）；客户行
   **只有** id/created/description —— email/name 等 PII 永不进数据面（doc 05
   §12.8 纪律的结构化落地，非事后擦除）。
5. **验证读先于数据读**（`getOverviewData` 编排）：每次 detail 现读 `/v1/account`
   （复用 refreshEvidence 同一状态机：401 翻 expired 并持久化、verified 翻回
   connected、状态变更才写）；验证通过且**能力证据在场**才读四类别 —— 证据缺席
   = fail-closed typed 拒绝（evidence, never claims）。类别读顺序固定
   （balance → payment_objects → customers → disputes），全部现读。
6. **固定近因窗口**：列表类别 `limit=10`（对话面的近因证据，非任意分页面 ——
   分页会引入新的参数面；P2 不发明）。
7. **其余五操作维持 §7.3 拒绝语义**：intent/eligibility/routing/grant/execution
   各随其领域切片（P4/P6/P7）落地 —— P2 不提前实现、不发明拒绝语义。

## Alternatives considered

- **新增 `payswap_read_provider_data` 第七工具** —— 违反 §7.1/N21 闭集法则，直接
  否决。
- **`check_eligibility` 承载能力面** —— 其 params 是 `{intentId}`（P4 的 intent
  编译器产物）；P2 无 intent，工具将只能回答自身领域外的拒绝。能力面归
  `get_account_overview` 的证据半（capabilities[] 即证据），P4 的 eligibility 引擎
  届时消费同一证据。
- **connect 时即验证凭据**（connect → 立即 read-back 验证）—— 连接流切片（UI 半）
  的 UI 编排会做 connect + refreshEvidence；服务法保持 connect = 存储门
  （formatCheck 防御性 + Gate E2 fail-closed），验证读是 refreshEvidence/
  getOverviewData 的状态机职责（单一状态机，不重复实现）。

## Consequences

- shared 法则新增 `account-data.ts`（类别枚举/证据引用/数据 schema/结局联合/
  detail 联合/端口类型）；读回 `verified` 结局 additively 可选携带
  `evidence`（既有 outcome 语义不变）。
- services 新增 Stripe 只读数据 adapter（`readAccountData.ts`）与
  `getOverviewData` 编排半；bootstrap dispatch 新增 `accountDetailReader` 注入面
  （与 `accountOverviewReader` 同门：三码法则优先，抛错 internal_error）。
- no-write 断言成为 battery 行（结构断言：类别枚举 × write 动词、六操作 × write
  动词）+ wire 断言（数据读全部 GET）。
- 事实纪律：四类别端点事实住
  `docs/payswap/provider-facts/stripe-readonly-endpoints.md`（doc 06 §2.13 的
  fact-sheet 纪律：检索日期 + 复核期限；adapter 事实无当前 fact-sheet 引证即
  review 失败）。

## Amendment 2026-11-17 — `requirements: null` 是显式的 provider 缺席证据（native Windows live 实证）

- **Trigger:** 原生 Windows live 验收（acct_1FPs7UAkPdhgtN6I，restricted rk_test 键）：
  `/v1/account` 与 `/v1/accounts/{id}` 对 **standard 账户的受限键自读**返回完整的
  `capabilities`（13 项）但**整个省略 `requirements` 字段**。原全有或全无捕获把
  缺席也判 null → 概览 detail 面 lawful typed 拒绝 `read_back_unavailable` ——
  链路其余九步（连接/at-rest/refresh verified/桥铸造/清单）全绿，仅 detail 面被拒。
- **Decision:** `PayswapAccountCapabilityEvidence.requirements` 改为 **nullable**：
  - requirements 字段**整个缺席** → `requirements: null`（显式的「provider 本次
    读回未暴露」证据 —— 绝不捏造零值；evidence, never claims 不变）；
  - requirements **在场但畸形** → 整体无证据（fail-closed 不变 —— 载荷与声明契约
    不符时不采信任何半区）；
  - capabilities 缺席/空/畸形 → 整体无证据（不变）。
- **Unchanged:** 概览 detail 的拒绝法则不变（evidence 缺席仍拒绝）；拒绝词汇闭集
  不变；no-write 结构断言不变。能力注册表消费 null 时语义为「provider 未暴露
  requirements」，不是「无 requirements 要求」。
- **Battery:** payswap-account-data.test.ts 新增 standard-account wire 形态用例
  （requirements 缺席 → evidence 携带 `requirements: null`，schema parse 通过）；
  既有正例（requirements 在场）与畸形例（present-but-malformed → 无证据）原样钉死。

## Amendment 2026-11-24 — provider 缺席面是 typed 答案，不是 detail 拒绝（P3）

- **Trigger:** P3 的 source-first 对账（register P3 行）发现：Decision 5 的「能力证据
  在场才读四类别」对 Paystack 与 PayPal 让四类别对话读**永不可达** —— Paystack
  读回因无官方自身份端点一律答 `unavailable`，PayPal 的 `verified` 不带能力证据，
  于是 `getOverviewData` 对两个 P3 provider 恒答 `read_back_unavailable`。这与
  register 的 P2/P3 验收条款直接冲突：「the four read-only categories … return real
  data conversationally through the production path」+「capabilities are answered from
  provider read-back evidence **with typed refusals where unconfigured**」。原门把三件事
  并成了一件：凭据是否有效、provider 是否签发账户标识、provider 是否暴露能力证据。
- **Decision:** 三者分开作答（法则全文见 shared CONTRACT「P3 provider 缺席面」）。
  - 读回 `verified` 的 `providerAccountId` 可为 `null`，当且仅当 `identityGap` 在场
    （码 `provider_identity_not_exposed`）——「provider 认证了凭据」是 `verified` 的
    事实来源，身份缺席不再是 `unavailable`。
  - 读回 `verified` 可携带 `capabilityGap`（码 `capability_evidence_not_exposed`，
    与 `evidence` 互斥）—— adapter 对已钉住官方事实的显式声明。
  - 概览 detail 的能力面答案恰一：`evidence` 或 `capabilityRefusal`。两者皆缺席仍
    fail-closed 拒绝 —— Decision 5 对 Stripe 逐字不变；放行只发生在 adapter **显式
    声明**缺口时，服务永不因 `evidence` 恰好缺席而放行。
  - 类别读法则（Decision 2–4、6）不变：类别各自 typed 作答，官方无面的类别照旧
    `refused{unsupported_operation}` / `unavailable`；redaction-by-construction 不变。
- **Unchanged:** no-write 结构断言；拒绝词汇闭集（新增两枚 typed 码均有 law
  battery）；六操作闭集；验证读先于数据读；401 唯一 expiry 证据。
- **Downstream:** `capabilityRefusal` 对 P4 eligibility 的语义是 unknown =
  unavailable（doc 05 §4「Unknown = `unavailable`, not optimistic defaults」）。
- **Battery:** payswap-account-data.test.ts（detail 携 `capabilityRefusal` + 四类别
  照读；二者皆缺席仍拒；schema 不变量 null⇔identityGap、gap⇔¬evidence）；
  payswap-paystack-provider / payswap-paypal-provider（adapter 缺口声明、无捏造
  身份）；reader-bridge 与 broker dispatch（detail 携 `capabilityRefusal` 原样过桥）；
  两个 live conformance 套件的真实 API 行改钉新法则。
