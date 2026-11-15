# Paystack fact sheet (P3 — read-only provider conformance)

> Retrieval batches: **2026-11-15 first pass** (TL ops environment, plain
> HTTPS, no JS rendering) and **2026-11-15 second pass** (headless-browser JS
> rendering + official first-party code artifacts + live unauthenticated API
> probes). Upstream baseline: `docs/payswap/p0/04-provider-auth-comparison.md`
> §2 (as of 2026-11, ⚠ RE-VERIFY flags preserved there; this sheet is the
> re-verification record).

## Retrieval environment honesty (second pass)

`https://paystack.com/**` remains unreachable from this network **including
via headless-browser JS rendering**: every path (docs, robots.txt,
sitemap.xml) answers Cloudflare HTTP 403, and the interactive Turnstile
challenge ("Verify you are human") wedged the headless session twice — the
challenge could not be completed from this environment today. The official
docs site therefore remains un-retrieved. What the second pass could do
instead, and did: (a) live unauthenticated probes of the API host (GET only,
zero credentials, zero writes), (b) the official first-party Node SDK
(`@paystack/paystack-sdk`, publisher `andrew@paystack.com`, npm modified
2026-10-21, source repo `PaystackOSS/paystack-node`, HEAD merged 2026-10-20),
auto-generated from Paystack's own OpenAPI specification, and (c) the
official WooCommerce plugin repo for the webhook verifier code. Wayback
(archive.org) was rate-limited (HTTP 429) from this IP for the entire pass —
recorded, not worked around by citing second-hand sources.

## Verified (2026-11-15 — live API probes)

| # | Fact | Source | Retrieval |
|---|---|---|---|
| K-1 | `https://api.paystack.co` is live; the six read-plane routes exist (HTTP 401 on unauthenticated GET — not 404): `/transaction`, `/customer`, `/dispute`, `/balance`, `/transfer`, `/settlement` | live unauthenticated GET probes | 2026-11-15 |
| K-2 | Unauthenticated 401 envelope (no header): `{"status":false,"message":"No Authorization Header was found","meta":{"nextStep":"Ensure that you provide the correct authorization key for the request"},"type":"validation_error","code":"invalid_Key"}` (per-endpoint probes; `/balance` `/transfer` `/settlement` spell it "No Authorization header was found" — case varies in the wild, shape does not) | live probe | 2026-11-15 |
| K-3 | Invalid-credential 401 envelope (fake `Bearer sk_test_invalidkey123` — syntactically fake, zero real secrets): `{"status":false,"message":"Invalid key","meta":{…nextStep…},"type":"validation_error","code":"invalid_Key"}` — **HTTP 401 is the auth-failed evidence code on the read plane** | live probe of `GET /balance` | 2026-11-15 |
| K-4 | Unknown route answers bare HTTP 404 (empty body) — 401-vs-404 distinguishes existing routes from absent ones | live probe of `/definitelynotanendpoint` | 2026-11-15 |
| K-5 | `OPTIONS /transaction` answers 200 with `access-control-allow-origin: *` (CORS enabled; TLS enforced — HSTS `max-age=31536000; includeSubDomains; preload` observed) | live probe | 2026-11-15 |

## Verified (2026-11-15 — official first-party code artifacts)

| # | Fact | Source | Retrieval |
|---|---|---|---|
| K-6 | The official Node SDK (`@paystack/paystack-sdk` v1.2.2) is **auto-generated from Paystack's OpenAPI specification** ("The OpenAPI specification of the Paystack API that merchants and developers can harness to build financial solutions in Africa", contact `techsupport@paystack.com`); base path `https://api.paystack.co`; auth is `Authorization: Bearer <apiKey>`; response envelope `{status, message, data}` | npm tarball dist + https://github.com/PaystackOSS/paystack-node (HEAD 2026-10-20) | 2026-11-15 |
| K-7 | Read-plane endpoint surface (GET paths in the official SDK): `/balance` (+ `/balance/ledger`), `/transaction` (list; + `/transaction/{id}`, `/transaction/totals`, `/transaction/export`), `/customer` (list; + `/customer/{code}`), `/dispute` (list; + `/dispute/{id}`, `/dispute/export`, `/dispute/transaction/{id}`), `/settlement` (+ `/settlement/{id}/transaction`), `/refund`, `/transfer` (list; + `/transfer/{code}`, `/transfer/verify/{reference}`, `/transfer/export`), `/page`, `/product` | official SDK v1.2.2 bundle | 2026-11-15 |
| K-8 | Transfer-control endpoints exist (write plane — recorded for the executor design, not for read-only use): `/transfer/finalize_transfer`, `/transfer/resend_otp`, `/transfer/enable_otp`, `/transfer/disable_otp`, `/transfer/disable_otp_finalize`, `/transfer/bulk`, `/transferrecipient` (+ bulk) | official SDK v1.2.2 bundle | 2026-11-15 |
| K-9 | Integration/account-adjacent endpoints: `/integration/payment_session_timeout`; bank detail resolution `/bank`, `/bank/resolve`; `/address_verification/states`; `/country` | official SDK v1.2.2 bundle | 2026-11-15 |
| K-10 | Official SDK README connects from a sandbox/test posture with a `sk_test_…` secret key ("create a Paystack account … to get your test and live secret keys"; example `new Paystack("sk_test_xxxxxx")`) — the `sk_test_` prefix form appears in current official first-party usage | official SDK README (npm) | 2026-11-15 |
| K-11 | **Webhook signature scheme (corroborating first-party code, 2021 vintage)**: the official WooCommerce plugin verifies `x-paystack-signature` as `hash_hmac('sha512', $rawBody, $secretKey)` — HMAC-SHA512 of the raw request body keyed by the account secret key; the check requires the header to be present and rejects otherwise. Recorded as official-code corroboration of doc 04 §2.3; **current-docs confirmation still pending** (docs site unreachable — see honesty note) | https://github.com/PaystackHQ/plugin-woocommerce `includes/class-wc-gateway-paystack.php` (repo HEAD 2021-05-02) | 2026-11-15 |

## Remains ⚠ RE-VERIFY before any Paystack adapter code (doc 04 §2/§5 — narrowed, not empty)

1. **Key shapes end-to-end**: `sk_test_` is verified via official SDK usage
   (K-10); `sk_live_`, `pk_test_`, `pk_live_` prefixes and the full key
   character grammar are still only doc-04 ⚠ claims — the docs site (keys and
   permissions pages) is the missing source. No `formatCheck` regex may be
   encoded from partial evidence.
2. **The API key permissions feature** (availability, scope list,
   transfers-disabled/read-only posture for evidence collection — the
   P2-equivalent restricted-key question): still unverifiable without the
   docs site.
3. **Transfer status enum including the reversal window** (`success` →
   `reversed`): the endpoints are verified (K-8) but the status vocabulary and
   reversal window are docs facts — still ⚠.
4. **Webhook current-source confirmation**: the HMAC-SHA512 scheme is
   corroborated by official plugin code (K-11) but the current docs page
   (incl. whether separate webhook secrets now exist) and the published
   webhook source-IP list remain unverified.
5. **Test magic numbers and the current error-code catalog** beyond the two
   live 401 envelopes (K-2/K-3): docs facts — still ⚠.

## Consequence in source (fail-closed, by design — unchanged)

Paystack remains **not** registered in the account-service authSpec set: item
1 above (key shapes) is the gate the authSpec's `formatCheck`/`modePrefixes`
would encode, and it is only partially verified — encoding a prefix regex
from partial evidence would violate the doc 04 §5 discipline. `connect` for
`providerId: "paystack"` keeps producing the typed refusal
`unsupported_provider` (zero at-rest writes) until the docs site is
retrievable (or an official spec document surfaces the key grammar) and the
remaining ⚠ items close. No Paystack read adapter exists; nothing is
invented.
