# P0 Deliverable 8 — Upstream Compatibility and Regression Plan

**Owner:** TL · **Inputs:** deliverables 01–03 (inventory, preservation matrix,
extension-surface audit)

## 1. The standing gate battery (real commands, real results — never claims)

Every lane and every upstream sync runs, on the merged tree, from the repo root
(the repo's own documented verification commands, per `AGENTS.md`):

| Gate | Command | What it proves |
|---|---|---|
| Workspace baseline | `node scripts/check-workspace-freshness.mjs` | baseline integrity |
| Types | `pnpm typecheck` | cross-package type contract |
| Lint | `pnpm lint` | code rules |
| Format | `pnpm fmt:check` | formatting |
| Pre-push contract | `pnpm verify:pre-push` | workspace + lint + schema + architecture |
| Architecture | `pnpm architecture:check` (and `--changed` per lane) | boundary law (no UI→Repo, no cross-domain imports, single owners) |
| Engineering tests | `pnpm test:engineering <file>`; push scope: `pnpm test:engineering:affected --scope push` | engineering/protocol regressions |
| Conversation/E2E | the WDIO suites (497 specs; 375 conversation-session — file list in deliverable 01) | user-visible behaviour of New Task + workspace surfaces |
| CLI/CUA | per-package entries (`apps/zcode-cli`, `packages/zcode-cua`) | agent runtime + the CUA fail-closed contract |
| Browser acceptance | per `docs/testing/` for touched surfaces | interactive evidence |
| Fork syncs | the procedure in `docs/payswap/UPSTREAM-SYNC.md` | upstream merges never regress PaySwap |

Policy notes that are themselves invariants: **App business unit tests stay
retired** (retired upstream 2026-10-26 — no new app unit tests; detection rides
E2E/browser acceptance + engineering Vitest). Reported results are actual outputs;
existing failures are never written as passing (AGENTS.md law).

## 2. The preservation matrix as the regression index

Deliverable 02's 40-row matrix (feature → source ownership → existing detection →
PaySwap contact surface → rule) is the canonical index. The upstream
`.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`
(415 nodes with code seeds) is adopted as the machine-readable regression-impact
index: any PaySwap lane declares its touched features; the TL expands impact via
the graph before merge.

## 3. The ten unguarded features — closing plan (Worker 1, P1)

Deliverable 02 §5 flags ten thinly-guarded surfaces (rpc relay protocol, client
relay ACKs, input prediction, whiteboard, gen-ui, formal-proof, e2e-report viewer,
web-share/share-ui, Android, the retired services-layer unit coverage). Decisions:

1. P1 tasks owned by Worker 1: engineering-test coverage for `packages/rpc` and
   `packages/client` relay contracts first (highest blast radius), then the
   remaining surfaces in the order the matrix ranks them.
2. Each addition lands as engineering Vitest under existing packages (policy-
   compliant), with the proposal from deliverable 02 §5 as the base design.
3. Android device acceptance stays UNVERIFIED in-repo (deliverable 01 open
   question) — recorded as an operator question, not silently assumed.

## 4. Per-wave regression contracts

- **P1 (plugin extension):** full battery + the plugin lifecycle E2E + the New
  Task state proofs (addendum §2 oracle): S0a/S0b-vs-upstream rendered-surface
  comparisons, plus the S1 **delta-equivalence** check — the S1-vs-S0 delta must
  equal the standard upstream delta of a control plugin with the same component
  shape (one stdio MCP server, same tool count, no UI surfaces), with no
  PaySwap-specific delta kinds beyond it.
- **P2 (Stripe vertical):** battery + account-connection browser acceptance +
  approval-gating E2E (a money tool is refused without the bound approval) +
  the CUA fail-closed contract still green.
- **P3+ (each provider):** the P2 contract re-run per provider, plus provider-
  specific read-back/reconciliation acceptance.
- **P6/P7 (routing/execution):** deterministic-route property tests (engineering
  Vitest) + the no-bypass battery (INV-30 carried from PaySwap 3.0: decomposition
  never changes purpose classification/eligibility) + unknown-outcome no-retry law
  tests.
- **Every upstream sync:** battery + the New Task state proofs (S0a/S0b-vs-upstream;
  the S3 invariant holds in every state).

## 5. Honest-boundaries register (carried from the mission methodology)

Any gate that cannot run in this sandbox (device farms, OS automation) is recorded
as NOT RUN with the reason — never claimed. External financial configuration
(provider accounts, keys) is operator-gated and recorded as such.
