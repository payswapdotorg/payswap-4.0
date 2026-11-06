# P1 Wave 2 Deliverable 3 — Broker Architecture Decision Records (rev 2)

**Owner:** TL · **Status:** accepted (architect review of PR #4, 2026-11-05,
id 5785051406) · **Scope:** amendments to `w2-01-broker-contract.md` and
`w2-02-broker-threat-model.md` recorded as decisions, per playbook §1
("record material decisions in a short ADR in the relevant module/spec").

These ADRs record the two decisions the architect's PR #4 review made, the
alternatives that were rejected, and the recovery semantics the review
required. The contract sections carry the normative text; this file carries
the reasoning and the acceptance trail.

---

## ADR-1 — Ed25519 host-signed responses (per-boot key)

**Context.** The rev-1 contract authenticated the caller→host direction
only. The threat model's own residual §7.2 admitted the same-user
socket-replacement attack, and the rev-1 candidate mitigations were
insufficient: an `instanceId` echo is not cryptographic authentication (the
id is present in the child environment and observable to a same-user
process), and a response MAC keyed by the per-instance token is forgeable by
any substituted endpoint that captures a single request, because §4.5 sends
that token with every request. The architect's review (finding 1) decided
the matter: asymmetric response signing, in Wave 2 / P1, before any provider
information crosses the bridge.

**Decision.**

1. The host generates an **Ed25519 key pair at every broker boot** (host
   process financial-services start). The **private key stays exclusively in
   host memory** — never in any child env, plugin config, manifest, log,
   file, or wire field. Only the **public key** is injected into the
   official PaySwap child, through the trusted path of contract §4.2, as
   `PAYSWAP_BROKER_VERIFY_KEY`, alongside the host-boot id
   (`PAYSWAP_BROKER_HOST_ID`). The credential tuple is five keys,
   all-or-nothing captured (§4.4), all stripped from every other environment
   (§4.3).
2. Every response is a **versioned canonical envelope** (§6.4) signed with
   the boot key: `v`, `hostInstanceId`, `instanceId`, `seq`, `op`,
   `requestDigest` (SHA-256 of the exact request line bytes), and the
   complete success-or-error body. Canonical form is RFC 8785 JSON, one
   shared implementation, property-tested for round-trip stability.
3. The child verifies the signature **and every binding** before accepting
   any response (§6.5.3): version, host id, instance id, seq, op, request
   digest, body conformance. Any failure — invalid, missing, stale,
   modified, cross-instance, cross-boot, mismatched — fails closed; nothing
   from a rejected response reaches the model.
4. **Key scope: one pair per host boot**, shared by all instances of the
   boot. Rejected alternative: per-instance signing keys — they multiply
   secret material in host memory without adding a binding the envelope
   does not already carry (instanceId is bound and checked); rotation would
   be per-spawn instead of per-boot for no security gain. Revisit only by
   ADR with a stated reason.
5. Mandatory adversarial rows (RED before implementation code, §12.1):
   substituted socket returning fabricated responses; modified responses;
   replayed responses; cross-instance responses; signatures from a previous
   host boot; binding-mismatch, unsigned/unknown-version, and oversize rows.

**Rejected alternatives (recorded).**

- *Instance-id echo:* not cryptographic; observable in child env.
- *Response MAC under the per-instance token:* the token travels in every
  request, so a substituted endpoint captures it and can forge the MAC.
- *Per-instance signing keys:* no added binding (see decision 4).
- *TLS/mTLS over the local socket:* transport machinery heavier than the
  threat requires for a local-domain endpoint; adds certificate-lifecycle
  surface without a property Ed25519 envelopes do not already provide.
- *Deferring to P2:* rejected by the review — the bridge must authenticate
  both sides **before** provider information crosses it.

**Consequences.** Five-key credential tuple with all-or-nothing capture; a
shared canonicalization module in `packages/shared/src/payswap/`; every
broker response path signs, every child path verifies; the honest
same-request replay residue and the suppression/reordering residue are
recorded in threat model §7.2 rather than laundered; no unsigned response
mode exists in v1.

---

## ADR-2 — Frozen replay gap G = 64 and sequence-allocation recovery

**Context.** The architect accepted `G = 64` but froze it as a v1 protocol
constant rather than an unrestricted deployment setting (review finding 2),
and required the contract to settle sequence-allocation recovery: a request
that may have reached the broker must retain its sequence when retried; a
request definitely never sent must not leave a permanent sequence gap;
cancellation and connection failure need explicit tests for both situations.

**Decision.**

1. **`G = 64` is a fixed v1 protocol constant** (contract §9.4): no
   settings key, environment variable, CLI flag, or manifest field may
   alter it. The constant is exported once from the shared protocol module.
   Mandatory boundary tests: `W+64` accepted, `W+65` refused. Mandatory
   memory-bound test: `|R| ≤ G` per instance, asserted under an adversarial
   gap-flood. Changing `G` requires an ADR with **measured concurrency and
   memory evidence** and a stated hard upper bound, plus a contract
   amendment — no other path.
2. **Allocation happens only at the send boundary** (§9.3(5)): a prepared
   but unsent request holds no sequence; a failed connect consumes nothing;
   once any byte is handed to the socket, delivery is **uncertain** and the
   `seq` is retained — a retry presents the same logical request (same
   instanceId, seq, op, params, sessionId), and a delivered-but-unanswered
   request replays as `sequence_duplicate` (re-issuing is a new logical
   request; outcome reconciliation for side effects is the §9.6 idempotency
   layer, never a transport retry).
3. **Retirement declarations close abandoned holes** (§9.3(6)): a `seq` the
   child will never (re)send — cancelled after send, or provably never
   delivered — is declared on a subsequent request through the bounded
   `retiredSeqs` field (≤ 8 strictly-increasing integers, each below the
   carrying request's own seq). The broker marks never-accepted entries
   resolved-missing and advances the watermark contiguously; entries naming
   already-accepted sequences are ignored and logged (the child cannot know
   the broker's watermark); a retired sequence that later arrives is
   refused `sequence_duplicate` before dispatch. Retirement adds no
   operation to the closed dispatch table (N21 untouched) and no authority
   to the child — the lying-retirement rows are mandatory tests.

**Rejected alternatives (recorded).**

- *Deployment-configurable gap:* an unrestricted knob; frozen instead
  (finding 2). 
- *Broker-side gap garbage collection (time-based):* a time-based closure
  could accept a late frame after the collector forgot a dispatched
  sequence — a double-dispatch window. Hole-closing must be child-declared,
  monotone, and never time-dependent; retirement declarations are exactly
  that.
- *Strict in-order dispatch:* rejected already in the P0 addendum — it
  serializes legitimate concurrent requests; the retained-set algorithm
  provides the same replay guarantee without the serialization.

**Consequences.** The request schema gains one optional bounded field
(`retiredSeqs`); the broker's watermark can always advance, so no
definitely-unsent or abandoned sequence can permanently wedge an instance;
mandatory recovery tests cover cancellation and connection failure before
versus after possible delivery.

---

## ADR-3 — Linux peer-credential read: ss(SOCK_DIAG) pairing + procfs holder scan (Step 3)

**Context.** Contract §5.1(1) requires the broker to read the connected
peer's real (pid, uid) at accept time, "via the runtime's peer-credentials
API where the runtime exposes it, else a small native helper." Node's public
surface exposes neither `SO_PEERCRED`/`getpeereid` nor client-socket
pre-`bind` (verified empirically on Node 24: accepted sockets see
`remoteAddress: undefined` from unbound clients, and `/proc/net/unix` lists
only bound sockets — no pairing information). A native addon is a build
burden the Step-3 PR should not add.

**Decision.** The Linux arm composes three kernel sources, each of which the
attacker cannot forge:

1. the accepted socket's fd (libuv handle) → `/proc/self/fd/<fd>` → own
   socket inode;
2. `ss -xH state established` (iproute2 speaking netlink `SOCK_DIAG` to the
   kernel) → the `u_str` row's local/peer inode **pairing** — the only
   pure-Node source of the two-ends relationship;
3. a full `/proc/<pid>/fd` scan for the holder of the peer socket inode —
   **exactly one** holder (an fd passed to a second process is ambiguous →
   refuse), with the effective uid from `/proc/<pid>/status`.

`ss` is resolved only from a fixed absolute-path allowlist
(`/usr/sbin/ss`, `/usr/bin/ss`, `/bin/ss`, `/sbin/ss`), spawned with a
stripped environment, a 2 s timeout and an 8 MB output cap, and parsed with
a strict row regex; the whole read path carries a 2.5 s wall-clock budget.
Any failure, timeout, or ambiguity returns `null` = identity not
established = fail-closed (§5.4). Non-Linux platforms get no reader
(`createDefaultPeerCredentialReader` → unavailable) — the macOS
`SecCodeCheckValidity`/`getpeereid` helper and the Windows pipe helper
(§5.3) are later native work; until then those platforms boot
`degraded_refusing`.

**Rejected alternatives (recorded).**

- *Native addon (node-gyp):* the contract's escape hatch, but a new native
  build surface for every platform/arch in Step 3; ss+procfs delivers the
  same kernel answer with zero build cost. Revisit if a deployment target
  lacks iproute2 (the boot self-probe degrades there — ADR-4 — which is the
  honest state, not a silent one).
- *`/proc/net/unix` alone:* lists only *bound* sockets and carries no
  pairing — it cannot identify an unbound client's inode. Verified
  empirically; recorded so it is not re-attempted.
- *Client-side abstract-namespace bind + `remoteAddress`:* Node exposes no
  client `bind()`; not constructible.
- *Trusting the child's self-reported pid:* violates §5.2(3) (a claim on
  the wire is never sufficient); rejected without test.

**Consequences.** Peer identity on Linux is kernel-sourced end to end; the
residual risks are (a) `ss` absence on minimal images → degraded_refusing
(the self-probe detects it at boot, operator-visible), (b) inode-reuse
races between accept and the scan — bounded by requiring the token to also
match (§4.5) and the registry liveness check (§5.2), (c) a same-uid PATH
hijack planting a fake `ss` — mitigated by the absolute-path allowlist, and
the spoof gains nothing without the instance token. All three are recorded
in the threat model's Step-3 rows.

---

## ADR-4 — Boot self-probe: identity through a real loopback pair, before the listener binds (Step 3)

**Context.** §5.4 requires the broker to know **at boot** whether the
peer-verification subsystem is available, and to start `degraded_refusing`
when it is not. "Available" must mean *proven on this machine*, not
*assumed by platform check* — iproute2 can be missing, /proc can be mounted
oddly, and the runtime's `ss` invocation can fail.

**Decision.** Before binding the real listener, the boot sequence creates a
**real loopback UDS pair** (throwaway `mkdtemp` probe directory + listener +
self client + accepted socket — no mocks, the exact kernel path production
connections take) and runs the **full** credential-read pipeline on the
accepted socket. The subsystem counts as available only if the reader
identifies the probe's peer as the host itself: `pid === process.pid` and
effective `uid === process.geteuid()`. The probe directory is removed
afterwards; the boot result exposes `{verified, pid, uid}` for diagnostics.
On failure the broker still binds the endpoint (§5.4: diagnostics must be
reachable) but answers every request `peer_verification_failed` at the peer
gate — token-only fallback remains prohibited.

**Rejected alternatives (recorded).**

- *Platform check only (`process.platform === "linux"`):* assumes
  availability; an image without `ss` would discover the failure only on
  the first real request. The probe makes the degraded state a boot-time,
  operator-visible fact (§11(3) audit event with the reason).
- *Probe with a synthetic reader result (mocking the reader at boot):* a
  mock proves nothing about the machine; the probe must exercise ss +
  procfs for real.

**Consequences.** Boot cost on Linux is one extra throwaway socket pair
(~tens of ms); every platform without a working read path boots
`degraded_refusing` by construction, which is the §5.4 "fail closed on all
supported OSes" arm for Step 3. The Step-3 suite pins both directions:
default-Linux boot → `peer_verified` with self pid/uid; forced-unavailable
reader → `degraded_refusing` with the socket bound.

---

## ADR-5 — failPeer discipline and the check order at the connection level (Step 3)

**Context.** §5.5 fixes the per-connection order — peer verification before
payload parse, token before registry binding — and §6.3 requires refusals
to be typed, machine-readable lines the peer can actually receive. The
implementation-level questions were (a) how to refuse a connection **while
the peer is still writing** without losing the error line, and (b) where
the shutting-down check sits.

**Decision.**

1. **D5.4 — failPeer = `socket.end(line)` + `socket.resume()`:** the typed,
   signed, null-bound refusal line is written and the write side
   half-closed; the read side is put into flowing mode so the peer's
   in-flight bytes are consumed and discarded **without ever being
   parsed** (the §5.5 invariant), and no RST is generated — the peer is
   guaranteed to read the complete error line even mid-write. The drain is
   capped (5 s hard destroy) so a malicious endless stream cannot pin a
   half-open socket. `destroy()` was rejected: a destroy racing the peer's
   unread receive buffer can surface as RST, and the kernel may discard the
   error line before the peer reads it — the adversarial suite pins the
   row (an unverified peer streaming 5 MB still receives the complete
   line).
2. **D5.5 — token binds to the peer-mapped instance, never the claim:** the
   timing-safe comparison runs against the token of the instance the
   **verified pid** maps to (§5.2 spawn table); the wire's `instanceId` is
   then *checked* against that same mapping (§5.2(3)). Cross-instance
   tokens die at `unauthorized`; own-token foreign-id claims die at
   `instance_unknown`.
3. **D5.6 — tombstoned instances answer `instance_unknown` at the Step-3
   bridge:** both tombstone reasons (§10.2(1)). The disable-arm's business
   answer (`financial_mode_disabled`, §7.3) rides the dispatch table that
   lands with Step 4 — §12 already assigns the residual-call reachability
   row to the Step 2/5 suites, so Step 3's bridge-level `instance_unknown`
   is the strictly-safe interim, recorded here so the Step-4 upgrade is a
   diff against a stated decision, not a silent change.
4. **Shutting-down sits between the peer gate and the parse, evaluated at
   line receipt:** the peer gate always runs first (an unverified peer is
   refused `peer_verification_failed` even during shutdown); a line that
   arrives after `close()` began is answered `broker_unavailable`
   (retryable, §6.3) **without being parsed**. The first implementation
   placed the check before awaiting the line — the adversarial row caught a
   request dispatched after shutdown began; the check moved to
   line-receipt and the row went green (RED-first working as intended).
5. **Step-3 interim dispatch answers `not_connected`:** with no account
   model in this wave (§13), §7.3's S2 row ("enabled, opted in, no account
   → `not_connected`") is the only true answer a fully-verified request can
   receive; it rides the signed envelope as `{kind:"refused",
   refusal:{code:"not_connected",…}}` data (the plugin contract's refusal
   envelope shape; the message text mirrors `payswap-plugin/src/contract.ts`
   — bootstrap cannot import the plugin package, direction reversed). The
   live-state dispatch (enabled-map reading, the S1/`financial_mode_disabled`
   branches) lands with Step 4.

**Consequences.** Every refusal path writes exactly one signed line and
drains; the check order is test-pinned (peer-failed oversize writers get
`peer_verification_failed`, never `request_invalid`); the response to a
verified request is request-attributed (§6.4(3)) and the Step-3 suite
verifies it with the shared envelope module's full sequence.

---

## ADR-6 — close() semantics: unlink-first, grace-bounded teardown, unconditional finally (Step 3)

**Context.** The broker owns a per-boot directory and socket file (§3.1)
and in-flight connections; a host shutdown must not hang on a stuck peer,
must never leave a stale endpoint reachable (§3.4/§10.3), and must be safe
to call twice.

**Decision.**

1. **Unlink before draining:** `close()` removes the socket path **first**,
   so no new connection can resolve the endpoint while teardown proceeds
   (the stale-endpoint arm of N22); pending backlog connections fail with
   `ECONNREFUSED`, which is the correct §10.3 semantics (a broker restart
   is a host restart; pre-restart incarnations are unreachable by
   construction).
2. **Grace-bounded live-count drain:** in-flight connections get
   `closeGraceMs` (default 250 ms) to finish; the live count is released
   **unconditionally in the connection handler's `finally`** — every early
   return, refusal path, and thrown error decrements it, so the count can
   never leak and wedge a future `close()`. Stragglers are force-destroyed
   at the deadline (the fallback); half-open drain sockets from
   failPeer/refuseParsed carry their own 5 s destroy cap (ADR-5 D5.4).
3. **Unconditional finally cleanup + idempotence:** the socket file and the
   per-boot directory are removed in the teardown tail regardless of drain
   outcome; the second `close()` call returns the same resolved promise.
   `broker_unavailable` (retryable) is the typed answer for requests that
   arrive inside the shutdown window (ADR-5 D5.6 arm 4).

**Rejected alternatives (recorded).**

- *`server.close()` alone (wait for all connections):* a stuck or malicious
  idle peer hangs host shutdown indefinitely — the 250 ms fallback exists
  precisely so that cannot happen; waiting without a bound was rejected.
- *`destroy()` on all sockets immediately:* would race in-flight legitimate
  responses the same way destroy races the failPeer line (ADR-5 D5.4);
  grace-then-destroy preserves the answer window.

**Consequences.** Host shutdown is bounded (~grace + destroy), the endpoint
directory dies with the listener (§3.1(3)), and the suite pins: close
removes both fs entries, is idempotent, releases a stuck live connection
within the fallback, and answers in-window requests `broker_unavailable`.

---

## TL acceptance record — P1.1 (broker contract and threat model)

Checklist-based acceptance against the P0 addendum and the architect's PR #4
review, per playbook §1 and §9 (in-scope contract acceptance is a TL
responsibility; no external sign-off is required or sought).

| # | Requirement | Where satisfied | Verdict |
|---|---|---|---|
| 1 | Host-owned broker; only path to host financial services (addendum §3.2) | contract §0, §7 | met |
| 2 | Authenticate the calling process, not a claim (addendum §3.5) | contract §4, §5, §10 | met |
| 3 | Authenticate the broker to the child — Ed25519, host-memory private key, trusted-injected public key, canonical envelope binding instance/seq/op/request-digest/response (review finding 1) | contract §6.4, §6.5; ADR-1 | met |
| 4 | Response-auth adversarial test obligations present and RED-first ordered (review finding 1) | contract §6.5(4)/(6), §12.1; threat model §9.3 | met |
| 5 | Fixed G = 64 with boundary + memory-bound tests; ADR-only change path (review finding 2) | contract §9.4; ADR-2 | met |
| 6 | Sequence-allocation recovery: send-boundary allocation, retain-on-uncertain, no permanent gaps, cancellation/connection-failure tests (review finding 2) | contract §9.3(5)–(6); ADR-2 | met |
| 7 | Later-wave scope stated as P1 subwaves (P1.6/P1.7), P1 not closed by the broker alone (review finding 3) | README (this PR) | met |
| 8 | No external approval dependency; TL acceptance language (review finding 4) | contract header, README, PR description | met |
| 9 | Rev-1 threat-model T4 overclaim corrected | threat model T4 (correction note), T9 | met |
| 10 | Fail-closed posture on every arm (addendum §3.5 item 2) | threat model §6 (8 rules); contract §5.4, §6.5 | met |
| 11 | Independent worker challenge of the revised threat model completed and dispositioned | section below | met — 1 blocker + 4 majors found, all dispositioned in rev 2a (below) |

**Worker challenge (independent adversarial review):** completed 2026-11-05
by an independent reviewer (fresh context, no authorship bias) over the full
rev-2 documents. Verdict: **1 blocker, 4 majors, 12 minors**; the core
replay machinery, canonicalization design, cross-boot/cross-instance
bindings, and governance amendments survived every attack attempted. All
findings were accepted and dispositioned in **revision 2a** (same PR,
contract + threat model amended accordingly):

| ID | Severity | Finding (abridged) | Disposition (rev 2a) |
|---|---|---|---|
| F1 | blocker | Signed-refusal oracle: pre-binding error responses (`unauthorized`, `instance_unknown`, degraded-mode) had no specified binding source; echoing payload claims would let a registered sibling relay a victim's verbatim bytes and feed it a genuinely-signed false refusal passing every §6.5(3) binding | Envelope binding fields are **request-attributed, never claim-echoed** (contract §6.4(3)): populated iff the request passed §5.5 steps 1–4; all pre-binding refusals are null-bound and unverifiable by any child by design. Sibling-relay row added to §6.5(4) and §12 |
| F2 | major | Credential-currency gap: a complete *stale* five-key tuple passes the presence-only launch assertion → official child trusting a previous boot's signing key | §4.4(2) now requires live-state validation (host id = current boot, instance id live in registry, socket = current endpoint); stale-tuple rows added; threat model §7.2 corrected |
| F3 | major | Retirement declarations on gap-refused carriers unspecified → ≥G abandoned sequences permanently wedge an instance | §9.3(6): retirements of any request that passed steps 1–4 are processed independently of the carrier's own refusal; all W/R mutations share the per-instance lock; wedge-recovery row added |
| F4 | major | requestDigest byte-range contradiction (§6.4(2) excludes the newline; §6.5(3g) as written included it) | §6.5(3g) now references §6.4(2)'s definition verbatim; host/child digest-equality row (multi-chunk write) added |
| F5 | major | §4.3 cited only the sanitize strip list; the shipped discipline requires the tool-env-passthrough blocklist too | §4.3(1) now requires both lists (`NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS`), passthrough row added |
| F6 | minor | §6.4 sketch omitted the body's inner `seq` | fixed in the sketch; §6.4(1) carries the rule |
| F7 | minor | Host-side emission cap unspecified | §6.4(4): broker MUST NOT emit an oversize envelope (`internal_error`); row added |
| F8 | minor | Threat model T6 said "default 64" | fixed to "fixed protocol constant G = 64" |
| F9 | minor | T2 proof row said "three keys" | fixed to five |
| F10 | minor | §3.4(3) pointed at broker-side checks for a child-side attack | rewritten: the defense for that direction is response authentication |
| F11 | minor | Replay-residue freshness boundary unstated; "stale" undefined | freshness steering stated (contract §6.5(5), TM §7.2); "stale" defined precisely in §6.5(3); P2 revisit flag |
| F12 | minor | Child-side read deadline unspecified | §6.5(3): per-attempt read deadline (SHOULD 30 s) feeding the retry budget |
| F13 | minor | Tombstone-reason semantics unspecified | §10.2(1): tombstones carry a reason selecting the residual-call refusal |
| F14 | minor | Version-skew asymmetry (request has no version field) | noted in §6.1 (fail-closed total outage; future ADR's call) |
| F15 | minor | Aggregate memory bound implicit | T6 now states `O(G × instance_count)` with instance_count host-controlled |
| F16 | minor | Child-side canonicalization failure mode unstated | §6.4(5) + §6.5(3a): full rejection, like a signature failure |
| F17 | minor | Acceptance record pre-marked the challenge "met" over a placeholder | this record supersedes it; the row now cites the actual outcome |

Defenses the challenge attacked and **could not break** (recorded for the
next reviewer): canonicalization divergence (single shared module,
property-tested); envelope replay across attempts (seq/op/digest bindings);
lying retirements vs at-most-once (ignore+log converges to refusal-only);
watermark advancing past a dispatched seq (not constructible); partial env
pre-plant (all-or-nothing capture); per-instance memory bound (no
off-by-one; `R ⊆ (W, W+G]` by the accept test).

**Boundary restated:** this acceptance authorizes the broker contract and
its Steps 2–7 implementation only. No Stripe, Paystack, PayPal, live
account data, or money movement is authorized by it.

---

## ADR-7 — Step 4 dispatch shape, per-workspace stable minting, and the wiring halves (Step 4)

**Status:** accepted (as-built, P1.4 Step 4) · **Date:** 2026-11-06 · **Owner:** TL

### D7.1 — The closed dispatch table IS the per-op schema record (N21)

The §7.2 "closed enum → handler map in code" is implemented as the literal
`PAYSWAP_OPERATION_PARAMS_SCHEMAS` record (op → `.strict()` schema, 1:1 with the
Wave 1 tool surface). No registration surface exists; `op` outside the record is
`operation_not_found` at dispatch (the belt behind the §6.1 schema enum's
suspenders). A separate handler-map abstraction was rejected: the schemas record
already *is* the table, and Wave-2 semantics (three-code law for every op) live
in one resolver — per-op handlers would be six copies of the same law.

### D7.2 — Tombstone-reason split at §5.5 step (4) (D5.6 as-built, incl. a caught bug)

exit/superseded tombstones refuse `instance_unknown` (null-bound) exactly as
Step 3 did; the `disabled` reason flows through to dispatch and answers the
request-attributed business refusal `financial_mode_disabled` **without
consulting the live reader** — the registry revocation is authoritative
(§10.2(2)). The adversarial row caught the first implementation checking
`lookup.entry.childPid` on tombstoned lookups (type-level unreachable at
runtime: tombstoned results carry no `entry`), which silently degraded the
disabled arm back to `instance_unknown`; the childPid consistency belt now runs
only for live entries, and the disabled arm's pid ownership is guaranteed by the
spawn table (pid-keyed, registerInstance-written) plus the claim-match check.

### D7.3 — Post-binding refusals are request-attributed (§6.4(3) boundary)

Pre-binding violations (§6.1 schema: unknown key / op beyond the enum / token
shape / seq / sessionId / trace shape) stay null-bound. Per-op params
violations and dispatch-level `internal_error` (a throwing live reader) happen
**after** binding — the envelope binds the verified instanceId/seq/op/digest.
Null-binding those would discard verified attribution for free; the tests pin
both shapes distinctly.

### D7.4 — Per-(server, workspace) stable minting; pending mints are reusable

The coordinator mints one tuple per (trusted server, workspaceKey) and reuses
it while the mint is pending (config injected, spawn not yet observed) or the
instance is live — the connection pool keys entries by
`stableStringify(config)` (pool.ts connectionKey), so per-prepare re-minting
would fragment pool entries and double-spawn. The first implementation required
registry liveness for reuse, which re-minted between the app-startup and
settings-surface resolutions (spawn not yet observed → pool fragmentation) —
the adversarial stability row caught it; reuse now requires "not known dead".
Exit observation and disable revocation invalidate the mint (fresh instanceId
on the next prepare, append-only §10.1).

### D7.5 — Boot failure degrades fail-safe, not fail-shut

A broker boot failure (endpoint occupied etc.) logs via `onWiringError` and
returns the servers **un-injected**: the child then runs the Wave 1
fail-closed no-credential path (env-snapshot refusals) instead of blocking the
spawn. Rejected: failing the spawn — a broker-less child is safe (nothing
crosses the bridge), and startup resilience wins. The three-code law's
`financial_mode_disabled` reachability is preserved by the registry-driven
revocation path independent of this degradation.

### D7.6 — The launch assertion's child-side half is context-only, by structure

`runPluginHostCommand` now gates the captured tuple on the trusted official
plugin context (before import — credentials never load into untrusted code).
The F2 currency checks (hostId/instanceId/socket vs the current boot) are
structurally host/broker-side: the child holds no registry or boot state to
check against, and §5.5 (token/instance/socket vs the live registry) is the
enforcement point that matters. The full assertion remains the reference
implementation for host-side use; the wired gate is its extracted first check.

### D7.7 — Reader defaults and failure classes

No live reader → every op answers `not_connected` (S2): all three codes are
refusals, and "no account exists" is unconditionally true in Wave 2 (§13). A
throwing reader → `internal_error` (typed, no detail leaked): it is an
unexpected host-side failure, not a business state. Production wiring always
provides the config-reading reader; the default exists for module-level use
and is documented as such.

## ADR-8 — Step 5 session resolution, workspace isolation, and the wiring ports (§8)

**Status:** accepted (as-built, P1.5 Step 5) · **Date:** 2026-11-06 · **Owner:** TL

### D8.1 — §8 executes between §5.5 steps (4) and (5); pre-dispatch refusals do not burn sequences

The §8 stage (session-scope re-resolution + entity isolation) sits after the
instance/registry binding (step 4) and before the reserved replay slot (step
5, Step 6). Two reasons, both structural: (a) addendum §3.5 item 5 makes the
session scope part of the binding triple itself — the binding completes at
(4.5), before request-level integrity checking; (b) §9.3(1)/(4) place the
atomic accept-and-mark boundary at the dedupe step — an §8-refused request
was never "accepted for dispatch", so its `seq` is unmarked and the child may
re-send the same logical request or retire it (§9.3(5)/(6)). Had §8 run after
the dedupe, either §8 refusals would burn sequences permanently (the
retry-killer: a transient session unavailability could never be retried at
the same `seq`) or the marking would have to defer past §8 and N35's atomic
one-dispatch guarantee would break under concurrent duplicates. §9.3(6)'s
rev-2a rule already processes retirements for carriers refused past step (4)
— consistent with §8 refusing between (4) and (5). When Step 6 lands, the
§5.5 literal order (4)→(5)→(6) is preserved with §8 inside step (4)'s
completion.

### D8.2 — Fail-closed default: no resolver wired → every live request is `session_unresolvable`

The liveStateReader's lenient default (S2 `not_connected`, D7.7) does **not**
extend to sessions. The session is the resolution root of every dispatch
(§8.1 "resolved, not asserted"): a broker that cannot resolve sessions must
not serve requests as if they had resolved. This forces the production wiring
to be real — a lenient default would let §8 wiring debt hide indefinitely,
which is precisely the debt Step 5 exists to close. Both faces therefore wire
resolvers (D8.6); the default remains for module-level use and is pinned by
the fail-closed rows.

### D8.3 — The disable-revoked arm bypasses §8 (D5.6 preserved)

A `disabled`-tombstoned instance's residual call answers
`financial_mode_disabled` **without** session resolution or entity checks:
the registry revocation is authoritative, and a revoked instance gets no
session/entity oracle (least information — the mode answer is the whole
truth). Exit/superseded tombstones still refuse `instance_unknown` at step
(4), ahead of §8. This preserves §12's "`financial_mode_disabled` residual
call reachability" row (the Step 2/5 suite) through the §8 insertion.

### D8.4 — Ordering within §8 and the failure classes

Session resolution (§8.2) precedes the entity check (§8.3); both precede the
three-code law (§7.3) — bridge failures precede business answers (a business
refusal presupposes successful resolution). A session resolver returning
null **or throwing** is `session_unresolvable`: the requireSession pattern's
typed `sessionUnavailable` is the domain answer ("cannot resolve"), not an
internal error — no detail leaks either way. An entity resolver **throwing**
is `internal_error` (unexpected host-side failure — the D7.7 classification;
entity resolution is infrastructure, not a domain answer). Unknown entity ids
name nothing (`null` → the three-code law): §8.3 punishes only **known**
cross-workspace references; existence questions are the business layer's.

### D8.5 — The broker enforces the binding law itself; the resolver only resolves

The resolver port answers "what session does this hint name, and which
workspace does it belong to" — the §8.2 comparison
(`resolved.workspaceKey === registration.sessionScope`) is broker-side
(`isSessionWithinBindingScope`), never delegated: the hint-can-narrow-never-
widen law holds even with a sloppy resolver. The check binds to the
registration's **`sessionScope`** field, not `workspace`: Wave 3's server-side
operator-principal model may narrow `sessionScope` below the workspace, and
the session check narrows with it without touching the entity side (which
compares against `workspace`). The tests pin the field choice explicitly (a
resolved session matching the workspace but outside a narrowed sessionScope
is refused). Key-formula dependency: both the coordinator's injection scope
(`identity||path`, mcp.ts/create-app.ts) and the session records'
`ZCodeWorkspaceRef.workspaceKey` use the `resolveWorkspaceKey` convention —
a mismatch fails closed (`session_unresolvable`), never widens.

### D8.6 — Production wiring: a per-request facade slot, bound per face

The coordinator's boot options carry a **facade** that reads a mutable slot
at request time (not a boot snapshot), so `bindSessionScopeResolver` works
before and after the lazy boot — the protocol face constructs its server
after the coordinator and binds immediately after (`ZCodeProtocolAgentServer
.payswapSessionScopeResolver`, a narrow port in the requireSession pattern:
readiness + record lookup → the session's `workspaceKey`, null on either
miss; `createPayswapSessionScopeResolver` in server-types.ts). The app face
(owned coordinator in `createZCodeApp`) binds a single-session resolver at
construction (`createSingleSessionScopeResolver`): a standalone app has
exactly one session — its own `sessionId`, always present (create-app.ts) —
and every other hint is null. The unbound window (boot before binding) is
correctly fail-closed. The settings face (mcp/list) never calls tools, so it
needs no resolver. The entity resolver (`entityWorkspaceResolver`) is a
constructor-only option: nothing wires it in Wave 2 (no entity store exists,
§13); the port and the law are proven by injected rows, and P2's account
store wires the real one.

### D8.7 — Audit shape: typed codes, full attribution, no hints

§8 refusals are audited like the other post-binding refusals
(`refused` + `session_unresolvable`/`workspace_mismatch` + instanceId/seq/
op/peerPid). The session hint and the resolved workspace value are **not**
logged — ids are not credential material, but the typed code suffices and
hint logging would leak call patterns (§11(2)'s spirit; the least-log row
asserts the serialized audit contains neither).

## ADR-9 — Step 6 replay engine: shared-module placement, the intra-request order, and the audit shape (§9)

**Status:** accepted (as-built, P1.6 Step 6) · **Date:** 2026-11-06 · **Owner:** TL

**Context.** §12.1's binding order makes the Step 6 PR land the
watermark/retained-set engine with the frozen `G`, allocation/recovery,
retirement declarations, and all replay arms (N33/N34/N35/N39, the 64/65
boundary rows, the memory-bound row, the cancellation/connection-failure
rows). The contract fixes the algorithm and the frozen constant but leaves
four as-built decisions to this ADR: where the engine lives, the order of a
carrier's own accept verdict versus its retirement processing, the
classification rule for retirement entries, and the audit/observability
shape.

### D9.1 — The carrier's own accept verdict is decided against the pre-retirement watermark; retirement resolves after the verdict, on every exit path past step (4)

§9.3(6) rev 2a requires retirement processing to be independent of the
carrier's own fate, but does not pin the intra-request order of "the
carrier's accept test" versus "the carrier's retirement resolution". This
implementation decides the carrier's verdict FIRST — the duplicate and gap
tests see exactly the `W`/`R` state the request arrived into — and resolves
the carrier's retirements AFTER the verdict, before any response is
written. Two reasons, both normative-adjacent: (a) the mandatory
wedge-recovery row ("retirement-carrying requests that **individually fail
the gap test** until the watermark clears") requires a carrier's own
declaration not to rescue its own gap verdict — otherwise a wedge of depth
`G+1` would self-clear on the first carrier and the row's failing carriers
would never exist; (b) the rev-2a narrative describes the bug as "every
subsequent carrier fails the gap test, no retirement is ever processed" —
the fix processes the retirement of failing carriers; it does not redefine
the carrier's admissibility. The resolution runs on **every** exit path a
step-(1)–(4)-passing carrier can take: the three §8 refusals
(`session_unresolvable`, entity-resolver `internal_error`,
`workspace_mismatch`), the two §9 refusals (`sequence_duplicate`,
`sequence_gap_exceeded`), and the accepted→dispatch path. Step-(1)–(4)
refusals never reach it — an unverified or unbound peer's declarations are
not transport bookkeeping from a trusted child and are dropped with the
request.

### D9.2 — Retirement classification is judged against the running maximum of all prior array entries; effects are per-entry, machine-readable, and audit-logged

Per entry `e` of `retiredSeqs`: `e ≥ carrierSeq`, a non-positive/non-integer
`e`, an in-array duplicate, or any `e ≤` the maximum of the previously seen
entries (valid or not) is `ignored_nonsensical` — the array must be strictly
increasing as a whole, so a violating entry is judged against its strongest
predecessor; `e ≤ W` or `e ∈ R` is `ignored_already_accepted` (the child
cannot know `W`/`R`; tolerance is required and at-most-once is untouched);
everything else (`W < e < carrierSeq`, never accepted) is `resolved_missing`
(idempotent re-mark). Classification is closed, mutually exclusive, and
carried per entry into the audit log. Schema-level shape violations
(`> 8` entries, non-positive/non-integer elements) stay `request_invalid`
pre-binding per §6.1(4) — the schema is the shape gate, the engine is the
semantic gate.

### D9.3 — The engine and the allocator live in the shared protocol module; injection rides the boot-options surface

`packages/shared/src/payswap/replay.ts` is the single implementation of both
sides: the broker-side seen-record engine (§9.3(1)–(4)/(6), §9.4) and the
child-side send-boundary allocator (§9.3(5)). Placement follows §9.4(1)
(`G` lives once in the shared protocol module, exported and referenced by
both sides) and the §6.4(5) single-implementation discipline that
`shared/payswap/contract.ts` already records for canonicalization and
envelopes — two replay implementations drifting is the same class of
violation. Both halves are synchronous pure in-memory state (no IO), so the
shared module's no-IO invariant holds. The broker wires the engine through
a `seenRecords` boot option (default: internally created; injection exists
for state introspection — the §9.4(3) memory-bound row asserts `|R| ≤ G`
after every flood step through the injected reference), exactly the
`liveStateReader`/`sessionScopeResolver` injection-surface pattern of
Steps 4–5. N35's atomicity is by construction: the accept verdict, the `R`
insertion, and the watermark advance are one synchronous step — Node's event
loop has no interleaving window even with the async §8 resolver ahead of the
check, and two concurrent same-seq connections deterministically produce
one dispatch and one `sequence_duplicate`.

### D9.4 — The accepted-for-dispatch boundary is the dedupe step; §8 refusals never burn sequences, dispatch refusals always do

§9.3(1)'s "accepted for dispatch" boundary is the §5.5 step-(5) accept test
itself: a request refused at §8 (step 4.5) was never accepted, so its `seq`
is unmarked and the child may re-send the same logical request or retire it
(D8.1, pinned by an explicit row). A request that passes the accept test
burns its `seq` regardless of the dispatch outcome — a three-code business
refusal, a per-op params `request_invalid`, and a success are all
"dispatched" for replay purposes ("regardless of the original request's
eventual outcome"). The disable-revocation arm (D5.6) passes the boundary
like any other: its residual NEW calls answer `financial_mode_disabled`,
and a replay from a disabled instance answers `sequence_duplicate` — the
residual-call reachability row and the replay rows compose rather than
collide.

### D9.5 — Memory bound: `R ⊆ (W, W+G]` structurally, with a belt invariant; the resolved-missing set grows only by explicit declaration

`R` is bounded by `G` structurally (a seq beyond `W+G` is refused before it
can enter `R`, and `W` never regresses), asserted by a belt check that
throws `PayswapReplayInvariantError` (surfacing as `internal_error`, no
detail leaked) if the implementation ever violates it. The resolved-missing
set `M` has no contractual `G` bound — §9.3(6) admits entries anywhere in
`(W, carrierSeq)` — but it grows only through explicit child declarations at
≤ 8 entries per request: linear in request count, the same order as the
audit log, with no single-request amplification (the gap bound already
denies the cheap skip-ahead). ADR-2's rejection of time-based gap collection
stands: hole closure is child-declared, monotone, and never time-dependent.

### D9.6 — Audit: a `retired` outcome carries each entry's effect; replay refusals ride the existing refused shape

The §11 ingress audit gains one outcome value, `retired`, emitted once per
declared entry with `code` = the D9.2 effect, `seq` = the declared entry
(not the carrier), plus instanceId/peerPid. `sequence_duplicate` and
`sequence_gap_exceeded` refusals ride the existing `refused` outcome with
their typed codes — no stack traces, no token, no endpoint path, unchanged
from §11(2). The zero-dispatch assertions in the suite read the audit's
dispatched count directly (§9.5's "nothing is dispatched" is proven, not
assumed).

### D9.7 — The child-side bridge transport lands with Step 7; Step 6 lands the allocation discipline

§12.1's Step 6 list (engine, frozen `G`, allocation/recovery, retirement
declarations, replay arms) is fully landed here; the register's "the
child-side bridge client lands with it" refers to the Steps 6–7 pair as a
unit. The transport shell (UDS connect, line write, response verification
wiring, retry loop over the allocator) lands with Step 7, where the complete
chain — real plugin build → broker → financial service stub — runs through
the production host launch path and needs exactly that client. Step 6
proves the discipline it will ride: the allocator rows (send-boundary only,
uncertain-delivery retention, provable-non-delivery dual arm, abandonment,
never-reuse) and both broker-integration delivery-situation rows.
