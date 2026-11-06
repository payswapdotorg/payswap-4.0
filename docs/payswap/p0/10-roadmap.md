# P0 Deliverable 10 — Roadmap with Explicit Acceptance Criteria


> **Canonical roadmap / single source of truth.** This file is the only authoritative definition of the PaySwap P1–P9 sequence, milestone scope, acceptance criteria and live delivery status. Do not create another roadmap, milestone checklist or parallel status register. The navigation page is [docs/payswap/README.md](../README.md); the subordinate implementation procedure is [IMPLEMENTATION-PLAYBOOK.md](../IMPLEMENTATION-PLAYBOOK.md); the normative architecture and security constraints are in [11-architecture-addendum.md](11-architecture-addendum.md). Those documents may explain how to work, but may not redefine milestone scope, ordering or acceptance.

**Owner:** TL · **Law:** prove the extension architecture with one Stripe vertical
before attempting every transactional feature across all providers. Live money
movement stays disabled until the complete provider, beneficiary, authorization
and reconciliation acceptance suite passes (operator-gated).

## Live delivery status — single authoritative register

This register is maintained **in this file only**. Update it in the same PR that proves a milestone gate. Issue trackers, PR descriptions, project boards, chat messages and dashboards may link here, but must not create competing status or acceptance records.

**Status vocabulary:** `not_started` = no implementation started; `in_progress` = implementation underway; `blocked` = a named dependency or gate is preventing work; `gate_passed` = all milestone acceptance evidence is green on the proposed head but not yet merged to `main`; `complete` = the evidence-bearing change is merged to `main`. A green build by itself never means a milestone is complete.

| Milestone | Status | Current evidence / next action |
|---|---|---|
| P0 — Architecture and preservation baseline | complete | P0 deliverables merged to `main` in [commit `26f8c695`](https://github.com/payswapdotorg/payswap-4.0/commit/26f8c695c762a68a28f7553f333e2c1ecb8a46ed). |
| P1 — Trusted ZCode extension and financial authorization | in_progress | P1.0 scaffold merged via [PR #3](https://github.com/payswapdotorg/payswap-4.0/pull/3) at commit `86a9ae53`. P1.1 broker contract/threat model merged via [PR #4](https://github.com/payswapdotorg/payswap-4.0/pull/4) at commit `9c237aed` (architect-reviewed, worker-challenged, TL-accepted; decisions in `docs/payswap/p1/w2-03-broker-adrs.md`). P1.2 (trusted instance registration + per-instance credentials, contract §4/§10/§6.5.1) merged via [PR #6](https://github.com/payswapdotorg/payswap-4.0/pull/6) at commit `19c5aa57` (RED `ea325dfa` → GREEN `dcfc3ef9`, module adoption `70cd6b30`; gates green on head `70cd6b30`; Step-2 module acceptance closed — production wiring tracked to Step 3+ by design, not silently dropped). P1.3 Linux arm (broker boot self-probe / UDS line protocol / OS peer verification / fail-closed, contract §3/§5, ADRs 3–6) merged via [PR #7](https://github.com/payswapdotorg/payswap-4.0/pull/7) at commit `6174198e` (RED `f5eef860` → GREEN `25278e1f`; gates green on head `c6929523`); the Windows native-helper arm (§5.3) remains outstanding. P1.4 Step 4 (closed six-operation dispatch + §6.1 strict request schema + §7.3 three-code law with live reads + the live spawn-chain wiring: lazy broker boot at trusted-config resolution, per-workspace stable five-key minting, process-observer instance registration/exit-tombstone, disable-time revocation, child-side context gate) merged via [PR #8](https://github.com/payswapdotorg/payswap-4.0/pull/8) at commit `c0f682d6` (RED `dfa9e1b6` → GREEN `28e150d0`; gates green on head `28e150d0`; ADR-5 D5.6 upgrade included: disable-tombstoned residual calls answer financial_mode_disabled; ADR-7 records the Step-4 as-built decisions). P1.5 Step 5 (§8 session resolution + workspace isolation: the fail-closed session-scope default, the §8.2 hint-narrows-never-widens law bound to the registration's sessionScope field, §8.3 entity-isolation port, and the wiring ports for both host faces — coordinator bind facade + protocol-face requireSession-pattern resolver + app-face single-session resolver) merged via [PR #9](https://github.com/payswapdotorg/payswap-4.0/pull/9) at commit `2c108cf1` (RED `8a5a45f2` → GREEN `9e634b8d`; gates green on head `5798c077`; ADR-8 records the as-built decisions). Wave-2 Step 6 (broker replay protection — the playbook's P1.5 work package, contract §9: the contiguous-watermark/retained-set seen-record engine with the frozen G=64 boundary rows and the per-step |R| ≤ G memory bound, §9.3(5) send-boundary allocation discipline with both delivery-situation rows, §9.3(6) retirement declarations with rev-2a carrier-fate independence plus the lying-retirement and wedge-recovery rows, N33/N34/N35/N39, the D8.1 no-burn boundary, and the disable-arm composition) merged via [PR #10](https://github.com/payswapdotorg/payswap-4.0/pull/10) at commit `f9fa8202` (RED `e11713dc` → GREEN `5ca30de2`; gates green on head `5ca30de2`; ADR-9 records the as-built decisions — D9.7 scopes the child-side bridge transport to Step 7). P1 remains incomplete: broker runtime Step 7 (complete-chain adversarial suite §12 — the child-side bridge client lands with it), the Windows §5.3 native-helper arm, operator-principal (P1.6), grants/Class-B card (P1.7), E1/E3 and N/T acceptance are outstanding. |
| P2 — Stripe read-only vertical | not_started | Starts after P1 is complete. Gate E2 must pass before any PSP secret is stored. |
| P3 — Paystack and PayPal | not_started | Starts after P2 is complete; provider-specific auth facts require dated official-source verification. |
| P4 — Capability registry, eligibility and intent compiler | not_started | Starts after P3 is complete. |
| P5 — Conversational New Task workflow | not_started | Starts after P4 is complete. |
| P6 — Deterministic multi-provider route intelligence | not_started | Starts after P5 is complete. |
| P7 — Execution, ledger and reconciliation | not_started | Starts after P6 is complete; live activation remains separately operator-gated. |
| P8 — Financial surfaces and automations | not_started | Starts after P7 is complete; live activation remains separately operator-gated. |
| P9 — Wider provider network and capability learning | not_started | Starts after P8 is complete. |

**Last reconciled:** 2026-11-06. The TL must update this register from actual merged Git state and CI evidence; never infer completion from a report or an unmerged branch.


## Wave plan

### P1 — Real ZCode plugin extension and PaySwap marketplace presence
**Scope:** the official PaySwap plugin (manifest, `mcpServers` with the six
`payswap_*` tools, `ui.surfaces` for the **informational** financial cards
only — Class A, addendum §1.6.0: route-plan, evidence, workspace panel;
authorization-styled declarations rejected at manifest validation, N25 — boolean
`userConfig` option `financialWorkspace` default `false`, the R3 opt-in path),
marketplace seeding via the official-plugin mechanism, the authenticated
MCP-to-host broker bridge (addendum §3 — node-repl-broker protocol discipline +
CUA trusted-injection discipline; **addendum §3.5 hardening:** per-process-instance
socket+token credentials, OS peer verification against the host-registered
instance table — Unix peer credentials, Windows native client-pid + pipe-DACL
helper on the C# `windows-browser-import-helper` model, **fail-closed where peer
identity cannot be established — no token-only fallback for money** — host-private
socket directory, endpoint replacement protection, **broker-instance replay
protection** — request identity (instance id, sequence number), dedupe at
broker-instance scope surviving connection changes, reject-before-dispatch
(§3.5.7); the native Windows peer-verification helper holding the pipe
endpoint, relaying only verified requests over its spawn-verified,
parent-pid-bound, token-authenticated channel (§3.5.8); the end-to-end
authenticated chain MCP child → OS peer verifier → host broker → registered
plugin instance → authoritative session (§3.5.9 — the replay algorithm is
the contiguous watermark with retained completed sequences and a bounded gap,
§3.5.7)), the server
**operator-principal model** (addendum §1.6.3 — per-operator credentials
distinct from the shared server token, server-resolved stable principals,
the two-level `/ws` credential handshake and operator-credential lifecycle
(items 7–8), workspace-scoped role bindings (item 9), server-side financial
roles, session expiry/revocation, cross-user
isolation), the
transaction-authorization grant mechanism with its refusal path and **trusted
approval origin** (addendum §1.3 + §1.6 — host-rendered authorization card on the
permission-prompt pattern with host-derived content, one-time challenge,
transaction-digest binding, sender verification — expected webContents,
expected main frame, trusted application origin — server-deployment auth
boundary),
Gate E1 (per-plugin hook admission in financial mode — the upgrade path the
source itself names), Gate E3 (controlled provider-authorization Browser flow —
allowlist, not blocklist), and the rpc/client relay engineering tests from
deliverable 08 §3.
**Acceptance:** plugin installs/enables/disables through the EXISTING plugin
lifecycle end-to-end (browser-verified); `payswap_*` tools register and the broker
bridge serves read-only queries end-to-end (Model → MCP tool → broker → host service,
addendum §3.2 sequence); **negative E2E rows N1–N9 green** (addendum §1.7 — every
bypass context refuses money ops with no provider write attempted); **approval-origin
and server-principal rows N13–N18 + N25–N32 + N40–N41 green** (forged renderer events,
card-content deviation, replayed challenges, plugin-webview and model-originated
approvals, manifest authorization-surface declarations, plugin-callback approval
attempts, unauthenticated server/client, cross-user resolution, expired/revoked
operator session, insufficient financial role, forged client operator id,
rotated-out/revoked operator credential at the handshake, cross-workspace role
use — all rejected); **broker rows N19–N22 + N33–N35 + N39 green** (impostor
config, cross-instance
token, closed dispatch, stale endpoint, replay on a new connection, replay after
reconnect, concurrent duplicate dispatch, and the replay of an out-of-order
request that completed before the missing lower sequence arrived — all rejected
before dispatch);
**transition tests T1–T7 green** (addendum §2.2 — enable, opt-in, opt-out, disable,
uninstall, settings-page-unchanged, and opt-out-with-live-surfaces host-side
revocation (§2.3 — both arms: future data delivery blocked **and**
already-rendered protected content disposed/replaced with renderer retention
cleared); S0a/S0b-vs-upstream proofs; **S1 delta-equivalence
against a control plugin** — the S1-vs-S0 delta equals the standard upstream
enabled-plugin delta set; S2 renders only Class-A `ui.surfaces[]`-declared surfaces
plus the host-rendered authorization card; S3 invariant intact); Gate E1 test green
(third-party hook blocked in financial mode, upstream behavior unchanged with
financial mode off); Gate E3 tests green and the Browser battery unchanged; full gate
battery green; the ten preservation traps from deliverable 02 §5 have their first two
(rpc, client relay) covered by engineering tests.

### P2 — Stripe read-only account connection and capability discovery (the vertical)
**Scope:** real Stripe authorization (API key / OAuth per deliverable 04), the
account service + credential storage upgrade (**Gate E2**, addendum §5.2 —
per-platform: desktop safeStorage, server secret-manager `ZCODE_CREDENTIAL_SECRET`,
fail-closed when neither is available; the deterministic fallback is never used for
`payswap:psp:*` keys), evidence-backed capability discovery, read-only operations
in conversation.
**Acceptance:** a real Stripe account connects via the platform shell with
credentials landing ONLY in the upgraded store — **Gate E2 acceptance:** connection
with only the fallback available refuses (typed error, E2E); at rest no PSP secret
is decryptable under the fallback-derived key; non-PSP `ICredentialService`
behavior unchanged; capabilities are answered from provider read-back evidence with
typed refusals where unconfigured; read-only ops (balances, payment objects,
customers, disputes…) run conversationally; NO write operation exists in the tool
surface yet; browser-verified connection/onboarding flow; battery green.

### P3 — Paystack and PayPal on the same contract, their real auth models
**Scope:** Paystack secret-key auth + recipient→transfer→reference→status
lifecycle; PayPal client-credential vs merchant-onboarding vs account-consent
distinction; verified recipients only.
**Acceptance:** the P2 acceptance contract re-run per provider; **every deliverable
04 fact that P3 encodes is re-verified against live official provider documentation
with retrieval dates recorded** (the dated-evidence discipline of deliverable 05 §4
applies to the auth models themselves); no invented OAuth, recipient codes, or
email addresses — the typed refusals appear instead; battery green.

### P4 — Capability registry, eligibility, and the financial intent compiler
**Acceptance:** capability registry answers eligibility queries with real
country/currency/method/amount/product/entitlement/purpose restrictions from
evidence; the intent compiler turns natural-language financial asks into typed
intents (with refusals, never guesses); property/engineering tests over both;
battery green.

### P5 — Conversational financial operations in the original New Task interface
**Acceptance:** the deliverable 07 acceptance look works end-to-end
browser-verified — discover, plan, approve, execute (sandbox/test mode only),
reconcile — all inside the unchanged New Task experience; the New Task zero-diff
proof still green.

### P6 — Deterministic multi-provider route intelligence
**Acceptance:** direct-route baseline always computed first; existing/conditional/
opportunity routes are distinct typed results; conditional/opportunity NEVER
labelled executable until requirements verified satisfied; the no-bypass battery
(INV-30: decomposition never changes purpose classification/eligibility — carried
from PaySwap 3.0) machine-asserted; shared leg-validation structurally binds
planner to executor (deliverable 06); property tests green.

### P7 — Execution authority, provider operations, and reconciliation
**Scope:** the full authorization-tuple binding (principal, source account,
verified recipient, amount, currency, purpose, full route+legs, max fees, FX
conditions, provider operations, expiry; material changes re-authorize — the
addendum §1.3 grant, single-use, host-minted only); the multi-leg saga with
per-leg idempotency, partial-failure handling, recovery, reconciliation; webhook
ingress (additive server route); unknown outcomes never auto-retried when
duplication is possible; append-only ledger under the addendum §4 authority model
(one authoritative host per deployment — under the **fenced lease**, addendum
§4.6: a fencing generation persisted in the ledger, incremented on every
acquisition, validated at the repository write boundary, **and an owner-checked
release** — the upstream lock's pid + instance id + nonce ownership check
(`channelRuntime.ts:220-232`) preserved with the fencing generation added, so a
stale holder cannot delete a successor's lock — with the SQLite server
topology requiring one **explicitly configured** authoritative instance per
logical ledger/workspace; server topology moves authority to the server host;
hosted multi-user requires the PostgreSQL-ledger + authenticated principals
decision **at this wave's live-gate review**).
**Acceptance:** saga/execution property tests; **negative E2E rows N10–N12 green**
(tuple-deviation, single-use, expiry refusals — addendum §1.7); **ledger rows
N23–N24 + N36–N38 + N42 green** (second host process against one SQLite ledger refuses
within the boot budget under the fenced lease-based authority lock — typed
`ledger_authority_unavailable`, no financial services; crash arm: no takeover
before lease TTL, and chain verification runs before the first post-takeover
write; replica write rejected at the repository; fencing arms — the stale
holder's post-takeover write refuses typed `ledger_authority_lost` with the hash
chain unaffected, simultaneous acquisition produces exactly one winner with the
generation incremented exactly once, a write presenting a stale generation
refuses inside the write transaction, and the stale holder's attempt to release
or delete the successor's lock is a no-op under the owner/nonce/generation
check — addendum §4.6); reconciliation closes the
loop against provider
read-back; the unknown-outcome law machine-asserted; ledger hash-chain
verification test; **chain-verified restore** (addendum §4.4 — a restored ledger
loads only after chain verification passes); battery green. **Live money movement
remains operator-gated off, and hosted multi-user or horizontally scaled
deployments refuse financial activation until the central PostgreSQL ledger
and authenticated principals are in place** (addendum §4.6 — activation-time
refusal, a hard precondition, not a recommendation).

### P8 — UI Plugins, financial operations surfaces, and automations
**Acceptance:** the financial workspace toggle and Class-A informational cards
(route plans, evidence, workspace panel) on the sanctioned UI Plugin surfaces —
the authorization card remains host-rendered in every wave (addendum §1.6.0);
automations over read-only financial events; the complete
provider/beneficiary/authorization/reconciliation acceptance suite drafted and
dry-run in test mode — the gate P7+ must pass before live activation.

### P9 — Wider PSP network and provider capability learning
**Acceptance:** the provider research tooling (dated evidence files) feeds the
registry; new providers join via the deliverable 05 contract without financial-
layer semantic changes; per-provider acceptance = the P3 contract.

## Cross-wave invariants (checked every wave)

The governing invariant (every ZCode capability preserved — deliverable 02 matrix
maintained), the AML law (INV-30), model-never-authorizes, API-acceptance-is-not-
settlement, unknown-no-retry, evidence-or-refusal, and honest reporting of every
gate result (real output, never claims).


## Execution authority and autonomous phase advancement

The TL is authorized to plan, implement, test, integrate and advance through P1–P9 without requesting user approval for each next milestone or wave. This delegation is part of the approved roadmap. The TL must follow [IMPLEMENTATION-PLAYBOOK.md](../IMPLEMENTATION-PLAYBOOK.md), preserve the acceptance criteria above, and update this file's status register with evidence.

A milestone may be marked `gate_passed` only when every acceptance criterion in its section is backed by committed tests and reproducible evidence on the exact PR head. It becomes `complete` only after that evidence-bearing change is merged into `main` under the repository's normal branch protections. Once a milestone is complete, the TL automatically starts the next milestone; no additional user confirmation is required. The same rule applies to ordered sub-waves inside P1.

This delegation does **not** authorize bypassing branch protections, fabricating test evidence, weakening an acceptance criterion, changing the normative architecture, or enabling real-money operations. The hard-stop cases and reserved operator decisions are defined in the implementation playbook. No phase transition can override the live-money gate above or the architecture addendum.
