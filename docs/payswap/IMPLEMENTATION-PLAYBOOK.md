# PaySwap 4.0 — autonomous TDD implementation playbook

**Audience:** TL, architect, implementation workers and coding agents.  
**Normative relationship:** the canonical roadmap `docs/payswap/p0/10-roadmap.md` owns milestone order, scope, acceptance criteria and current status. The architecture addendum `docs/payswap/p0/11-architecture-addendum.md` owns binding architecture and security constraints. This playbook defines how to execute them; it cannot weaken or replace either.

## 1. Delegated authority: do not ask for the next phase

The product owner has delegated execution of the approved P1–P9 roadmap to the TL. The TL must not stop after a milestone to ask whether it may begin the next milestone. When the previous milestone's defined gates have passed and the evidence-bearing change is merged to `main`, the TL automatically starts the next milestone and updates the canonical status register.

This authority includes ordinary engineering decisions inside the approved scope: task decomposition, worker assignment, implementation details, test selection, refactoring, sequencing of independent tasks, and reversible design choices that respect the existing contracts. Record material decisions in a short ADR in the relevant module/spec; do not ask for approval merely because a new wave is beginning.

The delegation does **not** permit:
- Enabling live money movement or submitting real provider write operations.
- Using real customer/provider credentials, moving real funds, or changing a sandbox integration to live mode.
- Weakening authentication, authorization, peer verification, replay protection, ledger integrity, auditability or a fail-closed rule.
- Changing the P0 normative architecture or expanding the product scope in a way that conflicts with the approved roadmap.
- Irreversible production data migrations/deletion, or accepting a destructive compatibility break.
- Committing to new paid infrastructure/services or external financial/legal obligations not already authorized.

For these cases, stop the affected operation, keep the safe/test path available, document the blocker and evidence, and request the specific operator decision. Continue unrelated work that does not depend on the reserved decision. A security or architecture contradiction is a stop-and-record decision, not permission to improvise a weaker design.

## 2. Authority order and document ownership

| Question | Controlling artifact |
|---|---|
| What milestone comes next? What is in scope? What makes it complete? What is its status? | `docs/payswap/p0/10-roadmap.md` only |
| What architecture/security invariants are mandatory? | `docs/payswap/p0/11-architecture-addendum.md` |
| Where does a financial domain live and who owns its state? | `docs/payswap/p0/06-financial-architecture.md` plus the affected module contract |
| What is the provider interface and evidence requirement? | `docs/payswap/p0/05-provider-plugin-contract.md` |
| How must the team implement and prove a change? | This playbook, subordinate to the artifacts above |
| What code actually exists? | The merged source tree, package scripts, tests, migrations and CI runs—not plans, PR claims or agent summaries |

Do not create another P1–P9 roadmap, status dashboard or shadow acceptance matrix. Task boards and issues are allowed only as task-level execution aids with a link to the canonical milestone. A task board cannot independently mark a milestone complete.

## 3. Team operating model

The TL is accountable for integration, interfaces, dependency ordering, acceptance evidence, status updates and automatic advancement. Use three concurrent workers where parallel work is real:

- **Worker A — Trust/runtime:** broker, process identity, peer verification, sessions, server principals and authorization trust boundaries.
- **Worker B — Financial domain:** typed contracts, account/capability/eligibility/intent/routing domain logic, ledger and reconciliation foundations.
- **Worker C — Provider/product:** provider adapter contracts and sandbox conformance, New Task/UI integration, browser acceptance and evidence surfaces.

Workers may work concurrently only after the TL freezes the relevant interface, state owner, event ordering and test contract. Do not allow two workers to create writers for the same state, competing registries, alternative runtimes or overlapping provider execution paths. For dependencies that are not yet implemented, workers may produce research, specs, threat models and contract-first tests; do not prematurely enable downstream runtime behavior.

The TL keeps integration small and continuous: one concern per PR/commit series, short-lived branches, real upstream boundaries, and no giant end-of-phase merge. Every worker returns changed paths, contracts, tests, commands, actual output, commit SHA and known gaps.

## 4. Mandatory TDD loop — RED → GREEN → REFACTOR → PROVE

Every behavior change follows this sequence. A PR that implements behavior before its expected behavior and failure cases are specified is out of process.

### 4.1 Specify the behavior first

Before code, update the existing spec/contract that owns the behavior. State:
- User-visible behavior and explicit non-goals.
- The single owner of every mutable state item.
- Public interface/schema, error/refusal codes and side effects.
- Event order, authorization point, idempotency key, cancellation/expiry and recovery semantics where applicable.
- Positive, negative, boundary, concurrency/replay and failure/recovery scenarios.
- Which existing ZCode behavior must remain unchanged.

Use the existing P0 deliverables and module contracts; do not create duplicate feature specifications when an existing spec is authoritative.

### 4.2 RED — write and run the failing test before implementation

Write the narrowest test at the correct boundary. Run it against the current implementation and record:
- Exact test path and case name.
- Exact command.
- Expected failure showing the missing/incorrect behavior.
- Confirmation that the failure is an assertion about the intended behavior, not a broken fixture, missing dependency, bad environment or unrelated baseline failure.

For security changes, write the negative/bypass tests before the positive path. A test that passes before the implementation is not proof of the new behavior. If a reliable red test cannot be produced, explain why and create a reproducible harness before coding.

### 4.3 GREEN — smallest implementation that makes the test pass

Implement only enough behavior to satisfy the contract. Keep external side effects in host-owned services/adapters; domain decisions remain deterministic and testable. No provider write path may be introduced before P7. Do not expand scope to make a test easier.

### 4.4 REFACTOR — preserve the evidence

Refactor only after the red/green pair exists. Re-run the new test, then all directly affected tests. Keep the public contract stable unless the spec and decision record are intentionally updated. Remove dead branches and duplicated ownership rather than adding speculative fallback paths.

### 4.5 PROVE — integrate across the actual boundary

For cross-process, provider, browser, UI, storage, permissions or remote behavior, add an integration/E2E test through the real production boundary. Test adapters or deterministic local fakes may isolate an external dependency, but mocked-only tests cannot close a provider, broker, authorization, persistence or browser acceptance criterion. Use provider sandbox/test mode for provider integration; never place real secrets in fixtures, logs, screenshots or CI output.

## 5. Test selection rules for this repository

Follow root `AGENTS.md`, `docs/testing/unit-test-quality.md`, `docs/testing/pre-push-hook.md` and `apps/zcode-cli/AGENTS.md`. In particular, App business unit tests and module `contract.test.ts` files have been retired. **Do not add or restore them.** Use the repository's supported test classes:

1. **Pure financial rules:** schema/runtime validation, property-based or engineering tests in the approved engineering harness; test invariants and counterexamples, not implementation details.
2. **CLI/plugin/process behavior:** the owning CLI/package test entry points, real built artifacts and stdio/process tests.
3. **Cross-module host services/RPC/storage:** engineering integration tests through public contracts and the actual persistence/IPC boundary.
4. **UI/New Task behavior:** browser/E2E acceptance against the running application; include desktop and remote modes where the changed contract affects them.
5. **Native OS security:** platform-specific integration tests for Linux, macOS and Windows. A platform that cannot be executed in the current environment is explicitly unverified; a mock does not turn it green.
6. **Provider behavior:** contract conformance plus official sandbox/test-mode integration. Record the provider API/version, official documentation URL and retrieval date for capability/auth facts.

A phase gate is not green when a test was skipped, not collected, environment-blocked, marked todo, run only against a mock where a real boundary is required, or failed on a baseline. Baseline failures must be reproduced on the unmodified base commit and reported separately; they remain unresolved evidence, not passes.

## 6. Required risk-based test matrix

Every behavior change includes the applicable rows; financial/security/persistence work must address all relevant rows.

| Risk | Minimum proof |
|---|---|
| Input/schema | Valid input; malformed, missing, extra and boundary values; stable typed refusal |
| Identity/authorization | Unauthenticated, wrong principal, wrong role, cross-workspace, revoked/expired and forged caller |
| Money movement | No provider write on every refusal/bypass path; exact authorized tuple; changed tuple requires reauthorization |
| Duplicate/retry | Duplicate request, concurrent duplicate, retry after timeout, reconnect/replay and idempotency behavior |
| Async/remote | Ordering, cancellation, stale result, reconnect/resume, bounded queue/gap and timeout ownership |
| Persistence/ledger | Crash/restart, migration, corruption, hash-chain verification, single-writer fencing and restore |
| Provider | Capability read-back, country/currency/amount/product restriction, declined/refused response, timeout/unknown outcome, webhook duplication and reconciliation |
| UI/surfaces | Trusted origin, no data leakage, opt-out/disable/uninstall, renderer retention disposal and unchanged upstream controls |
| Platform | Linux/macOS/Windows behavior, permissions/ACLs, paths, process identity and helper lifecycle |
| Preservation | Relevant rows from the ZCode preservation matrix and regression battery; ordinary non-financial mode unchanged |

For P1, the P0 N1–N42 and T1–T7 identifiers are the governing security/transition matrix; do not replace them with a smaller locally invented list. For later milestones, the milestone section in the canonical roadmap is authoritative.

## 7. P1 execution breakdown — ordered work packages

PR #3 is only the initial Wave 1 plugin scaffold. It is not completion of P1. After that PR is merged, continue the work packages below without asking the user to authorize each one. Their detailed acceptance is already defined by P1 in the canonical roadmap and the N/T matrix in the addendum.

| Order | Work package | TDD-first emphasis | Dependency / exit |
|---|---|---|---|
| P1.0 | Official plugin scaffold and production host-launch path | Manifest/lifecycle, official seed, resolver, real CLI host dispatch, six tools, static Class-A surfaces and typed refusal tests | PR #3 merge; scaffold only |
| P1.1 | Broker protocol, host ownership and threat model | Contract schemas, caller trust assumptions, closed operation names, typed failures, trust-boundary negative tests | Before broker implementation |
| P1.2 | Trusted instance registration and per-instance credentials | Unknown instance, forged identity, credential substitution/rotation/revocation, endpoint replacement and private socket directory | P1.1 |
| P1.3 | OS peer verification | Impostor process, wrong PID/image, ACL/DACL and owner mismatch; Unix peer credentials; Windows native helper parent/process binding | P1.2; fail closed on all supported OSes |
| P1.4 | Closed six-operation dispatch and authoritative session binding | Unknown operation, malformed payload, cross-instance token, forged session/workspace, wrong role; no unregistered dispatch | P1.3 |
| P1.5 | Broker replay protection | Duplicate and concurrent requests; reconnect; out-of-order completion; contiguous watermark, retained completed sequences and bounded gap | P1.4; N19–N22, N33–N35, N39 |
| P1.6 | Server operator-principal model | Two-level /ws handshake; deployment credential vs operator credential; lifecycle, rotation/revocation, workspace role bindings and cross-user isolation | Contract may be prepared in parallel; integration depends on trusted session path |
| P1.7 | Transaction grants and trusted Class-B approval | Exact tuple/digest binding, single-use challenge, expiry, trusted renderer origin, model/plugin forgery, material-change reauthorization | P1.4 and P1.6 |
| P1.8 | Surface lifecycle, hook admission, Browser authorization and preservation | T1–T7, both arms of T7, S0a/S0b/S1/S2/S3, delta-equivalence, E1/E3, full ZCode regression battery | P1.7; complete N1–N42/T1–T7 and P1 acceptance |

Do not implement a shortcut broker that accepts token-only trust for money. Do not expose credentials to arbitrary plugin servers. Do not use user-controlled plugin identity, model arguments or renderer messages as authoritative identity. The authoritative principal/session must be resolved by the host/server.

## 8. TDD focus by later milestone

The following is an execution checklist, not a second definition of milestone scope. Use the corresponding acceptance section in the canonical roadmap as the release gate.

- **P2 — Stripe read-only vertical:** write Gate E2 tests first (fallback-derived PSP key refused; secure desktop/server storage required; stored secret cannot be decrypted with the old deterministic fallback). Then test real Stripe connection/onboarding in test mode, account read-back, evidence-backed capabilities and read-only operations. Assert that no write tool/operation is registered.
- **P3 — Paystack and PayPal:** run the P2 provider contract separately for each provider. Start with contract/refusal tests for the actual auth and recipient models. Re-verify every encoded auth/capability fact against current official documentation and record retrieval dates before implementing; never invent OAuth/recipient identifiers.
- **P4 — Registry, eligibility and intent:** test immutable/revisioned evidence snapshots, unknown/stale evidence, country/currency/method/amount/product/entitlement/purpose restrictions and typed refusals. Compiler tests must prove the model supplies drafts only and cannot assert eligibility or authorization. Use property tests for boundary combinations.
- **P5 — New Task workflow:** write browser journeys first for discover → plan → approve → sandbox execute → reconcile; negative paths include opt-out, no provider, insufficient capability, expired approval, changed transaction and remote workspace. Verify the preserved New Task composer and ZCode controls against the approved interaction design.
- **P6 — Route intelligence:** property-test the direct-route baseline, typed existing/conditional/opportunity taxonomy, fees/FX/deadline constraints, leg continuity and shared planner/executor validation. Assert that decomposition never changes purpose classification/eligibility (INV-30) and no unverified conditional/opportunity route is executable.
- **P7 — Execution, ledger and reconciliation:** test transaction-grant tuple mismatch, single-use/expiry, per-leg idempotency, partial failures, crash recovery, duplicate webhooks, timeout/unknown outcomes and no unsafe retry. Test append-only hash chain, restore verification, one-writer lease/fencing, stale holder rejection, owner-checked release and PostgreSQL/authenticated-principal activation requirements. Provider read-back—not API acceptance—closes settlement.
- **P8 — Surfaces and automation:** browser-test Class-A informational cards and host-only Class-B approval; test retention destruction on opt-out. Automations begin read-only. Dry-run the full acceptance suite in provider test mode; never infer live-money permission from P8 completion.
- **P9 — Wider network:** new providers must pass the same provider contract and evidence/re-verification process without changing shared financial semantics. Add one provider at a time behind capability conformance and security regression tests.

## 9. Phase exit, evidence and automatic advancement

For each milestone, the TL prepares an evidence record in the PR description (not a duplicate roadmap). It must include:
- Canonical milestone ID and the exact acceptance criteria being closed.
- Spec/contract paths changed before implementation.
- RED evidence: test path/case, command and expected pre-fix failure.
- GREEN evidence: implementation commit and exact passing test output.
- Integration/browser/provider-sandbox evidence where required.
- Full gate commands, CI workflow/run URL and exact tested head SHA.
- Tests skipped, not collected, environment-blocked or baseline-failing, with reproduction evidence and owner.
- Security N/T/E rows closed by exact test names and paths.
- Preservation/regression results and remaining risks.
- Confirmation that the canonical status register is updated in the same change.

**Advance automatically only when all are true:**
1. Every acceptance criterion in the canonical milestone section has source-backed evidence.
2. All required tests passed on the exact PR head; no relevant test is skipped or replaced by a mock-only proof.
3. Required security negative tests and ZCode preservation checks are green.
4. Required CI checks are green and the merge obeys branch protection.
5. The evidence-bearing change is merged to `main`.
6. The status row in `docs/payswap/p0/10-roadmap.md` is changed to `complete`, and the next milestone is changed to `in_progress` in the same merged change or immediate status-only follow-up.

The TL then starts the next milestone automatically. Do not wait for a user response or request permission to begin it. If a PR is ready but not yet merged, keep the milestone at `gate_passed` (or `in_progress` if any gate remains) and do not claim the dependent milestone is complete.

## 10. PR and implementation discipline

- Keep every PR scoped to a coherent contract or work package; include its test-first evidence.
- Update the existing spec before code. Update the canonical roadmap only for milestone status/acceptance changes; do not copy acceptance text into another tracker.
- Build the production path, not a second implementation of the same launcher, broker, credential store, registry or ledger.
- Preserve all unrelated local changes. Do not reset or rewrite shared refs to make a gate green.
- Pin the source commit, tool versions and provider documentation retrieval date when evidence depends on them.
- Redact credentials and financial/customer data from logs, artifacts, CI and screenshots.
- A successful typecheck, lint, unit/engineering test or mock integration cannot substitute for browser, provider, security, cross-platform or settlement acceptance that the roadmap explicitly requires.
- Report precisely what is implemented, what has passed, what has been skipped and what remains. Do not call a scaffold a milestone.

## 11. Definition of final product

The final product is achieved when P1–P9 are complete according to the canonical roadmap and the production release gates pass. This does not silently enable live money: the live-money activation remains a separately operator-controlled action after the complete provider, beneficiary, authorization, execution, ledger, recovery and reconciliation acceptance suite passes.
