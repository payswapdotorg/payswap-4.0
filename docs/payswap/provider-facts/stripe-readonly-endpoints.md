# Stripe read-only endpoint facts（ADR-P2-1 数据面事实清单）

> **Evidence standard**（doc 06 §2.13，normative for adapter facts）：adapter 编码的
> 每个 provider wire 事实都必须有当前 fact-sheet 引证（检索日期 + 复核期限）。
> 本清单覆盖 P2 只读数据面的四个端点；认证/账户/能力事实已在
> [doc 04 §1](../p0/04-provider-auth-comparison.md) 在案（检索 2026-11）。
> 本清单的检索基线：**2026-11-13**；复核期限：**P3 开始前**（Paystack/PayPal
> 数据面清单建立时一并复核 Stripe 行）。

| # | Fact | Endpoint / shape | Status |
|---|---|---|---|
| S-RO-1 | 余额读回是 `GET /v1/balance`（Bearer）；`available[]`/`pending[]` 各为 `{amount, currency}` 数组；`amount` 是 **minor-unit 整数**（如美分） | `GET https://api.stripe.com/v1/balance` | ⚠ RE-VERIFY（2026-11-13） |
| S-RO-2 | 支付对象（Charge）列表是 `GET /v1/charges`；支持 `limit` 查询参数（上界 100；P2 固定 10）；行携带 `id`（`ch_*`）、`amount`（minor-unit 整数）、`currency`、`status`（如 `succeeded`/`failed`/`processing`）、`created`（unix 秒）、可选 `description` | `GET https://api.stripe.com/v1/charges?limit=10` | ⚠ RE-VERIFY（2026-11-13） |
| S-RO-3 | 客户列表是 `GET /v1/customers`（同 `limit` 语义）；行携带 `id`（`cus_*`）、`created`、可选 `description`；行还携带 `email`/`name`/`phone` 等 PII —— **PaySwap 的 redaction 白名单不拷贝它们**（ADR-P2-1 法则 4） | `GET https://api.stripe.com/v1/customers?limit=10` | ⚠ RE-VERIFY（2026-11-13） |
| S-RO-4 | 争议列表是 `GET /v1/disputes`（同 `limit` 语义）；行携带 `id`（`dp_*`）、`amount`（minor-unit 整数）、`currency`、`status`（如 `needs_response`/`under_review`/`won`/`lost`）、可选 `reason`（如 `fraudulent`）、`created` | `GET https://api.stripe.com/v1/disputes?limit=10` | ⚠ RE-VERIFY（2026-11-13） |
| S-RO-5 | 四端点全部为 **GET**（无任何写副作用）；认证与 doc 04 §1.1 同源（HTTP Bearer；test/live 同基 URL `https://api.stripe.com`，模式由键前缀区分） | — | ⚠ RE-VERIFY（2026-11-13） |
| S-RO-6 | restricted key 的 per-resource 读权限缺失时端点答 **403**（doc 04 §1.3 的 per-resource permissions）；凭据无效答 **401**；限流答 429 | — | ⚠ RE-VERIFY（2026-11-13） |

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

## 复核清单（P3 前）

- [ ] S-RO-1..S-RO-6 逐条对照 live Stripe API 文档复核（dated-evidence 纪律）。
- [ ] Charge `status` 词汇当前集（受 api_version 影响）。
- [ ] `limit` 上界与默认值是否有变化。
- [ ] restricted key 权限粒度列表（doc 04 §1.3 的 ⚠ RE-VERIFY 项）是否覆盖四端点。
