# P1 Wave 2 — The Authenticated MCP→Host Broker Bridge

**Owner:** TL · **Branch:** `p4/p1-broker-contract` · **Base:** `main` @ `86a9ae53`
(the approved PR #3 merge) · **Status:** Wave 2 Step 1 delivered (this PR);
Steps 2–7 are implementation PRs gated on this contract's approval.

Wave 1 (PR #3, merged) landed the official plugin scaffold: manifest, the six
typed-refusal tools, Class-A surfaces, the `financialWorkspace` opt-in, the
architecture-module adoption, the direct-stdio and production-host launch
suites, CI, and branch protection. Wave 2 builds the bridge those tools will
actually call: the **host-owned broker** of addendum §3, hardened per §3.5.

## The architect's implementation sequence (binding)

Delivered in this exact order; no step starts before the previous step's PR is
approved and merged. No payment provider, live account data, or money movement
enters at any point in this wave — every operation behind the bridge stays
read-only or a typed refusal until P2+ gates open.

| Step | Deliverable | Status |
|---|---|---|
| 1 | **Host-owned broker contract and threat model** — this PR: `w2-01-broker-contract.md` (normative) + `w2-02-broker-threat-model.md` | **delivered here** |
| 2 | Trusted instance registration + per-instance credentials (contract §4, §10) | next |
| 3 | OS peer verification — Linux, macOS, Windows, fail-closed (contract §5) | queued |
| 4 | Closed six-operation dispatch table (contract §7) | queued |
| 5 | Server-side principal/session resolution + workspace isolation (contract §8) | queued |
| 6 | Replay protection — contiguous watermark + retained completed-request set (contract §9) | queued |
| 7 | Adversarial integration tests across the complete chain (contract §12, threat model §9) | queued |

## Files

- `w2-01-broker-contract.md` — the normative contract: transport, credentials,
  peer verification, message schemas, the closed dispatch table, session
  resolution, the replay algorithm, lifecycle, error taxonomy, acceptance
  criteria. Steps 2–7 implement sections of this document; each implementation
  PR names the sections it lands.
- `w2-02-broker-threat-model.md` — the companion threat model: assets, trust
  boundaries, the adversary classes A1–A9, attack trees with mapped
  mitigations, fail-closed rules, residual risks stated honestly, and the
  adversarial test plan that Step 7 executes.

## What Wave 2 does NOT contain (unchanged boundary)

No Stripe, Paystack, PayPal, live account data, or money movement. The six
operations remain typed refusals (`not_opted_in` / `not_connected`) except
where a later wave's P2+ gates open read-only provider data. The authorization
grant, the Class-B host-rendered card, and the server operator-principal model
are Waves 3–4, not this wave.
