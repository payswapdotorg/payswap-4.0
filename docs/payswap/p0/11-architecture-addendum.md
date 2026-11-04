# PaySwap P0 — Architecture Addendum (response to the P0 architect review)

**Owner:** TL · **Status:** normative for P1+ · **Revision:** 5 — incorporates
the architect's fourth R1–R4 review round on top of revision 4 (four focused
implementation-contract corrections: disposal of already-rendered surfaces on
opt-out in §2.3; the contiguous-watermark replay algorithm in §3.5.7; the
two-level credential handshake, operator-credential lifecycle, and
workspace-scoped roles in §1.6.3; the owner/nonce/generation-checked lease
release in §4.6) · **Reviewed against:** worktree `a9fe401` (v3.17.2) ·
**Responds to:** the architect reviews of PR #2 (changes-requested before
merge).

**What revision 5 adds (the architect's fourth R1–R4 round — one focused final
correction per area, revision 4's architecture preserved):** §2.3 + T7 extend
opt-out revocation from *stopping future data delivery* to **removing what was
already rendered** — host-controlled disposal or replacement of every
PaySwap-tracked surface instance that has rendered protected account data
(upstream's own teardown discipline: bounded cleanup window, then
`disposeSandbox` by captured handles), plus clearing the per-key renderer-side
retention that would otherwise restore stale content on reopen; §3.5.7
corrects the replay algorithm to a **contiguous watermark plus a retained set
that keeps completed-but-uncovered sequences recorded** until the watermark
advances past them, with a bounded maximum sequence gap; §1.6.3 items 7–9
specify the **two-level `/ws` credential handshake** (deployment Bearer header
+ operator header or short-lived session cookie; the URL query transport
disabled on financially-enabled deployments), the **operator-credential
lifecycle** (format, digest-only storage, rotation with grace window,
immediate revocation, non-exposure rules), and **workspace-scoped role
bindings**; §4.6 preserves the upstream lock's **owner/nonce-checked release**
(`channelRuntime.ts:220-232`) with the fencing generation added to the
authority validation, so a stale holder cannot delete a successor's lock. New
negative rows N39–N42; T7 strengthened to assert both arms; all existing
N1–N38 and T1–T6 criteria stand unchanged.

**The revision-4 record (kept):** revision 4 added the server principal model
and desktop main-frame/origin sender validation (§1.6.2–§1.6.3),
broker-instance replay protection and the authenticated Windows helper relay
(§3.5.7–§3.5.9), opt-out host-side revocation (§2.3), and the fenced-lease
ledger authority with explicit authoritative-instance configuration (§4.6),
with rows N29–N38 and T7. The architect accepted it as a substantial
improvement and requested the four focused corrections above — no
architectural redesign.

**The revision-3 finding (kept for the record):** revision 2 required that
authorization cards never render in a plugin webview (§1.6) while
simultaneously listing authorization-request cards among the `ui.surfaces[]`
plugin-surface cards (§2, deliverable 07 §1.3). That was a direct conflict
inside our own documentation. §1.6.0 resolved it with a two-class surface
model, and every affected document was amended in this PR.

This addendum resolves the gaps the architect identified across four review
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
3. **Sender verification, per topology (R1 — strengthened to the expected main
   frame and the trusted application origin).** Desktop: the approval event
   must arrive over the main window's service port — the port-delivery
   discipline (§1.6.1) means only that window's webContents holds a transport
   — and the host applies **three** checks on the approval channel, two
   upstream-precedented and one assembled from upstream disciplines:
   - **Expected webContents:** `event.sender.id` equals the webContents id the
     host recorded when it issued the challenge (upstream precedent:
     `webRemoteControlRendererReconnect.ts:33-36`).
   - **Expected main frame:** `event.senderFrame === event.sender.mainFrame` —
     the event must originate from the window's main frame, not a subframe
     (upstream precedent: the browser-local-preview navigation owner check,
     `packages/desktop/src/main/browser-local-preview/index.ts:124-130` —
     `win.webContents !== event.sender || event.senderFrame !==
     event.sender.mainFrame` ⇒ "Browser navigation owner mismatch").
   - **Trusted application origin:** the sending frame's URL must be the
     application shell's own trusted origin (upstream discipline: capturing and
     checking `event.senderFrame?.url` before acting on security-sensitive IPC —
     `packages/desktop/src/main/index.ts:380-385`,
     `packages/desktop/src/main/desktopMainIpcRemote.ts:362-366`). Explicitly
     **not** accepted: any plugin-sandbox origin
     (`zcode-sandbox://plugin-<appIdentity>/…`, `protocol.ts:205-255`), any
     `ui://` resource origin, any remote or unknown origin. This composition is
     a **new PaySwap requirement** — upstream checks frame URLs per surface but
     has no approval channel to protect; PaySwap applies the disciplines to
     one.
   All three checks must pass; any failure rejects the event with no grant
   (N13 extends to frame and origin failures). Server deployments: item 5 and
   §1.6.3.
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
   resolve an approval — N28. Item (b) authenticates the *connection*; which
   human is acting on it is a different question — that is the
   operator-principal model of §1.6.3 (R1's core distinction).

#### 1.6.3 Server principal model (R1 — server authentication is not operator identity)

**What upstream actually has (verified at `a9fe401`) — none of it is an
operator identity:**

| Mechanism | Source | What it is — and is not |
|---|---|---|
| Optional shared auth token (Bearer / `?token=` / HttpOnly cookie) | `packages/server/src/entry-http.ts:21,39`; `hasValidLiteToken` (`packages/server/src/http.ts:245-262`); middleware `:353-363` | **Deployment authentication.** It proves a client holds the deployment's single shared token. It does not distinguish humans: no per-operator credential, no expiry, no revocation, no roles. The auth middleware registers only when a token is configured — with none, `/ws` and `/api/*` are unauthenticated (`authRequired` in the server-info payload at `http.ts:190` is advertising, not enforcement). |
| Per-connection identity | `createZCodeAgentConnectionScope` with `connectionId: server-ws-${randomUUID()}` and a role derived from the client mode (`trusted-host-relay` / `terminal-client`) — `http.ts:112-116` | A random **connection** id and a transport-mode **role**. Stable for neither: a reconnect is a new id; neither names a human. |
| Downstream session resolution | `requireSession` (`server-types.ts:334-347`) | Session-runtime lookup for protocol operations — a session, not a principal. |

**The decision, stated as law:** *server authentication* (the transport-level
token / authenticated connection — upstream) and *authenticated operator
identity* (which human principal is acting — PaySwap's addition) are different
things, and **only the second may appear in a grant.**

1. **Operator registry and per-operator credentials (new PaySwap requirement).**
   A PaySwap-enabled server deployment provisions operators as a server-side
   admin action: each operator receives an individual credential — never the
   shared server token, never a client-chosen id. The registry is server-host
   state; credentials are verifiable server-side.
2. **Operator sessions and the stable principal (new).** An operator session is
   an authenticated `/ws` connection whose upgrade completed the two-level
   credential handshake (item 7) with a valid operator credential. The server
   resolves the **principal** from the credential
   server-side and binds it to the connection's session state for that
   connection's lifetime. The principal is a stable server-assigned identifier:
   a reconnecting operator presents the credential again and resolves to the
   same principal; the per-connection `server-ws-*` id is never the principal.
3. **Approval events bind the server-resolved principal (new).** Every grant
   records the principal that approved it. A challenge is issued to one
   operator session's interaction stream and records the issuing session's
   principal; upstream's `resolveInteraction` is first-come-first-served with
   late resolution a noop (`command.ts:223` — "先到先得，晚到 noop"), and PaySwap
   additionally requires that a resolution arriving on a session whose
   principal differs from the issuing session's is rejected as an impersonation
   attempt (N29), not resolved.
4. **Client-supplied operator ids are never identity (law, with the mechanism).**
   The principal is read exclusively from the server-side session state keyed
   by the credential. An `operatorId` / `principal` / `onBehalfOf` field in any
   request payload is ignored — and a payload attempting to name a principal
   other than the authenticated one refuses the request (N32). There is no code
   path from payload to principal.
5. **Server-side financial roles (new — and workspace-scoped, item 9).** The
   proposer / approver / auditor /
   viewer roles (deliverable 06 §4) are enforced at the service boundary before
   approval processing and before any money-affecting operation: an
   authenticated operator without the approver role **for the target
   workspace** cannot mint a grant (N31, N41).
   The check is server-side, never in the UI.
6. **Expiry, revocation, and cross-user isolation (new).** Operator sessions
   carry a bounded, deployment-configured lifetime; revocation is a server-side
   admin action that invalidates the credential immediately — pending
   challenges issued to a revoked or expired principal are invalidated at
   revocation/expiry, and a resolution arriving on such a session is rejected
   (N30). Cross-user isolation: challenges are single-use and bound to one
   pending proposal **and** the issuing session's principal; one operator's
   session cannot resolve, inspect, or mint another's (N29); ledger
   authorization records name the principal, so post-hoc audit is unambiguous.
7. **The two-level credential handshake (R1 — the credential transport,
   specified).** How the `/ws` upgrade authenticates **both** levels,
   concretely:
   - **Level 1 — deployment.** The upgrade request carries the deployment's
     shared token in the `Authorization: Bearer` header — the transport
     upstream's middleware already implements (the `hasValidLiteToken` Bearer
     branch, `packages/server/src/http.ts:247-252`; the middleware guards
     `/ws` and `/api/*` with a 401, `:353-363`). PaySwap additionally
     **disables upstream's `?token=` query branch** (`:253-258`) on
     financially-enabled deployments: it is the one URL-borne transport, and
     no credential of either level may appear in a URL (proxy and access
     logs). A financially-enabled deployment without a configured token
     already fails closed (N27).
   - **Level 2 — operator.** Exactly two transports, both header/cookie-borne.
     Native operator clients (the PaySwap desktop/web approval clients)
     present the per-operator token in an `X-PaySwap-Operator-Token` request
     header on the upgrade. Browser clients that cannot set WebSocket
     request headers first exchange the token over an authenticated HTTPS
     request (`Authorization: Bearer <operator token>` on the
     operator-session endpoint), which mints a short-lived
     (deployment-configured, default 15 min), single-purpose, **HttpOnly +
     SameSite=Strict** session cookie — the upgrade then presents that
     cookie. Cookie-attribute precedent: upstream's lite-token cookie is
     already HttpOnly (`http.ts:254-258`); PaySwap tightens `SameSite=Lax` to
     `Strict`, scopes the path to the operator-session purpose, and bounds
     the lifetime to minutes. The cookie authenticates level 2 only; it
     never substitutes for the level-1 Bearer token.
   - **Order and failure semantics.** The deployment token is validated first
     (401; the operator credential is not yet read); operator resolution is
     second and fails with a single generic `operator_authentication_failed`
     — unknown, expired, rotated-out, and revoked credentials are
     indistinguishable to the caller, defeating token enumeration. On
     success the connection is bound to (deployment, principal, role
     bindings, session expiry) and every frame on it acts as that principal.
8. **Operator-credential format, storage, rotation, and revocation (R1).**
   - **Format:** `pso_<version>_<base64url>` covering 32 bytes of CSPRNG
     output (the `randomBytes(32)` broker-token discipline,
     `node-repl-browser-broker.ts:32`) — high-entropy by construction, so
     the registry stores only `sha256(token)` for keyed lookup, compared
     constant-time (the `timingSafeEqual` discipline, `:165`). The
     plaintext is displayed exactly once, at provisioning.
   - **Storage:** the server host's private state directory under the
     upstream private-persistence file discipline (`0600`, atomic rename —
     `packages/shared/src/node/privateFilePersistence.ts`) — never the
     ledger (credentials are not financial evidence), never a repo file,
     and never the shared token's env slot.
   - **Rotation:** an admin- or operator-initiated rotation issues a new
     token and marks the old one rotating with a bounded grace window
     (default 24 h, deployment-configured). Both tokens authenticate during
     the window; every old-token authentication emits an audit record; at
     window end the old token is revoked, all sessions it authenticated are
     closed server-side, and their pending challenges are invalidated
     (item 6).
   - **Revocation:** immediate — the token's digest record is flagged
     revoked, the principal's active sessions are marked revoked and their
     connections closed, and pending challenges issued to those sessions
     are invalidated. N30 is the session-level arm (a resolution arriving on
     an expired/revoked session); N40 is the credential-level arm (an
     upgrade attempt with a rotated-out or revoked token refuses before any
     session exists).
   - **Non-exposure (the architect's rule):** operator tokens never appear in
     URLs (item 7's transports are header/cookie only), are never logged
     (server logs record only the token's record id, never a value), and
     never enter model context or any MCP child / broker / plugin
     environment — they exist solely between the operator's approval client
     and the server's auth middleware. The env-sanitization backstop
     (`runtimeEnv.ts:64-76`) never even needs to strip them: they are never
     placed in any environment variable at all.
9. **Workspace-scoped role bindings (R1 — roles attach to bindings, not to
   operators).** The proposer / approver / auditor / viewer roles are
   properties of the **(operator, workspace/ledger) binding**, not of the
   operator alone. The registry stores `operatorId × ledgerId → roles`; the
   item-5 service-boundary check evaluates the roles bound to the **target
   workspace of the operation** — resolved server-side from the authoritative
   session scope, never from a client-supplied workspace field. An approver in
   workspace A holds no role in workspace B unless explicitly bound there; an
   unbound operator's approval attempt refuses (N41). Approval events record
   the triple (principal, workspace, role used), so post-hoc audit is
   unambiguous across workspaces. P0–P6 deployments carry one logical ledger
   per deployment (§4.2), but the binding-scoped schema exists from day one —
   multi-workspace support later requires no semantics migration, and no
   cross-workspace role inheritance ever exists to remove.

**Labels:** the fail-closed server posture, the exposure policy, and the
authenticated-channel requirement are §1.6.2 item 5 (upstream mechanisms,
PaySwap policy). The Bearer-transport and HttpOnly-cookie disciplines of the
item-7 handshake are upstream mechanisms (`http.ts:247-262`); composing them
into a two-level upgrade handshake, disabling the query transport on
financially-enabled deployments, and the short-lived operator-session cookie
are **new PaySwap requirements**. The operator registry, per-operator
credentials, stable principals, financial roles, expiry/revocation/isolation,
the credential lifecycle (item 8), and the workspace-scoped role bindings
(item 9) are **new PaySwap requirements with no upstream equivalent** —
upstream's server has no operator-identity mechanism at all; the verified
table above is the evidence. They gate P1 alongside N27/N28 (the same server
boundary), before any server-side approval is trusted.

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
| N13 | any session | forged renderer approval event (wrong webContents/sender, non-main frame, or untrusted frame origin) | approval rejected; no grant created (§1.6.2 item 3) |
| N14 | valid proposal pending | card-content deviation — a payload (or forged frame) presenting amount/recipient/legs differing from the host-side proposal record | host recomputes the digest from its own state → mismatch → approval rejected; independently, the rendered payload is host-derived (§1.6.0) and asserted byte-equal to the proposal record (§1.6.2) |
| N15 | valid proposal pending | replayed approval challenge (already consumed, expired, or belonging to another proposal) | rejected; no grant (§1.6.2) |
| N16 | any session | approval event originating from a plugin webview | cannot reach the approval channel (no transport, no challenge); asserted refused end-to-end (§1.6.2) |
| N17 | any session | model-generated text claiming the user approved | not an event; no grant path exists; assertion: no grant record after model text (§1.6.2) |
| N18 | after card/instance teardown | stale capability handle replayed | handle rejected (upstream `pluginUiHostTeardown` discipline); no effect on newer pages (§1.6) |
| N19 | any config | impostor MCP config with copied PaySwap names/commands/env but not the official plugin registration | no broker credential; cannot connect; tools unreachable (§1.5/§3.3) |
| N20 | two live instances | second PaySwap MCP server instance presenting the first instance's token | per-instance credential mismatch → connection refused (§3.5.1) |
| N21 | any broker session | request naming an operation outside the six `payswap_*` operations | closed dispatch table → refused, no host-service reach (§3.3/§3.5) |
| N22 | after host restart | connection to a stale/pre-planted socket path | endpoint replacement protection: fresh per-boot path, unknown peer → dropped (§3.5.6/§3.5.2) |
| N23 | two host processes, one ledger DB | second process opened against the same SQLite ledger | lease-based authority lock: fails within the boot budget — typed `ledger_authority_unavailable`, financial services do not start, never a second writer (§4.6); crash arm: after `kill -9` of the holder, no process acquires before lease TTL, and takeover runs chain verification before the first write |
| N24 | read-only replica | ledger write attempted | rejected at the repository, not by convention (§4.6) |
| N25 | plugin load | manifest declaring an authorization-styled surface in `ui.surfaces[]`, or a tool with `_meta.ui` naming one | manifest validation rejects the declaration; plugin does not load with it (§1.6.0) |
| N26 | any session | approval-resolution attempt arriving via the plugin-UI callback path (`mcp/uiCallTool`) or any `ui://` interaction | not an approval channel: no grant can originate; asserted refused end-to-end (§1.6.2) |
| N27 | server deployment | financial mode requested but no `ZCODE_SERVER_AUTH_TOKEN` configured | financial services fail closed at activation (§1.6.2) |
| N28 | server deployment | approval resolution from a client without a valid authenticated session (or excluded by the PaySwap exposure policy) | rejected; no grant (§1.6.2) |
| N29 | server deployment, two operators | operator B's session attempts to resolve the challenge issued to operator A's session (cross-user approval / impersonation) | rejected — the challenge is bound to the issuing session's principal (§1.6.3); no grant |
| N30 | server deployment | approval resolution from an expired or revoked operator session | rejected; pending challenges issued to that principal were invalidated at expiry/revocation (§1.6.3); no grant |
| N31 | server deployment | approval resolution by an authenticated operator whose financial role is not approver | refused at the service boundary — server-side role enforcement (§1.6.3); no grant |
| N32 | server deployment | request payload carries a client-supplied operator id that differs from the authenticated principal | payload field never used as identity; grants bind the server-resolved principal only; naming another principal refuses the request (§1.6.3) |
| N33 | broker, new connection | request id already dispatched on an earlier connection of the same broker instance | rejected before dispatch — dedupe scope is the broker instance, not the connection (§3.5.7) |
| N34 | broker session, after reconnect | the same request (same instance id + sequence number) re-sent after the connection dropped and was re-established | rejected before dispatch — the per-instance seen-record survives connection changes (§3.5.7) |
| N35 | broker, concurrent duplicates | two connections present the same request id simultaneously | exactly one dispatches; the other is rejected before any host-service call (§3.5.7) |
| N36 | ledger authority, after takeover | the previous holder (paused past the lease TTL, takeover completed) resumes and attempts a write | refused at the repository boundary — its fencing generation is below the ledger's current generation; typed `ledger_authority_lost`; hash chain unaffected (§4.6) |
| N37 | two host processes, one ledger DB | simultaneous lease acquisition attempts | exactly one acquisition wins (atomic-rename primitive); the loser fails closed within the boot budget (`ledger_authority_unavailable`); the generation is incremented exactly once (§4.6) |
| N38 | any ledger write | writer presenting a stale fencing generation (any generation below the ledger's current value) | refused inside the write transaction at the repository boundary, before any record is appended (§4.6) |
| N39 | broker, out-of-order completion | with the watermark at 10 and sequence 11 outstanding, sequence 12 is accepted, dispatched, and completes; then a replay of 12 arrives (same or new connection) **before 11** | rejected before dispatch — completed-but-not-yet-covered sequences remain recorded above the watermark until it advances past them (§3.5.7); no second dispatch |
| N40 | server deployment | `/ws` upgrade presenting a rotated-out (past grace) or revoked operator token | refused at the handshake with the generic `operator_authentication_failed` — no session established; a session already open on a token revoked mid-flight is closed server-side and its pending challenges invalidated (§1.6.3 items 7–8) |
| N41 | server deployment, operator bound as approver in workspace A only | approval attempt targeting workspace B (unbound) | refused at the service boundary — roles are (operator, workspace) bindings, never global (§1.6.3 item 9); no grant |
| N42 | ledger authority, after takeover | the previous holder resumes and attempts to release or delete the successor's lock (graceful release or lock-directory removal) | release is a no-op — the ownership check (pid + instance id + nonce + fencing generation) fails against the successor's owner record; the successor's lock, lease, and subsequent writes are unaffected (§4.6) |

N10–N12 run in P7 when execution lands; N1–N9 are executable against the refusal
path as soon as P1's tool surface exists (the refusal logic is present from day one).
N13–N18 gate P1 (approval-origin boundary) together with the tool surface;
N19–N22 gate the P1 broker bridge; N23–N24 gate the P7 ledger; **N25–N28 gate P1
with the approval-origin rows** (N25 manifest validation, N26 plugin-callback
path, N27 unauthenticated server, N28 unauthenticated client); **N29–N32 gate
P1 with the server-principal rows** (§1.6.3: cross-user resolution,
expired/revoked session, insufficient role, forged client operator id);
**N33–N35 + N39 gate the P1 broker bridge alongside N19–N22** (replay on a new
connection, after reconnect, concurrent duplicates, and the out-of-order
completed-request replay — the retained-set arm of §3.5.7);
**N40–N41 gate P1 with the server-principal rows** (§1.6.3 items 7–9:
credential-lifecycle refusal at the handshake, cross-workspace role use);
**N36–N38 + N42 gate the P7
ledger alongside N23–N24** (stale-holder write after takeover, simultaneous
acquisition, stale-generation write, and the stale holder's release of the
successor's lock refused by the owner/nonce/generation check). Every "refuse"
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
transitions: **enable** (S0b→S1), **opt-in** (S1→S2), **opt-out** (S2→S1 —
immediate host-side revocation, §2.3), **disable** (S1→S0b or S2→S0b),
**uninstall** (any → S0a).

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
| T3 | opt-out (S2→S1) | refusal codes revert immediately; plugin-UI surfaces disappear per the upstream session lifecycle; no authorization card renders (the broker refuses to create proposals — no card can be pending); surfaces already open at the moment of opt-out follow §2.3's immediate revocation semantics — asserted end-to-end by T7 |
| T4 | disable (→S0b) | new sessions identical to upstream's disabled state (no PaySwap runtime components); running sessions keep their frozen tool surface (upstream behavior, unchanged — PaySwap adds no teardown it doesn't own) but money operations refuse `financial_mode_disabled` via broker-binding revocation; interface otherwise upstream |
| T5 | uninstall (→S0a) | interface identical to upstream not-installed; plugin config and userConfig removed by the existing uninstall flow (`plugins.ts:783-817`; `file-config.adapter.ts:318-325` removes both `enabledPlugins[id]` and `options[id]`); connection credentials deleted via the revocation flow (deliverable 05 §5); **ledger evidence retained** per its own retention rules — financial audit records are never destroyed by a UI uninstall — or exported-then-deleted by explicit operator choice; same residual-session semantics as T4 |
| T6 | settings page | the existing plugin settings surface renders the PaySwap entry exactly like any other plugin — zero settings-page modification beyond the plugin's own declared options |
| T7 | opt-out while an informational surface and an authorization proposal are already open (S2→S1, live surfaces) | **host-side revocation, immediate (§2.3) — both arms asserted:** (a) *future data delivery stops* — the surface's data queries refuse `not_opted_in`, never stale balances; and (b) *already-rendered protected content is gone* — every Class-A instance that has rendered protected account data is disposed or replaced by the host (its DOM and JavaScript context no longer exist; the replacement instance is fresh, dataless, and renders the disabled state), and its per-key renderer-side retention (feed snapshot, widget state) is cleared, so reopening the surface cannot restore stale data; the surface is non-actionable (every action routes through the broker and refuses); the pending grant proposal and its one-time challenge are invalidated at the transition — an approval click after opt-out is rejected (no live challenge) and the authorization card dismisses; new sessions follow the updated state; the upstream plugin lifecycle is untouched (the plugin remains enabled — S1 — and no upstream-owned teardown runs) |

Deliverables 07 §3 and 10 (P1/P5 acceptance) are amended accordingly in this PR.

### 2.3 Opt-out with existing surfaces — host-side revocation (R3)

The per-session surface lifecycle (above) governs what *new* sessions render,
but an opt-out must also be effective **immediately**, against surfaces that
are already open — **including the data they have already rendered**. The
rule: **revocation authority lives in the host, never in the plugin and never
in the surface, and no guarantee depends on the surface's cooperation.**

1. **Existing surfaces must not continue exposing protected account
   information — and what they already rendered must stop being exposed.**
   Two host-side mechanisms, in sequence:
   - **Data-capability revocation (stops future delivery).** Open Class-A
     surfaces are fed by the plugin's MCP server → broker → host services. On
     opt-out the broker's live state flips (§2.1), so every subsequent data
     query refuses `not_opted_in` — the host stops serving protected account
     data to that plugin instance's broker session. This arm alone does
     **not** erase data already delivered, which is why the second arm
     exists.
   - **Disposal or replacement of the surface instance — removes what was
     already rendered (new PaySwap requirement, built on upstream
     mechanisms).** The PaySwap host integration keeps a
     **surface-content registry**: every Class-A surface *instance* it
     renders is tracked by its captured sandbox lease (`sandboxId`/`initId` +
     the plugin `appIdentity` lease triple) together with a
     has-ever-received-protected-data mark. On opt-out, every marked
     instance is torn down **by the host, on upstream's own teardown
     discipline**: a bounded `ui/resource-teardown` cleanup window whose
     expiry proceeds without the page's cooperation
     (`pluginUiHostTeardown.ts:43-54`), then bridge/port close and
     `disposeSandbox(sandboxId, initId)` — the platform-port contract whose
     own documentation states the isolation guarantee
     (`packages/shared/src/mcp-apps/contract.ts:198-203`: disposal releases
     only the captured registration; new pages use new credentials and
     sandboxIds, so a late old disposal cannot touch a new registration).
     Disposal destroys the instance's DOM **and its JavaScript heap** — the
     rendered protected content ceases to exist rather than being refreshed
     away. Where the surface anchor must remain occupied (e.g., the
     financial workspace pane), the host **replaces** the instance: dispose,
     then create a fresh instance on a new lease (new `sandboxId`/`initId`)
     with **no data capability**, rendering the S1 disabled state; the
     fresh instance cannot inherit anything from the disposed one.
     Hidden-but-retained instances are disposed identically — a background
     page is a live page (the retention manager keeps up to four per window
     with a 30-minute idle horizon, `pluginUiBackgroundRetention.ts:8-9`)
     and holds the same rendered data; it is in the registry like any
     other.
   - **Renderer-side retention cleared.** Two upstream renderer stores
     retain per-surface state beyond page close and would otherwise restore
     it on reopen: the feed-snapshot store — whose own contract is that
     closing and reopening a panel still yields the "最后一次成功结果"
     (`pluginUiSurfaceFeedStore.ts:7-13`) — and the widget-state store
     (`pluginUiWidgetStateStore.ts:1-8`). Both expose per-key clear APIs
     (`clearPluginUiSurfaceFeed`, `pluginUiSurfaceFeedStore.ts:43`;
     `clearPluginUiWidgetState`, `pluginUiWidgetStateStore.ts:20`), and both
     are keyed by the workspace/session/plugin/server/resource/scope key
     scheme — on opt-out the PaySwap host integration clears **exactly its
     own surface keys** (its pluginId/server), touching no other plugin's
     entries. After the clear, reopening a PaySwap surface starts from
     empty and its data queries refuse `not_opted_in`.
2. **Existing surfaces must become non-actionable.** Every action a Class-A
   surface offers routes through `payswap_*` tools → broker → refusal. There is
   no host-service path from a plugin surface to a financial operation that
   bypasses the broker (§3.3's closed dispatch table is the structural
   guarantee); non-actionability is therefore inherited from the same live
   state flip, not implemented per-surface.
3. **Pending authorization challenges are invalidated.** All pending grant
   proposals and their one-time challenges are host-owned state (§1.6.2);
   opt-out invalidates them at the transition. An approval event arriving
   after opt-out finds no live challenge — rejected, no grant (the N15
   invalid-challenge rule; T7 asserts it end-to-end). The host-rendered
   authorization card dismisses with the invalidation.
4. **New sessions follow the updated plugin state** — the upstream per-session
   lifecycle (§2) is unchanged and needs no PaySwap help.
5. **Upstream plugin lifecycle semantics are not modified.** Opt-out does not
   disable the plugin (it remains enabled — S1), does not tear down or restart
   its MCP server (upstream owns that lifecycle), and touches no upstream
   surface. Disposal targets **only instances the PaySwap host integration
   itself created and tracked** — the same capability-scoped discipline as
   upstream's own teardown (`pluginUiHostTeardown.ts:6-9`: release by
   captured handles; pages created by newer credentials unaffected); the
   plugin's MCP server process, other plugins' surfaces, and upstream-owned
   surfaces are out of scope by construction. The PaySwap revocation event
   over the plugin-UI data path remains as **best-effort UX** for surfaces
   that never received protected data; **no security property depends on
   it.**

T7 is the acceptance test for exactly this scenario — **both arms**: future
data requests fail, and already-rendered protected data is neither visible
nor recoverable (instance disposed or replaced; retention cleared).

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
7. **Replay protection at broker-instance scope (R2 — corrected: dedupe scoped
   to the connection lifetime is not replay protection).** The architect is
   right that the previous wording ("dedupe inside the connection lifetime")
   established nothing across reconnects: upstream's per-call ledger token is
   valid only while the call entry is open (`call-ledger/ledger.ts:49` —
   "token 每次调用一个，只在条目打开期间有效"), and the one-request-per-connection
   line protocol ends all state at connection close — a reconnected peer could
   replay any prior request id untouched. New PaySwap requirements:
   - **Request identity is (instanceId, seq).** Each request carries the
     calling MCP server instance's id (bound to the per-instance credential,
     item 1) and a **monotonically increasing per-instance sequence number**
     allocated by the MCP child. The pair is unique by construction.
   - **The dedupe scope is the broker instance** — the host process's
     financial-services lifetime — not the connection. Connection drops and
     reconnections do not clear it; a new MCP server instance gets a new
     instanceId and credential, so requests from a superseded instance fail
     the instance check before sequence handling matters. Broker restart
     needs no seen-record persistence for the same reason: a broker restart
     is a host restart, stdio children do not outlive the host, and every
     instanceId of the previous incarnation is therefore superseded — its
     requests fail the instance-credential check (N19/N20 discipline)
     before sequence handling is reached.
   - **The seen-record algorithm (corrected — completed sequences stay
     recorded until covered).** Per instance, the broker keeps a
     **watermark** `W` — the highest sequence such that *every* sequence
     ≤ `W` has been accepted — and a **retained set** `R` of every accepted
     sequence above `W`, **including completed requests**: a sequence
     enters `R` when its request is accepted for dispatch and leaves only
     when the watermark advances past it. A request is a duplicate — and is
     rejected before dispatch — iff `seq ≤ W` or `seq ∈ R`, regardless of
     the original request's eventual outcome (success, failure, timeout):
     *accepted* means accepted for dispatch, and outcome reconciliation is
     the idempotency layer's job (below). The watermark advances only when
     `W+1` has been accepted, then contiguously through `R` (advancement is
     bookkeeping over already-accepted sequences, pruning as it goes). This
     closes the out-of-order gap a bare in-flight set leaves open: with
     `W=10` and sequence 11 outstanding, sequence 12 may be accepted,
     dispatched, and complete — 12 remains in `R` (completed but not
     covered), so a replay of 12 before 11 arrives is rejected before
     dispatch (N39); when 11 arrives it is accepted and the watermark
     advances through 11 and 12 together.
   - **A bounded sequence gap (memory bound + flood defense).** A request
     with `seq > W + G`, where `G` is the deployment-configured maximum
     permitted gap (default 64), is refused before dispatch with the typed
     `sequence_gap_exceeded` — the retained set is bounded by `G`, and a
     peer cannot balloon broker memory by skipping ahead. (The alternative
     — strict in-order dispatch per instance — was considered and rejected:
     it would serialize concurrent requests that legitimately ride separate
     connections; the retained-set algorithm provides the same replay
     guarantee without the serialization.)
   - **Duplicates are rejected before dispatch.** The dedupe check precedes any
     host-service call: a request whose (instanceId, seq) was already
     dispatched — on this connection, a new connection, or concurrently on a
     second connection — receives the typed replay refusal and nothing is
     dispatched. N33–N35, and N39 for the out-of-order completed-request
     replay.
   - **Durable operation-level idempotency for financial side effects stands
     unchanged and complementary** (deliverable 05 §6.3): executor-allocated
     per-leg idempotency keys relayed onto provider-native mechanisms, plus
     the append-only ledger, survive host restarts — a scope the broker table
     deliberately does not claim. The two layers reject different things:
     transport replay (same request id) is refused at the broker; a
     *legitimate* retry after an unknown outcome (new request id, same
     idempotency key) reconciles at the financial boundary without
     double-executing.
8. **The native Windows peer-verification channel (R2 — how the verified client
   PID reaches the Node host).** On Windows the client-pid check lives in the
   native helper (item 2: Node/libuv expose neither `GetNamedPipeClientProcessId`
   nor DACL control). The relay is specified so the verified pid cannot be
   forged in transit:
   - **The helper holds the pipe.** The broker's Windows endpoint is the
     helper's named pipe — explicit DACL restricted to the current user's SID,
     single server instance (`Program.cs:1031-1057`), each client connection
     verified by `GetNamedPipeClientProcessId` + exact pid + image path
     (`:1095-1127`) before any payload is read.
   - **The helper→host channel is authenticated with the helper family's own
     shipped disciplines (upstream precedents, verified):** the host spawns
     the helper only after hash/signature verification and passes its own pid
     (`--parent-pid` + `String(process.pid)`,
     `windowsChromeAppBoundKey.ts:295,316`); the helper binds its pipe and
     one-shot token to that exact parent pid — "broker 侧用启动后拿到的精确
     PID 和随机 token 绑定本次实例" (`Program.cs:125`) — and the token is
     compared constant-time (`FixedTimeEquals`, `:193`; one-shot 32-byte
     token, `:1213-1217, 1249-1262`). The relayed "verified client pid" is
     trustworthy exactly because (a) the helper binary was verified at spawn,
     (b) the helper serves no parent but the spawning host, and (c) the
     host↔helper channel is token-bound.
   - **New PaySwap requirement (labeled):** applying this helper family as a
     broker peer-verification relay. Upstream uses it for browser cookie
     import; the pattern is upstream, the application to the financial broker
     is ours to build and prove.
9. **The complete chain, authenticated end-to-end (R2).** No hop accepts the
   previous hop's word — each hop's identity is established at that hop:
   1. **MCP child → broker endpoint:** per-instance token (item 1); on
      Windows the pipe DACL also bounds who may connect (item 8).
   2. **OS peer verification:** Unix — the host reads peer credentials
      (pid/uid) at the socket; Windows — the native helper verifies client
      pid + image path and relays only verified requests (items 2 and 8).
   3. **Host broker:** the caller's plugin-identity claim is validated against
      the in-memory registry (§1.5) **and** the verified pid is mapped to the
      host's own spawn table — `McpTrackedProcess`/`listProcesses()`
      (`telemetry.ts:33-39, 277-290`) plus the transport's recorded child pid
      (`stdio-transport.ts:91-93`) — the pid must be a live PaySwap MCP server
      child the host itself spawned, holding the credential issued to *that*
      child (N19, N20).
   4. **Registered plugin instance → session scope:** re-resolved
      authoritatively downstream (`requireSession` pattern,
      `server-types.ts:334-347`) — never from the request payload (item 5).
   5. **Money-affecting operations:** the grant id is validated against the
      ledger's grant record and the tuple re-checked before dispatch (§1.3).

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
| **Server-hosted workspace** (`packages/server`) | the **server** host process (webhook ingress already lands there per deliverable 06 §2.10) — **explicitly configured as the authoritative instance** (§4.6) | same local SQLite discipline in P0–P6 | The desktop client participating in that deployment holds **at most a read-only replay replica** of evidence; it never writes authoritative financial state. |
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
| Server-hosted workspace | authenticated operator identity | **the §1.6.3 operator-principal model:** server authentication (shared token, upstream) is not operator identity; the principal is server-resolved from per-operator credentials, bound to operator sessions with expiry/revocation/cross-user isolation; **client-provided operator IDs are never identity** (mission mandate, unchanged — no code path from payload to principal, N32). Role enforcement server-side, before approval processing (N31). |
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

- **Acquisition (boot, serialized by an atomic primitive):** the process that
  will run the authoritative ledger repository acquires the lock at
  financial-services boot, within a bounded boot budget. The acquisition
  primitive is the upstream one: a fully-initialized pending lock directory
  atomically renamed into place (`channelRuntime.ts:172-178` — the upstream
  bugfix comment states exactly why: "先在唯一临时目录写完 owner，再原子
  rename，避免竞争者把尚未初始化完成的锁误判为 stale"; rename conflict
  fails on POSIX, and the Windows EPERM path re-checks staleness,
  `:180-203`). This **serializes simultaneous acquisition attempts**: exactly
  one rename wins; losers observe a fresh lease and fail closed. Failure to
  acquire = typed `ledger_authority_unavailable`, **financial services do not
  start** — fail-closed, surfaced in diagnostics; never a degraded second
  writer, never a silent read-only fallback unless the process was explicitly
  deployed as a replica (§4.2 — replicas have no write code path reachable at
  all, asserted by N24).
- **Fencing generation on every acquisition (new — the split-brain fix).** The
  upstream lock's honest gap, stated plainly: its heartbeat is
  `utimes(leasePath, …).catch(() => undefined)` (`channelRuntime.ts:213-214`)
  — a stale holder whose lease directory was taken over receives **no
  signal** (the heartbeat fails silently; upstream tolerates this for bot
  polling; money may not). PaySwap therefore adds a **fencing generation**: a
  monotonically increasing counter persisted **in the ledger database itself**
  (a meta row — the one artifact every writer must touch). The acquisition
  winner, and only the winner, increments it inside a `BEGIN IMMEDIATE`
  transaction before its first write and holds the resulting generation for
  its lease's lifetime.
- **Generation validation at the repository boundary (new).** Every ledger
  write — inside the same `BEGIN IMMEDIATE` transaction, before any record is
  appended — compares the writer's held generation against the ledger's
  current meta generation. Mismatch (stale holder after takeover;
  pathological double-acquisition) = typed `ledger_authority_lost`, the write
  is refused, the hash chain is untouched. A stale holder therefore **cannot
  write after takeover even though its process is alive and its SQLite
  connection is open** — the check reads the same database the write targets,
  under the same transaction, so it cannot be raced. This is the classic
  fencing-token discipline; SQLite's own locking cannot provide it (see the
  opening of this section: two authoritative hosts on one file interleave two
  hash chains — physically serialized, semantically divergent).
- **Owner-checked release, with the generation added (preserve the upstream
  contract — R4's implementation safeguard).** Upstream's `release()`
  re-reads the lock's *current* owner and removes the lock directory only
  on an exact three-field match — `currentOwner?.pid === owner.pid &&
  currentOwner.botId === owner.botId && currentOwner.nonce ===
  owner.nonce` (`channelRuntime.ts:220-232`, the ownership check at
  `:223-230`) — so a former holder that resumes and shuts down cannot
  delete a successor's lock. PaySwap preserves that exact ownership check
  and adds the fencing generation to the authority validation: release
  removes the lock only when the current owner record matches the
  releaser's pid + instance id + nonce **and** the generation recorded in
  the owner record equals the generation the releaser was granted. A stale
  holder's release is therefore a no-op (its generation is below the
  successor's), and the successor's lock, lease, and writes are unaffected
  (N42) — without this check, a paused-then-resumed former holder's
  shutdown path could delete the successor's lock and open a third
  acquisition window. The rule covers **every** removal path — graceful
  `release()` on shutdown, crash-recovery cleanup, and any lock-directory
  maintenance — and mirrors the takeover arm's own discipline (takeover
  removes only a lock whose owner pid is dead or lease has expired,
  re-checked at `:189-203` before the stale-directory removal at `:205`).
- **Hold:** heartbeat for the process lifetime; explicit release on shutdown.
- **Crash recovery:** takeover only after the lease TTL expires or the owner
  pid is dead — **and the chain verifier (§4.4) must pass before the first
  post-takeover write, and the takeover itself increments the fencing
  generation** (takeover is an acquisition; the new holder's generation
  supersedes the old holder's, which is what makes the old holder's
  subsequent writes refuse — N36). A takeover without verification is
  prohibited.
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
| Server-hosted workspace | the server host process — one lease per ledger file (keyed by DB path), and only an instance **explicitly configured as authoritative** (below) | webhook ingress is in-process (deliverable 06 §2.10); a second server process against the same root refuses — by explicit-configuration refusal at activation, and by the lease at latest |
| Horizontal / multi-instance against one SQLite file | **nobody — prohibited** | refused by the lease (N23); stated in deployment documentation |
| Hosted multi-user | n/a (PostgreSQL topology) | the lease is SQLite-topology-specific; PostgreSQL provides its own concurrency control — and that topology additionally requires authenticated principals (§4.5) before any live operation |

**Explicit authoritative-instance configuration (server mode, new — R4):** in
the SQLite server topology, authority is never inferred from reach or order of
boot. The deployment must **explicitly configure** exactly one instance as the
ledger authority for each logical ledger/workspace (an explicit
authority/replica setting; an instance not explicitly configured refuses
financial activation with a typed diagnostic). Desktop needs no such
configuration: the desktop host is authoritative by upstream construction
(single-instance, `app.requestSingleInstanceLock`,
`packages/desktop/src/main/index.ts:2101-2139`). The lease + fencing remains
the enforcement backstop regardless of configuration: two instances both
explicitly configured as authority against one file are still refused by the
lease (N23) and cannot interleave chains (N36–N38).

**Verification is a test, not a claim:** N23 starts two host processes against
one ledger DB and asserts the second refuses within the boot budget (typed
failure, no financial services); the crash-recovery arm of N23 kills the lease
holder and asserts (a) no other process acquires before the TTL, (b) takeover
after TTL runs the chain verifier before the first write. N24 asserts the
replica's write path is rejected at the repository, not by convention. N36–N38
assert the fencing discipline specifically: the stale holder's post-takeover
write refuses (`ledger_authority_lost`, hash chain unaffected), simultaneous
acquisition produces exactly one winner with the generation incremented exactly
once, and a write presenting any generation below the ledger's current value
refuses inside the write transaction before any record is appended. N42
asserts the release-path arm: the stale holder's attempt to release or delete
the successor's lock is a no-op — the ownership check (pid + instance id +
nonce + generation) fails against the successor's owner record — and the
successor's lock, lease, and subsequent writes survive.

**Deployment consequence:** the initial server deployment is
**single-authoritative-host and single-writer** — enforced by the lease,
required by explicit configuration, and asserted by N23. **Hosted multi-user
or horizontally scaled deployments must refuse financial activation until the
central PostgreSQL ledger and the authenticated principal model (§4.5, §1.6.3)
exist.** This is a hard precondition of the P7 live gate, not a recommendation:
a scaled deployment with a shared SQLite ledger is a configuration the software
**refuses at activation time** (typed diagnostic, no financial services) — not
a documented prohibition alone, and never one it tolerates.

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

Revision 3 (second R1–R4 round):

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

Revision 4 (third R1–R4 round):

| Deliverable | Amendment |
|---|---|
| 05 §9 | Broker description extended: broker-instance replay protection — (instanceId, sequence) request identity, dedupe at broker-instance scope surviving connection changes, reject-before-dispatch; the spawn-verified, parent-pid-bound Windows peer-verification relay; the end-to-end authenticated chain; N-row reference updated to N1–N38 |
| 06 §2.12 | Fenced lease: fencing generation persisted in the ledger and validated at the repository write boundary (`ledger_authority_lost`); explicit authoritative-instance configuration for the SQLite server topology; rows N36–N38 |
| 06 §4 | Server principal model applied (§1.6.3): server authentication ≠ operator identity; per-operator credentials; expiry/revocation/cross-user isolation; rows N29–N32 |
| 07 §3 | Opt-out host-side revocation semantics (§2.3) + T7 in the transition tests |
| 08 §4 | P1 row adds T7 and N29–N35; the P6/P7 row adds N36–N38 |
| 10 P1 | Server operator-principal model, broker-instance replay protection, Windows helper relay, and the authenticated chain in scope; N29–N35 and T7 in acceptance |
| 10 P7 | Fenced lease + explicit authoritative-instance configuration in scope; N36–N38 in acceptance; activation-time refusal wording |

Revision 5 (fourth R1–R4 round — implementation-contract corrections, revision 4's architecture preserved):

| Deliverable | Amendment |
|---|---|
| 05 §9 | Broker replay description corrected to the contiguous-watermark algorithm: completed-but-uncovered sequences stay recorded above the watermark until it advances past them; bounded sequence gap (`sequence_gap_exceeded`); N-row reference updated to N1–N42 |
| 06 §2.12 | Fenced-lease release contract added: the upstream lock's owner/nonce-checked release (`channelRuntime.ts:220-232`) preserved verbatim with the fencing generation added to the authority validation — a stale holder's release of the successor's lock is a no-op; row N42 |
| 06 §4 | Server principal model extended (§1.6.3 items 7–9): the two-level credential handshake (deployment Bearer header + operator header or short-lived session cookie; the URL query transport disabled on financially-enabled deployments), operator-credential format/storage/rotation/revocation with non-exposure rules, workspace-scoped role bindings; rows N40–N41 |
| 07 §3 | T7 and the opt-out revocation paragraph extended to the disposal contract (§2.3): already-rendered protected content is removed by host-controlled instance disposal/replacement plus per-key renderer-retention clearing — not merely future-delivery blocking |
| 08 §4 | P1 row adds N39 (out-of-order completed replay) and N40–N41 (credential lifecycle, cross-workspace role); the P6/P7 row adds N42 (release-path ownership); T7 wording updated to both arms |
| 10 P1 | Broker replay scope corrected (contiguous watermark + retained completed sequences + gap bound); server-principal scope adds the handshake, credential lifecycle, and workspace-scoped roles; N39–N41 and the strengthened T7 in acceptance |
| 10 P7 | Fenced-lease scope adds the owner-checked release contract; N42 in acceptance |

## §7. What this addendum deliberately does not change

The extension strategy, the preservation matrix, the financial domain decomposition
(deliverable 06 §2), the provider contract (deliverable 05), the evidence-or-refusal
law, the routing taxonomy, the mission invariants, and the P1→P9 sequence all stand
as submitted. No ZCode surface is replaced; every mechanism above is additive and
anchored to a precedent already shipped in the codebase at `a9fe401`.
