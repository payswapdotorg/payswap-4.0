# PaySwap 4.0 — project control center

This directory is the repository's PaySwap product documentation. Read the documents below in order.

## Authority and navigation

1. **[Canonical roadmap and live status](p0/10-roadmap.md)** — the sole source of truth for milestone order, scope, acceptance criteria and status. All progress updates must be made there.
2. **[Normative architecture addendum](p0/11-architecture-addendum.md)** — binding architecture, security, trust, authorization, ledger and deployment constraints. It can constrain implementation; it does not create a second roadmap.
3. **[Implementation playbook](IMPLEMENTATION-PLAYBOOK.md)** — mandatory TDD process, team operating model, evidence standard, autonomous advancement rules and reserved hard stops. It does not restate or redefine milestone scope.
4. **[P0 financial architecture](p0/06-financial-architecture.md)** — domain ownership and package boundaries.
5. **[Provider plugin contract](p0/05-provider-plugin-contract.md)** — provider adapter and integration contract.
6. **[Unified PSP Interface and Money-Movement Discovery architecture](p0/12-agent-payment-harness-architecture.md)** — the payment-only product boundary, connected-PSP operations interface, payment-capability graph, route/opportunity discovery and per-party authorization model for P3–P9.
7. **[New Task interaction design](p0/07-newtask-interaction-design.md)** — approved financial interaction model.

## Single-source-of-truth rule

The only authoritative roadmap and status register is `docs/payswap/p0/10-roadmap.md` (linked above as `p0/10-roadmap.md`). Do not maintain duplicate roadmaps in issues, PR descriptions, planning documents, agent memory, project boards or chat. Those systems may contain task-level execution details, but must link back to the canonical milestone and may not alter its scope, order or acceptance criteria.

When the roadmap changes, update the canonical file and its integrity checks in the same PR. When a milestone changes state, update the status table in that same file with the exact commit/PR and CI evidence. If a supporting document conflicts with the canonical roadmap, the canonical roadmap controls milestone sequencing and acceptance; the architecture addendum controls normative safety and architecture constraints.

## Current starting point

Live status is read from the canonical register only. This page deliberately does
not restate it: the paragraph that previously stood here ("P2 remains
`in_progress` … P3–P9 have not started") had gone stale against the register and
was removed on 2026-11-23, so that the documentation index cannot become a second,
competing status statement. Start work from the register's current row and its
recorded next action. The roadmap is the source of truth for all live status.
