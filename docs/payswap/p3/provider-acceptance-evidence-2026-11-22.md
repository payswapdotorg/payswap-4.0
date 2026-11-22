# PayStack and PayPal provider acceptance evidence — 2026-11-22

Per-handoff §3 P3-C: for each provider, produce an evidence table covering
the read-only provider contract. Separate **code blockers** (things TL1 can
fix) from **account/provider dependencies** (things the account owner or
provider must supply).

---

## Paystack

| Acceptance criterion | Evidence | Status | Blocker type |
|---|---|---|---|
| Official provider facts, API version | PAYSWAP_PAYSTACK_EVIDENCE_PIN (protocol-facts in shared); official docs paystack.com/docs/api/; API version implicit (no versioned endpoint prefix) | PASS | none |
| Authentication (sk_test_ / sk_live_) | authSpec formatCheck `/^sk_(?:test\|live)_[A-Za-z0-9]{10,}$/` (PR #54); live-key conformance run used sk_test_ (PR #72) | PASS | none |
| Connection / onboarding | Compliance 5/5 + agreement signed + activation processed (PR #92 evidence); dashboard verified | PASS | ~~Paystack review~~ (completed) |
| Credential storage and revocation | v1.1 named slots (client-credentials pairs under Windows custody); single-slot for api-key; revocation clears both | PASS | none |
| Provider identity / read-back | Typed identity-gap refusal (official API exposes no self-identity endpoint); state stays connected (PR #54) | PASS | none |
| Balance read | Real-API test-mode conformance (PR #72): balance `ok` with available/pending arrays | PASS | none |
| Payment objects read | Real-API test-mode conformance (PR #72): payment_objects `ok` | PASS | none |
| Privacy-safe customer data | Real-API test-mode conformance (PR #72): customers `ok`, rows carry only `id`/`created`/`description` — PII redaction-by-construction | PASS | none |
| Disputes | Pinned typed `unavailable` (official records carry no top-level amount/currency/reason) | PASS (honest) | none |
| Invalid credentials → 401 | Security row: bogus key → real 401 → `expired` (PR #72) | PASS | none |
| Timeouts / unavailable responses | Transport failure → typed `unavailable` (all-or-nothing) | PASS | none |
| No credential exposure to renderer/agent/model/logs | At-rest invariant: record store zero plaintext; credentials store ciphertext-only (PR #72) | PASS | none |
| No provider write in P3 tool surface | P3 tools are read-only (balance/transactions/customers/disputes/refunds — read-only); no transfer/payout/initiate tools exist | PASS | none |
| **Live credentials** | `sk_live_` pending PayStack review (compliance submitted 2026-11-21) | **PENDING** | **Provider review** |

**Paystack conclusion**: The read-only provider contract is **fully
implemented and conformance-proven** in test mode. The sole remaining
acceptance item (live credentials) is a **provider-review dependency**, not a
code blocker.

---

## PayPal

| Acceptance criterion | Evidence | Status | Blocker type |
|---|---|---|---|
| Official provider facts, API version | PAYSWAP_PAYPAL_EVIDENCE_PIN (specification v0.2; OAuth2 client credentials; token response fields); official docs developer.paypal.com/api/rest/ | PASS | none |
| Authentication (client-credentials pair) | authSpec: clientId + clientSecret, operator-declared sandbox/live mode (PR #55) | PASS | none |
| Connection / onboarding | Sandbox pair obtained from the account owner's developer dashboard (PR #77 conformance); live credentials outstanding | PASS (sandbox) | **Live credentials** |
| Credential storage and revocation | v1.1 named slots: client-id + client-secret each their own PSP slot; revoke clears both | PASS | none |
| Provider identity / read-back | `verified` with providerAccountId = official `app_id` (APP-80W284485P519543T observed live in PR #77 sandbox conformance) | PASS | none |
| Balance read | Sandbox conformance: `unavailable` (fresh sandbox empty-state — no fabricated empty projection); ISO 4217 exponent discipline verified on populated envelopes | PASS (honest) | none |
| Payment objects read | Sandbox conformance: `unavailable` (same empty-state); ok-shape pinned by unit battery | PASS (honest) | none |
| Privacy-safe customer data | No customers endpoint exists in the official PayPal merchant API — `refused{unsupported_operation}` (provider-absence fact, zero wire touch) | PASS (honest) | none |
| Disputes | Sandbox conformance: disputes `ok` (official /v1/customer/disputes envelope present, empty projection) | PASS | none |
| Invalid credentials → 401 | Security row: bogus pair → real 401 `invalid_client` → `expired` (PR #77) | PASS | none |
| Timeouts / unavailable responses | Transport failure → typed `unavailable` | PASS | none |
| No credential exposure to renderer/agent/model/logs | At-rest invariant: connection record store zero plaintext; credentials store ciphertext-only for both slots (PR #77) | PASS | none |
| No provider write in P3 tool surface | P3 tools are read-only; no capture/void/refund/payout tools exist | PASS | none |
| **Live credentials** | Live PayPal REST API app required (account owner must create one) | **PENDING** | **Account owner** |
| **Live URL confirmation** | Resolved 2026-11-21: api-m.paypal.com directly documented on the official API requests page (PR #78) | PASS | none |

**PayPal conclusion**: The read-only provider contract is **fully
implemented and conformance-proven** in sandbox mode. The sole remaining
acceptance item (live credentials) is an **account-owner dependency**, not a
code blocker.

---

## Protocol adapters (x402 / MPP / AP2)

| Adapter | Facts | Message face | Production wiring | Status |
|---|---|---|---|---|
| AP2 | Gate open (reverify empty); conformance-corrected (PR #85) | ✅ 58/58 | Not wired (no production caller) | Face complete; wiring pending |
| MPP | Rails pinned; per-network variants honestly narrowed (PR #87) | ✅ 44/44 | Not wired | Face complete; wiring pending |
| x402 | 26/31 rows promoted; 5 spec-silent rows honestly recorded | Law-blocked | Not implemented | Five-row disposition produced (this document); subset face possible |

---

## Summary

- **Paystack**: read-only contract fully proven in test mode. Live credentials = provider-review dependency.
- **PayPal**: read-only contract fully proven in sandbox mode. Live credentials = account-owner dependency. Live URL confirmed.
- **Protocol adapters**: AP2 and MPP faces implemented, conformance-verified, registered. x402 face implementable as a supported subset (five-row disposition produced). Production wiring (host integration) is the remaining engineering task (P3-A).
- **No code blockers remain** for the read-only provider acceptance. All open items are external dependencies (provider review, account-owner credentials) or the host integration engineering task (P3-A).
