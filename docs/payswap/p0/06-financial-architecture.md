# PaySwap P0 — Financial Architecture & Dependency Graph

**Worker:** P0-W3 (audit/architecture) · **Recorded:** 2026-11 · **Status:** design input, not implementation permission

## 1. Layering principle

PaySwap 4.0 is ZCode (agent harness) + an **additive financial layer**. Two layers, one application:

- **ZCode layer stays semantically untouched.** Model providers (`packages/provider`, `packages/provider-node`, `packages/model-option-map`, `packages/services/src/model-provider/`) are LLM providers and remain exactly that. PaySwap never modifies the model-provider runtime, the agent process model, or the session/protocol semantics.
- **The model is an orchestrator, never a financial authority.** It proposes, asks, and narrates; deterministic host-side code validates, routes, authorizes, executes, and records.
- **No duplicate runtimes, no duplicate state owners.** Every new piece of state has exactly one writer; every new service rides the existing service/RPC/plugin surfaces (AGENTS.md: 避免重复状态和多条写入路径).

Everything below maps the thirteen financial domains onto actual upstream package boundaries verified at `a9fe401`.

### 1.1 Package boundary map (summary)

| # | Domain | Owning location | Kind |
|---|---|---|---|
| 1 | Financial contracts | `packages/shared/src/payswap/` (additive) | Protocol types (zod), no runtime |
| 2 | PSP account & credential management | `packages/services/src/payswap/accounts/` (additive host service) | Service; secrets ONLY via existing `ICredentialService` |
| 3 | Evidence-backed capability registry | **new pure package** `packages/payswap-provider` | Pure domain (mirrors `packages/provider`'s role), + evidence collection service under `packages/services/src/payswap/capabilities/` |
| 4 | NL financial intent compiler | `packages/services/src/payswap/intent/` + `payswap_compile_intent` MCP tool | Deterministic compiler; model supplies drafts only |
| 5 | Eligibility & policy validation | `packages/services/src/payswap/eligibility/` | Pure validation shared by planner & executor |
| 6 | FX & liquidity intelligence | `packages/services/src/payswap/fx/` | Read-only intelligence, evidence-stamped |
| 7 | Deterministic route discovery | `packages/services/src/payswap/routing/` | Pure function over evidence; direct-route baseline first |
| 8 | Financial execution authority | `packages/services/src/payswap/execution/` | The ONLY submitter of provider write operations |
| 9 | Provider runtime | `packages/services/src/payswap/providers/<providerId>/` | First-party in-process adapters (contract: doc 05) |
| 10 | Webhook/event processing | `packages/services/src/payswap/events/` (+ additive `/webhooks/payswap/…` route in `packages/server` for web deployments) | Ingress, verification, dedupe, dispatch |
| 11 | Reconciliation | `packages/services/src/payswap/reconciliation/` | Read-only matcher; raises exceptions; confirms settlement |
| 12 | Append-only financial evidence ledger | `packages/services/src/payswap/ledger/` | node:sqlite DB, append-only, hash-chained, single writer |
| 13 | Provider research tooling | `docs/payswap/provider-facts/` + `apps/zcode-cli/tools/payswap-provider-research/` (additive CLI) | Evidence-stamped fact sheets + re-verification harness |

All `packages/services/src/payswap/**` services register additively in `IServiceAccessor` (`packages/services/src/accessor.ts`) and over `ServiceChannels` (`packages/shared/src/channels.ts`) — new channel names, no edits to existing channel semantics. UI consumes them exclusively via `packages/ui/src/hooks/` (additive `usePaySwap*` hooks), storing projections in one additive Zustand store (`packages/ui/src/store/payswapStore.ts`). The model-facing surface is one official plugin (`payswap@zcode-plugins-official` pattern, cf. `computer-use@zcode-plugins-official` in `packages/shared/src/mcp.ts`) exposing the narrow toolset of doc 05 §9.

---

## 2. Domain details

### 2.1 Financial contracts — `packages/shared/src/payswap/`

**Why here:** every layer (renderer, host services, agent runtime, adapters) must speak one typed vocabulary. Upstream precedent: `packages/shared/src/zcode-protocol/index.ts` is the single zod-validated protocol for the agent surface; `packages/shared/src/mcp.ts` for MCP config. PaySwap contracts are the financial equivalent: pure types + zod schemas + digest helpers, **no runtime, no I/O**.

Key types (illustrative):

```ts
interface FinancialIntent {
  intentId: string;                     // UUIDv7
  kind: "send" | "collect" | "refund" | "convert" | "sweep" | "review";
  source: AccountRef;                   // connectionId + providerAccountId
  recipient: VerifiedRecipientRef;      // provider-verified only (doc 04 §3.3)
  amount: Money;                        // { value: decimal-string, currency: ISO-4217 }
  purpose: PurposeCode;                 // typed + free text
  constraints: { maxFees?: Money; deadline?: string; fxToleranceBps?: number };
}

interface Route {
  routeId: string; intentId: string;
  basis: "existing" | "conditional" | "opportunity";
  baseline: boolean;                    // the direct route is always present & first
  legs: readonly Leg[];
  estimate: { fees: Money; fx: readonly FxQuoteRef[]; eta: string };
  preconditions: readonly RoutePrecondition[];   // for conditional routes
}

interface Leg {
  legId: string;
  providerId: string; operation: PayswapOperationId;
  debit: Money; credit: Money;
  idempotencyKey: string;               // allocated at validation; immutable
  maxFee: Money;
  fxCondition?: { quoteId: string; rate: string; maxSlippageBps: number; expiresAt: string };
}
```

Decimal money is **always a string** in contracts (Paystack subunits, float hazard — doc 04 §2.5); conversion happens only inside adapters.

### 2.2 PSP account & credential management — `packages/services/src/payswap/accounts/`

**Why here:** account/connection lifecycle is a host service, following `packages/services/src/model-provider/`'s role for model providers (account provider credential key/store/service files there are the direct precedent).

- **State:** connection records (non-secret metadata: provider, mode test/live, display name, status, capability-record pointer). **Secrets never live here** — they go to `ICredentialService` under `payswap:psp:<providerId>:<connectionId>:<secretKind>` keys (the only secret store; `packages/services/src/credential/credentialService.ts` — AES-256-GCM, file-locked, corrupt-refuse-overwrite).
- **Single writer:** the account service. UI reads via hooks; adapters read secrets only inside the host process.
- **Interfaces:** `connect(operatorSecret | oauthStart)`, `refreshEvidence(connectionId)`, `revoke(connectionId)`, `listConnections()` — exposed over an additive RPC channel.
- **Known gap filled additively:** plugin `userConfig.sensitive` has no secure store today (doc 05 §1); PaySwap credentials bypass plugin userConfig entirely.

### 2.3 Evidence-backed capability registry — new pure package `packages/payswap-provider`

**Why a new pure package:** it mirrors `packages/provider`'s architectural role (pure domain: immutable revisioned registry, frozen views, `onDidChange`, fail-closed snapshot patterns — `packages/provider/src/registry.ts`, `sources.ts`) without touching that package. It is a **new domain** (payment capabilities), not a second model registry.

- **State:** the registry instance is owned by a host service (`packages/services/src/payswap/capabilities/`) which collects evidence by invoking adapters' evidence operations and persists each raw read-back as a ledger evidence record (doc 05 §4).
- **Invariants:** capability records are immutable, evidence-referenced, schema-versioned; a record without evidence cannot claim an operation `enabled`.
- **Interfaces:** `snapshot(connectionId)`, `onDidChange`, `quarantine(adapterId, reason)` (fail-closed precedent: `createFailClosedAccountProviderConfigSnapshot`).

### 2.4 NL financial intent compiler — `packages/services/src/payswap/intent/`

**The boundary:** natural-language *understanding* is the model's job; financial *semantics* are deterministic code. The model calls the `payswap_compile_intent` MCP tool with a **draft** structured intent; the compiler service validates it against contracts + account evidence + verified-recipient registry and returns either a typed `FinancialIntent` or typed clarification requests (surfaced through the existing elicitation surfaces — `ElicitationDialog.tsx` in `packages/ui`, `zcodeUserInputRequested` protocol events).

- **State:** none of its own — output intents are appended to the ledger by the intent service (single writer = ledger).
- **Never:** the model never fabricates routes, legs, amounts post-approval, or authorization.

### 2.5 Eligibility & policy validation — `packages/services/src/payswap/eligibility/`

- **Single source of "is this leg allowed":** `validateLegForSubmission(leg, capabilitySnapshot, policy, connectionState) → LegValidation` is **the same function** used by route discovery (as a filter) and by the execution authority (as a submit precondition). *A planner can therefore never propose a leg the executor won't submit* — except when evidence goes stale between plan and submit, in which case the executor refuses typed `policy_blocked: evidence_stale` and the route re-derives. That drift path is explicit, typed, and operator-visible.
- **Policy:** operator policy (per-connection operation enables, live gate state, amount ceilings, purpose allowlists) is ledger-recorded operator state (single writer: the policy service inside eligibility domain, persisted via ledger records).
- **State:** none beyond policy records in the ledger; capability inputs come from the registry.

### 2.6 FX & liquidity intelligence — `packages/services/src/payswap/fx/`

- Read-only: provider balance queries (`balances.read`), rate quotes, corridor cost estimates. Evidence-stamped snapshots with TTL; every quote carries `{ quoteId, rate, source, fetchedAt, expiresAt }`.
- **No execution role.** Feeds route discovery and approval display (FX conditions bind into authorization records).
- **State:** in-memory cache + evidence records in ledger; single writer = fx service.

### 2.7 Deterministic route discovery — `packages/services/src/payswap/routing/`

- **Pure function:** `(intent, capabilitySnapshot, fxSnapshot, policy) → readonly Route[]`. Same inputs ⇒ same routes; no LLM in the loop.
- **Route taxonomy:**
  - **Direct-route baseline** (always computed, always shown first): single leg, source account → verified recipient, via one provider operation. Alternatives must justify themselves *against the baseline* (fees + FX + ETA + risk).
  - **Existing routes:** every leg currently executable on evidence.
  - **Conditional routes:** executable once declared preconditions hold (recipient verification pending, capability pending, funding in flight); preconditions are checkable, typed, and attached to the route.
  - **Opportunity routes:** cheaper/faster alternatives under current FX/liquidity intelligence; never auto-selected; always presented with baseline comparison.
- **State:** none; routes are ledger-recorded at proposal time.

### 2.8 Financial execution authority — `packages/services/src/payswap/execution/`

The **only** component that submits provider write operations.

- **Per-leg idempotency:** keys allocated at route validation, immutable; mapped by adapters onto provider-native mechanisms (doc 05 §6.3).
- **Multi-leg saga:** a route executes as a saga in dependency order; each leg: prevalidate (`validateLegForSubmission`) → submit → read-back → record provisional outcome → next. The ledger is the saga journal (append-only), so **recovery = replay**: on restart the executor reconstructs in-flight sagas from the ledger, resubmits only legs never submitted (idempotency keys make that safe where providers guarantee it), and parks unknown legs for reconciliation.
- **Partial failure:** no blind auto-rollback. Compensation legs (refund, transfer-back) are themselves money movements — they must be **pre-authorized as part of the route** (visible in the approval record) or explicitly authorized afterwards. Failure of leg N halts dependent legs, surfaces a typed partial-failure state, and requests operator action.
- **State:** saga/execution state lives in ledger DB records; single writer = executor. **The executor never trusts planner claims** — it revalidates every leg.

### 2.9 Provider runtime — `packages/services/src/payswap/providers/<providerId>/`

First-party in-process adapters implementing the plugin contract (doc 05). P0: `stripe`, `paystack`, `paypal`. Third-party plugin-shipped adapters (same contract over MCP) are P1+ behind trust review + acceptance suite. The adapter is the **only** code that knows a provider's wire format; it is the only place provider facts (doc 04) are encoded — each fact stamped and re-verified per the research standard.

### 2.10 Webhook/event processing — `packages/services/src/payswap/events/`

- **Ingress topology, P0:** desktop = **poll-based** provider read-back on schedule + on-demand (no local webhook listener; desktop Main holds no business state per AGENTS.md). Web deployments (`packages/server`) get an additive `/webhooks/payswap/:provider` route: signature verification at ingress (adapter `verify`, doc 05 §6.5), event-id dedupe, normalized event appended to the ledger, then dispatched to execution/reconciliation consumers.
- **Ordering & duplication:** providers deliver at-least-once, unordered (PayPal explicitly — doc 04 §3.4). Events never mutate execution state directly; they update outcome expectations that **reconciliation** resolves.
- **State:** event records in ledger (single writer via ledger repo); in-flight queue in host memory only.

### 2.11 Reconciliation — `packages/services/src/payswap/reconciliation/`

- **Read-only matcher:** provider read-back (authoritative, via `reconciliation.read` operations) vs ledger expectations vs (where applicable) bank-side confirmation. Produces reconciliation records: `confirmed | exception | pending-with-deadline`.
- **Confirms settlement** — the honest terminal state (doc 04 §4: every provider has a settlement-honesty gap: Stripe payout schedules, Paystack success→reversed, PayPal unclaimed→returned).
- **Never mutates** provider objects; exceptions raise operator actions with full evidence trails. Reversal events (e.g., `transfer.reversed`) flip confirmed settlements back to exceptions — the ledger records both states, append-only.
- **State:** reconciliation records in ledger; single writer = reconciliation service.

### 2.12 Append-only financial evidence ledger — `packages/services/src/payswap/ledger/`

**Why this shape:** the repo's established local-persistence pattern is `node:sqlite` `DatabaseSync` with versioned migrations and a schema contract check (`packages/services/src/session/taskIndexRepo.ts`, `tasksDatabase/migrations.ts`, root `db:schema:check` script). PaySwap gets its **own database file** (different owner, different lifecycle than the task index) with the same engineering discipline: versioned schema migrations + root schema-contract test extension.

- **Append-only, hash-chained:** each record carries `seq`, `type`, `payload`, `prevHash`, `recordHash = sha256(seq|type|payload|prevHash)`. No updates, no deletes; corrections are new records referencing the corrected record. (Digest-binding precedent in-repo: MCP trust `declarationDigest`.)
- **Record types:** evidence (capability read-backs, fx quotes), intent, route proposal, authorization, execution events (submit/accepted/refused/unknown/read-back), normalized provider events, reconciliation records, policy/operator actions (incl. live-gate unlocks).
- **Single writer, single process (R4-hardened; fenced in addendum rev 4):** the ledger repository is the only component that writes; every other domain *submits* records to it. Concurrency boundary (addendum §4.6, normative): the SQLite ledger is **never opened for writing by more than one process** — horizontal/multi-instance writes are prohibited; the repository holds a **fenced lease-based authority lock** for the database's lifetime (the bot-runtime-lock precedent — `packages/services/src/bots/channelRuntime.ts:153-238`: lock directory + atomically-renamed `owner.json` + 10 s heartbeat / 30 s TTL lease + dead-pid takeover + explicit release, held for the runtime-loop lifetime in upstream), hardened per addendum §4.6: bounded boot acquisition over the atomic-rename primitive that serializes simultaneous attempts, a **fencing generation** — monotonically increased on every acquisition, persisted in the ledger itself, and validated at the repository write boundary inside every write transaction (a stale holder after takeover refuses typed `ledger_authority_lost`; rows N36–N38) — fail-closed typed `ledger_authority_unavailable`, and chain verification before the first post-takeover write. In the SQLite server topology the authority is never inferred: exactly one instance per logical ledger/workspace must be **explicitly configured** as authoritative, and an instance without explicit configuration refuses financial activation. *Correction (rev 3, retained):* the rev-2 "`withFileLock` held long-lived" wording was not implementable as stated — `withFileLock` is per-operation by contract (`packages/shared/src/node/privateFilePersistence.ts:51-86`); it remains in use only for short file-maintenance operations (export/backup). WAL + `BEGIN IMMEDIATE` (`taskIndexRepo.ts:398-402, 766-767`) serialize within the one process. Single-writer verification is a test, not a claim: N23 (second host refuses within the boot budget; crash arm — no takeover before TTL, chain verification before the first post-takeover write), N24 (replica write rejected at the repository), and N36–N38 (stale-holder write after takeover, simultaneous acquisition, stale-generation write). Hosted multi-user or horizontally scaled deployments must refuse financial activation until central PostgreSQL + authenticated principals exist (addendum §4.6, with the deployment-scope table).
- **UI:** reads projections via RPC; the additive `payswapStore` never becomes the source of truth.

### 2.13 Provider research tooling — `docs/payswap/provider-facts/` + `apps/zcode-cli/tools/payswap-provider-research/`

- Fact sheets per provider: every claim evidence-stamped with retrieval date and a re-verification deadline (this domain's first artifact is doc 04). Precedent for tooling location: `apps/zcode-cli/tools/provider-regression/` (root scripts `provider:regression`).
- The tooling keeps facts alive: scheduled re-verification checklists, diffing live docs against encoded adapter facts, and fixture harvesting for the doc 05 §12 acceptance suite. An adapter fact without a current fact-sheet citation fails review.

---

## 3. Dependency graph

```mermaid
graph TD
  subgraph ZCodeLayer["ZCode layer (untouched)"]
    MODEL[Model orchestrator]
    UI[UI: hooks + payswapStore projection]
    AGENT[Agent runtime / MCP plugin surface]
  end

  RESEARCH[13 Provider research tooling] -->|evidence-stamped facts| FACTS[provider fact sheets]
  FACTS -->|cited notes| ADAPTERS

  CONTRACTS[1 Financial contracts<br/>packages/shared/src/payswap]

  ACCOUNTS[2 PSP accounts &amp; credentials<br/>services/payswap/accounts] -->|secrets via| CRED[(ICredentialService<br/>existing credential store)]
  ACCOUNTS -->|connections| ADAPTERS[9 Provider runtime<br/>services/payswap/providers/*]

  ADAPTERS -->|capability evidence| CAPREG[3 Capability registry<br/>packages/payswap-provider + capabilities service]
  ADAPTERS -->|fx quotes / balances| FX[6 FX &amp; liquidity intelligence]
  ADAPTERS -->|operation results| EXEC[8 Execution authority]

  MODEL -->|draft intent| COMPILER[4 Intent compiler]
  COMPILER --> CONTRACTS
  COMPILER -->|clarifications| MODEL

  CAPREG --> ELIG[5 Eligibility &amp; policy validation]
  POLICY[(operator policy records<br/>in ledger)] --> ELIG
  ELIG --> ROUTING[7 Route discovery<br/>direct-route baseline first]
  FX --> ROUTING
  COMPILER -->|intent| ROUTING
  CONTRACTS --> ROUTING

  ROUTING -->|route proposal| AUTHZ[Authorization model §4<br/>approval records]
  ELIG -->|same validateLegForSubmission| EXEC
  ROUTING -->|legs re-validated| EXEC
  AUTHZ -->|authorization record gates| EXEC
  EXEC -->|submit / read-back| ADAPTERS
  EXEC -->|journal| LEDGER[(12 Append-only evidence ledger<br/>sqlite, hash-chained)]

  EVENTS[10 Webhook / event processing<br/>poll (desktop) / ingress route (server)] -->|verified normalized events| LEDGER
  ADAPTERS -->|signatures / polling read-back| EVENTS

  RECON[11 Reconciliation] -->|read-back| ADAPTERS
  LEDGER -->|expectations| RECON
  RECON -->|confirmations / exceptions| LEDGER

  CAPREG -->|evidence records| LEDGER
  COMPILER -->|intents| LEDGER
  ROUTING -->|routes| LEDGER
  AUTHZ -->|authorizations| LEDGER
  ACCOUNTS -->|connection lifecycle| LEDGER
  FX -->|quotes| LEDGER

  LEDGER -->|read projections| UI
  AGENT -->|payswap_* tools (common layer only)| COMPILER
  AGENT -->|eligibility / route / status queries| ROUTING
  UI -->|approval actions| AUTHZ
```

Reading rules: arrows into the ledger are *submissions* (the ledger repo is the single writer of its tables); the model touches only the compiler + query tools; adapters receive calls and emit evidence — they never call the executor, the planner, or the UI. The `UI →|approval actions| AUTHZ` edge originates **exclusively** from the host-rendered authorization card (addendum §1.6.0 Class B — permission-prompt projection pattern) — never from plugin webview surfaces, never from model output.

---

## 4. Authorization model

**What an approval binds** — a typed `AuthorizationRecord` (contracts domain), hash-digested (`approvalDigest = sha256(canonical record)`; digest-binding precedent: `declarationDigest` in `zcodeWorkspaceMcpTrustParamsSchema`):

| Field | Binding |
|---|---|
| `principal` | The **authenticated operator** identity (desktop: the local OS user session of the host process; web: the **server-resolved operator principal** — addendum §1.6.3: server authentication is not operator identity; the principal derives from per-operator credentials server-side, never from client payloads). Never "the model". |
| `sourceAccount` | `connectionId` + provider account id (the debiting account). |
| `recipient` | A **provider-verified recipient reference** (Paystack `recipient_code`, PayPal confirmed account recipient, Stripe account object) — never a model-fabricated address (doc 04 §3.3). |
| `amount`, `currency` | Exact decimal money. |
| `purpose` | Typed purpose code + text. |
| `route` | The **full route with all legs** (provider, operation, debit/credit, idempotency keys, max fees, FX conditions per leg). |
| `maxFees` | Hard ceiling across the route. |
| `fxConditions` | Quoted rate, max slippage, quote id, expiry. |
| `providerOperations` | The exact operation ids the executor may submit. |
| `expiry` | Timestamp; expired ⇒ reauthorization. |
| `singleUse` | `true` in P0 — one approval executes at most once (precedent: `approvalMode: "user-once"` on permission requests). |

**Flow:** model calls `payswap_request_authorization` → common layer materializes the record + digest → operator approval surfaces through the **existing permission protocol** (`zcodePermissionRequestedEventPayloadSchema` with `riskLevel: "critical"`, options approve/reject/edit — never auto-approve) → on approval, the authorization record is appended to the ledger binding the principal → the executor may run. **The model cannot authorize its own action** — it is not a principal, holds no credentials, and its tool surface has no approve path.

**Material changes require reauthorization:** any change to a digested field (amount, route legs, fees, FX conditions, recipient, purpose) produces a different digest ⇒ a new approval. Route amendments mid-saga (e.g., a compensation leg not pre-authorized) require a fresh approval.

**Server-side role enforcement:** in web deployments, `packages/server` enforces roles (proposer / approver / auditor / viewer) **at the service boundary** before PaySwap RPC methods execute — enforcement never lives in the UI (AGENTS.md UI boundaries). Operator sessions carry bounded lifetimes, revocation is a server-side admin action that invalidates credentials and pending challenges immediately, and challenges bind the issuing session's principal — cross-user resolution is rejected (addendum §1.6.3; rows N29–N32). Desktop is single-principal by construction (host process = the operator's session). **Mobile remote control (web-remote-replayable) does not approve money movement in P0** — approvals bind to the desktop/web operator surfaces only (open question §7).

---

## 5. State ownership matrix (no duplicate owners)

| State | Single owner | Location | Writers | Readers |
|---|---|---|---|---|
| PSP secrets | `ICredentialService` (existing) | `credentials.json` (AES-256-GCM) | accounts service | adapters (host process only) |
| Connection records | accounts service | additive payswap config store | accounts service | UI projection, eligibility, executor |
| Capability evidence | capability registry service | ledger evidence records + in-memory registry | capabilities service | eligibility, routing, UI |
| Intents / routes / authorizations | ledger repo | payswap ledger sqlite (append-only) | intent/routing/authz services via ledger | everything (read-only) |
| Execution & saga state | execution authority | ledger execution records | executor only | reconciliation, UI |
| Provider events | events service | ledger event records | events service | executor, reconciliation |
| Reconciliation results | reconciliation service | ledger records | reconciliation only | UI, operators |
| Policy + live-gate state | eligibility/policy service | ledger records | operator actions | eligibility, executor |
| FX snapshots | fx service | memory + ledger evidence | fx service | routing, approvals display |
| UI projections | `payswapStore` (Zustand, additive) | renderer | UI only (from RPC reads) | components |

Explicitly **not** owners: desktop Main (no business state, per AGENTS.md), external relay (auth/pairing/forwarding only, per AGENTS.md), the agent runtime (holds no financial state, no credentials), renderer-local state (never authoritative).

---

## 6. Delivery semantics (the two chains)

AGENTS.md mandates distinguishing desktop `desktop-continuous` from mobile `web-remote-replayable` semantics. For PaySwap:

- **Execution status, ledger projections, reconciliation results** must be **replayable**: they are ledger-backed, so a mobile remote attaching mid-saga sees consistent snapshots (same mechanism as task snapshots — runtime state supplements, not session-file writes).
- **Approvals and live-gate actions** are **continuous-only in P0** (desktop/web surfaces; mobile approval deferred — §7 open questions).
- Streaming/queue semantics for financial tools ride the existing queue/permission plumbing unchanged; financial tools must never introduce their own bypass of `CommandInbox` admission.

---

## 7. Open questions for the TL

1. **Mobile approval** — defer money-movement approval on `web-remote-replayable` to P1? (Recommendation: yes.)
2. **`packages/payswap-provider` as a new pure package** vs folding the capability registry into `packages/services/src/payswap/capabilities/` only — new package mirrors `packages/provider` precedent and keeps pure/testable domain code out of services; confirm appetite for a new workspace package.
3. **Webhook ingress priority** — is a `packages/server` webhook route needed in P0, or is poll-based reconciliation sufficient for the whole P0 horizon? (Recommendation: polling for P0; the events domain keeps the ingress contract so the server route is additive later.)
4. **Compensation pre-authorization UX** — showing pre-authorized compensation legs inside the approval record adds cognitive load; alternative is compensation-always-requires-new-approval (safer, slower). Recommendation: pre-authorized only for reversal-shaped compensations (refunds), new approval for novel legs.
5. **Ledger DB file location & backup story** — separate file under the existing app config dir (recommended) vs shared DB with the task index (rejected: different owner/lifecycle).

---

## 8. Safety invariants (non-negotiable)

1. **API acceptance is not settlement.** No leg is `settled` until reconciliation confirms from provider/bank read-back (Stripe payout schedules; Paystack `success`→`reversed`; PayPal `UNCLAIMED`→`RETURNED` — doc 04 §4). Provisional outcomes (`succeeded-provisional`) are the ceiling of API-level truth.
2. **Unknown outcomes are never auto-retried when duplication is possible.** Timeouts/ambiguities post-submit ⇒ leg parked `unknown` in the ledger; resolution = operator + provider read-back (reconciliation). Auto-retry is permitted only where idempotency is provably provider-guaranteed for that operation, and only by the executor, never the planner or the model.
3. **Licensing / AML / KYC / sanctions are never bypassed by extra hops.** Every leg rides the provider's own verified rails with the provider's own onboarding state as evidence; multi-leg routes may not launder a blocked corridor through an intermediate account. Eligibility enforcement includes regulatory gates; refusals are typed and explained (`region_unsupported`, `risk_flagged`, `capability_not_enabled`) — the system refuses and explains, it never reroutes around a regulatory block.
4. **Live money movement is gated until the full acceptance suite passes.** Per provider: the doc 05 §12 eight-part suite green + operator go-live checklist recorded in the ledger + reconciliation dry-run pass. Until then the executor refuses all live operations typed `policy_blocked: live_mode_not_enabled`, regardless of credentials present. Live unlock is itself an operator action recorded as a ledger record with evidence links.

**Additional standing invariants:** the model is never a principal and never holds credentials; approvals are single-use and digest-bound; material changes force reauthorization; the ledger is append-only and hash-chained; every capability claim carries evidence; every provider fact carries a retrieval date and re-verification deadline.
