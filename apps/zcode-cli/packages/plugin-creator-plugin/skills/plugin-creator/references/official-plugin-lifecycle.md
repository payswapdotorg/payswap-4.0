# Official plugin production lifecycle

How a plugin source package inside `apps/zcode-cli/packages/` becomes a launched official ZCode plugin. Every step cites the real implementation; an agent following this reference walks the same path the host walks at startup. Package directory convention: `<plugin-name>-plugin` (e.g. `packages/payswap-plugin`), manifest name without the suffix (`payswap`).

## 1. Spec → package layout

A workspace repo package with at minimum:

```text
packages/<name>-plugin/
  package.json              # @zcode/<name>-plugin; version MUST equal manifest + definition version
  .zcode-plugin/plugin.json # the plugin manifest (see plugin-json-spec.md)
  src/…                     # server sources; entry src/main.ts exports main()
  scripts/build.mjs         # esbuild bundle → dist/server.mjs
  dist/server.mjs           # build output (gitignored); consumed by seed
```

`payswap-plugin` and `zcode-site-plugin` follow exactly this shape; the four document plugins share `office-runtime`'s build (`documents-plugin/package.json` `build: node ../office-runtime/scripts/build.mjs`).

## 2. Official definition (registration)

`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` holds `OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[]`. Registration is a code change in this array; see [official-plugin-definition.md](official-plugin-definition.md) for every field. Three versions must stay equal — `package.json`, manifest, `definition.version` — pinned by the bootstrap test `plugins.test.ts` → "keeps every bundled plugin package, manifest, and seed version aligned". Adding a plugin without registering it is a hard error our audit script reports (`official-plugin-audit.mjs` → "missing official definition").

## 3. Build

`pnpm -r build` runs each package's build script. For MCP-bearing plugins the output is the single stdio entry declared in the manifest (`dist/server.mjs`); payswap's `scripts/build.mjs` uses esbuild with `bundle + platform node + format esm + target node24` and a `createRequire` banner, identical parameters to office-runtime. The bundle's last line is `export { main }` — the production host requires it. Missing or stale `dist/` artifacts produce a broken seed; bootstrap's test helper `tests/payswap-plugin-build.ts` (`ensurePayswapPluginDist`) defines freshness as `dist/server.mjs` mtime ≥ newest input under `src/`, `scripts/`, manifest, `package.json`.

## 4. Seed (definition → immutable cache)

At startup `resolveOfficialPluginRoots({ storageRoot })` (`bootstrap/src/app/bundled-plugins.ts`) seeds every definition:

- Source: SEA assets in the packaged binary, otherwise the filesystem. `resolveFilesystemPluginRoot` walks `candidateBaseDirs()` × `definition.rootCandidates` and picks the first candidate containing `.zcode-plugin/plugin.json`.
- File collection: `collectFilesystemPluginFiles` copies only whitelisted top-level paths (`.zcode-plugin`, `dist`, `docs`, `scripts`, `skills`, `commands`, `agents`, `hooks`, `.mcp.json`, `README.md`, `package.json`, `templates`, `output-styles`) plus `definition.runtimeTopLevelPaths`. A top-level directory outside the whitelist never reaches users — put runtime assets inside `dist/` or extend `runtimeTopLevelPaths`.
- Completeness gate: `findMissingOfficialPluginSeedPaths` refuses to seed a plugin missing any `requiredSeedPaths` entry. This is why `dist/server.mjs` is listed as required for payswap: "缺 server.mjs 会 seed 出能看到面板入口却启动不了 MCP server 的残缺插件".
- Destination: `<storageRoot>/cache/zcode-plugins-official/<name>/<version>/` (`officialPluginCacheRoot`) — immutable per version; bumping the version is what moves users to new content. The seed also writes the official marketplace catalog entry (listing seed → marketplace.json `raw`).

## 5. Runtime manifest rewriting (host-launch contract)

`bootstrap/src/app/official-plugin-runtime.ts` → `writeOfficialPluginRuntimeManifest` rewrites the seeded manifest's `mcpServers` for stdio servers:

- `command = process.execPath`
- `args = [...officialPluginHostPrefixArgs(), <original args with ${ZCODE_PLUGIN_ROOT} replaced by the cache root>]`
  - SEA runtime: prefix is `[ZCODE_PLUGIN_HOST_COMMAND]` (the SEA binary itself is the entry).
  - Dev/desktop: prefix is `[...process.execArgv, resolve(process.argv[1]), ZCODE_PLUGIN_HOST_COMMAND]` — the real CLI entry plus the dispatch marker.
- `env = { ...manifest env, ELECTRON_RUN_AS_NODE: "1", ZCODE_PLUGIN_ID: "<name>@zcode-plugins-official" }` — the plugin identity is authoritative from the resolver; manifest/user env cannot override it.

Non-stdio servers (http/sse, e.g. image-search) are left untouched.

## 6. Resolution (discovery)

`discoverNodePluginsSync` (`@zcode/adapters/plugins`) reads the seeded manifest and resolves MCP configs (`adapters/src/plugins/mcp.ts`):

- Templates: `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` / `${ZCODE_PROJECT_DIR}` (+ CLAUDE_ aliases) resolve; `${user_config.X}` resolves from plugin options (defaults from `userConfig`); `${ZCODE_SESSION_ID}` / skill-dir tokens throw `PluginVariableError` at resolution; sensitive `user_config` values resolve only in env sinks, never in command/args/url.
- Server naming: `plugin:<manifest-name>:<server-key>` (e.g. `plugin:payswap:gateway`).
- `isolation: "workspace"` is honored only for official plugins; everything else stays session-isolated.
- Default-enabled semantics: `enabledPlugins[id] ?? defaultEnabled` — `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` (built from the definitions) is passed as `officialPluginsEnabledByDefault`. A user's explicit enable/disable always wins.

## 7. Host launch (stdio dispatch)

The resolved command is `process.execPath` with args ending `… <cli-entry> __zcode-plugin-host <cache-root>/dist/server.mjs`. In the CLI process, `main.ts` checks `isPluginHostInvocation(argv)` (`cli/src/plugin-host-command.ts`) and calls `runPluginHostCommand`, which:

1. Resolves the server path and requires it to exist.
2. Runs broker credential capture gates (CUA socket/pluginAuthority; PaySwap five-key tuple context + freshness assertions — impostor plugin ids and stale boot credentials are rejected before any module import).
3. `await import(pathToFileURL(serverPath))` and requires `module.main` — "Plugin server does not export main()." otherwise.
4. Restores captured broker env keys into the process (last host boundary), runs `module.main()`, restores env afterwards.

The server entry itself must keep the payswap `src/main.ts` discipline: export `main()`, connect `StdioServerTransport` inside `main`, handle SIGTERM/SIGINT/stdin-end, and guard direct `node dist/server.mjs` runs with the `import.meta.url === pathToFileURL(argv[1])` check.

## 8. MCP tools and resources

The host client connects to the child over stdio. Tools registered via `registerTool` appear namespaced to the model; resources (`registerResource`) serve `ui://` payloads. Declared `ui.surfaces` are projected by `bootstrap/src/zcode-protocol/plugin-ui-surfaces.ts` → `listPluginUiSurfacesFromPlugins`, filtered to enabled plugins only — launcher visibility is not data reachability. See [ui-surface-integration.md](ui-surface-integration.md).

## 9. Host services (Profile 3)

A workspace plugin that needs domain data must not fetch it with its own credentials; it proxies to host-owned services. PaySwap's broker chain is the worked example — see [host-broker-integration.md](host-broker-integration.md) and [workspace-plugin-security.md](workspace-plugin-security.md).

## 10. Verification chain (tests)

In order, mirroring `bootstrap/tests/payswap-launch-path.test.ts` and `tests/payswap-host-launch.test.ts`:

1. Package unit/contract tests (tool registration, refusals, surfaces, env namespace).
2. Definition/manifest/seed consistency (mechanical bootstrap tests in `plugins.test.ts`).
3. Launch path: real seed via `resolveOfficialPluginRoots({ storageRoot: tmp })` → `discoverNodePluginsSync` → connect a stdio MCP client to the resolved entry → assert tools/resources/typed refusals.
4. Production host launch: same seed with `process.argv = [execPath, cliEntry]`, `execArgv = []` so the rewrite bakes the real CLI entry, then execute the complete resolved command (`node <zcode.cjs> __zcode-plugin-host <server.mjs>`) verbatim — no truncation — and assert MCP behavior through it.

See [production-launch-testing.md](production-launch-testing.md) for the concrete patterns and commands.

## PaySwap-specific vs general

- General: package layout, definition registration, version triangle, seed whitelist/completeness, manifest rewrite, dispatch, resolution rules, defaultEnabled semantics, test chain.
- PaySwap-specific: the five-key broker credential group and its capture/restore gates (`plugin-host-command.ts` PaySwap branches), `PAYSWAP_*` env namespace, the three-refusal state law, financial opt-in. Other official plugins (browser-use's host-owned `node_repl` via `hostMcpServerNames`, documents' office-runtime MCP, image-search's http server) show alternative integration shapes.
