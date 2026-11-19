# P2 AGENT HANDOFF — live operational state (2026-11-17)

> **Purpose:** any agent can take over P2 completion from this document alone.
> It records the exact live state: what is merged, what is in flight, where every
> credential lives, what remains, and the exact commands to reproduce each result.
> Canonical milestone status stays in `docs/payswap/p0/10-roadmap.md`; this file is
> the working handoff, not a second status register. Delete it when P2 closes.

## 1. Where things stand (one screen)

| Item | State |
|---|---|
| `main` | `8d595ed3` (PRs #42 + #43 + #44 merged; CI green on each head) |
| PR #45 `p2/vm-scripts-repo-root` | **OPEN, head `e92bf122`**, all five commits live-validated in E2B; awaiting CI + review + merge. Contains this file. |
| Stripe test account | `acct_1UblugEz3o7yd7Uo` (test mode, "Payswap"), owner email `ekontetevi+p2acceptance@gmail.com` — **email verified**, business type + representative + business details + products + support details + statement descriptor + **bank IBAN (test)** all submitted. |
| Onboarding position | Wizard step **3/5 "Secure your account" (2FA)** — the "Add authenticator app" dialog is open; button `Enter code manually` reveals the TOTP secret. Continue from there (see §5). |
| Live key | `rk_test_…` (name `payswap-p2-live-ro`) — **exactly 5 read permissions** (Accounts/Balance/Charges+Refunds/Customers/Payment Disputes), created 2026-11-16, stored in `~/.payswap-keys.env` (see §3). Never print/commit it. |
| Harness live state (last run, PR #45 branch, E2B) | Steps 1–8 **GREEN** (real keyring, real connect, at-rest no-plaintext ×2, live `api.stripe.com` refresh `verified`, real MessageChannelMain bridge, conversational overview). Steps 9/10 = typed `read_back_unavailable` refusal — cause: `/v1/account` carries **no `requirements` object** until onboarding identity section completes (evidence capture is all-or-nothing by law, `readBackAccount.ts` `captureCapabilityEvidence`). Onboarding since progressed; re-run to see the boundary move. |
| E2E arm | Not yet run to completion post-#45 (previous blockers all fixed; runner chain now proven to the spec execution step). |
| P2-Linux leg (2026-11-17 evening) | **Linux acceptance face delivered + independently-executable half GREEN** on the TL Linux sandbox (Debian 13, prefix leg stack): `scripts/payswap/linux/` five-category runner (merge 57669794 brings the E2B fixes onto this branch); linux-build / linux-secure-storage (probe + 129/129 + 12/12) / linux-desktop-e2e (connection-ui 7/7) all PASS; milestone decomposed (P2-Linux + P2-Windows rows in the roadmap). stripe-live / conversation-acceptance honestly SKIP — the key is on THIS machine (~/.payswap-keys.env), the TL sandbox has no valid secret channel. **Fastest P2-Linux closure path: run the E2B driver (§4.1) or the linux runner from THIS machine once onboarding finishes (§5 step 2 gate input).** Exact commands: docs/payswap/p2/LINUX-P2-CLOSURE-HANDOFF.md. |
| Roadmap P2 | `in_progress` — flip to `complete` only after the checklist in `docs/payswap/p0/10-roadmap.md` is fully evidenced & merged. |

## 2. What was done (merged to main)

1. **PR #42** — E2B operator toolchain vs current base template: `/workspace` sudo provisioning in `e2b-drive.mjs`; `vm-mega-setup.sh` self-provisions (sudo apt, alsa lib name by os-release, Node 24 via NodeSource when node<22, system-wide bun, Xvfb :99); `PAYSWAP_E2B_TEMPLATE` driver option (default E2B template has only ~484MB RAM → build OOMs; use an ≥4GB template, e.g. the account's `aise-android-station`).
2. **PR #43** — production fixes, RED-first, independently reviewed (rev1 REQUEST-CHANGES caught a real law violation; rev2 ACCEPT): reader-bridge per-op budgets (overview 15s, **detail 60s** — sequential worst case 5×10s); category-401 short-circuit with law-complete not-attempted placeholders (all four keys always present); two stale doc-facts aligned.
3. **PR #44** — Windows tar path discipline: win32 pins System32 bsdtar (`resolveTarCommand`); MSYS GNU tar is incompatible across namespaces (drive-colon remote-host parse + `..` depth mismatch, both demonstrated). Unblocked the Windows desktop build (`pnpm --filter @zcode/desktop... run build` now exits 0).

Open non-P2 PRs untouched: #40, #41 (P3 PayPal) — do not merge them into P2 work.

## 3. Credentials & environment (operator machine, Windows)

- **All keys**: `~/.payswap-keys.env` (0600). Source per shell: `. ~/.payswap-keys.env` (the Bash tool is non-login; profiles are NOT auto-read).
- Relevant entries: `PAYSWAP_PAT` (GitHub), `E2B_API_KEY`, `ZCODE_E2E_STRIPE_LIVE_KEY` (the restricted test key), `STRIPE_P2_ACCOUNT_EMAIL` / `STRIPE_P2_ACCOUNT_PASSWORD` (dashboard login for `ekontetevi+p2acceptance@gmail.com`).
- ⚠️ The account password leaked into THIS agent's session transcript via an accessibility-tree echo during reset (throwaway test credential; rotate via Stripe `/reset` if that matters).
- **E2B driver dep**: `e2b@^1` installed at the *workspace root* `C:\Users\Lenovo\.zcode\workspace\default\node_modules` (NOT in the repo — intentional; ESM walk-up resolves it from `payswap-4.0/scripts/payswap/live/`).
- **Templates**: `Sandbox.create()` default = Debian 12, Node 20.9, no bun, ~484MB RAM. Use `PAYSWAP_E2B_TEMPLATE=aise-android-station` (4 CPU / 8GB, Debian 12, bun+git+sudo). List via `new ApiClient(new ConnectionConfig({apiKey})).api.GET('/templates')`.
- Stripe dashboard: the in-app browser (IAB) may need re-login — sign out of any `ekontetevi@gmail.com` (Cattyz) session first, then sign in with the p2acceptance email + password above. Playwright `click/fill` on the dashboard SPA often needs `force:true` or `evaluate(() => el.click())`; DOM-CUA typing does NOT stick on React inputs — use Playwright `fill`.

## 4. Reproduction guide

### 4.1 Canonical E2B acceptance (both arms) — from the Windows operator machine

```bash
. ~/.payswap-keys.env
cd /c/Users/Lenovo/.zcode/workspace/default/payswap-4.0
git fetch origin main && git checkout main && git rev-parse origin/main   # record SHA
PAYSWAP_E2B_TEMPLATE=aise-android-station \
  node scripts/payswap/live/e2b-drive.mjs --arm both
```

- Requires PR #45 merged (the runner scripts on `main` at `8d595ed3` still have the broken REPO_DIR/electron/DISPLAY chain — that is exactly what #45 fixes).
- Exit codes: 0 green / 2 usage / 3 key-leak / 4 integrity / 5 RESULT≠0. Artifacts land in `p2-live-e2e-evidence/` + `p2-live-harness-evidence/`.
- Per-arm wall time ≈ 10–15 min (mega-setup ≈ 5 min inside). Sandboxes: 1h TTL, one per arm.

### 4.2 Single-arm quick probe (what this agent used to iterate)

`e2b-debug-harness.mjs` in the workspace root (NOT in the repo) clones main, overlays the four fixed files from the local branch checkout, runs the harness arm, and prints the tail. Adapt as needed; treat any pinned-VM overlay run as provisional — the official evidence must come from the driver against merged `main`.

### 4.3 Windows-native desktop validation (WP E)

```bash
cd /c/Users/Lenovo/.zcode/workspace/default/payswap-4.0
pnpm install --frozen-lockfile          # done once; node_modules present
pnpm --filter @zcode/e2e-report run build:node
pnpm --filter @zcode/desktop... run build   # exit 0 after PR #44
. ~/.payswap-keys.env
cd packages/desktop
ZCODE_E2E_STRIPE_LIVE_KEY="$ZCODE_E2E_STRIPE_LIVE_KEY" \
ZCODE_E2E_SPEC=./test/e2e/payswap-connection-live.test.ts \
ZCODE_E2E_KEYRING=discover pnpm run test:e2e:serial
```

- Windows uses DPAPI (`safeStorage` backend `dpapi`); the spec's keyring discovery should find it natively. Env-gating + spec details: header of `packages/desktop/test/e2e/payswap-connection-live.test.ts`.
- Note: a full local build stages `packages/desktop/bundled-tools/…helper.exe`, which makes `payswapBrokerPeerHelperSupply.test.ts` fail locally (it assumes an unbuilt tree; CI is clean). `rm -rf packages/desktop/bundled-tools` before pushing (it is gitignored).

### 4.4 Test batteries (repo-wide)

```bash
npx vitest run packages/services/test/payswap-account-data.test.ts   # from repo root
(cd apps/zcode-cli/packages/bootstrap && npx vitest run tests/payswap-account-reader-bridge.test.ts)
pnpm run lint && pnpm run typecheck   # full sets; ~177 registered engineering files
```

Pre-push hook runs `verify:pre-push` (worktree/lint/schema/architecture/affected tests). First-push of a new branch needs `origin/staging` to exist — it does not on this remote; fix locally once: `git update-ref refs/remotes/origin/staging refs/remotes/origin/main`.

## 5. Exact remaining steps (in order)

1. **Finish Stripe onboarding 2FA** (wizard step 3/5): the "Add authenticator app" dialog is open in the IAB Stripe tab. Click `Enter code manually` → the page reveals a TOTP secret; store it in `~/.payswap-keys.env` as `STRIPE_P2_TOTP_SECRET`, generate 6-digit codes locally (TOTP, 30s window, SHA1, 6 digits — e.g. `node -e` with a tiny HMAC impl or `oathtool`), enter the code, Continue. Then step 4/5 "Add extras" (skip fraud protection if skippable), step 5/5 "Review and submit" → submit. Onboarding may then say "pending verification" — **that is fine**; what matters for P2 is that `/v1/account` starts returning the `requirements` object.
2. **Verify the evidence gate input**: `curl -s -u "$ZCODE_E2E_STRIPE_LIVE_KEY:" https://api.stripe.com/v1/account | jq '.requirements, (.capabilities|length)'` — need `requirements.currently_due`/`past_due` arrays present (any length) + non-empty capabilities. If `requirements` is still absent after full submission, wait a few minutes and re-check (Stripe populates it asynchronously); if it stays absent, the acceptance boundary is genuinely unreachable without Stripe-side activation → document as operator-dependent and STOP before roadmap flip.
3. **PR #45**: check CI green on head `e92bf122` (`gh`/curl the check-runs), get an independent review (spawn a fresh reviewer agent on the incremental diff `c4623b50..e92bf122`; the previous audit agent's context is gone), merge. Then re-run §4.1 — expect `RESULT_E2E=0`; harness `RESULT_HARNESS=0` **iff** step 2's gate input holds (else 1 = refusal boundary, do NOT flip the roadmap).
4. **WP E Windows-native** (§4.3) — record backend (`dpapi`) + 3/3 results.
5. **WP F no-write verification**: audit trail already in PR #43 + adapters (`GET`-only, `PAYSWAP_WRITE_OPERATION_VERBS` unused at runtime); document at-rest scans (artifact byte-level leak check is built into the driver).
6. **WP H evidence + roadmap**: append the run to `docs/payswap/p2/live-acceptance-evidence.md` (UTC timestamps, tested SHA, artifacts + SHA-256, no secrets ever), flip P2 to `complete` in `docs/payswap/p0/10-roadmap.md` in the SAME PR (roadmap-integrity gate requires it), merge, delete this handoff file in that PR.

## 6. Known gotchas (learned the hard way)

- E2B default template = 484MB → desktop build SIGKILL (137). Always `PAYSWAP_E2B_TEMPLATE`.
- E2B keeps background processes ACROSS commands (probed) — Xvfb from mega-setup survives; the harness failure was the missing `DISPLAY` export, not a dead Xvfb.
- The repo is `node-linker=hoisted`: electron binary at repo-root `node_modules/electron/dist/electron`.
- `e2b-drive.mjs` clones **public main** — any unmerged fix is invisible to it; that is why PR #45 must merge before the official run.
- Stripe restricted keys are show-once; the dashboard's "Copy key" on old keys does NOT reveal them. The current key is in the env file — do not lose it (or mint a new one with exactly the five Read permissions; the wizard: Create secret key → Custom permissions → Read on Accounts/Balance/Charges and Refunds/Customers/Payment Disputes).
- Gmail (plus-alias delivery) is the recovery path for both password reset and 2FA setup emails — the inbox tab is `mail.google.com/mail/u/0`.
- Scope law: `getOverviewData` evidence capture requires BOTH `capabilities` (non-empty) AND `requirements` (object with `currently_due`/`past_due` arrays) — all-or-nothing by contract (`packages/services/src/payswap/providers/stripe/readBackAccount.ts`). Do not weaken it.

---

## ADDENDUM (2026-11-19 — read TL-PROGRESS.md "TAKEOVER HANDOFF" section first)

The P2-Windows functional acceptance (§9/§9.1) is complete; the credential-boundary
hardening (ADR-P2-3, owner disposition: hardening = P2-Windows blocker) is
mid-implementation — the custodian SYSTEM service is installed and RUNNING, the
console-mode protocol test is GREEN, but the service-mode read chain fails at one
diagnosed point. The takeover entry point is TL-PROGRESS.md
"⚠️ TAKEOVER HANDOFF — CUSTODIAN SERVICE" (H-1..H-5: live state, the diagnosed
open point, exact next steps). This legacy handoff file's §5 list predates the
custodian work and does not reflect it.
