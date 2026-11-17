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
   as live-acceptance-evidence §8.5 (incl. one operational note: runner exit
   phase can hang on a lingering child handle after manifest-last completion —
   non-blocking, follow-up hygiene item). PR #46 defect verification
   re-confirmed on this face: 915242dc covers RedactingLog cross-chunk carry,
   13-step evidence strictness, preflight fail-closed; the Linux runner
   consumes the same platform-neutral modules (runner-redaction.cjs /
   manual-evidence.cjs / acceptance-verdicts.cjs).

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
