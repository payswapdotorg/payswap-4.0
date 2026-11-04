# PaySwap P0 — Provider Authentication Comparison: Stripe, Paystack, PayPal

**Worker:** P0-W3 (audit/architecture) · **Recorded:** 2026-11 · **Status:** design input, not implementation permission

## Evidence standard for this document

- **Provider facts** below come from my knowledge of the three providers' public developer documentation, stamped **"as of 2026-11"**. Every such fact carries a **⚠ RE-VERIFY** flag where live-doc confirmation is mandatory before any of it is encoded into a PaySwap adapter. Provider APIs drift; this document is a planning map, not a source of truth.
- **Repo facts** cite exact paths/symbols read in this worktree at upstream baseline `a9fe401` (ZCode v3.17.2).
- No real credentials appear here. Key examples always use placeholder forms such as `sk_live_<placeholder>`, `rk_live_<placeholder>`, `whsec_<placeholder>`.

---

## 1. Stripe

### 1.1 What the credential IS (as of 2026-11 ⚠ RE-VERIFY)

| Credential | Shape | What it authenticates | Who holds it |
|---|---|---|---|
| Secret key | `sk_test_<placeholder>` / `sk_live_<placeholder>` | Full server-side API access to one Stripe account, one mode | The Stripe account (created in dashboard) |
| Restricted key | `rk_test_<placeholder>` / `rk_live_<placeholder>` | Server-side access scoped to named resources × read/write permissions | The Stripe account |
| Publishable key | `pk_test_<placeholder>` / `pk_live_<placeholder>` | Client-side tokenization only (Stripe.js/Elements); cannot move money alone | The Stripe account |
| Webhook signing secret | `whsec_<placeholder>` | Proof that a webhook event came from Stripe for one endpoint | Per webhook endpoint |

- Auth is HTTP **Bearer** with the secret/restricted key against `https://api.stripe.com`.
- **Test vs live are different key pairs** with different prefixes; an integration picks mode by which key it uses. There is no per-request mode switch. ⚠ RE-VERIFY that restricted keys remain test/live-prefixed and their permission granularity list.
- Who holds it: the merchant (standard account) or the platform (for Connect managed accounts). Stripe dashboard team members with roles manage keys; keys are account-scoped, not user-scoped. ⚠ RE-VERIFY current team-role matrix.

### 1.2 Account linking / onboarding (as of 2026-11 ⚠ RE-VERIFY)

Two distinct models that PaySwap must never conflate:

1. **Standard account + own API keys** — the merchant operating PaySwap pastes a key from *their own* dashboard. No linking flow exists or is needed; the credential *is* the link. This is the "merchant account linking" path.
2. **Connect (platform ↔ seller)** — a platform operates onboarding and payments for connected sellers:
   - **Account Links API** produces a hosted onboarding URL; Stripe hosts KYC collection; the Account object exposes `requirements` (`currently_due`, `past_due`, `disabled_reason`, `current_deadline`) and `capabilities` (`card_payments`, `transfers`, …) with per-capability status (`active` / `inactive` / `pending`).
   - **Connect OAuth** (authorize URL with platform `client_id`, `state`, `scope=read_only|read_write`) lets a seller grant the platform access to the *seller's own* Stripe account, yielding tokens incl. a refresh token. Stripe has for years steered platforms toward Account Links + platform-created connected accounts (with `Stripe-Account` header) instead of OAuth; **⚠ RE-VERIFY the current status and deprecation posture of Connect OAuth before designing any OAuth-based Stripe connection.**
   - Express/Custom connected accounts are accessed **with the platform's own keys** plus the `Stripe-Account` header; Standard connected accounts are accessed via the seller's OAuth token or the seller's own keys.

For PaySwap P0, **Stripe connection = standard account + operator-supplied key (restricted key preferred)**. Connect flows (acting on *other people's* Stripe accounts) are a later scope decision, not P0.

**Why this matters for the capability registry:** the Stripe Account `capabilities` + `requirements` read-back is *exactly* the evidence PaySwap's evidence-backed capability registry should consume — capabilities come from the account's actual state, never from hardcoded claims.

### 1.3 Read vs write scopes (as of 2026-11 ⚠ RE-VERIFY)

- Secret key: read+write everything (except some irrevocable actions gated in dashboard).
- Restricted keys: per-resource permissions, e.g. "Charges — write", "Transfers — read". Granularity list must be re-verified and encoded as evidence, not assumption.
- Connect OAuth scopes: coarse (`read_only` vs `read_write`). ⚠ RE-VERIFY.

### 1.4 Webhook verification (as of 2026-11 ⚠ RE-VERIFY)

- Header `Stripe-Signature: t=<unix>,v1=<hex>`.
- `v1 = HMAC-SHA256(signing_secret, "${t}.${rawBody}")`.
- Default tolerance window ≈ 5 minutes (replay protection); configurable but Stripe recommends keeping it.
- **Test and live events go to separate webhook endpoints with separate signing secrets** (configured in the dashboard per mode).
- Events are versioned: each endpoint pins an `api_version`; Stripe signs the body it sent, so **the raw body must be preserved before parsing** for verification to work.

### 1.5 Test environments & idempotency (as of 2026-11 ⚠ RE-VERIFY)

- Test mode: separate keys, test data (test cards, test banks), Test Clocks for time-dependent behavior; no real money.
- `Idempotency-Key` header accepted on POST requests; replays with the same key return the original result; keys expire after ~24h (⚠ RE-VERIFY exact retention).
- Dashboard has a test/live toggle for viewing each mode's objects.

### 1.6 The dashboard's role

Key creation/rotation (including restricted keys), team roles, audit log, webhook endpoint management, Connect onboarding progress, dispute handling. PaySwap should deep-link operators to the right dashboard pages (analogous to the existing `apiKeyManagementUrl` field on model providers — `packages/provider/src/config/provider-config.ts` `ApiKeyAccessConfig`).

### 1.7 Stripe gotchas for PaySwap

- **`succeeded` on a Charge/PaymentIntent ≠ money in the bank** — payout to the merchant's bank is a separate, scheduled event. Perfect instance of "API acceptance is not settlement."
- Transfers (Connect) require the right capability, currency balance, and geography; cross-border rules bite.
- A refund can fail *after* being created (asynchronous state).
- Connect OAuth posture drift — see 1.2.
- Live-key leakage anywhere (logs, chat, env dumps) = rotate immediately.

---

## 2. Paystack

### 2.1 What the credential IS (as of 2026-11 ⚠ RE-VERIFY)

| Credential | Shape | What it authenticates | Who holds it |
|---|---|---|---|
| Secret key | `sk_test_<placeholder>` / `sk_live_<placeholder>` | Full server-side API access to one Paystack account, one mode | The Paystack merchant |
| Public key | `pk_test_<placeholder>` / `pk_live_<placeholder>` | Client-side (Inline JS popup) | The Paystack merchant |

- Auth is `Authorization: Bearer <secret>` against `https://api.paystack.co`.
- **There is NO OAuth account-authorization flow.** The integrator is the merchant; the secret key *is* the account link. Anyone holding the live secret key can move money out of the account's Paystack balance (transfers) — treat it as a high-value signing key.
- Paystack has been adding **API key permissions** (scoped keys) in recent years — ⚠ RE-VERIFY availability, scope list, and whether live keys can be restricted to transfers-disabled/read-only for evidence collection.

### 2.2 Recipient → transfer → reference lifecycle (as of 2026-11 ⚠ RE-VERIFY)

This is the canonical Paystack money-out flow and the model PaySwap's leg/executor design must absorb:

1. **Create Recipient** (`POST /transferrecipient`): `type` (`nuban`, `ghipss`, `basa`, `mobile_money`, …), `account_number`, `bank_code`, `name`, `currency` → returns a stable `recipient_code` (`RCP_<placeholder>`). Some markets support account-number → name verification/lookup before creation (⚠ RE-VERIFY per-country endpoints).
2. **Initiate Transfer** (`POST /transfer`): `source: "balance"`, `amount` **in subunits** (kobo/pesewas/cents — integer), `recipient` (recipient_code), `reason`, and a **unique `reference` supplied by the caller**. The reference is the dedupe/idempotency anchor.
3. **Status lifecycle**: `pending` → `processing` → `success` | `failed` | `reversed`, plus `abandoned` and OTP-failure states (⚠ RE-VERIFY the exact current enum). Critically, **`success` can later become `reversed`** — a transfer that "succeeded" can be clawed back asynchronously. This is a hard, real instance of the invariant *API acceptance is not settlement*.
4. **Transfer controls** (live): OTP/dual-factor on transfers, disable-OTP request flow, per-transfer limits, balance checks (`GET /balance`), bulk recipients. Enabling live transfers requires explicit dashboard settings. ⚠ RE-VERIFY current control endpoints and default posture.

### 2.3 Webhook verification (as of 2026-11 ⚠ RE-VERIFY)

- Header `x-paystack-signature` = **HMAC-SHA512 of the RAW request body** using the account secret key (not a separate signing secret — ⚠ RE-VERIFY whether separate webhook secrets now exist).
- Verify with constant-time comparison; **the raw body must be captured before any JSON parse**.
- Paystack recommends IP allowlisting of their webhook source IPs (⚠ RE-VERIFY current published list).
- Relevant events: `transfer.success`, `transfer.failed`, `transfer.reversed`, `charge.success`, etc.

### 2.4 Test environment (as of 2026-11 ⚠ RE-VERIFY)

- Test keys; dedicated test bank codes (e.g., a "test bank" bank code with account numbers that force success/timeout/failure), magic amounts that simulate specific card outcomes. ⚠ RE-VERIFY the current magic numbers/banks before writing fixtures — these change.

### 2.5 Paystack gotchas for PaySwap

- **Subunits everywhere** — kobo/pesewas integers; a single decimal misinterpretation is a 100× money bug. Amounts must be carried as decimal strings in PaySwap contracts and converted only inside the adapter.
- **`success` → `reversed`** — settlement confirmation requires watching for reversal events for a provider-defined window (⚠ RE-VERIFY window), not just the first `success`.
- Transfer availability is country-scoped (NG, GH, ZA, KE, …) and currency-scoped; the capability registry must record the *account's actual* supported transfer countries/currencies as evidence, not Paystack's marketing matrix.
- Unique-reference collisions: PaySwap must allocate references deterministically (per-leg idempotency key derivation) so a crashed-then-retried leg reuses the same reference, and provider-side duplicate-reference rejections map to a typed `duplicate_reference` refusal.
- OTP/dual-auth interactions with automated execution: live transfers may require a human approval step *inside Paystack's flow* — the executor must surface this as an operator-actionable state, never attempt to bypass it.

---

## 3. PayPal

### 3.1 What the credential IS (as of 2026-11 ⚠ RE-VERIFY)

| Credential | Shape | What it authenticates | Who holds it |
|---|---|---|---|
| App client credentials | `client_id` + `client_secret` from the developer dashboard | OAuth2 client for one REST app, one environment | The app owner |
| Access token | OAuth2 bearer, from `client_credentials` or `refresh_token` grant | Time-boxed API access (own account or on-behalf-of merchant) | Derived; cache in host memory |
| Refresh token | From `authorization_code` grant | Long-lived merchant consent for third-party operation | The consenting merchant ↔ app |

- Token endpoint `POST /v1/oauth2/token`; access tokens are commonly valid for a small number of hours (docs have shown ~9h idle validity in places) — ⚠ RE-VERIFY current lifetimes and caching guidance; tokens must be cached host-side, never re-fetched per call.
- **Sandbox and live are different apps with different client credentials and different base URLs** (`api-m.sandbox.paypal.com` vs `api-m.paypal.com`).

### 3.2 Merchant onboarding / third-party consent (as of 2026-11 ⚠ RE-VERIFY)

- **Partner Referrals / Commerce Platform**: partner creates a referral → onboarding link → merchant completes PayPal onboarding and grants permissions → partner can operate on the merchant's behalf. ⚠ RE-VERIFY current API paths and consent scopes.
- **Third-party grants**: `authorization_code` OAuth flow yields a `refresh_token` bound to the merchant's consent; the partner then mints on-behalf-of access tokens. Scope strings are URI-shaped (e.g. payouts scopes) — ⚠ RE-VERIFY the current scope list before encoding.
- For PaySwap P0, **own-account client credentials** (operator's own PayPal business app) is the connection model; Partner-Referrals-style *other-merchant* onboarding is a later scope.

### 3.3 Verified recipients — the hard rule (as of 2026-11 ⚠ RE-VERIFY)

- Payouts (`POST /v1/payments/payouts`) send to a `receiver` identified by `recipient_type` = `EMAIL` | `PAYPAL_ID` | `PHONE`.
- **The recipient email must be a confirmed PayPal account recipient.** Paying an unregistered/unconfirmed address produces an `UNCLAIMED` item that is eventually `RETURNED` (historically after ~30 days — ⚠ RE-VERIFY). **PaySwap must never manufacture or guess recipient addresses**; recipients enter the system only as provider-verified references (PaySwap-confirmed input matched against provider-side verification where available).
- Item status lifecycle: `PENDING` → `UNCLAIMED` / `ONHOLD` / `SUCCESS` / `FAILED` / `RETURNED` / `BLOCKED` / `REFUNDED` (⚠ RE-VERIFY enum). Again: `SUCCESS` after submission is provisional until reconciliation.
- Batch-level `sender_batch_id` and item-level `sender_item_id` provide **duplicate-submission protection** (PayPal detects identical retries) — ⚠ RE-VERIFY exact dedupe semantics and window; PaySwap's per-leg idempotency keys must map onto these.
- Payouts permission is **not default**: apps/accounts without the payouts grant get `NO_PERMISSION` — this must be surfaced as a typed `insufficient_permission` refusal with evidence, not retried.

### 3.4 Webhook verification (as of 2026-11 ⚠ RE-VERIFY)

- Events carry headers `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-TIME`, `PAYPAL-CERTIFICATE-ID`, `PAYPAL-AUTH-ALGO`.
- Canonical verification is **a server-side call**: `POST /v1/notifications/verify-webhook-signature` with the webhook id + headers + body → `VERIFICATION_STATUS: SUCCESS|FAILURE`. (Local certificate-chain verification is possible but subtle — ⚠ RE-VERIFY current recommendation.)
- Webhook events are **at-least-once and unordered** — consumers must dedupe by event id and tolerate late events. This constrains PaySwap's event-processing design (dedupe + ledger append-only, no in-place mutation).

### 3.5 PayPal gotchas for PaySwap

- Access-token lifecycle: refreshing on a schedule, not per call; sandbox/live split apps.
- Currency support varies by receiving account/country; `SUCCESS` of an item doesn't mean the recipient withdrew funds.
- The payouts grant, verified-recipient rule, and unclaimed-return cycle make PayPal the provider where "verified recipient" enforcement matters most.
- Fees on payouts batches; FX spread when sender currency ≠ recipient's holding currency (⚠ RE-VERIFY current fee/FX disclosure surfaces usable as evidence).

---

## 4. Comparison table (as of 2026-11 — every cell ⚠ RE-VERIFY before encoding)

| Dimension | Stripe | Paystack | PayPal |
|---|---|---|---|
| Auth model | Bearer secret/restricted key | Bearer secret key | OAuth2 client credentials → bearer access token (+ refresh tokens for third-party) |
| Account linking | Own key (standard) OR Connect (Account Links / OAuth) | Secret key *is* the link; no OAuth | Own app credentials; merchant consent via Partner Referrals/refresh tokens |
| Scopes | Restricted keys: per-resource read/write; Connect OAuth: read_only/read_write | Historically all-or-nothing; newer key permissions (re-verify) | OAuth scopes incl. payouts; app grants |
| Webhook verification | HMAC-SHA256 `Stripe-Signature` (t+payload, whsec secret, ~5 min tolerance) | HMAC-SHA512 of raw body with secret key (`x-paystack-signature`) | Server-side verify API call with transmission headers (+ webhook id) |
| Test environments | Test keys/test clocks, separate webhook endpoints | Test keys, test banks + magic amounts | Sandbox apps/accounts, separate base URLs |
| Write-idempotency anchors | `Idempotency-Key` header (POST) | Unique `reference` per transfer | `sender_batch_id` + `sender_item_id` (payouts) |
| Settlement honesty | Charge succeeded ≠ paid out | transfer `success` can become `reversed` | Item `SUCCESS` ≠ withdrawn; UNCLAIMED→RETURNED |
| Recipient model | Bank/account objects; Connect accounts | `recipient_code` from verified bank details | Confirmed PayPal account recipient (email/PAYER_ID) |
| Key-rotation UX | Dashboard rotate, restricted keys, roles | Dashboard regenerate | New app credentials / revoke grants |
| Biggest gotcha | Connect OAuth drift; capability gating | Subunit amounts; success→reversed | NO_PERMISSION on payouts; unclaimed cycle |

---

## 5. Re-verification checklist (gate before any adapter code)

Every item below must be re-checked against live developer documentation, with retrieval date recorded into `docs/payswap/provider-facts/` fact sheets (the provider-research-tooling domain, doc 06 §2.13):

1. Stripe: restricted-key permission list; Connect OAuth status; Account `capabilities`/`requirements` schema; webhook tolerance default; idempotency-key retention.
2. Paystack: transfer status enum (incl. reversal window); webhook signature scheme + IP list; key-permissions feature; test magic numbers; transfer-control endpoints and defaults per market.
3. PayPal: token lifetimes; payouts dedupe semantics; webhook verification recommendation; recipient-verification surfaces; unclaimed-return window; payouts grant mechanics.
4. All: current API base URLs, TLS requirements, rate-limit headers, error-code catalogs — needed for the typed-refusal mapping tables in doc 05.

---

## 6. Security notes for the desktop-agent context (applies to all three)

The consuming application is an **Electron desktop agent + web + CLI monorepo where a conversational model orchestrates but must never be the financial authority.** Repo-verified constraints:

1. **Secrets live in exactly one place: the existing host credential store.** `packages/services/src/credential/credentialService.ts` persists AES-256-GCM-encrypted values (`enc:v1:` prefix, `packages/services/src/credential/providers/credentialCipherProvider.ts`) into `credentials.json` under the app config dir, with file locking, atomic writes, and corrupt-refuse-overwrite semantics. The `ICredentialService` contract (`packages/services/src/credential/credential.ts`) is host-side only — the renderer gets opaque status, never values. **PaySwap must not create a second secret store.**
2. **Never in chat, logs, or model context.** AGENTS.md log rules already forbid credentials in logs ("不在日志、示例或提交中写入凭据"). Extend the rule to: PSP credentials never appear in tool inputs/outputs, conversation transcripts, telemetry, or error messages. Redaction happens at the adapter boundary before any string leaves the host service.
3. **The agent process never holds PSP credentials.** Provider API calls are made by the host-side PaySwap execution authority (doc 06 §2.8), not by model-executed bash/curl/fetch. Financial provider domains should sit on the agent's network-tool deny side — precedent: WebSearch is only exposed under a confirmed provider-domain allowlist (`docs/websearch-provider-domain-allowlist.md`); PaySwap needs the inverse (denylist) for `api.stripe.com`, `api.paystack.co`, `api-m.paypal.com` in agent-driven fetch tools. Design flag for the TL: this denylist is a P1 hardening item, P0 relies on the permission surfaces.
4. **Least privilege by default.** Prefer Stripe restricted keys scoped to the operations the operator actually enables; use read-only credentials for evidence collection where the provider supports them; keep write-scoped keys only for connections with execution enabled.
5. **Mode is part of connection identity.** Test vs live is a first-class field on the PaySwap connection record (derived from key prefix / environment where the provider makes it distinguishable — Stripe & Paystack prefixes, PayPal sandbox-vs-live app). Live mode is additionally gated behind the PaySwap live gate (doc 06 §8, invariant 4), not merely by which key was pasted.
6. **Rotation and revocation are first-class flows.** Each auth spec carries a dashboard deep-link (`apiKeyManagementUrl` precedent in `packages/provider/src/config/provider-config.ts`); revocation deletes from the credential store and then *verifies* loss of access by evidence refresh, so a stale "connected" badge can never survive a real revocation.
7. **OAuth (where it exists) runs host-side with `state` validation and deep-link callbacks** — the existing `IOAuthService` (`packages/services/src/oauth/oauth.ts`, runs in the host process: provider management, state lifecycle, token exchange, credential storage) is the pattern to extend additively for PSP OAuth; never a renderer-side token exchange.

---

## 7. What this comparison decides for PaySwap P0

- **Three different auth models, one contract.** Secret-key (Stripe/Paystack), OAuth-client-credentials (PayPal own-account), and OAuth-authorization-code (PayPal third-party, later) must all fit the single provider plugin contract in doc 05 — the contract abstracts *acquisition method*, *storage key layout*, and *session/refresh semantics* per provider.
- **The "account link" differs fundamentally**: Stripe standard = pasted key; Paystack = the key is the account; PayPal = app credentials + (optionally) merchant consent. The connection UX and the capability-evidence flows must treat these as distinct acquisition paths over one storage model.
- **Every provider has a settlement-honesty gap** (Stripe payout schedule; Paystack success→reversed; PayPal unclaimed→returned). This is the empirical basis for the invariant *API acceptance is not settlement* and for reconciliation being a core domain rather than an afterthought (doc 06 §2.11).
- **Idempotency anchors differ per provider** (header vs reference vs batch/item ids) — per-leg idempotency keys are allocated by PaySwap's executor and mapped by each adapter onto the provider's native mechanism (doc 05 §6).
