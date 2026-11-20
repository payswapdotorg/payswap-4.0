# W1 First-Alive Registration Race — Round 3 Item 2 Evidence (2026-11-20)

**Milestone:** P2-Windows (already `complete` — this round adds the permanent
adversarial regression for the documented residual W1 race; it does NOT reopen
P2-Windows and does NOT claim W1 is closed).
**Base head:** `2d5905c4` (PR #51 merge; P2-Windows row round-2 amendment `6baff865`).
**Task:** Windows custodian security round 3, item 2 — permanent adversarial
regression proving the residual first-alive registration race is **loud**:
when an attacker wins the rebind race after the legitimate desktop main dies,
the genuine desktop receives an explicit typed failure (`custodian_unavailable`
vocabulary) and never silently uses the attacker's custody channel.

## 1. Deliverables

| Deliverable | Path | Nature |
|---|---|---|
| Permanent battery leg (26 `w1:` checks; battery 54 total) | `scripts/payswap/security/custodian-service-probe.cjs` (`batteryRegistrationRaceW1`) | Synthetic, console-mode, private pipe/endpoint/blob/diag paths; production gates (no test seam); native Windows |
| Desktop typed-refusal law (8 vitest cases) | `packages/desktop/test/payswap-custodian-provisioning-fail-closed.test.ts` | CI-canonical (`engineering` project; registered in ci.yml P2 battery + the P2 runner vitest list) |
| Test seams (defaults unchanged) | `packages/desktop/src/main/payswap/custodianClient.ts` | `endpointFile` / `helperPath` options alongside the existing `runClient` seam — same discipline as the helper client's own `--endpoint-file` console seam; production behavior identical |
| Live installed-SYSTEM-service leg | `w1-live-registration-race-test.cjs` + `w1-live-result.json` (this directory) | Non-destructive: read-only Stripe gets + refused ops only; custody blob/memory never written |
| Runner + CI registration | `scripts/payswap/windows/run-p2-acceptance.cjs` (battery label 28→54 checks; vitest list 13→14 suites), `.github/workflows/ci.yml` (P2 battery list) | Gates kept in sync |

## 2. RED phase — regression run against the original behavior

The regression (battery leg) was written and executed **before any production
change**; production code on the base head was left untouched throughout
(§3.1 of the round-3 handoff: do not modify production merely to make the test
pass).

**Output:** `w1-battery-red-run-original-behavior.log` — `50/53 checks passed`.

All loud-refusal legs **passed on the original behavior**: attacker-wins honesty,
genuine desktop refused on all four custody ops (exit 70, EOF, empty stdout),
no attacker canary transfer, diag rebinding-pid record, recovery. The three
FAILs were a console-seam discovery, **not** a production security failure:

- `w1:attacker-push-controls-custody` (exit 72) / `w1:recovery-push-replaces-attacker-material` (exit 72) /
  `w1:attacker-repush-restores-canary` (diag count).

**Finding (console-mode-only):** the A4 storage boundary hardens the custody
blob to SYSTEM-only after every verified push — correct fail-closed behavior —
so a console-mode service (running as the user, not SYSTEM) can never
`File.Replace` an existing blob; push-while-exists surfaces as the honest
`ok:false persist-failure` (`custodian:push-persist-failed` in
`w1-red-run-console-diag.log`, exactly at the Replace calls). Create-path pushes
always succeed. On the production SYSTEM service the blob ACL grants SYSTEM
FullControl, so Replace-while-exists works by design (and is recorded live on
the SYSTEM service by the F6 evidence: the impersonator's push overwrote the
incumbent credential). **No silent attacker custody use occurred; no
production change was made to satisfy the regression.** The battery was
re-sequenced so every push targets an absent blob (create path), with the
Replace-while-exists arm delegated to the live SYSTEM-service evidence.

## 3. GREEN phase — final battery (54/54)

**Output:** `w1-battery-green-run-54of54.log` — `54/54 checks passed`, exit 0
(28 pre-existing checks unchanged — F6/W2/A2/A4 coverage still green — plus 26
new `w1:` checks). Native Windows environment: Windows 11 26200 x64, repo
electron image `node_modules/electron/dist/electron.exe`, staged helper
`payswap-broker-peer-helper.exe` sha256 `92df7318…` (rebuilt from base-head
`Program.cs` by the prepare script; functionally identical to the deployed
`c670f706…` W2 build — same source, fresh compiler MVID).

### Battery legs (the frozen test contract)

**A — genuine registration + four-op channel (pre-attack):** genuine electron
main registers (`exit=0`), get answers `no-key` (deterministic), push acks
`ok:true` after verified persistence (`custodian:push-ok len=69`), drop acks
`ok:true` with the blob verifiably gone.

**B — genuine termination:** non-electron probe register refused by the ALIVE
gate while the genuine main lives (`custodian:register-alive-exists
registered=<genuinePid>`), and after termination refused by the IMAGE gate
instead (alive-exists count unchanged) — the registered-main-alive state
transition is observable.

**C — attacker wins the documented race (recorded honestly):** attacker
electron main (same configured image, attacker-controlled entry) registers
`ok:true` (`custodian:register-rebind parent=<attackerPid>` in the diag — the
ADR's "diag records the rebinding pid"), then drives the channel (get `no-key`
honest state, push/drop/re-push control of custody with its length-78 canary —
`push-ok len=78` ×2).

**D — the arriving genuine desktop is refused LOUDLY (the core contract):**
fresh genuine main: register **exit 70 + empty stdout**, push **exit 70 +
empty stdout**, get **exit 70 + empty stdout**, drop **exit 70 + empty stdout**.
Exit 70 EOF is the exact service boundary `custodianClient.ts` maps to
inactive `register-refused` provisioning → typed `custodian_unavailable`.
Diag: `register-alive-exists registered=<attackerPid>` (refusal BECAUSE the
attacker holds the registration — visible, not silent) and 3 ×
`data-gate-reject parent=<genuinePid>` (kernel facts, not transport
accidents). The attacker canary is absent from every genuine-side capture.

**E — documented recovery:** attacker terminated → fresh genuine main
registers `ok:true` (`register-rebind parent=<recoveryPid>`), purge-drop of the
attacker's leftover material acks `ok:true` (subsequent create-path push proves
the blob was gone), get answers `no-key` (deterministic), push restores GENUINE
custody material (`push-ok len=74`, blob present). Old registration state
discarded; no canary material anywhere in genuine captures or diag lines.

## 4. Live installed-SYSTEM-service leg

**Script/result:** `w1-live-registration-race-test.cjs` / `w1-live-result.json`
(non-destructive law: attacker push/drop deliberately omitted live; custody
never written; no restore needed).

| Step | Result |
|---|---|
| Service identity | `C:\ProgramData\payswap\svc-bin\payswap-custodian-svc.exe --svc-run --image <repo electron.exe>` (sc qc); staged sha `92DF7318…`; deployed byte-identical by the install code path |
| G1 genuine main | register `exit=0`; get /v1/balance `exit=0` **stripeStatus=200** (the documented positive read-only check through the live restricted key) |
| G1 terminated → retained handle signals | (attacker's rebind success is the observable) |
| Attacker (same image, malicious entry) | **WON the rebind race** (`register exit=0`) — recorded honestly; get through the INCUMBENT material `exit=0` **stripeStatus=200** (worst-case residual; key material never read by the script) |
| G2 genuine recovery attempt (attacker holds) | register **70** / push **70** / get **70** / drop **70** — all with empty stdout (EOF, no reply bytes) |
| Attacker terminated → G3 fresh genuine main | register `exit=0` (rebind); get `exit=0` **stripeStatus=200** — documented recovery works |
| Verdict | **W1 LOUD-REFUSAL CONTRACT HOLDS (race real + honest, genuine refused typed, recovery works)** |

## 5. Desktop typed-refusal law (CI-canonical vitest)

`packages/desktop/test/payswap-custodian-provisioning-fail-closed.test.ts` —
8/8 PASS (`vitest run --project engineering`). Drives the REAL
`provisionDesktopCustodianBridge` (fake `runClient`/endpoint/helper seams;
production mapping code verbatim): register exit 70 → inactive
`register-refused` with no bridge; explicit inactive vocabulary
(endpoint-absent / service-unreachable); data ops exit 70 → exactly one
full-gate re-register retry → typed `custodian_unavailable` (push/drop throw
with `code === "custodian_unavailable"`; get returns `{status: 0, body:
"custodian-unavailable"}`); recovery (re-register succeeds after the attacker
exits → op retried exactly once, succeeds); exit-72 unconfirmed outcomes typed,
never faked; secret only ever travels via stdin (argv scanned negative).

## 6. Honest boundary (unchanged and re-asserted)

- **W1 remains OPEN by design.** The regression pins the documented
  loud-refusal behavior; the race itself is closed only by the deferred
  OS-level identity separation (AppContainer-class, Post-P9 backlog H2).
- Winning the race carries real residual capability (recorded, not hidden):
  the winner can read/replace/destroy custody until it exits (live leg records
  the winner USING the incumbent credential; battery records push/drop
  control synthetically).
- Console-mode A4 blob ACL behavior (RED-phase finding) is fail-closed by
  design; documented in §2 — recorded as an observation, not a security
  backlog item.
- P2-Windows acceptance is untouched: no status change, no gate weakening, no
  second credential service, no Stripe writes, no live-money operations.

## 7. Reproduction

```powershell
# battery (native Windows, ~2-4 min): 54 checks incl. 26 w1: checks
node scripts/payswap/security/custodian-service-probe.cjs
# desktop typed-refusal law
pnpm exec vitest run --project engineering packages/desktop/test/payswap-custodian-provisioning-fail-closed.test.ts
# live leg (native machine with the installed service; non-destructive)
node docs/payswap/p2/evidence/custodian-w1-2026-11-20/w1-live-registration-race-test.cjs
```

## 8. Manifest

SHA-256 of every file in this directory: `MANIFEST-sha256.txt`.
