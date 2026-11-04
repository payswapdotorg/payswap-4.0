# P0 Deliverable 10 — Roadmap with Explicit Acceptance Criteria

**Owner:** TL · **Law:** prove the extension architecture with one Stripe vertical
before attempting every transactional feature across all providers. Live money
movement stays disabled until the complete provider, beneficiary, authorization
and reconciliation acceptance suite passes (operator-gated).

## Wave plan

### P1 — Real ZCode plugin extension and PaySwap marketplace presence
**Scope:** the official PaySwap plugin (manifest, `mcpServers` with the six
`payswap_*` tools, `ui.surfaces` for the financial cards, boolean `userConfig`
option `financialWorkspace` default `false` — the R3 opt-in path), marketplace
seeding via the official-plugin mechanism, the authenticated MCP-to-host broker
bridge (addendum §3 — CUA/node-repl-broker pattern reuse: trusted-snapshot
credential injection, host-verified plugin authority, narrow typed RPC surface;
**addendum §3.5 hardening:** per-process-instance credentials, OS peer
verification against the host-registered instance table, socket/pipe filesystem
restrictions, Windows pipe ACLs, endpoint replacement protection, request-id
replay dedupe), the transaction-authorization grant mechanism with its refusal
path and **trusted approval origin** (addendum §1.3 + §1.6 — host-controlled
surface, one-time challenge, transaction-digest binding, sender verification),
Gate E1 (per-plugin hook admission in financial mode — the upgrade path the
source itself names), Gate E3 (controlled provider-authorization Browser flow —
allowlist, not blocklist), and the rpc/client relay engineering tests from
deliverable 08 §3.
**Acceptance:** plugin installs/enables/disables through the EXISTING plugin
lifecycle end-to-end (browser-verified); `payswap_*` tools register and the broker
bridge serves read-only queries end-to-end (Model → MCP tool → broker → host service,
addendum §3.2 sequence); **negative E2E rows N1–N9 green** (addendum §1.7 — every
bypass context refuses money ops with no provider write attempted); **approval-origin
rows N13–N18 green** (forged renderer events, card tampering, replayed challenges,
plugin-webview and model-originated approvals all rejected); **broker rows N19–N22
green** (impostor config, cross-instance token, closed dispatch, stale endpoint);
**transition tests T1–T6 green** (addendum §2.2 — enable, opt-in, opt-out, disable,
uninstall, settings-page-unchanged; S0-vs-upstream and S1-vs-S0 rendered-surface
zero-diff proofs; S2 renders only `ui.surfaces[]`-declared surfaces; S3 invariant
intact); Gate E1 test green (third-party hook blocked in financial mode,
upstream behavior unchanged with financial mode off); Gate E3 tests green and the
Browser battery unchanged; full gate battery green; the ten preservation traps from
deliverable 02 §5 have their first two (rpc, client relay) covered by engineering
tests.

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
(one authoritative host per deployment; server topology moves authority to the
server host; hosted multi-user requires the PostgreSQL-ledger + authenticated
principals decision **at this wave's live-gate review**).
**Acceptance:** saga/execution property tests; **negative E2E rows N10–N12 green**
(tuple-deviation, single-use, expiry refusals — addendum §1.7); **ledger rows
N23–N24 green** (second host process against one SQLite ledger refuses to start
financial services — the single-writer lock holds; replica write rejected at the
repository — addendum §4.6); reconciliation closes the loop against provider
read-back; the unknown-outcome law machine-asserted; ledger hash-chain
verification test; **chain-verified restore** (addendum §4.4 — a restored ledger
loads only after chain verification passes); battery green. **Live money movement
remains operator-gated off, and hosted multi-user or horizontally scaled
deployments remain blocked from live financial operations until the central
PostgreSQL ledger and authenticated principals are in place (addendum §4.6 —
hard precondition, not a recommendation).**

### P8 — UI Plugins, financial operations surfaces, and automations
**Acceptance:** the financial workspace toggle and cards on the sanctioned UI
Plugin surfaces; automations over read-only financial events; the complete
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
