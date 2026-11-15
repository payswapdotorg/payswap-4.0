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

| Sheet | Subject | Status (2026-11-15) |
|---|---|---|
| `stripe-readonly-endpoints.md` | Stripe read-only data-plane endpoint facts (P2/ADR-P2-1; baseline 2026-11-13) | pre-existing sheet — its own deadline: re-verify the Stripe rows when the Paystack/PayPal data-plane lists are established (P3, behind the ⚠ auth gates) |
| `paystack.md` | Paystack auth/transfer facts | partially retrievable — API base live-verified; docs site unreachable from the ops network; all doc-04 facts remain ⚠ RE-VERIFY |
| `paypal.md` | PayPal REST/OAuth/payouts facts | partially verified — OAuth 2.0 client-credentials + base URLs verified from official docs; payouts page is JS-rendered → dedupe facts remain ⚠ RE-VERIFY |
| `protocols-ap2-x402-mpp.md` | AP2 / x402 / MPP protocol facts | boundary facts verified from official sources; version pins: AP2 v0.2 verified; x402/MPP version strings not yet verifiable (honestly unpinned) |

## Retrieval environment honesty

Retrievals on 2026-11-15 were performed from the TL ops environment: plain
HTTPS fetches (no JS rendering). Consequences, recorded per sheet: pages that
require JavaScript rendering (e.g. PayPal's payouts reference) or that block
the retrieval network (e.g. Paystack's docs site, HTTP 403) could **not** be
re-verified this pass. Those items stay ⚠ and gate their adapter code. This is
preferred over citing stale or second-hand facts.
