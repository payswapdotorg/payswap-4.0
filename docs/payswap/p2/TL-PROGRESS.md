# TL progress log — P2 closure on native Windows (live note, 2026-11-17)

> **Continuity note for any agent picking this up.** Working state of the P2
> closure mission. Branch: `p2/acceptance-runner-fail-closed` (pushed, contains
> everything needed); main-checkout local branch `p2/acceptance-run-tl` tracks
> it and is the acceptance-run checkout (has node_modules).

## Done

1. **Native Windows env verified**: win32 10.0.26200.9974, interactive Console
   session, no WSL, Node 24.14.0, pnpm 10.33.2, git 2.56.0, 345 GB free.
2. **Preflight win32 fixes** (`66255b26`, branch `p2/preflight-win32-invocation`,
   merged into the runner branch):
   - pnpm is a `.cmd` shim — `execFile` (CreateProcess) can never resolve it →
     shell-spawn fix (same pattern as the runner's execStep).
   - Stripe probes moved off `fetch`/undici onto explicit-teardown `https` —
     undici's keep-alive pool + `process.exit` aborted with
     `UV_HANDLE_CLOSING` (exit 127 / 0xC0000409 + stderr pollution), which the
     runner would have consumed as "preflight unparsable".
3. **Runner fail-closed hardening** (`915242dc`, the three architect-review
   defects + tests + CI wiring + docs). 24-case regression matrix
   (`scripts/payswap/windows/run-p2-acceptance.test.mjs`, all green; wired into
   `payswap-roadmap.yml`).
4. **Stage 1 `windows-build` GREEN**: `pnpm install --frozen-lockfile` exit 0;
   `pnpm build:bootstrap` exit 0 (same machine, same checkout lineage).
5. **Stripe readiness (the historical blocker is GONE)**:
   - Account `acct_1FPs7UAkPdhgtN6I` ("Cattyz") is **activated** — it is a
     live account (has pk_live/sk_live), Payments capability **Active**. The 2
     past-due tasks (business details, W8/W9 tax residency) impact **payouts
     only**, not reads. No email-verification banner.
   - Created restricted key **"PaySwap P2 read-only acceptance"** (rk_test_*)
     via the dashboard in test mode, Read on Core/Accounts(+Connect),
     Balance-family, Charges and Refunds, Customers, Payment Disputes. Balance/
     Customers/Disputes reads are auto-locked-selected (implied by Core read).
   - **The key never entered chat**: it was captured from the reveal dialog in
     the browser kernel and written directly to `C:\Users\Lenovo\.payswap-live.env`
     (mode 600 + icacls /inheritance:r /grant:r "Lenovo:R").
   - Authorized read-back probe: `GET /v1/balance -> HTTP 200, object=balance,
     livemode=false`. **All five acceptance stages are [EXEC] in preflight.**

## In flight

- Full five-stage acceptance run (background): `run-p2-acceptance.cjs` with the
  key env-loaded. Expected honest outcome: stages 1-3 PASS, stripe-live
  PASS-or-BOUNDARY, conversation-acceptance MANUAL-PENDING (checklist emitted)
  → exit 2 until the interactive half is done.

## Remaining

1. Stage 5 interactive New Task walkthrough (13 steps) with the real desktop app
   (`pnpm dev:desktop:prod` or installed package), evidence file per checklist.
2. Final zero-assumption five-stage run with `--manual-evidence` → exit 0.
3. Evidence register update (`docs/payswap/p2/live-acceptance-evidence.md` §7+),
   sanitization + SHA-256 manifest, roadmap P2 row move (TL, at merge).
4. Independent review of `915242dc` before merging PR #46 (security-sensitive).

## Gotchas recorded

- husky pre-push needs `ZCODE_PRE_PUSH_BASE=origin/main` (script strictly
  requires `origin/staging`, which does not exist on this remote).
- node REPL/browser: the Stripe dashboard's permission table renders rows
  whose labels are outside the segmented control's ancestor chain — position-
  matching clicks (label y ↔ option y) are the reliable setter.
- The IAB controlled tab can vanish between calls; re-claim via
  `agent.browsers.open(url)` on the same URL.


---

# TL progress log — P2-Linux closure on the TL Linux sandbox (2026-11-17, evening)

> Continuity note for the Linux leg. Branch: `p2/acceptance-runner-fail-closed`
> (the same branch as the Windows work; merge `57669794` brings the E2B-side
> `p2/vm-scripts-repo-root` fixes onto it). This sandbox IS a real Linux
> environment (Debian 13, 4GiB cgroup, 2 vCPU) with a prefix-installed desktop
> stack (`/home/z/my-project/linux-stack`: gnome-keyring + libsecret + p11-kit +
> dbus from local debs) — the Linux desktop acceptance leg runs in-place.

## Done (Linux leg, 2026-11-17)

1. **Branch recovery + E2B-fix merge**: sandbox recycle lost the prior checkout;
   re-cloned from origin and merged `p2/vm-scripts-repo-root` (6 commits:
   REPO_ROOT derivation, hoisted electron resolution, Xvfb lifetime, DISPLAY
   export) — merge commit `57669794`.
2. **linux-build GREEN** (real chain, memory-constrained form):
   `pnpm install --frozen-lockfile` (exit 0, 1m39s) + e2e-report build:node +
   `pnpm --filter @zcode/desktop... run build` (exit 0, ~4min). The full
   workspace bootstrap (`pnpm build:bootstrap` incl. packages/web) OOMs in the
   4GiB cgroup — vite chunk rendering with hidden sourcemaps peaks >3.3GiB
   native RSS (measured SIGKILL at anon-rss 3347MB, heap cap irrelevant —
   sourcemap merging is native memory). Delivered
   `ZCODE_DESKTOP_BUILD_SOURCEMAPS=off` (commit `1bd675dd`) — env-gated knob,
   E2E/acceptance face only; production packaging face unchanged.
3. **Display-leg self-verification GREEN**: Xvfb :99 + dbus-run-session +
   gnome-keyring (`org.freedesktop.secrets` on the session bus, attempt 2) +
   real Electron 44.7.0 probe: `backendSelected=gnome_libsecret,
   isEncryptionAvailable=true, roundTrip=ok`.
4. **Linux acceptance face DELIVERED** (this branch): preflight linux stage
   derivation (`linux-leg-stack` check + linux-build/linux-secure-storage/
   linux-desktop-e2e derivations; stripe-live & conversation-acceptance shared
   ids per platform), `scripts/payswap/linux/` (leg-stack.cjs / leg-session.sh /
   run-p2-acceptance.cjs + 14-case regression matrix), shared verdict law module
   `scripts/payswap/acceptance-verdicts.cjs` (windows runner refactored onto it,
   its 24-case matrix stays green).
5. **Canonical five-stage run (TL sandbox, leg-stack prefix form)**:
   linux-build **PASS** / linux-secure-storage **PASS** (probe + 13 suites
   129/129 + platform gate 12/12) / linux-desktop-e2e **PASS**
   (payswap-connection-ui 7/7, first-time pass 100% — the four storage arms on
   the real gnome_libsecret backend) / stripe-live **SKIP** (no
   ZCODE_E2E_STRIPE_LIVE_KEY in this environment — chat transcripts are not a
   valid secret channel) / conversation-acceptance **SKIP** → **exit 2** (a
   skip is never a pass). Sanitized artifacts + SHA-256 manifest under
   `artifacts/p2-acceptance-linux/`.
6. **Milestone decomposition landed** (roadmap surgery, script kept at
   `scripts/payswap/linux/milestone-split-surgery.py`): P2 row split into
   P2-Linux + P2-Windows; validator REQUIRED_MILESTONES + playbook updated;
   validate-roadmap + its test green.
7. **Post-recycle zero-assumption re-run GREEN** (2026-11-17T18:25:49Z, HEAD
   `80c42ba1` = the merge candidate face): after full process reaping between
   sessions the leg rebuilt in-place — verdicts identical to §8 (build PASS /
   storage PASS 129/129 + probe gnome_libsecret / e2e PASS 7/7 / the two
   operator-gated stages honest SKIP), manifest 8/8 OK, ~5.6 min. Registered
   as live-acceptance-evidence §8.5. PR #46 defect verification re-confirmed
   on this face: 915242dc covers RedactingLog cross-chunk carry, 13-step
   evidence strictness, preflight fail-closed; the Linux runner consumes the
   same platform-neutral modules (runner-redaction.cjs / manual-evidence.cjs /
   acceptance-verdicts.cjs).
8. **Exit-hygiene observation CLOSED (runner exonerated, 2026-11-17 late)**:
   the §8.5 first-draft "lingering child handle" suspicion was corrected after
   four controlled stage re-runs (both output forms) + one instrumented
   zero-assumption full run (timeline + process snapshot to files): the runner
   exits cleanly in every form (335s, rc=2, zero survivors, shell completes);
   the stall lives in the TL sandbox tool-harness layer (large-volume direct-
   pipe EOF), not the runner. Documented form (file redirection) unaffected.
9. **Second recycle, worse mode — wipe→bundle-restore→full run GREEN**
   (2026-11-17T19:15:25Z): the next sandbox recycle emptied the repo working
   tree entirely; branch restored from the delivered bundle at `5bdd6900`,
   cold `pnpm install --frozen-lockfile` 58.7s, full zero-assumption run all
   green again (3 PASS + 2 honest SKIP, manifest 8/8) — the delivered bundle's
   restorability is now proven by execution, registered in §8.5.
10. **Independent security review of 915242dc DONE — 2 findings, both fixed
    in-branch** (record: `docs/payswap/p2/security-review-915242dc.md`;
    probes in-repo: `scripts/payswap/security-review-915242dc.probes.mjs`).
    F1 (high): manual-evidence attestation hard-coded the winver `10.0.<build>`
    form → a Linux-leg 13-step receipt could NEVER pass (and the linux-leg
    checklist template pointed at the windows runner with backslashes) —
    fixed by platform-parameterizing manual-evidence.cjs (default win32 = the
    windows-matrix contract; linux runner passes "linux": kernel-version
    platform + Windows-string rejection; legs not interchangeable). F2
    (medium): Operator/Date-time emptiness checks still used the `\s*\S`
    cross-line borrow (the exact defect class 915242dc-B fixed for Observed)
    plus a Date/time alternation-order slip — fixed with `[ \t]` scoping +
    longest-alternative-first. The redaction engine itself held under all
    2036 adversarial probes (every split boundary, byte-by-byte, fuzz,
    self-overlap) — no findings. After fixes: windows matrix 25/25, linux
    matrix 19/19, probes 2052/2052 blocked, 0 new lint warnings on changed
    files. Review no longer blocks the PR #46 merge.

## Remaining (P2-Linux closure) — operator-controlled, precisely identified

1. **Restricted key supply** for `acct_1UblugEz3o7yd7Uo` (or the activated
   `ekontetevi+p2acceptance@gmail.com` account): the key (`rk_test_*`, name
   `payswap-p2-live-ro`, created 2026-11-16) lives in
   `~/.payswap-keys.env` **on the Windows operator machine**. The TL sandbox has
   no key and no valid secret channel (chat = transcript). Action: run the two
   Stripe stages either on the operator machine (E2B driver §4.1 / windows
   runner) or deliver the key to a chosen Linux acceptance machine via a 0600
   env file.
2. **Account onboarding completion**: email verified ✓; wizard stopped at 3/5
   (2FA authenticator). `/v1/account` has no `requirements` object until the
   identity section completes → detail read-back stays the typed
   `read_back_unavailable` refusal (lawful, not a defect). Action: finish 2FA +
   steps 4-5, then verify
   `curl -s -u "$KEY:" https://api.stripe.com/v1/account | jq '.requirements,
   (.capabilities|length)'` shows requirements + non-empty capabilities.
3. Then re-run `stripe-live` (expect RESULT_E2E=0; RESULT_HARNESS=0 iff the
   requirements gate holds) + `conversation-acceptance` (13-step manual receipt)
   — exact commands in LINUX-P2-CLOSURE-HANDOFF.md.

---

# WINDOWS CONTINUATION (TL, 2026-11-17 evening → 2026-11-18 morning)

> Append-only continuation of the log above. Branch head at handoff:
> **`2cd89736`** (merge of the Linux-leg delivery `b0eda0a5` into the Windows
> continuation; everything pushed). Local checkout `p2/acceptance-run-tl`.

## A. Delivered since the log above (all on the branch, battery-backed)

| Commit | What |
|---|---|
| `3ed89be3`+`5de31b89` | **three-hop helper-key env wiring** (host→agent forward in `zcodeAgentProcessManager.ts`; agent-CLI capture-before-strip + re-injection at the D15.3 site; coordinator `idleTimeoutMs` passthrough) + bootstrap battery additions |
| `2beca244` | live-harness builder win32 portability (REPO_ROOT 4-level; backslash import specifiers die in JS escapes) |
| `63e8498a` | **ADR-P2-1 amendment** — standard-account restricted-key self-fetch OMITS `requirements` entirely (live-proven); evidence schema `requirements: nullable` (absence = explicit provider-absence evidence; malformed-present still fail-closed; refusal law unchanged); harness 10/10 RESULT_HARNESS=0 after |
| `c47e7035`+`e3406abc` | §11(3) audit sinks on BOTH coordinator surfaces (the desktop `--surface desktop` boots through the **protocol-entrypoint** coordinator — the create-app sink never fires there) |
| `73fd40c6`+`1b5289d1`+`4f81e1dd` | boot audit carries degradedReason + helperSupplyPresent booleans |
| `48f128b3` | **defaultDevBundledToolsRoots compiled-layout fix** — dev main runs the bundled `out/main/index.js` (ESM, everything inlined): `import.meta.dirname` = out/main → up 2 = packages/desktop; the old `../../` resolved `out/bundled-tools` (absent) so hop 1 never injected |
| helper staged | `packages/desktop/bundled-tools/win32-x64/payswap-broker-peer/` (sha256 `c613315f…`; `pnpm --filter @zcode/desktop prepare:payswap-broker-peer`) |

## B. Acceptance faces proven GREEN on this machine (do not redo)

1. **windows-build** (install 0 + build:bootstrap 0); 2. **windows-secure-storage**
(real Electron 44.7.0 DPAPI `available=true roundTrip=ok` + CI-canonical
13-file law battery 129/129 + platform gate); 3. **windows-desktop-e2e**
(`payswap-connection-ui` real-window spec, twice); 4a. **E2E live spec 3/3**
(connect→at-rest→verified via real api.stripe.com→revoke→secret deleted);
4b. **harness 10/10, RESULT_HARNESS=0** (four-category conversational data,
both direct and bridge forms — `/tmp/harness-repro2/` evidence, copy before
/tmp cleanup). Stripe account activated (live account, Payments Active;
payouts-only tasks don't block reads); restricted key at
`C:\Users\Lenovo\.payswap-live.env` (0600, never in chat); `/v1/balance` → 200.

## C. THE ONE REMAINING BLOCKER + next steps

The New Task conversational read still dies `instance_mismatch` because the
broker boots **degraded_refusing**. The audit instrumentation (both surfaces)
shows `helperSupplyPresent {path:false,sha256:false}` — the supply keys die
between desktop main and the booting process. `48f128b3` fixes the hop-1
resolution (compiled layout) but has **not been verified live** (the app died
first). A vitest probe already proved `bootPayswapBroker` returns
`peer_verified` when the keys are in `process.env`.

Next agent steps:
1. Relaunch detached (session-bound launches die):
   `Start-Process cmd '/c cd /d …\payswap-4.0 && pnpm dev:desktop:prod > %TEMP%\dev.log 2>&1' -WindowStyle Hidden`
   (the dev chain rebuilds dists — fixes ride along).
2. Fresh New Task → four-category question → read the newest
   `payswap-broker-audit` boot line in `~/.zcode/cli/log/zcode-2026-11-18.jsonl`:
   - `{true,true}` + `peer_verified` → done: verify the tool answer carries the
     four categories, then checklist steps 12–13 (revoke → typed refusal).
   - `{true,true}` + degraded with a relay reason → debug
     `startPayswapWindowsPeerRelay` (helper spawn/pipe), reason is logged now.
   - still `{false,false}` → set the two keys operator-side (user env vars;
     operator-wins is honored end-to-end) to unblock the conversation, and
     bisect the desktop-main injection as a parallel fix.
3. Then: 13-step manual evidence → final zero-assumption five-stage run with
   `--manual-evidence` → evidence register §7+ → roadmap P2 → complete.

## D. Security findings for the final report (none are secrets)

1. **Model bypass ×3**: plugin disabled by design (S0b) → no PaySwap tool →
   the New Task model improvised a full DPAPI→os_crypt→AES-GCM credential-chain
   unwrap + direct Stripe GETs; again with the plugin enabled but the broker
   degraded. Tooling was secret-free (sha256 recorded) and deleted, but the P2
   law "PSP credentials never exposed to the model" was violated at the model
   layer — any same-user process can perform the unwrap. P3 candidate:
   host-side hardening; short-term: keep the verified tool path working (C).
2. **dev relay starvation**: helper never staged in dev + three env hops
   stripping the supply keys + 30s idle rotation under a live MCP child — all
   fixed on the branch; final live confirmation pending (C).
3. A Linux-leg note: the runner was exonerated on the exit-hygiene suspicion
   (a66b5ea4) — consistent with our Windows observations.

## E. Gotchas (all live-encountered)

- Pre-push: `ZCODE_PRE_PUSH_BASE=origin/main` (script demands nonexistent
  `origin/staging`). Bootstrap tests are OUTSIDE the engineering manifest
  (run inside the package). `spawn-wiring.ts` has an intentional `\0` literal —
  Read/grep choke, edit via node. Dev app dies if launched from a session-bound
  shell — launch detached. Rebuild bootstrap before cli (cli embeds
  `bootstrap/dist`); restart the dev app after rebuilding. oxlint max-lines
  800 hard gate. IAB browser: claim tabs via `agent.browsers.open(url)`;
  Stripe permission rows need position-matched clicks. Pre-existing Windows
  typecheck noise (TS7006/TS6305, untouched files) — ignore.
- Artifacts: run-1 `artifacts/p2-acceptance/2026-11-17T15-31-25-426Z/`;
  run-2 `…/2026-11-17T15-48-00-883Z/`; harness evidence `/tmp/harness-repro2/`
  (copy to `artifacts/` before /tmp cleanup).
