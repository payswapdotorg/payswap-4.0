# Post-P9 Windows Security Hardening Backlog

> **Deferred-hardening register (round 3, 2026-11-20).** Consolidated during the
> round-3 item-2 task (W1 adversarial regression). Sequencing law from the
> round-3 handoff §5: **do not implement any of these items during P2–P9
> windows work**; they are recorded so nothing is silently dropped and none is
> promoted into current milestone acceptance criteria. The only exception is an
> actual immediate security vulnerability that makes current operation unsafe —
> that must be reported and isolated, not deferred. Each item carries explicit
> `deferred_to_post_P9` status. Canonical roadmap linkage lives in
> [10-roadmap.md](../p0/10-roadmap.md) (P2-Windows row).

## H1 — Retained-handle acquisition TOCTOU

- **Identifier:** H1.
- **Source:** `apps/zcode-cli/native/payswap-broker-peer-windows/Program.cs`,
  `ServeCustodianConnection` register arm → `RegisterGateAllows` →
  `VerifyProcessImagePath(parentPid, …)` followed by the separate
  `OpenProcess(SYNCHRONIZE | QueryLimitedInformation, parentPid)` retained-handle
  acquisition.
- **Threat scenario:** the registering parent's image is validated on one
  `OpenProcess` probe, then the retained handle is opened in a second,
  independent operation. A same-user attacker able to time process replacement
  (exit + PID reuse) between those two operations could be validated as the
  electron image and then have the retained handle reference a different,
  attacker-owned process instance.
- **Current observed behavior:** image validation and handle acquisition are
  two separate kernel operations; the race window is narrow but structurally
  present. The retained handle itself is subsequently used correctly for
  liveness (W2 discipline) — the gap is only in the identity correlation at
  acquisition time.
- **Severity / preconditions:** low-to-medium; requires precise same-user PID
  replacement timing inside the registration window; no remote path.
- **Proposed eventual mitigation:** validate the image through the SAME process
  handle that is retained (`QueryFullProcessImageName` on the retained handle)
  plus creation-time/liveness correlation, making image validation and handle
  acquisition a single atomic identity observation (pairs with H4).
- **Required tests:** a battery arm that re-registers while replacing the
  registering process between image check and handle acquisition (hard to drive
  deterministically — likely needs a service-side test seam or a
  kernel-event-driven harness); plus regression of all existing `w1:`/`f6:`
  arms.
- **Dependencies:** H4 (process identity correlation) shares the mitigation
  surface.
- **Status:** `deferred_to_post_P9`.

## H2 — W1 OS-level identity separation (AppContainer class)

- **Identifier:** H2 (the tracked closure task for the W1 race; ADR-P2-3
  §A0.5 item 2, recommendation 3).
- **Source:** `Program.cs` `RegisterGateAllows` / `IsAuthorizedCustodianParent`;
  `packages/desktop/src/main/payswap/custodianClient.ts` provisioning.
- **Threat scenario:** at service start / registered-main death, the first
  qualifying same-user electron main rebinds first-come-first-served; the
  service has no kernel-enforced way to distinguish the real desktop from an
  attacker's electron at that instant (command lines are PEB-rewritable; every
  same-user protocol proof is replayable). This is the residual the round-3
  regression pins as loud.
- **Current observed behavior:** race is real (battery `w1:attacker-wins-race-register`,
  live `attackerWon`); winning is loud (typed `custodian_unavailable` for the
  genuine desktop; diag records the rebinding pid).
- **Severity / preconditions:** medium; any model-controlled same-user process
  that wins the rebind race controls the custody channel until it exits.
- **Proposed eventual mitigation:** OS-level identity separation — AppContainer
  (or equivalent) for model-controlled agent children, with process launch,
  security identifiers and the named-pipe DACL designed **together**.
  AppContainer alone is insufficient if the model-controlled child retains
  access through the ordinary user's SID.
- **Required tests:** battery arms where a low-privileged-token child attempts
  registration and every data op (expect refusal at the pipe/DACL boundary);
  service restart + rebind recovery with separated identities; the full
  existing `w1:`/`f6:` battery must stay green.
- **Dependencies:** pipe DACL redesign; desktop launcher changes; H3 (service
  lifecycle) for restart semantics.
- **Status:** `deferred_to_post_P9`.

## H3 — Service lifecycle hardening (installed-service formal acceptance)

- **Identifier:** H3.
- **Source:** `Program.cs` `SvcRun` / `CustodianService` (OnStart/OnStop) /
  `CustodianServeLoop`; SCM interaction via `sc.exe` in `SvcInstall`/`SvcUninstall`.
- **Threat scenario:** formal lifecycle semantics of the installed SYSTEM
  service (startup ordering, SCM stop/start, registration invalidation on
  restart, blob bootstrap, concurrent restart races) are only partially
  exercised — the console battery's restart arm is a console-mode analogue, not
  a full installed-service lifecycle acceptance.
- **Current observed behavior:** P2 evidence covers service restart recovery
  (blob bootstrap 3/3) on the native machine; a formal lifecycle matrix (SCM
  stop during an in-flight connection, start-while-blob-present, double-start,
  stop-during-registration) has no permanent battery.
- **Severity / preconditions:** low (availability/consistency class rather
  than credential exposure; the gates are re-initialized on each start).
- **Proposed eventual mitigation:** permanent installed-service lifecycle
  battery (elevated harness), including registration-invalidation-on-restart
  assertions equivalent to the console `f6:service-restart-registration-cleared`
  arm, run against the real SCM service.
- **Required tests:** the lifecycle matrix above; keep console battery green.
- **Dependencies:** elevated test harness convention (the five-stage runner
  already runs elevated native stages).
- **Status:** `deferred_to_post_P9`.

## H4 — Process identity correlation (creation time / kernel-backed lineage)

- **Identifier:** H4 (round-3 handoff §5-H4).
- **Source:** `Program.cs` `GetParentProcessInfo` (TOOLHELP snapshot parent PID)
  + `VerifyProcessImagePath`; registration retained-handle acquisition.
- **Threat scenario:** PID + image-path + retained-handle liveness identify the
  registered process instance, but parent/child correlation across helper
  spawns relies on the TOOLHELP parent PID, which is subject to timing
  ambiguity (PID reuse between snapshot and use) — the same class W2 closed for
  the registered main.
- **Current observed behavior:** helper connections are gated by client image +
  parent PID + parent image; the parent PID lookup can race with PID reuse in
  principle.
- **Severity / preconditions:** low; requires same-user PID-reuse timing during
  a helper connection; the client-image gate (exact helper path) already
  narrows the surface to the genuine helper binary.
- **Proposed eventual mitigation:** carry process creation time (or a
  kernel-backed lineage token) end-to-end: parent/child correlation uses
  creation-time equality, eliminating PID timing ambiguities (pairs with H1).
- **Required tests:** battery arm with a PID-reuse race during a helper
  connection (deterministic driver needed); all existing arms stay green.
- **Dependencies:** H1 (same mitigation surface).
- **Status:** `deferred_to_post_P9`.

## H5 — Deployed binary provenance

- **Identifier:** H5 (round-3 handoff §5-H5).
- **Source:** `Program.cs` `SvcInstall` (File.Copy to protected svc-bin) /
  `SvcRun` self-check (`VerifyNoUserAccess` + exact protected location).
- **Threat scenario:** the deployed service binary is trusted because the
  install code path copies the staged binary byte-identically into an
  ACL-protected location; direct measurement of the DEPLOYED binary is not
  available to a non-elevated verifier (the svc-bin copy is SYSTEM+Admins
  ACL-denied to the user).
- **Current observed behavior:** evidence records the staged binary's SHA-256
  plus the installed code path relationship (F6/W2 evidence convention);
  the deployed copy itself is not hash-verified at runtime by the service
  beyond the location/ACL self-check.
- **Severity / preconditions:** low; requires an administrator-level attacker
  to modify the protected copy — at which point the same attacker could also
  replace the staged binary before install.
- **Proposed eventual mitigation:** service-side startup self-attestation of
  its own deployed image (e.g., digest recorded at install time in the
  SYSTEM-readable config, verified at each start and logged in the diag), so
  the deployed bytes are measured, not inferred.
- **Required tests:** battery/service-mode arm asserting start refusal when the
  deployed digest mismatches the recorded install digest; existing ACL/location
  self-check arms stay green.
- **Dependencies:** H3 (lifecycle battery harness).
- **Status:** `deferred_to_post_P9`.

## H6 — Observations recorded during round 3 (no security action required)

- **Identifier:** H6 (catch-all per handoff §5-H6).
- **Observation 1 — console-mode blob Replace (fail-closed by design):** after
  a verified push the custody blob is hardened to SYSTEM-only; a console-mode
  service (user context) cannot `File.Replace` the existing blob and surfaces
  honest `ok:false persist-failure` while create-path pushes succeed. Production
  (SYSTEM) retains FullControl, so Replace-while-exists works by design and is
  recorded on the live SYSTEM service (F6 evidence: impersonator push overwrote
  the incumbent credential). Recorded as `custodian:push-persist-failed` in the
  round-3 RED-phase diag
  (`docs/payswap/p2/evidence/custodian-w1-2026-11-20/w1-red-run-console-diag.log`).
  **Not a vulnerability** — this is the A4 storage boundary working as intended
  in the console probe seam; the permanent battery sequences pushes onto absent
  blobs and the live SYSTEM leg covers Replace-while-exists.
- **Observation 2 — custody material persistence across a won race:** the
  race winner inherits the INCUMBENT custody material (live leg records the
  winner driving a successful provider read through it) and the winner's pushed
  material persists after the winner exits until a legitimate desktop
  overwrites/purges it (battery `w1:recovery-drop-purges-attacker-material`).
  This is part of the documented W1 residual (the winner controls the custody
  channel until it exits; the blob is the custody store by design, restored
  across restarts — accepted P2 behavior), and is pinned honestly by the
  regression rather than mitigated here. Any change to it belongs with H2's
  identity-separation design.
- **Status:** `deferred_to_post_P9` (observations only; no security action).

## Round-3 findings that were NOT deferred (scope discipline note)

None. No immediate security violation was found: the loud-refusal contract
held on the original behavior (RED-phase run), the live SYSTEM-service leg
held, and no silent attacker-custody path exists. The round-3 regression,
its seams (`endpointFile`/`helperPath` options with unchanged defaults), and
the runner/CI registration are test-infrastructure only.
