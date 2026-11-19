# Plugin Creator: before / after (Part B)

Branch `feat/plugin-creator-official-workspace` (based on origin/main @ 8d595ed3).

## Before (0.1.1)

- One profile: a local plugin scaffolded into `<workspace>/plugins/<slug>/` plus a dev marketplace catalog and a manual UI handoff. Skill sections 1–6.
- References: manifest spec + manual install/update only.
- Helpers: `create-basic-plugin.mjs` (basic scaffold with an empty-tool MCP handshake), `scaffold-files.mjs`, `validate-plugin.mjs` (preflight + optional `zcode plugins validate`), `upsert-dev-marketplace.mjs`.
- Zero knowledge of official plugins: how a plugin becomes a built-in, the host definition, seeding, runtime manifest rewriting, `__zcode-plugin-host` dispatch, UI surface rules, credential boundaries, or the launch-test chain. Recreating PaySwap meant manually discovering all of it.

## After (0.2.0)

- **Three explicit profiles** (SKILL.md §0): local (unchanged workflow), official built-in, official workspace; with a pre-implementation security/consent review (§0a) whose laws are audit-enforced.
- **Seven new references** derived from the real host sources with citations: `official-plugin-lifecycle.md`, `official-plugin-definition.md`, `host-broker-integration.md`, `workspace-plugin-security.md`, `production-launch-testing.md`, `ui-surface-integration.md`, `payswap-reference-pattern.md`.
- **New deterministic generator** `scaffold-official-plugin.mjs`: complete official package (manifest with mcpServers/ui.surfaces/opt-in userConfig, `src/contract.ts` single source of truth, typed-refusal server, informational panels, `main()` entry, esbuild build, vitest acceptance suite) + the `OfficialPluginDefinition` block for registration.
- **New deterministic validator** `official-plugin-audit.mjs`: definition registration, version triangle, requiredSeedPaths/build outputs, componentTypes/ui agreement, ui surface rules, `main()` export, empty-tool handshake detection, env namespace/credential boundaries (broker five-key group, reserved host keys, `alwaysLoad`-is-not-consent), resolver template rules, stale builds, launch-test wiring. Parses the real `official-plugin-definitions.ts` (constants, map-generated entries).
- **Dogfooded**: plugin-creator's own definition pins the new files; version triangle bumped to 0.2.0; the creator package audits 0 errors against itself.
- **Evidence**: `evidence/payswap-acceptance-evidence.md` — the original PaySwap requirements regenerated in a disposable fixture: 11 files generated, audit 0 errors, generated suite 7/7, production host launch 4/4 through the real CLI dispatch; remaining domain engineering and seeding-into-production boundaries documented.

## Verification

- Plugin-creator suite: `pnpm test` → 12/12 (8 pre-existing kept green, incl. one assertion updated for the reworded preflight message; 4 new official-tooling tests).
- Golden reference: the real `payswap-plugin` audits 0 errors against the real definitions file (test enforces it in CI-representative environments).
- Bootstrap mechanical tests (version alignment, ui component type) pass with the creator bump.
- Real bootstrap payswap launch suites: behavioral stdio-over-real-host tests pass; two exact-path assertions fail only on Windows (pre-existing `${ZCODE_PLUGIN_ROOT}/dist/server.mjs` forward-slash vs `join()` backslash), untouched by this branch.
