# Protocol fact sheet — AP2 / x402 / MPP (P3 — versioned protocol contracts)

> Retrieval batch: 2026-11-15, from the TL ops environment (plain HTTPS).
> Machine half (single source for pinning):
> `packages/shared/src/payswap/protocols/protocol-facts.ts`
> (`PAYSWAP_PROTOCOL_PIN_REGISTRY`). This sheet is the fuller retrieval log.

## AP2 — Agentic Payment Protocol (v0.2)

Source: <https://ap2-protocol.org/ap2/specification/> · retrieved 2026-11-15.

Verified:

- The spec page titles the protocol **"Agentic Payment Protocol (v0.2)"** and
  self-describes as "a protocol to secure Agent-performed payment transactions"
  that "makes use of the Agent Authorization model". (The site header uses
  "Agent Payments Protocol – AP2"; both names are recorded, neither is
  adjudicated here.)
- Roles include a **Trusted Surface (TS)**: "a UI surface that is trusted to
  get informed user consent for an Intent before creating a user-signed
  Mandate" — PaySwap's counterpart is the existing trusted, non-agentic
  Class-B surface (doc 12 §6 boundary rule).
- Payment Mandate modes, enumerated by the spec's own table of contents:
  **Direct (Human Present)**, **Autonomous (Human Not Present)**,
  **Agent-to-Agent Delegation**.
- **Checkout Mandate + Receipt** and **Payment Mandate + Receipt** are paired
  artifacts usable as evidence at dispute time.
- AP2 self-describes as operating "as a security feature within a Commerce
  Protocol" — consistent with PaySwap's boundary (addendum §10: adapters are
  not providers or executors).

Pin: **v0.2** (verified version string). Still ⚠ before adapter message code
(`reverifyBeforeAdapter` in the machine registry): field-level mandate/receipt
schemas; VDC formats; the Agent Authorization Framework mechanics; mandate
versioning rules.

## x402

Source: <https://x402.org> · retrieved 2026-11-15.

Verified:

- Self-described as "an open, neutral standard for internet-native payments".
- Flow, in the site's own words: "If a request arrives without payment, the
  server responds with HTTP 402, prompting the client to pay and retry" — the
  402 challenge is **untrusted input, not consent** (doc 12 §6 rule).
- Server-side middleware shape: `paymentMiddleware` with per-route accepted
  networks/schemes.
- Landing-page copy mentions agents paying "instantly with stablecoins" —
  rail facts must come from the official specification, not landing-page
  copy; not encoded as a rule.

Pin: **honestly null** — the landing page publishes no citable version string.
Adapter message code is blocked by the machine registry
(`protocol_version_unpinned`) until a spec source with a verified version
string is recorded. ⚠ before adapter code: spec document URL + version;
402 request/response wire formats; accepted asset/network/scheme set;
receipt and replay semantics.

## MPP — Machine Payments Protocol

Source: <https://stripe.com/blog/machine-payments-protocol> · retrieved
2026-11-15 (announcement page; not a specification document).

Verified:

- "an open standard, internet-native way for agents to pay — co-authored by
  Tempo and Stripe".
- "provides a specification for agents and services to coordinate payments
  programmatically, enabling microtransactions, recurring payments, and more".
- Stripe users can accept payments over MPP "as fiat with cards and buy now,
  pay later payment methods via Shared Payment Tokens (SPTs)".
- Announcement examples include per-session metered consumption (agents
  paying per headless-browser session) — metered/repeated charges map to
  PaySwap envelope bounds, not to ambient billing (doc 12 §6 rule).

Pin: **honestly null** — an announcement page is not a citable version source.
⚠ before adapter code: official specification URL + version; session
lifecycle and message schemas; SPT mechanics relative to the PaySwap
credential plane; metered/recurring event semantics and verification rules.

## Boundary contract (implemented this pass)

`packages/shared/src/payswap/protocols/protocol-contract.ts` implements the
addendum §10 boundary: the pinned-registration gate
(`evaluatePayswapProtocolAdapterRegistration` — refuses
`protocol_not_registered` / `protocol_version_unpinned` /
`protocol_version_unsupported`, including fact-source drift), the closed
refusal vocabulary (`protocol_message_unverifiable`,
`protocol_feature_unsupported`, `protocol_receipt_unavailable`), and the two
translation directions as types only — inbound messages verify into
**untrusted proposal references** (never grants), receipts emit only from
verified execution/reconciliation state. No external message schemas are
invented; those land behind the ⚠ lists above.
