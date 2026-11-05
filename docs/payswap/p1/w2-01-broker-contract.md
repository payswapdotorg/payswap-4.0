# P1 Wave 2 Deliverable 1 — The Host-Owned Broker Contract (normative)

**Owner:** TL · **Law:** the broker is the only path from the PaySwap MCP
server process to host financial services (addendum §3.2, normative), and it
must authenticate the **calling process**, not a claim (addendum §3.5, the
architect's rule, adopted verbatim). Live money movement stays disabled; every
operation the dispatch table exposes in this wave is read-only or a typed
refusal.

**Position in the sequence:** this document is Step 1 of the architect's
seven-step broker milestone. Steps 2–7 (instance registration and credentials,
OS peer verification, the closed dispatch table, session resolution, replay
protection, adversarial integration tests) implement the sections of this
contract; each implementation PR names the sections it lands and is gated on
this contract's approval. **Nothing in Steps 2–7 may deviate from this
contract without a contract amendment PR first** — the same discipline the P0
addendum established for the architecture.

**Citations:** every upstream citation in this contract was re-verified at
`main` @ `86a9ae53` (the PR #3 merge); see Appendix A. Where the P0 addendum's
citation and the current tree disagree, the corrected path is used and the
disagreement is noted.

---

## §0 Scope

**In scope:** the local bridge between exactly one PaySwap MCP server child
process (the plugin's stdio `gateway` server, spawned by the host's plugin
runtime) and the host process's PaySwap financial services — the transport,
the credentials, the peer verification, the message contract, the closed
dispatch table, session/workspace resolution, replay protection, the instance
registry and lifecycle, and the acceptance criteria.

**Out of scope (later waves, unchanged):** the transaction-authorization grant
and its tuple binding (Wave 4, §1.3), the host-rendered Class-B card (Wave 4,
§1.6), the server operator-principal model (Wave 3, §1.6.3), the append-only
ledger and its authority (P7, §4), provider adapters and their credentials
(P2+, deliverable 05), and every provider capability. The contract reserves
the hooks those waves need (§7.4, §9.6, §11) but implements none of them.

**The Wave 2 semantic migration (why this wave exists at all):** in Wave 1 the
six tools decide refusals from the startup env snapshot
(`PAYSWAP_FINANCIAL_WORKSPACE`, merged PR #3). From Wave 2 the refusal
decisions move host-side: the tools become pure thin proxies that forward
every call over this bridge, and the **broker** reads live financial-mode
state (the plugin enabled map + `userConfig`) and returns the typed refusal.
This is what makes the T2/T3 live-flip semantics (opt-in/opt-out take effect
on the next call, not the next process) reachable, and what makes
`financial_mode_disabled` meaningful for residual calls (addendum §2.1 — the
host revokes a disabled plugin's broker bindings at disable time).

## §1 Principals and trust boundaries (summary)

The full model — assets, adversaries, attack trees, residual risks — is the
companion threat model (`w2-02-broker-threat-model.md`). The contract-level
summary:

| Principal | Trust | Holds |
|---|---|---|
| The host process (desktop Electron main / server host) | trusted (TCB) | the broker listener, the instance registry, financial services, the spawn table |
| The PaySwap MCP server child (one per enabled plugin instance per workspace) | semi-trusted | its per-instance broker credential; **no** financial state, **no** provider credentials, **no** ledger access (addendum §3.2) |
| Other MCP servers, skills, Bash and tool children | untrusted | nothing of the broker's |
| Other processes of the same user | untrusted for money | nothing of the broker's |
| Other users / the network | out of reach | the endpoint is local-domain only (§3); OS filesystem boundaries apply |

The bridge crosses exactly one trust boundary — host ↔ PaySwap MCP child — and
every mechanism below exists to make that crossing a verified, replay-proof,
closed-surface crossing.

## §2 Conformance language

**MUST / MUST NOT / SHALL / SHALL NOT** are normative: an implementation PR
that violates one is a contract deviation, not a style choice. **SHOULD /
MAY** are advisory defaults a deviation PR may argue against. Every normative
clause maps to at least one acceptance row (§12) or a named negative row of
addendum §1.7.

---

## §3 Transport contract

### 3.1 Endpoint placement (POSIX — Linux and macOS)

1. The broker MUST listen on a **local-domain Unix socket** — no TCP, no
   network interface, on any deployment (addendum §3.4: "every broker is
   per-host, local-domain only").
2. The socket file MUST live in a **host-private per-boot directory** created
   with `mkdtemp(tmpdir(), "zcode-payswap-")` and mode `0700`, with the socket
   itself mode `0600`. This adopts the official-command endpoint's placement
   precedent (`apps/zcode-cli/packages/bootstrap/src/official-command-endpoint/endpoint.ts:60-65`
   — "UDS 放在只有当前用户可进的临时目录里"), **not** the browser broker's
   shared-`tmpdir()` placement (`node-repl-browser-broker.ts:89-94`), which
   the P0 addendum already labeled the weaker pattern.
3. One directory per broker **boot** (host process financial-services
   lifetime), not per connection; the directory dies with the listener (§10).

### 3.2 Windows named pipe (via the native helper)

1. On Windows the broker's endpoint is a named pipe **held by the native
   peer-verification helper** (§5.3), not by Node — Node/libuv expose neither
   `GetNamedPipeClientProcessId` nor DACL control (addendum §3.5 item 2).
2. The pipe MUST be created with an explicit security descriptor:
   `PipeSecurity` with `SetAccessRuleProtection(true, false)` (no inheritance),
   `PipeAccessRights.ReadWrite` granted to the current user's SID only, and a
   single server instance — the in-repo precedent verified at
   `packages/desktop/native/windows-browser-import-helper/Program.cs:1031-1057`.
   A NULL DACL or a broader grant is a contract violation.
3. The pipe name MUST be random per boot (UUID/hex entropy — the
   `createSocketPath` discipline, `node-repl-browser-broker.ts:89-94`); a
   stable process-lifetime name is explicitly rejected. *Citation correction:*
   the P0 addendum cited the stable-name precedent at
   `adapters/src/mcp/stableCuaTransport.ts:19-22`; in the current tree that
   code lives at `packages/services/src/cua-permission-broker/stableCuaTransport.ts:15-22`
   (`getStableCuaPipeName` mints once and reuses). The rule is unchanged: the
   PaySwap broker does not adopt it.

### 3.3 Line protocol

1. One request per connection: the client connects, writes **one** JSON
   object as a single line (newline-terminated), reads **one** JSON response
   line, and the server closes. This is the shipped broker discipline
   (`node-repl-browser-broker.ts` — one response per connection at `respond`,
   `:156-160`).
2. The request line MUST NOT exceed **1 MiB** (`MAX_REQUEST_BYTES = 1024 * 1024`,
   the shipped precedent `node-repl-browser-broker.ts:16`). Oversize or
   unparseable input is refused with `request_invalid` (§6.3) and the
   connection closed; nothing is dispatched.
3. The response is one JSON line. Either side MAY half-close after its write;
   the server ends the connection after responding.
4. Idle connections MAY be closed by the server after a bounded timeout
   (SHOULD be ≥ 30 s so legitimate tool calls with slow model-side assembly
   never race it); a closed idle connection carries no state (§9.2).

### 3.4 Endpoint replacement protection (N22)

1. The per-boot path is unpredictable (UUID/hex entropy in a `0700`
   directory), so pre-planting is not constructible in practice; the host
   MUST ADDITIONALLY refuse or remove an existing filesystem entry at the
   chosen socket path before binding (a stale socket from a crashed previous
   host, or a same-user pre-plant attempt, must never be silently adopted).
2. The path is delivered to the PaySwap MCP child **only** via the trusted
   config injection (§4.2) — never user-configurable, never persisted, never
   logged, never inherited through a nested environment (§4.3).
3. A client connecting to a path the current broker does not own is, by
   construction, connecting to something else; the per-instance token check
   (§4.5) and peer verification (§5) both fail it. The stale-socket arm of
   N22 asserts exactly this after a host restart.

---

## §4 Credential contract (per-instance) — Step 2 implements this section

### 4.1 Minting

1. At every spawn of the PaySwap MCP server child, the host mints a
   **per-instance credential**: a 256-bit random token
   (`randomBytes(32).toString("hex")`, the shipped discipline
   `node-repl-browser-broker.ts:32`) bound to a fresh **instance id**
   (UUID v4).
2. Token lifetime = process instance lifetime. One instance's token MUST NOT
   validate another (N20). Token, instance id, child pid, plugin registration
   identity, and workspace/session scope enter the host's in-memory instance
   registry together (§10.1).
3. The credential is generated in the host process, in memory; it MUST NOT be
   persisted to disk, written to a log, or exposed over any channel other
   than §4.2.

### 4.2 Delivery — trusted injection only

1. The credential reaches the PaySwap MCP child's process environment through
   the **trusted config-injection path** — the CUA discipline
   (`injectZCodeCuaBrokerMcpServers`,
   `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:108+`): the host
   resolves the official plugin's server config and injects the broker env
   into **that config object only**, at spawn.
2. Authority derives from the in-memory official-plugin registry with
   **reference identity** — `configuredServers[name] === config` and the
   plugin-id env of the official registration
   (`resolveTrustedOfficialCuaServerNames`, `mcp-config.ts:43-58`, the
   anti-copying gate; addendum §1.5). A copied config with PaySwap's names,
   commands, and env values does not inherit the credential (N19).
3. Env keys (the plugin-owned `PAYSWAP_` namespace, accepted by the architect
   in round 1 — official plugin precedent: `ANDROID_PLUGIN_SDK_PATH`,
   `IOS_SIM_DEFAULT_DEVICE`):

   ```
   PAYSWAP_BROKER_SOCKET        the per-boot endpoint path (POSIX) or pipe name (Windows)
   PAYSWAP_BROKER_TOKEN         the per-instance 256-bit hex token
   PAYSWAP_BROKER_INSTANCE_ID   the per-instance UUID
   ```

4. The values MUST NOT be user-configurable (absent from any settings schema
   and from manifest `env` — the manifest's `mcpServers.*.env` keys stay
   exactly the Wave 1 set: `PAYSWAP_FINANCIAL_WORKSPACE`), and MUST NOT be
   discoverable through `${user_config.*}` substitution.

### 4.3 Sanitization (the strip list)

1. All three `PAYSWAP_BROKER_*` keys MUST join the child-environment strip
   list — the shipped discipline that already strips the CUA broker socket,
   the CUA legacy tokens, and the official-endpoint pair from every child
   environment (`packages/shared/src/runtimeEnv.ts:64-76`, with the in-source
   confused-deputy rationale: a leaked credential turns a sibling MCP server
   or a prompt-injected Bash command into a driver of the authorized
   channel).
2. Injection ordering MUST preserve the shipped property: the targeted
   injection lands **after** the strip (the CUA pair's
   `buildMcpStdioEnv`-then-spread ordering, documented in `runtimeEnv.ts`'s
   strip comment) so the PaySwap child receives its credential and no other
   child receives any.
3. A nested agent (a PaySwap child spawning its own agent) MUST NOT inherit
   the credential: the strip list applies to all descendant environments; the
   official-endpoint pair's "one session's token never reaches another
   session" comment (`runtimeEnv.ts`, `ZCODE_OFFICIAL_ENDPOINT_*` entries) is
   the exact discipline.

### 4.4 Capture-before-sanitization and the launch assertion

1. Where a `__zcode-plugin-host` dispatch path is involved (the production
   launch chain PR #3 proved), the broker credential MUST be captured
   in-process **before** env sanitization, in the shipped snapshot pattern
   (`getCapturedZCodeCuaBrokerCredentials`,
   `packages/shared/src/runtimeEnv.ts:157-209`), with the same fail-closed
   pair rule: **a socket (or token) appearing without its complete set
   clears the snapshot** — a half credential never launches (the `:171-174`
   discipline).
2. The launch assertion precedent applies verbatim
   (`assertCapturedBrokerLaunchIsAuthorized`,
   `apps/zcode-cli/packages/cli/src/plugin-host-command.ts:83-105`): the
   plugin-host dispatch path MUST assert that captured PaySwap broker
   credentials may only serve the trusted official PaySwap plugin host
   context, and refuse the launch otherwise. (The CUA assertion's own
   comment history — token removed from the credential group, pair-required
   — is the maintenance discipline to follow when this contract evolves.)

### 4.5 Verification

1. Every request carries the token (`PAYSWAP_BROKER_TOKEN`'s value, in the
   request body, §6.1). The broker compares with a length check +
   **timing-safe comparison** (`timingSafeEqual` — the shipped
   `authorizeRequest`, `node-repl-browser-broker.ts:162-172`; the Windows
   helper's `FixedTimeEquals`, `Program.cs:1249-1262`, for the
   helper↔host hop).
2. Token verification is **necessary, never sufficient**: §5 (peer
   verification) and §10.1 (registry binding) must also pass. A token-only
   fallback for money-path reachability is prohibited on every platform
   (addendum §3.5 item 2, the fail-closed rule).

---

## §5 Peer verification contract (fail-closed) — Step 3 implements this section

The architect's rule, restated as the section's law: **a plugin identity claim
alone is not process authentication — the broker must verify the actual
calling process against the host-registered plugin instance** (addendum §3.5,
 adopted verbatim).

### 5.1 POSIX peer credentials

1. On Linux and macOS the broker MUST read the connected peer's credentials
   (pid, uid) at accept time — via the runtime's peer-credentials API where
   the runtime exposes it, else a small native helper (addendum §3.5 item 2's
   escape hatch).
2. The peer's uid MUST equal the host process's uid. A uid mismatch is
   `peer_verification_failed` (§6.3), connection dropped, no payload parsed.
3. **Honest upstream state, unchanged from the P0 addendum:** no TypeScript
   broker in this repo performs OS peer verification today (zero
   `getPeerCredentials`/`SO_PEERCRED` in any `.ts` file — all TS brokers are
   token-only). The peer-credential read is ours to build; the native
   precedents are the macOS CUA Helper (`SecCodeCheckValidity` +
   `getpeereid`/`LOCAL_PEERPID`, fail-closed if any gate cannot be
   established — spec at `docs/cua-permission-broker/zcode-cua-permission-broker.md:25`)
   and the C# Windows helper (`GetNamedPipeClientProcessId` + exact-pid +
   image-path, `Program.cs:1095-1127`).

### 5.2 The spawn-table binding

1. The verified pid MUST map to a **live child the host itself spawned** —
   the spawn table: `McpTrackedProcess` / `listProcesses()`
   (`apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts:33-39`, in-memory)
   plus the stdio transport's recorded child pid
   (`stdio-transport.ts:87-93`, `this.childProcess = child`).
2. The mapped entry MUST be the PaySwap plugin's server for the instance id
   the request claims: pid → registry entry → instance id equality (§10.1).
   A pid reuse race (the child died and the OS recycled its pid to a hostile
   process) is covered by the liveness requirement — a dead child's entry is
   tombstoned at exit (§10.2) before the pid can be reused.
3. A claim on the wire is never sufficient by itself (the architect's rule);
   the payload's `instanceId` is *checked against* the registry, never
   *adopted from* the payload.

### 5.3 Windows helper relay

1. On Windows, `GetNamedPipeClientProcessId` and DACL control live in the
   **native helper** which holds the pipe (§3.2): each client connection is
   verified — client pid + exact match against the registered instance's
   child pid + image-path verification (`Program.cs:1095-1127`) — **before
   any payload is read**.
2. The helper→host channel is authenticated with the helper family's shipped
   disciplines: the host spawns the helper only after hash/signature
   verification and passes its own pid (`--parent-pid` +
   `String(process.pid)` — `windowsChromeAppBoundKey.ts:295,316`); the helper
   binds its endpoint and a one-shot 32-byte token to that exact parent pid
   (`Program.cs:125`); the token is compared constant-time
   (`FixedTimeEquals`, `Program.cs:1213-1217, 1249-1262`).
3. The relayed "verified client pid" is trustworthy exactly because (a) the
   helper binary was verified at spawn, (b) the helper serves no parent but
   the spawning host, and (c) the host↔helper channel is token-bound
   (addendum §3.5 item 8). Applying this helper family as a broker
   peer-verification relay is **labeled new PaySwap work** — upstream uses it
   for browser cookie import; the application to the financial broker is
   ours to build and prove.
4. The helper relays **only** verified requests; an unverifiable client is
   dropped at the pipe, and the relay never forwards a client-supplied pid
   claim.

### 5.4 The fail-closed rule (normative, all platforms)

Where peer identity **cannot be established** on a platform — no
peer-credentials API, the helper failed to spawn or verify, the runtime
refuses the native call — the broker **refuses connections on that platform**.
A token-only fallback for money-path reachability is not acceptable
(addendum §3.5 item 2; the macOS Helper's own rule). Concretely: if the
peer-verification subsystem is unavailable at broker start, the broker starts
in `degraded_refusing` mode — the socket binds (so diagnostics can be
returned) but every request is refused `peer_verification_failed` (§6.3), and
the PaySwap tools surface the corresponding typed failure. Financial services
are never reachable through an unverified peer.

### 5.5 Check order (normative)

For every connection: **(1)** peer verification (§5.1/§5.3) → **(2)** payload
parse + size cap (§3.3) → **(3)** token verification (§4.5) → **(4)**
instance/registry binding (§5.2, §10.1) → **(5)** replay check (§9) →
**(6)** dispatch (§7). No step may be reordered; unknown pids are dropped
before any payload byte is parsed (addendum §3.5 item 2).

---

## §6 Message contract

### 6.1 Request schema

A single strict schema (zod, `.strict()` — unknown keys rejected, the shipped
`nodeReplBroker.ts:25-35` discipline):

```ts
payswapBrokerRequest = z.object({
  instanceId: z.string().uuid(),        // the per-instance credential's id (§4.1)
  seq: z.number().int().positive(),      // per-instance monotonic sequence (§9.1)
  op: z.enum([                           // the closed dispatch table (§7.1)
    "compile_intent", "check_eligibility", "discover_routes",
    "request_authorization", "get_execution_status", "get_account_overview",
  ]),
  params: z.record(z.unknown()),         // op-specific, schema'd per op in the implementation PR
  token: z.string().length(64),          // the 256-bit hex credential (§4.5)
  sessionId: z.string().trim().min(1),   // routing hint ONLY — never authoritative (§8)
  trace: traceSchema.optional(),         // the shipped trace triple, optional
}).strict();
```

Normative notes:

1. `seq` starts at 1 and MUST increase monotonically per instance
   (allocated by the MCP child, §9.1). Sequence 0 is invalid.
2. `sessionId` is a **routing hint, never an identity**: the broker resolves
   the session scope authoritatively downstream (§8) — the shipped
   token-proves-origin / session-resolved-downstream discipline
   (`node-repl-browser-broker.ts:168-171`, `requireSession` at
   `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts:334-347`).
3. `params` schemas are per-op, strict, and live in
   `packages/shared/src/payswap/` (Worker 3 territory) — one schema per
   operation of §7.1, versioned with the contract. The implementation PR for
   Step 4 lands them; this contract fixes their home and their strictness,
   not their fields (the six tools' shapes are already pinned by deliverable
   05 §9 and the Wave 1 proxy surface).

### 6.2 Response schema

```ts
payswapBrokerResponse =
  | { ok: true,  seq: number, data: unknown }              // op result (the tool envelope rides here)
  | { ok: false, seq: number, error: { code: PayswapBrokerErrorCode,
                                       message: string,
                                       retryable: boolean } }
```

The business refusal envelope (`{ kind: "refused", refusal: { code, message } }`,
merged PR #3, `payswap-plugin/src/contract.ts`) rides inside `data` for
refusal-resolving ops — the broker-level error taxonomy below is for
**bridge** failures only, never conflated with business refusals (the
three-code law, addendum §2.1: `not_opted_in` / `not_connected` /
`financial_mode_disabled` are business states, single source of truth in the
plugin contract module).

### 6.3 Error taxonomy (bridge failures — typed, closed set)

| Code | Meaning | retryable | Proven by |
|---|---|---|---|
| `unauthorized` | token mismatch (§4.5) | no | N20 arm |
| `peer_verification_failed` | peer identity not established / uid mismatch / unknown pid (§5) | no | N22, Step 3 suite |
| `instance_unknown` | instance id not in the live registry (superseded, tombstoned, or forged) (§10) | no | N19/N20, restart arm |
| `request_invalid` | schema violation, unknown key, oversize line (§3.3, §6.1) | no | Step 4 suite |
| `sequence_duplicate` | `(instanceId, seq)` already accepted — replay (§9.3) | no | N33/N34/N35/N39 |
| `sequence_gap_exceeded` | `seq > W + G` (§9.4) | yes (after filling the gap) | Step 6 suite |
| `operation_not_found` | `op` outside the table (unreachable via the schema's enum — the belt behind the suspenders) (§7) | no | N21 |
| `session_unresolvable` | authoritative session resolution failed for the calling instance (§8) | no | Step 5 suite |
| `workspace_mismatch` | request targets a workspace other than the instance's (§8.3) | no | Step 5 suite |
| `broker_unavailable` | broker in `degraded_refusing` or shutting down (§5.4, §10.3) | yes | Step 3 suite |
| `internal_error` | unexpected host-side failure — no detail leaked | no | all suites |

Every refusal is typed and logged (§11); no stack trace, token, path, or
credential material ever crosses the bridge in an error payload.

---

## §7 The closed dispatch table — Step 4 implements this section

### 7.1 The six operations

The dispatch table contains **exactly** the operations behind the six
`payswap_*` tools (deliverable 05 §9; the Wave 1 tool surface, merged):

```
compile_intent · check_eligibility · discover_routes ·
request_authorization · get_execution_status · get_account_overview
```

1:1 with `TOOL_NAMES` (`payswap-plugin/src/contract.ts`). The mapping is
structural: each tool's params schema is its operation's params schema; each
operation's result is the tool's envelope. **No seventh operation exists.**

### 7.2 What is deliberately absent (N21)

No general `ServiceChannels` access (ServiceChannels is the renderer↔host
fabric, not an API for an external MCP process — addendum §3.3); no arbitrary
host-service invocation; no reflection; no passthrough; no "raw service"
escape hatch; no operation that takes a service name or channel name as
data. The dispatch is a **closed enum → handler map in code**, not a
registry that accepts registrations. An `op` value outside the enum fails
schema validation (`request_invalid` / `operation_not_found` belt-and-suspenders,
§6.3) and dispatches nothing.

### 7.3 Wave 2 semantics (read-only + refusals)

In Wave 2 every operation resolves to a business refusal or (where the
account model permits nothing yet) `not_connected` — the live-state migration
of §0: the broker reads the plugin enabled map + `userConfig.financialWorkspace`
**live** (not the child's env snapshot) and answers per the three-code law:

| Broker-observed state | Answer |
|---|---|
| plugin disabled/uninstalled (residual call) | `financial_mode_disabled` (bindings revoked at disable, §10.2) |
| enabled, `financialWorkspace=false` (S1) | `not_opted_in` |
| enabled, opted in, no account (S2) | `not_connected` |

Read-only account data arrives with P2's Gate E2 — **no provider credential,
no provider call, and no account data exists in this wave.**

### 7.4 The grant hook (reserved, dormant)

The signature of `request_authorization` reserves an optional
`authorizationId` param and the dispatch layer reserves a grant-validation
step (addendum §1.3), both **dormant** in Wave 2: the param is rejected with
the business refusal `authorization_required`-family codes only when Waves
4+/P7 activate them. Nothing in this wave mints, validates, or stores a
grant. The hook exists so later waves do not need a breaking protocol
change; the dormant flag is itself asserted in the Step 7 suite (a Wave 2
`authorizationId` submission must not reach any grant logic).

---

## §8 Session resolution and workspace isolation — Step 5 implements this section

### 8.1 Authoritative downstream resolution

The broker never takes session identity from the request payload. The
connection's verified instance (§5.2) maps to its registration scope
(§10.1); the session record is resolved authoritatively downstream through
the shipped `requireSession` pattern
(`server-types.ts:333-347` — session runtime readiness, record lookup,
typed `sessionUnavailable` on miss) — the same discipline the browser broker
documents at `node-repl-browser-broker.ts:168-171`: the private socket token
proves origin; the session is resolved, not asserted.

### 8.2 Binding

A broker connection is bound to the triple **(verified pid → host-registered
plugin instance → session scope)** (addendum §3.5 item 5). All requests on
that connection resolve within that binding; a request whose `sessionId`
hint does not match the binding's resolvable scope is `session_unresolvable`
— the hint can narrow, never widen.

### 8.3 Workspace isolation

The PaySwap plugin's manifest declares `isolation: "workspace"` (merged PR
#3): one MCP server instance per workspace. The broker preserves this
end-to-end: an instance's registration carries its workspace; a request may
only resolve within that workspace; a request whose params name another
workspace's entities (accounts, routes, evidence URIs) is
`workspace_mismatch`. Cross-workspace reachability at this layer is refused
even for read-only operations — the (operator, workspace) binding discipline
that §1.6.3 item 9 makes server-side in Wave 3 is enforced structurally here
for the local case.

---

## §9 Replay protection contract — Step 6 implements this section

### 9.1 Request identity

Request identity is **`(instanceId, seq)`** (addendum §3.5 item 7): the
instance id is bound to the per-instance credential (§4.1), and `seq` is a
monotonically increasing per-instance integer allocated by the MCP child.
The pair is unique by construction — the child allocates each seq exactly
once, and a superseded instance's ids fail §10 before sequence handling
matters.

### 9.2 The dedupe scope is the broker instance

The dedupe record's scope is the **host process's financial-services
lifetime** (the broker instance), **not the connection**: connection drops
and reconnections do not clear it (N33/N34). A new MCP server instance gets
a new instanceId and credential, so a superseded instance's requests fail
the instance check first. Broker restart needs no seen-record persistence:
a broker restart is a host restart, stdio children do not outlive the host,
and every instanceId of the previous incarnation is superseded (§10.3) —
requests carrying them fail `instance_unknown` before sequence handling is
reached.

### 9.3 The seen-record algorithm (normative — the contiguous watermark)

Per instance, the broker keeps:

- **`W`** — the watermark: the highest sequence such that **every** sequence
  `≤ W` has been accepted.
- **`R`** — the retained set: every accepted sequence `> W`, **completed
  requests included**. A sequence enters `R` when its request is **accepted
  for dispatch** and leaves only when the watermark advances past it.

Rules:

1. **Accept test:** a request is a duplicate — and is rejected
   `sequence_duplicate` **before dispatch** — iff `seq ≤ W` or `seq ∈ R`,
   regardless of the original request's eventual outcome (success, failure,
   timeout). *Accepted* means accepted for dispatch; outcome reconciliation
   is the idempotency layer's job (§9.6).
2. **Watermark advance:** `W` advances only when `W+1` has been accepted,
   then **contiguously through `R`** (advancement is bookkeeping over
   already-accepted sequences, pruning `R` as it goes).
3. **The out-of-order arm (N39):** with `W=10` and sequence 11 outstanding,
   sequence 12 may be accepted, dispatched, and complete — 12 remains in `R`
   (completed but not covered), so a replay of 12 **before 11 arrives** is
   rejected before dispatch; when 11 arrives it is accepted and the watermark
   advances through 11 and 12 together. This closes the gap a bare
   in-flight set leaves open (the architect's round-2 correction, adopted).
4. **Concurrency:** the accept test and `R` insertion are one atomic step
   (per-instance lock or CAS); two connections presenting the same
   `(instanceId, seq)` simultaneously produce exactly one dispatch and one
   `sequence_duplicate` (N35).
5. **Allocation discipline (child side):** the MCP child allocates `seq`
   from a monotonic counter persisted for the process lifetime (in memory);
   retries after connection loss MUST reuse the same `seq` for the same
   logical request (so a delivered-but-unanswered request replays as a
   duplicate, not a double dispatch) and allocate a fresh `seq` only for a
   new logical request.

### 9.4 The bounded gap

A request with `seq > W + G`, where `G` is the deployment-configured maximum
permitted gap (**default 64**), is refused `sequence_gap_exceeded` **before
dispatch**. The retained set is thereby bounded by `G`, and a peer cannot
balloon broker memory by skipping ahead. (The alternative — strict in-order
dispatch per instance — was considered and rejected in the P0 addendum: it
would serialize concurrent requests that legitimately ride separate
connections; the retained-set algorithm provides the same replay guarantee
without the serialization.)

### 9.5 Reject-before-dispatch

The replay check (§9.3) precedes any host-service call: a request whose
`(instanceId, seq)` was already dispatched — on this connection, a new
connection, or concurrently on a second connection — receives the typed
refusal and **nothing is dispatched** (N33–N35, N39). No "at-most-once
except under load" carve-out exists.

### 9.6 Complementarity with durable idempotency (reserved)

Durable operation-level idempotency for financial side effects (deliverable
05 §6.3 — executor-allocated per-leg idempotency keys relayed onto
provider-native mechanisms, plus the append-only ledger) survives host
restarts — a scope this table deliberately does not claim. The two layers
reject different things: **transport replay** (same request identity) is
refused at the broker; a **legitimate retry after an unknown outcome** (new
request identity, same idempotency key) reconciles at the financial boundary
without double-executing. The ledger-ingress recording hook (§11) is where
the two layers will meet in P7; this wave records audit entries only.

---

## §10 Instance registry and lifecycle — Step 2 implements this section

### 10.1 Registration

At spawn, the host registers the instance: `{instanceId, token, child pid,
plugin registration identity (the official-plugin registry entry — §1.5's
host-verified identity), workspace, session scope, spawn time}`. The
registry is in-memory, host-process-private, and append/tombstone only —
entries are never mutated in place (a re-spawn is a new instanceId; the old
entry tombstones).

### 10.2 Teardown and supersession

1. Child exit (observed via the spawn table / transport exit hooks,
   `stdio-transport.ts`'s `recordExit`) tombstones the entry. A tombstoned
   instance's requests fail `instance_unknown` — covering the pid-reuse race
   (§5.2) and the dead-child token arm of N20.
2. **Plugin disable/uninstall revokes bindings** (addendum §2.1): the
   host-side revocation at disable time tombstones every live instance of
   that plugin, making residual calls answer `financial_mode_disabled` —
   the reachability fix the P0 addendum's §2.1 table made normative.
3. Opt-out (S2→S1) does **not** tombstone instances (the process stays
   alive); it flips the live financial-mode state the broker reads (§7.3) —
   the T3 live-flip.

### 10.3 Host restart semantics

A broker restart is a host restart (the broker lives in the host process —
addendum §3.4). All previous instanceIds are superseded by construction
(stdio children do not outlive the host); a request from a pre-restart
incarnation fails `instance_unknown` before sequence handling. No
seen-record persistence across restarts is required or permitted (§9.2) —
the fresh instanceId space makes replay-across-restart impossible, and the
stale-endpoint arm is additionally covered by §3.4 (N22).

---

## §11 Observability and audit

1. Every broker request is **audit-logged at ingress**: timestamp,
   instanceId, seq, op, the verified pid, the resolved workspace/session
   scope, the outcome (dispatched / refused + code). This is the P7
   ledger-ingress hook's Wave 2 shape (addendum §3.2: "All broker calls are
   ledger-recorded at ingress (§4)") — a structured local audit log now, the
   append-only ledger's ingress record then, same fields.
2. **Never logged:** token values (a salted length-preserving digest at
   most, if correlation demands it), full credential env, response payloads
   containing account data (post-P2; Wave 2 responses carry no account
   data).
3. Refusals log their typed code, never a stack trace. The `degraded_refusing`
   state (§5.4) logs its reason at entry with an operator-visible diagnostic.

---

## §12 Acceptance criteria

The wave's acceptance = this contract's sections proven by the Step 7
adversarial integration suite (against the **real** host launch chain — the
PR #3 production-host suite is the harness pattern) **plus** the negative
rows of addendum §1.7 that gate the broker bridge:

| Gate | Rows / suites | Contract sections proven |
|---|---|---|
| Impostor configs receive no credential and cannot connect | **N19** | §4.2, §4.5, §5.2 |
| Cross-instance token use refused | **N20** | §4.1, §4.5, §10.1 |
| Closed dispatch (no seventh op, no service reach) | **N21** | §6.1, §7 |
| Stale/pre-planted endpoint unreachable after restart | **N22** | §3.4, §10.3 |
| Replay on a new connection refused | **N33** | §9.2, §9.3 |
| Replay after reconnect refused | **N34** | §9.2, §9.3 |
| Concurrent duplicates: exactly one dispatch | **N35** | §9.3(4) |
| Out-of-order completed replay refused (retained-set arm) | **N39** | §9.3(3) |
| Fail-closed peer verification (each platform, forced-unavailable arm) | Step 3 suite | §5.4 |
| T2/T3 live-flip (opt-in/opt-out answered by live broker state, next call) | Step 4/5 suite (transition rows feed T2/T3) | §0, §7.3, §10.2 |
| `financial_mode_disabled` residual-call reachability | Step 2/5 suite | §7.3, §10.2 |
| Sequence-gap bound enforced | Step 6 suite | §9.4 |
| Audit log complete over the adversarial run; zero credential material in logs | Step 7 suite | §11 |

Additional step gates (from the README sequence): each implementation PR
lands its section's unit/property tests plus the harness extension rows it
can carry; Step 7 runs the complete chain suite — MCP child (real plugin
build) → broker → financial service stub — through the **production host
launch path** (no test-only launcher; the PR #3 discipline).

---

## §13 What this contract does not authorize

No Stripe, Paystack, PayPal, or any payment provider. No live account data.
No money movement. No authorization grant minting, validation, or storage.
No provider credential storage. No network exposure. No settings-surface,
composer, navigation, or upstream-semantics change beyond the additive
injection points §4.2/§4.3 name (themselves the CUA pattern's exact shape).
The six operations resolve to typed refusals until P2+ gates open them. This
contract is the boundary the architect set: **the broker exists to make the
crossing verified, replay-proof, and closed — nothing crosses it yet.**

---

## Appendix A — Citation index (verified at `main` @ `86a9ae53`)

| Claim | Citation | Verified |
|---|---|---|
| 256-bit random token, timing-safe compare | `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts:32` (`randomBytes(32)`), `:162-172` (`authorizeRequest`) | ✅ this branch |
| 1 MiB cap, one-request-per-connection, UUID socket path | `node-repl-browser-broker.ts:16`, `:156-160` (`respond`), `:89-94` (`createSocketPath`) | ✅ |
| Env-key pair + strict zod request schema (`.strict()`, token min 32) | `packages/shared/src/browser-use/nodeReplBroker.ts:6-7`, `:25-35` | ✅ |
| Strip-list discipline (CUA socket, legacy tokens, official-endpoint pair) with confused-deputy rationale | `packages/shared/src/runtimeEnv.ts:64-76` | ✅ |
| Capture-before-sanitization snapshot, half-pair clears | `packages/shared/src/runtimeEnv.ts:157-209` (pair rule `:171-174`) | ✅ |
| Launch assertion (captured credentials serve only the trusted host) | `apps/zcode-cli/packages/cli/src/plugin-host-command.ts:47-49`, `:83-105` | ✅ |
| Trusted injection + reference-identity anti-copying gate | `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:108+` (`injectZCodeCuaBrokerMcpServers`), `:43-58` (`resolveTrustedOfficialCuaServerNames`, `configuredServers[name] === config` at `:51`) | ✅ |
| Host-side pid→plugin spawn tracking | `apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts:33-39` (`McpTrackedProcess`) | ✅ |
| Transport-recorded child pid + exit observation | `apps/zcode-cli/packages/adapters/src/mcp/stdio-transport.ts:87-93` | ✅ |
| Private-dir socket placement (the adopted precedent) | `apps/zcode-cli/packages/bootstrap/src/official-command-endpoint/endpoint.ts:60-65` | ✅ |
| Windows pipe DACL + single instance | `packages/desktop/native/windows-browser-import-helper/Program.cs:1031-1057` | ✅ |
| Windows client-pid + image-path verification | `Program.cs:1095-1127` | ✅ |
| One-shot 32-byte token, constant-time compare | `Program.cs:1213-1217`, `:1249-1262` | ✅ |
| Helper parent-pid binding | `packages/desktop/src/main/windowsChromeAppBoundKey.ts:295,316` (`--parent-pid` + `String(process.pid)`) | ✅ |
| macOS Helper fail-closed peer gate (spec) | `docs/cua-permission-broker/zcode-cua-permission-broker.md:25` | ✅ |
| Stable process-lifetime pipe name (the **rejected** pattern) | `packages/services/src/cua-permission-broker/stableCuaTransport.ts:15-22` — *corrected from the addendum's `adapters/src/mcp/stableCuaTransport.ts:19-22`* | ✅ |
| Per-call token ledger (one token per open entry) | `apps/zcode-cli/packages/node-repl-host/src/call-ledger/ledger.ts:49` | ✅ |
| Downstream authoritative session resolution | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts:334-347` (`requireSession`) | ✅ |
| Token-proves-origin / session-resolved-downstream comment | `node-repl-browser-broker.ts:168-171` | ✅ |
