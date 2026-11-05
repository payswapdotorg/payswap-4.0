# PaySwap 4.0 — project control center

This directory is the repository's PaySwap product documentation. Read the documents below in order.

## Authority and navigation

1. **[Canonical roadmap and live status](p0/10-roadmap.md)** — the sole source of truth for milestone order, scope, acceptance criteria and status. All progress updates must be made there.
2. **[Normative architecture addendum](p0/11-architecture-addendum.md)** — binding architecture, security, trust, authorization, ledger and deployment constraints. It can constrain implementation; it does not create a second roadmap.
3. **[Implementation playbook](IMPLEMENTATION-PLAYBOOK.md)** — mandatory TDD process, team operating model, evidence standard, autonomous advancement rules and reserved hard stops. It does not restate or redefine milestone scope.
4. **[P0 financial architecture](p0/06-financial-architecture.md)** — domain ownership and package boundaries.
5. **[Provider plugin contract](p0/05-provider-plugin-contract.md)** — provider adapter and integration contract.
6. **[New Task interaction design](p0/07-newtask-interaction-design.md)** — approved financial interaction model.

## Single-source-of-truth rule

The only authoritative roadmap and status register is `docs/payswap/p0/10-roadmap.md` (linked above as `p0/10-roadmap.md`). Do not maintain duplicate roadmaps in issues, PR descriptions, planning documents, agent memory, project boards or chat. Those systems may contain task-level execution details, but must link back to the canonical milestone and may not alter its scope, order or acceptance criteria.

When the roadmap changes, update the canonical file and its integrity checks in the same PR. When a milestone changes state, update the status table in that same file with the exact commit/PR and CI evidence. If a supporting document conflicts with the canonical roadmap, the canonical roadmap controls milestone sequencing and acceptance; the architecture addendum controls normative safety and architecture constraints.

## Current starting point

P0 is merged. The initial P1.0 official-plugin scaffold (PR #3) is now merged at `86a9ae53160cf06fa92d5e0778be61fbfd85a637`; it does not complete P1. The next required P1 work is the authenticated broker, operator-principal model, trusted authorization grant and host-rendered approval experience, followed by the P1 security and preservation acceptance battery. See the live status register rather than relying on this summary.
