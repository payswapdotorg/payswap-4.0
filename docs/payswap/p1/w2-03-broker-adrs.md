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

---

## ADR-10 — Step 7 as-built: the child-side transport, the session-hint channel, the bridge-failure surface, and the credential restore

**Context.** D9.7 scoped the child-side bridge transport to Step 7. The
contract pins the protocol pieces (§3.3 one-request-per-connection, §6.1(5)
child-side size pre-check, §6.5(3) per-attempt read deadline and full-envelope
verification, §9.3(5)/(6) allocation/retry/retirement discipline) but four
integration decisions were Step 7's to make: where the transport lives, where
the session hint comes from, how bridge failures surface on the tool envelope,
and how the five-key tuple reaches the plugin server past the CLI entry's
sanitization. This ADR records those decisions as-built.

**Decision.**

1. **D10.1 — The transport lives in the shared protocol module**
   (`packages/shared/src/payswap/bridge-client.ts`). The child is its only
   consumer, but §6.4(5)'s single-implementation discipline (host and child
   share one envelope/replay/canonical implementation) extends naturally: the
   transport wires exactly those modules, and colocating it keeps the protocol
   from drifting into two trees. The plugin bundles it via esbuild
   (`@zcode/shared: workspace:*` devDependency, the zcode-site-plugin
   precedent); `dist/server.mjs` stays self-contained.

2. **D10.2 — The session hint is the host-namespaced `_meta`**
   (`com.zcode/request-context` → `session_id`), never a top-level `_meta` key
   — the node_repl browser-bridge boundary discipline, verbatim: the top-level
   `_meta` is third-party extensible and must not become a session-routing
   credential. The hint remains a routing hint only (§8.1
   resolved-not-asserted); a missing/blank hint is a typed child-side failure
   (`session_hint_missing`) because §6.1's `sessionId` is `min(1)` — no valid
   request can be formed, so nothing is sent and no sequence is consumed.

3. **D10.3 — Bridge failures surface as a third tool-envelope kind**
   (`{kind:"bridge_failure", failure:{code,message,retryable}}`). §6.2's
   "never conflated with business refusals" forces the three-code
   `kind:"refused"` surface to stay untouched; verified §6.3 bridge errors and
   child-side typed failures (the closed set in
   `PayswapBridgeClientFailureCode`) ride the new kind. A verified success
   body's `data` is the tool envelope itself (§6.2: the business envelope
   rides inside `data`), serialized verbatim.

4. **D10.4 — Verification rejection is never retried; delivery failures
   retry the same sequence within a bounded budget (default 1).** §6.5(3)
   permits retry on rejection; Step 7 declines it: a response that was
   received and failed authentication means the endpoint is adversarial or
   substituted — re-sending the same request only widens the suppression
   window and cannot produce a verifiable answer that was not already
   available. The rejected attempt's sequence and its carried retirement
   declarations are re-queued (broker-side declaration handling is
   idempotent-tolerant, §9.3(6)). Delivery-failure situations follow §9.3(5)
   exactly: provable non-delivery (connect failure, failed write callback)
   and uncertain delivery (bytes handed over, closed or deadline) retry the
   same `seq` byte-for-byte; budget exhaustion surfaces the last failure's
   category (`connect_failed` / `response_deadline_exceeded` /
   `retry_budget_exhausted`) with `retryable: true` — re-issuing the logical
   request is the caller's decision (§6.5(3)).

5. **D10.5 — The `__zcode-plugin-host` dispatch restores the captured tuple
   around `module.main()`** (the CUA socket restore, promoted to five keys).
   The CLI entry's sanitization captures the tuple before stripping it
   (§4.3(1)); the restore happens only after the serving-context gate
   (impostor plugin ids never reach the import), only in the official PaySwap
   context, and is reverted in `finally`. The delivery surface remains
   exactly one process — the intended child (§4.2): the plugin server reads
   the five keys at construction inside `main()`, arms the bridge, and never
   logs them.

6. **D10.6 — The §6.1(5) size pre-check uses a maximal-width sequence
   placeholder.** The pre-check must precede allocation, but the serialized
   line embeds the sequence. A 16-digit placeholder (≥ any safe integer's
   width) with the next retirement batch (mirroring `takeRetirements`'
   semantics: ascending, ≤ 8, below the carrier) yields an exact upper bound:
   if the probe line fits, the real line fits. With more than eight pending
   retirements the probe can exceed the cap while the real line would not —
   an over-conservative refusal in an extreme edge, chosen in the fail-closed
   direction.

**Consequences.** The chain suite proves each decision on the real path:
same-seq byte-identical retries (suppression relay), retirement declarations
riding the next carrier, the null-bound sibling-relay refusal rejected
in-full, and the zero-credential scan over audit/stderr/results. The Wave-1
no-credential arm (S0b/S1 snapshot refusals) is preserved verbatim — the
bridge arms only when the five-key tuple is present, which only the trusted
injection provides.

## ADR-11 — P1.6 operator-principal: the law's home, the store's scope, and the upgrade's observable surface

**Context.** The P1 completion handoff (work package 5) binds the server
operator-principal model: addendum §1.6.3 items 1–9 with rows N27–N32, N40 and
N41. The addendum specifies the model (two-level `/ws` handshake, per-operator
credentials, stable principals, workspace-scoped roles, credential lifecycle,
challenge binding) but leaves five integration decisions to this work package:
where the law lives, what the server store owns, how the upgrade handshake is
observable, how revocation reaches live connections, and what the deployment
activation gate looks like. This ADR records those decisions as-built.

**Decision.**

1. **D11.1 — The law lives in the shared protocol module; the server keeps a
   thin state owner.** Credential minting/parsing (digest-only, constant-time),
   the registry (operators, credential records, sessions, challenges,
   workspace-scoped role bindings, the rotation/revocation cascades), and the
   two-level handshake evaluation are single-implementation modules in
   `packages/shared/src/payswap/` (`operator-credentials.ts`,
   `operator-registry.ts`, `operator-handshake.ts`) — the same discipline as
   the envelope/replay/bridge modules (§6.4(5): one implementation, drift is a
   violation). `packages/server/src/payswap/` (managed module `server-payswap`,
   adopted) owns only what is inherently server-side: the persisted state file,
   connection registration/closure, and the Hono wiring (guard, endpoint,
   bind-helper).

2. **D11.2 — Session lifetime and cookie lifetime are one knob; rotation grace
   is the second.** The addendum gives cookie "default 15 min" and session "a
   bounded, deployment-configured lifetime" — two sentences for one concept
   (the cookie *carries* the session id; its Max-Age is the session lifetime,
   default 15 min, `sessionLifetimeMs`). Rotation grace is the independent
   knob (default 24 h, `rotationGraceMs`). Both are injectable for the test
   clock.

3. **D11.3 — Explicit revocation is principal-scoped; rotation-end closure is
   record-scoped; both are timer-free.** `revokeOperatorCredential` closes
   *all* of the principal's sessions and invalidates their pending challenges
   (the addendum item 6 text: "the principal's active sessions"); an operator
   holding a second live credential must be re-issued deliberately — admins
   rotate, they do not revoke, when they only want to cycle credentials.
   Rotation-end closure is record-scoped ("sessions it authenticated"): the
   session liveness law re-evaluates the minting credential on every
   verification (lazy death, no timers), and `sweepRotationWindows()` — called
   on every upgrade evaluation and cookie mint — eagerly closes the affected
   connections and invalidates their challenges.

4. **D11.4 — The upgrade handshake's credential precedence is
   header-over-cookie with no fallback.** When both an operator token header
   and a session cookie are presented, the header wins and its failure is
   final — there is no credential shopping between level-2 transports. An
   absent credential is not a failure: the client upgrades as an ordinary
   unbound connection (no financial principal; financial operations on it
   refuse — the N28 session-level arm). Only a *presented-but-invalid*
   credential refuses the upgrade.

5. **D11.5 — Upgrade refusals are bodyless bare 401s; typed codes ride the
   observable HTTP face.** The `@hono/node-ws` adapter writes every non-101
   response to an upgrade-intent request as a bare status line with
   `Content-Length: 0` — no middleware can attach a body. As-built, every
   `/ws` upgrade refusal (level-1 or level-2, any failure class) is
   byte-identical to the client: the single-generic-failure law
   (`operator_authentication_failed`) holds a fortiori on this surface. The
   typed code is observable where the adapter carries bodies: the
   operator-session endpoint (real HTTP responses — proven byte-equal across
   unknown/malformed/rotated-out/revoked in the boundary suite) and the law
   verdicts. The level-1-before-level-2 order is structural (middleware
   registration order) and proven at the law level by the throwing-getter row.

6. **D11.6 — Financial activation is a typed two-site gate.**
   `resolvePayswapFinancialActivation` (entry face) refuses financial mode
   requested without `ZCODE_SERVER_AUTH_TOKEN` (N27; the entry exits non-zero
   — a financially-requested deployment never serves in a weaker posture), and
   `createHttpServer` independently refuses `payswapFinancial` without an
   `authToken` (defense in depth — no caller can construct a weak financial
   server). The financial middleware variant disables the upstream `?token=`
   query branch (§1.6.3 item 7 — no credential of either level in URLs) while
   keeping Bearer and the lite cookie; non-financial deployments keep the
   upstream middleware verbatim (S-preservation row).

7. **D11.7 — Provisioning is an in-process admin API, not a network
   endpoint.** Operator provisioning/rotation/revocation are store methods
   (persisted under the private-persistence discipline: 0600, atomic rename,
   digest-only state; sessions/challenges are memory-only — restart revokes
   them by construction). A network endpoint guarded only by the shared
   deployment token would let any token holder mint approver credentials —
   exactly what §1.6.3 item 1 forbids. An operator CLI wrapper over these
   methods is deployment sugar (P1.8 or later); the P1.6 boundary is the
   store's own API exercised by the suites.

8. **D11.8 — Challenge rows close at the law level in P1.6; the approval-path
   closure lands with P1.7.** N29/N30's full semantics (cross-principal
   resolution, expired/revoked-session resolution, cascade invalidation) and
   N31/N41's service-boundary role law are proven against the registry law
   (bootstrap suite) and the server store (issue/invalidate observable at
   revocation through the real server). The rows' *approval-resolution* arms
   (a resolution arriving on the approval channel producing/not producing a
   grant) require P1.7's grant machinery and are tracked there — the register
   entry states this split explicitly. The exposure-policy allowlist
   (§1.6.2 item 5c) lands with the approval channel it guards (P1.7).

**Evidence.** Law suite `tests/payswap-operator-law.test.ts` (20 rows:
credential format/digest-only/constant-time, stable principal, rotation grace
window + audit flag, rotation-end sweep, principal-scoped revocation cascade,
session lifetime + lazy credential law, N29/N30 challenge rows, single-use/
expiry/secret-match, N31/N41 role rows, N32 claim law, handshake order +
generic-collapse + both transports). Boundary suite
`packages/server/test/payswap-operator-auth.test.ts` (14 rows through real
`createHttpServer` + real HTTP + raw WebSocket upgrade handshakes: N27 both
sites, query disable + upstream preservation, level-1-first order, bare-401
collapse across four failure classes, ordinary-client unbound upgrade, native
authenticated upgrade + live session, cookie endpoint attributes + wrong-
credential generic + no-level-1 upstream, session expiry at the upgrade, N32
foreign-claim refusals at both faces, revocation closing a live connection
(code 1008) + challenge invalidation + re-upgrade refusal, 0600 digest-only
persistence + principal restore across restart).

## ADR-12 — P1.7 transaction grants and trusted Class-B approval: the law set, the mint capability, the resolution order, and the exposure policy

**Context.** The playbook's P1.7 work package (addendum §1.3 + §1.6, closing
D11.8's tracked arms) binds the transaction-authorization grant mechanism with
its refusal path and the trusted Class-B approval origin: the exact tuple/digest
binding, the single-use challenge, expiry, the trusted renderer origin, the
model/plugin forgery rows, and the material-change reauthorization — with
N1–N17's law-level arms, N28's client arm, N29/N30/N31/N41's
approval-resolution arms, and the §1.6.2 item 5c exposure policy. The addendum
specifies the semantics; this ADR records the as-built decisions.

**Decision.**

1. **D12.1 — The grant law is a shared single implementation, five modules;
   the server module owns only assembly and exposure.**
   `packages/shared/src/payswap/` gains `authorization-tuple.ts` (the §1.3
   strict schema, the canonical-JSON SHA-256 digest, the exact-binding law with
   a stable first-deviation report order), `grant-ledger.ts` (records, the
   single mint entry, the enforcement seam, the refusal audit),
   `approval-card.ts` (the Class-B payload schema and the single derivation
   path), `approval-origin.ts` (the §1.6.2 item 3 three-check sender law and
   the item 4 event discrimination), and `approval-flow.ts` (the
   proposal→challenge→resolution→mint state machine plus the card-instance
   challenge store). `packages/server/src/payswap/approval-service.ts` (same
   managed module) owns the registry challenge adapter, the role port, the
   grant-ledger handle wiring, and the exposure policy — the D11.1 discipline
   applied to the grant machinery.

2. **D12.2 — Exactly the addendum's two caller-visible refusal codes; the
   reason discrimination is audit-only.** N1/N3–N9 name `authorization_required`
   (nothing presented, in every bypass context); N2 explicitly maps
   presented-but-forged/expired/consumed ids to `authorization_mismatch`, as
   N10 maps tuple deviation. The seam therefore exposes two codes
   (`authorization_required` | `authorization_mismatch` — §7.4's family) and
   records `no_grant`/`grant_unknown`/`grant_expired`/`grant_consumed`/
   `tuple_deviation` in the refusal audit with the invocation context: the
   caller cannot enumerate grant states; the auditor can. The N1–N9
   context-invariance row proves the context is an annotation that never
   changes a verdict.

3. **D12.3 — The single mint path is a per-instance capability pair, and the
   ledger is memory-resident until P7.** `createPayswapGrantLedger` returns
   `{ ledger, minter }`; the minter closes over a per-instance CSPRNG nonce,
   and `appendApprovedGrant` verifies the nonce **and** independently recomputes
   the tuple digest — a hand-forged mint, a foreign ledger's mint, or an
   internally drifted digest all throw `unauthorized_mint` with the ledger
   unchanged. The approval flow is the only minter holder (§1.3's "no other
   code path"). `authorizationId` and the sequence are host-allocated — the
   mint command has no fields to supply them. Persistence (the §4 financial
   ledger, N23/N24) is P7 work; P1.7's ledger is append-only in memory with
   the discipline (single writer, monotonic sequences, single-use consumption)
   proven from day one.

4. **D12.4 — The resolution order is: event discrimination → sender/proposal
   state → challenge binding → port authentication → decision → role → mint.
   Two load-bearing placements.** First, the challenge-binding check (the
   presented challenge must be the proposal's own — N15) precedes the port:
   otherwise a foreign-but-valid challenge could be *consumed* through the
   wrong proposal's resolution. Second, the role check runs **after** the port
   and before the mint: the P1.6 registry law authenticates first (session →
   principal → secret), so cross-user attempts fail on the principal axis
   without leaking the issuing principal's role state (N29), and the role gate
   evaluates the authenticated rightful resolver. A role-refused approve has
   already consumed the challenge — the human's decision is spent, and
   re-approval requires a fresh challenge and a host-rederived card; the
   retry row proves `challenge_consumed`. The addendum's "enforced at the
   service boundary before approval processing" is read as *before the
   approval completes into a grant*; the boundary is the mint.

5. **D12.5 — The §1.6.2 item 5c exposure policy is a fail-closed default plus
   a per-connection override, not a static allowlist.** The channel registered
   in the ServiceCollection **is** the refusing stub
   (`approval_channel_unauthorized`); only an operator-bound `/ws` connection
   (the two-level handshake's binding, read at `onOpen`) receives the
   session-bound facade via the per-connection overrides map — the exact
   `IProviderProvisioningTargetService` precedent. Consequence: the
   trusted-host face, the stdio face, and the zcode-server-cli face
   structurally receive the stub; a deployment that never registers the
   channel exposes nothing. The upstream `ServiceExposurePolicy` mechanism is
   static per call and cannot express per-connection authentication state —
   the override composition is stricter and observable (N28's client arm gets
   a typed refusal, not a channel-not-found error).

6. **D12.6 — Issuance is an in-process host API; the operator-client surface
   is resolve + session-filtered inspect.** Following D11.7: no network
   endpoint mints proposals — the P2+ `request_authorization` wiring calls
   `issueProposal` from the trusted host path. The card (with its challenge)
   reaches the operator client through `listPendingProposals`, filtered to the
   caller's session: §1.6.3 item 6's "resolve, inspect, or mint" isolation —
   B's session never sees A's pending cards. The pendingInteraction/v4-snapshot
   rendering integration and the desktop card component are P1.8 surface work.

7. **D12.7 — The desktop arms are law-level in P1.7; the Electron wiring lands
   with P1.8.** The three-check sender law (N13/N16: expected webContents,
   main frame, trusted application origin with zcode-sandbox:// and ui://
   explicitly untrusted, fail-closed on an empty allowlist) and the
   card-instance challenge store (§1.6.2 item 1: 256-bit CSPRNG, single-use,
   bound to the proposal and the issuing card instance, expiring with the
   proposal) are pure modules proven in the law suite; the real IPC mapping,
   the production trusted-origin value, and N18's full plugin-handle teardown
   arm arrive with the surface work. N8's arm is structural here: no
   subagent/automation origination API exists (issuance is host-in-process;
   resolution must pass the sender law), and the wrong-channel row proves an
   operator-connection sender cannot resolve a card-instance proposal.

8. **D12.8 — The dormant dispatch hook stays dormant; the mechanism ships
   ahead of its callers.** §7.4's reserved `authorizationId` param remains
   schema-rejected on the six ops — P1.7 lands the grant machinery and the
   enforcement seam (`authorizeOperation`) that P7's executor calls; the
   dispatch-layer wiring activates with P2+/P7 when a caller exists. The
   playbook's "material-change reauthorization" emphasis is the tuple-binding
   law plus single-use: any deviation refuses, and a changed plan needs a new
   grant because the old one cannot authorize it.

**Evidence.** Law suite `tests/payswap-grant-law.test.ts` (30 rows: tuple
strictness/malformed-money/digest canonicality + collision sensitivity, the
binding law across amount/recipient/leg/fee/purpose/source/principal/expiry
deviations, host-allocated ids and sequences, forged + foreign-mint
unauthorized_mint, the N1–N9 bypass-context exhaustion with the audit
annotation proof, N2's three invalid-id arms, context invariance in both
directions, N10/N11/N12 through the seam, the N14 byte-equal payload and the
no-display delta, the challenge/secret shape, N13's five rejection rows plus
the fail-closed default and the operator-connection acceptance, N26/N17
classification, the positive flow with the recomputed digest and the
seam-composition closure, the tuple-override and foreign/consumed/expired
challenge family, sender-rejection non-consumption, deny consumption, the
N18 stale-replay arm, dead-on-arrival issuance, the N8 wrong-channel arm, and
the role-refused-consumes retry). Boundary suite
`packages/server/test/payswap-approval.test.ts` (8 rows through the real
`createHttpServer` + real two-level WebSocket upgrades + the real channel rpc
(`ChannelClient`/`ProxyChannel`, the web-remote transport path): the positive
mint with the server-resolved principal, the (principal, workspace, approver)
record, the N11/N15 seam/replay arms, N29's resolve + inspect arms with
non-consumption on the impersonation refusal, N30's expiry and revocation arms
(connection closed server-side, cascade-invalidated challenge), N31/N41
service-boundary role refusals with the consumed-retry arm, N28's client arm
behind the exposure-policy stub, and the N14/N26 server arms with challenge
survival).

---

## ADR-13 — The macOS §5.1 native arm: helper-held endpoint, fact-relay transport, and the shared relay seam (P1.3 completion, macOS half)

**Context.** ADR-3 shipped the Linux read (ss+procfs) and deferred the macOS
§5.1 arm: Node exposes neither `getpeereid`/`LOCAL_PEERPID` nor client-fd
passing (SCM_RIGHTS) on macOS, and macOS has no procfs to compose an
equivalent from pure Node. §5.1(1) names "a small native helper" as the
escape hatch and §5.1(3) names the macOS CUA Helper precedent
(`getpeereid`/`LOCAL_PEERPID`, fail-closed). Until this ADR, darwin booted
`degraded_refusing`. The Windows arm (§3.2/§5.3) shares the same host-side
shape — a helper-held endpoint relaying verified connections — so this ADR
defines the seam both arms use; the Windows half (pipe-name mint per
§3.2(3), DACL per §3.2(2), pid+image-path gate per §5.3(1) with the spawn
table pushed to the helper) lands as its own PR against the same seam.

**Decision.**

1. **D13.1 — The helper holds the public endpoint.** A dependency-free C
   helper (`apps/zcode-cli/native/payswap-broker-peer-macos/helper.c`,
   compiled `payswap-broker-peer-helper`) binds the per-boot UDS path minted
   by `mintBrokerBootState`. The §3.1 placement law is enforced *inside the
   helper*: 0700 directory (chmod-pinned), 0600 socket (chmod-pinned), and
   §3.4 refuse/remove of any pre-existing entry before bind. The host never
   binds the public endpoint in verified mode. In degraded mode the host
   binds it exactly as today, so §5.4 diagnostics stay reachable when the
   helper is absent — the degraded observable behavior is unchanged.

2. **D13.2 — Facts at accept; identity-unestablishable clients are dropped at
   the socket; every other connection relays.** At accept the helper reads
   `getpeereid` (effective uid) and `LOCAL_PEERPID` (pid). A client whose
   facts cannot be established is dropped at the socket, never relayed (the
   §5.3(4) family rule). A client with establishable facts — *including*
   uid-mismatch clients — is relayed, because §5.1(2) makes a uid mismatch a
   typed `peer_verification_failed` the peer must actually receive, and the
   signature lives host-side (§6.5(1), ADR-1): relaying keeps the refusal
   behavior byte-identical to the Linux arm instead of forking it. The
   helper never parses payload (§5.5(1)); it is a byte pump, and the host
   parses only after its own peer gate.

3. **D13.3 — The relay channel.** The host holds an ingress UDS
   (`<per-boot dir>/ingress.sock`, same 0700 dir, 0600). One ingress
   connection per client connection. The helper's first ingress line is a
   versioned header `{"v":1,"t":"<64-hex>","pid":N,"uid":N}` (strict shape,
   no extra keys, hard 512 B cap), then a bidirectional byte pump until EOF
   both ways — §3.3's one-request-per-connection, the 1 MiB request cap, the
   drain disciplines, and the half-close semantics all apply unchanged on
   the relayed stream because the host sees a real socket end-to-end.

4. **D13.4 — The helper-family spawn discipline (§5.3(2), adopted for
   macOS).** The host spawns the helper only after SHA-256 verification of
   the binary against a pinned digest (absent binary or mismatch =
   subsystem unavailable = `degraded_refusing`; never spawn on mismatch).
   The host passes `--parent-pid <process.pid>`; the helper exits when its
   actual parent changes (poll-bounded), which also gives §3.1(3)/§10.3
   endpoint-dies-with-host semantics. The one-shot 32-byte token travels via
   a 0600 token file inside the per-boot dir (argv is `ps`-visible to
   same-uid on macOS), read once and unlinked immediately by the helper.
   Every ingress connection re-authenticates with the token, compared
   constant-time (`timingSafeEqual` host-side; the `FixedTimeEquals`
   discipline of the C# family).

5. **D13.5 — Boot is spawn + a real-path self-probe (ADR-4 adapted).** The
   subsystem is available only if the host, connecting as a real client to
   the helper-held public endpoint through the exact kernel path production
   connections take, receives a token-valid header identifying *the host
   itself* (`pid === process.pid`, `uid === geteuid()`). Any failure —
   spawn, hash, header, token, identity, or the bounded timeout — kills the
   helper, removes the per-boot dir, and boots `degraded_refusing` with the
   host-held endpoint. No mock ever substitutes the probe (ADR-4's rule).

6. **D13.6 — The trust boundary of relayed facts is the token.** Relayed
   (pid, uid) are trusted exactly because the ingress is 0700-dir-bound and
   every connection is token-authenticated from the hash-verified,
   parent-bound helper. The residual — a same-uid attacker who wins the
   one-shot token-file race and then fabricates facts — is the macOS twin of
   ADR-3's (c) `ss`-hijack residual: fabricated facts still cannot pass
   §5.5(3) without the instance token, and every response is host-signed
   (§6.4/§6.5), so the fabricated-fact relay is a typed-refusal oracle at
   worst. Recorded in the threat model's Step-3 residual rows.

7. **D13.7 — No `SecCodeCheckValidity` in v1.** The CUA helper's
   launcher-signature gate exists because that helper *owns TCC grants*;
   this helper owns no OS authorization. A stolen-binary spawn can only
   build a relay toward an attacker-chosen ingress (equivalent to running
   `socat` — no gain), and the real endpoint is unreachable to it (0700 dir
   + §3.4 refusal + the parentage check). Rejected here so it is not
   re-attempted without a new OS-grant-owning responsibility.

8. **D13.8 — The seam is shared; the arm is per-platform.** The broker
   server gains a relay transport option (facts-from-header, no public
   endpoint bind, ingress listener adoption, close-time teardown). Linux
   keeps the direct ss+procfs reader unchanged — no second Linux
   implementation (playbook §10). `createDefaultPeerCredentialReader` is
   unchanged (darwin/win32 still return unavailable); the relay subsystem is
   a separate construction that *replaces* the direct transport only when it
   verifies, so the existing darwin/win32 fail-closed rows keep their
   meaning: they pin the default state when no helper is provisioned.

9. **D13.9 — Helper resolution and the env surface.** The helper is resolved
   from `PAYSWAP_BROKER_HELPER_PATH` + `PAYSWAP_BROKER_HELPER_SHA256`
   (dev/CI provision; both host-only keys are added to the runtimeEnv strip
   list so they never propagate into any child env). Production packaging of
   the binary inside the CLI distribution is a recorded gap: the arm is
   proven on the `macos-latest` CI runner; until packaging ships a binary,
   production macOS boots `degraded_refusing` — the honest state, not a
   silent one.

10. **D13.10 — The platform evidence boundary.** The host half (header
    strictness, token check, probe identity rule, degrade paths, close
    semantics, the full §5.5 chain through a relay) is pinned by a
    Linux-runnable suite against a protocol-faithful fake helper. The
    platform rows — real `getpeereid`/`LOCAL_PEERPID`, endpoint placement
    modes, parent-death cleanup, cross-uid EACCES (§3.1(2) placement law),
    and the real chain end-to-end — run only on darwin, in the `gates-macos`
    CI job that compiles `helper.c` with clang and runs the platform suite.
    A mock never greens a platform row (playbook §5(5)); Linux-CI skips of
    the darwin suite are the designed boundary, not an evasion.

**Rejected alternatives (recorded).**

- *N-API addon:* ADR-3's build-burden reason still holds, now for
  darwin-specific toolchains; the helper needs no Node linkage at all.
- *`lsof`-based pure-Node pairing:* would rest on unverifiable output-format
  claims about macOS `lsof` peer-pid support; not documentable as a security
  foundation from a Linux sandbox. Recorded so it is not re-attempted
  without on-platform evidence.
- *Helper-side uid drop of mismatched clients:* would fork the refusal
  behavior from the Linux arm (§5.1(2)/D5.4 demand the signed typed line the
  peer can receive). Relayed-and-host-refused is the single-behavior rule.
- *Multiplexed single ingress connection:* framing complexity for no gain;
  one connection per client keeps the pump byte-exact and the teardown
  trivially correct.

**Consequences.** macOS gets the §5.1 read with kernel-sourced facts end to
end; typed refusal behavior is identical across arms (one §5.5 pipeline,
one signature path); the Windows follow-up inherits the transport, the
protocol, and the probe discipline. Residuals: the one-shot token-file race
window (same risk class as ADR-3 (c), needs the instance token to matter),
the helper packaging gap (D13.9), and the platform rows being CI-runner
gated. The darwin fail-closed rows in the Step-3 suite remain valid exactly
as written.

**Evidence.** Host-half suite
`apps/zcode-cli/packages/bootstrap/tests/payswap-broker-peer-relay.test.ts`
(fake-helper, Linux-runnable: protocol strictness, token arms, probe
identity rule, degrade fallbacks, close semantics, the full chain through a
relay); platform suite
`apps/zcode-cli/packages/bootstrap/tests/payswap-broker-peer-macos.test.ts`
(darwin-only: real helper end-to-end, placement modes, one-shot token file,
parent-death cleanup, cross-uid EACCES); CI `gates-macos` compiles the
helper with clang and runs both suites on `macos-latest`.

## ADR-14 — The Windows §5.3 native arm: helper-held named pipe, DACL, and the spawn-table push (P1.3 completion, Windows half)

**Context.** ADR-13 shipped the relay seam and the macOS §5.1 arm, and named
this half: "the Windows half (pipe-name mint per §3.2(3), DACL per §3.2(2),
pid+image-path gate per §5.3(1) with the spawn table pushed to the helper)
lands as its own PR against the same seam." Until this ADR, win32 booted
`degraded_refusing`. The normative shape is contract §3.2/§5.3: Node/libuv
expose neither `GetNamedPipeClientProcessId` nor DACL control (§3.2(1)), so
the public endpoint is a named pipe **held by the native helper**, verified
per §5.3(1) with the C# precedent family
(`packages/desktop/native/windows-browser-import-helper/Program.cs:1031-1057,
1095-1127, 1213-1265` — `PipeSecurity`/`SetAccessRuleProtection`,
`GetNamedPipeClientProcessId`, `QueryFullProcessImageName` image verification,
`FixedTimeEquals`). Applying that family as the broker peer-verification
relay is labeled new PaySwap work (§5.3(3)).

**Decision.**

1. **D14.1 — The helper holds the public pipe (§3.2(1)/(2)).** A
   single-`Program.cs` C# helper (`apps/zcode-cli/native/payswap-broker-peer-windows/`,
   built with the family's shipped discipline — the OS-bundled .NET Framework
   `csc.exe` at the `build-windows-browser-import-helper.mjs` path, csproj-less,
   `/warnaserror+` in CI like the clang `-Werror` of `gates-macos`) creates the
   public pipe with the precedent's exact discipline: `PipeSecurity` +
   `SetAccessRuleProtection(true, false)` (no inheritance), the current
   user's SID granted `PipeAccessRights.ReadWrite`, LocalSystem `FullControl`
   (the precedent's fixed base — no administrators, no authenticated-users,
   no anonymous grants), `maxNumberOfServerInstances: 1`, byte mode,
   4096/4096 buffers. A NULL DACL or broader grant is a §3.2(2) contract
   violation. The host never creates the public pipe in verified mode; in
   degraded mode the host binds it (Node *can* listen on a pipe — it cannot
   set its DACL or read peer pids), exactly as §5.4 demands (diagnostics
   reachable; every request refused `peer_verification_failed`).

2. **D14.2 — The host mints the pipe name (§3.2(3)).** `mintBrokerBootState`
   gains a platform parameter (default `process.platform`): win32 mints
   `\\.\pipe\payswap-broker-<24-hex>` (the `createSocketPath` discipline —
   random per boot, UUID/hex entropy; a stable process-lifetime name is
   rejected). POSIX platforms keep today's path shape byte-identically. The
   ingress pipe name is minted with the same entropy family. Pipe names are
   kernel objects: there is no per-boot directory and no chmod placement law
   on win32 — §3.1(2)'s role is played entirely by the DACL (D14.1).

3. **D14.3 — Facts at connect; the pid+image-path gate runs at the pipe
   (§5.3(1)/(4)).** At `ConnectNamedPipe` completion the helper calls
   `GetNamedPipeClientProcessId` (kernel-sourced — a wire claim is never
   forwarded), then gates **before any payload byte is read**: the client is
   allowed iff (a) its pid is the spawning host AND its image path equals
   the `--parent-image` the host passed at spawn, or (b) its pid is in the
   spawn table pushed over stdin (D14.5) AND its image path
   (`OpenProcess(ProcessQueryLimitedInformation)` +
   `QueryFullProcessImageName`, `Path.GetFullPath`,
   `StringComparison.OrdinalIgnoreCase` — the precedent's
   `VerifyProcessImagePath` verbatim) equals that entry's pushed expected
   image. A table entry pushed without an image path cannot be verified →
   dropped (unverifiable = dropped, §5.3(4)). **Unregistered or
   mismatched clients are dropped at the pipe — no refusal line.** This is
   the deliberate Windows divergence from the macOS arm's relay-and-refuse
   (D13.2): §5.3(1) demands the gate before payload read and §5.3(4)
   demands the drop; a *relayed* client that later fails a host-side §5.5
   step still receives the signed typed refusal, so the refusal surface for
   registered peers is unchanged.

4. **D14.4 — The ingress is a host-held named pipe; the token is the trust
   boundary.** One ingress connection per public-client connection; the
   helper's first ingress line is the shared v1 header
   (`peer-relay-protocol.ts` unchanged — `uid` carries the win32 sentinel
   `0`), then a bidirectional pump. The ingress server is Node's
   `net.Server` on `\\.\pipe\payswap-broker-relay-<hex>`; libuv creates pipe
   instances with the OS default security descriptor, which grants read
   access to Everyone. Consequence, recorded: a cross-user squatter can
   *occupy* ingress instances (a boot-time or relay-slot DoS that degrades
   fail-closed — the probe times out, `degraded_refusing`) but **cannot
   write** the token-authenticated header, so relayed-fact forgery remains
   exactly as hard as on POSIX: steal the one-shot token (D14.5) or nothing.
   This widens ADR-13 D13.6's squatter class from same-uid to any-local-user
   while keeping the failure mode fail-closed; recorded in the threat model
   (T4/T6 residual rows). Rejected alternatives below.

5. **D14.5 — Token and control lines travel over stdin.** The host spawns
   the helper only after SHA-256 verification of the binary (the D13.4
   rule; mismatch/absent = degraded, never spawn) with argv
   `--endpoint/--ingress/--parent-pid/--parent-image` (no secrets in argv —
   the command line is readable by same-user processes via WMI, the win32
   twin of macOS `ps`), then writes the one-shot 32-byte hex token as the
   helper's **first stdin line**, followed by append-only control lines
   `{"v":1,"add":<pid>,"image":"<path>"|null}` — strict closed key set,
   one JSON object per line — pushed whenever the host registers an
   instance (`registerInstance` → `relay.registerChildPid(pid, imagePath)`).
   A later `add` for the same pid replaces the entry (the host's spawn
   table is a pid→instance route). Removals are **not pushed in v1**: §5.2(2)
   covers pid reuse host-side (exit-tombstone before reuse) and the image
   gate is the helper-side belt; a stale entry's clients must still present
   the live instance's token (§4.5) and the host still applies §5.5(4).
   Every ingress connection re-authenticates with the token,
   constant-time (`timingSafeEqual` host-side; the precedent's
   `FixedTimeEquals` discipline). The one-shot token-file race window of
   D13.4 does not exist here: an anonymous stdin pipe is not readable by
   any other process.

6. **D14.6 — Parent binding and endpoint lifetime.** The host passes
   `--parent-pid String(process.pid)` (the §5.3(2) discipline); the helper
   runs a watchdog thread that exits when the parent process is gone
   (250 ms poll bound — the macOS helper's periodic `getppid` check, win32
   form), which also gives §3.1(3)/§10.3 endpoint-dies-with-host semantics:
   the pipe object dies with the helper's handles. `--parent-image`
   (`process.execPath`) is the belt for the parent arm of the gate (D14.3a).
   §3.4's Windows form: the pipe namespace refuses a duplicate name at
   creation (`CreateNamedPipe` fails) — a pre-planted or mid-flight
   replacement cannot be silently adopted; the helper treats creation
   failure as fatal (exit ≠ 0 → probe fails → `degraded_refusing`), and a
   replaced endpoint cannot forge responses (§6.4/§6.5, T4 analysis).

7. **D14.7 — Boot is spawn + a real-path self-probe (D13.5's win32 form).**
   The subsystem is available only if the host, connecting as a real client
   to the helper-held public pipe through the exact kernel path production
   connections take, receives a token-valid header identifying *the host
   itself* (`pid === process.pid`; the `uid` field is the win32 sentinel —
   the same-user boundary is enforced by the DACL at the public pipe, not
   by a uid compare). Any failure — spawn, hash, header, token, identity,
   or the bounded timeout — kills the helper, closes the ingress, and boots
   `degraded_refusing` with the host-held endpoint. No mock ever
   substitutes the probe. To keep one §5.5 pipeline across arms, the relay
   transport declares its peer-uid basis: `"header"` (POSIX arms — the
   server compares the header uid against `geteuid()`, today's behavior)
   or `"transport"` (win32 — the server skips the uid compare because the
   transport already established it; the sentinel is not evidence).

8. **D14.8 — The spawn-table push, end to end.** The image path a gate
   entry expects is the executable the host actually spawned, observed at
   the source: the stdio transport's `ChildProcess.spawnfile`, surfaced
   through the adapters `stdioProcessObserver.onStarted(serverName,
   config, pid, imagePath?)` → `PayswapBrokerProcessObserver` →
   `registerInstance` → `PayswapInstanceRegistryEntry.childImagePath`
   (optional, additive; POSIX arms ignore it) → the stdin control line.
   A child that connects before its control line lands is dropped at the
   pipe (§5.3(4)) and the bridge client's bounded byte-equivalent retry
   (ADR-10) covers the registration race.

9. **D14.9 — Single instance means serial service (accepted, recorded).**
   §3.2(2) mandates `maxNumberOfServerInstances: 1` (the cited precedent's
   shape): while one client connection is being served, further connects
   get `ERROR_PIPE_BUSY`. With §3.3's one-request-per-connection and the
   in-memory dispatch, in-flight serialization is the accepted cost; a
   same-user client can additionally hold the slot up to the §3.3(4) idle
   cap (a DoS shape equivalent to what a same-user attacker can already
   do to any local endpoint; recorded, T6). The round-6/7 platform rows
   pinned the client-side observables of that kernel fact: a Node/libuv
   client does not surface `EBUSY` — libuv enters its `WaitNamedPipe`
   busy-retry, so the connect stays pending (no `connected`/`error`/
   `close`) for as long as the single instance is held. When the
   holder's connection ends, the server's dispose-then-recreate leaves
   a brief zero-instance window that can resolve a pending
   `WaitNamedPipe` as `ENOENT` instead of a direct grant — the
   documented Windows client retry shape (a fresh connect finds the
   recreated instance), so the platform row proves the re-grant with a
   fresh client and leaves the pending client's terminal to those
   mechanics. The service loop's pump was rebuilt to the darwin
   helper's single-threaded poll-loop discipline (APM form:
   `BeginRead` + `WaitAny` on overlapped handles, directional EOF,
   both-die on write failure, the 35s idle cap mirroring §3.3(4)):
   the original two-thread pump with cross-dispose could jam the
   serial service loop forever — closing a synchronous pipe handle
   while another thread blocks in `ReadFile` on it has undefined
   wake behavior, so the loop never reached the next
   `CreateNamedPipe` (the round-8 busy-row ENOENT shape); closing an
   overlapped handle cancels pending I/O by documented guarantee,
   making the teardown deterministic. (The round-3 "EPIPE"
   observation was an artifact of the control-line parser defect:
   the holder was dropped at the gate, the instance freed, and the
   second client connected vacuously.)

10. **D14.10 — The evidence boundary (D13.10's win32 form).** The host half
    (stdin token + control-line discipline, probe identity rule, uid-basis
    skip, push-wiring, drop-at-pipe vs typed-refusal split, close/teardown,
    the full §5.5 chain through the relay) is pinned by a POSIX-runnable
    suite against a protocol-faithful fake helper: on POSIX the relay's
    endpoint mints UDS paths for both sides (Node's net layer is
    shape-transparent — `listen`/`connect` are identical for pipes), so the
    host half is proven on Linux CI without a Windows machine; the fake's
    parentage check is a POSIX-only discipline and the fake never proves
    kernel facts. The platform rows — the real C# helper end to end,
    the real DACL (SDDL read back from the created pipe), the real
    `GetNamedPipeClientProcessId` + image-path gate, parent-death cleanup,
    single-instance busy, pipe-name mint — run only on win32, in the
    `gates-windows` CI job that publishes the helper with `dotnet` and runs
    the platform suite. A mock never greens a platform row (playbook §5(5)).
    Helper packaging inside the CLI distribution is the D13.9 gap's win32
    twin: until packaging ships a binary, production win32 boots
    `degraded_refusing` — the honest state, not a silent one.

**Rejected alternatives (recorded).**

- *TCP loopback ingress:* same squatter class (any local process can
  connect) plus a scannable port surface; the named pipe keeps the
  `\\.\pipe\` namespace family discipline. No security gain for a real
  complexity cost.
- *Helper-held ingress (role inversion):* the host cannot be the relay
  client without a per-connection signal from the helper — the multiplexed
  framing D13 already rejected; a control channel to coordinate control
  channels is strictly worse than stdin.
- *Token via argv or token file:* argv is WMI-visible to same-user
  processes (the precedent family passes `--token` in argv — we do better
  because we can: we own the spawn); a file re-opens D13.4's one-shot race
  window for zero benefit. stdin (an anonymous pipe between host and
  helper) is unreadable to third parties.
- *Helper-side removals of dead pids:* the host-side tombstone (§5.2(2)) +
  token (§4.5) + §5.5(4) already bound a recycled pid; pushing exits adds
  an ordering surface (tombstone events do not flow through the server
  today) for a belt on a belt. Recorded so it is not re-attempted without
  a concrete pid-reuse incident class.
- *N-API addon:* ADR-3's build-burden reason, now for a second toolchain;
  the helper needs no Node linkage.
- *Permissive multi-instance public pipe:* §3.2(2) mandates a single server
  instance; the serialization cost is accepted and recorded (D14.9), not
  laundered by widening the contract-cited shape.

**Consequences.** Windows gets the §5.3 read with kernel-sourced facts end
to end; the refusal surface for registered peers and the entire §5.5
pipeline are byte-identical across arms (one signature path, one typed
failure set); unregistered peers are dropped at the pipe per §5.3(4) —
a deliberate, contract-cited difference from the POSIX arms' typed refusal
(D13.2's relay-and-refuse exists there because §5.1(2) demands the peer
*receive* the typed line; §5.3(1)/(4) demand the drop here). Residuals:
the ingress default-DACL squatter class (D14.4, fail-closed only), the
serial single-instance service shape (D14.9), the packaging gap (D14.10),
and the fake-helper evidence boundary for the host half on POSIX CI
(platform rows are windows-runner-gated). The darwin/linux fail-closed
rows in the Step-3 suite remain valid exactly as written; the darwin arm
(ADR-13) is untouched.

**Evidence.** Host-half suite
`apps/zcode-cli/packages/bootstrap/tests/payswap-broker-peer-relay-windows.test.ts`
(fake-helper, POSIX-runnable: stdin token/control discipline, probe identity
rule, uid-basis skip, drop-at-pipe vs typed-refusal split, spawn-table push
end to end, hash-mismatch never-spawns, degrade paths, close semantics, the
full §5.5 chain through the relay); platform suite
`apps/zcode-cli/packages/bootstrap/tests/payswap-broker-peer-windows.test.ts`
(win32-only: real helper end-to-end through the named pipe, real DACL SDDL
readback, image-gate arms, parent-death cleanup, single-instance busy,
pipe-name mint); CI `gates` (ubuntu) and `gates-macos` gain the host-half
suite; new `gates-windows` job compiles the helper with the OS-bundled `csc.exe`
(warnings are errors) and runs the peer-verification fail-closed rows +
the platform suite on `windows-latest` (the host half is already pinned on
POSIX; a mock never runs there).

---

## ADR-15 — Helper-binary packaging for the peer-verification arms: Windows in P1, the Darwin packaging deferred to the P9 platform-hardening submilestone — one prepare discipline, one manifest, two distribution vehicles, zero broker-code change (the D13.9/D14.10 gap closure — decided before implementation)

**Context.** ADR-13 D13.9 and ADR-14 D14.10 record the packaging gap: the
arms are proven on their CI runners with env-key provisioning
(`PAYSWAP_BROKER_HELPER_{PATH,SHA256}`), but no production distribution
ships the helper binary, so production darwin and win32 boot
`degraded_refusing` — the honest state, but not the intended one. Two
production surfaces host the broker, and both already ship native binaries:

1. **The CLI SEA** (`@zcode/cli` single executable): native tools are
   compiled/prepared into `packages/desktop/bundled-tools/<platformKey>/…`
   (`prepareSeaRuntimeToolAssets`), embedded as SEA assets under
   `zcode-runtime-tools/<id>/<sha256>/<binary>` plus a `manifest.json`
   (`collectSeaRuntimeToolAssets`), and at runtime `ensureSeaRuntimeTools`
   (`packages/cli/src/sea-runtime-tools.ts`) extracts each tool to
   `~/.zcode/cache/runtime_tools/<target>/<id>/<version>-<sha256>/` with
   size + SHA-256 re-verification against the manifest, an atomic
   tmp-then-rename install, a marker file, `chmod 0755`, and env-var
   injection at `main.ts` startup that never overrides an operator-set
   value.
2. **The desktop app** (`@zcode/desktop`, which runs the same
   `apps/zcode-cli/packages/cli/dist/zcode.cjs` agent bundle under
   `ELECTRON_RUN_AS_NODE`): native helpers are staged into
   `bundled-tools/<targetPlatform.key>/…` by prepare scripts, copied into
   app resources by electron-builder `extraResources`, resolved at runtime
   via `process.resourcesPath` with dev-tree fallbacks (the
   `windowsChromeAppBoundKey` resolution family), and supplied to the
   agent through the desktop's agent-env assembly (`desktopRuntimeEnv.ts`,
   the CUA-helper-app supply precedent).

This ADR defines the packaging as a scope decision ahead of implementation
(the ADR-1/ADR-2 forward-decision pattern of this file): the delivery PR
cites this ADR, lands RED-first, and carries the register sentence.

**Sequencing decision (product-owner; recorded here and in the roadmap
register's P9 section).** The P1 packaging delivery is **Windows-only**.
The Darwin helper's production packaging — the darwin compile/stage step
of the prepare script, the darwin SEA embedding/extraction, and the darwin
desktop resource wiring (D15.1–D15.4's darwin halves) — is **deferred to
the final platform-hardening submilestone under P9**; no P10 is created.
The already-merged macOS arm (PR #26, ADR-13) and its security behavior
stay intact, and `gates-macos` keeps compiling and exercising `helper.c`
as the regression gate for that merged implementation. Until the P9
submilestone proves the darwin packaging, production darwin continues to
boot `degraded_refusing` where the helper is unavailable — ADR-13 D13.9's
honest state, unchanged. The deferral changes the schedule, never the
security: no token-only fallback, no `verifyHelperBinary` bypass, no
weakening of peer verification, and no unsupported connection appearing
supported.

**Decision.**

1. **D15.1 — One prepare discipline, CLI-owned, byte-for-byte the gates'
   compile; P1 ships win32.** A single CLI-owned prepare script
   (`apps/zcode-cli/packages/cli/scripts/prepare-payswap-broker-peer-helper.mjs`)
   compiles the Windows helper from
   `apps/zcode-cli/native/payswap-broker-peer-windows/Program.cs` with
   exactly the CI-gate discipline: the OS-bundled .NET Framework `csc.exe`
   with `/nologo /optimize+ /target:exe /platform:<arch> /warnaserror+
   /win32manifest:app.manifest` (x64 by default; arm64 only via an
   explicit Roslyn `ZCODE_CSC_PATH`, the browser-import-helper
   precedent's rule). Any flag change re-opens the platform rows — the
   packaged binary must be the proven binary. Output stages to
   `packages/desktop/bundled-tools/<platformKey>/payswap-broker-peer/`
   (the runtime-tools staging root). **Darwin and Linux are deliberate
   no-ops in P1**: the Linux arm has no helper (ADR-3 direct reader;
   D13.8's no-second-Linux-implementation rule), and the darwin helper's
   packaging is the P9 deferral above — in P1 the darwin compile remains
   exclusively the `gates-macos` regression gate's concern. A win32
   release build running on a win32 host must fail loudly when the
   required compiler is unavailable (a Windows release that would ship
   degraded must be a deliberate act, not an accident); any build that
   does not package a helper for its target — darwin and linux targets
   in P1, and every foreign-host cross-build — stages an explicit
   `helper: null` manifest (D15.2): the SEA/desktop artifact still
   builds, and the platform boots `degraded_refusing` honestly.

2. **D15.2 — The per-target helper manifest (v1), shipped as a pair.**
   `manifest.json` staged next to the binary records
   `{ "version": 1, "target": "<sea-target>", "helper": { "binaryName",
   "sha256", "size" } | null }` — the digest computed from the compiled
   binary at prepare time; `null` is the explicit absent record (every
   target P1 does not package a helper for: darwin, linux, and
   foreign-host cross-builds). Both distribution vehicles embed binary +
   manifest as an inseparable pair; a binary without its manifest (or
   vice versa) is never adopted. The `target` field uses the SEA target
   family (`win-x64`, `win-arm64`, `darwin-x64`, …) exactly as the
   runtime-tools manifest does.

3. **D15.3 — SEA embedding and extraction (the runtime-tools pattern);
   win targets only in P1.** The SEA collector embeds, for win targets
   only: `zcode-payswap-broker-peer/<sha256>/<binaryName>` plus
   `zcode-payswap-broker-peer/manifest.json`. At runtime,
   `ensureSeaPayswapBrokerPeerHelper()` (a `sea-runtime-tools.ts` sibling,
   wired at the same `main.ts` injection site) validates the manifest
   (strict closed shape: version, target match against the running
   platform/arch, binary-name, 64-hex digest, size), extracts to
   `~/.zcode/cache/payswap_broker_peer/<target>/<sha256>/` with the same
   disciplines — size + SHA-256 verification of the extracted bytes
   against the manifest, atomic tmp-then-rename, marker file, `chmod
   0755` — and injects `PAYSWAP_BROKER_HELPER_PATH` +
   `PAYSWAP_BROKER_HELPER_SHA256` into `process.env`, only when the
   platform is win32, a helper entry exists, and the operator has not
   already set the keys (the runtime-tools precedence rule verbatim).
   Non-SEA (node dev form) never injects: env-key provisioning remains
   the dev/CI discipline (D13.9 unchanged). Darwin and Linux SEAs embed
   nothing broker-helper-related before the P9 submilestone: a `null`
   /absent record produces no injection and the existing honest boot law
   applies unchanged.

4. **D15.4 — Desktop staging and supply (the browser-import-helper
   pattern); win32 only in P1.** The desktop prepare chain calls the same
   CLI-owned prepare script (one implementation, both vehicles);
   electron-builder `extraResources` copies the staged pair into the app
   resources; the desktop's agent-env assembly resolves
   `process.resourcesPath/payswap-broker-peer/<binary>`, reads the staged
   manifest, verifies the binary digest at injection time, and injects
   the same two env keys into the agent env (the CUA-helper-app supply
   precedent) — with the same precedence rule and the same honest no-
   injection on any mismatch (agent boots `degraded_refusing`, §5.4
   diagnostics reachable). Dev fallbacks follow the `bundled-tools`
   relative-path family. Darwin desktop resources carry no helper before
   the P9 submilestone — the same honest no-injection law.

5. **D15.5 — Zero broker-code change; the env seam stays the single
   supply point.** `resolveDefaultPeerRelayHelper` (D13.9) is unchanged —
   packaging only supplies its two inputs. `verifyHelperBinary` (D13.4)
   remains the spawn-time gate: it re-hashes the extracted on-disk file
   against the injected digest before any spawn, binding the file against
   post-extraction tampering (the extraction-time check and the
   spawn-time check are two verifications of one digest, not a
   redundancy). The env keys stay host-only and stripped from every child
   env (the D13.9 runtimeEnv strip lists, unchanged). A
   packaging-supplied helper is not a trusted bypass: every supply source
   passes the same spawn-time verification.

6. **D15.6 — The manifest's trust basis is the distribution vehicle.** In
   the SEA, manifest and binary live inside the postject-injected blob —
   tampering with them means tampering with the executable. On the
   desktop, they live inside the app resources covered by the app's
   platform signing and installer integrity. The manifest discipline's
   job is binding helper→digest within the shipped artifact and
   preventing stale or mismatched helper adoption (the §3.4/§10.3
   family), not defending against installation tampering: an attacker who
   can rewrite the installation can already run arbitrary code as the
   user, and that class is already recorded (D13.6/D14.4 — fabricated
   relay facts still cannot pass §5.5(3) without the instance token, and
   every response is host-signed per §6.4/§6.5).

7. **D15.7 — The evidence boundary (D13.10/D14.10's form).** Host half,
   POSIX-runnable (Linux CI, fakes): manifest validation rows (shape,
   target match, digest format); extraction rows (size/hash mismatch →
   no injection; cache-marker currency; atomic install); injection
   precedence rows (operator env wins; non-SEA no-op; absent/`null`
   helper no-op; wrong-target refusal); collector rows (staged fake
   binary → correct asset keys + manifest; absent helper → `helper:
   null` manifest, no build failure); desktop-injection resolver rows
   (fake `resourcesPath` + manifest → the env pair; digest mismatch → no
   injection). Windows platform rows (gates-windows): the prepare script
   compiles the real helper with the gates discipline and the existing
   §5.3 platform suite re-runs against the prepare-script output (path +
   manifest digest) instead of the ad-hoc CI compile — proving the
   packaged artifact is the proven artifact. `gates-macos` is unchanged:
   the regression gate for the already-merged darwin arm, env-keyed,
   with no packaging rows in P1. The full SEA assembly extends the
   existing `build-sea` test suite with the new collector (fake
   binaries). A mock never greens a platform row (playbook §5(5)).

8. **D15.8 — Scope guard and the P9 deferral record.** This is P1.3
   follow-through for the Windows helper, not a new P1 acceptance
   clause: P1's acceptance (roadmap §P1) is behavioral and already
   satisfied by the arms' fail-closed rows; the Windows packaging closes
   the recorded production-deployment residual without redefining
   milestone scope. The Darwin helper's packaging, SEA extraction and
   desktop resource wiring are deferred to the final platform-hardening
   submilestone under P9 (the sequencing decision above; recorded in the
   roadmap register's P9 section; no P10). Until that submilestone
   passes, macOS production remains honestly fail-closed —
   `degraded_refusing` where the helper is unavailable — and nothing in
   the deferral authorizes a token-only fallback, a `verifyHelperBinary`
   bypass, weakened peer verification, or an unsupported connection
   appearing supported. The register sentences ride the PRs that prove
   them: the Windows closure sentence rides the Windows delivery PR
   (register law); the P9 submilestone's sentence rides its own future
   delivery.

**Rejected alternatives (recorded).**

- *Packaging both platforms in P1 (this ADR's original scope):*
  superseded by the product-owner sequencing decision — the darwin
  packaging moves to the P9 final platform-hardening submilestone; the
  Windows packaging is the P1 delivery. Recorded so a future reader does
  not silently restore the dual-platform scope.
- *Env-only provisioning forever (status quo):* production darwin/win32
  permanently `degraded_refusing`; the arms' verified boot unrealized in
  every shipped artifact. Rejected — this ADR (win32 in P1; darwin via
  the P9 submilestone).
- *First-boot download (install-on-demand):* adds a network-trust surface
  to the money-path trust chain and defeats the pinned-digest
  discipline's offline honesty; the env keys already are the manual
  equivalent. Rejected for v1; do not re-attempt without a TL decision.
- *N-API addon or install-time build:* ADR-3/13/14's build-burden
  reasons; additionally the SEA has no install step. Rejected (recorded
  so it is not re-attempted).
- *Two manifest formats (SEA and desktop):* divergence between the
  vehicles is a stale-helper adoption surface. One format, both
  vehicles.
- *A resolution bypass flag for distribution-supplied binaries:* never —
  D13.4's spawn-time verification applies to every supply source; the
  seam has exactly one verification point.
- *A token-only or trust-flag fallback to make the deferred macOS
  packaging look supported:* never — fail-closed OS peer verification is
  the ADR-13 law; the deferral changes the schedule, not the security.
- *Linux helper "for symmetry":* the Linux arm has no helper by design
  (D13.8); adding one would fork the direct reader. Rejected.

**Consequences.** Windows release builds carry the helper in both
vehicles and production win32 boots verified; every other target —
darwin until the P9 submilestone, linux by design, and any foreign-host
cross-build — ships the honest absent record and boots
`degraded_refusing` where the helper is unavailable, never silently.
`gates-macos` is unchanged as the regression gate for the already-merged
darwin arm. The dev/CI env-key discipline, the broker's boot law, and
the arms' platform rows are untouched. The delivery plan is a single
Windows implementation PR (prepare script + collector + SEA extractor +
desktop resolver wiring + the D15.7 test map + the register sentence),
RED-first, citing this ADR.

**Evidence.** Planned per D15.7 (this ADR is the scope decision; the
delivery PR carries the RED→GREEN record, the CI gate runs, and the
register sentence).

---

## TL acceptance record — ADR-15 (helper-binary packaging scope)

Checklist-based acceptance against the TL handoff's A1–A4 requirements,
ADR-13, ADR-14, the actual runtime paths and the merged Git state, per
playbook §1 and §9 (in-scope contract acceptance is a TL responsibility;
no external sign-off is required or sought). All facts verified on
`main` @ `0ec69fc6` plus this branch's amendment head.

| # | Requirement | Where satisfied | Verdict |
|---|---|---|---|
| 1 | macOS/Windows arms already landed; neither implementation undone (A1) | PR #26 (ADR-13) + PR #27 (ADR-14) merged on `main` @ `0ec69fc6`; this ADR changes packaging scope only | met |
| 2 | P1 packaging scope = Windows through CLI SEA + desktop; gates-windows compile discipline exact (A2) | D15.1 (csc flags mirror `gates-windows`; any flag change re-opens the platform rows) | met |
| 3 | One prepare script + one strict manifest format (A2) | D15.1 (single CLI-owned script, both vehicles) + D15.2 (manifest v1, inseparable pair) | met |
| 4 | Digest verified before injection and again at the existing spawn-time boundary (A2) | D15.3/D15.4 (extraction-time + injection-time verification) + D15.5 (`verifyHelperBinary` unchanged, the single verification point) | met |
| 5 | Missing/mismatched helper never silently adopted (A2) | D15.2 (`helper: null` explicit absent record) + D15.3/D15.4 (mismatch → no injection → honest `degraded_refusing`) | met |
| 6 | Win32 release build on win32 host fails loudly on missing compiler (A2) | D15.1 (loud-failure law) | met |
| 7 | Foreign-host build records an explicit absent helper, never fakes a verified binary (A2) | D15.1 (foreign-host cross-builds stage `helper: null`) | met |
| 8 | macOS packaging deferred to the P9 submilestone; implementation + security behavior intact; `gates-macos` regression retained; honest `degraded_refusing` until proven (A1/A2) | Sequencing decision + D15.8 + the roadmap register's P9 record (this PR); `gates-macos` unchanged (D15.7) | met |
| 9 | No token-only fallback, no `verifyHelperBinary` bypass, no peer-verification weakening, no false supported status (A2) | Sequencing decision + D15.5 + D15.8 + the rejected token-only alternative | met |
| 10 | The implementation PR must prove the packaged artifact, not a separately compiled test binary (A3) | D15.7 (the §5.3 platform suite re-runs against the prepare-script output with the shipped manifest/digest) | met |
| 11 | POSIX host half may use fakes; fakes never green a platform row (A3) | D15.7 (host half POSIX-runnable with fakes; the mock-never-greens rule, playbook §5(5)) | met |
| 12 | Operator-env precedence and spawn-time digest verification preserved; a packaging-supplied helper is no trusted bypass (A3) | D15.3 (precedence rule verbatim) + D15.5 | met |
| 13 | Referenced paths, build commands, asset names, env keys and distribution entry points verified (A4) | `sea-runtime-tool-{assets,prepare}.mjs`, `sea-runtime-tools.ts`, the `main.ts` injection site, the `bundled-tools/<platformKey>/` staging root, `extraResources` + `process.resourcesPath`, `desktopRuntimeEnv.ts`, `peer-relay.ts` (`resolveDefaultPeerRelayHelper`, `verifyHelperBinary`), `PAYSWAP_BROKER_HELPER_{PATH,SHA256}`, `ZCODE_CSC_PATH` — all present on `main` @ `0ec69fc6` | met |
| 14 | Register reconciliation: superseded P1 statements removed, P2 preserved-branch status accurate, P9 submilestone recorded (roadmap law) | The roadmap register edits in this PR (P1 row, P2 row `in_progress` on `p2/gate-e2-stripe`, the P9 section record, the reconciliation date) | met |
| 15 | The Windows delivery remains its own RED-first PR after this scope decision | Consequences (a single Windows implementation PR, RED-first, citing this ADR) | met |

**Deferred-scope integrity note.** The darwin deferral moves work, not
risk: until the P9 submilestone lands, every darwin production surface
keeps ADR-13's fail-closed boot law, `gates-macos` keeps proving the
merged implementation on every PR, and the darwin helper's env-key
dev/CI discipline (D13.9) is unchanged.
