# P0 Deliverable 9 — TL and Three-Worker File-Disjoint Assignments

**Owner:** TL · **Effective:** after P0 approval, for P1+

## Ownership map (file-disjoint by construction)

| Owner | Territory (paths) | Mission role |
|---|---|---|
| **TL** | `docs/payswap/` (cross-cutting), `specs/`, integration merges, `main` + sync branches, the tracking issue, release gates, all shared-boundary files (any file two lanes both need) | architecture, provenance, integration, review, release |
| **Worker 1 — Preservation & regression** | engineering/regression test files under `packages/rpc/test/`, `packages/client/test/` (new), E2E/WDIO spec additions under the existing E2E trees, `docs/payswap/regression/` | the preservation net (deliverables 01/02 maintenance; §3 of deliverable 08's coverage plan) |
| **Worker 2 — Extension surfaces** | the official PaySwap plugin package (`packages/payswap-plugin/` or the location deliverable 03 §6 fixes at P1 kickoff — the manifest, `mcpServers`, `ui.surfaces`, bridge integration), sandbox/permission integration points, `docs/payswap/surfaces/` | plugin/MCP/UI-Plugin mounting, approval hardening, credential-service upgrades |
| **Worker 3 — Financial layer** | `packages/shared/src/payswap/` (contracts), `packages/services/src/payswap/*` (all financial host services), `packages/payswap-provider/` (new registry package), the ledger store, `apps/zcode-cli/tools/payswap-provider-research/`, `docs/payswap/provider-facts/` | contracts, provider adapters, execution, ledger, reconciliation (deliverables 04/05/06) |

## Disjointness rules

1. **No shared files across lanes.** A need to touch another lane's file is a
   boundary change → the TL owns it (work-order amendment, not a quiet edit).
2. **Additive-first:** every lane's default diff is new files; edits to upstream
   files are enumerated in the lane's work order and reviewed against the
   preservation matrix (deliverable 02) before dispatch.
3. **The money path is Worker 3's alone** (in-process first-party adapters —
   approved decision); Worker 2 owns the model-facing surface (`payswap_*` MCP
   tools registration) but not the financial semantics behind them.
4. **Worker 1 may add tests inside any package** (tests are observation, not
   ownership) but changes no runtime code.
5. **The TL is the only merger**; every lane lands by PR into `main` with the
   gate battery's real output attached (deliverable 08).

## Resolved TL decisions (from the workers' P0 open questions)

1. **CUA stays fail-closed** in PaySwap 4.0 — no financial flow rides a
   fail-closed placeholder; revisit only if upstream revives Computer Use.
2. **In-process first-party adapters for the money path** (P0/P1); the
   MCP-plugin provider topology is deferred to P1+ evaluation.
3. **New `packages/payswap-provider` workspace package approved** (mirrors the
   `packages/provider` model-provider precedent).
4. **Polling-based reconciliation for P0**; webhook ingress arrives as an
   additive `packages/server` route in P7 (desktop Main holds no business state).
5. **safeStorage-backed credential cipher + per-provider keys is a P2 gate** —
   no real PSP keys land in `ICredentialService` before it (deliverable 03 §4.2).
6. **Money-moving tools are never silently approvable** — always-ask semantics
   regardless of mode (P1 hardening, Worker 2).
7. **Agent network denylist for PSP domains** (P1, Worker 2) — the model's
   browser/compute surfaces never talk to PSP endpoints directly.
8. **Mobile-remote approval of money movement deferred** (P8+ evaluation).
9. **Compensation pre-authorization UX** is a P7 design task (Worker 3 + TL).
