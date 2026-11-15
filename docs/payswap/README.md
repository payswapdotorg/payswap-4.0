# PaySwap 4.0 — project control center

This directory is the repository's PaySwap product documentation. Read the documents below in order.

## Authority and navigation

1. **[Canonical roadmap and live status](p0/10-roadmap.md)** — the sole source of truth for milestone order, scope, acceptance criteria and status. All progress updates must be made there.
2. **[Normative architecture addendum](p0/11-architecture-addendum.md)** — binding architecture, security, trust, authorization, ledger and deployment constraints. It can constrain implementation; it does not create a second roadmap.
3. **[Implementation playbook](IMPLEMENTATION-PLAYBOOK.md)** — mandatory TDD process, team operating model, evidence standard, autonomous advancement rules and reserved hard stops. It does not restate or redefine milestone scope.
4. **[P0 financial architecture](p0/06-financial-architecture.md)** — domain ownership and package boundaries.
5. **[Provider plugin contract](p0/05-provider-plugin-contract.md)** — provider adapter and integration contract.
6. **[Agent-native Payment Harness architecture](p0/12-agent-payment-harness-architecture.md)** — the merged agent catalog, multi-agent mission, delegated-authority and protocol-interoperability design for P3–P9.
7. **[New Task interaction design](p0/07-newtask-interaction-design.md)** — approved financial interaction model.

## Single-source-of-truth rule

The only authoritative roadmap and status register is `docs/payswap/p0/10-roadmap.md` (linked above as `p0/10-roadmap.md`). Do not maintain duplicate roadmaps in issues, PR descriptions, planning documents, agent memory, project boards or chat. Those systems may contain task-level execution details, but must link back to the canonical milestone and may not alter its scope, order or acceptance criteria.

When the roadmap changes, update the canonical file and its integrity checks in the same PR. When a milestone changes state, update the status table in that same file with the exact commit/PR and CI evidence. If a supporting document conflicts with the canonical roadmap, the canonical roadmap controls milestone sequencing and acceptance; the architecture addendum controls normative safety and architecture constraints.

## Current starting point

P0 and P1 are recorded complete in the canonical roadmap. P2 remains
`in_progress`: the real Stripe test account has connected and the read-only
platform path is evidenced, but the four-category conversational read-back /
final TL adjudication remains open. P3–P9 have not started. The approved
2026-11-15 architecture rebaseline makes P3–P9 deliver one payment-centric
multi-agent ZCode harness on the existing PaySwap financial core. Start P3 only
after the canonical P2 gate closes; do not infer or backdate P2 completion.
The roadmap is the source of truth for all live status.
