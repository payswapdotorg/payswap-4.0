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
