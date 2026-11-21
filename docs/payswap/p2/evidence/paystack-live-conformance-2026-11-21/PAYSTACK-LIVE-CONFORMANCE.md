# PayStack test-mode LIVE conformance — 2026-11-21

## What this proves

The P3 PayStack provider half's readonly contract, exercised against the **real
`https://api.paystack.co`** (no mock transport) with the account owner's own
**test-mode secret key** (`sk_test_…`), via
`packages/services/test/payswap-paystack-live-conformance.test.ts`.

Suite: **1 passed** (2408 ms, real network). Without the env key the suite
**skips** (CI/batteries stay network-free).

## The acceptance rows (all green, real API)

| Row | Behavior proven | Real-API result |
|---|---|---|
| 1. Connect | `connect { providerId: "paystack", operatorSecret: <real sk_test> }` → `connected`, mode `test`; zero network at connect | ✅ |
| 2. Identity gap | real `200 + {status:true}` envelope on `GET /balance` → typed `refused` (`read_back_unavailable`); connection state **stays connected** — no identity fabricated even with valid credentials | ✅ |
| 3. Overview gate | `getOverviewData` verification read hits the same identity gap → `refused`; the four-category detail is never answered on an identity-gap provider | ✅ |
| 4. Data reads (real) | direct data port with the real secret: `balance` → `ok` (available/pending arrays); `payment_objects` (`GET /transaction`) → `ok`; `customers` (`GET /customer`) → `ok` with **PII redaction-by-construction** (rows carry only `id`/`created`/`description` keys); `disputes` → pinned typed `unavailable` (official records carry no top-level amount/currency/reason) | ✅ |
| 5. Security row | bogus `sk_test_00…0` secret → real **401** → connection flips `expired` (the only expiry evidence; revoked/rotated keys are detected) | ✅ |
| 6. At-rest | connection record store file contains **zero** secret material (real key and bogus key both absent) | ✅ |

## Credential discipline

- The key exists **only** as the env var `ZCODE_PAYSWAP_PAYSTACK_TEST_KEY` for the
  duration of the run; it is read from the account owner's own PayStack dashboard
  (test mode) in the integrated browser.
- No key material appears in this evidence, in the test file, in logs, or in any
  persisted store (row 6 asserts the at-rest invariant).
- Test mode = no real-money movement is possible with these credentials; every
  request is a readonly GET on the pinned closed-set paths.
- The customer rows returned by the live `customers` read are **not** persisted —
  the suite asserts only the projected row key shape (`id`, `created`,
  `description`), and PII fields (email/name/phone) are never read.

## Honest boundaries

- Test-mode only: the live-mode leg stays blocked on business activation
  (compliance steps Contact/Owner/Account/Service-agreement require the
  account owner's real business data — address, owner identity document,
  settlement account — which cannot be supplied by automation).
- The identity-gap row is expected behavior, not a failure: PayStack publishes no
  official self-identity endpoint, so `verified` identity evidence is impossible
  without fabrication (pinned for re-verification).
- The `disputes` typed-unavailable row is the pinned provider-absence projection,
  not a network condition.
