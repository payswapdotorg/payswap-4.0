# x402 five-row disposition — 2026-11-22, re-verified 2026-11-23

The canonical x402 fact register (`packages/shared/src/payswap/protocols/protocol-facts.ts`)
pins the wire schemas, facilitator semantics, transport rules and nine wire behaviors
(fourth-pass retrieval, 2026-11-22). Five rows stayed **specification-silent**. This
document is the row-by-row disposition required by the handoff (P3-B): for each row,
what the official specification actually says, which behaviors are supported and
implemented, which remain silent or inaccessible, the **exact** typed refusal, and
whether the gap is a P3 blocker or an explicitly unsupported capability for the
Windows MVP.

## Source of record for every quote below

| Item | Value |
|---|---|
| Repository | `x402-foundation/x402` (canonical; `coinbase/x402` is a fork) |
| Commit | `b711fa9fead4cf8a955e8afeafd179de9af75402` (branch `main`) |
| Retrieved | 2026-11-23T17:15:15Z (raw files, byte-identical copies hashed below) |
| Files | `specs/x402-specification-v2.md` (sha256 `c0c94b8c…`, 733 lines), `specs/schemes/exact/scheme_exact_evm.md` (`186111e2…`), `specs/transports-v2/http.md` (`7f8b0469…`) |
| Re-verification | Before any P6/P9 integration is enabled, and at the latest 2026-12-23 |

Quotes are verbatim from those files at that commit. Nothing below is taken from
secondary sources; SDK behavior is labelled as implementation evidence wherever it
is mentioned, and is never the basis for an encoded rule.

## What changed on 2026-11-23, and why

PR #93 produced the first version of this document and landed an x402 message face
described as a "supported subset". Two things were wrong with that state and are
corrected in the same change as this re-verification:

1. **The contract's implementation gate was contradicted by the tree.** The protocol
   contract (law 5) says a protocol's message face must not land while the registry's
   `reverifyBeforeAdapter` list is non-empty, and the law battery asserted that x402
   and MPP were still blocked — while faces for both were merged. The previous
   version of this document said the face "can be law-unblocked by … recording these
   five rows … in the reverify list"; no such recording was ever made. The registry now
   carries an explicit `unsupportedCapabilities` list (each entry with its typed
   refusal), the re-verification lists are empty for all three landed faces, and the
   registration gate itself refuses `protocol_reverify_pending` while a list is
   non-empty.
2. **The "supported subset" accepted more than it validated.** The face validated any
   `scheme`/`network` and left the scheme-specific `payload` unvalidated, then returned
   `validated-untrusted-proposal`. The subset is now exactly what the register pins
   field-by-field — `exact` on `eip155:*` via the default `eip3009` transfer method and
   the default `authorization` flow — with a strict payload schema; everything else is
   typed `protocol_feature_unsupported` (unavailable, not simulated).

The five rows themselves are unchanged in substance: **none is a P3 blocker**, and
none is implemented by invention.

---

## Row 1 — EVM `validAfter` / `validBefore` ↔ `maxTimeoutSeconds` linkage

**Official specification (verbatim).** The core spec defines the fields but never
links them:

> `validBefore` | `string` | Required | Unix timestamp when authorization expires
> — `specs/x402-specification-v2.md` §5.2.2

> `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion
> — §5.1.2

The scheme binding's verification logic says only:

> **Verify** the authorization parameters (Amount, Validity Window) meet the `PaymentRequirements`.
> — `specs/schemes/exact/scheme_exact_evm.md`, Phase 2: Verification Logic, step 3

No document at this commit derives `validBefore` from `maxTimeoutSeconds`.

**SDK evidence (non-normative, not encoded).** The x402 client SDK sets
`validBefore = now + maxTimeoutSeconds` before signing, and the facilitator SDK
checks the window. This is implementation behavior; the register records it as
implementation evidence and encodes none of it.

**Supported and implemented.** A structural window check only: `validAfter < validBefore`
(compared as integers). Both fields must be present digit-strings.

**Silent / inaccessible.** The linkage itself. PaySwap neither derives a `validBefore`
from `maxTimeoutSeconds` nor rejects a payload whose `validBefore` differs from
`issueTime + maxTimeoutSeconds`. Enforcing the window against the current time is the
facilitator's verification step (Row 3).

**Exact typed refusal.** `protocol_message_unverifiable` when `validAfter ≥ validBefore`
or either field is missing / not a digit string.

**Proving tests.** `packages/services/test/payswap-x402-message-face.test.ts` →
"validAfter ≥ validBefore refuses (structural window check — Row 1 disposition)";
"validAfter is not a timestamp string refuses …"; "validBefore is negative refuses …".

**P3 blocker?** **No.** The unverifiable linkage is not encoded. It becomes relevant
only if PaySwap ever *constructs* payments (a client role, P6+), at which point the
client SDK's behavior must be pinned from an official source first.

---

## Row 2 — Core cross-scheme replay statement

**Official specification (verbatim).** The core security section covers one mechanism
family only:

> **EIP-3009 Nonce**: Each authorization includes a unique 32-byte nonce to prevent replay attacks
> **Blockchain Protection**: EIP-3009 contracts inherently prevent nonce reuse at the smart contract level
> **Time Constraints**: Authorizations have explicit valid time windows to limit their lifetime
> **Signature Verification**: All authorizations are cryptographically signed by the payer
> — §10.1 Replay Attack Prevention

and the field table:

> `nonce` | `string` | Required | 32-byte random nonce to prevent replay attacks
> — §5.2.2

No cross-scheme ("all schemes") replay guarantee is stated. Per-scheme MUSTs for
other schemes live in their own scheme documents and are recorded in the register's
fourth-pass facts.

**Supported and implemented.**

- Structural: `nonce` is required and must be 32 bytes (`0x` + 64 hex, the only
  encoding the official example shows).
- Host boundary (services protocol host): the **payment authorization identity** —
  `network + payer + nonce` — is consumed exactly once, atomically. This identity is
  taken from the quoted sentence: the replay defense is the payer's nonce. It
  deliberately does **not** include signature bytes, because ECDSA signatures are
  malleable and a key that included them could be replayed with a re-signed variant.
- A second legitimate purchase of the same resource (new nonce) is a new
  authorization, not a replay.

**Silent / inaccessible.** Any PaySwap-wide "replay-safe across schemes" claim. The
register makes none. Schemes other than `exact`/EVM are not accepted at all (see
"Surfaces outside the supported subset" below), so there is no unpinned surface on
which a replay claim could be made.

**Exact typed refusal.**

| Situation | Code |
|---|---|
| `nonce` missing, empty, or not 32-byte hex | `protocol_message_unverifiable` |
| The same authorization `(network, from, nonce)` is submitted again | `protocol_challenge_consumed` |
| A scheme/network whose replay semantics are not pinned | `protocol_feature_unsupported` |

**Proving tests.** x402 face battery → "nonce is not 32 bytes refuses …", "nonce is a
bare word refuses …", "the credential digest keys on the payer nonce, never on
signature bytes (ECDSA signatures are malleable)". Host battery
(`packages/services/test/payswap-protocol-host.test.ts`) → "replaying the same
authorization refuses protocol_challenge_consumed — even with a different
(malleable) signature"; "a SECOND legitimate purchase of the same resource (new payer
nonce) is a new authorization, not a replay"; "concurrent duplicate payments consume
exactly one".

**P3 blocker?** **No.** Single-use of the authorization is enforced at the host with
the spec's own identity, and no cross-scheme claim is made.

---

## Row 3 — Core enforcement-actor assignment

**Official specification (verbatim).** The facilitator is defined by its role:

> **Resource Server**: A service that requires payment for access to protected resources (APIs, content, data, etc.)
> **Client**: Any application or agent that requests access to protected resources
> **Facilitator**: A service that handles payment verification and blockchain settlement
> — §3 Protocol Components

and the verification steps are the facilitator's:

> **Verify** the signature is valid and recovers to the `authorization.from` address.
> **Verify** the `client` has sufficient balance of the `asset`.
> — `scheme_exact_evm.md`, Phase 2: Verification Logic, steps 1–2

> `/verify` is **read-only**: it validates payment state but MUST NOT commit payment state or write onchain state.
> — §7.1 POST /verify

The core spec does not enumerate which party performs each individual check.

**Supported and implemented.** PaySwap's message face validates **structure**; the
protocol host performs **challenge correlation and single-use**. Neither is an
enforcement actor: no signature recovery, no balance check, no on-chain simulation,
no settling.

**Silent / inaccessible.** Signature verification, balance, and the validity-window
check against the current time. These are not implemented at P3 (see "Signature
posture" below) and the adapter is not the party the spec assigns them to.

**Exact typed refusal.** Not applicable as a *refusal*: the adapter does not enforce,
so there is no behavior it refuses on this row. What the adapter guarantees instead is
that it never reports enforcement it did not perform — a well-formed forged signature
yields `validated-untrusted-proposal`, and a consumed challenge yields
`challenge-consumed` with `credential: "unverified"`.

**Proving tests.** x402 face battery → "a forged-but-well-formed signature is never
verified: the outcome stays an untrusted proposal with no verification claim". Host
battery → "issues a challenge and consumes its exact credential echo once — the
outcome is challenge-consumed with an UNVERIFIED credential".

**P3 blocker?** **No.** The adapter does not claim to be the enforcement actor.

---

## Row 4 — `maxTimeoutSeconds` bounds

**Official specification (verbatim).**

> `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion
> — §5.1.2

No minimum, maximum, or default is documented in the core spec or in any scheme
binding.

**SDK evidence (non-normative, not encoded).** The SDK uses the field for transaction
timeouts and enforces no bounds.

**Supported and implemented.** Presence and type: a positive integer. Nothing else.

**Silent / inaccessible.** Bounds. The message face accepts any positive integer,
including values a human would consider unreasonable; whether a given timeout is
acceptable is a **host policy** decision, made where the host is the issuer (below)
and left to P6 eligibility where it is not.

**Host policy that uses the field (labelled as policy, not protocol).** When the
PaySwap host advertises a 402, the advertised requirements are valid for that entry's
`maxTimeoutSeconds` from the moment of advertisement. This is PaySwap's own staleness
rule for a field the spec defines as "maximum time allowed for payment completion"; it
is not a protocol semantic.

**Exact typed refusal.** `protocol_message_unverifiable` when `maxTimeoutSeconds` is
missing, not a number, not an integer, or ≤ 0.

**Proving tests.** x402 face battery → "x402 message face — maxTimeoutSeconds presence
(Row 4 disposition …)": the five malformed rows, plus the pin that 1, 60, 86 400 and
2 147 483 647 are all structurally valid (no bounds invented).

**P3 blocker?** **No.** Bounds are a host policy and are not encoded.

---

## Row 5 — Stale-402 server behavior

**Official specification (verbatim).** The transport spec defines the status mapping
and nothing about a stale challenge:

> | x402 Error       | HTTP Status | Description                                     |
> | Payment Required | 402         | Payment needed to access resource               |
> | Invalid Payment  | 400         | Malformed payment payload or requirements       |
> | Payment Failed   | 402         | Payment verification or settlement failed       |
> | Server Error     | 500         | Internal server error during payment processing |
> | Success          | 200         | Payment verified and settled successfully       |
> — `specs/transports-v2/http.md`, Error Handling

> Response bodies are a server implementation concern.
> — `specs/transports-v2/http.md`, Response Body

The words "expire", "stale" and "replay" do not occur in the transport spec at this
commit; its only "retry" passages concern browser CORS handling.

**SDK evidence (non-normative, not encoded).** The facilitator SDK returns
`payment-expired` and the server re-issues a fresh 402.

**Supported and implemented.** A **host policy**, stated as such: requirements
advertised by the PaySwap host are matchable for `maxTimeoutSeconds` from
advertisement; after that, a payment for them is refused as stale. Re-advertising the
same 402 is idempotent and refreshes the window, which is what a server re-issuing a
402 needs.

**Silent / inaccessible.** What a server *ought* to do. PaySwap's rule is one valid
choice, not a spec requirement, and the register lists it under
`unsupportedCapabilities` with `refusal: "protocol_challenge_expired"` so the
distinction survives in code.

**Exact typed refusal.** `protocol_challenge_expired` when the selected requirements
were advertised by this host but the host clock is past their validity;
`protocol_challenge_unknown` when they were never advertised by this host (or the
host restarted).

**Proving tests.** Host battery → "re-advertising the same 402 is idempotent and
refreshes the host expiry (a stale 402 becomes payable again)"; "a payment for
requirements that were never advertised refuses protocol_challenge_unknown". The
desktop real-runtime battery (`packages/desktop/test/payswap-protocol-runtime-wiring.test.ts`,
"protocol messages are handled through the real runtime …") proves the same
host-clock mechanism is wired through the real desktop assembly (its stale arm uses
MPP, whose challenge carries an explicit `expires`).

**P3 blocker?** **No.** The behavior is a labelled host policy.

---

## Surfaces outside the supported subset (added 2026-11-23)

These are not among the five spec-silent rows — the official documents do describe
them — but they are not pinned field-by-field in the register, so the message face
does not accept them. Each is **unavailable, not simulated**
(doc 12 §6: "Unsupported features are unavailable, not simulated as production
support").

| Surface | Official status at `b711fa9f` | Typed refusal | Proving test (x402 face battery) |
|---|---|---|---|
| `upto`, `batch-settlement`, `auth-capture` and any scheme other than `exact` | Listed in §6 ("including `exact`, `upto`, and `batch-settlement`"); payload wire not pinned | `protocol_feature_unsupported` | "payment payload selecting an unpinned scheme (upto) refuses …", "… (batch-settlement) …" |
| Non-EVM network families | CAIP-2 networks listed in §11.1; bindings not pinned | `protocol_feature_unsupported` | "payment payload selecting an unpinned network family (solana) refuses …" |
| EVM transfer methods `permit2` and `erc7710` | Described in `scheme_exact_evm.md` §2–§3; not pinned field-by-field | `protocol_feature_unsupported` | "… the Permit2 transfer method …", "… the ERC-7710 transfer method …" |
| Payment flows `upfront` and `escrow` | §6.1; PaySwap supports the default `authorization` flow only | `protocol_feature_unsupported` | "… a non-default payment flow (escrow) refuses …" |
| A wire `x402Version` other than `2` | §5.1.2 field table: "Protocol version identifier (must be 2)" | `protocol_message_unverifiable` (unknown shape; the version-specific code `protocol_version_unsupported` is reserved for an adapter pin that disagrees with the register) | "stale wire x402Version refuses …", "future wire x402Version refuses …" |

A `PaymentRequired` that *advertises* an unsupported entry is still structurally
valid: eligibility is not the message face's decision (P6), and
`evaluatePayswapX402RequirementSupport` is exported as the single implementation for
that later use — "a PaymentRequired advertising an unpinned entry stays structurally
valid (eligibility is not the message face's call)".

## Signature posture (cross-cutting; the condition on "not a blocker")

The addendum (§10), doc 12 (§6) and doc 05 (§13) require protocol adapters to verify
signature, identity, replay and expiry "according to that protocol". The x402 face
does **not** verify signatures at P3, and says so in its header. The requirement is
not waived:

- What verification would mean here is fixed by the spec — "Verify the signature is
  valid and recovers to the `authorization.from` address" — and is self-contained (the
  payer's own address is the key; no external trust anchor is needed).
- It is not implemented because it requires secp256k1 public-key recovery and
  keccak-256, and no audited dependency providing them is approved in this repository.
  Hand-rolled cryptography is not an acceptable substitute.
- Therefore, per the addendum's own closing sentence — "Integration remains disabled
  until its evidence and acceptance suite passes" — no x402 message is mapped into a
  PaySwap intent at P3, and the protocol host marks every consumed credential
  `"unverified"`. This is the sense in which the rows above are "not P3 blockers":
  P3 freezes the contract, the conformance suites and the host boundary, and leaves
  integration disabled.

**Explicitly not claimed at P3**

- That any x402 signature has been verified, or that any payer address is authentic.
- That any payment has settled. An inbound `SettlementResponse` is an untrusted
  proposal; a receipt can be emitted only from evidence issued by the host's
  evidence authority, and at P3 the production host has no issuer.
- That an authorization is still inside its validity window. The host uses
  `validBefore` only as the retention bound for the consumed-authorization record.
- Any capability for PaySwap to *construct* an x402 payment (a client role).

---

## Summary

| Row | P3 blocker? | Exact typed refusal | Encoded? |
|---|---|---|---|
| 1. EVM window ↔ `maxTimeoutSeconds` linkage | No | `protocol_message_unverifiable` (window structure only) | Structural check only; linkage not encoded |
| 2. Cross-scheme replay statement | No | `protocol_challenge_consumed` / `protocol_message_unverifiable` / `protocol_feature_unsupported` | Single-use on `(network, from, nonce)`; no cross-scheme claim |
| 3. Enforcement-actor assignment | No | n/a — the adapter does not enforce and never claims to | Not an enforcement actor |
| 4. `maxTimeoutSeconds` bounds | No | `protocol_message_unverifiable` (presence/type only) | Presence + positive integer; bounds are host policy |
| 5. Stale-402 server behavior | No | `protocol_challenge_expired` / `protocol_challenge_unknown` | Labelled host policy |

**Conclusion.** The five specification-silent rows do not block P3. The x402 message
face is a supported subset with explicit refusals — `exact` on `eip155:*` via
`eip3009` under the `authorization` flow — and it satisfies the canonical P3
acceptance criteria for positive, malformed, replay, stale-version and
signature-posture/refusal behavior *as a contract and conformance boundary*. It does
not satisfy them as an integration, because real signature verification does not
exist yet; integration stays disabled until it does.
