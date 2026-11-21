# PayPal sandbox LIVE conformance — 2026-11-21

## What this proves

The P3 PayPal provider half's readonly contract, exercised against the **real
`https://api-m.sandbox.paypal.com`** (no mock transport) with the account
owner's own **sandbox client-credentials pair** (read from the account owner's
developer dashboard in the integrated browser), via
`packages/services/test/payswap-paypal-live-conformance.test.ts`.

Suite: **1 passed** (~4.0 s, real network). Without the env pair the suite
**skips** (CI/batteries stay network-free).

## The acceptance rows (all green, real API)

| Row | Behavior proven | Real-API result |
|---|---|---|
| 1. Connect | client-credentials pair (clientId + secret + declared mode) → `connected` mode test; zero network at connect | ✅ |
| 2. Verified | real token exchange (`POST /v1/oauth2/token`, Basic pair, form grant) → 200 → read-back `verified` with `providerAccountId` = the official `app_id` (real value `APP-80W284485P519543T` observed live); connection state `connected` | ✅ |
| 3. Overview gate | `getOverviewData` verification passes (`verified`) but the PayPal contract's verified outcome carries **no capability evidence** (client_credentials reachability to identity surfaces is not officially evidenced — shared pin; nothing fabricated) → the overview detail face refuses fail-closed (`read_back_unavailable`) | ✅ |
| 4. Data reads (real) | direct data port with the real pair: `balance` → typed `unavailable` (real empty-state: the official `balances` envelope key is absent for this fresh sandbox account — the adapter refuses to fabricate an empty projection); `payment_objects` → typed `unavailable` (same real empty-state: `transaction_details` key absent); `customers` → `refused{unsupported_operation}` (official absence, zero wire touch); `disputes` → `ok` with an empty rows projection (the official `items` envelope is present and empty) | ✅ |
| 5. Security row | bogus secret pair → real **401** (`invalid_client`) → connection flips `expired` (the only expiry evidence) | ✅ |
| 6. At-rest | the connection record store contains **zero** credential material (real pair and bogus pair both absent) | ✅ |

## Honest boundaries recorded by the run

- **Fresh-sandbox empty states**: this sandbox business account carries no
  balance/transaction rows, so the official reporting envelopes arrive with the
  `balances`/`transaction_details` keys absent. The adapter's all-or-nothing
  discipline treats a key-absent envelope as "no data evidence" (typed
  `unavailable`) rather than fabricating an empty projection. The `ok` shape
  for populated envelopes is pinned by the unit battery (mock envelopes with
  real rows); the live leg pins the observed real-API behavior. Pinned for
  re-verification once the account carries data.
- **Overview gate**: PayPal's `verified` row carries no capability evidence by
  design — the overview detail face therefore answers `refused` for PayPal
  exactly as it does for PayStack's identity gap. Four-category detail reads
  are exercised through the data port directly.
- Test-mode only: sandbox = no real-money movement is possible; every request
  is a readonly call on the pinned official endpoints.

## Credential discipline

- The pair existed **only** as env vars for the duration of the run, extracted
  in-browser from the account owner's own dashboard session and held in a
  temp file (0600, outside the repo) that was **deleted immediately after the
  run**. Token/balance/transaction/dispute probe files were deleted with it.
- No key material appears in this evidence, in the test file, in logs, or in
  any persisted store (row 6 asserts the at-rest invariant; the suite also
  asserts the record store never carries the client ID).
- The `disputes`/`transactions` row contents are **not** persisted — the suite
  asserts only outcome statuses and array shapes.
