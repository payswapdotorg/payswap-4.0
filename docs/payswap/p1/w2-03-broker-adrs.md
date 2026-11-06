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
