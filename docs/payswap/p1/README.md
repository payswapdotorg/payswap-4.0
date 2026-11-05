# P1 Wave 2 — The Authenticated MCP→Host Broker Bridge

**Owner:** TL · **Branch:** `p4/p1-broker-contract` · **Base:** `main` (kept
current with the roadmap-governance merge) · **Status:** Wave 2 Step 1
delivered in **revision 2** (this PR); Steps 2–7 are implementation PRs
gated on the **TL's recorded checklist acceptance** of this contract
(`w2-03-broker-adrs.md`, acceptance record section) — per the implementation
playbook, in-scope phase transitions need no external sign-off.

Wave 1 (PR #3, merged) landed the official plugin scaffold: manifest, the six
typed-refusal tools, Class-A surfaces, the `financialWorkspace` opt-in, the
architecture-module adoption, the direct-stdio and production-host launch
suites, CI, and branch protection. Wave 2 builds the bridge those tools will
actually call: the **host-owned broker** of addendum §3, hardened per §3.5 —
and, from revision 2 on, **mutually authenticated**: the host proves which
process is calling (§4/§5), and every response proves it came from the
child's own host boot and answers that exact request (§6.4/§6.5).

## The architect's implementation sequence (binding)

Delivered in this exact order; no step starts before the previous step's PR
passes its acceptance and is merged. No payment provider, live account data,
or money movement enters at any point in this wave — every operation behind
the bridge stays read-only or a typed refusal until P2+ gates open.

| Step | Deliverable | Status |
|---|---|---|
| 1 | **Host-owned broker contract and threat model** — this PR: `w2-01-broker-contract.md` (normative, rev 2) + `w2-02-broker-threat-model.md` (rev 2) + `w2-03-broker-adrs.md` (ADRs + TL acceptance record) | **delivered here** |
| 2 | Trusted instance registration + per-instance credentials + the five-key tuple, host-boot Ed25519 keypair minting, public-key injection, shared canonicalization and envelope sign/verify modules (contract §4, §10, §6.5.1 — adversarial tests first, §12.1) | next |
| 3 | OS peer verification — Linux, macOS, Windows, fail-closed (contract §5) | queued |
| 4 | Closed six-operation dispatch table + the signed wire schemas exercised on the real path (contract §6, §7) | queued |
| 5 | Server-side principal/session resolution + workspace isolation (contract §8) | queued |
| 6 | Replay protection — contiguous watermark, retained completed-request set, frozen G = 64, allocation recovery + retirement declarations (contract §9) | queued |
| 7 | Adversarial integration tests across the complete chain, including every response-authentication row end-to-end (contract §12, threat model §9) | queued |

## Revision 2 (2026-11-05, architect review of this PR)

1. **Host-signed responses (ADR-1):** Ed25519 per-boot key pair; private key
   host-memory only; public key + host id trusted-injected (five-key tuple,
   all-or-nothing capture); versioned canonical envelope binding host id,
   instance id, seq, op, the exact request digest, and the complete response;
   child verifies everything, fails closed on any failure. This is Wave 2 /
   P1 work, not a P2 deferral.
2. **Frozen replay gap (ADR-2):** `G = 64` is a fixed v1 protocol constant
   with 64/65 boundary tests and the `|R| ≤ G` memory-bound proof; change
   only by ADR with measured evidence and a hard upper bound.
3. **Sequence-allocation recovery (ADR-2):** allocation only at the send
   boundary; uncertain delivery retains the sequence on retry; abandoned or
   definitely-unsent sequences close via bounded retirement declarations —
   no permanent gaps; explicit cancellation/connection-failure tests for
   both situations.
4. **Threat model corrected:** the rev-1 T4 claim that a fake broker cannot
   return an accepted response was wrong as specified; T4 is corrected, and
   T9 (response forgery, adversary D10) is the new tree that the
   response-authentication rows prove.
5. **Worker challenge (rev 2a):** an independent adversarial review of the
   revised documents found 1 blocker (a signed-refusal oracle via sibling
   relay of pre-binding refusals — fixed by request-attributed, never
   claim-echoed envelope bindings, §6.4(3)) and 4 majors (credential-currency
   validation in the launch assertion; retirement processing on gap-refused
   carriers; a requestDigest byte-range contradiction; the tool-env
   passthrough blocklist) — all accepted and dispositioned in the same
   revision; the full record is in `w2-03-broker-adrs.md`.

## Files

- `w2-01-broker-contract.md` — the normative contract (rev 2, amended 2a): transport,
  the five-key credential tuple, peer verification, the signed response
  envelope and response authentication, the closed dispatch table, session
  resolution, the replay algorithm with recovery semantics, lifecycle, error
  taxonomy, acceptance criteria, and the binding implementation order.
  Steps 2–7 implement sections of this document; each implementation PR
  names the sections it lands.
- `w2-02-broker-threat-model.md` — the companion threat model (rev 2):
  assets (A-1–A-7), trust boundaries, adversary classes D1–D10, attack trees
  T1–T9 with mapped mitigations, the eight fail-closed rules, residual risks
  stated honestly, and the adversarial test plan that Step 7 executes.
- `w2-03-broker-adrs.md` — ADR-1 (Ed25519 host-signed responses) and ADR-2
  (frozen G = 64 + sequence recovery), with rejected alternatives and the
  TL acceptance record for P1.1.

## What Wave 2 does NOT contain (unchanged boundary)

No Stripe, Paystack, PayPal, live account data, or money movement. The six
operations remain typed refusals (`not_opted_in` / `not_connected`) except
where a later wave's P2+ gates open read-only provider data. The
authorization grant, the Class-B host-rendered card, and the server
operator-principal model are **later P1 subwaves** — the playbook's P1.6 and
P1.7 work packages, sequenced after the broker steps — **not work deferred
beyond P1**. P1 remains open until those deliverables and the full N/T
acceptance battery (E1/E3 included) pass; a working broker alone does not
close the milestone.
