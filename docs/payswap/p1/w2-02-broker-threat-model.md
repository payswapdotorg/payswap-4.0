# P1 Wave 2 Deliverable 2 — The Broker Threat Model

**Owner:** TL · **Companion to:** `w2-01-broker-contract.md` (normative
contract; this document is its risk analysis) · **Method:** assets → trust
boundaries → adversaries → attack trees → mitigations → residual risks.

The threat model exists to answer one question the architect posed in the P0
review: *what does "authenticate the calling process" actually have to
withstand on a developer's machine?* Every mitigation below maps to a
contract section and to the adversarial suite (Step 7) or a negative row of
addendum §1.7 that proves it. Anything we cannot mitigate is stated as
residual risk with its honest boundary — not glossed.

---

## §1 Methodology

Classical asset-centric threat modeling over the bridge's single trust
boundary (host ↔ PaySwap MCP child), extended with the addendum §3.5
hardening items as explicit adversary classes. The P0 review's rule governs
severity: **the broker is on the money path** (P2+), so its authentication
posture must be fail-closed, not best-effort — a mitigation that only works
when the attacker is polite is not a mitigation.

## §2 Assets

| # | Asset | Where | Loss scenario |
|---|---|---|---|
| A-1 | Per-instance broker credentials (token + instance id + endpoint path) | host memory → PaySwap child env | theft → impersonation of the bridge caller |
| A-2 | The broker endpoint itself | host-private dir (POSIX) / helper pipe (Windows) | replacement/occupation → traffic capture, DoS, spoofed host |
| A-3 | Reachability of host financial services | behind the closed dispatch table | unauthorized dispatch → data exposure now, money movement P7 |
| A-4 | The instance registry | host memory | forgery → binding a fake instance to a real scope |
| A-5 | Future: account data (P2+) / the ledger ingress (P7) | behind the broker | premature reach → the boundary this wave must hold |
| A-6 | Audit records | host log | tampering → undetectable replay or impersonation |

Wave 2's concrete stakes: A-1 through A-4 and the **boundary** over A-5. No
account data or ledger exists yet — the attack surface of this wave is the
bridge itself, and the asset it protects is *the guarantee that nothing
crosses until later waves' gates open it*.

## §3 Trust boundaries and principals

```
┌─ HOST PROCESS (trusted computing base) ──────────────────────────────┐
│  broker listener · instance registry · financial services · spawn    │
│  table · audit log                                                   │
│        ▲                                                             │
│        │ (1) verified crossing: peer creds + token + registry +      │
│        │     replay check + closed dispatch                          │
┌────────┴──────────────────────────────────────────────────────────────┐
│ PAYSWAP MCP CHILD (semi-trusted) — holds its credential, nothing else │
└────────┬──────────────────────────────────────────────────────────────┘
         │ (2) process env boundary (strip list — §4.3 of the contract)
┌────────┴──────────────────────────────────────────────────────────────┐
│ ALL OTHER CHILDREN & SAME-USER PROCESSES (untrusted for money)        │
│  other MCP servers · skills · Bash/tool children · any local process  │
└───────────────────────────────────────────────────────────────────────┘
         │ (3) OS boundaries: other users (fs perms) · network (none —
         │     local-domain socket only)
```

Boundary (1) is the only place a request may enter the host from outside
it. Boundary (2) is where credentials must never leak. Boundary (3) is held
by the OS and the transport choice, not by us — stated for completeness.

**Honest TCB statement:** everything inside the host process is trusted. A
compromised host component (renderer exploit reaching the main process, a
malicious host extension) is **out of scope** for this model — no broker
design inside the host can defend the host from itself; that class belongs
to the host's own security model and the §1.6 approval-origin chain (Wave 4
defends the *other* direction). What this model must hold: nothing **outside
the host** — and nothing inside it that is merely another child — reaches
financial services except through the verified crossing.

## §4 Adversary classes

| # | Adversary | Capability | Primary target |
|---|---|---|---|
| D1 | Impostor MCP config | copies PaySwap's names/commands/env into a user/project MCP config; not the official registration | A-3 via a fake "PaySwap" server (N19) |
| D2 | Credential thief (same user) | reads sibling processes' env (`/proc/<pid>/environ`), scrapes logs/artifacts | A-1 (N20, strip-list discipline) |
| D3 | Replay attacker | captured a valid request (or its identity); re-sends on same/new/second connection, in or out of order | the dispatch's at-most-once property (N33–N35, N39) |
| D4 | Endpoint attacker | pre-plants a socket at the path, or replaces the listener, or races a crashed host's stale socket | A-2 (N22) |
| D5 | Pid spoofer | kills the real child, waits for pid reuse by its own process; or claims a pid on the wire | A-4 / the §5.2 binding |
| D6 | Flood attacker | opens many connections, sends oversized/gap-jumping sequences | broker memory/CPU (§9.4, §3.3) |
| D7 | Confused deputy driver | another MCP server, a skill, or a prompt-injected Bash command that *obtained* a credential through leakage | A-1 leakage → A-3 (runtimeEnv strip rationale) |
| D8 | Malicious PaySwap child (the semi-trusted insider) | is the legitimate credential holder; tries to exceed its scope | §7 closed dispatch, §8 session/workspace binding |
| D9 | Platform downgrade attacker | makes peer verification unavailable (blocks helper spawn, strips a runtime API) to force a token-only fallback | §5.4 fail-closed rule |

## §5 Attack trees — mitigations and proofs

Each tree reads: adversary → attack step (mitigation §; proof row).

### T1 — Impostor server (D1)
- Copy manifest names/commands/env → **no credential ever injected**
  (contract §4.2: injection is by in-memory official registration with
  reference identity `configuredServers[name] === config`,
  `mcp-config.ts:43-58`) → cannot even reach the token check → **N19**.
- Steal a real credential (falls to T2) → token passes but peer
  verification (§5.1/§5.2) demands the registered child's live pid →
  impostor pid fails → **N19/N20**.
- Connect with no credential → `unauthorized` (§4.5) / dropped at peer
  check (§5.5 order) → **N19**.

### T2 — Credential theft (D2, D7)
- Read sibling env → key stripped from every other child (§4.3;
  `runtimeEnv.ts:64-76` — the shipped confused-deputy rationale) →
  nothing to read. **Proof:** Step 2 suite asserts sibling/Bash child env
  omits all three `PAYSWAP_BROKER_*` keys.
- Read the PaySwap child's own env (same user, `/proc`) → token alone is
  insufficient: §5 peer verification + §10.1 registry binding demand the
  *process*, not the knowledge. A thief process presenting a stolen token
  from a different pid fails §5.2 → **N20**. (The residual same-user
  ptrace case: §7 below.)
- Scrape logs → §11.2 forbids token material in logs → nothing to scrape.
- Nested agent inheritance → §4.3(3) strip applies to descendants → the
  official-endpoint "one session's token never reaches another session"
  discipline.

### T3 — Replay (D3)
- Same connection, same `(instanceId, seq)` → `sequence_duplicate` before
  dispatch (§9.3) → **N33**.
- New connection after drop (the shipped brokers' actual gap — their
  one-request-per-connection state ends at close) → dedupe scope is the
  broker instance, not the connection (§9.2) → **N33/N34**.
- Second concurrent connection, same identity → atomic accept test: one
  dispatch, one refusal (§9.3(4)) → **N35**.
- Out-of-order completed replay (the subtle arm): seq 12 completed, seq 11
  missing, replay 12 before 11 → 12 still in retained set `R` (completed ≠
  covered) → refused; 11 then arrives and the watermark advances through
  both (§9.3(3)) → **N39**.
- Replay across host restart → previous incarnation's instanceIds all
  superseded (§10.3): `instance_unknown` before sequence handling; plus
  the stale endpoint is gone (fresh per-boot path, §3.4) → **N22 arm**.

### T4 — Endpoint attack (D4)
- Pre-plant a socket at the future path → path is UUID-entropy in a `0700`
  `mkdtemp` dir; host refuses/removes an existing entry before binding
  (§3.4(1)) → **N22**.
- Replace the listening socket mid-flight → impossible while the host holds
  the listen fd; a same-user attacker who could unlink it (POSIX allows)
  produces a *different* endpoint — clients still present per-instance
  tokens that only the real broker registry validates; a fake broker
  cannot answer with anything the child would accept as a valid dispatch
  (and Wave 2's payload is refusals — nothing to steal). Post-P2 this arm
  is revisited under response-integrity (see §8 residual).
- Stale socket after host crash → per-boot dir dies with the host;
  fresh boot = fresh dir + path (§3.1, §3.4) → **N22**.

### T5 — Pid spoofing (D5)
- Claim a pid on the wire → §5.2: the *host* maps pid→registry (payload
  claims are never adopted) → forged mapping fails → Step 3 suite.
- Pid reuse race (real child dies, OS recycles pid to attacker) → the
  child's exit tombstones the registry entry before the attacker's process
  can present anything (§10.2(1)); a fresh claim for a dead instanceId is
  `instance_unknown` → Step 2 suite.
- Windows: `GetNamedPipeClientProcessId` + image-path verification at the
  helper (§5.3, `Program.cs:1095-1127`) — the attacker's binary is not the
  plugin server image → dropped at the pipe → Step 3 (Windows) suite.

### T6 — Flood / resource exhaustion (D6)
- Connection floods → local-domain only, per-connection 1 MiB cap,
  one-request-per-connection, server-side close (§3.3); no per-connection
  state survives close (§9.2).
- Sequence-gap ballooning (skip to huge seqs, force unbounded `R`) →
  bounded gap `G` (default 64): `sequence_gap_exceeded` before dispatch;
  `R` is O(G) per instance (§9.4) → Step 6 suite.
- Bogus instanceIds (registry pollution via probe requests) → unknown
  instances never create per-instance state (state is created at
  *registration*, spawn time — §10.1, not at request time) → Step 2 suite.

### T7 — The semi-trusted child (D8)
- Ask for a seventh operation / arbitrary service → closed enum + closed
  handler map; schema rejects unknown ops (§7.2) → **N21**.
- Ask for another session's/workspace's data → binding (§8.2), workspace
  isolation (§8.3): `session_unresolvable` / `workspace_mismatch` → Step 5
  suite (the N41 discipline's local arm).
- Submit `authorizationId` to trigger grant logic early → dormant hook
  rejects without reaching any grant code (§7.4) → Step 7 suite.

### T8 — Downgrade to token-only (D9)
- Kill the peer-verification helper / block the native API, hope the
  broker degrades open → §5.4: unavailable peer verification = broker in
  `degraded_refusing`, every request refused, financial services
  unreachable — fail-closed, the macOS Helper's own rule → Step 3 suite
  (forced-unavailable arm per platform).

## §6 Fail-closed rules (collected)

1. Half-captured credential pairs clear the snapshot and refuse the launch
   (§4.4 — the shipped `:171-174` pair rule).
2. Peer identity unverifiable → the platform refuses connections
   (§5.4) — **no token-only fallback for money, ever**.
3. Unknown pid → dropped before payload parse (§5.5).
4. Superseded instance → `instance_unknown` before sequence handling
   (§9.2, §10.3).
5. Duplicate identity → refused before dispatch, regardless of original
   outcome (§9.3).
6. Schema violation / oversize / unknown op → `request_invalid` /
   `operation_not_found`, nothing dispatched (§3.3, §6, §7.2).
7. Plugin disabled → bindings revoked at disable time, residual calls
   refuse `financial_mode_disabled` (§10.2) — the addendum §2.1 table's
   reachability fix.

## §7 Residual risks (honest, unlaundered)

1. **Same-user ptrace/CAP_SYS_PTRACE.** A same-user process that can
   `ptrace` the PaySwap child can read its memory — token, and control
   flow — no broker discipline stops a fully-compromised-credential-holder
   *process*; §5 makes the thief need the process, not just the secret,
   which raises the bar from "read env" to "control the process", but the
   line is drawn by OS process isolation, not by us. Mitigations in
   depth: per-instance binding means the stolen process is still confined
   to §7/§8 scope (closed ops, its session, its workspace). **Stated,
   accepted for P1–P2 (read-only era); revisited before any money
   movement with the full grant chain (§1.3) as the compensating
   control.**
2. **Same-user socket unlink (POSIX).** A same-user process can unlink the
   broker's socket file and bind its own path — clients would connect to
   the imposter. Defense today: the imposter cannot answer with valid
   dispatches (no registry), and Wave 2 carries no valuable payload;
   **response-integrity (does the child verify the broker?) is explicitly
   NOT yet designed** — the shipped brokers don't do it either. Filed as
   the first candidate for the Wave 2 implementation PRs' hardening
   review: minimum viable arm = the response echoes the request's
   `(instanceId, seq)` (a fake broker must at least know the instanceId —
   which never appears in any env other than the child's own); full arm =
   a response MAC keyed by the per-instance token, decided at Step 2
   design review, before any read-only provider data (P2) crosses.
3. **Registry is in-memory only.** Correct for the threat model (it is the
   host's own state, TCB) but means audit correlation across restarts
   depends on §11's log, not the registry. Accepted; the P7 ledger
   replaces the audit log's authority.
4. **Desktop assumes single financial host per machine** (addendum §4.6's
   P7 law). A second host process's broker is a *different* broker with
   its own per-boot dir — no cross-talk — but "one authoritative
   financial host" is only enforced at the ledger layer (P7), not here.
   Accepted for this wave; the P7 fenced lease is the enforcement.

## §8 Out of scope (and why)

- **Network adversaries:** the endpoint is local-domain only (§3.1/§3.2);
  no network path exists to attack. (The server-deployment variant keeps
  the broker host-local per addendum §3.4 — the network edge belongs to
  the §1.6.3 server principal model, Wave 3.)
- **Other-user adversaries:** OS filesystem permissions (`0700` dir,
  `0600` socket, current-user-SID pipe DACL) are the boundary; testing
  them is Step 3's platform suites, not this model's trees.
- **Renderer-origin approval attacks:** §1.6/N13–N18 — Wave 4's
  host-rendered card chain.
- **Ledger single-writer/fencing:** §4.6/N23–N24/N36–N38/N42 — P7.
- **Provider-side abuse (stolen PSP credentials elsewhere):** P2's Gate
  E2 and deliverable 05's adapter contracts.

## §9 The adversarial integration test plan (Step 7 executes)

One suite, run against the **real production host launch chain** (the PR #3
`payswap-host-launch` harness pattern — real `zcode.cjs` dispatch, real
manifest resolution, real spawn), with a financial-service stub asserting
dispatch/no-dispatch at the service boundary:

1. **Chain happy path:** real plugin build → host spawn → credential
   injected → tool call → broker → six tools enumerated → refusals typed
   per state (S1/S2) — T2/T3 flip rows included (opt-in/opt-out between
   calls, live answer).
2. **N-rows executable against the bridge:** N19 (impostor config — no
   credential), N20 (cross-instance token), N21 (seventh op), N22 (stale
   endpoint after restart), N33/N34/N35/N39 (the four replay arms,
   including the out-of-order completed arm with a forced sequence-11
   delay).
3. **Platform arms:** POSIX peer-credential pass/fail (uid mismatch,
   unknown pid, dead pid reuse); Windows helper verification (client pid,
   image path, DACL) in the lab harness; forced-unavailable →
   `degraded_refusing` on each platform.
4. **Boundary assertions at the stub:** every refusal row also asserts
   **zero host-service dispatch attempts** (the N-row law: asserted at
   the service boundary, not the UI).
5. **Audit completeness:** the run's ingress log contains every request
   with its outcome; a token-pattern scan over all logs/artifacts finds
   nothing (the §11.2 rule, machine-checked).

The suite is the wave's exit gate: green on the real chain, all rows, no
carve-outs. Any row that cannot be made green is a contract deviation to
be reported and adjudicated — never silently dropped.
