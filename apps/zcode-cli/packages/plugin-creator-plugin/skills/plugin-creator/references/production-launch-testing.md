# Production launch testing for official plugins

The acceptance chain proves definition → build → seed → resolution → stdio → MCP behavior on real mechanisms — no mocks, no parallel launcher, no truncated commands. Patterns below are transcribed from the real suites; copy the file, rename the plugin, adapt the contract lists.

## Layer 1 — package tests (vitest, inside the plugin package)

`payswap-plugin/src/server.test.ts` and `contract.test.ts` are the template:

- Client↔server over `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`).
- `listTools()` equals the contract `TOOL_NAMES` exactly (sorted compare).
- Typed refusal arms: construct the server with `{ env }` overrides for each opt-in state and assert the full envelope `{ kind: "refused", refusal: { code, message } }` for EVERY tool.
- Surfaces: `readResource` per declared `ui://` URI returns one content with mimeType `text/html;profile=mcp-app`; panels contain the "no data is shown on this surface yet" marker; no placeholder-data or external-dependency patterns.
- Contract tests read the manifest from disk and mechanically pin: `PLUGIN_OUTPUTS` = `[".zcode-plugin/plugin.json", "dist/server.mjs"]`, every `mcpServers.*.env` key inside the plugin env namespace.

Run: `pnpm --filter @zcode/<name>-plugin test` (after `pnpm --filter @zcode/<name>-plugin build`, or rely on `ensureXPluginDist` helpers below).

## Layer 2 — deterministic audit (cheap, run first)

`node skills/plugin-creator/scripts/official-plugin-audit.mjs <plugin-path> <repo-root>` — registration, version triangle, seed paths/build outputs, ui surface rules, entry `main()` export, empty-tool detection, env boundaries. 0 errors required before running the suites below.

## Layer 3 — bootstrap mechanical consistency tests

Already exist and run against ALL official plugins (`bootstrap/tests/plugins.test.ts`):

- "keeps every bundled plugin package, manifest, and seed version aligned" — version triangle + every `requiredSeedPaths` exists.
- "declares the ui component type exactly for bundled plugins with UI surfaces".
- "Settings 默认启用集合与 CLI 的官方插件声明一致" (default-enabled agreement).

If you added a new plugin, these pass only when your definition/package/manifest agree — run them: `pnpm --filter @zcode/bootstrap test plugins.test.ts`.

## Layer 4 — launch-path test (real seed + real stdio)

Template: `bootstrap/tests/payswap-launch-path.test.ts`. Structure to replicate as `bootstrap/tests/<name>-launch-path.test.ts`:

1. `beforeAll`: ensure build outputs exist (copy the `ensurePayswapPluginDist` freshness+lock discipline from `bootstrap/tests/payswap-plugin-build.ts` — parallel-safe, reuses the official build script, never hand-rolled bundles). Create `mkdtemp` storage + workspace dirs. Seed for real: `resolveOfficialPluginRoots({ storageRoot })`. Assert the cache root `<storageRoot>/cache/zcode-plugins-official/<name>/<version>` contains every `requiredSeedPaths` artifact.
2. Discovery: `discoverNodePluginsSync({ config: { enabledPlugins: { "<name>@zcode-plugins-official": true }, options: { "<name>@zcode-plugins-official": { <optIn>: false } } ... } })` and assert plugin metadata (marketplace = official, rootPath = cache root, version = definition version) and the resolved MCP config: `command === process.execPath`, `isolation: "workspace"`, args end with `[ZCODE_PLUGIN_HOST_COMMAND, <cache-root>/dist/server.mjs]`, env has the opt-in substitution (`false` arm AND `true` arm), authoritative `ZCODE_PLUGIN_ID`, `ELECTRON_RUN_AS_NODE: "1"`.
3. stdio MCP: connect a real `StdioClientTransport` to the resolved entry (`args: [mcp.args![mcp.args!.length - 1]!]` — the payswap suite runs the server module directly here; the dispatch mechanism itself is proven by Layer 5) and assert `listTools`, typed refusals per opt-in arm, and `readResource` per surface.
4. Disabled arm: discover with empty `enabledPlugins` and assert the plugin is `enabled: false`, produces no MCP server, and is absent from the launcher surfaces projection.

## Layer 5 — production host-launch test (real CLI entry + `__zcode-plugin-host` dispatch)

Template: `bootstrap/tests/payswap-host-launch.test.ts` — the suite that made the earlier launch-path test honest ("上一版测试在这里截断成 [server.mjs] —— 本文件存在的意义就是不再截断"). Replicate as `bootstrap/tests/<name>-host-launch.test.ts`:

1. Ensure the real CLI entry exists: `packages/cli/dist/zcode.cjs` (CI builds it; locally run `cli/scripts/build.mjs` — the same production script, no second bundle).
2. Seed with production process context so the manifest rewrite bakes the real entry:
   ```ts
   const originalArgv = process.argv;
   const originalExecArgv = process.execArgv;
   process.argv = [process.execPath, cliEntry];
   process.execArgv = [];
   try { resolveOfficialPluginRoots({ storageRoot }); } finally { /* restore */ }
   ```
3. Assert the resolved args EXACTLY equal `[cliEntry, ZCODE_PLUGIN_HOST_COMMAND, join(cacheRoot, "dist", "server.mjs")]`.
4. Spawn the FULL resolved command verbatim (`StdioClientTransport` with `args: mcp.args!`, `command: mcp.command`, `env: { PATH, ...mcp.env }`) and assert the same MCP behavior as Layer 4 — tools, typed refusals in both arms, surface resources — through the real dispatch chain (`main.ts → isPluginHostInvocation → runPluginHostCommand → import server.mjs → main()`).

Timeouts: these suites need 90–180s budgets (`{ timeout: 90_000 }` per test; `beforeAll` up to 180_000) because they build and spawn real processes.

## What "done" means

- `pnpm --filter @zcode/<name>-plugin build && pnpm --filter @zcode/<name>-plugin test` green.
- `node skills/plugin-creator/scripts/official-plugin-audit.mjs <plugin-path> <repo-root>` → 0 errors.
- `pnpm --filter @zcode/bootstrap test plugins.test.ts` green.
- New `bootstrap/tests/<name>-launch-path.test.ts` + `bootstrap/tests/<name>-host-launch.test.ts` green.
- Manual UI verification is separate (see [installing-and-updating.md](installing-and-updating.md)) — automated suites do not replace the user-journey trial.

## Honesty rules the suites enforce

- No mocked launch acceptance: always spawn what the resolver produced; never re-create the host dispatch in test code.
- No empty tool lists presented as done: a refusal-envelope tool surface is a real Wave-1 deliverable only when the contract tests pin it; otherwise it is a failure (`official-plugin-audit.mjs` flags the scaffold handshake).
- Keep package/manifest/definition versions aligned — the mechanical tests catch drift at CI time, the audit catches it at authoring time.
