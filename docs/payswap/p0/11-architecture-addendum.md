# PaySwap P0 — Architecture Addendum (response to the P0 architect review)

**Owner:** TL · **Status:** normative for P1+ · **Revision:** 3 — incorporates the
architect's second R1–R4 review round (surface-class conflict resolved in
§1.6.0; broker citation corrections and honest peer-verification labeling in
§3.5; state-model contradiction fixed in §2; lease-based single-writer lock in
§4.6) · **Reviewed against:** worktree `a9fe401` (v3.17.2) · **Responds to:** the
architect reviews of PR #2 (changes-requested before merge).

**The finding this revision leads with:** revision 2 required that authorization
cards never render in a plugin webview (§1.6) while simultaneously listing
authorization-request cards among the `ui.surfaces[]` plugin-surface cards (§2,
deliverable 07 §1.3). That was a direct conflict inside our own documentation.
§1.6.0 resolves it with a two-class surface model, and every affected document is
amended in this PR.

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
host-rendered authorization card — Class B, §1.6.0 (human click)
  → host account service (trusted-renderer→host service channel, host process)
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
| Subagent in a yolo session | The child may call `payswap_*` freely — executor refuses without a grant. Additionally, grants are issued only from interactive host-rendered approval cards (§1.6.0); a subagent or automation context cannot originate one (no approval event exists in that context). |
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
event." This section specifies what makes an event host-verified — and, first,
**which surface class the authorization card belongs to**.

#### 1.6.0 The two card classes (resolves the surface conflict)

PaySwap renders exactly two classes of financial UI, on opposite sides of the
trust boundary:

| Class | Surfaces | Rendering path | Content origin |
|---|---|---|---|
| **A — informational plugin surfaces** | account-connection cards, route-plan cards, evidence/reconciliation cards, the financial workspace panel | the plugin UI surface contract — `ui.surfaces[]` + `ui://` resources in the hardened plugin sandbox webview (deliverable 03 §6) | the PaySwap plugin (its MCP server's `ui://` HTML resources) |
| **B — the authorization card** | the authorization-request card (approval of a grant proposal) | **host-rendered in the trusted application renderer**, following the permission-prompt projection pattern (below) — **not** a plugin surface, **not** declarable in `ui.surfaces[]`, **not** a `ui://` resource, **not** resolvable via `mcp/uiCallTool` | the host's own grant-proposal record |

Class A may never carry an authorization action. Upstream's plugin-UI contract
is explicit that host validation of `ui://` content is structural only — the
product decision is documented as *fully trusting the plugin's declaration*
(`packages/services/src/plugin-ui-bridge/contract.ts:27-31`), and `ui://`
resources are served only inside the sandbox origin
`zcode-sandbox://plugin-<appIdentity>/…`
(`packages/desktop/src/main/pluginSandbox/protocol.ts:205-255`). Plugin content
is trusted *as plugin content* — which is precisely why it can never host a
money authorization. **A PaySwap plugin manifest that declares an
authorization-styled surface in `ui.surfaces[]` (or a tool with `_meta.ui`
naming one) is rejected at manifest validation — N25.**

**The Class-B rendering precedent (upstream, verified): the permission prompt.**
The host computes a typed payload — `permissionRequestPayloadSchema` with
host-computed `summary`, `detail`, and `options`
(`packages/shared/src/zcode-protocol-v4/snapshot.ts:244-265`) — the trusted
renderer renders it **as data** (`packages/ui/src/PermissionDialog.tsx`, wired
via `packages/ui/src/v4/V4InteractionDialogs.tsx:91-92`), and the human's
decision returns over the interaction-resolution command channel
(`resolveInteraction`, `packages/shared/src/zcode-protocol-v4/command.ts:224-236`
— first-come-first-served, late resolution is a noop, `:223`). The authorization
card is a new member of this pattern with its own payload schema — **with one
deliberate delta:** upstream permission prompts may carry a tool-self-reported
`display` preview (`snapshot.ts:253-255` — a bounded shape that degrades to
plain text on parse failure). The authorization card **does not use
plugin- or tool-reported display fields for any authorization-tuple value**: every
displayed value (amount, recipient, legs, fees, FX, expiry) is derived by host
code from the proposal record that the challenge digest binds. What the human
sees and what the host records are the same data.

#### 1.6.1 Upstream precedents (verified at `a9fe401` — reused, not reinvented)

| Mechanism | Source |
|---|---|
| Host-computed interaction payload → trusted renderer → `resolveInteraction` return path (the Class-B pattern) | `snapshot.ts:244-265`; `PermissionDialog.tsx` (wired at `V4InteractionDialogs.tsx:91-92`); `command.ts:224-236` |
| Window/sender ownership verification on security-sensitive IPC | `packages/desktop/src/main/webRemoteControlRendererReconnect.ts:33-36` — `if (event.sender.id !== win.webContents.id) return;`; same discipline at `packages/desktop/src/main/web-remote-relay/webRemoteControlRendererAction.ts:48-50` ("只接收目标窗口对本次 requestId 的回包") |
| Service-port delivery is window-scoped | the desktop main process posts the service port to the window's webContents only (`packages/desktop/src/main/desktopWindowLifecycle.ts:156-167`); the plugin-sandbox guest preload has no ServicePort channel at all (`packages/desktop/src/preload/pluginSandbox/index.ts:13-33`, selected at `packages/desktop/src/main/index.ts:2148-2149`) |
| Plugin webviews cannot reach host services or credentials | `packages/ui/src/plugin-ui/CONTRACT.md:11` — plugin UI receives only capability handles (`sandboxId`/`initId`) via `IPluginUiBridgeService`, bound to Agent `runtimeId/generation/token/appIdentity`; hardened guest policy (`packages/desktop/src/main/pluginSandbox/guestPolicy.ts:42-51` — sandboxed, context-isolated, no node integration); owner-checked host IPC (`pluginSandbox/host.ts:307-371`) |
| Stale-handle replay protection | `packages/ui/src/plugin-ui/app/pluginUiHostTeardown.ts:7-9` — teardown releases registrations by the *captured* `sandboxId`/`initId` and cannot affect pages created by newer credentials |

#### 1.6.2 New PaySwap requirements (no upstream equivalent — ours to build and prove)

1. **One-time host-generated approval challenge.** When the authorization card
   is created, the host generates a 256-bit cryptographically random challenge
   and issues it to that card instance only. The approval event must present the
   challenge. Challenges are single-use, bound to one pending grant proposal,
   and expire with it. Challenges never enter model context and never transit
   the plugin's MCP server process — they live in the host↔trusted-renderer
   layer only.
2. **Transaction-digest binding.** The challenge binds a SHA-256 digest of the
   exact authorization tuple (§1.3). At approval time the host **recomputes the
   digest from its own state** — never from anything the card, the plugin, or
   the model supplied — and rejects on mismatch. Combined with §1.6.0's
   content-origin rule (displayed values are host-derived), this closes both
tamper directions: a card cannot display values other than the tuple, and an
   approval event cannot bind a tuple other than the one displayed.
3. **Sender verification, per topology.** Desktop: the approval event must
   arrive over the main window's service port — the port-delivery discipline
   (§1.6.1) means only that window's webContents holds a transport, and the host
   additionally applies the sender-identity check (`event.sender.id` against
   the expected webContents — the `webRemoteControlRendererReconnect.ts:33-36`
   precedent) on the approval channel. Server deployments: item 5.
4. **Plugin-webview and model-originated approvals are impossible by
   construction — and tested anyway.** Plugin webviews have no transport to the
   approval channel and never receive challenges; model output is not an event;
   an approval-resolution attempt arriving via the plugin-UI callback path
   (`mcp/uiCallTool`) or any `ui://` interaction is not an approval event and
   produces no grant — N26. The negative tests below assert the boundary holds
   end-to-end rather than trusting the construction.
5. **Server-deployment approval boundary.** The standalone server today
   exposes **every** registered service channel on `/ws` with no per-service
   exposure policy (`packages/server/src/http.ts:134` —
   `services.exposeOnChannelServer(server, overrides)` with no policy argument;
   `packages/services/src/collection.ts:39-40` — an undefined policy exposes all
   channels), and its auth token is optional (`packages/server/src/entry-http.ts:21,39`).
   PaySwap does not inherit that posture for money: (a) financial services
   **fail closed at activation when no server auth token is configured** — N27;
   (b) approval events ride the authenticated operator client's
   interaction-resolution channel, with items 1–2 applying identically;
   (c) PaySwap adds an exposure policy for the standalone server so the approval
   channel is reachable only by authenticated operator clients — the same
   allowlist mechanism the desktop already ships for mobile clients
   (`WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS`,
   `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts:20-86`, which
   already excludes e.g. `PluginUiBridge`); (d) env hygiene: server auth and
   broker tokens are never present in MCP child environments (the
   `sanitizeZCodeRuntimeEnv` stripping discipline,
   `packages/shared/src/runtimeEnv.ts:64-76`). An unauthenticated client cannot
   resolve an approval — N28.

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
| N13 | forged renderer approval event (wrong webContents/sender, or non-expected frame) | approval rejected; no grant created (§1.6.2) |
| N14 | card-content deviation — a payload (or forged frame) presenting amount/recipient/legs differing from the host-side proposal record | host recomputes the digest from its own state → mismatch → approval rejected; independently, the rendered payload is host-derived (§1.6.0) and asserted byte-equal to the proposal record (§1.6.2) |
| N15 | replayed approval challenge (already consumed, expired, or belonging to another proposal) | rejected; no grant (§1.6.2) |
| N16 | approval event originating from a plugin webview | cannot reach the approval channel (no transport, no challenge); asserted refused end-to-end (§1.6.2) |
| N17 | model-generated text claiming the user approved | not an event; no grant path exists; assertion: no grant record after model text (§1.6.2) |
| N18 | stale capability handle replayed after card/instance teardown | handle rejected (upstream `pluginUiHostTeardown` discipline); no effect on newer pages (§1.6) |
| N19 | impostor MCP config with copied PaySwap names/commands/env but not the official plugin registration | no broker credential; cannot connect; tools unreachable (§1.5/§3.3) |
| N20 | second PaySwap MCP server instance presenting the first instance's token | per-instance credential mismatch → connection refused (§3.5.1) |
| N21 | broker request naming an operation outside the six `payswap_*` operations | closed dispatch table → refused, no host-service reach (§3.3/§3.5) |
| N22 | connection to a stale/pre-planted socket path after host restart | endpoint replacement protection: fresh per-boot path, unknown peer → dropped (§3.5.6/§3.5.2) |
| N23 | second host process opened against the same SQLite ledger DB | lease-based authority lock: the second process fails within the boot budget — typed `ledger_authority_unavailable`, financial services do not start, never a second writer (§4.6); crash arm: after `kill -9` of the holder, no process acquires before lease TTL, and takeover runs chain verification before the first write |
| N24 | non-authoritative process (read-only replica) attempting a ledger write | rejected at the repository, not by convention (§4.6) |
| N25 | PaySwap plugin manifest declaring an authorization-styled surface in `ui.surfaces[]`, or a tool with `_meta.ui` naming one | manifest validation rejects the declaration; plugin does not load with it (§1.6.0) |
| N26 | approval-resolution attempt arriving via the plugin-UI callback path (`mcp/uiCallTool`) or any `ui://` interaction | not an approval channel: no grant can originate; asserted refused end-to-end (§1.6.2) |
| N27 | server deployment with financial mode requested but no `ZCODE_SERVER_AUTH_TOKEN` configured | financial services fail closed at activation (§1.6.2) |
| N28 | server deployment: approval resolution from a client without a valid authenticated session (or excluded by the PaySwap exposure policy) | rejected; no grant (§1.6.2) |

N10–N12 run in P7 when execution lands; N1–N9 are executable against the refusal
path as soon as P1's tool surface exists (the refusal logic is present from day one).
N13–N18 gate P1 (approval-origin boundary) together with the tool surface;
N19–N22 gate the P1 broker bridge; N23–N24 gate the P7 ledger; **N25–N28 gate P1
with the approval-origin rows** (N25 manifest validation, N26 plugin-callback
path, N27 unauthenticated server, N28 unauthenticated client). Every "refuse"
means the typed refusal is returned and, for money rows, **no provider write API
call is attempted** (asserted at the adapter boundary, not the UI).

---

## §2. New Task acceptance criteria — corrected

The first architect round replaced deliverable 07's on/off wording with a
four-state model. The second round found a contradiction inside it: S1 claimed
"same rendered surface set as S0 / no visual delta" while simultaneously
registering PaySwap tools — but upstream visibly renders enabled plugins (the
composer `@`-mention list, MCP settings rows, plugin-UI launcher entries), so
"tools registered" and "no visual delta" cannot both hold; and the refusal
taxonomy named `financial_mode_disabled` as a tool response in S0, where the
tools are unregistered and nothing could return it. This revision fixes both.

| State | Definition | Requirement |
|---|---|---|
| **S0a** | plugin **not installed** | identical to upstream with no such plugin — the zero-difference proof compares this state against upstream |
| **S0b** | plugin installed, **disabled** | identical to upstream's installed-and-disabled state. Upstream itself renders management rows for disabled plugins — Enabled/Disabled badge (`packages/ui/src/settings/InstalledPluginManagement.tsx:162-170`), declared MCP server rows shown read-only ("This MCP server is built into a plugin. Enable the plugin to load it." — `packages/ui/src/settings/pluginManagedResourceGroups.ts:232-234`, `packages/ui/src/i18n/locales/en-US.ts:3822-3823`) — while a disabled plugin contributes **zero runtime components** (`emptyComponents`, `apps/zcode-cli/packages/adapters/src/plugins/index.ts:193-206, 983-992`: no `mcpServers`, no hooks, no commands) |
| **S1** | plugin enabled, user has **not** opted in | the rendered-surface delta vs S0 is **exactly the standard upstream delta of any enabled plugin with an MCP server** — the plugin appears in the composer `@`-mention list (enabled-only filter, `packages/ui/src/mentions/providers/pluginsMentionProvider.ts:22,62`), its servers appear in the MCP settings page with tool counts, declared plugin-UI launcher entries appear (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-ui-surfaces.ts:17-18`), and the context-usage "MCP tools" bucket includes its tool schemas (`packages/ui/src/chat-input-toolbar/contextUsage.tsx:157`). **No PaySwap-specific chrome**: no cards, no composer toggle, no navigation change, no settings-page modification beyond the plugin's own `userConfig` options. Tools register with upstream's default deferral (`shouldDefer: true`, no `alwaysLoad` — `apps/zcode-cli/packages/core/src/mcp/index.ts:193-195`), so S1 adds nothing to the default provider contract; every tool call returns the typed `not_opted_in` refusal (§2.1) |
| **S2** | user **opted in** (`financialWorkspace=true`) | PaySwap may render (a) surfaces declared in its `ui.surfaces[]` registry — **informational classes only** (Class A, §1.6.0; manifest validation rejects authorization-styled declarations, N25): account-connection cards, route-plan cards, evidence cards, the financial workspace panel — and (b) the **host-rendered authorization card** (Class B, §1.6.0), which appears when and only when a grant proposal is pending |
| **S3** | invariant across S0–S2 | Composer, model selector, Browser / Terminal / Computer-Use controls, theme, navigation, layout, responsive and remote behaviour are **unchanged in every state**. |

**Test oracle:** S0a-vs-upstream and S0b-vs-upstream's-disabled-state are
byte-level rendered-surface comparisons (same harness as deliverable 08's New
Task preservation traps). **S1-vs-S0 is no longer claimed as zero-diff — that
claim was wrong.** The S1 oracle is **delta-equivalence**: the S1-vs-S0 delta
must equal the delta upstream itself produces when any *control plugin* with
the same component shape (one stdio MCP server, same tool count, no UI
surfaces) is enabled — the same delta kinds (presence in the `@` list, MCP
settings rows, launcher entries), parameterized only by plugin/server names;
any delta kind beyond that set is a failure. S2 is checked against the
declared-surface registry (Class A) plus the Class-B authorization-card rule
(§1.6.0: rendered only for a pending proposal, host-derived content). The
plugin-UI-bridge capability limitation the architect cited is preserved
verbatim: local workspace Agents support the bridge; Web/remote surfaces that
do not declare the capability do not render PaySwap cards (deliverable 03 §6
stays normative).

**Session-lifecycle semantics (upstream facts the transitions must respect):**
plugin resolution happens once per app/session creation
(`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:245-253`), and
config changes apply to new sessions — "Changes apply to new sessions"
(`apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts:110`);
"Takes effect in new sessions" (`en-US.ts:5392`). Two consequences: (1) typed
refusals are decided by the **broker's live state** (tools are thin proxies,
§3.2), so refusal codes flip immediately on a config change; (2) plugin-UI
surfaces follow the upstream per-session lifecycle — they appear in sessions
created after the change, per upstream rules. The host-rendered authorization
card is proposal-driven and independent of session age.

### 2.1 The exact opt-in path (R3)

**Upstream mechanism, used unmodified:** the PaySwap plugin declares a boolean
`userConfig` option — `financialWorkspace`, default `false` (the
`PluginUserConfigOption` contract, `apps/zcode-cli/packages/contracts/src/plugins/index.ts:58-65`,
supports `type: "boolean"` with a default). The existing plugin settings surface
renders it: `packages/ui/src/settings/PluginConfigControls.tsx:148-158` renders
boolean `userConfig` options with a `Switch`, mounted inside the existing plugin
settings pages (`packages/ui/src/settings/InstalledPluginManagement.tsx:230-237`,
`PluginsSection.tsx:509-522` applies the `configuredOptions → option.default →
false` fallback for booleans). **Opt-in is the user flipping that switch in the
existing settings page.** No new settings page, no composer control, no
navigation change, no PaySwap-specific settings chrome.

**State machine:** S0a/S0b (not installed / disabled) → S1 (enabled,
`financialWorkspace=false`) → S2 (enabled, `financialWorkspace=true`). The five
transitions: **enable** (S0b→S1), **opt-in** (S1→S2), **opt-out** (S2→S1),
**disable** (S1→S0b or S2→S0b), **uninstall** (any → S0a).

**The inert-registration mechanism is a PaySwap plugin behavior, not a
plugin-runtime change.** Upstream has no "registered but inert" server state:
an enabled plugin whose required `user_config.*` values are missing is skipped
with an error diagnostic (`plugin_variable_missing`,
`apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:417-431` — the server is
not registered and a warning row appears in the management UI). PaySwap does
not use that path: the PaySwap MCP server always starts under the standard
lifecycle, and its tools are thin proxies that delegate every call to the
broker (§3.2); the broker reads **live** financial-mode state (the plugin
enabled map + `userConfig`) and returns the typed refusal. Zero plugin-runtime
modification; the refusal logic is testable from day one.

**Refusal taxonomy (three distinct typed codes, never conflated — with
reachability, fixing the contradiction):**

| Code | Names | Returned by | Reachable when |
|---|---|---|---|
| `not_opted_in` | S1 — enabled, `financialWorkspace=false` | the broker, via the thin-proxy tools | any tool call in S1 |
| `not_connected` | S2 — opted in, no account connected | the broker | any account-dependent tool call in S2 |
| `financial_mode_disabled` | plugin disabled or uninstalled | the broker, for **residual calls** | sessions started before the disable/uninstall keep their frozen tool surface until they end (upstream semantics, unchanged); the host revokes the disabled plugin's broker bindings at disable time, so residual tool calls refuse with this code |

In steady-state S0 the tools do not exist for new sessions (`emptyComponents`,
§2) — the model sees the standard unknown-tool behavior, identical to upstream.
The earlier revision's implication that `financial_mode_disabled` is a
steady-state S0 tool response was a contradiction (in S0 the tools are
unregistered — nothing could return it); this table is the correction, and
broker-binding revocation is what makes the code reachable and meaningful.

### 2.2 Transition acceptance tests (P1)

| T# | Transition | Must |
|---|---|---|
| T1 | enable (S0b→S1) | rendered-surface delta vs S0b equals the control-plugin delta set (§2 oracle — delta-equivalence, not zero-diff); tools registered and inert (`not_opted_in`) |
| T2 | opt-in (S1→S2) | refusal codes flip immediately (`not_opted_in` → `not_connected` — live broker state); plugin-UI surfaces appear per the upstream session lifecycle (sessions created after the flip); the host-rendered authorization card appears only with a pending proposal |
| T3 | opt-out (S2→S1) | refusal codes revert immediately; plugin-UI surfaces disappear per the upstream session lifecycle; no authorization card renders (the broker refuses to create proposals — no card can be pending) |
| T4 | disable (→S0b) | new sessions identical to upstream's disabled state (no PaySwap runtime components); running sessions keep their frozen tool surface (upstream behavior, unchanged — PaySwap adds no teardown it doesn't own) but money operations refuse `financial_mode_disabled` via broker-binding revocation; interface otherwise upstream |
| T5 | uninstall (→S0a) | interface identical to upstream not-installed; plugin config and userConfig removed by the existing uninstall flow (`plugins.ts:783-817`; `file-config.adapter.ts:318-325` removes both `enabledPlugins[id]` and `options[id]`); connection credentials deleted via the revocation flow (deliverable 05 §5); **ledger evidence retained** per its own retention rules — financial audit records are never destroyed by a UI uninstall — or exported-then-deleted by explicit operator choice; same residual-session semantics as T4 |
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
  → authenticated host broker     (local-domain Unix socket / Windows named pipe, host process)
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
| Host-side broker service | descriptor registration is an **in-process channel** (`packages/services/src/cua-permission-broker/cuaPermissionService.ts:53-55`, registered at `packages/services/src/node.ts:2729-2730`); the socket-listening precedents are the node-repl browser broker (TS, in-repo) and the CUA Helper (native, out-of-tree) | `packages/services/src/payswap/broker/` — a TS socket listener in the host process following the node-repl broker's protocol discipline (typed schema, size cap, one-request-per-connection, timing-safe token); listens on a local-domain Unix socket (desktop) / named pipe (Windows) in a **host-private directory** (§3.5.3) |
| Broker endpoint credential injection | `injectZCodeCuaBrokerMcpServers` (`apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:108-142`) injects the CUA socket into the **trusted `node_repl` server config only** (`:124-131`), via `ZCODE_CUA_PERMISSION_BROKER_SOCKET` (`packages/shared/src/runtimeEnv.ts:14`). **Correction of the previous revision:** the CUA injection is identity-mode today — socket + per-spawn `pluginAuthority`, **no token** (`resolveZCodeCuaBrokerToken()` returns `undefined`, `mcp-config.ts:30-32`; authority minted per spawn, `packages/services/src/node.ts:2396-2401`). The socket+**token** pair precedent is the node-repl browser broker (`node-repl-browser-broker.ts:80-84`; env keys `packages/shared/src/browser-use/nodeReplBroker.ts:6-7`) | PaySwap's broker credential = a **per-instance socket+token pair** (browser-broker discipline) delivered via the **trusted-injection path** (CUA discipline) — host-injected, never user-configurable, never persisted |
| Trusted-snapshot credential capture | `getCapturedZCodeCuaBrokerCredentials()` lives in `packages/shared/src/runtimeEnv.ts:157-209` (the previous revision's `mcp-config.ts:20-30` citation was wrong — that file holds only the captured-first wrapper at `:22-28`): captured in-process before env sanitization; a socket appearing without its authority **clears** the snapshot, fail-closed (`:171-174`) | Same rule for the PaySwap broker credential — plus the launch-assertion precedent `assertCapturedBrokerLaunchIsAuthorized` (`apps/zcode-cli/packages/cli/src/plugin-host-command.ts:47-49, 83-105`) and the env-stripping backstop (`runtimeEnv.ts:64-76` — captured keys never leak to other MCP servers, Bash, or tool children) |
| Host-verified plugin authority | `resolveTrustedOfficialCuaServerNames` (`mcp-config.ts:43-58`) — the anti-copying gate is **reference identity** (`:51` — `configuredServers[name] === config &&`); copied configs don't inherit authority | Only the official PaySwap plugin registration receives the broker credential (§1.5) |
| Per-instance isolation | `mcp/uiCallTool` instance credentials + callId isolation, fail-closed session ownership (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts:59-76`; lease triple `runtimeId/generation/token/appIdentity`, `mcp-ui/instances.ts:52-66, 88-100`) | Broker sessions are per-MCP-server-instance, fail-closed on ownership mismatch |

**Authentication of the calling process** (the architect's explicit requirement):
(1) the endpoint is a local-domain Unix socket / named pipe — no network exposure
on any deployment; (2) the per-instance random token is required on every call —
a process that doesn't hold it cannot reach the broker at all; (3) the token is
delivered only via the trusted config injection path above, which only the
host-verified PaySwap plugin registration receives; (4) the broker validates the
caller's plugin identity claim against the in-memory registry **and** the
OS-level peer identity (§3.5.2) — a claim alone is never sufficient (the
architect's rule, adopted verbatim).

**Authorization of each operation:** the broker exposes a **narrow typed RPC surface**
— exactly the operations behind the six `payswap_*` tools (deliverable 05 §9), not
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
  broker never crosses the network — every broker is per-host, local-domain only.
- **P0/P1 first implementation:** desktop only, read-only operations, so the bridge
  is proven on the simplest topology before the server variant is exercised.

### 3.5 Broker process authentication (R2 — hardening beyond the shipped pattern)

The architect's rule, adopted verbatim: **a plugin identity claim alone is not
process authentication — the broker must verify the actual calling process against
the host-registered plugin instance.** Re-verification of the upstream source
produced both corrections to our previous citations and a sharper honest labeling
of what upstream actually ships.

**Upstream precedents (verified at `a9fe401`):**

| Mechanism | Source |
|---|---|
| Per-broker 256-bit random token, timing-safe comparison | `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts:32` (`randomBytes(32)`), `:162-172` (`authorizeRequest` — length check + `timingSafeEqual` at `:165`). *Correction: the previous revision cited `:155-168`; `:155-160` is `respond()`* |
| Strict request schema, 1 MiB size cap, one-request-per-connection line protocol | schema `packages/shared/src/browser-use/nodeReplBroker.ts:25-35` (`token: z.string().min(32)`); `node-repl-browser-broker.ts:16` (`MAX_REQUEST_BYTES`), `:128` (parse), `:159` (`socket.end` — exactly one response per connection) |
| Downstream authoritative session resolution | token-proves-origin / session-resolved-downstream comment at `node-repl-browser-broker.ts:168-171` (*previously mis-cited as `:163-168`*); `requireSession` at `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts:334-347`; the child-session map is written only by `forChildSession` (`zcode-protocol/browser-control-broker.ts:38-39, 336-338` — "没有登记就按原 id 找，找不到即拒") |
| Host-side pid→plugin tracking | `McpTrackedProcess` (`apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts:33-39` — *previously mis-cited as `:30-37`*), `listProcesses()` (`:277-290`, pure in-memory), exposed over the protocol (`zcode-protocol/server.ts:888-889`). The process-tree utility (`adapters/src/mcp/process-tree.ts:33-43`) is a terminator, not part of the registry — the previous revision listed it under tracking |
| Random per-listener socket/pipe path | `createSocketPath` (`node-repl-browser-broker.ts:89-94` — *previously mis-cited as `:86-90`*): UUID-suffixed on both platforms; `close()` removes the socket file on POSIX only (`:62-64`) |
| **Private-directory socket placement** (the pattern PaySwap adopts) | official-command endpoint: "UDS 放在只有当前用户可进的临时目录里；Windows 用随机名的命名管道" — `mkdtemp` private dir (`apps/zcode-cli/packages/bootstrap/src/official-command-endpoint/endpoint.ts:60-65`). Contrast: the browser broker itself places its socket in the **shared OS `tmpdir()`** (`:93`) with no permission hardening — the weaker pattern, not the one we follow |
| Per-call token ledger inside the MCP child | node-repl-host call ledger (`apps/zcode-cli/packages/node-repl-host/src/call-ledger/ledger.ts:49` — `randomBytes(32)` per call; `CONTRACT.md:14` — "token 每次调用一个，只在条目打开期间有效") |
| **OS peer verification — native precedents** | macOS CUA Helper (closed source, spec in-repo): `SecCodeCheckValidity` code-signature gate on the launcher pid + `getpeereid`/`LOCAL_PEERPID` uid/pid ancestry, **fail-closed** if any gate cannot be established (`docs/cua-permission-broker/zcode-cua-permission-broker.md:25`). C# `windows-browser-import-helper` (in-repo): explicit pipe DACL + single server instance (`packages/desktop/native/windows-browser-import-helper/Program.cs:1031-1057`), `GetNamedPipeClientProcessId` + exact-pid + image-path verification (`:1095-1127`, P/Invoke at `:1523`), one-shot 32-byte token compared with `FixedTimeEquals` (`:1213-1217, 1249-1262`) |

**Honest upstream state (what the architect's re-review found):** no
**TypeScript** broker in the repo performs OS peer verification — zero
`getPeerCredentials`/`SO_PEERCRED` occurrences in any `.ts` file; all TS brokers
are token-only (the official-command endpoint's token check is a plain Map
lookup, `endpoint.ts:85-88`, not even timing-safe). On Windows, the CUA peer
gate is **temporarily open** upstream (`WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN`
— "Windows 上任何本机进程都能连这条 named pipe",
`docs/cua/windows-source-development.md:93-101`). The previous revision's
labeling of OS peer verification as simply "not in upstream — ours to build"
was therefore imprecise: upstream has real peer-verification precedents, but
they are **native** (macOS Helper, C# helper), and the TS-broker token-only
posture — including the currently open Windows CUA gate — is exactly what
PaySwap must not inherit for a financial broker.

**New PaySwap requirements (not in upstream TS brokers — ours to build and
prove):**

1. **Per-process-instance credentials.** Each PaySwap MCP server *instance*
   receives its own broker token at spawn; token lifetime = process instance
   lifetime; one instance's token never validates another. Delivered only via
   the trusted config-injection path (§3.3); stripped from every other child
   environment by the sanitization discipline (`runtimeEnv.ts:64-76`). N20.
2. **OS peer verification, fail-closed.** Unix: peer credentials (pid/uid) read
   on connect — via the runtime's peer-credentials API where the runtime
   exposes it, else a small native helper — with the pid verified against the
   host's own spawn table (`McpTrackedProcess`/`listProcesses()` + the
   transport's recorded child pid, `stdio-transport.ts:91-93`) and the uid
   required to equal the host's. Windows: client-pid verification and explicit
   pipe DACLs **require native support** — Node/libuv expose neither
   `GetNamedPipeClientProcessId` nor DACL control; the in-repo C# helper is the
   implementation model (`Program.cs:1031-1057, 1095-1127`). **Fail-closed rule
   (the macOS Helper's own rule): where peer identity cannot be established on
   a platform, the broker refuses connections on that platform — a token-only
   fallback is not acceptable for money.** The peer check happens before any
   payload parsing; unknown pids are dropped; a plugin identity claim on the
   wire is never sufficient by itself.
3. **Socket filesystem permissions.** The socket lives in a host-private
   per-boot directory (`mkdtemp`, `0700`, socket `0600`) — **adopting the
   official-command endpoint's placement precedent**
   (`endpoint.ts:60-65`), not the browser broker's shared-`tmpdir()` placement.
4. **Windows named-pipe ACLs.** Pipe DACL restricted to the current user's SID —
   no NULL DACL, no broader grants — via the native helper (precedent:
   `Program.cs:1031-1057` — `PipeSecurity` + `SetAccessRuleProtection(true,
   false)`, `maxNumberOfServerInstances: 1`). *Correction: the previous
   revision cited `windowsCuaDevHelperHost.ts` as evidence that "upstream ships
   named pipes" — that dev helper creates pipes with default security and no
   DACL; the genuine in-repo DACL precedent is the C# browser-import helper.*
5. **Process/plugin/session binding.** A broker connection is bound to
   (verified pid → host-registered plugin instance → session scope). The
   session scope is re-resolved authoritatively downstream
   (`requireSession`-pattern, `server-types.ts:334-347`) — never taken from the
   request payload.
6. **Endpoint replacement protection.** Per-boot random path (upstream
   `:89-94`) **in** the private directory (item 3): the host removes or refuses
   an existing file at the path, and delivers the path only via trusted config
   injection. An attacker cannot pre-plant a socket at the path the host will
   use (UUID entropy + `0700` directory), cannot replace the host's listening
   socket while the host holds it, and a stale socket from a crashed host dies
   with the private-directory lifecycle. We do **not** adopt upstream's stable
   process-lifetime CUA pipe name (`stableCuaTransport.ts:19-22`) — a fresh
   per-boot path is required. N22.
7. **Replay resistance.** Timing-safe token comparison + the
   one-request-per-connection protocol (upstream) **plus** a per-request unique
   id with dedupe inside the connection lifetime (per-call ledger-token
   precedent, `call-ledger/ledger.ts:49`): a replayed request id is rejected.
   N21 covers the closed dispatch table; N19 the impostor config; N20 the
   cross-instance token.

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
| **Desktop, single user** (P0–P6 default) | the desktop host process | local `node:sqlite` file — own DB file, WAL + `BEGIN IMMEDIATE`, **lease-based authority lock** (§4.6; the bot-runtime-lock precedent, `channelRuntime.ts:153-238`); versioned migrations (repo precedents: `packages/services/src/session/taskIndexRepo.ts:398-402, 766-767`, `tasksDatabase/migrations.ts:62-121`) | Single writer process ⇒ **no concurrent writers by construction**. This is the single-user audit journal + saga journal + evidence store. |
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
  refuses to load, fail-closed. The same verification runs before a lease
  takeover resumes writes after a crash (§4.6).
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
(`packages/services/src/session/taskIndexRepo.ts:398-402, 766-767`) serialize
writers (the tasks index is explicitly shared by multi-window hosts within one
machine — SQLite's own file locking prevents *physical* corruption); the
`withFileLock` utility (`packages/services/src/credential/credentialService.ts:105,146,159`;
defined in `packages/shared/src/node/privateFilePersistence.ts:51-86`) is an
advisory per-operation lock. Neither is a multi-host mechanism, and PaySwap does
not pretend otherwise. Note also what SQLite cannot do here even when it
physically serializes writers: two authoritative hosts on one file would still
interleave **two hash chains** — physically serialized, semantically divergent.
The application-level lock below enforces single **authority**, which SQLite
alone cannot.

**The verifiable single-writer mechanism — a lease-based authority lock
(corrected).** The previous revision described "`withFileLock`, held long-lived".
That description was imprecise about the mechanism and not implementable as
stated: `withFileLock` is strictly per-operation — release is bound to the
awaited callback's completion (`privateFilePersistence.ts:75-85`), it has no
acquire-then-release-later API, and a parked long hold would starve every other
writer past its default 8 s budget (`DEFAULT_LOCK_MAX_WAIT_MS`,
`atomicFileLock.ts:238-248`). The correct upstream precedent for a
lifetime-held single-writer lock is the **bot channel runtime lock**
(`packages/services/src/bots/channelRuntime.ts:153-238`): a lock directory whose
`owner.json` (`{pid, botId, nonce, createdAt}`) is written in a temp dir and
atomically renamed (`:161-178`), a **heartbeat lease** — 10 s heartbeat / 30 s
TTL (`:7-10`) — stale takeover only when the owner pid is dead or the lease
expired (`:189-203`), and an explicit `release()` (`:220-232`); it is held for
the whole runtime-loop lifetime (`telegramChannelRuntime.ts:104-138` — "Telegram
long polling is handled by another ZCode window").

PaySwap's ledger authority lock follows that pattern, hardened for money:

- **Acquisition (boot):** the process that will run the authoritative ledger
  repository acquires the lock at financial-services boot, within a bounded boot
  budget. Failure to acquire = typed `ledger_authority_unavailable`,
  **financial services do not start** — fail-closed, surfaced in diagnostics;
  never a degraded second writer, never a silent read-only fallback unless the
  process was explicitly deployed as a replica (§4.2 — replicas have no write
  code path reachable at all, asserted by N24).
- **Hold:** heartbeat for the process lifetime; explicit release on shutdown.
- **Crash recovery:** takeover only after the lease TTL expires or the owner pid
  is dead — **and the chain verifier (§4.4) must pass before the first
  post-takeover write**. A takeover without verification is prohibited.
- **In-process discipline:** within the authoritative process, ledger writes use
  the SQLite discipline upstream already ships for the tasks index: WAL +
  `busy_timeout` + `BEGIN IMMEDIATE` transactions (`taskIndexRepo.ts:398-402,
  766-767`) and versioned checksummed migrations (`tasksDatabase/migrations.ts:62-121`).
- **`withFileLock`'s actual role:** short cross-process read-modify-write around
  ledger *file maintenance* operations (export, backup) — its designed
  per-operation contract, unchanged.

**Deployment scope of the lock (who may hold it, per topology):**

| Deployment | Lock holder | Notes |
|---|---|---|
| Desktop, single user | the desktop host process (the services host) | the desktop app is single-instance by upstream design (`app.requestSingleInstanceLock`, `packages/desktop/src/main/index.ts:2101-2139`), so exactly one candidate exists; the CLI adapter process never opens the ledger (no write path) |
| Server-hosted workspace | the server host process — one lease per ledger file (keyed by DB path) | webhook ingress is in-process (deliverable 06 §2.10); a second server process against the same root refuses |
| Horizontal / multi-instance against one SQLite file | **nobody — prohibited** | refused by the lease (N23); stated in deployment documentation |
| Hosted multi-user | n/a (PostgreSQL topology) | the lease is SQLite-topology-specific; PostgreSQL provides its own concurrency control — and that topology additionally requires authenticated principals (§4.5) before any live operation |

**Verification is a test, not a claim:** N23 starts two host processes against
one ledger DB and asserts the second refuses within the boot budget (typed
failure, no financial services); the crash-recovery arm of N23 kills the lease
holder and asserts (a) no other process acquires before the TTL, (b) takeover
after TTL runs the chain verifier before the first write. N24 asserts the
replica's write path is rejected at the repository, not by convention.

**Deployment consequence:** the initial server deployment is
**single-authoritative-host and single-writer** — enforced by the lease, stated
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

Revision 2 (R1–R4 round):

| Deliverable | Amendment |
|---|---|
| 05 §9 | Refusal-code taxonomy (`financial_mode_disabled` / `not_opted_in` / `not_connected`, addendum §2.1) + per-process-instance broker credentials and OS peer verification (addendum §3.5) + N-row reference updated to §1.7 |
| 06 §2.12 | Ledger single-writer enforcement: lifetime lock-file mechanism, multi-instance prohibition, N23/N24 (addendum §4.6) |
| 07 §1.2/§3 | N-matrix reference updated to §1.7; opt-in path (§2.1) and transition tests T1–T6 (§2.2) added to the acceptance criteria |
| 10 P1 | Adds transition tests T1–T6, approval-origin rows N13–N18, broker rows N19–N22, per-instance credential + peer-verification scope |
| 10 P7 | Adds ledger rows N23–N24 and the explicit hosted/horizontal live-operation precondition |

Revision 3 (this commit — second R1–R4 round):

| Deliverable | Amendment |
|---|---|
| 07 §1.3/§3/§4 | **Card-class partition applied** (the previous text listed authorization-request cards among the plugin-webview `ui.surfaces[]` cards — the direct conflict with §1.6, corrected): Class A informational cards ride the plugin surface; the authorization card is host-rendered (§1.6.0). State model updated to S0a/S0b/S1/S2 with the delta-equivalence oracle; T1–T6 restated with live-vs-session timing and residual-session semantics |
| 03 §5 | The plugin plan now states `ui.surfaces[]`/`_meta.ui` cards are informational only; authorization-styled declarations are rejected at manifest validation (N25) |
| 05 §9 | Refusal-taxonomy reachability fixed (`financial_mode_disabled` = the broker's refusal for residual calls from sessions predating a disable/uninstall — not a steady-state S0 tool code, where no tool exists to return it) |
| 06 §2.12 | Single-writer mechanism corrected to the lease-based authority lock (bot-runtime-lock precedent; §4.6) with the deployment-scope table; `withFileLock` re-scoped to per-operation file maintenance |
| 06 §3 | Diagram note: approval actions (`UI → AUTHZ`) originate exclusively from the host-rendered authorization card (§1.6.0 Class B) |
| 10 P1 | Approval-origin rows extended to N13–N18 **+ N25–N28**; the S1 zero-diff claim replaced by delta-equivalence; the Windows native peer-verification scope (client-pid + pipe DACL helper, fail-closed) made explicit |
| 08 §4 | The P1 "New Task layout zero-diff proof … with the plugin installed vs. not" — the same S1-vs-S0 zero-diff claim the architect rejected — replaced by the state proofs (S0a/S0b-vs-upstream + S1 delta-equivalence) |
| 10 P7 | N23 expanded with the crash-recovery arm (no takeover before TTL; chain verification before the first post-takeover write); single-writer wording aligned to §4.6 |

## §7. What this addendum deliberately does not change

The extension strategy, the preservation matrix, the financial domain decomposition
(deliverable 06 §2), the provider contract (deliverable 05), the evidence-or-refusal
law, the routing taxonomy, the mission invariants, and the P1→P9 sequence all stand
as submitted. No ZCode surface is replaced; every mechanism above is additive and
anchored to a precedent already shipped in the codebase at `a9fe401`.
