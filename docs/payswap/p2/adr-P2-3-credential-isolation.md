# ADR-P2-3 — PSP credential isolation from model-controlled processes

- Status: **accepted — SYSTEM custodian service architecture (amended 2026-11-19;
  live-verified on this machine)**. Owner disposition 2026-11-18: "Hardening =
  P2 blocker" (recorded in `live-acceptance-evidence.md` §10.2). The §2 first
  attempt (restricted-token children) was REJECTED live; the §2 "Layer 1-3"
  LogonUser-per-call design below was likewise **superseded** by the SYSTEM
  service — it is retained as decision history only, not as the shipped design.
- Supersedes: the 2026-11-17-era framing that placed the same-user DPAPI boundary
  outside P2 (§10.2 of the evidence register supersedes that statement)
- Enforcement gates: `scripts/payswap/security/custodian-service-probe.cjs`
  (protocol battery: diag hygiene, exact gates, deadlines, durable custody,
  client contract) + `scripts/payswap/security/isolation-probe.cjs`
  (meaningful-green adversarial acceptance: fresh credential in custody, at-rest
  recovery blocked, unauthorized RPC refused) — the milestone is DONE exactly
  when both exit 0 on the final head

## 0. Amendment 2026-11-19 — the shipped architecture (SYSTEM custodian service)

**Decision:** the PSP credential lives ONLY inside a demand-start Windows service
running as LOCAL SYSTEM (`PayswapCustodianSvc`), which holds the key in memory and
in a SYSTEM-DPAPI-wrapped blob; the desktop main reaches it exclusively through a
gated named-pipe protocol; every fallback to the legacy user-readable credential
store is structurally removed on Windows (`credentialCustody: "custodian-required"`).

### A0.1 Components (as implemented)

1. **Service** (`apps/zcode-cli/native/payswap-broker-peer-windows/Program.cs`,
   custodian region): installed by the helper's `--svc-install` (elevated) which
   copies the binary to `C:\ProgramData\payswap\svc-bin\` (explicit ACLs:
   SYSTEM+Administrators only, inheritance off — a user-writable location is
   rejected as a SYSTEM service host; SvcRun self-checks image location + ACL at
   start), writes the exact-identity config (electron image, client-helper image,
   user SID), and registers via `sc create/start`. Service-mode refuses
   `--test-gate` outright (the console seam cannot reach SYSTEM).
2. **Protocol** (`payswap-custodian-v1` named pipe): per-start token handshake
   (endpoint file `C:\ProgramData\payswap\custodian-endpoint.json`, SYSTEM + user
   RW), kernel-fact gates only — client pid via `GetNamedPipeClientProcessId`,
   client image == configured helper image (exact), parent image == configured
   electron image (exact, via `OpenProcess`+`QueryFullProcessImageName`), data ops
   additionally require the registered main pid with live re-verification
   (PID-reuse defense). Registration = exact electron-image anchor (the
   `Contains("electron.exe")` gate is abolished); rebind allowed only through the
   same full gate. All reads/writes bounded (Task.WaitAny deadlines); replies
   wait (bounded) for pipe drain so `Disconnect` cannot race away a reply.
3. **Custody** (durable semantics): push = validate shape (64..512 printable
   ASCII) → SYSTEM-DPAPI protect → atomic blob write (tmp + Replace/Move) →
   readback decrypt + byte-verify → SYSTEM-only ACL → only then ack ok:true;
   drop = memory clear → delete → verify absent → ack ok:true. Any failure =
   typed ok:false (the client exit-code contract 0/70/71/72 makes unconfirmed
   ops throw in the TS bridge). Bootstrap restores the key from the blob across
   service restarts (`bootstrap-key-restored`).
4. **Bounded read proxy**: five-path allowlist (`/v1/balance|/v1/charges|
   /v1/customers|/v1/disputes|/v1/account`), key only ever placed in the
   Authorization header inside the service, `Proxy = null` + TLS 1.2 explicit,
   30s read/write timeouts.
5. **Diagnostics**: sanitized decision facts only (pid/reason/length/result
   code/win32 error code) — no tokens, no operation payloads, no exception
   messages; 1 MB rotation. The secret-bearing `custodian:op=` line is gone.
6. **Desktop seam** (`packages/desktop/src/main/payswap/custodianClient.ts`):
   `provisionDesktopCustodianBridge()` returns active (bridge) or inactive with an
   explicit reason; liveness = successful register handshake (kernel pipe+token+
   gate facts), never a stale endpoint file; verified replies; one fully-gated
   re-register retry for service-restart recovery.
7. **Fail-closed runtime** (`packages/services/src/payswap/runtime.ts` +
   `accountService.ts`): `credentialCustody: "custodian-required"` (win32) — with
   no bridge, the credential port is a refusing port (`custodian_unavailable`
   typed refusal; no legacy write path exists at all — the enc:v1 slot cannot be
   written even when the custodian is missing/broken); delete-only legacy access
   keeps revocation working and cleans pre-policy residue. The bridge is
   forwarded into the account service (a pre-existing omission that made the
   revoke-time custody drop a silent no-op is fixed); an unconfirmed custody drop
   makes revoke a typed refusal on an already-revoked record.
8. **Connection UI**: `custodian_unavailable` refusal code surfaced with i18n
   strings (code-keyed, never message-matched).

### A0.2 Why this design (vs §2 history)

- The restricted-token design (§2 first attempt) is impossible on non-elevated
  desktops (win32 1314). The LogonUser-per-call design (§2 "accepted") was
  superseded: a dedicated-identity custodian still leaves the wrapped material
  readable to any same-user process holding the DACL-granted file, and per-call
  impersonation cannot persist the key across restarts without re-deriving from
  those files. The SYSTEM service moves custody entirely out of the user's
  reach: the user-readable artifact set no longer contains (or can unwrap) the
  credential at all.
- Proven live on this machine (see
  `evidence/custodian-2026-11-19/EVIDENCE.md`): service-mode register → push →
  live Stripe 200s (4/4); same-user read of the blob = EPERM; service restart →
  blob bootstrap restores the key (3/3, no re-push); verified revocation (blob
  absent, post-drop read = typed no-key); console probe battery 21/21;
  isolation probe GREEN (fresh-key digest absent from all user-readable
  material, unauthorized RPC refused, copied-helper registration refused).

### A0.3 Honest boundary statement (unchanged in spirit)

- The service boundary defends files + RPC; memory-read of the desktop main by a
  same-user process remains a same-trust-boundary breakout of a different threat
  class (tracked in the hardening milestone).
- The endpoint file is readable by the user by design (pipe + per-start token);
  it grants nothing by itself — the gates are kernel process facts.
- Revocation requires the custodian service to be alive to confirm the drop; a
  failed drop surfaces as a typed refusal (never a fake revoked confirmation).

## 1. Context

The 2026-11-18 security probe (evidence register §10) demonstrated end-to-end that a
plain, non-Electron, same-user process recovers a freshly stored PSP credential:

```
%APPDATA%/ZCode Dev/session/Local State (os_crypt.encrypted_key, "DPAPI"-prefixed)
  → plain DPAPI unprotect (CurrentUser) → 32-byte master key
  → v2/payswap-psp-safe-storage-key (Chromium "v10" AES-GCM blob) → 64-hex file key
  → v2/credentials.json "enc:v1:" slot (services cipher, public repo format)
  → restricted-key plaintext
```

A model-controlled process **is** such a same-user child. The established P2 law —
"PSP credentials must not be exposed to the model" — is therefore violated by the
current architecture regardless of how reliably the authorized tool path behaves.
Key rotation (§10.1) contains the historical exposure; it does not change the
boundary. Electron 44's os_crypt scheme does not either.

## 2. Decision

**First attempt (2026-11-18) — deny-restricted agent child processes — REJECTED by
live Windows privilege reality.** Implementation detail: `CreateRestrictedToken`
works, but `CreateProcessAsUser` with the derived restricted token fails with
**win32 1314 (ERROR_PRIVILEGE_NOT_HELD)** — SeIncreaseQuotaPrivilege is not held by
a non-elevated desktop process (Windows 11 26200 default token), and the documented
alternatives (`CreateProcessWithTokenW`) need SeImpersonatePrivilege — likewise not
held. Undocumented workarounds (NtSetInformationProcess ProcessAccessToken swap) are
against the repo's documented-API discipline. The helper binary retains the
`--harden-path` / `--harden-child` / `--spawn-restricted` modes as the probe
instrumentation, but the restricted-token spawn layer cannot ship.

**Accepted design — dedicated-identity custodian helper** (the TL's Option A,
realized without a permanent Windows service install):

### Layer 1 — one-time elevated provisioning (operator-gated, UAC step)

A local account `payswap-broker` (random 32-char password, generated at provision
time, stored **only** in the helper-readable provisioned store whose DACL grants
just that account + SYSTEM). Provisioning = one elevated `net user /add` +
password hand-off; never repeated.

### Layer 2 — custodian helper = the ONLY reader/decryptor

The existing payswap-broker-peer helper gains `--custodian` mode: it calls
`LogonUser("payswap-broker", …)` (no caller privilege required for
LOGON32_LOGON_BATCH/INTERACTIVE with explicit credentials — verified against the
Win32 contract) and impersonates, then:

- reads the PSP wrapped-key + `credentials.json` slots (DACLS re-keyed: grant
  `payswap-broker` + SYSTEM only, **revoke Lenovo read**),
- derives the cipher, performs the Stripe read-back itself (the four categories
  + account evidence),
- returns **redacted projections only** over the existing authenticated
  reader-bridge/relay channel (D14.8 image-path gate machinery).

The desktop main never holds — not even as ciphertext — the PSP credential: the
store file is unreadable to Lenovo/model processes by DACL, and the plaintext
exists only inside the impersonated helper process.

### Layer 3 — adversarial acceptance (unchanged, sharpened)

- `scripts/payswap/security/isolation-probe.cjs` GREEN: same-user child is blocked
  at file read (DACLS deny Lenovo outright — stronger than the restricted-token
  design's conditional protection).
- The helper's authenticated channel stays hash/image-gated (D14.8) so model-side
  processes cannot drive the custodian directly.
- New Task four-category read re-proved through the custodian; full five-stage
  runner + 13-step receipt re-run on the isolated build.

## 3. Alternatives considered

| Option | Assessment |
|---|---|
| Restricted-token agent children (first attempt) | REJECTED live: `CreateProcessAsUser` needs SeIncreaseQuotaPrivilege (win32 1314 on 26200); `CreateProcessWithTokenW` needs SeImpersonatePrivilege; both absent from non-elevated desktop processes. Undocumented NtSetInformationProcess token-swap rejected on documented-API discipline. |
| Full Windows service (permanent install) | Heavier than the custodian helper for the same guarantee (the custodian impersonates a dedicated identity per-call instead of a service hosting it permanently); no service-control-manager surface, no install-time service ACLs. Escalation path if the LogonUser-based custodian proves fragile. |
| AppContainer for agent children | Insufficient alone (child keeps user SID; default DACLs granting the user still admit it) and cripples normal tool behavior (loopback/network denied). |
| In-memory-only credentials (never at rest) | Breaks receipt steps 6/7 (restart persistence); moves the surface. |
| TPM-bound encryption | Protects against other machines, not same-user processes. |

## 4. Consequences

- Same-user model-controlled children lose read access to every credential-carrying
  file; the recovery chain is blocked at its first file read.
- The desktop main keeps single-owner access; no protocol or store-format change.
- All legitimate agent capability (four-category reads, route discovery, evidence
  refresh) continues through the existing authenticated broker/reader-bridge.
- Deployment adds a helper-binary mode + first-run ACL hardening step; both ship in
  the desktop installer/dev chain (no admin elevation needed — the files are owned
  by the user).
- Honest boundary statement: the restricted-token boundary defends the *files*;
  memory-read of the desktop main process by a same-user process remains out of
  scope for this layer (that is a same-trust-boundary breakout — a different threat
  class, tracked separately in the hardening milestone).

## 5. Rollout

1. Helper mode: `--spawn-restricted <cmd> [args…]` (C# P/Invoke:
   OpenProcessToken → CreateRestrictedToken(restricting SID) → CreateProcessAsUser).
2. First-run ACL step in desktop main: attach the deny ACE to the three paths.
3. Wire `ZCodeAgentProcessManager` spawn through the helper (restricted mode).
4. Turn `scripts/payswap/security/isolation-probe.cjs` GREEN (exit 0) — this is the
   milestone's acceptance gate, with the PowerShell variant added to the probe.
5. Re-prove: New Task four-category read + five-stage runner + 13-step receipt on
   the isolated build; update evidence register §10 with the GREEN probe output.

### A0.4 Amendment 2026-11-19 (post-merge review follow-up) — F6 impersonation gap closed

The independent review's F6 finding was **confirmed by live execution** before
fixing: a same-user process launching the *configured* electron image with an
attacker-controlled entry script and driving the genuine helper reached full
custody control (register/push/get/drop all accepted) under the multi-instance
relaxation. Fixed by:

1. **First-alive-wins registration** — rebind is refused while the registered
   desktop main is alive and matches the configured image; rebind only after the
   registered main dies (the legitimate app-restart path). The desktop is a
   single-instance process by law (`requestSingleInstanceLock`), so this binds
   the service to the one genuine desktop instance.
2. **Registered-pid data gate restored** — data operations require the parent
   helper's parent pid to be exactly the registered main pid (image + alive
   kernel checks unchanged). The impersonating electron is a different pid →
   refused at every data operation.

The F6 attack is now a **permanent probe battery case** (console mode, production
gates, no test seam: `f6:impersonator-{register,push,get}-refused-while-genuine-alive`;
battery 26/26) and was re-executed live against the redeployed SYSTEM service:
**all four attack ops refused** while the genuine main was alive
(`evidence/custodian-2026-11-19/f6-live-result.json`; test script kept as
`f6-live-impersonation-test.cjs`). The genuine flow re-verified 4/4 after the fix.

**Honest residual (asserted in the battery, must stay visible)**: at the instant
the registered main dies (app exit / service restart), a fresh electron main
rebinds — first-come-first-served. An impersonator winning that race gets the
custody channel **until its own process dies**, and the genuine desktop's
subsequent connections fail typed (`custodian_unavailable`) — loud, visible
breakage, never silent impersonation. Command-line pinning was evaluated and
rejected (self-PEB-rewrite spoofs it). The complete fix is OS-level separation of
model-controlled children (AppContainer spawn for agent processes) — tracked as
the follow-up Windows security task; until then the same-trust-boundary breakout
class (debug-injecting the genuine main, winning the restart race) remains
documented rather than solved.

### A0.5 Amendment 2026-11-19 (review follow-up round 2) — process-instance identity + honest race statement

The second review round accepted the F6 gate but identified two remaining
weaknesses. Disposition:

1. **PID-reuse (W2) — CLOSED structurally.** `registeredMainPid` alone cannot
   distinguish the original main from a same-image process that later owns the
   reused PID. Registration now **retains a kernel handle to the registered main
   process** (SYNCHRONIZE | QueryLimitedInformation); the data gate requires the
   retained handle to be **live** (WaitForSingleObject(0) == WAIT_TIMEOUT) in
   addition to pid equality and the exact-image check. A retained handle
   references the *original* process object: if the process exits and Windows
   reuses the PID — even for a process launched from the same configured
   electron image — the handle signals and every data operation is refused.
   The handle is opened fail-closed at registration and released on rebind/stop.
2. **Registration race (W1) — OPEN, documented, loud.** At service start /
   registered-main death, the first qualifying electron main rebinds first-come-
   first-served; the service has no kernel-enforced way to distinguish the real
   desktop from an attacker's electron at that instant (command lines are
   PEB-rewritable; every same-user protocol proof is replayable). The race is
   asserted in the probe battery (`f6:residual-rebind-after-genuine-death-
   expected`) so it cannot silently change. Winning the race is **loud**: the
   genuine desktop's subsequent connections fail typed (`custodian_unavailable`)
   and the diag records the rebinding pid. Closing this window requires the
   OS-level identity separation of recommendation 3 (AppContainer for
   model-controlled agent children with the pipe ACL designed together) — the
   tracked Windows security task.
3. **Battery coverage (W3) — extended to 28 checks**: the F6 case now covers all
   four custody operations (register/push/get/**drop**) refused while the
   genuine registration is alive, plus service-restart registration clearing,
   plus the residual-rebind assertion. The live F6 result JSON now records the
   service binary identity (deployed path via sc qc + the staged binary's
   SHA-256 — byte-identical to the deployed copy by the install code path) and
   the post-fix genuine flow (4/4 with live Stripe 200s).

Live re-verification on the redeployed SYSTEM service (retained-handle binary
`c670f706…`): the impersonator was refused at all four operations while the
genuine main was alive; the fresh-main rebind after genuine death succeeded
(residual visible); the genuine flow re-verified 4/4.

### A0.6 Amendment 2026-11-20 (review round 3, item 2) — W1 permanent adversarial regression

The round-3 task built the permanent adversarial regression for the W1
residual itself (it does NOT close the race and does NOT reopen P2-Windows):

1. **The race is now pinned end-to-end in the permanent battery**
   (`batteryRegistrationRaceW1`, battery 54 checks incl. 26 `w1:` checks):
   the attacker electron that wins the rebind race is recorded honestly
   (register `ok:true`, `register-rebind parent=<attackerPid>` in the diag,
   plus full winner control — get/push/drop/re-push over the custody channel
   with a synthetic canary), and the arriving genuine desktop is refused
   **loudly at all four custody ops** (exit 70, EOF, empty stdout — the exact
   boundary `custodianClient.ts` maps to inactive `register-refused` → typed
   `custodian_unavailable`), with the attacker canary asserted absent from
   every genuine-side capture, the data-gate refusals asserted in the diag,
   and the documented recovery (fresh genuine rebind after the attacker exits;
   purge + re-push of genuine material) proven. RED-phase output against the
   original behavior is retained
   (`docs/payswap/p2/evidence/custodian-w1-2026-11-20/`); the loud-refusal
   contract held on the original behavior — **no production gate was modified
   to satisfy the regression** (only test seams with unchanged defaults:
   `endpointFile`/`helperPath` options alongside the existing `runClient`
   seam).
2. **Desktop typed-refusal law is CI-canonical**
   (`packages/desktop/test/payswap-custodian-provisioning-fail-closed.test.ts`,
   8 cases, registered in the ci.yml P2 battery and the P2 runner vitest
   list): register exit 70 → inactive `register-refused` with no bridge; data
   ops exit 70 → exactly one full-gate re-register retry → typed
   `custodian_unavailable`; recovery retry after the attacker exits; exit-72
   unconfirmed outcomes typed, never faked; secret only via stdin.
3. **Live SYSTEM-service confirmation (non-destructive)**: on the installed
   service the race was won by an attacker electron (recorded honestly), the
   arriving genuine desktop was refused at all four ops (70/EOF/empty), and
   the fresh genuine main recovered with live Stripe 200s — custody blob/memory
   never written. Evidence: `docs/payswap/p2/evidence/custodian-w1-2026-11-20/`.
4. **Console-mode observation (fail-closed by design, no action)**: after a
   verified push the blob is SYSTEM-only, so a console-mode service cannot
   `File.Replace` an existing blob (honest `persist-failed`); the battery
   sequences pushes onto absent blobs and Replace-while-exists is covered by
   the live SYSTEM leg. Recorded as backlog observation H6 in
   [post-p9-windows-security-backlog.md](post-p9-windows-security-backlog.md)
   (H1–H6 consolidated there — **all `deferred_to_post_P9`**; none promoted
   into current acceptance criteria).

W1's status is unchanged: **OPEN by design, documented, loud, now
battery-pinned end-to-end**. Its closure remains the OS-level identity
separation task (backlog H2).
