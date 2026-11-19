# OfficialPluginDefinition registration reference

Source of truth: `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`. Registration means adding one element to `OFFICIAL_PLUGIN_DEFINITIONS` and keeping it consistent with the plugin package. Verify with `scripts/official-plugin-audit.mjs` before running tests.

## Fields (from the real `OfficialPluginDefinition` interface)

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Plugin manifest name; plugin id is `<name>@zcode-plugins-official` (`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE` in `@zcode/contracts`). |
| `version` | yes | Must equal the package's `package.json` version AND the manifest version. Cache path is `<storageRoot>/cache/zcode-plugins-official/<name>/<version>`, so a version bump is how users move to new content. |
| `rootCandidates` | yes | Candidate package dirs relative to the CLI bundle dir; convention is `["packages/<name>-plugin", "../<name>-plugin", "../../<name>-plugin", "../../../<name>-plugin"]`. The first candidate containing `.zcode-plugin/plugin.json` wins (`resolveFilesystemPluginRoot`). |
| `requiredSeedPaths` | no | Paths that MUST exist in the package or the seed refuses (`findMissingOfficialPluginSeedPaths`, bundled-plugins.ts). List every file the plugin cannot run without: skill bodies, docs the skill reads, scripts it imports, and every built runtime artifact. |
| `componentTypes` | no | `["ui"]` exactly when the manifest declares `ui.surfaces` — pinned by `plugins.test.ts` "declares the ui component type exactly for bundled plugins with UI surfaces" (the marketplace needs it to classify suppressed/restorable entries). |
| `defaultEnabled` | no | Adds the id to `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`, which resolution passes as `officialPluginsEnabledByDefault` so users get the plugin without an explicit enable. Semantics: `enabledPlugins[id] ?? defaultEnabled`. |
| `listing` | no | Store metadata seed (`OfficialPluginListingSeed`): `displayName`, `displayName_i18n`, `description_i18n`, `category`, `author {name,url}`, `icon` (CDN URL; UI degrades gracefully on 404), `homepage`, `privacyPolicy`, `termsOfService`, `heroImage`, `examplePrompts(_i18n)`. Written into the official marketplace entry. |
| `hostMcpServerNames` | no | Host-owned MCP servers attributed to this plugin (browser-use/computer-use declare `["node_repl"]`). The runtime server keeps its host identity; only product ownership/status display uses this. |
| `runtimeTopLevelPaths` | no | Extra top-level package paths staged into the seed beyond the default whitelist (computer-use stages `node_modules` for Sharp). |

## The two consent laws

1. **Opt-in needs default-off.** If the manifest declares a `userConfig` option with `default: false` (an opt-in gate), the definition must NOT set `defaultEnabled: true`. Precedent comment (payswap element): installed stays S0b (installed + disabled) until the user explicitly enables; see [workspace-plugin-security.md](workspace-plugin-security.md). `plugins.test.ts` "computer-use 默认不启用" pins the same decision for computer-use.
2. **`alwaysLoad` is not consent.** `mcpServers.<key>.alwaysLoad: true` (adapters `resolveMcpServerConfig`) only bypasses tool deferral — it is a latency choice, never a permission. Do not use it to "make the plugin work" for an opt-in plugin; our audit script errors on `alwaysLoad:true` combined with an opt-in gate and warns on every other use.

Note the `defaultEnabled:true` comment discipline in the file: it is reserved for content-type plugins (skills/commands without heavy side effects). MCP-bearing plugins that are default-on (documents, zcode-site) each carry an explicit product-decision comment — write one when you deviate from default-off.

## Worked examples (real elements)

- `payswap` — sensitive workspace plugin: `componentTypes: ["ui"]`, `defaultEnabled: false`, `requiredSeedPaths: [".zcode-plugin/plugin.json", "dist/server.mjs"]`, listing with author `PaySwap` and zh-CN description.
- documents/pdf/presentations/spreadsheets — produced by one `.map()` over tuples; `requiredSeedPaths` include skill bodies, `agents/visual-judge.md`, and the office-runtime artifacts `dist/server.mjs`, `dist/ui/assets.json`, `dist/ui/panel.html` (via `OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS`). Map-generated entries cannot be parsed by naive tooling — `official-plugin-audit.mjs` reports them as "generated; verify manually" instead of failing.
- `zcode-site` — UI plugin with commands + scripts + panels; required seed paths pin `commands/site-deploy.md`, `scripts/zcode-site.mjs`, `dist/server.mjs`, `dist/ui/panel.html`.
- `computer-use` — no `defaultEnabled`, `runtimeTopLevelPaths: ["node_modules"]`, tracks an upstream runtime version kept in sync by a producer workflow.
- `node-repl-host` — not user-facing (no listing, no market entry); exists purely to carry a shared runtime artifact (`dist/mcp/server.js`) that two capability plugins depend on.

## Mechanical checks that will fail the bootstrap suite if the definition drifts

- "keeps every bundled plugin package, manifest, and seed version aligned" — version triangle + every `requiredSeedPaths` exists on disk.
- "declares the ui component type exactly for bundled plugins with UI surfaces" — `componentTypes` ↔ `ui.surfaces`.
- "Settings 默认启用集合与 CLI 的官方插件声明一致" — default-enabled sets agree between bootstrap and CLI declarations.
- "rejects an incomplete Browser Use filesystem or SEA seed" — seed-path gate behavior.

## How to register (procedure)

1. Build the plugin once (`pnpm --filter @zcode/<name>-plugin build`) so `requiredSeedPaths` artifacts exist.
2. Insert the definition element (use `scaffold-official-plugin.mjs --definition-out` output as the starting block; keep the file's comment discipline and explain any non-default field).
3. Run `node skills/plugin-creator/scripts/official-plugin-audit.mjs <plugin-path> <repo-root>` — expect 0 errors.
4. Run the bootstrap mechanical tests: `pnpm --filter @zcode/bootstrap test plugins.test.ts` (version alignment + ui component type + default-enabled agreement).
5. Add the launch tests ([production-launch-testing.md](production-launch-testing.md)).
