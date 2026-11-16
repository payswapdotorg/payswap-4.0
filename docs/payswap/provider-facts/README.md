# PaySwap provider facts — dated-evidence register

> **What this is**: the `docs/payswap/provider-facts/` fact sheets required by
> deliverable 04 §5 (re-verification checklist, gate before any adapter code)
> and deliverable 06 §2.13 (provider-research-tooling domain). Every fact here
> carries **source URL + retrieval date**; facts that could not be re-verified
> carry an explicit ⚠ **RE-VERIFY** marker and stay un-encoded in source.
>
> **Discipline** (doc 04 §5, verbatim intent): every item is re-checked against
> live official developer documentation, with retrieval date recorded. Adapter
> code that encodes a provider/protocol fact is merged only behind a fact sheet
> whose relevant items are verified — the typed refusal appears instead until
> then (`unsupported_provider` for providers, `protocol_*` codes for protocols).
>
> **Machine half**: protocol pins live in code as the single source
> (`packages/shared/src/payswap/protocols/protocol-facts.ts`,
> `PAYSWAP_PROTOCOL_PIN_REGISTRY`); these sheets are the human-readable
> retrieval log and the provider-side research record.

## Sheets

| Sheet | Subject | Status (2026-11-15, third pass) |
|---|---|---|
| `stripe-readonly-endpoints.md` | Stripe read-only data-plane endpoint facts (P2/ADR-P2-1; baseline 2026-11-13) | **re-verified 2026-11-15** — S-RO-1..6 closed with one recorded drift (dispute id prefix `dp_*` → `du_*`); RAK permission model, webhook tolerance (5 min) and idempotency retention (24 h) verified; Connect OAuth posture deferred |
| `paystack.md` | Paystack auth/transfer facts | **advanced 2026-11-15 (second pass)** — docs site still Cloudflare-blocked (even headless-browser JS + Turnstile); live API probes verify base URL, six read routes, both 401 envelopes; official SDK v1.2.2 (auto-generated from Paystack's OpenAPI spec, 2026-10-21) verifies the endpoint surface; official WooCommerce plugin corroborates HMAC-SHA512 webhook scheme; key-shape/permissions/transfer-enum/magic-number items stay ⚠ and keep `unsupported_provider` fail-closed |
| `paypal.md` | PayPal REST/OAuth/payouts facts | **conformance slice landed 2026-11-15 (third pass)** — official OpenAPI specs (schema.json, OpenAPI 3.2.0) pin the wire shapes: token response field set incl. `app_id` (P-18 — the read-back account evidence), money = provider-native major-unit strings (P-20), balances/transactions/disputes containers (P-21..P-23), date_time = RFC3339 seconds-required (P-24); authSpec client-credentials shape + multi-secret connect/read path + mint read-back + four-category data-read adapters encoded behind the sheet (amountFormat `major-unit` projection; customers = typed `unsupported_operation`); remaining ⚠: documented default token lifetime (sample only — adapter reads `expires_in` per response), own-account scope grantability (**the sandbox conformance run answers it** — needs a real sandbox app), recipient-verification surface |
| `protocols-ap2-x402-mpp.md` | AP2 / x402 / MPP protocol facts | **all three pinned 2026-11-15 (second pass)** — x402 **v2** (canonical spec in x402-foundation/x402 `specs/`; coinbase/x402 is a fork); MPP **draft-httpauth-payment-01** (tempoxyz/mpp-specs + paymentauth.org + mpp.dev; Tempo Labs + Stripe authors); AP2 v0.2 with two recorded corrections (five roles; two in-scope modes — A2A delegation explicitly out of scope) and the published mandate `vct` versioning + SD-JWT securing; adapter message-face lists narrowed, not closed |

## Retrieval environment honesty

- **2026-11-15 first pass**: plain HTTPS fetches (no JS rendering) from the TL
  ops environment. Paystack docs HTTP 403; PayPal payouts page empty without
  JS — recorded per sheet.
- **2026-11-15 second pass**: headless-browser JS rendering (developer.paypal.com
  fully readable — the payouts blocker was a page move, not a block), live
  unauthenticated/fake-credential API probes (zero real secrets, zero writes),
  official first-party code artifacts (npm registry tarballs, GitHub repos) and
  `raw.githubusercontent.com` spec sources. `paystack.com` remains Cloudflare-
  blocked including the interactive challenge; `archive.org` answered 429 for
  the whole pass; `api.github.com` REST was rate-limited (github.com HTML and
  raw endpoints worked); IETF datatracker answered 403 behind a Cloudflare
  challenge. Where a source was unreachable it is recorded as unreachable —
  preferred over citing stale or second-hand facts.
- **2026-11-15 third pass (late UTC)**: targeted PayPal wire-shape pinning —
  headless-browser JS rendering of developer.paypal.com reference pages plus
  the **official machine-readable OpenAPI specs** the site publishes
  (`/api/transaction-search/v1/schema.json`, `/api/customer-disputes/v1/
  schema.json` — OpenAPI 3.2.0; zero real secrets, zero writes). These are
  first-party spec artifacts, cited as sources in their own right.
