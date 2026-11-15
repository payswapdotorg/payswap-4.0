# PayPal fact sheet (P3 — read-only provider conformance)

> Retrieval batches: **2026-11-15 first pass** (TL ops environment, plain
> HTTPS, no JS rendering) and **2026-11-15 second pass** (headless-browser JS
> rendering of developer.paypal.com + live sandbox API probes with fake
> credentials only — zero real secrets, zero writes). Upstream baseline:
> `docs/payswap/p0/04-provider-auth-comparison.md` §3 (as of 2026-11, ⚠
> RE-VERIFY flags preserved there; this sheet is the re-verification record).
>
> Docs-reorganization fact (recorded 2026-11-15, second pass): the payouts
> reference moved — `developer.paypal.com/api/payments/payouts/` now answers
> "Page not found"; the live pages are `developer.paypal.com/api/payouts`
> (guide, "Last updated: September 10, 2026") and the OpenAPI reference pages
> under `developer.paypal.com/api/payments.payouts-batch/v1/…`.

## Verified (2026-11-15 — first pass re-confirmed, second pass extended)

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

## Remains ⚠ RE-VERIFY before PayPal adapter code (doc 04 §3/§5 — narrowed, not empty)

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

## Consequence in source (fail-closed, by design — unchanged until the P3 conformance slice)

PayPal remains **not registered** in the account-service authSpec set this
pass: its acquisition shape is client-credentials (client-id + client-secret,
two secrets, environment-declared mode) — the authSpec vocabulary extension
(operator-supplied-secret is the only registered shape today) and the
account-service multi-secret connect/read path land **behind this sheet** as
the next P3 work package, together with the sandbox conformance run that
answers ⚠ item 2. `connect` for `providerId: "paypal"` keeps producing the
typed refusal `unsupported_provider` (zero at-rest writes) until that slice
merges. No PayPal read adapter exists yet; nothing is invented.
