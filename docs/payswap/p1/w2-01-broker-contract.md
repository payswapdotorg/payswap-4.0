# P1 Wave 2 Deliverable 1 — The Host-Owned Broker Contract (normative)

**Owner:** TL · **Law:** the broker is the only path from the PaySwap MCP
server process to host financial services (addendum §3.2, normative), and the
bridge authenticates **both directions**: the host must authenticate the
**calling process**, not a claim (addendum §3.5, the architect's rule, adopted
verbatim), and the PaySwap child must authenticate the **response** as a
genuine answer from its own host boot (§6.4/§6.5, the architect's PR #4 review
decision, adopted verbatim). Live money movement stays disabled; every
operation the dispatch table exposes in this wave is read-only or a typed
refusal.

**Revision 2 (2026-11-05):** amended per the architect's review of PR #4 —
(1) host-signed responses via a per-boot Ed25519 key pair are now a **Wave 2 /
P1 normative requirement** (§6.4, §6.5; ADR-1), not a deferred P2 design item;
(2) the replay gap `G` is a **fixed v1 protocol constant** (§9.4; ADR-2), not a
deployment setting; (3) sequence-allocation recovery semantics are normative
(§9.3 rules 5–6; ADR-2); (4) the rev-1 threat-model claim that a fake broker
cannot return an accepted response is corrected (threat model T4/T9). The
credential tuple grows from three to five env keys (§4.2–§4.4).

**Position in the sequence:** this document is Step 1 of the architect's
seven-step broker milestone. Steps 2–7 (instance registration and credentials,
OS peer verification, the closed dispatch table, session resolution, replay
protection, adversarial integration tests) implement the sections of this
contract; each implementation PR names the sections it lands and is gated on
the **TL's recorded checklist acceptance** of this contract against the P0
addendum (playbook §1: in-scope phase transitions require no external
sign-off). **Nothing in Steps 2–7 may deviate from this
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
| The host process (desktop Electron main / server host) | trusted (TCB) | the broker listener, the instance registry, financial services, the spawn table, the per-boot Ed25519 **private** signing key (host memory only, §6.5) |
| The PaySwap MCP server child (one per enabled plugin instance per workspace) | semi-trusted | its per-instance broker credential, the host-boot verification (**public**) key (§4.2); **no** financial state, **no** provider credentials, **no** ledger access, **no** private key material (addendum §3.2) |
| Other MCP servers, skills, Bash and tool children | untrusted | nothing of the broker's |
| Other processes of the same user | untrusted for money | nothing of the broker's |
| Other users / the network | out of reach | the endpoint is local-domain only (§3); OS filesystem boundaries apply |

The bridge crosses exactly one trust boundary — host ↔ PaySwap MCP child — and
every mechanism below exists to make that crossing a **mutually verified**,
replay-proof, closed-surface crossing: §4/§5/§10 prove to the host **which
process is calling**; §6.4/§6.5 prove to the child **that the answer came from
its own host boot and answers this exact request**. One direction without the
other is not an authenticated channel.

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
   construction, connecting to something else. **Rev 2a:** the defenses for
   that direction are the child's — response authentication (§6.4/§6.5)
   makes a substituted endpoint unable to produce an acceptable response;
   the broker-side token and peer checks (§4.5, §5) never run on a
   substituted path and are correctly no defense against it. The stale-socket
   arm of N22 asserts the endpoint replacement itself is unreachable after a
   restart; the response-authentication rows assert the substitution arm
   fails closed when it is attempted anyway.

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
   `IOS_SIM_DEFAULT_DEVICE`). **Revision 2:** the tuple grows from three to
   **five** keys — the two additions carry the response-authentication
   material of §6.5:

   ```
   PAYSWAP_BROKER_SOCKET        the per-boot endpoint path (POSIX) or pipe name (Windows)
   PAYSWAP_BROKER_TOKEN         the per-instance 256-bit hex token
   PAYSWAP_BROKER_INSTANCE_ID   the per-instance UUID
   PAYSWAP_BROKER_HOST_ID       the host-boot UUID — the scope of the response-signing key (§6.5.1)
   PAYSWAP_BROKER_VERIFY_KEY    the host-boot Ed25519 public verification key, base64 (RFC 8032)
   ```

   The last two are injected with exactly the same trusted-path discipline as
   the first three: same reference-identity gate, same spawn-time resolution,
   same prohibition on any other channel.

4. The values MUST NOT be user-configurable (absent from any settings schema
   and from manifest `env` — the manifest's `mcpServers.*.env` keys stay
   exactly the Wave 1 set: `PAYSWAP_FINANCIAL_WORKSPACE`), and MUST NOT be
   discoverable through `${user_config.*}` substitution.

### 4.3 Sanitization (the strip list)

1. All **five** `PAYSWAP_BROKER_*` keys MUST join the child-environment strip
   list — the shipped discipline that already strips the CUA broker socket,
   the CUA legacy tokens, and the official-endpoint pair from every child
   environment (`packages/shared/src/runtimeEnv.ts:64-76`, with the in-source
   confused-deputy rationale: a leaked credential turns a sibling MCP server
   or a prompt-injected Bash command into a driver of the authorized
   channel). **Rev 2a (worker-challenge fix):** the shipped discipline is
   *two* lists — the five keys MUST also join the tool-env-passthrough
   blocklist (`NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS`,
   `runtimeEnv.ts:104-117`, whose in-source comment states the CUA keys must
   not be restored into Bash/tool child envs via tool-env passthrough, "that
   would bypass the strip above"). A Step 2 implementation that strips but
   does not block passthrough re-opens the exact confused-deputy bypass the
   upstream comment warns about; the Step 2 suite asserts Bash/tool children
   cannot recover any `PAYSWAP_BROKER_*` key via passthrough. The two rev-2
   additions strip for the same reason — the public key and host id are not
   secret, but a sibling that reads them can at least *attempt* endpoint
   impersonation against the real child, and the strip keeps the credential
   tuple's delivery surface exactly one process.
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
   pair rule extended to the full five-key tuple: **any `PAYSWAP_BROKER_*`
   key appearing without the complete set clears the snapshot** — a partial
   credential never launches (the `:171-174` discipline, now over five keys,
   all-or-nothing). Partial-tuple rows (each of the five keys missing alone,
   and each proper subset) are mandatory Step 2 test rows.
2. The launch assertion precedent applies verbatim
   (`assertCapturedBrokerLaunchIsAuthorized`,
   `apps/zcode-cli/packages/cli/src/plugin-host-command.ts:83-105`): the
   plugin-host dispatch path MUST assert that captured PaySwap broker
   credentials — all five keys — may only serve the trusted official PaySwap
   plugin host context, and refuse the launch otherwise. (The CUA assertion's
   own comment history — token removed from the credential group,
   pair-required — is the maintenance discipline to follow when this
   contract evolves.) **Rev 2a — currency validation (worker-challenge
   fix):** presence and context are not sufficient for this credential
   class: the assertion MUST additionally validate the captured tuple
   against the **live** broker state — the captured `PAYSWAP_BROKER_HOST_ID`
   equals the **current** boot id, the captured `PAYSWAP_BROKER_INSTANCE_ID`
   is **live in the current registry**, and the captured
   `PAYSWAP_BROKER_SOCKET` equals the **current** endpoint — and refuse the
   launch otherwise. Without this, a complete **stale** tuple scraped from a
   previous boot's child and re-planted into a fresh launch (the CUA
   assertion never checked currency because the CUA credential carries no
   per-boot semantics) would spawn an official child trusting a previous
   boot's signing key — defeating the cross-boot binding of §6.5(1) through
   a path the contract itself defines. Mandatory Step 2 rows: complete
   stale-tuple pre-plant → launch refused; current-boot tuple with a
   mismatched socket → refused.

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

The child's mirror duty (response side, §6.5): **(1)** read one line under the
response size cap → **(2)** parse → **(3)** signature verification under the
injected public key → **(4)** binding verification (version, host id,
instance id, seq, op, request digest) → **(5)** accept as the answer to that
in-flight attempt. No step may be reordered; an unparseable or oversize
response line is rejected before any signature check is attempted, and an
unsigned response is rejected before any field of it is trusted.

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
  retiredSeqs: z.array(z.number().int().positive())  // ≤ 8 per request (§9.3(6));
    .max(8).optional(),                   // transport bookkeeping — NOT a dispatch op
  trace: traceSchema.optional(),         // the shipped trace triple, optional
}).strict();
```

Normative notes:

1. `seq` starts at 1 and MUST increase monotonically per instance
   (allocated by the MCP child at the send boundary, §9.3(5)). Sequence 0 is
   invalid.
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
4. `retiredSeqs` (rev 2) is bounded transport bookkeeping for sequence-hole
   recovery (§9.3(6)): at most 8 strictly-increasing integers, each smaller
   than the carrying request's own `seq`, each a sequence the child allocated
   and will never (re)send. It is **not** a dispatch-table operation and adds
   nothing to §7's closed surface (N21 is unaffected). Schema violations of
   the bound (> 8 entries, non-positive/non-integer entries) are
   `request_invalid`; semantic mishandling is handled tolerantly per §9.3(6).
5. **Child-side size pre-check (rev 2):** the child MUST NOT write a request
   line that exceeds the 1 MiB cap — a logical request whose serialized form
   exceeds the cap is refused child-side, before send-boundary allocation
   (no `seq` is consumed). A size-valid child request that the broker still
   answers `request_invalid` therefore indicates corruption or substitution
   on the path, and the strict response-binding rules of §6.5 apply.

**Version-skew note (rev 2a):** the response envelope is versioned
(`v: 1`); the request schema carries no version field in v1. A version
skew between child and host therefore manifests as `request_invalid`
null-bound envelopes the child cannot verify — a total but fail-closed
outage, diagnosable from the host audit log. Adding a request version
field is a future ADR's call, not a v1 change.

### 6.2 Response body schema

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

**Rev 2:** this object is the **inner body** of the wire response. On the
wire, every response is the signed envelope of §6.4 — `{ envelope, signature }`
— whose `envelope.response` field carries exactly this body (success or
error, complete). An unsigned body on the wire is a protocol violation the
child fails closed on (§6.5); there is no unsigned response mode in v1.

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

### 6.4 The signed response envelope (normative, rev 2)

Every response — success, every error code of §6.3, `degraded_refusing`
diagnostics, all of them — travels as **one JSON line** that is the
serialization of a versioned signed envelope:

```ts
payswapBrokerSignedResponse = {
  envelope: {
    v: 1,                        // protocol version; unknown versions fail closed (§6.5(3b))
    hostInstanceId: string,      // the host-boot id — the signing key's scope (§6.5.1)
    instanceId: string | null,   // the VERIFIED instance this response answers; null when the
                                 // request never passed §5.5 steps 1–4 (§6.4(3), rev 2a)
    seq: number | null,          // the answered request's seq — null unless the request was
    op: string | null,           //   attributable to a verified instance (§6.4(3))
    requestDigest: string,       // hex SHA-256 of the exact request line bytes (6.4.2)
    response:                    // the complete §6.2 body — success or error, nothing withheld
      | { ok: true,  seq: number, data: unknown }
      | { ok: false, seq: number, error: { code: PayswapBrokerErrorCode, message: string, retryable: boolean } }
  },
  signature: string              // base64 Ed25519 signature over canonical(envelope) (§6.5.2)
}
```

1. **The inner `seq` of §6.2's body is carried inside `response`** — and MUST
   equal the envelope's `seq` (a mismatch is a protocol violation, rejected
   at §6.5(3h)). The envelope's binding fields are authoritative; the body's
   is the compatibility echo.
2. **`requestDigest` is the exactness guarantee:** the SHA-256 hash, hex
   encoded, of the **exact request line bytes** as received by the host —
   UTF-8, excluding the terminating newline — regardless of whether the
   request parsed. This binds the response to the precise bytes the child sent
   for this attempt: parameters, routing hint, every field, byte-for-byte.
   The child computes the same hash over the bytes it wrote and compares
   (§6.5(3g)).
3. **Binding fields are request-attributed, never claim-echoed (rev 2a —
   the worker-challenge blocker fix).** The envelope's `instanceId`, `seq`,
   and `op` are populated **iff the request passed §5.5 steps 1–4** (peer
   verification → parse → token → instance/registry binding); only then do
   the payload's identity fields cease to be mere claims — they matched the
   connection's verified registry binding, and the envelope binds them. For
   every refusal issued **before or at** those steps — `request_invalid`,
   `peer_verification_failed`, `unauthorized`, `instance_unknown` — the
   envelope carries `instanceId: null`, `seq: null`, `op: null`, with the
   typed error in `response`. **Payload claims are never echoed into a
   signed envelope** (§5.2(3)'s rule, extended to the response direction).
   Consequences, stated honestly:
   - **A child can never verify a pre-binding refusal** — its own requests
     always carry concrete `instanceId`/`seq`/`op`, so a null-bound envelope
     fails §6.5(3d–f) and the child surfaces the generic typed retryable
     failure. Pre-binding diagnostics are unverifiable by design — an
     accepted cost (diagnostic availability, not security; the host's audit
     log §11 carries the typed truth). This is the fail-closed resolution of
     what would otherwise be a **signed-refusal oracle**: a registered
     sibling (adversary D8, using D10's endpoint substitution) relaying a
     victim's verbatim request bytes to the real broker receives a
     genuinely-signed refusal; had claims been echoed, every §6.5(3)
     binding would pass at the victim and the model would receive a
     cryptographically attested **false** refusal. Under this rule the
     relay's envelope is null-bound and the victim rejects it in full. The
     sibling-relay oracle row is a mandatory Step 2/7 test.
   - `degraded_refusing` (§5.4) responses are null-bound by construction
     (no peer verification exists to attribute the request) — children
     reject them and surface the typed failure; the operator diagnostic
     lives in the host log, as §5.4 already provides.
4. **Response line size cap (both sides):** the serialized envelope line
   MUST NOT exceed 1 MiB (`MAX_RESPONSE_BYTES = MAX_REQUEST_BYTES`). The
   child enforces the cap on receipt and fails closed on oversize — no
   partial trust, no "verify anyway" carve-out. The host enforces the
   mirror at **emission** (rev 2a): the broker MUST NOT emit an envelope
   whose serialized line exceeds the cap — an operation whose result cannot
   fit is answered `internal_error` (later waves paginate or narrow the
   response; they never oversize the envelope) — so no legitimate response
   is ever signed-then-unverifiable.
5. **Canonicalization:** the signature is computed over the **canonical JSON**
   serialization (RFC 8785 — JSON Canonicalization Scheme: UTF-8, object keys
   sorted, no insignificant whitespace) of the `envelope` object. One shared
   implementation lives in `packages/shared/src/payswap/` and is used by both
   the host (signing) and the child (verification); divergence between two
   implementations is a contract violation by construction. Property tests
   (playbook §4.2) must pin: `canonical(parse(canonical(x))) === canonical(x)`
   for every envelope the protocol produces. A response body value that
   cannot survive canonical round-trip (non-finite numbers, unsupported
   types) MUST be refused at envelope construction on the host
   (`internal_error` instead of a signed response) — the protocol never signs
   what it cannot serialize deterministically. **The child's mirror (rev 2a):
   canonicalization failure on a received envelope — a parsed value the
   shared module rejects (e.g. a non-JCS-serializable number) — is a full
   rejection, exactly like a signature failure.** Wave 2 bodies are small
   typed refusals; P2+ account-data schemas must preserve the canonical
   round-trip property, and their PRs carry the property rows.

### 6.5 Response authentication — host-signed, child-verified (normative, rev 2)

The architect's PR #4 review decision, adopted verbatim in substance: *the
contract must authenticate the broker to the calling process, not only the
calling process to the broker.* The rev-1 options were insufficient — an
`instanceId` echo is not cryptographic (the id is present in the child
environment and observable to a same-user process), and a response MAC keyed
by the per-instance token is forgeable by any substituted endpoint that
captured one request (§4.5 sends the token with every request). Asymmetric
signing removes both properties' weaknesses.

1. **The key pair (host-boot scoped).** At broker boot — the host process's
   financial-services start, the same lifetime that owns the endpoint of
   §3.1(3) — the host generates an **Ed25519** key pair (RFC 8032;
   deterministic signatures, no nonce-reuse failure class). The **private
   signing key never leaves host memory**: it MUST NOT enter any child
   environment, plugin config, manifest, log, file, socket, or any field of
   any broker request or response — the only place it exists is the signing
   call. The **public verification key** and the **host-boot id** (a fresh
   UUID per boot) are injected into the official PaySwap child through the
   trusted path of §4.2, as `PAYSWAP_BROKER_VERIFY_KEY` and
   `PAYSWAP_BROKER_HOST_ID`, with the same capture/strip/assertion discipline
   as the rest of the five-key tuple (§4.3, §4.4).
   *Scope decision (ADR-1):* one key pair per host boot, shared by all
   instances of that boot. Cross-instance confusion is already impossible —
   the envelope binds `instanceId` and the child checks it against its own
   (§6.5(3d)) — so per-instance signing keys would multiply secret material in
   host memory without adding a binding. Rotation is automatic every boot;
   there is no long-lived signing key to protect or rotate manually. The
   per-instance alternative is recorded as rejected in ADR-1 and may be
   revisited only by ADR.
2. **Signing (host side).** The broker signs **every** response envelope —
   success bodies, every §6.3 error code, degraded-mode refusals, shutdown
   refusals — with `sign(canonical(envelope))`. There is **no unsigned
   response mode in v1**; an implementation that can emit an unsigned
   response line violates this contract. `hostInstanceId` in the envelope is
   the boot id whose key signed it.
3. **Verification (child side, all bindings, fail-closed).** Before any part
   of a response is accepted as a tool result, the child MUST verify **all**
   of the following, in the order of §5.5's mirror:
   - **(a) signature validity** — Ed25519 verification of `signature` over
     `canonical(envelope)` under the injected `PAYSWAP_BROKER_VERIFY_KEY`
     (canonicalization failure of the received envelope is a full rejection,
     §6.4(5));
   - **(b) version** — `envelope.v` is a version the child implements;
   - **(c) host binding** — `envelope.hostInstanceId ===` the injected
     `PAYSWAP_BROKER_HOST_ID`;
   - **(d) instance binding** — `envelope.instanceId ===` the child's own
     `PAYSWAP_BROKER_INSTANCE_ID` (a null-bound envelope can never satisfy
     this — §6.4(3));
   - **(e) sequence binding** — `envelope.seq ===` the `seq` of the in-flight
     attempt this response answers;
   - **(f) operation binding** — `envelope.op ===` that attempt's `op`;
   - **(g) request-digest binding** — `envelope.requestDigest ===` the SHA-256
     hash defined in §6.4(2), computed by the child over **the exact request
     line bytes it wrote for that attempt, excluding the terminating
     newline** (the same byte range the host hashes — a digest over any other
     range, including one that includes the newline, is a mismatch);
   - **(h) body conformance** — `envelope.response` matches §6.2's shape, and
     its inner `seq` equals the envelope's `seq`.
   **Invalid, missing, stale, modified, cross-instance, cross-boot, or
   mismatched — any failure of (a)–(h) — the response is rejected in full**
   ("stale" here means precisely: not bound to the current in-flight
   attempt's exact `(instanceId, seq, op, request bytes)` — there is no
   wall-clock freshness claim in v1). The child surfaces a typed retryable
   failure through the tool envelope, discards every field of the rejected
   response (nothing from it may reach the model or the tool result), and MAY
   retry the attempt per §9.3(5) recovery semantics (same `seq`, same logical
   request) within a bounded retry budget; exhaustion surfaces the typed
   failure. The child never auto-reissues a *new* logical request —
   re-issuing is the caller's decision, visible as a new tool call. **The
   per-attempt read deadline (rev 2a):** the child MUST impose a response
   read deadline on every attempt — SHOULD be 30 s, aligned with the
   server-side idle timeout of §3.3(4) — feeding the same retry budget; an
   endpoint that holds the connection open cannot hang an attempt past the
   deadline.
4. **What the bindings defeat (each row is a mandatory adversarial test):**
   | Attack | Defeated by | Test row |
   |---|---|---|
   | Substituted socket returns **fabricated** responses | (a) — no private key, no valid signature | Step 2 module suite + Step 7 chain suite |
   | Captured valid response, **modified** (any field, or the signature) | (a)/(g) — canonical signature covers the whole envelope | Step 2 + Step 7 |
   | Captured valid response, **replayed** against a different in-flight request | (e)/(f)/(g) — seq/op/digest bind to the exact attempt | Step 2 + Step 7 |
   | Response from **instance A applied to instance B** | (d) — per-spawn instanceIds are distinct | Step 7 |
   | Response from a **previous host boot** (stale capture, old key) | (a)/(c) — per-boot key + host id binding | Step 7 (restart arm) |
   | **Sibling-relay signed-refusal oracle** — a registered sibling relays the victim's verbatim bytes to the real broker and presents the signed refusal to the victim | §6.4(3) — pre-binding refusals are null-bound; claims are never echoed | Step 2 + Step 7 (mandatory, rev 2a) |
   | **Downgrade** — unsigned JSON, missing signature field, unknown version | (a)/(b) — fail closed, no unsigned mode | Step 2 + Step 7 |
   | Oversize / unparseable line | §6.4(4), §5.5 mirror — rejected before verification | Step 2 |
5. **The same-request replay residue, stated honestly:** a captured envelope
   for `(instanceId, seq)` presented to a *byte-identical retry* of that same
   logical request verifies — because it **is** the broker's true answer to
   that exact request; at-most-once dispatch (§9.3) guarantees the broker
   answered `(instanceId, seq)` exactly once, so the replayed envelope cannot
   assert anything the broker did not actually answer. What an endpoint
   attacker retains is **suppression, reordering, and freshness steering**
   (withholding the true response, presenting it late, or choosing *which*
   true answer — the original's or a duplicate refusal to the retry — the
   child sees) — availability attacks, not integrity ones; and an accepted
   replayed answer reflects the broker's state at **original-dispatch time**,
   not retry time — a caller that needs current state re-issues with a new
   `seq`. The child's bounded-retry failure surfaces the suppression cases.
   This residue is recorded in the threat model (§7.2) rather than laundered,
   and is flagged for revisit at P2, when data-bearing responses make
   freshness steering more valuable to an attacker.
6. **Test obligations precede implementation code (playbook §4.2, binding):**
   the adversarial rows of §6.5(4) and the binding-mismatch rows of
   §6.5(3) land as RED tests **before** the signing/verification
   implementation commits that turn them green — in the Step 2 PR (keypair,
   injection, canonicalization, sign/verify modules with their unit/property
   adversarial tests), exercised on the real path from Step 4 on, and run to
   completion in the Step 7 chain suite. A PR that lands response-signing
   code without its red-first adversarial evidence is out of process.

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
5. **Allocation discipline (child side, rev 2 — send-boundary allocation):**
   the MCP child allocates `seq` **only at the send boundary** — the sequence
   is assigned atomically with the initiation of the write. A prepared but
   unsent request holds **no** sequence (a connect failure consumes nothing;
   a cancelled-before-send request consumes nothing). Once **any byte** of a
   request has been handed to the socket, delivery is **uncertain**, and the
   rules are:
   - **Uncertain delivery (may have reached the broker):** the `seq` is
     retained; a retry MUST present the **same logical request** — same
     `instanceId`, `seq`, `op`, `params`, `sessionId` — with byte-stable
     serialization SHOULD-preserved (the per-attempt digest binding of §6.5(4g)
     makes byte-stability non-load-bearing for verification, but stability
     keeps captured-response analysis clean). Two outcomes are possible and
     both are safe: the original never arrived → the retry is the first
     acceptance and dispatches once; the original arrived → the retry is
     refused `sequence_duplicate` and the child surfaces the typed duplicate
     failure (re-issuing the operation is a **new** logical request with a
     **new** `seq` — the caller's visible decision; outcome reconciliation
     for side-effecting operations is §9.6's idempotency layer, not a
     transport retry).
   - **Provable non-delivery (write failed before any byte was handed off,
     e.g. `EPIPE` on a first write that accepted zero bytes):** the child MAY
     retry with the same `seq` (always safe) or retire the `seq` (rule 6) and
     re-prepare with a fresh one. Either path closes without a permanent
     gap.
   - **Abandonment (a cancelled tool call that will never be retried):** the
     `seq` is retired via rule 6 on the child's next request. An abandoned
     uncertain `seq` is never reused for a different logical request.
6. **Retirement declarations (rev 2 — bounded, transport-level, never a
   dispatch op):** a sequence the child allocated and will never (re)send is
   closed by carrying it in the optional `retiredSeqs` field of a subsequent
   request (§6.1 note 4: ≤ 8 strictly-increasing integers per request, each
   smaller than that request's own `seq`). **Processing is independent of the
   carrier's own fate (rev 2a, worker-challenge fix):** the `retiredSeqs` of
   a request that passed §5.5 steps 1–4 (peer → parse → token → instance
   binding) are processed **even when the carrying request itself is
   refused** — including `sequence_gap_exceeded` — because retirement is
   transport bookkeeping, not dispatch. Without this rule, an instance that
   abandons ≥ G consecutive sequences would wedge permanently: every
   subsequent carrier fails the gap test, no retirement is ever processed,
   and the watermark can never advance. All `W`/`R` mutations — accept,
   retirement resolution, watermark advance, pruning — share the per-instance
   lock of rule 4 (one atomic state machine, no interleaving window).
   Broker rules, per entry `e`:
   - `e ≤ W` or `e ∈ R` (already accepted): **ignore**, log informational —
     the child cannot know `W`/`R`, so tolerance is required, and the
     at-most-once property is untouched (an accepted `seq` stays accepted;
     retirement never un-accepts and never removes from `R` except via
     watermark advance over accepted sequences).
   - `e ≥` the carrying request's own `seq`, or otherwise nonsensical
     (duplicate within the array, not strictly increasing): **ignore**, log
     as a protocol note (child defect — visible in audit, not fatal).
   - otherwise (`W < e <` carrying `seq`, never accepted): mark
     **resolved-missing**, and `W` advances contiguously through
     `accepted ∪ resolved-missing`, pruning `R` as it goes.
   A `seq` that later **arrives** despite being resolved-missing is `≤ W` →
   `sequence_duplicate` before dispatch (fail-closed; the child broke its
   declaration, never the broker's guarantee). Retirement entries are
   audit-logged (§11) with their effect. This field is transport bookkeeping
   only — it adds no operation to §7's closed table and no authority to the
   child (the lying-retirement rows are mandatory Step 6 tests: retire an
   accepted `seq` → no effect; retire an in-`R` `seq` → no effect; retire
   then send the retired `seq` → `sequence_duplicate`, zero dispatch; and
   the wedge-recovery row: force > G abandoned sequences, then recover
   purely through retirement-carrying requests that individually fail the
   gap test until the watermark clears).

### 9.4 The bounded gap (fixed v1 protocol constant, rev 2)

A request with `seq > W + G`, where **`G = 64` is a fixed v1 protocol
constant**, is refused `sequence_gap_exceeded` **before dispatch**. The
retained set is thereby bounded by `G`, and a peer cannot balloon broker
memory by skipping ahead.

1. **`G` is not a deployment setting.** No configuration surface — no
   settings key, no environment variable (`PAYSWAP_REPLAY_GAP` and any
   equivalent knob MUST NOT exist), no CLI flag, no manifest field — may
   alter it. The constant lives once, in the shared protocol module, exported
   and referenced by both sides.
2. **Boundary rows (mandatory Step 6 tests):** with `W` fixed at a known
   point, `seq = W + 64` is accepted; `seq = W + 65` is refused
   `sequence_gap_exceeded`.
3. **Memory bound (mandatory Step 6 test):** `|R| ≤ G` per instance at all
   times — demonstrated under an adversarial gap-flood (repeated max-gap
   allocations) with the retained-set size asserted after every step.
4. **Changing `G`** requires (a) an ADR in `docs/payswap/p1/` recording
   **measured concurrency and memory evidence** from real workloads, (b) a
   hard upper bound stated in that ADR with the measurement that justifies
   it, and (c) a contract amendment PR. No other path exists.

(The alternative — strict in-order dispatch per instance — was considered and
rejected in the P0 addendum: it would serialize concurrent requests that
legitimately ride separate connections; the retained-set algorithm provides
the same replay guarantee without the serialization.)

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
   `stdio-transport.ts`'s `recordExit`) tombstones the entry. **Tombstones
   carry a reason, set at tombstone time (rev 2a):** the reason selects the
   refusal the broker answers to residual calls of that instance —
   exit-tombstoned instances answer `instance_unknown`, disable-tombstoned
   instances answer `financial_mode_disabled` (§7.3) — so the append-only
   registry (§10.1) can distinguish them without mutating entries. A
   tombstoned instance's requests fail accordingly — covering the pid-reuse
   race (§5.2) and the dead-child token arm of N20.
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
| Sequence-gap bound enforced at the frozen constant (W+64 accepted, W+65 refused) | Step 6 suite | §9.4 |
| Retained-set memory bound `\|R\| ≤ G` under adversarial gap-flood | Step 6 suite | §9.4 |
| Retirement declarations close holes; lying retirements have no effect; retired seq sent later = `sequence_duplicate`, zero dispatch | Step 6 suite | §9.3(6) |
| Cancellation & connection-failure recovery, both delivery situations, explicit (before-send: no allocation; after-send: retain-then-retry-or-retire) | Step 6 suite | §9.3(5) |
| **Signed-response authentication: fabricated / modified / replayed / cross-instance / previous-host-boot responses all rejected fail-closed** | Step 2 module suite + Step 7 chain suite | §6.4, §6.5 |
| **Sibling-relay signed-refusal oracle** (registered sibling relays victim's verbatim bytes; the victim must reject the resulting null-bound signed refusal) | Step 2 + Step 7 suites | §6.4(3) |
| Pre-binding refusals (`request_invalid` / `peer_verification_failed` / `unauthorized` / `instance_unknown` / degraded-mode) are null-bound, unverifiable by any child, surfaced as typed failure | Step 2 + Step 7 suites | §6.4(3) |
| Response binding mismatches (version / host / instance / seq / op / request-digest / body) rejected | Step 2 + Step 7 suites | §6.5(3) |
| Unsigned or unknown-version response rejected (no unsigned mode) | Step 2 + Step 7 suites | §6.4, §6.5(2) |
| Host/child request-digest byte-range equality on the happy path (multi-chunk socket write included) | Step 2 suite | §6.4(2), §6.5(3g) |
| Host never emits an oversize envelope (emission cap → `internal_error`) | Step 2 suite | §6.4(4) |
| Five-key credential tuple: all-or-nothing capture, strip, launch assertion (partial-tuple rows) | Step 2 suite | §4.2–§4.4 |
| **Credential currency**: complete stale-tuple pre-plant → launch refused; current-boot tuple with mismatched socket → refused | Step 2 suite | §4.4(2) |
| **Tool-env passthrough**: Bash/tool children cannot recover any `PAYSWAP_BROKER_*` key via tool-env passthrough | Step 2 suite | §4.3(1) |
| Private signing key never in child env, config, logs, files, or any wire field | Step 2 + Step 7 suites (secret-pattern scan) | §6.5(1) |
| Audit log complete over the adversarial run; zero credential material in logs | Step 7 suite | §11 |

Additional step gates (from the README sequence): each implementation PR
lands its section's unit/property tests plus the harness extension rows it
can carry; Step 7 runs the complete chain suite — MCP child (real plugin
build) → broker → financial service stub — through the **production host
launch path** (no test-only launcher; the PR #3 discipline).

### §12.1 Implementation order (binding, rev 2)

Playbook §4.2 governs security changes: **the negative/bypass tests are
written and run RED before the implementation code that turns them green.**
For this contract that means, concretely:

1. **Step 2 PR** (contract §4, §10, §6.5.1 key/injection portions) lands,
   in commit order: (a) the RED adversarial tests for the five-key tuple
   capture/strip/assertion, the canonicalization round-trip properties, and
   the sign/verify module's rejection rows (fabricated, modified, replayed,
   binding-mismatch, unsigned, unknown-version, oversize); (b) then the
   implementation commits — host-boot Ed25519 keypair minting, five-key
   trusted injection, capture/strip/assertion, the shared canonicalization
   module, the envelope sign/verify modules — recorded RED→GREEN per
   playbook §9.
2. **Step 4 PR** (§6, §7) lands the wire schemas (`.strict()`, `retiredSeqs`)
   and exercises broker signing + child verification on the real request
   path, with its own RED-first rows for the schema and dispatch closures.
3. **Step 6 PR** (§9) lands the watermark/retained-set engine with the frozen
   `G`, allocation/recovery, retirement declarations, and all replay arms —
   RED-first: the N33/N34/N35/N39 rows, the 64/65 boundary rows, the
   memory-bound row, and the cancellation/connection-failure rows precede
   the engine commits.
4. **Step 7 PR** runs the complete adversarial chain suite over the
   production host launch path, including every §6.5(4) response-auth row
   end-to-end (real substituted-socket, real restart, real cross-instance
   harnesses).

A PR that lands implementation code for any section without its RED-first
adversarial evidence for the security rows of that section is out of process
and is rejected at TL review — the same discipline the playbook makes
mandatory for every security change.

---

## §13 What this contract does not authorize

No Stripe, Paystack, PayPal, or any payment provider. No live account data.
No money movement. No authorization grant minting, validation, or storage.
No provider credential storage. No network exposure. No settings-surface,
composer, navigation, or upstream-semantics change beyond the additive
injection points §4.2/§4.3 name (themselves the CUA pattern's exact shape).
The six operations resolve to typed refusals until P2+ gates open them. The
rev-2 response-signing key pair authenticates the channel and authorizes
nothing: in Wave 2 there is no account data to sign and no side effect to
authorize — it exists so that **when** provider information is allowed to
cross (P2+), it already crosses a mutually authenticated, replay-proof
bridge. This contract is the boundary the architect set: **the broker exists
to make the crossing verified in both directions, replay-proof, and closed —
nothing crosses it yet.**

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

## Appendix B — Rev-2 external normative references (not upstream code)

The rev-2 mechanisms cite external standards, not this repository's code;
they are recorded here so the citation discipline stays complete:

| Mechanism | Reference | Role in this contract |
|---|---|---|
| Ed25519 signatures (deterministic) | RFC 8032 (Edwards-Curve Digital Signature Algorithm, §5.1 Ed25519) | §6.4 `signature`, §6.5.1 key pair, §6.5.2 signing, §6.5.3(a) verification |
| Canonical JSON serialization | RFC 8785 (JSON Canonicalization Scheme) | §6.4(5) — the deterministic byte form the signature covers; one shared implementation, property-tested |
| SHA-256 request digest | FIPS 180-4 | §6.4(2) `requestDigest` — exact-request binding |

Node's `crypto` module (`generateKeyPairSync('ed25519')`, `sign(null, …)`,
`verify(null, …)`, `createHash('sha256')`) implements all three; the
implementation PR pins the exact API surface in the shared module with
interop vectors from the RFCs' test suites.
