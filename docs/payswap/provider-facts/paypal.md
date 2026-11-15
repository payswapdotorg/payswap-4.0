# PayPal fact sheet (P3 — read-only provider conformance)

> Retrieval batches: **2026-11-15 first pass** (TL ops environment, plain
> HTTPS, no JS rendering), **2026-11-15 second pass** (headless-browser JS
> rendering of developer.paypal.com + live sandbox API probes with fake
> credentials only — zero real secrets, zero writes) and **2026-11-15 third
> pass (late UTC)** (headless-browser JS rendering + the official machine-
> readable OpenAPI specs published at `developer.paypal.com/api/
> <area>/v1/schema.json`, OpenAPI 3.2.0 — zero real secrets, zero writes).
> Upstream baseline: `docs/payswap/p0/04-provider-auth-comparison.md` §3
> (as of 2026-11, ⚠ RE-VERIFY flags preserved there; this sheet is the
> re-verification record).
>
> Docs-reorganization fact (recorded 2026-11-15, second pass): the payouts
> reference moved — `developer.paypal.com/api/payments/payouts/` now answers
> "Page not found"; the live pages are `developer.paypal.com/api/payouts`
> (guide, "Last updated: September 10, 2026") and the OpenAPI reference pages
> under `developer.paypal.com/api/payments.payouts-batch/v1/…`.

## Verified (2026-11-15 — first pass re-confirmed, second/third pass extended)

| # | Fact | Source | Retrieval |
|---|---|---|---|
| P-1 | OAuth 2.0 client-credentials: `POST /v1/oauth2/token`, HTTP Basic (`CLIENT_ID:CLIENT_SECRET`), `grant_type=client_credentials`; token sent as `Authorization: Bearer <token>`; on expiry call `/v1/oauth2/token` again (no refresh flow for this grant) | https://developer.paypal.com/api/rest/authentication/ ("Last updated: June 30, 2026") | 2026-11-15 |
| P-2 | Token response carries `expires_in` (seconds; official sample value **31668**) and a `scope` list; guidance is to **reuse tokens until expiry** ("reuse OAuth 2.0 access tokens (till their expiry time)") — cache host-side, never re-fetch per call | same page (sample response) + https://developer.paypal.com/api/payouts (rate-limiting guideline) + https://developer.paypal.com/api/rate-limiting ("Last updated: June 4, 2026") | 2026-11-15 |
| P-3 | Sandbox and live are distinct apps/environments with distinct base URLs: `api-m.sandbox.paypal.com` vs `api-m.paypal.com` (reference pages declare server URL `https://api-m.sandbox.paypal.com/`) | authentication page + API reference pages | 2026-11-15 |
| P-4 | **Live-probed**: the sandbox token endpoint is live and answers invalid client credentials with HTTP 401 `{"error":"invalid_client","error_description":"Client Authentication failed"}` (probe used syntactically fake credentials only — the 401 envelope is the auth-failed evidence shape for the token mint) | live probe of `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` | 2026-11-15 |
| P-5 | Read-only scope URIs (client-credentials flow): transactions `https://uri.paypal.com/services/reporting/search/read`; balances `https://uri.paypal.com/services/reporting/balances/read`; disputes `https://uri.paypal.com/services/disputes/read-buyer` (+ `read-seller`, `update-seller`, `read-buyer` in the scope table); vault read `.../services/vault/payment-tokens/read`; payouts `.../services/payments/payouts`; webhooks `.../services/webhooks`; `openid` | https://developer.paypal.com/api/transaction-search/v1/search-get · /api/transaction-search/v1/balances-get · /api/customer-disputes/v1/disputes-get · https://developer.paypal.com/apps-scopes-and-credentials ("Last updated: May 21, 2026") | 2026-11-15 |
| P-6 | Scope semantics: "Scopes define your app's permissions and access levels to PayPal services. The scope field in the authentication response shows all available permissions for your app." | apps-scopes-and-credentials page | 2026-11-15 |
| P-7 | **Balances read**: `GET /v1/reporting/balances` ("List all balances. Specify date time to list balances for that time"); optional `as_of_time` (RFC3339, "will return the last refreshed balance in the system when not provided"); "It takes a maximum of three hours for balances to appear in the list balances call"; response carries `last_refresh_time` and per-currency `total_balance` / `available_balance` / `withheld_balance` (`{currency_code, value}`) | https://developer.paypal.com/api/transaction-search/v1/balances-get | 2026-11-15 |
| P-8 | **Transactions read**: `GET /v1/reporting/transactions`; `start_date` and `end_date` **required** (RFC3339 with seconds, length 20–64); optional `fields` (`transaction_info` or `all`), `transaction_status` filter, `balance_affecting_records_only`, `page`/`page_size` (default 20 per docs example); response `transaction_details[].transaction_info` carries `paypal_account_id`, `transaction_id`, `transaction_status`, amounts | https://developer.paypal.com/api/transaction-search/v1/search-get | 2026-11-15 |
| P-9 | **Disputes read**: `GET /v1/customer/disputes` ("view all the disputes associated with an account", filterable by `disputed_transaction_id` etc.) and `GET /v1/customer/disputes/{id}`; response `items[].dispute_id`; dispute ids are `PP-D-…` / `PP-R-…` shaped; statuses include OPEN, WAITING_FOR_BUYER_RESPONSE, WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW (sample set observed in guide; full enum is in the reference definitions) | https://developer.paypal.com/api/disputes (guide) + /api/customer-disputes/v1/disputes-get | 2026-11-15 |
| P-10 | **Identity read**: `GET /v1/identity/openidconnect/userinfo` ("Shows OpenID Connect user profile information for standard claims. The attributes that are returned depend on the scopes associated with the client ID."); sample fields `user_id`, `sub`, `name`, `email`, `email_verified`, … — note this is the **current path** (the older `/v1/identity/oauth2/userinfo` spelling is not what the current reference publishes) | https://developer.paypal.com/api/identity/v1/userinfo-get | 2026-11-15 |
| P-11 | **Payouts dedupe (write-side facts, recorded for the executor design)**: `sender_batch_header.sender_batch_id` "to prevent duplicate requests"; item-level `sender_item_id`; retry semantics: "To retry after a server error (such as HTTP 5xx), send the request again with the same sender_batch_id **within 30 days**"; `PayPal-Request-Id` header parameter for idempotency; `POST /v1/payments/payouts` answers 201 | https://developer.paypal.com/api/payouts ("Last updated: September 10, 2026") | 2026-11-15 |
| P-12 | **Payout item status enum** (`transaction_status`): SUCCESS / FAILED / PENDING / UNCLAIMED / RETURNED / ONHOLD / BLOCKED / REFUNDED / REVERSED ("specific to payouts created through web uploads"); batch status enum: SUCCESS / PENDING / PROCESSING / DENIED / CANCELED | https://developer.paypal.com/payouts/use-payouts/track-payout-item-status (Last updated: September 10, 2026) | 2026-11-15 |
| P-13 | **UNCLAIMED → RETURNED window**: "If not, these payouts expire in **30 days**, and PayPal automatically returns the money to your PayPal account." | https://developer.paypal.com/payouts/use-payouts/handle-unclaimed-payouts | 2026-11-15 |
| P-14 | **Webhook verification**: self cryptographic verification is preferred ("self cryptographic verification is the preferred method as it will be faster and avoid extra API dependency and latency"): signed message `transmissionId | timeStamp | webhookId | crc32` (crc32 of the **raw** body, decimal form), public key from the `paypal-cert-url` header, signature in `paypal-transmission-sig`, `SHA256withRSA`; alternative postback `POST /v1/notifications/verify-webhook-signature` with `transmission_id`/`transmission_time`/`cert_url`/`auth_algo`/`transmission_sig`/`webhook_id`/`webhook_event` — "the webhook_event data [must] be posted back exactly as it was received"; mock events cannot use postback | https://developer.paypal.com/api/rest/webhooks (Last updated: June 18, 2026) | 2026-11-15 |
| P-15 | **Webhook delivery semantics**: listener on HTTPS port 443; "PayPal will retry each delivery up to **25 times over 3 days**" (at-least-once, unordered — dedupe by event id remains the consumer's job) | same page | 2026-11-15 |
| P-16 | **Rate limiting**: "PayPal doesn't publish exact rate limits" (they vary); 429 status on exceed; Payouts API specifically: "we allow **400 POST requests per minute**"; mitigation guidance: use webhooks instead of polling, cache OAuth tokens | https://developer.paypal.com/api/rate-limiting + /api/payouts | 2026-11-15 |
| P-17 | Client credentials model: client ID is public ("Safe to use in client-side code"), client secret is private ("Must be kept secure and used only server-side"); new accounts get a "Default Application" with ready-to-use credentials; apps are created per environment in the developer dashboard | https://developer.paypal.com/apps-scopes-and-credentials | 2026-11-15 |
| P-18 | **Token response sample documents the full field set** ("Last updated: June 30, 2026"): `scope` (space-separated URIs) / `access_token` / `token_type: "Bearer"` / **`app_id`** (sample `APP-80W284485P519543T` — non-secret app identifier) / `expires_in` (seconds) / `nonce`. Consequence: the read-back's account evidence is `app_id` (same position as Stripe's `acct_*`) — no identity-read dependency for verification | https://developer.paypal.com/api/rest/authentication/ (Sample response) | 2026-11-15 (third pass) |
| P-19 | **Official machine-readable OpenAPI specs are published** at `developer.paypal.com/api/transaction-search/v1/schema.json` and `developer.paypal.com/api/customer-disputes/v1/schema.json` (both OpenAPI 3.2.0); disputes pages split as `disputes-list` (GET /v1/customer/disputes) vs `disputes-get` (GET /v1/customer/disputes/{id}) | schema.json endpoints + /api/customer-disputes/v1 index | 2026-11-15 (third pass) |
| P-20 | **Money schema** (official): `value` is a string — "An integer for currencies like `JPY` that are not typically fractional. A decimal fraction for currencies like `TND` that are subdivided into thousandths."; `currency_code` is the three-character ISO-4217 code. Consequence: amounts are provider-native **major-unit** strings (integer-or-decimal) — not minor-unit integers | transaction-search + customer-disputes schema.json `money` | 2026-11-15 (third pass) |
| P-21 | **Balances response** (`balances_response`): `{balances: [{currency, primary, total_balance, available_balance, withheld_balance}], account_id, as_of_time, last_refresh_time}` — each `*_balance` is money{currency_code, value} | transaction-search schema.json | 2026-11-15 (third pass) |
| P-22 | **Transactions response** (`search_response`): `{transaction_details: [{transaction_info, …}], account_number, start_date, end_date, last_refreshed_datetime, page, total_items, total_pages}`; `transaction_info` carries `paypal_account_id`, `transaction_id` (`^[a-zA-Z0-9_]*$`, 1–24), `transaction_initiation_date` / `transaction_updated_date` (date_time), `transaction_amount` / `fee_amount` (money), `transaction_status` (single-letter codes: D/P/V…), `transaction_subject`, `transaction_note`, … | transaction-search schema.json | 2026-11-15 (third pass) |
| P-23 | **Disputes list response** (`dispute_search`): `{items: dispute_info[1..100] ("Sorted in latest to earliest creation time order"), links}`; `dispute_info` carries `dispute_id` (`^[A-Za-z0-9-]+$`), `create_time` / `update_time` (date_time), `reason` (10-value enum: MERCHANDISE_OR_SERVICE_NOT_RECEIVED / …_AS_DESCRIBED / UNAUTHORISED / CREDIT_NOT_PROCESSED / DUPLICATE_TRANSACTION / INCORRECT_AMOUNT / PAYMENT_BY_OTHER_MEANS / CANCELED_RECURRING_BILLING / PROBLEM_WITH_REMITTANCE / OTHER), `status` (**OPEN / WAITING_FOR_BUYER_RESPONSE / WAITING_FOR_SELLER_RESPONSE / UNDER_REVIEW / RESOLVED / OTHER**), `dispute_state`, `dispute_amount` (money) | customer-disputes schema.json | 2026-11-15 (third pass) |
| P-24 | **date_time format** (official): "The date and time, in Internet date and time format (RFC3339 §5.6). Seconds are required while fractional seconds are optional" — minLength 20, maxLength 64 | transaction-search schema.json `date_time` | 2026-11-15 (third pass) |

## Remains ⚠ RE-VERIFY (doc 04 §3/§5 — narrowed; the sandbox conformance run answers item 2)

1. **Documented default token lifetime**: the docs publish the `expires_in`
   field and a sample value (31668 s ≈ 8.8 h) plus reuse-until-expiry
   guidance, but no authoritative default-lifetime figure. The adapter must
   read `expires_in` per token response and refresh on 401 rather than encode
   any fixed lifetime.
2. **Own-account grantability of the read scopes (P-5)**: the scope URIs are
   verified from the reference pages, but whether a given own-account sandbox
   app is actually granted `reporting/search/read`, `reporting/balances/read`
   and `disputes/read-buyer` (vs needing partner onboarding) is a **live
   sandbox question**, not a docs fact — it must be answered by the P3
   sandbox conformance run with a real sandbox app, not by encoding an
   assumption.
3. **Recipient-verification surfaces**: payouts docs mention "Integrate
   Assisted Account Creation to collect recipient payer IDs and email
   addresses" — the API detail surface behind that copy is not yet verified
   from a reference page. The verified-recipient hard rule (doc 04 §3.3)
   keeps its ⚠ until that surface is pinned.

## Consequence in source (updated 2026-11-15 third pass — the P3 conformance slice landed)

The P3 conformance slice is merged behind this sheet: the authSpec
vocabulary now carries the **client-credentials** shape (client-id +
client-secret, environment-declared mode, per-mode base URLs P-3, token
path P-1 — `PAYSWAP_PAYPAL_AUTH_SPEC`, `packages/shared/src/payswap/
account-connection.ts`); the account service connects PayPal with **two
secrets at rest** (`payswap:psp:paypal:<id>:client-id` / `:client-secret`,
multi-secret read path with fail-closed refusal on any missing key); the
read-back adapter is the **token mint** (P-1/P-3/P-4; `app_id` = account
evidence per P-18, `scope` list = capability evidence per P-2/P-6, neutral
requirements projection); the data-read adapter covers the four closed
categories from the verified read data plane (P-7/P-8/P-9; customers →
typed `unsupported_operation` — no customer-list surface exists in the
verified plane) with `amountFormat: "major-unit"` projection (P-20) and
RFC3339→epoch conversion (P-24). No formatCheck is invented for PayPal
secrets (no verified shape) — the mint is the authority. **No provider
writes**; the no-write closed-category surface is unchanged.

The **sandbox conformance run** (⚠ item 2) remains the open step: it needs a
real sandbox app's client credentials (operator-supplied), runs
`scripts/p3/paypal-sandbox-conformance.ts`, and records the dated evidence
(mint + four-category live outcomes, observed value shapes, scope grants).
Paystack stays unregistered (`unsupported_provider`) pending its docs site.
