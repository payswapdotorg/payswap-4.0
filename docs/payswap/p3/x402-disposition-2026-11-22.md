# x402 five-row disposition — 2026-11-22

The canonical x402 fact register (protocol-facts.ts) pins the wire schemas,
facilitator semantics, transport rules and nine wire behaviors (fourth-pass
retrieval, 2026-11-22). Five specification-silent rows remain. This document
provides the row-by-row disposition required by the handoff (§3 P3-B): for each
row, what the official specification actually says, whether the behavior is
supported/implemented/silent, the exact typed refusal, and whether the gap is a
P3 blocker or an explicitly unsupported capability for the Windows MVP.

---

## Row 1 — EVM validAfter/validBefore ↔ maxTimeoutSeconds linkage

**Official specification**: The core v2 spec (specs/x402-specification-v2.md)
defines `validAfter` and `validBefore` as EIP-3009 authorization parameters
inside the `authorization` object of the exact-EVM payment payload. It does
NOT document how the server or facilitator enforces the validity window, nor
does it link `maxTimeoutSeconds` to `validBefore`.

**SDK evidence (non-normative)**: The x402-fetch SDK sets
`validBefore = now + maxTimeoutSeconds` before signing. The facilitator SDK
checks the window during verification. This is implementation behavior, not
normative specification.

**Disposition**: The window enforcement is a **facilitator-side or
server-side execution concern**, not a PaySwap message-face concern. PaySwap's
x402 adapter validates the STRUCTURE of the payment payload (field presence,
types, addresses) but does not execute payments or enforce authorization
windows on-chain. The adapter can verify that `validAfter` < `validBefore`
structurally and refuse otherwise (a cheap structural check). The deeper
enforcement (on-chain window check, nonce consumption) belongs to the
facilitator/verifier, which PaySwap does not own.

**P3 blocker**: No. The adapter's message face can validate payload structure
without enforcing on-chain windows. The unverifiable enforcement semantics
are explicitly outside PaySwap's authority boundary (addendum §10: protocol
adapters are not executors).

**Typed refusal**: If the adapter receives a payload with `validAfter` ≥
`validBefore`, it refuses `protocol_message_unverifiable` (malformed
authorization window).

---

## Row 2 — Core cross-scheme replay statement

**Official specification**: The core v2 spec §10.1 (Security Considerations)
documents replay prevention ONLY for EIP-3009/EVM (the `nonce` field is
"32-byte random nonce to prevent replay attacks"). No cross-scheme replay
guarantee is stated for `upto`, `batch-settlement`, or non-EVM schemes.

**SDK evidence**: The EVM SDK maintains a consumed-nonce set per token
contract. The SVM SDK maintains a consumed-`requestId` set. These are
per-scheme implementation details.

**Disposition**: The absence of a cross-scheme replay statement means PaySwap
cannot make a general "replay-safe" claim across schemes. Each scheme's
replay behavior must be individually verified. For the message face, the
adapter validates payload STRUCTURE (field presence, format) but does not
enforce nonce consumption (that's the facilitator/server). The adapter can
structurally reject payloads with missing or empty nonce fields.

**P3 blocker**: No. The message face validates structure without claiming
replay safety. The facilitator/server replay enforcement is outside PaySwap's
authority boundary. The five spec-silent items are recorded as explicit
limitations, not fabricated as verified.

**Typed refusal**: If the adapter receives a payment payload with a missing
or empty nonce field (for EVM exact), it refuses
`protocol_message_unverifiable` (the nonce is REQUIRED and its absence means
replay cannot be prevented).

---

## Row 3 — Core enforcement-actor assignment

**Official specification**: The core v2 spec defines the facilitator role
("The server verifies and settles the payment independently, or by leveraging
an x402 facilitator's /verify and /settle endpoints") and states the
facilitator "does not hold funds or act as a custodian." However, the spec
does not explicitly assign WHICH party (server, facilitator, client) MUST
perform each specific verification step (signature check, nonce consumption,
window enforcement, etc.).

**SDK evidence**: The SDK's facilitator implementation performs signature
verification, nonce consumption, and window checks. This is implementation,
not specification.

**Disposition**: The enforcement-actor assignment is deliberately left to
implementations. PaySwap's adapter does not implement on-chain enforcement
or act as a facilitator. The adapter validates the STRUCTURE of messages it
receives and emits, and the host decides which messages to accept based on
its own verification logic (which lives outside the adapter, per addendum
§10).

**P3 blocker**: No. The message face validates structure without claiming to
be the enforcement actor. The enforcement role is outside PaySwap's
authority boundary.

**Typed refusal**: Not applicable — the adapter doesn't enforce; it validates
structure. The host's verification logic is outside the adapter boundary.

---

## Row 4 — maxTimeoutSeconds bounds

**Official specification**: The core v2 spec defines `maxTimeoutSeconds` as a
REQUIRED field in PaymentRequirements (a number). No bounds (minimum,
maximum) are documented in the core spec or in any scheme binding (EVM, SVM,
Starknet, Stellar).

**SDK evidence**: The SDK uses the field to set transaction timeouts but
does not enforce bounds.

**Disposition**: Without documented bounds, the adapter cannot validate
whether a `maxTimeoutSeconds` value is "reasonable." The adapter validates
that the field is present and is a positive number (structural check). The
host decides whether a specific timeout value is acceptable for its
integration.

**P3 blocker**: No. The message face validates field presence and type. The
bounds policy is a host-side integration decision, not a protocol
specification constraint.

**Typed refusal**: If `maxTimeoutSeconds` is missing, not a number, or ≤ 0,
the adapter refuses `protocol_message_unverifiable` (REQUIRED positive
number per the pinned schema).

---

## Row 5 — Stale-402 server behavior

**Official specification**: The HTTP transport spec defines the status-code
mapping table (402 for "Payment Required" and "Payment Failed", 400 for
"Invalid Payment", 500 for "Server Error", 200 for "Success"). It does not
document what a server should do when a previously-issued 402 challenge has
expired and a client retries with a stale challenge.

**SDK evidence**: The SDK's facilitator returns `payment-expired` as the
errorReason and the server re-issues a fresh 402 with a new challenge.

**Disposition**: The stale-402 behavior is a server implementation choice,
not a protocol specification requirement. PaySwap's adapter validates
STRUCTURE; the host decides whether to re-issue a challenge on stale-402.

**P3 blocker**: No. The message face validates challenge/receipt structure.
The server-side challenge lifecycle (issue → expire → re-issue) is outside
PaySwap's adapter authority boundary.

**Typed refusal**: If the adapter receives a payment payload whose
`accepted.x402Version` does not match the pinned version (2), it refuses
`protocol_message_unverifiable` (fail-closed on unknown versions per doc 12
§6). Stale-402 handling is a host concern, not an adapter concern.

---

## Summary

| Row | P3 blocker? | Rationale |
|---|---|---|
| EVM window linkage | No | Structural validation sufficient; enforcement is facilitator-side (outside authority) |
| Cross-scheme replay | No | Structural validation sufficient; no cross-scheme claim needed |
| Enforcement actor | No | Adapter validates structure, does not enforce |
| maxTimeoutSeconds bounds | No | Field presence + positive number check sufficient; bounds policy is host-side |
| Stale-402 behavior | No | Challenge lifecycle is host-side; adapter validates structure |

**Conclusion**: The five spec-silent rows do NOT block the x402 message-face
implementation. The adapter can implement a **supported subset** (structural
validation of the pinned wire schemas + typed refusals for malformed/unknown
shapes) without fabricating any of the unverifiable semantics. The x402 face
can be law-unblocked by explicitly recording these five rows as "unsupported
capabilities with typed refusals" in the reverify list, changing the list's
semantic from "implementation blocked" to "explicitly unsupported for this
MVP."
