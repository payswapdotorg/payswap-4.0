# PaySwap P0 — Architecture Addendum (response to the P0 architect review)

**Owner:** TL · **Status:** normative for P1+ · **Revision:** 2 — incorporates the
architect's R1–R4 final-revision round (trusted approval origin, broker process
authentication, opt-in transitions, ledger concurrency boundary) · **Reviewed
against:** worktree `a9fe401` (v3.17.2) · **Responds to:** the architect reviews
of PR #2 (changes-requested before merge).

This addendum resolves the gaps the architect identified across two review
rounds. Each section states the decision, the source evidence at `a9fe401`,
and the acceptance criteria that make it enforceable. **Every security mechanism
is labeled** as either an *upstream precedent* (already shipped in ZCode — PaySwap
reuses it) or a *new PaySwap requirement* (ours to build and prove). Where it
amends an earlier deliverable, the amendment is listed in §6 and applied to that
document in this same PR.

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

### 1.6 Trusted approval origin (R1 — the approval surface and its proof chain)

§1.3 says grants are created "exclusively by a host-verified renderer approval
event." This section specifies what makes an event host-verified. The approval
surface is **host-controlled**: the authorization card renders in the trusted
application renderer — the same UI that renders permission prompts — never
inside a plugin webview, never in model-generated content.

**Upstream precedents (verified at `a9fe401` — reused, not reinvented):**

| Mechanism | Source |
|---|---|
| Window/sender ownership verification on security-sensitive IPC | `packages/desktop/src/main/webRemoteControlRendererReconnect.ts:34` — rejects when `event.sender.id !== win.webContents.id`; sender-id + frame-URL discipline at `packages/desktop/src/main/index.ts:381-382` |
| Plugin webviews cannot reach host services or credentials | `packages/ui/src/plugin-ui/CONTRACT.md:11` — plugin UI receives only capability handles (`sandboxId`/`initId`) via `IPluginUiBridgeService`, bound to Agent `runtimeId/generation/token/appIdentity`; the UI never touches plugin HTML, databases, or connection credentials |
| Stale-handle replay protection | `packages/ui/src/plugin-ui/app/pluginUiHostTeardown.ts` — teardown releases registrations by the *captured* `sandboxId`/`initId` and cannot affect pages created by newer credentials |
| Renderer↔host RPC fabric isolation | `ServiceChannels` (`packages/shared/src/channels.ts:97`) is reachable only from the trusted renderer via the desktop preload bridge — sandboxed plugin frames have no transport to it |

**New PaySwap requirements (no upstream equivalent — ours to build and prove):**

1. **One-time host-generated approval challenge.** When the authorization-request
   card is created, the host generates a 256-bit cryptographically random
   challenge and issues it to that card instance only. The approval event must
   present the challenge. Challenges are single-use, bound to one pending grant
   proposal, and expire with it. Challenges never enter model context — they
   live in the host↔renderer layer only.
2. **Transaction-digest binding.** The challenge binds a SHA-256 digest of the
   exact authorization tuple (§1.3). At approval time the host **recomputes the
   digest from its own state** — never from anything the card, the plugin, or
   the model supplied — and rejects on mismatch. This is the anti-tamper proof
   for the card content: a card that displayed different values than the tuple
   the host will record cannot produce a valid approval.
3. **Sender verification.** Desktop: the approval event must arrive from the
   expected window's webContents (the `event.sender.id !== win.webContents.id`
   precedent applied to the approval channel); events from any other frame,
   guest webview, or process are rejected. Server deployments: the event must
   arrive over the authenticated operator session (§4.5).
4. **Plugin-webview and model-originated approvals are impossible by
   construction — and tested anyway.** Plugin webviews have no ServiceChannels
   transport and never receive challenges; model output is not an event. The
   negative tests below assert the boundary holds end-to-end rather than
   trusting the construction.

### 1.7 Negative E2E test matrix (required before any write operation ships)

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
| N13 | forged renderer approval event (wrong webContents/sender, or non-expected frame) | approval rejected; no grant created (§1.6) |
| N14 | approval-card tampering — card presents amount/recipient/legs differing from the host-side tuple | digest mismatch → approval rejected (§1.6.2) |
| N15 | replayed approval challenge (already consumed, expired, or belonging to another proposal) | rejected; no grant (§1.6.1) |
| N16 | approval event originating from a plugin webview | cannot reach the approval channel (no ServiceChannels transport, no challenge); asserted refused end-to-end (§1.6.4) |
| N17 | model-generated text claiming the user approved | not an event; no grant path exists; assertion: no grant record after model text (§1.6.4) |
| N18 | stale capability handle replayed after card/instance teardown | handle rejected (upstream `pluginUiHostTeardown` discipline); no effect on newer pages (§1.6) |
| N19 | impostor MCP config with copied PaySwap names/commands/env but not the official plugin registration | no broker credential; cannot connect; tools unreachable (§1.5/§3.3) |
| N20 | second PaySwap MCP server instance presenting the first instance's token | per-instance credential mismatch → connection refused (§3.5.1) |
| N21 | broker request naming an operation outside the six `payswap_*` operations | closed dispatch table → refused, no host-service reach (§3.3/§3.5) |
| N22 | connection to a stale/pre-planted socket path after host restart | endpoint replacement protection: fresh per-boot path, unknown peer → dropped (§3.5.6/§3.5.2) |
| N23 | second host process opened against the same SQLite ledger DB | single-writer lock: refuses to start financial services, never a second writer (§4.6) |
| N24 | non-authoritative process (read-only replica) attempting a ledger write | rejected at the repository, not by convention (§4.6) |

N10–N12 run in P7 when execution lands; N1–N9 are executable against the refusal
path as soon as P1's tool surface exists (the refusal logic is present from day one).
N13–N18 gate P1 (approval-origin boundary) together with the tool surface;
N19–N22 gate the P1 broker bridge; N23–N24 gate the P7 ledger. Every "refuse"
means the typed refusal is returned and, for money rows, **no provider write API
call is attempted** (asserted at the adapter boundary, not the UI).

---

## §2. New Task acceptance criteria — corrected

The architect found deliverable 07 §3 and deliverable 10's P1 acceptance in
conflict: 07 says PaySwap adds cards and a toggle; 10 demanded "rendered surface set
unchanged with the plugin on vs. off." The corrected, normative criteria:

| State | Definition | Requirement |
|---|---|---|
| **S0** | PaySwap plugin not installed or disabled | Original ZCode New Task experience, **identical** to upstream `a9fe401` — the zero-difference proof compares this against upstream |
| **S1** | plugin enabled, user has **not** opted in | Original interface **unchanged** — same rendered surface set as S0. The `payswap_*` tools may be registered (standard plugin lifecycle) but are inert: every tool returns the typed `not_opted_in` refusal (§2.1 taxonomy — distinct from `not_connected`). No cards, no toggle, no visual delta. |
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

### 2.1 The exact opt-in path (R3)

**Upstream mechanism, used unmodified:** the PaySwap plugin declares a boolean
`userConfig` option — `financialWorkspace`, default `false` (the `PluginUserConfigOption`
contract, `apps/zcode-cli/packages/contracts/src/plugins/index.ts`, already in
deliverable 05 §1's evidence table). The existing plugin settings surface renders
it: `packages/ui/src/settings/PluginConfigControls.tsx` already renders
`plugin.userConfig` options with a `Switch`, mounted inside the existing plugin
settings pages (`packages/ui/src/settings/InstalledPluginManagement.tsx`,
`PluginsSection.tsx`). **Opt-in is the user flipping that switch in the existing
settings page.** No new settings page, no composer control, no navigation change,
no PaySwap-specific settings chrome.

**State machine:** S0 (not installed or disabled) → S1 (enabled,
`financialWorkspace=false`) → S2 (enabled, `financialWorkspace=true`). The five
transitions: **enable** (S0→S1), **opt-in** (S1→S2), **opt-out** (S2→S1),
**disable** (S1→S0 or S2→S0), **uninstall** (any → S0).

**Refusal taxonomy (three distinct typed codes, never conflated):**

| Code | State it names |
|---|---|
| `financial_mode_disabled` | plugin disabled or uninstalled |
| `not_opted_in` | S1 — enabled, `financialWorkspace=false` |
| `not_connected` | S2 — opted in, but no account connected |

Every `payswap_*` tool returns exactly the code matching the current state before
any operation is attempted.

### 2.2 Transition acceptance tests (P1)

| T# | Transition | Must |
|---|---|---|
| T1 | enable (S0→S1) | rendered-surface zero-diff vs S0; tools registered and inert |
| T2 | opt-in (S1→S2) | only `ui.surfaces[]`-declared surfaces appear; refusal code changes `not_opted_in` → `not_connected` |
| T3 | opt-out (S2→S1) | surfaces disappear; interface returns to S1-identical; code reverts to `not_opted_in` |
| T4 | disable (→S0) | interface identical to S0; tools unregistered; code `financial_mode_disabled` |
| T5 | uninstall (→S0) | interface identical to S0; plugin config removed; connection credentials deleted via the revocation flow (deliverable 05 §5); **ledger evidence retained** per its own retention rules — financial audit records are never destroyed by a UI uninstall — or exported-then-deleted by explicit operator choice |
| T6 | settings page | the existing plugin settings surface renders the PaySwap entry exactly like any other plugin — zero settings-page modification beyond the plugin's own declared options |

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

### 3.5 Broker process authentication (R2 — hardening beyond the shipped pattern)

The architect's rule, adopted verbatim: **a plugin identity claim alone is not
process authentication — the broker must verify the actual calling process against
the host-registered plugin instance.** The shipped node-repl browser broker already
implements part of this; PaySwap adds the rest. Labeled honestly:

**Upstream precedents (verified at `a9fe401`):**

| Mechanism | Source |
|---|---|
| Per-boot 256-bit random broker token, timing-safe comparison | `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts:155-168` (`authorizeRequest`: `randomBytes(32)` token, `timingSafeEqual`) — proves the caller received the token via the host's trusted config injection |
| Strict request schema, size cap, one-request-per-connection line protocol | `nodeReplBrowserBrokerRequestSchema.parse`, `MAX_REQUEST_BYTES` (same file) |
| Downstream authoritative session resolution | `requireSession` resolves sessionIds only for child sessions the parent runtime registered (`forChildSession`); unregistered ones are rejected (comment at `node-repl-browser-broker.ts:163-168`) — the session claim is never trusted from the wire |
| Host-side pid→plugin tracking | `McpTrackedProcess` maps MCP child pids to their owning plugin (`apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts:30-37`; process tree in `adapters/src/mcp/process-tree.ts`) — the host already knows which pid belongs to which plugin's server |
| Random per-boot socket/pipe path | `createSocketPath` — UUID-suffixed path (`node-repl-browser-broker.ts:86-90`); no fixed path to squat; `close()` removes the socket |

**New PaySwap requirements (not in upstream — ours to build and prove):**

1. **Per-process-instance credentials.** Each PaySwap MCP server *instance*
   receives its own broker token at spawn; token lifetime = process instance
   lifetime. One instance's token never validates another (upstream's
   single-server design doesn't need this; our plugin surface does). N20.
2. **OS peer verification.** Unix: `socket.getPeerCredentials()` (SO_PEERCRED) on
   connect — the broker reads the caller's pid/uid and verifies the pid against
   the host-registered instance table (the `McpTrackedProcess` pid→plugin mapping,
   extended to the broker). Windows: named-pipe client process id. The peer check
   happens **before any payload parsing**; unknown pids are dropped. A plugin
   identity claim on the wire is never sufficient by itself.
3. **Socket filesystem permissions.** Unix: socket directory `0700` and socket
   `0600` under the host's private runtime directory. (Upstream's broker uses
   world-traversable `tmpdir()` — acceptable for its single-child threat model;
   hardened for ours because our broker surface is financial.)
4. **Windows named-pipe ACLs.** Pipe DACL restricted to the current user's SID —
   no NULL DACL, no broader grants. (Upstream ships named pipes — e.g.
   `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts` — but
   explicit ACL restriction for the financial broker is ours to add.)
5. **Process/plugin/session binding.** A broker connection is bound to
   (verified pid → host-registered plugin instance → session scope). The session
   scope is re-resolved authoritatively downstream (`requireSession` pattern) —
   never taken from the request payload.
6. **Endpoint replacement protection.** Per-boot random path (upstream) **plus**:
   the host generates a fresh path every boot, removes or refuses an existing
   file at that path, and delivers the path only via trusted config injection.
   An attacker cannot pre-plant a socket at the path the host will use (UUID
   entropy), cannot replace the host's listening socket while the host holds it,
   and a stale socket from a crashed host dies with the private directory
   lifecycle. Because the MCP child only *connects*, a token-harvesting fake
   broker would have to guess a fresh random path before the host binds it —
   the private-directory permission makes the plant impossible for another OS
   user and the per-boot randomness makes it infeasible in time. N22.
7. **Replay resistance.** Timing-safe token comparison (upstream) **plus** a
   per-request unique id with dedupe inside the connection lifetime: a replayed
   request id is rejected. N21 covers the closed dispatch table; N19 the
   impostor config; N20 the cross-instance token.

**The dispatch table stays closed:** exactly the six `payswap_*` operations of
deliverable 05 §9 — no general `ServiceChannels` access, no arbitrary
host-service invocation, no reflection, no passthrough. This restates §3.3(4)
because R2 makes it explicit.

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

### 4.6 Single-writer enforcement and the multi-instance prohibition (R4)

**Prohibition, explicit:** the SQLite ledger **must never be opened for writing
by more than one process.** Horizontal or multi-instance deployments pointing
multiple hosts at one SQLite ledger file are prohibited. This is stated plainly
because the upstream precedents do not provide multi-host coordination:
`PRAGMA journal_mode = WAL` + `BEGIN IMMEDIATE`
(`packages/services/src/session/taskIndexRepo.ts:401,570,767`) serialize writers
*within one process*; `withFileLock` (`packages/services/src/credential/credentialService.ts:105,146,159`,
utility in `@zcode/shared/node`) is an advisory per-file lock. Neither is a
multi-host mechanism, and PaySwap does not pretend otherwise.

**Verifiable single-writer mechanism:** the ledger repository acquires an
**exclusive OS-level lock file held for the database's lifetime** — the
`withFileLock` utility, held long-lived instead of per-operation (the utility's
holding discipline is the upstream precedent; the long-lived hold is ours).
A second process that fails to acquire the lock **refuses to start financial
services**: fail-closed typed error at boot, surfaced in diagnostics, never a
degraded second writer, never a silent read-only fallback unless the process
was explicitly deployed as a replica (§4.2 — replicas have no write code path
reachable at all, asserted by N24).

**Verification is a test, not a claim:** N23 starts two host processes against
one ledger DB and asserts the second refuses; N24 asserts the replica's write
path is rejected at the repository, not by convention.

**Deployment consequence:** the initial server deployment is
**single-authoritative-host and single-writer** — enforced by the lock, stated
in the deployment documentation, and asserted by N23. **Hosted multi-user or
horizontally scaled deployments require the central PostgreSQL ledger and
authenticated principals (§4.5) before any live financial operation in that
topology.** This is a hard precondition of the P7 live gate, not a
recommendation: a scaled deployment with a shared SQLite ledger is a
configuration the software refuses, not one it tolerates.

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

Revision 1 (first architect round):

| Deliverable | Amendment |
|---|---|
| 07 §1.2 | "MCP tools are always approval-gated" **corrected** — replaced with the two-layer statement and a pointer to this addendum §1; the "can never be silenced by yolo/accept-edits" claim is restated as a property of Layer 2 (grant enforcement), not of the MCP registration |
| 07 §3 + 10 P1/P5 | New Task acceptance criteria replaced with the four-state S0–S3 model (§2 above) |
| 10 P1 | Adds: broker bridge (§3) implementation + negative E2E rows N1–N9 + Gate E1 + Gate E3 |
| 10 P2 | Adds: Gate E2 (per-platform credential security, fail-closed) as a hard precondition for any real PSP credential |
| 10 P3 | Adds: live-doc re-verification of every deliverable 04 fact with retrieval dates (already implied, now explicit acceptance text) |
| 10 P7 | Adds: hosted-topology ledger decision point (§4.2), grant-bound negative rows N10–N12, chain-verified restore (§4.4) |
| 05 §2 | Bridge pointer: topology-1 adapters are reachable **only** via the §3 broker sequence — the MCP server process is a typed proxy with no financial state |

Revision 2 (R1–R4 round — this commit):

| Deliverable | Amendment |
|---|---|
| 05 §9 | Refusal-code taxonomy (`financial_mode_disabled` / `not_opted_in` / `not_connected`, addendum §2.1) + per-process-instance broker credentials and OS peer verification (addendum §3.5) + N-row reference updated to §1.7 |
| 06 §2.12 | Ledger single-writer enforcement: lifetime lock-file mechanism, multi-instance prohibition, N23/N24 (addendum §4.6) |
| 07 §1.2/§3 | N-matrix reference updated to §1.7; opt-in path (§2.1) and transition tests T1–T6 (§2.2) added to the acceptance criteria |
| 10 P1 | Adds transition tests T1–T6, approval-origin rows N13–N18, broker rows N19–N22, per-instance credential + peer-verification scope |
| 10 P7 | Adds ledger rows N23–N24 and the explicit hosted/horizontal live-operation precondition |

## §7. What this addendum deliberately does not change

The extension strategy, the preservation matrix, the financial domain decomposition
(deliverable 06 §2), the provider contract (deliverable 05), the evidence-or-refusal
law, the routing taxonomy, the mission invariants, and the P1→P9 sequence all stand
as submitted. No ZCode surface is replaced; every mechanism above is additive and
anchored to a precedent already shipped in the codebase at `a9fe401`.
