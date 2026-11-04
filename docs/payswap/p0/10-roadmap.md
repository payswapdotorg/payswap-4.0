# P0 Deliverable 10 — Roadmap with Explicit Acceptance Criteria

**Owner:** TL · **Law:** prove the extension architecture with one Stripe vertical
before attempting every transactional feature across all providers. Live money
movement stays disabled until the complete provider, beneficiary, authorization
and reconciliation acceptance suite passes (operator-gated).

## Wave plan

### P1 — Real ZCode plugin extension and PaySwap marketplace presence
**Scope:** the official PaySwap plugin (manifest, `mcpServers` with the six
`payswap_*` tools, `ui.surfaces` for the financial cards), marketplace seeding via
the official-plugin mechanism, the P1 hardening set (always-ask money tools, PSP
domain denylist, rpc/client relay engineering tests from deliverable 08 §3).
**Acceptance:** plugin installs/enables/disables through the EXISTING plugin
lifecycle end-to-end (browser-verified); `payswap_*` tools register and every one
is approval-gated (E2E proof, including under accept-edits/yolo); a New Task
zero-diff proof (the rendered surface set unchanged with the plugin on vs. off);
full gate battery green; the ten preservation traps from deliverable 02 §5 have
their first two (rpc, client relay) covered by engineering tests.

### P2 — Stripe read-only account connection and capability discovery (the vertical)
**Scope:** real Stripe authorization (API key / OAuth per deliverable 04), the
account service + credential storage upgrade (safeStorage-backed cipher — the P2
gate from deliverable 09), evidence-backed capability discovery, read-only
operations in conversation.
**Acceptance:** a real Stripe account connects via the platform shell with
credentials landing ONLY in the upgraded `ICredentialService` (verified: no
plaintext at rest, nothing in logs/chat/model context); capabilities are answered
from provider read-back evidence with typed refusals where unconfigured;
read-only ops (balances, payment objects, customers, disputes…) run
conversationally with approval gating; NO write operation exists in the tool
surface yet; browser-verified connection/onboarding flow; battery green.

### P3 — Paystack and PayPal on the same contract, their real auth models
**Scope:** Paystack secret-key auth + recipient→transfer→reference→status
lifecycle; PayPal client-credential vs merchant-onboarding vs account-consent
distinction; verified recipients only.
**Acceptance:** the P2 acceptance contract re-run per provider; each provider's
auth model verified against live docs (re-verification of every deliverable 04
fact that P3 encodes, with retrieval dates recorded); no invented OAuth, recipient
codes, or email addresses — the typed refusals appear instead; battery green.

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
**Scope:** the full authorization tuple binding (principal, source account,
verified recipient, amount, currency, purpose, full route+legs, max fees, FX
conditions, provider operations, expiry; material changes re-authorize); the
multi-leg saga with per-leg idempotency, partial-failure handling, recovery,
reconciliation; webhook ingress (additive server route); unknown outcomes never
auto-retried when duplication is possible; append-only ledger.
**Acceptance:** saga/execution property tests; reconciliation closes the loop
against provider read-back; the unknown-outcome law machine-asserted; ledger
hash-chain verification test; battery green. **Live money movement remains
operator-gated off.**

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
