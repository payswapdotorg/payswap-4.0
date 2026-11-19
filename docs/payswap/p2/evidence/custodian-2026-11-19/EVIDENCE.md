# Custodian service hardening — live evidence (2026-11-19, branch p2/acceptance-runner-fail-closed)

## Provenance

- Source head: commits `8da3129b` (native hardening) → `1bf1fe27` (TS fail-closed seam) → `014cc2c0` (bridge forwarding + A3 batteries) → this evidence commit.
- Staged helper binary: `packages/desktop/bundled-tools/win32-x64/payswap-broker-peer/payswap-broker-peer-helper.exe`
  SHA-256 `a3e4da37a859b9484bd813737e82e40ce1096fcb92f527d0cd7115558b4d1fe9` (43520+ bytes, manifest.json pairs).
- Service binary: installed copy at `C:\ProgramData\payswap\svc-bin\payswap-custodian-svc.exe`
  (File.Copy of the staged binary by `--svc-install`; dir+file ACLs SYSTEM+Administrators only,
  inheritance off; ordinary user gets EPERM reading it and the dir listing).
- Service: `PayswapCustodianSvc` WIN32_OWN_PROCESS SYSTEM demand-start; binPath points at the
  protected svc-bin copy (not the user-writable repo/app location). SvcRun self-checks image
  location + ACL at start (weakened ACL or wrong location = refuse to start).
- Stripe credential: restricted read-only test key delivered locally via
  `C:\Users\Lenovo\.payswap-live.env` (operator-approved local-secret mechanism; never in chat,
  repo, or logs).

## Root causes fixed this round (each previously masked)

1. **DPAPI P/Invoke was wrong since inception** — `CryptProtectData` was declared with a raw
   `byte[]` first parameter where crypt32 expects a pointer to a `DATA_BLOB` struct. The API
   parsed plaintext bytes as a blob header → ERROR_NOACCESS (998) on every call. Blob
   persistence NEVER worked; the old push handler caught the failure and still acked ok:true
   from memory (A4 defect "catch a blob-write error and still return success"), and the old
   console protocol test passed on memory-only custody. Fixed to the standard DATA_BLOB
   ref/out pattern (+CRYPTPROTECT_UI_FORBIDDEN, LocalFree of output blob).
2. **Secret-bearing diagnostic** — `Diag("custodian:op=" + opLine)` logged the full operation
   line (the push key included) to `C:\ProgramData\payswap\custodian-diag.log`. Removed; every
   diag line is now a stable decision fact (pid / reason / length / result code / win32 error
   code). Permanent regression: `scripts/payswap/security/custodian-service-probe.cjs` battery
   pushes a synthetic secret and asserts it appears in no diagnostic or client capture (21/21).
3. **Silent legacy fallback** — `createDesktopCustodianBridge()` returned undefined on any
   failure and the runtime silently switched to the legacy enc:v1 credential path. Replaced by
   `provisionDesktopCustodianBridge()` (explicit active/inactive+reason) and a
   `credentialCustody: "custodian-required"` runtime policy whose refusing port has no legacy
   write path at all (structural fail-closed); typed `custodian_unavailable` refusal code added
   to the shared taxonomy + connection UI i18n.
4. **Revoke never cleared custody** — the desktop assembly never forwarded `custodianBridge`
   into `createPayswapAccountService`, so the service-side `custodianBridge?.drop()` was a
   silent no-op; revocation of custodian connections left the service-held key alive. Fixed
   (bridge forwarded) and made honest: an unconfirmed custody drop is now a typed refusal on an
   already-revoked record, with idempotent re-revoke completing after recovery.
5. **Gate laxity** — `Contains("electron.exe")` registration/data gates replaced with exact
   configured-image verification via OpenProcess+QueryFullProcessImageName (kernel facts),
   registered-pid + parent-image + client-helper-image checks, PID-reuse re-verification, and a
   console-only test seam that production `--svc-run` refuses outright.
6. **Unbounded reads** — `ReadPipeLine` deadlines were advertised but not enforced (blocked
   forever inside the awaited read). All pipe reads/writes are now bounded (Task.WaitAny), and
   replies wait (bounded) for pipe drain so `Disconnect` cannot race away a reply.

## Live service-mode verification (production SYSTEM path, electron-main harness)

`C:\Users\Lenovo\payswap-live-tools\service-mode-harness.cjs` runs as electron main so the
helper client's parent image is the exact configured electron.exe (the gate's intended client).

1. Fresh install (redeploy.cmd): svc-uninstall ok → svc-install ok → service RUNNING from
   svc-bin (protected copy).
2. register → push (restricted key via stdin) → get /v1/balance → get /v1/account:
   **4/4 PASS** — balance HTTP 200 bodyLen 1199, account HTTP 200 bodyLen 1835, live Stripe
   bodies through the pipe proxy under SYSTEM (Proxy=null; TLS 1.2 explicit).
3. Blob: `C:\ProgramData\payswap\custodian-key.bin` present (326 bytes, SYSTEM-DPAPI wrapped);
   plain same-user Node `readFileSync` → **EPERM** (SYSTEM-only ACL enforced — the storage
   boundary is real, not inferred). Key material absent from diag (grep against the live key:
   clean).
4. Service restart (sc stop/start, elevated) → register → get WITHOUT re-push: **3/3 PASS** —
   diag `custodian:bootstrap-key-restored len=107`; the credential survives restarts via the
   SYSTEM blob with no decryptable copy in the ordinary user's data home.
5. Revocation: drop → ok:true → blob verifiably absent → subsequent read = status 0 "no-key"
   (typed refusal; no legacy fallback). **3/3 PASS.**

## Console-mode probe battery (permanent, CI-wirable)

`node scripts/payswap/security/custodian-service-probe.cjs` — **21/21 PASS** on this binary:
diag hygiene (synthetic secret never in diag/client capture), exact-gate rejections
(non-electron parent refused; copied helper binary refused), hostile-client deadline bounding
(silent / partial-token / oversized-line / held-open all bounded, valid client served after
each), durable push (verify-before-ack; persist-failure seam = ok:false exit 72), verified
drop, client exit-code contract (0/70/71/72).

## Known-limits (honest scope)

- The UI-driven user journey (Settings → Payment connections connect, New Task four-category
  read, revoke via UI) is tracked separately in live-acceptance-evidence.md §10.x — this file
  covers the service protocol boundary.
- The four-category Stripe data plane through the UI is exercised by the desktop E2E/stage
  runner, not by this harness.
