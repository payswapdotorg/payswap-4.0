# Paystack fact sheet (P3 — read-only provider conformance)

> Retrieval batch: 2026-11-15, from the TL ops environment (plain HTTPS, no JS
> rendering). Upstream baseline: `docs/payswap/p0/04-provider-auth-comparison.md`
> §2 (as of 2026-11, ⚠ RE-VERIFY flags preserved there).

## Verified this pass (2026-11-15)

| Fact | Source | Retrieval |
|---|---|---|
| `https://api.paystack.co` is live and reachable (HTTP 200 on base) | `https://api.paystack.co` | 2026-11-15 |

That is all this pass could verify directly. The API base responds, but key
shapes, permissions and endpoint semantics cannot be verified from a bare base
URL, and are **not** encoded in source.

## Could not be re-verified this pass (network-blocked — recorded honestly)

- `https://paystack.com/docs/**` → **HTTP 403** to this environment (with and
  without a browser user-agent). `https://docs.paystack.com` → does not resolve
  from this network. Paystack's developer documentation was therefore **not**
  retrievable on 2026-11-15 from the TL ops environment.

## Remains ⚠ RE-VERIFY before any Paystack adapter code (doc 04 §2/§5)

1. Secret-key / public-key shapes and test/live prefixes (`sk_test_`/`sk_live_`,
   `pk_test_`/`pk_live_` per doc 04 §2.1 — unverified this pass).
2. The **API key permissions** feature: availability, scope list, and whether
   live keys can be restricted to transfers-disabled/read-only for evidence
   collection (doc 04 §2.1 ⚠; the P2-equivalent restricted-key posture for
   Paystack depends on it).
3. Transfer status enum including the reversal window; transfer-control
   endpoints and defaults per market (doc 04 §2.2/§2.5).
4. Webhook signature scheme (`x-paystack-signature`, HMAC-SHA512 of raw body
   with the secret key) and whether separate webhook secrets now exist;
   published webhook source-IP list (doc 04 §2.3 ⚠).
5. Test magic numbers and current error-code catalog (doc 04 §5 item 2).
6. Country/currency scoping of transfers per account (capability evidence must
   come from the account's actual state, never from marketing matrices —
   doc 04 §2.5).

## Consequence in source (fail-closed, by design)

Paystack is **not** registered in the account-service authSpec set: `connect`
for `providerId: "paystack"` produces the typed refusal `unsupported_provider`
(zero at-rest writes) until the ⚠ items above are re-verified and an authSpec
is registered from verified facts. No Paystack read adapter exists; nothing is
invented.
