# Protocol fact sheet — AP2 / x402 / MPP (P3 — versioned protocol contracts)

> Retrieval batches: **2026-11-15 first pass** (TL ops environment, plain HTTPS)
> and **2026-11-15 second pass** (TL ops environment + headless-browser JS
> rendering + `raw.githubusercontent.com` spec sources + npm registry + live
> sandbox API probes). Machine half (single source for pinning):
> `packages/shared/src/payswap/protocols/protocol-facts.ts`
> (`PAYSWAP_PROTOCOL_PIN_REGISTRY`). This sheet is the fuller retrieval log.
>
> Second-pass retrieval environment honesty: `api.github.com` REST was
> rate-limited from this network (HTTP 403); GitHub facts were taken from
> github.com HTML pages and `raw.githubusercontent.com` instead. IETF
> datatracker (`datatracker.ietf.org`) answered HTTP 403 behind a Cloudflare
> JS challenge and could not be read this pass — recorded per item below.

## AP2 — Agentic Payment Protocol (v0.2)

Sources: <https://ap2-protocol.org/ap2/specification/> ·
<https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/specification.md>
· repo <https://github.com/google-agentic-commerce/AP2> (release tag `v0.2.0`,
Apache-2.0, "Copyright 2025 Google") · retrieved 2026-11-15 (both passes).

Pin: **v0.2** (verified version string — spec page title "Agentic Payment
Protocol (v0.2)"; corroborated by GitHub release tag `v0.2.0`; note the
license line "Apache License, Version 2.0" is a license version, not a
protocol version).

Verified (second pass — corrections and additions to the first pass):

- **Correction — roles are five, and the spec names them**: Shopping Agent
  (SA), Credential Provider (CP), Merchant (M), **Merchant Payment Processor
  (MPP)**, and Trusted Surface (TS). The spec's own role text: "The Trusted
  Surface role is a UI surface that is trusted to get informed user consent
  for an Intent before creating a user-signed Mandate"; "The following role
  MUST be non-agentic: Trusted Surface"; "The following role is expected to
  be agentic: Shopping Agent"; a single entity may play multiple roles.
  Acronym collision noted honestly: the AP2 role "MPP" (Merchant Payment
  Processor) and the machine-payments protocol "MPP" are unrelated — both
  spellings are recorded, neither is renamed here.
- **Correction — only two modes are in scope** (first pass recorded the spec's
  table of contents, which lists three). Spec §Modes verbatim: "There are two
  `modes` that AP2 can consider to operate in." — Human Present (Direct) and
  Human Not Present (Autonomous). §Agent-to-Agent Delegation verbatim:
  "Conceptually, it is possible to use this protocol to support delegation of
  Mandates from one Shopping Agent to another. This is outside the scope of
  the current specification."
- **Mandate versioning is published and exact-match**: "Each AP2 Mandate type
  identifies its schema using the `vct` claim. The `vct` value includes a
  numeric suffix that acts as a schema version number (e.g.
  `mandate.payment.1`, `mandate.checkout.open.1`). Implementations MUST match
  the exact `vct` string, including the version suffix. A future incompatible
  schema revision would introduce a new suffix (e.g. `.2`)."
- **VDC format is SD-JWT** (§Verifiable Digital Credential Formats): "AP2
  specifies the use of `SD-JWT`s for securing the Payment and Checkout
  Mandates. Payment and Checkout Mandates could be cryptographically secured
  by other VDCs as mentioned in [Agent Authorization]."
- **Payment Mandate field-level schemas are published**
  (`docs/ap2/payment_mandate.md`, `checkout_mandate.md` — both fetched
  2026-11-15): `vct` values `mandate.payment.1` (closed) /
  `mandate.payment.open.1` (open); rendered field list includes `_sd_alg,
  allowed, currency, execution_date, frequency, max, max_occurrences, min,
  not_after, not_before, payee, payment_amount, payment_instrument, vct`;
  constraints include Agent Recurrence (`payment.agent_recurrence`), Allowed
  Payees, Allowed Payment Instrument, Allowed PISP, Amount Range, Budget,
  Execution Date; "The Payment Mandate is bound to a particular Checkout using
  the cryptographic hash of the Checkout JWT."
- **Agent Authorization mechanics are published**
  (`docs/ap2/agent_authorization.md` — fetched 2026-11-15): User Credential
  delegation via OpenID4VP with `transaction_data` containing base64url-encoded
  mandate-delegation objects ("the mandate delegation object MUST contain …
  **type**: **REQUIRED**. MUST be the string value `delegate`"); Mandate
  Delegation, Mandate Structure, Action Authorization and Errors sections all
  present; the User Credential may be "a directly trusted user key … such as a
  passkey or hardware-attested key."
- Compatibility (spec self-description): "AP2 is designed explicitly to be
  compatible with the Universal Commerce Protocol (UCP)."

Still ⚠ before adapter message code (`reverifyBeforeAdapter` in the machine
registry — narrowed this pass, not empty): field-level extraction of the
OpenID4VP delegation objects and Action Authorization error semantics into
PaySwap message-face tests (the pages are published; the per-field pinning is
adapter work and must cite them), and the checkout-mandate field set has the
same status.

## x402 — pinned v2 (specification source found)

Sources: **canonical spec**
<https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md>
(raw fetched 2026-11-15; verbatim header: "# X402 Protocol Specification" /
"**Protocol Version**: 2") · official docs <https://docs.x402.org> ("These
docs are the credibly neutral source of truth for x402, as x402 is a
completely open standard under the Apache-2.0 license") · landing page
<https://x402.org> (first pass) · repo <https://github.com/x402-foundation/x402>
("A payments protocol for the internet. Built on HTTP."). Repo provenance:
`github.com/coinbase/x402` is a **fork** (embedded metadata
`repository_is_fork: true`, `repository_parent_nwo: x402-foundation/x402`) —
the x402 Foundation repo is canonical; `x402.org` and `docs.x402.org` both
link to it. An `x402-specification-v1.md` ("**Protocol Version**: 1") exists
in the same `specs/` directory.

Pin: **v2** (verified version string from the spec document itself — the
first pass's honest null is resolved).

Verified wire facts (quotes from `specs/` + `docs.x402.org`, retrieved
2026-11-15):

- HTTP transport (`specs/transports-v2/http.md`): "The server indicates
  payment is required using the HTTP 402 'Payment Required' status code." /
  "**Mechanism**: HTTP 402 status code with `PAYMENT-REQUIRED` header". Header
  summary: `PAYMENT-REQUIRED` (server → client, base64-encoded
  `PaymentRequired` object), `PAYMENT-SIGNATURE` (client → server,
  base64-encoded `PaymentPayload` object), `PAYMENT-RESPONSE` (server →
  client, base64-encoded `SettlementResponse` object). "None of the three
  headers above is CORS-safelisted."
- Version migration table (`docs.x402.org/guides/migration-v1-to-v2.md`): V1
  used `X-PAYMENT` / `X-PAYMENT-RESPONSE`, string network format
  ("base-sepolia"), `x402Version: 1`; V2 uses `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE`, CAIP-2 network format (`eip155:84532`), `x402Version: 2`.
  **Correction to PaySwap's first-pass notes: there is no `X-PAY` header —
  V1's client header is `X-PAYMENT`.**
- 402 body (`docs.x402.org/schemes/overview.md` example): JSON with
  `"x402Version": 2`, `error`, `resource: {url, description, mimeType}` and
  `accepts: [{scheme, network, amount, asset, payTo, maxTimeoutSeconds,
  extra}]` (example rows: `scheme: "exact"`, `network: "eip155:84532"`, USDC
  asset address; also `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`).
- Schemes: core v2 spec lists "including `exact`, `upto`, and
  `batch-settlement`"; docs overview adds `auth-capture` ("refundable payments
  where funds are held in escrow"); `exact` is fixed-price, `upto` is
  single-request usage-based, `batch-settlement` is high-volume/repeated
  micropayments.
- Networks (CAIP-2) per `docs.x402.org/core-concepts/network-and-token-support.md`:
  `eip155:<chainId>`, `solana:<genesisHash>`, plus TON (`tvm`), `algorand`,
  `stellar`, `aptos`, `hedera`, `keeta`, `near`, `canton`, Concordium (`ccd`),
  `xrpl`, `cardano`, `sui`; schemes overview also names Bitcoin Lightning
  (`lnbtc`).
- EVM transfer methods (`specs/schemes/exact/scheme_exact_evm.md`): EIP-3009,
  Permit2, ERC-7710; default `assetTransferMethod` is `"eip3009"`.
- Facilitation: "The server verifies and settles the payment independently, or
  by leveraging an x402 facilitator's /verify and /settle endpoints"
  (docs introduction).
- Package provenance: npm `x402` and `x402-fetch` at 1.2.0 (author "x402
  Foundation", repository `git+https://github.com/x402-foundation/x402.git`,
  Apache-2.0).

Still ⚠ before adapter message code (narrowed, not empty): per-scheme
field-level `PaymentRequired` / `PaymentPayload` / `SettlementResponse`
schemas pinned into PaySwap message-face tests from the v2 spec + per-scheme
spec pages; facilitator verify/settle semantics; replay/timeout semantics
beyond `maxTimeoutSeconds`.

## MPP — pinned draft-httpauth-payment-01 (specification suite found)

Sources: **core spec source**
<https://github.com/tempoxyz/mpp-specs/blob/main/specs/core/draft-httpauth-payment-01.md>
(kramdown-rfc YAML fetched 2026-11-15; verbatim front matter: `title: The
"Payment" HTTP Authentication Scheme` / `docname: draft-httpauth-payment-01`
/ `version: "01"` / `category: std` / `submissiontype: IETF`) · rendered spec
suite <https://paymentauth.org/draft-httpauth-payment-01.html> (also
.txt/.pdf/.xml) · official site <https://mpp.dev> ("Machine Payments Protocol
| MPP"; `machinepayments.dev` and `machinepaymentsprotocol.org` both 301 →
mpp.dev) · announcement
<https://stripe.com/blog/machine-payments-protocol> (first pass; `datePublished
2026-03-18`) · Stripe docs page <https://docs.stripe.com/payments/machine/mpp>
(og:title "MPP"; "MPP is a payment protocol that enables automated systems and
AI agents to make payments"). Authors (spec front matter): Brendan Ryan, Jake
Moxey, Tom Meagher (Tempo Labs); Jeff Weinstein, Steve Kaliski (Stripe). The
spec README names the IETF draft
`draft-ryan-httpauth-payment` as the core specification — datatracker itself
answered **HTTP 403 (Cloudflare JS challenge)** this pass and its revision
status could not be read directly; the draft name and `-01` revision are
corroborated by mpp-specs and paymentauth.org.

Pin: **draft-httpauth-payment-01** (verified docname + version "01" from the
spec source; the first pass's honest null is resolved).

Verified wire facts (quotes from the core draft + mpp.dev, retrieved
2026-11-15):

- Scheme: "This document defines the 'Payment' HTTP authentication scheme,
  enabling HTTP resources to require a payment challenge to be fulfilled
  before access. The scheme extends HTTP Authentication, using the HTTP 402
  'Payment Required' status code."
- Flow: `402 Payment Required` with `WWW-Authenticate: Payment id="..",
  method="..", intent="..", request=".."` → client pays → retry with
  `Authorization: Payment <credential>` → `200 OK` with `Payment-Receipt:
  <receipt>`.
- Terminology (verbatim): "Payment Challenge: A `WWW-Authenticate` header with
  scheme 'Payment' indicating the payment requirements for accessing a
  resource." — "Payment Credential: An HTTP header field with scheme 'Payment'
  containing payment authorization data. The default field name is
  `Authorization`. A Payment challenge MAY select `Payment-Authorization` with
  the `header` parameter" — "Request: Method-specific data in the challenge
  enabling payment completion. Encoded as base64url JSON in the `request`
  parameter."
- Failure semantics: `malformed-credential`, `invalid-challenge`,
  `payment-expired`, `verification-failed` problem types answer 402 with a
  fresh challenge.
- Intents (mpp.dev, official site): Charge ("one-time payments … buyer pays
  once for a request before receiving the resource"), Session ("metered
  pay-as-you-go payments … when usage is frequent or the final cost is unknown
  upfront"), Subscription ("recurring fixed payments … access renews across
  billing periods").
- **SPT mechanics** (from `draft-stripe-charge-00.txt`, paymentauth.org): the
  Stripe method "exchange[s] one-time payments using Shared Payment Tokens
  (SPTs)"; "Shared Payment Token (SPT): A single-use token (prefixed with
  spt_) that represents authorization to charge a payment method"; §10.1 "SPT
  Single-Use Constraint".
- Governance (mpp.dev/governance): "Anchoring the core at the IETF means no
  single company controls i[t]"; "the specification is governed by IETF Trust
  licensing under [IETF Trust Legal Provisions]".
- Draft suite breadth (paymentauth.org, all `-00` unless noted):
  draft-payment-discovery-01, draft-nearintents-charge-01,
  draft-payment-intent-charge-00, draft-payment-intent-subscription-00,
  draft-payment-transport-mcp-00, draft-card-charge-00, draft-evm-charge-00 /
  -session-00, draft-hedera-charge-00 / -session-00,
  draft-lightning-charge-00 / -session-00, draft-solana-charge-00 / -session-00
  / -subscription-00, draft-stellar-charge-00, draft-stripe-charge-00 /
  -subscription-00, draft-tempo-charge-00 / -session-00 / -subscription-00,
  draft-usdc-charge-00, draft-xrpl-charge-00 / -session-00.
- `mpp.dev` serves `<body data-version="1.0">` — observed but unlabeled;
  **not** cited as the protocol version (the draft revision is the defensible
  pin).
- SDK ecosystem (mpp-specs README): TypeScript `wevm/mppx` (npm `mppx`
  0.19.0), Python `tempoxyz/pympp`, Rust `tempoxyz/mpp-rs`, Go
  `tempoxyz/mpp-go`, Ruby `stripe/mpp-rb`.

Still ⚠ before adapter message code (narrowed, not empty): the per-method
drafts (charge/session/subscription per rail) each carry their own wire
details and are `-00` revisions — field-level pinning per rail into PaySwap
message-face tests; the MCP transport draft; direct IETF datatracker
confirmation of `draft-ryan-httpauth-payment` status/expiry (blocked by
Cloudflare this pass — retry from a browser-rendered session later).

## Boundary contract (unchanged in law, updated in pins)

`packages/shared/src/payswap/protocols/protocol-contract.ts` is unchanged:
the pinned-registration gate (`evaluatePayswapProtocolAdapterRegistration`),
the closed refusal vocabulary and the two translation directions (untrusted
proposal references in; receipts out only from verified execution/
reconciliation state) are the same law as the first pass. What changes this
pass is the registry: x402 and MPP now carry **pinned** version strings from
citable specification documents, so `protocol_version_unpinned` no longer
fires for them — an x402 v2 or MPP draft-httpauth-payment-01 descriptor now
reaches `registered`, and `protocol_version_unsupported` guards version and
fact-source drift. All three protocols' `reverifyBeforeAdapter` lists remain
non-empty: adapter **message-face** implementation stays gated (the lists
shrink as facts are pinned, they do not silently close). No external message
schemas are invented in this change.
