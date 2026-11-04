# PaySwap P0 — Architecture Addendum (response to the P0 architect review)

**Owner:** TL · **Status:** normative for P1+ · **Reviewed against:** worktree `a9fe401`
(v3.17.2) · **Responds to:** the architect review of PR #2 (changes-requested before merge).

This addendum resolves the five gaps the architect identified. Each section states the
decision, the source evidence at `a9fe401`, and the acceptance criteria that make it
enforceable. Where it amends an earlier deliverable, the amendment is listed in §6 and
applied to that document in this same PR.

---

## §1. Non-bypassable, transaction-bound approval

### 1.1 What the source actually does (verified)

The P0 audit correctly found that regular MCP tools are registered with
`needsApproval = true` (`apps/zcode-cli/packages/core/src/mcp/index.ts:148`). That
metadata does **not** mean execution always requires a human approval. The decision
order in `PermissionService.checkPermission`
(`apps/zcode-cli/packages/core/src/permission/service.ts`) allows these paths to reach
`allow` before any ordinary ask:

| # | Bypass path | Source (path:line, symbol) |
|---|---|---|
| 1 | **YOLO / guarded mode** allow-all — fires before disallowed-tools, project rules, and ordinary ask | `permission/service.ts:148` `(context.mode === "yolo" \|\| context.mode === "guarded") && !planEnabled` → `allow("mode.yolo")`; also `:217` (plan re-entry) and `:518` (plan MCP gate) |
| 2 | **Session allow rules** — bypass even tools that self-declare `alwaysAsk` | `permission/service.ts:399-456` `checkAlwaysAsk` — session-allow allow branch at `:435` `rule.session.allow` returns `allow` before the final `ask` |
| 3 | **Owned workflow amendments** — same position as session rules | `permission/service.ts:448` `rule.session.workflowOwner` (AmendWorkflow/FillWorkflowHole with in-session predecessor) |
| 4 | **`allowedTools` session config** | `permission/service.ts` `this.config.allowedTools.has(...)` → `allow("rule.allowedTools")` in the ordinary path |
| 5 | **Preapproved special cases** (ReplyToChannel, WebFetch preapproval, CronPauseSelf, workflow draft writes) | `permission/service.ts:203-281` |
| 6 | **Subagent contexts** — the Task/agent tool launches child runtimes with `needsApproval: false`; child calls are "separately constrained and approved" **in the child's own permission context**, which inherits the session mode (yolo sessions run yolo children) | `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:252-261` `permission: "subagent"` |
| 7 | **Automation / unattended runs** — permission outcomes are resolved by the same service under the run's mode; preapproval carve-outs exist precisely so unattended runs don't stall (CronPauseSelf) | `permission/service.ts:246-260` |

Plan mode is the strictest mode (read-only gate, MCP ask with
`optionsPolicy: "no-always-allow"` at `service.ts:518-526`) — but plan mode is a user
choice, not a security boundary we may assume.

Deliverable 07's statement that "MCP tools are always approval-gated" is therefore
**wrong as stated**; it is corrected in this PR. The audit's finding was right; the
proposed mitigation was underspecified. This section is the specification.

### 1.2 The decision: two independent layers, and the security boundary is the lower one

PaySwap separates two things the permission system conflates:

1. **Permission to invoke a PaySwap tool** — governed by the existing ZCode permission
   system, unchanged. This controls *noise*: whether the model may call
   `payswap_transfer` at all without an interrupting prompt.
2. **Authorization to execute a specific financial transaction** — governed by a new,
   host-owned **transaction authorization** mechanism inside the PaySwap financial
   layer. This controls *money*.

**Layer 2 is enforced in the execution authority
(`packages/services/src/payswap/execution/`, deliverable 06 §2.8), not in the
permission layer, not in the tool, and not in the adapter.** A money-affecting
operation (deliverable 05 §6.1 `create` operations) is refused unless the call
carries a valid **Authorization Grant** — and grants cannot be minted by anything the
model controls.

### 1.3 Authorization Grant — construction and binding

A grant is a ledger-recorded record created **exclusively** by this path:

```
renderer authorization card (human click)
  → host account service (renderer→host ServiceChannel, host process)
    → grant record appended to the ledger (single writer)
```

No other code path may create a grant. Specifically: not a tool call, not a subagent,
not an automation run, not a webhook, not the model, not the PaySwap MCP server
process itself.

A grant binds the full tuple, per the mission mandate and deliverable 06 §4:

| Field | Bound value |
|---|---|
| Principal | the host-verified human principal (§4.5) |
| Source account | `connectionId` + account identity from evidence |
| Recipient | **verified** recipient identity (provider read-back evidence ref) |
| Amount / currency | exact decimal + ISO-4217 |
| Purpose | typed purpose classification (deliverable 06 §2.4) |
| Route + legs | the exact validated route graph, leg-by-leg, with per-leg idempotency keys |
| Fees | maximum total fees |
| FX | exchange conditions (rate floor/source, expiry) |
| Expiry | wall-clock expiry; expired grants refuse |
| Use | **single-use** — consumed atomically by the executor at first execution attempt |

Any material deviation between the presented operation and the bound tuple (different
leg, different recipient hash, amount above bound, past expiry) is a typed refusal
(`authorization_mismatch`), never a best-effort execution.

### 1.4 Why every enumerated bypass path fails against Layer 2

| Bypass path (§1.1) | Effect on a money operation |
|---|---|
| YOLO mode auto-allows the tool call | The call executes **without a permission prompt** — and the executor refuses: no grant, `authorization_required`. Money does not move. |
| Guarded single-use confirm | Confirms only the *invocation*. Grant still required. |
| Session allow rule / `allowedTools` | Allow the *invocation* (possibly without prompt). Grant still required. |
| Owned workflow amendment | Amends a run, not a grant. Grant still required. |
| Preapproved carve-outs | None of them name PaySwap tools; even if a future one did, it would only affect invocation. Grant still required. |
| Subagent in a yolo session | The child may call `payswap_*` freely — executor refuses without a grant. Additionally, grants are issued only from interactive renderer approval cards; a subagent or automation context cannot originate one (no renderer approval event exists in that context). |
| Automation run | Same as above: invocation possible, execution impossible; read-only operations remain available. |
| Model "approves" in prose | Model text is not a renderer approval event; the host cannot be convinced by content. The grant ledger sequence is host-allocated. |

The permission layer (Layer 1) is retained as a UX affordance — PaySwap tools are
ordinary MCP tools and inherit `needsApproval: true` — but **no PaySwap security
property depends on Layer 1**. This is the direct answer to the architect's
requirement that approval "cannot be bypassed by YOLO or guarded mode, accept-edits,
session-level tool allowances, workflow amendments, or subagent/automation execution
contexts": those paths can silence prompts, and none of them can mint a grant.

### 1.5 Host-verified tool identity

The trust decision at the broker (§3) is based on **host-verified plugin identity
derived from the in-memory plugin registry**, not on tool names, not on
self-reported MCP annotations, and not on env values — reusing the exact precedent
ZCode already ships for official CUA:

- `resolveTrustedOfficialCuaServerNames`
  (`apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:43-57`) derives authority
  from the in-memory registry and explicitly documents that a user/project override
  replacing the config object ("copied names, commands, and env values") does **not**
  inherit the bundled plugin's authority.
- `createMcpToolEntry(..., officialCuaAuthorityVerified, ...)`
  (`apps/zcode-cli/packages/core/src/mcp/index.ts:96`) consumes that host-side
  verification.

PaySwap's broker applies the same rule: only the PaySwap plugin registered by the
official-plugin mechanism gets the broker credential; a same-named impostor plugin or
a hand-copied MCP server config does not.

### 1.6 Negative E2E test matrix (required before any write operation ships)

Every row is a P1/P7 gate; the matrix is machine-enforced (deliverable 08 harness
extension). "Refuses" means the typed refusal is returned and **no provider write
API call is attempted** (asserted at the adapter boundary, not the UI):

| # | Context | Attempt | Must |
|---|---|---|---|
| N1 | yolo session | money op, no grant | refuse `authorization_required` |
| N2 | yolo session | money op, forged/expired/consumed `authorizationId` param | refuse `authorization_mismatch` |
| N3 | guarded session | invocation confirmed, no grant | refuse |
| N4 | session allow rule on `payswap_*` | money op, no grant | refuse |
| N5 | `allowedTools` config containing the tool | money op, no grant | refuse |
| N6 | workflow amend context | money op, no grant | refuse |
| N7 | subagent (yolo parent) | money op, no grant | refuse |
| N8 | subagent (yolo parent) | attempts the approval-card flow | no grant can originate; refuse |
| N9 | automation run | money op | refuse |
| N10 | valid grant | operation with any tuple deviation (amount +1 minor unit; different recipient; extra leg) | refuse `authorization_mismatch` |
| N11 | valid grant | second execution attempt with same grant | refuse — single-use |
| N12 | valid grant | execution after expiry | refuse |

N10–N12 run in P7 when execution lands; N1–N9 are executable against the refusal
path as soon as P1's tool surface exists (the refusal logic is present from day one).

---

## §2. New Task acceptance criteria — corrected

The architect found deliverable 07 §3 and deliverable 10's P1 acceptance in
conflict: 07 says PaySwap adds cards and a toggle; 10 demanded "rendered surface set
unchanged with the plugin on vs. off." The corrected, normative criteria:

| State | Definition | Requirement |
|---|---|---|
| **S0** | PaySwap plugin not installed or disabled | Original ZCode New Task experience, **identical** to upstream `a9fe401` — the zero-difference proof compares this against upstream |
| **S1** | plugin enabled, user has **not** opted in | Original interface **unchanged** — same rendered surface set as S0. The `payswap_*` tools may be registered (standard plugin lifecycle) but are inert: without a connected account every tool returns the typed `not_connected` refusal. No cards, no toggle, no visual delta. |
| **S2** | user **opted in** (financial workspace toggle on) | PaySwap may render **only** surfaces declared in its `ui.surfaces[]` registry (deliverable 03 §6): account-connection cards, route-plan cards, authorization-request cards, evidence cards, the financial workspace panel. |
| **S3** | invariant across S0–S2 | Composer, model selector, Browser / Terminal / Computer-Use controls, theme, navigation, layout, responsive and remote behaviour are **unchanged in every state**. |

**Test oracle:** S0-vs-upstream and S1-vs-S0 are byte-level rendered-surface-set
comparisons (same harness as deliverable 08's New Task preservation traps). S2 is
checked against the declared-surface registry: any rendered surface not present in
`ui.surfaces[]` is a failure; the registry itself is the complete definition of what
PaySwap may add. The plugin-UI-bridge capability limitation the architect cited is
preserved verbatim: local workspace Agents support the bridge; Web/remote surfaces
that do not declare the capability do not render PaySwap cards (deliverable 03 §6
already records this — it stays normative).

Deliverables 07 §3 and 10 (P1/P5 acceptance) are amended accordingly in this PR.

---

## §3. The MCP-process-to-host-financial-service bridge

### 3.1 The problem, precisely

Deliverable 05 §2 places financial services and provider adapters **inside the host
process** (`packages/services/src/payswap/...`), and the six `payswap_*` tools in the
**PaySwap plugin's MCP server**, which the plugin runtime starts as a **stdio child
process** (`ProcessTreeStdioClientTransport`,
`apps/zcode-cli/packages/adapters/src/mcp/stdio-transport.ts:47`). A stdio child is
not a renderer: `ServiceChannels`
(`packages/shared/src/channels.ts:97`, `packages/services/src/descriptors.ts`
`createServiceDescriptor`) is the renderer↔host RPC fabric and is **not** an API an
external MCP process can call. The architect is right that this boundary was
unspecified; here is the concrete design.

### 3.2 The sequence (normative)

```
Model
  → payswap_* MCP tool            (PaySwap MCP server process, stdio child)
  → authenticated host broker     (loopback socket / named pipe, host process)
  → financial service             (packages/services/src/payswap/*, host process)
  → provider adapter              (packages/services/src/payswap/providers/<id>/, host process)
```

Nothing else. The MCP server process holds **no** financial state, **no** provider
credentials, and **no** ledger access; it is a thin, typed proxy. All broker calls
are ledger-recorded at ingress (§4).

### 3.3 The broker — reusing the shipped CUA broker pattern

ZCode already solves "host service ↔ MCP child process" once, for Computer Use. We
reuse the pattern, not the code path:

| Mechanism | CUA precedent (verified) | PaySwap broker |
|---|---|---|
| Host-side broker service | `packages/services/src/cua-permission-broker/` (service descriptor registration on ServiceChannels, host control plane) | `packages/services/src/payswap/broker/` — same descriptor pattern; broker listens on a loopback Unix socket (desktop) / named pipe (Windows) owned by the host process |
| Broker endpoint credential injection | `injectZCodeCuaBrokerMcpServers` (`apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:108`) injects the socket path into the trusted server config via `ZCODE_CUA_BROKER_SOCKET_ENV_KEY` (`packages/shared/src/mcp.ts`) | PaySwap plugin's trusted server config gets `PAYSWAP_BROKER_SOCKET` + `PAYSWAP_BROKER_TOKEN` the same way — **host-injected, never user-configurable, never persisted** |
| Trusted-snapshot credential capture | `getCapturedZCodeCuaBrokerCredentials()` (`mcp-config.ts:20-30`): captured in-process snapshot wins; stale runtime-env sockets **cannot** override it | Same rule for the PaySwap broker credential: captured at host startup, immune to env spoofing |
| Host-verified plugin authority | `resolveTrustedOfficialCuaServerNames` (`mcp-config.ts:43`) from the in-memory registry; copied configs don't inherit authority | Only the official PaySwap plugin registration receives the broker credential (§1.5) |
| Per-instance isolation | `mcp/uiCallTool` instance credentials + callId isolation, fail-closed session ownership (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts:59-76`) | Broker sessions are per-MCP-server-instance, fail-closed on ownership mismatch |

**Authentication of the calling process** (the architect's explicit requirement):
(1) the socket is loopback/named-pipe only — no network exposure on any deployment;
(2) the per-boot random token is required on every call — a process that doesn't hold
it cannot reach the broker at all; (3) the token is delivered only via the trusted
config injection path above, which only the host-verified PaySwap plugin registration
receives; (4) the broker additionally validates the caller's plugin identity claim
against the in-memory plugin registry, so even a stolen token on the same machine
cannot impersonate a different plugin's server.

**Authorization of each operation:** the broker exposes a **narrow typed RPC surface**
— exactly the operations behind the six `payswap_*` tools (deliverable 05 §10), not
general ServiceChannels access, not arbitrary host services. Money-affecting broker
operations additionally require the §1 grant id and validate the grant tuple before
dispatch to the executor. A plugin — any plugin — cannot use the broker to reach
broader host services; the broker's dispatch table is closed by construction.

### 3.4 Deployment variants

- **Desktop (Electron host):** broker lives in the desktop host process; the PaySwap
  MCP server child is local to it. 
- **Server deployment (`packages/server`, `entry-http.ts`/`http.ts`):** when PaySwap
  runs in a server-hosted workspace, the **server host process** owns the broker and
  the authoritative ledger (§4); the MCP server child is local to that host. The
  broker never crosses the network — every broker is per-host, loopback only.
- **P0/P1 first implementation:** desktop only, read-only operations, so the bridge
  is proven on the simplest topology before the server variant is exercised.

---

## §4. Ledger authority, deployment topology, and principal identity

### 4.1 The authority rule (normative)

**Exactly one host process owns the authoritative ledger per deployment.** The ledger
repository (deliverable 06 §2.12) is the single writer; every other domain submits
records to it. No process other than the authoritative host's ledger repository ever
writes ledger tables — on any deployment.

### 4.2 Deployment topologies

| Topology | Authoritative ledger host | Storage | Notes |
|---|---|---|---|
| **Desktop, single user** (P0–P6 default) | the desktop host process | local `node:sqlite` file — own DB file, WAL, file-lock; versioned migrations (repo precedents: `packages/services/src/session/taskIndexRepo.ts`, `tasksDatabase/migrations.ts`, `credentials.json` file-lock discipline) | Single writer process ⇒ **no concurrent writers by construction**. This is the single-user audit journal + saga journal + evidence store. |
| **Server-hosted workspace** (`packages/server`) | the **server** host process (webhook ingress already lands there per deliverable 06 §2.10) | same local SQLite discipline in P0–P6 | The desktop client participating in that deployment holds **at most a read-only replay replica** of evidence; it never writes authoritative financial state. |
| **Hosted multi-user / replicated** (beyond P7, not committed) | central server host | **PostgreSQL** — local SQLite is not appropriate for concurrent operators, replication, and backup SLAs; the architect's requirement is accepted | The ledger repository interface is storage-agnostic by design (same contract, same versioned-migration discipline), so the backend swap is additive. **Decision point: the P7 live-gate review.** Hosted multi-user PaySwap requires the central ledger AND authenticated principals (§4.5) before any live money in that topology. |

### 4.3 Multi-device and multi-process behaviour

- **One authoritative host per ledger identity.** Multiple desktops = multiple
  independent ledgers, each its own authority. Append-only hash chains do not merge;
  cross-device ledger merging is explicitly **out of scope** until the hosted model
  lands, and is not claimed anywhere in the roadmap.
- Concurrency *within* the authoritative host: all writes flow through the single
  ledger repository in one process — record append + hash-link + derived-state update
  commit in one SQLite transaction; there are no cross-process write races to
  resolve because no second writer exists.
- Saga recovery = replay (deliverable 06 §2.8) — unchanged by this addendum.

### 4.4 Backup, restore, migration

- **Backup:** documented procedure — stop host, copy DB file (plus a ledger export
  tool for evidence-portable backups).
- **Restore:** the chain verifier (already a P7 acceptance test: hash-chain
  verification) runs **before** a restored ledger is accepted; a broken chain
  refuses to load, fail-closed.
- **Migration** (SQLite → PostgreSQL at the P7 decision point, if taken): the new
  repository implementation must **replay the full chain and reproduce identical
  derived state** as an acceptance test — migration is proven by replay, not by
  schema translation alone.

### 4.5 Principal identity per deployment

| Deployment | Principal | Establishment |
|---|---|---|
| Desktop | OS-local human principal | host-verified renderer approval events (the §1.3 grant origin). The approval event's authenticity comes from the renderer→host ServiceChannel in the host process — **never** from model context, tool parameters, or subagent/automation text. The existing anti-laundering reminder (`apps/zcode-cli/packages/core/src/system-reminder/incoming-message.ts:7` — subagent reports "carry no user authority") documents the same principle; PaySwap enforces it structurally at the grant origin. |
| Server-hosted workspace | authenticated operator identity | server-side authentication; **client-provided operator IDs are never identity** (mission mandate, unchanged). Role enforcement server-side. |
| Hosted multi-user | authenticated operators + roles | prerequisite for that topology; not claimed before it exists. |
| Webhook ingress | none (it is an event, not a principal) | provider signature verification (deliverable 05 §6.5) — webhooks are *evidence about operations*, never authorization for anything. |

---

## §5. Plugin-hook and credential-security gates (P1/P2, enforceable)

### 5.1 Gate E1 — per-plugin hook admission in financial mode (P1)

**Source fact (verified):** `canRunPluginHooks()` returns `true` for every plugin
(`apps/zcode-cli/packages/adapters/src/plugins/index.ts:371-377`). The source comment
documents that the official-only trust boundary was abandoned and **names the upgrade
path**: "需要逐插件 trust（如 user config 白名单）时，把判断收回这里" — when
per-plugin trust is needed, pull the judgment back into this function.

**Decision:** P1 implements exactly that named upgrade path, gated:

- **Financial mode off (default):** behavior identical to upstream — all plugin
  hooks run. Zero ZCode regression.
- **Financial mode on** (a PaySwap financial workspace active in the session): only
  builtin/official plugins and plugins on an explicit user-config trust allowlist run
  hooks.

**Acceptance (P1):** engineering test — a third-party plugin hook does not execute
during an active financial flow unless admitted; with financial mode off, the same
hook runs (upstream behavior preserved); full plugin battery green.

### 5.2 Gate E2 — platform-appropriate credential security before real PSP credentials (P2)

**Source fact (verified):** when `ZCODE_CREDENTIAL_SECRET` is absent, the cipher key
is derived deterministically from public data —
`zcode-credential-fallback:${platform()}:${homedir()}:${username}`
(`packages/services/src/credential/providers/credentialCipherProvider.ts:24-38`); the
source's own comments describe `safeStorage` as a future migration, not an implemented
protection.

**Decision (per-platform, matching the architect's requirement):**

| Host | PSP-credential storage requirement |
|---|---|
| Electron desktop | `safeStorage`-backed cipher (the migration the source itself names) — OS keychain wraps the encryption key |
| Server / remote deployment | `ZCODE_CREDENTIAL_SECRET` from a real secret manager — **required**, not optional |
| Neither available | **Fail-closed:** the PaySwap account service refuses to store PSP credentials at all (typed error surfaced in the connection UI). The deterministic fallback is never used for `payswap:psp:*` keys. |

**Acceptance (P2):** E2E — connecting an account with only the fallback available
refuses; at rest, no PSP secret is decryptable under the fallback-derived key
(verified by direct inspection of the store); desktop battery green with safeStorage
active; the existing `ICredentialService` behavior for **non-PSP** keys is unchanged
(preservation matrix).

### 5.3 Gate E3 — controlled provider-authorization Browser flow (P1)

Not an indiscriminate domain block — a controlled flow, preserving legitimate
provider-hosted onboarding and existing Browser functionality:

1. **Model-controlled** navigation/API access to PSP API hosts in financial contexts
   is denied — the model never needs direct PSP HTTP access; that is what the
   adapters are for.
2. **Host-initiated provider flows** (OAuth redirect, dashboard onboarding) navigate
   only to a per-provider allowlist of official authorization hosts, driven by the
   host account service (deliverable 05 §5 `authSpec`), never by model-supplied URLs.
3. **Non-PSP domains:** Browser behavior completely unchanged (preservation matrix,
   deliverable 02).

**Acceptance (P1):** engineering tests for all three clauses; the existing Browser
E2E battery stays green.

---

## §6. Amendments applied to earlier deliverables (this PR)

| Deliverable | Amendment |
|---|---|
| 07 §1.2 | "MCP tools are always approval-gated" **corrected** — replaced with the two-layer statement and a pointer to this addendum §1; the "can never be silenced by yolo/accept-edits" claim is restated as a property of Layer 2 (grant enforcement), not of the MCP registration |
| 07 §3 + 10 P1/P5 | New Task acceptance criteria replaced with the four-state S0–S3 model (§2 above) |
| 10 P1 | Adds: broker bridge (§3) implementation + negative E2E rows N1–N9 + Gate E1 + Gate E3 |
| 10 P2 | Adds: Gate E2 (per-platform credential security, fail-closed) as a hard precondition for any real PSP credential |
| 10 P3 | Adds: live-doc re-verification of every deliverable 04 fact with retrieval dates (already implied, now explicit acceptance text) |
| 10 P7 | Adds: hosted-topology ledger decision point (§4.2), grant-bound negative rows N10–N12, chain-verified restore (§4.4) |
| 05 §2 | Bridge pointer: topology-1 adapters are reachable **only** via the §3 broker sequence — the MCP server process is a typed proxy with no financial state |

## §7. What this addendum deliberately does not change

The extension strategy, the preservation matrix, the financial domain decomposition
(deliverable 06 §2), the provider contract (deliverable 05), the evidence-or-refusal
law, the routing taxonomy, the mission invariants, and the P1→P9 sequence all stand
as submitted. No ZCode surface is replaced; every mechanism above is additive and
anchored to a precedent already shipped in the codebase at `a9fe401`.
