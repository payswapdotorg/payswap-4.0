# PaySwap 4.0 — Upstream Synchronization Process

**Recorded:** 2026-11-04 · **Owner:** resident TL · **Tracking:** issue #1

PaySwap 4.0 is a product fork: `main` carries the PaySwap product line, and upstream
ZCode improvements are merged in deliberately — never rebased, never fast-forwarded
over PaySwap work.

## Principles

1. **Baseline pin.** All PaySwap work cites the pinned baseline `a9fe401` (`v3.17.2`).
   Before any sync, re-check upstream `main`; if upstream moved, record the new tip in
   the tracking issue **before** merging. Drift is reported, never silently absorbed.
2. **Merge, don't rebase.** Published PaySwap history is immutable. Upstream changes
   enter as merge commits (`git merge upstream/main`), so every sync is bisectable and
   reversible as a unit.
3. **Preservation gates run on the merged tree.** A sync that breaks a ZCode
   capability is not a sync — it is a regression. The full regression gate battery
   (below) must pass on the merge result before it lands on `main`.
4. **Conflicts resolve toward upstream** unless the conflicted file is a PaySwap-owned
   additive surface (paths under `docs/payswap/`, `packages/*` files created by
   PaySwap lanes, PaySwap-only config). Any conflict touching shared ZCode files is
   resolved by hand with the architectural reason recorded in the merge commit body.

## The sync procedure

From the local clone (`origin` = fork, `upstream` = `zai-org/ZCode`):

```bash
# 0. Preflight: record current state
git checkout main && git pull origin main
git rev-parse HEAD                       # the PaySwap tip being synced FROM

# 1. Fetch and inspect upstream
git fetch upstream
git log --oneline HEAD..upstream/main    # what's incoming
git diff --stat HEAD...upstream/main     # what's changing

# 2. Sync branch, never sync on main directly
git checkout -b sync/upstream-<date>

# 3. Merge upstream
git merge upstream/main
# resolve conflicts per the principles above; if a PaySwap additive surface is
# deleted upstream-side, re-add it — additive surfaces are never silently dropped

# 4. Run the full gate battery on the merged tree
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm verify:pre-push
pnpm architecture:check
pnpm test:engineering:affected --scope push
# plus the E2E/browser acceptance entries the touched surfaces require
# (see docs/testing/ and deliverable 8's regression plan)

# 5. Push, PR, review — the TL is the only merger
git push origin sync/upstream-<date>
# open PR into main; the PR body records: upstream range, conflict resolutions,
# gate results (real output, not claims), and any deferred upstream changes

# 6. After merge: tag the sync point for provenance
git tag sync-upstream-<upstream-sha> && git push origin --tags
```

## Cadence and triggers

- **Routine:** sync when upstream publishes a release tag or security fix.
- **Before each PaySwap wave:** check upstream; sync or record the conscious
  decision to stay on the current baseline for that wave.
- **Never** during an open PaySwap lane's integration window (the TL sequences
  syncs between lanes to keep bisects clean).

## What must never happen

- `git push --force` to `main` or to any published lane branch.
- Rebasing PaySwap commits onto upstream (history rewrite).
- A sync merge that lands without the gate battery's real output attached.
- Divergent "shadow" copies of upstream files (edit in place or extend; the
  architecture check plus the P0 preservation matrix own this invariant).
