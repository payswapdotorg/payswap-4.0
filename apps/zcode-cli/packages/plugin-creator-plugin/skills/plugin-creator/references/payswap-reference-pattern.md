# PaySwap golden reference pattern

PaySwap (`apps/zcode-cli/packages/payswap-plugin/`) is the calibration example for official workspace plugins: a sensitive-domain plugin whose every requirement — opt-in defaulting false, typed refusals, host-side broker integration, no credentials in the plugin process, production launch proof — is implemented, tested, and mechanically pinned. Read the other official plugins to separate the general pattern from PaySwap specifics.

## File map (what each file proves)

| File | Role | Generalizable lesson |
| --- | --- | --- |
| `CONTRACT.md` | invariants in prose (opt-in default off; launcher visibility ≠ data reachability; MCP process holds no financial state; env namespace `PAYSWAP_`; Class A only; build outputs) | every workspace plugin should carry an equivalent invariants list next to its code |
| `contract.ts` (src) | `TOOL_NAMES` (6), `PayswapRefusalCode` closed set, `PayswapToolEnvelope`, `SURFACES`, `FINANCIAL_WORKSPACE_ENV`, snapshot readers | the contract file is the single source of truth; tests and the manifest are checked against it |
| `contract.ts` (root) + `contract.example.ts` + `contract.test.ts` | module-level summary contract: `PAYSWAP_PLUGIN_OUTPUTS`, `PAYSWAP_ENV_NAMESPACE`, opt-in option; contract tests read the manifest and pin outputs + env namespace mechanically | a plugin can be verified without knowing its implementation internals |
| `src/server.ts` | `createPayswapServer` registers 6 tools (zod schemas, `readOnlyHint` except `request_authorization`) + 3 `ui://` resources | tool surface with real schemas; refusal law enforced centrally in one handler |
| `src/bridge.ts` | 1:1 tool→op mapping, `_meta` session-hint extraction (namespaced only), five-key arming, envelope separation (`ok`/`refused`/`bridge_failure` never conflated) | the thin-proxy layer; session hint is a hint, broker resolves authoritatively |
| `src/panels.ts` | static informational HTML, zero dependencies, zero placeholder data, explicit status marker | panel discipline that makes the security tests writable |
| `src/main.ts` | `export async function main()` + SIGTERM/SIGINT/stdin-end + direct-run guard | the host entry contract (`plugin-host-command.ts` requires `module.main`) |
| `scripts/build.mjs` | esbuild → single `dist/server.mjs` (node24, esm, createRequire banner) | the exact build shape the seed and runtime rewrite expect |
| `.zcode-plugin/plugin.json` | `mcpServers.gateway` (stdio, `${ZCODE_PLUGIN_ROOT}/dist/server.mjs`, `cwd: ${ZCODE_PROJECT_DIR}`, env `${user_config.financialWorkspace}`, `isolation: "workspace"`), `ui.surfaces` ×3, `userConfig.financialWorkspace` (boolean, default false) | the manifest is the only place templates/opt-in/surfaces are declared |
| `package.json` | `@zcode/payswap-plugin`, scripts build/typecheck/test/clean, deps `@modelcontextprotocol/sdk 1.29.0`, `zod 4.6.5`, `esbuild`, `vitest` | package conventions + version triangle membership |
| `src/server.test.ts` | InMemoryTransport acceptance: tool list, refusal arms, surfaces, panel discipline | Layer-1 test template |
| `src/bridge.test.ts` | session-hint/trace extraction and envelope separation negative cases | fail-closed parsing of third-party extensible fields |

## Host-side counterpart (what the plugin's existence required)

- `bootstrap/src/app/official-plugin-definitions.ts` — the `payswap` element: `componentTypes: ["ui"]`, `defaultEnabled: false` (installed stays S0b until explicit enable), `requiredSeedPaths: [".zcode-plugin/plugin.json", "dist/server.mjs"]`, listing, rootCandidates, version.
- `bootstrap/src/app/official-plugin-runtime.ts` — manifest rewrite to the host-launch contract (execPath + `__zcode-plugin-host` + cache path, `ELECTRON_RUN_AS_NODE`, authoritative `ZCODE_PLUGIN_ID`).
- `bootstrap/src/mcp-config.ts` — trusted injection of the five-key broker group (`resolveTrustedOfficialPayswapServerNames` + `injectPayswapBrokerMcpServers`).
- `cli/src/plugin-host-command.ts` — dispatch with PaySwap capture-context + freshness gates and `restoreCapturedPayswapEnv`.
- `packages/shared/src/payswap/` — the single shared protocol implementation (broker-env, envelope signing/verification, replay, operations, refusal law).
- Tests: `bootstrap/tests/payswap-launch-path.test.ts` (real seed→resolution→stdio), `bootstrap/tests/payswap-host-launch.test.ts` (real `zcode.cjs` + dispatch, verbatim args), `bootstrap/tests/payswap-broker-credentials.test.ts`, `bootstrap/tests/payswap-broker-spawn-wiring.test.ts`, helper `bootstrap/tests/payswap-plugin-build.ts` (parallel-safe build freshness).

## What was PaySwap-specific (do NOT generalize blindly)

1. The five-key broker credential transport (socket + token + Ed25519 verify key) is PaySwap's local-IPC broker protocol. A plugin integrating an HTTP service uses the official-auth headers path instead (`adapters/src/mcp-official-auth.ts`).
2. The three financial refusal codes and S-state model are financial-domain semantics; the general shape is "closed set of typed refusal codes + tests that arms cannot be conflated".
3. `financialWorkspace` opt-in naming/env key; other plugins pick their own option name inside their own namespace.
4. Host files contain PaySwap branches (credential gates) — a new domain service with a new credential type means extending those gates deliberately, not copying them silently. That is TL/architecture-review territory: record it as an open decision ([workspace-plugin-security.md](workspace-plugin-security.md) Step 5).

## What IS the general pattern (copy for any Profile 3 plugin)

1. Contract file as single source of truth; manifest kept consistent with it; versions in triangle.
2. Opt-in gate: `userConfig` boolean default false → plugin env via `${user_config.*}` → typed `not_opted_in`; second code for "enabled but not provisioned"; `defaultEnabled: false`.
3. Thin-proxy tools with real schemas + `readOnlyHint` discipline; envelope union with separated failure kinds; never raw errors.
4. Static informational panels (Class A), no placeholder data, no external deps; resources registered with `text/html;profile=mcp-app`.
5. Build = esbuild bundle `dist/server.mjs` exporting `main()`; `requiredSeedPaths` pin it.
6. Test chain: package vitest → mechanical bootstrap tests → launch-path → production host-launch, all on real processes.
7. Deterministic audit (`official-plugin-audit.mjs`) as the pre-commit gate.

## The lifecycle in one line each

spec/CONTRACT → package layout → manifest (mcpServers/ui/userConfig) → build (`dist/server.mjs`) → definition registration → seed completeness (`requiredSeedPaths`) → runtime manifest rewrite (`__zcode-plugin-host`) → resolution (templates/isolation/identity) → stdio dispatch (`module.main()`) → MCP tools/resources → host services via trusted injection → user journey (enable → opt-in → connect) — each line has a citing section in [official-plugin-lifecycle.md](official-plugin-lifecycle.md) and a pinned test in [production-launch-testing.md](production-launch-testing.md).
