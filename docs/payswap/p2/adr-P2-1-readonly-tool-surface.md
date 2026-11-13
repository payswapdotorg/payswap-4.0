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
