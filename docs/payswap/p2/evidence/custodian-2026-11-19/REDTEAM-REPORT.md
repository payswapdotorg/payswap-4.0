# PaySwap P2 Custodian — Independent Red-Team Report

- **Date**: 2026-11-19 (probe window ~16:20Z–16:40Z)
- **Reviewer**: Worker 2 (independent; did not implement)
- **Target**: live SYSTEM service `PayswapCustodianSvc` (Running), pipe `\\.\pipe\payswap-custodian-v1`, binary `C:\ProgramData\payswap\svc-bin\payswap-custodian-svc.exe` (LocalSystem, demand start), source branch `p2/acceptance-runner-fail-closed`
- **Method**: adversarial live probes (all scripts under `C:\Users\Lenovo\payswap-live-tools\redteam\`, none inside the repo) + code-level seam review
- **Integrity note**: no synthetic key was ever accepted by the service during this exercise (no `push-ok` in the probe window; only an external actor's `push-shape-invalid len=56`, refused). Blob `custodian-key.bin` mtime unchanged (2026-11-19T16:16:16Z) across the whole exercise. Live key remains in service memory; Stripe control GET through the authorized chain returned 200 at the end.

---

## 1. Result table

| # | Probe | Expected | Actual | Verdict |
|---|-------|----------|--------|---------|
| 1a | Read `C:\ProgramData\payswap\custodian-key.bin` | EPERM | EPERM (file exists; stat/open denied; MSYS `cat` shows ENOENT due to stat-failure tooling artifact — node `readdir` sees the entry) | PASS |
| 1b | Read `custodian-config.json` | EPERM | EPERM; even ACL read (Get-Acl) denied | PASS |
| 1c | Read `custodian-endpoint.json` | readable by design | readable: pipe + 64-hex current handshake token exposed to any same-user process | BY-DESIGN (noted exposure) |
| 1d | List/read `svc-bin`, service image | deny | EPERM on listing and on image read; Get-Acl denied (no ReadControl) | PASS |
| 1e | Scan dev-data home `C:\Users\Lenovo\payswap-dev-data\.zcode\v2` for fresh enc:v1 PSP slots | none fresh from custodian path | 2 enc:v1 PSP slots exist but belong to records created 2026-11-18T21:04Z/21:12Z (pre-custodian-service era, custodian era starts 16:04Z Nov 19); the two currently-`connected` records have NO slot | PASS (residue, not fresh) — see F8 |
| 1f | Same-user unwrap chain of residue (Local State os_crypt key → DPAPI → AES-GCM → KEK → slots) | — | KEK blob is Chromium `v10` safeStorage format; its os_crypt key not present in any available `Local State` (8 profiles tried) → residue not decryptable with on-machine material | INCONCLUSIVE→LOW (F8) |
| 1g | `%APPDATA%\zcode` scan | no PSP slots | 0 enc:v1 files | PASS |
| 2a | Register via node-parent helper (exact helper image, parent=node) | EOF, exit 70, register-gate-reject | exit 70, `custodian_client:gate-refused`, stdout empty; diag `register-gate-reject` family | PASS |
| 2b | Register via copied helper at different path | EOF, exit 70, client-image-reject | exit 70, EOF; diag `client-image-reject` | PASS |
| 2c | Register via renamed copy | EOF, exit 70 | exit 70, EOF; diag `client-image-reject` | PASS |
| 2d | get /v1/balance via node-parent (never registered) | EOF, exit 70 | exit 70, EOF | PASS |
| 3a | push synthetic 107-char key via node-parent | EOF, exit 70 (no contamination) | exit 70, EOF; no `push-ok` | PASS |
| 3b | push synthetic via copied helper | EOF, exit 70 | exit 70, EOF | PASS |
| 3c | drop via node-parent | EOF, exit 70 | exit 70, EOF | PASS |
| 3d | get/push/drop via node-parent with stale registration in place (legit harness register first, electron exited) | EOF, exit 70 (parent≠registered pid) | exit 70, EOF, all three ops | PASS |
| 4a | Raw pipe: garbage token | silent EOF, no reply | EOF in 48 ms, 0 bytes; diag `token-mismatch` | PASS |
| 4b | Raw pipe: real token + malformed op line | silent EOF | EOF in 150 ms; diag `op-unreadable` | PASS |
| 4c | Raw pipe: real token + get path escapes (`/v1/tokens`, `/v1/balance/extra`, `/v1/balance/../v1/charges`, `/v1/balance?x=/v1/tokens`) | silent EOF | all EOF in 46–171 ms (image gate fires before path check for raw clients) | PASS |
| 4c-auth | Authorized-chain path escape (fresh electron register; hostile paths through the real helper): `/v1/tokens`, `/v1/balance/extra`, `/v1/balance/../v1/charges` | EOF/70 (server-side `get-path-not-allowed`) | exit 70 EOF on all; diag `get-path-not-allowed` ×3 | PASS |
| 4c-auth2 | Authorized-chain control: `/v1/balance` | allowed (200) | 200, real Stripe body (bodyLen=1199 in diag; no key material) | PASS (control) |
| 4c-auth3 | Authorized-chain: `/v1/balance?x=/v1/tokens` | allowed prefix, query forwarded | exit 0, Stripe 400 on bogus param — `?`-split is by design; no path traversal, no key exposure | PASS (info: query strings are forwarded on allowed endpoints) |
| 4d | Real token + get + destroy immediately (non-electron parent) | no data | 0 bytes | PASS |
| 4e | Raw pipe: op=push with synthetic key | image-gate EOF | EOF in 150 ms; no `push-ok` | PASS |
| 4f | Token line with surrounding whitespace/CRLF | normalized (Trim) then waits for op | held until op deadline, silent EOF | PASS (info) |
| 5a | Hostile: partial-token hold 5.5 s | no reply | 0 bytes, held | PASS |
| 5b | Hostile: real token + partial-op hold 8.5 s | no reply | 0 bytes, held | PASS |
| 5c | Hostile: oversized op line (40 KB) | disconnect at line cap | 0 bytes | PASS |
| 5d | Liveness after DoS | legit harness register succeeds | register PASS (HARNESS-SUMMARY 1/1) ~1 s later | PASS |
| 6 | Secret scan: live key value vs diag + endpoint + all redteam files (16 files) | 0 hits | 0 hits; diag contains zero `sk_test`/`sk_live`/`rk_test`/`Bearer` occurrences | PASS |
| 7 | Storage boundary ACLs | no user-writable route to SYSTEM execution | see §4 | PASS |
| 8 | Fail-closed seam review (code) | no legacy fallback on win32; gate-refusal never mistaken for success | no fallback path exists; one error-taxonomy wart (F3) | PASS with LOW finding |

**Overall: 0 FAIL. All expected refusals held. Boundary intact.**

---

## 2. Probe reproduction commands (sanitized)

All scripts in `C:\Users\Lenovo\payswap-live-tools\redteam\` (p1-storage.cjs, p1c-unwrap.cjs, p1d-v10.cjs, p2-register.cjs, p3-stale.cjs, p4-pipe.cjs, p4c-allowlist.cjs, p5-dos.cjs, p6-scan.cjs). Representative commands:

```
node p2-register.cjs
electron.exe service-mode-harness.cjs <helper> - register
node p3-stale.cjs            # immediately after the register above
node p4-pipe.cjs             # raw pipe sessions against \\.\pipe\payswap-custodian-v1
MSYS2_ARG_CONV_EXCL='*' electron.exe p4c-allowlist.cjs "/v1/tokens" "/v1/balance/extra" "/v1/balance?x=/v1/tokens" "/v1/balance"
node p5-dos.cjs
node p6-scan.cjs
```

Gotcha worth keeping: Git Bash rewrites leading-slash args (`/v1/tokens` → `C:/Program Files/Git/v1/tokens`) — first p4c run therefore tested a *different* non-allowlisted path (also refused); re-run with `MSYS2_ARG_CONV_EXCL='*'` for exact paths.

---

## 3. Diag evidence (A2-sanitized; probe window)

```
client-image-reject pid=...   (copies/renamed helper + raw node clients)
op-unreadable pid=...         (malformed / oversized op lines)
token-mismatch pid=...        (garbage token)
get-path-not-allowed          (authorized-chain hostile paths, parent=electron)
register-rebind parent=...    (every fresh electron harness register)
get-status=400 / get-status=200 bodyLen=1199  (allowed-path controls)
push-shape-invalid len=56     (external actor during window — refused, not mine)
```

No token/op-line/key material appears in diag at any point (verified by read + pattern scan).

---

## 4. Storage boundary / ACL findings

- Service: `BINARY_PATH_NAME = C:\ProgramData\payswap\svc-bin\payswap-custodian-svc.exe --svc-run --image <repo>\node_modules\electron\dist\electron.exe`, `SERVICE_START_NAME = LocalSystem`. The service *executes* only the protected svc-bin image; the `--image` argument is only a gate string (see F6).
- `custodian-config.json`, `custodian-key.bin`, `svc-bin\` (and the image inside): read AND ReadControl denied to my user (`Get-Acl` → "Attempted to perform an unauthorized operation"). Stronger than required.
- `custodian-endpoint.json` SDDL: `O:<user> D:PAI (A;;FA;;;SY)(A;;0x12019f;;;<user>)` — SYSTEM full + user RW. By design (desktop main must read pipe+token). Any same-user process therefore holds the current handshake token; the real gates are image/parent/pid (kernel facts), so token possession alone grants nothing (verified 4a–4e).
- `custodian-diag.log`: user-readable by design; content verified sanitized.
- `C:\ProgramData\payswap` dir inherits ProgramData defaults (owner=user; Users can create files in ProgramData dirs) — but every sensitive child is individually hardened, and no ACL observed lets a user alter svc-bin, config, blob, or the service command line. No user-writable path leads to SYSTEM executing attacker content (the service does not execute anything from user-writable locations).

---

## 5. Code-level findings (file:line)

- **F3 (LOW, error taxonomy, fail-closed direction preserved)** — `packages/desktop/src/main/payswap/custodianClient.ts:69`: `exitCode: result.status ?? (result.error ? 1 : 0)`. A 45 s spawnSync timeout or spawn failure surfaces as exitCode `1`, which is outside the `{70,71,72}` set checked at `custodianClient.ts:168` (push) and `194-206` (drop), so control falls to `parseReply("")` at `custodianClient.ts:173/201` → generic `Error("custodian: malformed reply...")` (`custodianClient.ts:82`) instead of typed `custodian_unavailable`. Downstream, `accountService.ts:281-290` maps only the two typed error families to refusals and rethrows anything else — so a connect during a helper timeout yields a channel-level internal error rather than the typed `custodian_unavailable` refusal the UI branches on. No legacy fallback anywhere; purely taxonomy. Recommend treating any non-zero/non-ok helper outcome as `custodian_unavailable`.
- **F5 (LOW, defense-in-depth note)** — `packages/services/src/payswap/runtime.ts:148-163`: the custodian apiClient wrapper routes only when the Authorization header ends with the `custodian-managed` marker; anything else falls back to direct `fetch`. On the win32 custodian path this fallback can never carry a real key because `load()` is the marker (`runtime.ts:130`) or typed-refuses (`runtime.ts:137`). However `accountWarmup.ts:50-56` still unwraps the legacy safeStorage keyStore into the main-process env view on every rebuild even on win32 — harmless today (nothing consumes it for custodian connections) but it is the only remaining code path that puts a PSP-format key into main-process memory; consider skipping legacy warmup when `credentialCustody === "custodian-required"`.
- **F4 (INFO)** — `custodianClient.ts:105-118` (`executeDataOp`): exit 70 triggers exactly one register+retry; gates are re-verified server-side on both legs (no relaxation). `custodianClient.ts:186-190` maps any get failure to `{status:0}` → `runtime.ts:160` 502 → adapter typed unavailable: a gate-refused op can never be mistaken for success (verified against helper exit-code contract in `Program.cs:1961-2072`).
- **F6 (MEDIUM as a *design boundary*, accepted)** — gates verify image *path* equality via `VerifyProcessImagePath` (`Program.cs:740`, used at `1456-1460/1464-1470/1475-1482`), not signature or hash. The configured electron image lives in the user-writable repo tree; any same-user process can spawn that exact image with arbitrary code (harness-equivalent) and pass register+data gates, and can also read the endpoint token. The custodian threat model is cross-user/other-process protection of the key at rest + bounded proxying — not defense against a determined same-user attacker (who already controls the user session and could DPAPI-decrypt user-scope secrets). Diag shows repeated `register-rebind` from different electron pids (19188/16120/7800/18904/9540/17428/2308): the registered main is *any* electron-parented tree, not a pinned app instance. Acceptable per ADR, but the TL should state it explicitly in the merge note.
- **F7 (INFO)** — push shape rule (`Program.cs:1444-1452`) accepts any 64..512 printable ASCII as a "key" (no Stripe prefix check server-side); shape validation of Stripe format happens client-side (`derivePayswapSecretKeyMode`). Data-quality only; no security impact (observed an external `push-shape-invalid len=56` correctly refused during the window).
- **F10 (LOW, DoS surface)** — pipe server is single-instance sequential (`Program.cs:1428-1436`, `maxNumberOfServerInstances:1`): a hostile loop of connect-and-hold clients can starve legitimate clients indefinitely (each hostile connection is bounded: 5 s token + 8 s op + 5 s drain ≈ ≤18 s, but back-to-back = continuous denial). Local-only pipe and a same-user attacker already owns the box, hence LOW. My bounded probe (≤25 s total) was followed by an immediate successful legit register.
- **F8 (LOW, at-rest residue, operator action suggested)** — `C:\Users\Lenovo\payswap-dev-data\.zcode\v2\credentials.json` retains two enc:v1 PSP slots for connections created 2026-11-18T21:04Z (`expired`) and 21:12Z (`revoked` at 23:59:46Z) — both pre-date the custodian-service era (first `svc-start` in diag 2026-11-19T16:04:21Z). The two currently-`connected` records (b61a51a6, 23b8e4f5) have **no** enc:v1 slot — no fresh custodian-path legacy write exists, which is the normative check and it PASSES. The KEK file (`payswap-psp-safe-storage-key`, 95 B) is a Chromium `v10` safeStorage blob; its os_crypt AES key was not recoverable from any of the 8 available `Local State` profiles (DPAPI unwrap succeeded on each key; GCM auth against the KEK failed on all) → residue is not decryptable with on-machine material. Recommend the TL (who has elevation) purge the residue for hygiene.

---

## 6. Secret-scan result

- Scanned: `custodian-diag.log`, `custodian-endpoint.json`, endpoint/config/key.bin (2 unreadable/denied = boundary artifacts), all files under `C:\Users\Lenovo\payswap-live-tools\redteam\` (scripts + helper copies + result JSON). 16 targets.
- Live key value (`ZCODE_E2E_STRIPE_LIVE_KEY`): **0 hits**. Diag pattern scan: `sk_test=0 sk_live=0 rk_test=0 bearer=0`.
- VERDICT: PASS — the key never appears in any artifact I produced or in the service diag.

---

## 7. Residual risks / recommendations for the TL before merge

1. **State the same-user boundary explicitly (F6).** The gate chain (image-path equality + parent pid + alive-check) defends the key from other users, from non-electron trees, and from casual same-user processes, but a deliberate same-user process can spawn the repo's own electron image and impersonate the genuine client. This is inherent to the threat model; document it in the ADR merge note so it is a decision, not an oversight.
2. **Endpoint token exposure is by design but worth one sentence in evidence** — any same-user process holds the current pipe+token; all real authorization is kernel-fact-based (verified: token possession alone yields nothing).
3. **Helper timeout → generic error instead of typed refusal (F3)** — small fix in `custodianClient.ts` (map any spawn error/timeout/exit 1 to `custodian_unavailable`) to keep the UI's typed refusal contract airtight.
4. **Skip legacy warmup under custodian-required (F5)** — removes the last code path that materializes a PSP-format key in main-process memory on win32.
5. **Purge pre-custodian enc:v1 residue (F8)** — operator/elevated action outside this review's scope.
6. **Single-instance pipe starvation (F10)** — acceptable for now; note it.
7. **Concurrency note** — an external actor (acceptance runner/TL) rebind-registered and attempted a 56-char push at 16:37:32Z during my window; the shape gate refused it and no state changed. Multiple concurrent testers rebinding `registeredMainPid` is normal behavior but means "registered" is whoever registered last.

## 8. Artifacts

- Probe scripts + evidence JSON: `C:\Users\Lenovo\payswap-live-tools\redteam\` (p1-storage.cjs, p1c-unwrap.cjs, p1d-v10.cjs, p2-register.cjs, p3-stale.cjs, p4-pipe.cjs, p4c-allowlist.cjs, p5-dos.cjs, p6-scan.cjs, p1-result.json, helper-copy.exe, renamed-helper.exe — all created by this review; repo untouched; service state untouched).
