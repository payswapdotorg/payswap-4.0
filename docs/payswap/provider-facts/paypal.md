# PayPal fact sheet (P3 — read-only provider conformance)

> Retrieval batch: 2026-11-15, from the TL ops environment (plain HTTPS, no JS
> rendering). Upstream baseline: `docs/payswap/p0/04-provider-auth-comparison.md`
> §3 (as of 2026-11, ⚠ RE-VERIFY flags preserved there).

## Verified this pass (2026-11-15)

| Fact | Source | Retrieval |
|---|---|---|
| PayPal REST APIs use OAuth 2.0 access tokens; the access token authorizes REST API use and is sent as `Authorization: Bearer <token>` | `https://developer.paypal.com/api/rest/authentication/` (page states "Last updated: June 30, 2026") | 2026-11-15 |
| Token acquisition is the client-credentials grant: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` with `-u "CLIENT_ID:CLIENT_SECRET"` (HTTP Basic, client id:secret base64) and `-d grant_type=client_credentials` | same page (cURL sample) | 2026-11-15 |
| On expiry, call `/v1/oauth2/token` again for a new access token (no refresh flow required for this grant) | same page | 2026-11-15 |
| Sandbox and live base URLs are distinct apps/environments: `api-m.sandbox.paypal.com` vs `api-m.paypal.com` | same page + `https://developer.paypal.com/api/rest/` | 2026-11-15 |
| App credentials model: "PayPal integrations use a client ID and client secret to authenticate API calls"; a client ID identifies an app; going live / testing outside the US requires a PayPal Business account | `https://developer.paypal.com/api/rest/` | 2026-11-15 |
| Scope vocabulary exists of the shape `https://uri.paypal.com/services/...` (e.g. `.../services/payments/refund`, `.../payments/payouts`, `.../services/disputes/read-seller`) plus URL-pattern scopes | same page (sample token response scope list) | 2026-11-15 |

## Could not be re-verified this pass (JS-rendered page — recorded honestly)

- `https://developer.paypal.com/api/payments/payouts/` renders empty without
  JavaScript in this environment → **payouts dedupe semantics**
  (`sender_batch_id` / `sender_item_id`), the unclaimed/return window and the
  payouts grant mechanics remain ⚠ RE-VERIFY (doc 04 §3 ⚠ items).

## Remains ⚠ RE-VERIFY before any PayPal adapter code (doc 04 §3/§5)

1. Token lifetimes (observed sample shows an expiry-in-seconds field; the
   actual default lifetime value needs a verified figure).
2. Payouts dedupe semantics and window; per-leg idempotency mapping onto
   `sender_batch_id`/`sender_item_id` (blocked on the JS-rendered page or an
   alternative official source).
3. Webhook verification recommendation and the verify-API surface
   (transmission headers + webhook id per doc 04 §3 — re-verify current
   guidance).
4. Recipient-verification surfaces; UNCLAIMED → RETURNED window.
5. Client-credential **scope sets actually grantable to an own-account app**
   for a read-only posture — the P2-equivalent minimal-permission question for
   PayPal (doc 04 §3.5 "verified recipient" concern rides on this).

## Consequence in source (fail-closed, by design)

PayPal is **not** registered in the account-service authSpec set (its P3 auth
shape is client-credentials, not operator-supplied-secret — the authSpec
vocabulary extension itself lands only with the verified facts above). `connect`
for `providerId: "paypal"` produces the typed refusal `unsupported_provider`
(zero at-rest writes) until then. No PayPal read adapter exists; nothing is
invented.
