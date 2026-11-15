# Stripe read-only endpoint facts（ADR-P2-1 数据面事实清单）

> **Evidence standard**（doc 06 §2.13，normative for adapter facts）：adapter 编码的
> 每个 provider wire 事实都必须有当前 fact-sheet 引证（检索日期 + 复核期限）。
> 本清单覆盖 P2 只读数据面的四个端点；认证/账户/能力事实已在
> [doc 04 §1](../p0/04-provider-auth-comparison.md) 在案（检索 2026-11）。
>
> **复核记录**：初始检索基线 **2026-11-13**；**2026-11-15 P3 二批复核完成**
> （见下方复核结果 —— S-RO-4 捕获一处事实漂移：dispute id 前缀）。

| # | Fact | Endpoint / shape | Status |
|---|---|---|---|
| S-RO-1 | 余额读回是 `GET /v1/balance`（Bearer）；`available[]`/`pending[]` 各为 `{amount, currency}` 数组；`amount` 是 **minor-unit 整数**（如美分） | `GET https://api.stripe.com/v1/balance` | ✅ RE-VERIFIED（2026-11-15：docs 样例载荷 `available: [{amount: 666670, currency: "usd", source_types: {...}}]`；白名单 `{amount, currency}` 不变 —— `source_types` 等额外字段照旧不拷贝） |
| S-RO-2 | 支付对象（Charge）列表是 `GET /v1/charges`；支持 `limit` 查询参数（上界 100；P2 固定 10）；行携带 `id`（`ch_*`）、`amount`（minor-unit 整数）、`currency`、`status`（如 `succeeded`/`failed`/`processing`）、`created`（unix 秒）、可选 `description` | `GET https://api.stripe.com/v1/charges?limit=10` | ✅ RE-VERIFIED（2026-11-15：limit 语义逐字「Limit can range between 1 and 100, and the default is 10.」；样例 `ch_3MmlLrLkdIwHu7ix0snN0B15`；status 词汇 `succeeded`/`failed`/`processing`/`refunded` 在案） |
| S-RO-3 | 客户列表是 `GET /v1/customers`（同 `limit` 语义）；行携带 `id`（`cus_*`）、`created`、可选 `description`；行还携带 `email`/`name`/`phone` 等 PII —— **PaySwap 的 redaction 白名单不拷贝它们**（ADR-P2-1 法则 4） | `GET https://api.stripe.com/v1/customers?limit=10` | ✅ RE-VERIFIED（2026-11-15：`cus_NffrFeUfNV2Hib` 样例在案；email（"email address of the customer"）/name（"customer's full name or business name"）字段在案 —— PII 白名单法则维持原状） |
| S-RO-4 | 争议列表是 `GET /v1/disputes`（同 `limit` 语义）；行携带 `id`、`amount`（minor-unit 整数）、`currency`、`status`、可选 `reason`（如 `fraudulent`）、`created` | `GET https://api.stripe.com/v1/disputes?limit=10` | ⚠ **RE-VERIFIED with drift（2026-11-15）**：status 枚举在案（`needs_response`/`under_review`/`won`/`lost` + `warning_needs_response`/`warning_under_review`/`warning_closed`）；`reason: "fraudulent"`、`amount` 整数、`created` unix 在案。**漂移**：dispute 对象样例 id 现为 **`du_*`**（`"id": "du_1MtJUT2eZvKYlo2CNaw2HvEv"`，`"object": "dispute"`），现行 dispute object 文档页已无 `dp_*` 样例 —— 本清单 2026-11-13 版按 `dp_*` 著录的行就此更正。readAccountData.ts 的争议 redaction 只校验 `id` 为字符串、不耦合前缀，故无代码漂移；证据面以本行为准 |
| S-RO-5 | 四端点全部为 **GET**（无任何写副作用）；认证与 doc 04 §1.1 同源（HTTP Bearer；test/live 同基 URL `https://api.stripe.com`，模式由键前缀区分） | — | ✅ RE-VERIFIED（2026-11-15） |
| S-RO-6 | restricted key 的 per-resource 读权限缺失时端点答 **403**（doc 04 §1.3 的 per-resource permissions）；凭据无效答 **401**；限流答 429 | — | ✅ RE-VERIFIED（2026-11-15：keys/restricted-api-keys 页「When you create a RAK in the Stripe Dashboard, you select which Stripe resources the key can access and the permissions…」+「Write permissions imply read permissions」；errors 页 401/403/429 词汇在案 —— 403→`refused{insufficient_permission}` 映射维持） |

## Adapter mapping（单一事实源：`packages/services/src/payswap/providers/stripe/readAccountData.ts`）

- 类别→路径的闭集映射：`balance → /v1/balance`；`payment_objects → /v1/charges?limit=10`；
  `customers → /v1/customers?limit=10`；`disputes → /v1/disputes?limit=10`。
- 结局映射：200 → strict redacted 解析（白名单字段 + minor-unit 整数字符串）；
  401 → `auth-failed`；403 → `refused{insufficient_permission}`；其余（404/429/5xx/
  非 JSON/畸形 200/传输/超时）→ `unavailable`（unknown ≠ failed）。
- redaction 白名单（schema 即法则）：余额 `{amount, currency}`；支付对象
  `{id, amount, currency, status, created, description}`；客户
  `{id, created, description}`（**PII 永不拷贝**）；争议
  `{id, amount, currency, status, reason, created}`。

## 2026-11-15 复核批（doc 04 §5 清单第 1 项的补充验证）

- [x] S-RO-1..S-RO-6 逐条对照 live Stripe API 文档复核（dated-evidence 纪律）—— 完成（见上表；S-RO-4 捕获并更正 `dp_*`→`du_*` 漂移）。
- [x] Charge `status` 词汇当前集 —— `succeeded`/`failed`/`processing`/`refunded` 等在 docs 页在案（受 api_version 影响的完整矩阵未逐版本枚举；adapter 只透传 status 字符串，不枚举校验）。
- [x] `limit` 上界与默认值 —— 逐字「Limit can range between 1 and 100, and the default is 10.」。
- [x] restricted key（RAK）权限粒度 —— per-resource Read/Write 选择制；「Write permissions imply read permissions」；`rk_test_`/`rk_live_` 前缀在 keys 页在案（doc 04 §1.3 的 ⚠ 就此闭合）。
- [x] webhook tolerance 缺省 —— docs webhooks 页：「tolerance of 5 minutes between the timestamp and the current time」（可调，Stripe 建议保留；doc 04 §1.4 ⚠ 闭合）。
- [x] idempotency-key 保留 —— docs api/idempotent_requests 页：「24 hours old. We generate a new request if a key is reused after the original is pruned.」（doc 04 §1.5 ⚠ 闭合）。
- [ ] Connect OAuth 当前姿态（doc 04 §1.2 ⚠）—— 本批未复核（P3 数据面不需要；留给涉 Connect 的后续工作包，复核期限顺延）。
