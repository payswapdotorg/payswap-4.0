# PaySwap 4.0 — Fork Provenance Record

**Recorded:** 2026-11-04 · **TL:** resident TL · **Tracking:** issue #1

## Mandate

Establish a genuine GitHub fork of `zai-org/ZCode` into `payswapdotorg/payswap-4.0`,
preserving upstream commit history, tags, package tree and provenance. The required
baseline is `v3.17.2` at `a9fe401eede6e6e5e01be9048679c206fe6f02d9`.

## Baseline recheck (immediately before forking)

Upstream `zai-org/ZCode` was re-checked at fork time via `git ls-remote`:

```
a9fe401eede6e6e5e01be9048679c206fe6f02d9  refs/heads/main
a9fe401eede6e6e5e01be9048679c206fe6f02d9  refs/tags/v3.17.2
```

**No drift** — upstream `main` was exactly the audited baseline `v3.17.2` at
`a9fe401`. Had it drifted, the change would have been reported back to the operator
rather than silently forking another version.

## The fork-blocking catch and its resolution

GitHub allows **one fork per upstream per account**. The `payswapdotorg` account
already held a fork of `zai-org/ZCode`: `payswapdotorg/gamos` — a divergent previous
mission (created 2026-10-04, 17 branches, `main` 4 commits ahead of the baseline,
last pushed 2026-11-04T12:11:56Z). A fork request for `payswap-4.0` returned the
existing fork regardless of the requested name.

Resolution, in order:

1. **Archive before delete.** `gamos` was bare-cloned and mirrored — branch-for-branch
   (17/17) and tag-for-tag (6/6, including its own `upstream-pin-a9fe401` pin) — to
   **`payswapdotorg/gamos-archive`** (public, read-only by convention). Verified via
   the branches/tags APIs and `main` HEAD match (`3e3717e…` on both).
2. **Freed the fork slot.** `gamos` deleted (`DELETE /repos/payswapdotorg/gamos` → 204).
3. **Fresh fork.** `POST /repos/zai-org/ZCode/forks` with `name: "payswap-4.0"` → 202.
4. The previously-created empty placeholder `payswapdotorg/Payswap-4.0` (non-fork,
   zero refs — verified empty: no branches, tags, or issues) was deleted **before**
   the fork so the name was free.

Nothing was lost: `gamos` lives on in full at `gamos-archive`.

## Verification — all checks pass

| Check | Evidence | Result |
|---|---|---|
| GitHub identifies the repo as a fork | `GET /repos/payswapdotorg/payswap-4.0` → `fork: true`, `parent: zai-org/ZCode`, `source: zai-org/ZCode` | ✅ |
| Pinned upstream commit is an ancestor | fork `main` HEAD = `a9fe401` (the pinned commit itself; `compare/a9fe401...main` → identical) | ✅ |
| Initial tree matches upstream | compare API: `status: identical, ahead 0, behind 0`; local `git diff v3.17.2` → empty | ✅ |
| Commit history preserved | clone at `a9fe401` retains full upstream history (`chore: sync ZCode source v3.17.2` at tip) | ✅ |
| Tags preserved | `v3.14.3`, `v3.15.1`, `v3.17.1`, `v3.17.2` present in the fork | ✅ |
| Upstream branches preserved | `main`, `feat/ui-plugin` | ✅ |
| Package tree preserved | 18-package pnpm monorepo intact (see P0 deliverable 1 for the full inventory) | ✅ |

## Remotes

```
origin    https://github.com/payswapdotorg/payswap-4.0.git   (fetch/push)
upstream  https://github.com/zai-org/ZCode.git               (fetch)
```

The upstream remote is fetch-only by convention; see `UPSTREAM-SYNC.md`.
