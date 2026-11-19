# B8 acceptance evidence — PaySwap requirements through the upgraded plugin-creator skill

Date: 2026-11-19 · Branch: `feat/plugin-creator-official-workspace` · Exercise location: `out/b8-payswap-fixture/` (gitignored, disposable). Production PaySwap files were not modified.

## What was given to the skill

The original PaySwap Financial Workspace plugin requirements (`out/b8-payswap-fixture/requirements.md`): official built-in plugin `payswap`; six MCP tools; three informational UI surfaces; `financialWorkspace` opt-in defaulting false; typed refusal behavior; host-side broker integration; no raw financial credentials in the MCP process; production build + official seeding + production host launch; real tool/resource acceptance tests.

## How the skill executed it

1. **Classification** → Profile 3 (official workspace plugin; financial domain = host-owned state). Recorded in `security-review.md` with the credential boundary, opt-in law, refusal taxonomy, env namespace and boundary-test decisions.
2. **Scaffold** — one deterministic command:
   `node skills/plugin-creator/scripts/scaffold-official-plugin.mjs payswap --path out/b8-payswap-fixture --tools payswap_compile_intent,payswap_check_eligibility,payswap_discover_routes,payswap_request_authorization,payswap_get_execution_status,payswap_get_account_overview --surfaces "workspace:PaySwap Workspace|PaySwap 金融工作区,route-plan:Route Plan|路线计划,evidence:Evidence|凭据与证据" --opt-in financialWorkspace --env-namespace PAYSWAP --display-name "PaySwap" --display-name-zh "PaySwap 金融工作区" --description "…" --description-zh "…" --author "PaySwap"`
3. **Registration** — the scaffold printed the exact `OfficialPluginDefinition` block (`componentTypes: ["ui"]`, `defaultEnabled: false`, `requiredSeedPaths: [".zcode-plugin/plugin.json", "dist/server.mjs"]`, rootCandidates, version `0.1.0`); it was applied to a fixture copy of the host definitions file (`fixture-official-plugin-definitions.ts`). No production host file was touched.
4. **Build + audit + tests** (commands and results below).
5. **Production host launch** — real CLI dispatch acceptance (`acceptance/host-launch.mjs`).

## Files generated (11 in the package + 5 fixture-level)

Package (`out/b8-payswap-fixture/payswap-plugin/`): `.zcode-plugin/plugin.json` (mcpServers `payswap` stdio entry with `${ZCODE_PLUGIN_ROOT}/dist/server.mjs`, `${ZCODE_PROJECT_DIR}` cwd, `PAYSWAP_FINANCIAL_WORKSPACE: ${user_config.financialWorkspace}`, `isolation: "workspace"`; `ui.surfaces` ×3 with mcp-app resource URIs; `userConfig.financialWorkspace` boolean default false), `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` (next steps), `src/contract.ts` (`TOOL_NAMES` ×6, `PLUGIN_ENV_NAMESPACE = "PAYSWAP_"`, `OPT_IN_ENV = "PAYSWAP_FINANCIAL_WORKSPACE"`, closed refusal set, `ToolEnvelope`, `SURFACES`, `PLUGIN_OUTPUTS`), `src/server.ts` (six registered tools with zod schemas + readOnlyHint discipline, typed-refusal law, three `ui://` resources), `src/panels.ts` (static informational skeletons), `src/main.ts` (`export async function main()` + signals + direct-run guard), `src/server.test.ts` (7 acceptance tests), `scripts/build.mjs` (esbuild, payswap-identical parameters).

Fixture-level: `requirements.md`, `security-review.md`, `fixture-official-plugin-definitions.ts` (generated definition block applied), `acceptance/host-launch.mjs`, `scaffold-stdout.json`.

Files updated in the production repo: none (the exercise is disposable by design).

## Integration points discovered automatically (no manual reverse-engineering)

1. Official package conventions: package.json/tsconfig/vitest layout, esbuild bundle parameters (payswap/office-runtime identical shape), `dist/server.mjs` + `main()` export requirement (`official-plugin-lifecycle.md` §1–3, audit-enforced).
2. `OfficialPluginDefinition` registration shape: version triangle, rootCandidates convention, `requiredSeedPaths` completeness gate, `componentTypes ↔ ui.surfaces`, opt-in ⇏ `defaultEnabled` (`official-plugin-definition.md`; generated block + audit).
3. Host-launch manifest rewrite contract: `command=process.execPath`, `args=[…, __zcode-plugin-host, <cache server>]`, `ELECTRON_RUN_AS_NODE=1`, authoritative `ZCODE_PLUGIN_ID` (`official-plugin-lifecycle.md` §5). The fixture's acceptance drove the real dispatch without reimplementing it.
4. Resolution rules: `${ZCODE_PLUGIN_ROOT}` / `${user_config.*}` templates, official-only `isolation: "workspace"`, namespaced server id `plugin:payswap:<key>` (lifecycle §6; mirrored by the audit).
5. UI surface validation rules + `text/html;profile=mcp-app` + static-skeleton discipline (`ui-surface-integration.md`; encoded in scaffold templates and tests).
6. Credential boundary law: plugin process credential-free; broker five-key group only via trusted host injection; plugin-own env namespace (`host-broker-integration.md`, `workspace-plugin-security.md`).
7. Test chain: package InMemoryTransport suite → mechanical bootstrap tests → launch-path → production host-launch (`production-launch-testing.md`).

## Tests created and executed (commands + counts)

| Check | Command | Result |
| --- | --- | --- |
| Package build | `pnpm run build` (fixture plugin) | PASS — `dist/server.mjs` produced, `export { main }` present |
| Generated acceptance suite | `pnpm test` (fixture plugin) | **7/7 PASS** (exact tool list; `not_opted_in` arm ×2; `not_connected` arm; never-conflated; surfaces mcp-app mime; panel discipline) |
| Deterministic audit | `node skills/plugin-creator/scripts/official-plugin-audit.mjs payswap-plugin --definitions fixture-official-plugin-definitions.ts` | **0 errors, 0 warnings** |
| Production host launch | `node acceptance/host-launch.mjs` (real `apps/zcode-cli/packages/cli/dist/zcode.cjs __zcode-plugin-host …/dist/server.mjs`) | **4/4 PASS** (six tools via listTools; S1 typed `not_opted_in` ×2 tools; three `ui://` resources with mcp-app mime + static marker; S2 typed `not_connected`) |
| Supporting: real-repo pipeline | `npx vitest run tests/payswap-launch-path.test.ts` / `tests/payswap-host-launch.test.ts` (bootstrap) | 3/4 and 2/3 PASS; the failing assertions are a **pre-existing Windows-only path-separator mismatch** (rewritten arg keeps `/dist/server.mjs` while the test expects `join()` backslashes); the behavioral stdio-over-real-host tests pass. Unrelated to this exercise's diff (plugin-creator only). |

## Defects the exercise caught in the skill itself (fixed + regression-tested)

1. Opt-in env key derived camelCase (`PAYSWAP_FINANCIALWORKSPACE`); now splits to `PAYSWAP_FINANCIAL_WORKSPACE` (official precedent) — `scaffold-official-plugin.mjs` fixed, test asserts the snake-case key.
2. Generated refusal tests sent empty args against a required-field schema (`isError: true`); now send a schema-valid sample argument.
3. Generated build script printed a literal `\n`; fixed.

All caught by running the generated suite — the deterministic feedback loop working as intended. Plugin-creator's own suite stays 12/12 green.

## Work that still requires domain engineering (honest boundary)

1. **Real tool handlers.** The generated tools answer the typed-refusal law (exactly PaySwap's Wave-1 deliverable). Wiring live data — the Wave-2 authenticated broker bridge (`@zcode/shared/payswap` client, five-key arming, host broker boot/minting, dispatch gates, per-op schemas) — is domain engineering with architecture review, not scaffolding.
2. **Per-tool input schemas.** The scaffold emits one generic required string per tool; real schemas replace them (the generated tests must be updated with them).
3. **Seeding execution against the real host.** The audit proves registration-readiness against the generated definition block; `resolveOfficialPluginRoots` reads the production definitions, so seed→discovery→launch-path execution for the fixture happens when the block lands in `bootstrap/src/app/official-plugin-definitions.ts` (one Edit + `plugins.test.ts` + the two launch suites, per `production-launch-testing.md`). The exercise deliberately did not touch production files.
4. **Listing polish** (icon CDN asset, example prompts) and additional locales.

## Manual steps eliminated vs the original PaySwap creation

The production plugin's requirements (packaging, build parameters, definition registration, seed-path discipline, manifest-rewrite contract, resolution semantics, surface validation, consent wiring, launch-test patterns) were previously discovered by reading host source across multiple iterations. The upgraded skill supplies them deterministically: one scaffold command + one registration Edit + the audit + referenced test templates produced a plugin that passes its own acceptance suite and launches through the real production host dispatch on the first exercise, with the credential and consent laws enforced mechanically instead of by convention.
