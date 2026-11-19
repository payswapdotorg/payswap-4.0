---
name: plugin-creator
description: Create or update ZCode plugin source and a local test marketplace, then guide the user to add, install, update and try it in the app. Also creates official built-in or workspace plugins for the ZCode host repo itself: packaging, official registration, host service integration, UI surfaces and production launch tests. Use for new plugins or changes to an existing plugin's capabilities, manifest or local distribution.
---

# Plugin Creator

Deliver implemented plugin source, a local dev marketplace catalog, and precise UI instructions for the user to add the market, install/update the plugin and try it. For plugins destined to ship inside the ZCode host repo, deliver the official package, registration and launch-test wiring instead. Use ZCode manifests.

The current handoff is manual. Do not register markets, install/update/enable plugins, or publish as part of this skill. Ordinary Desktop users are not expected to have a global `zcode` CLI or `node` command. Use existing file tools when helper runtimes are unavailable; do not ask users to install development tooling to complete the UI steps. A skill reference alone has no plugin requirements: ask what the plugin should do before generating files.

## 0. Classify the request — three creation profiles

Pick exactly one profile before generating anything; record the choice and the reasons in the delivery.

| Profile | Choose when | Deliverable |
| --- | --- | --- |
| **1 — Local plugin** | The plugin is for the user's own use or testing, distributed via a local dev marketplace. | Plugin source + local marketplace catalog + manual UI handoff (sections 1–6). |
| **2 — Official built-in plugin** | The plugin ships inside the ZCode host repo for all users but holds no host-domain state: skills, commands, docs, or an MCP server talking to external services with user-provided config. | Plugin package + official definition registration + build + launch-test wiring (sections 7). |
| **3 — Official workspace plugin** | Profile 2 AND the plugin must read or act on host-owned domain state (accounts, documents, financials, device access, workspace data). | Everything in Profile 2 plus the host-service boundary, typed contracts, security review and the full acceptance chain (sections 7–9). |

Decision rules:

- "Official" means the plugin lives in the host repo (`apps/zcode-cli/packages/<name>-plugin`) and is registered in `bootstrap/src/app/official-plugin-definitions.ts` — not a marketplace listing.
- Requests naming a host domain (payments/accounts/documents/desktop control) are Profile 3 even if the user says "just a plugin".
- When unclear whether host services are needed, inspect the workspace first (section 0a) and choose the least-privileged profile that satisfies the request; record what would upgrade the classification.
- Upgrading Profile 2 → 3 later is a planned change (contract file first); do not silently grow a plugin into Profile 3.

### 0a. Security and consent review (run before implementing Profiles 2/3)

Read [workspace-plugin-security.md](references/workspace-plugin-security.md) and answer, in writing, before code: credential handling (the plugin process must work with zero credentials of its own), opt-in requirement (sensitive domains need a `userConfig` boolean defaulting to `false` and `defaultEnabled: false`), read-only vs privileged tools, UI surfaces as informational only (approvals are host-rendered), the plugin's own env namespace, and which tests will prove the model cannot bypass the boundary. Record unresolved decisions explicitly; choose repository-consistent defaults (opt out of new privileges). Never generate a credential-bearing plugin server when the architecture calls for a host-managed credential boundary — stage typed refusals instead.

## 1. Define the outcome and source

Read the target workspace's instructions. Reuse the user's choices for purpose, name, components and destination. Define a representative input and observable expected result for the capability; use it for the smoke test and final trial prompt.

Default source location: `<workspace>/plugins/<slug>/`. An explicit directory wins. Work on the target host for remote work. For an existing plugin, inspect its manifest and edit the original source while retaining its identity.

Read [the ZCode manifest reference](references/plugin-json-spec.md) before choosing components. This step is complete when the source location and acceptance example are concrete.

## 2. Create and implement

Create `.zcode-plugin/plugin.json` and only the components the plugin needs. The directory name and manifest name must match. Use the available file tools, or the optional bundled `scripts/create-basic-plugin.mjs` helper when Node is already runnable. Helper options and examples are in the manifest reference.

Implement the requested capability and replace generic scaffold descriptions with its purpose. The generated MCP server only implements a handshake and an empty tool list; implement real tools before reporting a working integration. Keep secrets in user-config/environment/credential mechanisms.

Preserve existing source. Ordinary iteration edits implemented files and increments the manifest's semantic version; it does not re-scaffold with `--force`. This step is complete when the requested files and behavior have been implemented, or a specific blocker is recorded.

## 3. Check what the environment can verify

Check manifest JSON, declared resource existence, directory/name consistency, path containment and unresolved placeholders. Run the representative capability smoke test with available tools. Report unavailable runtime or credential-dependent checks explicitly.

In an existing developer environment, `scripts/validate-plugin.mjs` can additionally invoke `zcode plugins validate`; use its `--cli` override only when an actual working entry is already known. This is optional developer verification, not a prerequisite or a command to give ordinary Desktop users. File inspection alone does not prove ZCode schema validation or runtime execution.

## 4. Prepare the local test marketplace

Unless the user requested source-only delivery, create or update `<workspace>/plugins/marketplace.json` beside the plugin directories. Its entry uses the plugin manifest's name, version and description, a relative source path, and appropriate display/localized metadata. Preserve unrelated entries, metadata and order.

When Node is available, use `scripts/upsert-dev-marketplace.mjs` with the actual plugin path. It returns the marketplace ID, full plugin ID and paths; its directory-based dev ID is stable. Pass an existing chosen catalog explicitly with `--marketplace-path` to retain its name. Without Node, use the file tools and the reference's catalog format, choose a distinct `dev-` prefixed name for a new market, and retain that saved name on later edits. Resolve same-name/different-source conflicts rather than replacing another entry or market.

Read [manual installation, updates and trial](references/installing-and-updating.md) for every handoff. This step is complete when the catalog and plugin files exist and their IDs, versions and paths agree. Creating the catalog does not register a market or install a plugin.

## 5. Guide the user's UI actions

Provide the actual market root directory and instruct the user to open **Plugin Marketplace → Add → Add Plugin Marketplace**, paste that directory, and add it. Then use **Personal → the actual market name → plugin → Install**. Follow the reference for updates and failures.

Give a concrete new-task trial prompt with its expected result. For a skill, tell the user to select the installed plugin/skill from the composer picker after installation. Only provide an installed `SKILL.md` reference if its actual path has been observed; a source path is not an installed reference. Preserve the user's disabled choices and explain any needed manual enable/configuration step.

## 6. Deliver with accurate status

Reply in the user's language with:

- Actual absolute source directory, marketplace root to paste, and catalog file path.
- Actual marketplace name, full plugin ID and source version.
- The manual add/install or refresh/update steps, and **Settings → Plugins** as the installed management entry.
- The trial prompt and expected result, plus checks completed and checks pending.
- Explicit status: market awaiting manual addition, plugin awaiting installation/update, and trial pending, unless completion has been observed or reported by the user. Mark an existing but unverified installation as unverified.

If the user has not completed the UI steps, stop with a usable handoff rather than performing them automatically or claiming success. For a reported error, keep the source, inspect the error and correct the relevant source/catalog issue. Public release remains separate from local testing.

## 7. Official plugin package and registration (Profiles 2 and 3)

Work inside the host repo checkout. Read [official-plugin-lifecycle.md](references/official-plugin-lifecycle.md) first — it is the authoritative end-to-end path with citations; [official-plugin-definition.md](references/official-plugin-definition.md) covers every registration field and the consent laws.

1. **Scaffold.** In `apps/zcode-cli/packages/`, generate the package with `scripts/scaffold-official-plugin.mjs <name> --tools <t1,t2,…> [--surfaces id:Title|zh,…] [--opt-in <option>] [--env-namespace <NS>] [--definition-out <file>]`. It produces the repo-conventional package (manifest with `mcpServers`/`ui.surfaces`/`userConfig`, `src/contract.ts` as single source of truth, typed-refusal server, informational panels, `main()` entry, esbuild build, vitest acceptance tests) and the `OfficialPluginDefinition` block. An official plugin never ships an empty tool list; every generated tool answers a typed envelope until its real handler is wired.
2. **Implement.** Replace the typed-refusal handlers with the real capability through the host boundary (Profile 3: [host-broker-integration.md](references/host-broker-integration.md)); extend `src/contract.ts`, never a second source of truth. Reuse existing host infrastructure (brokers, permission/session context, shared packages) before proposing new machinery.
3. **Register.** Insert the definition into `OFFICIAL_PLUGIN_DEFINITIONS` (`bootstrap/src/app/official-plugin-definitions.ts`), keeping `package.json` version = manifest version = definition version, `requiredSeedPaths` pinning every runtime artifact, and `componentTypes: ["ui"]` exactly when `ui.surfaces` is declared. Sensitive workspace plugins keep `defaultEnabled: false`; `alwaysLoad: true` is never user consent.
4. **Build and audit.** `pnpm install && pnpm --filter @zcode/<name>-plugin build`, then `node <skill-root>/scripts/official-plugin-audit.mjs <plugin-path> <repo-root>` — fix every error it reports (registration, version triangle, seed paths/build outputs, ui surface rules, `main()` export, empty tools, env boundaries) before running tests.
5. **Test.** Follow [production-launch-testing.md](references/production-launch-testing.md): package vitest suite, bootstrap mechanical tests (`plugins.test.ts`), a real `bootstrap/tests/<name>-launch-path.test.ts` and a real `bootstrap/tests/<name>-host-launch.test.ts`. No mocked launch acceptance; no empty tool lists reported as done.
6. **UI surfaces (if any).** Follow [ui-surface-integration.md](references/ui-surface-integration.md): manifest-declared, mcp-app MIME resources, static informational skeletons until real data lands, seed paths pinning panel assets.

Do not rewrite host machinery (seed, resolver, dispatch) for a new plugin unless a cited gap exists — propose it as a recorded decision instead.

## 8. Profile 3 acceptance chain

A Profile 3 plugin is done only when all of these are real:

- Typed contract tests pin tool list, refusal taxonomy arms, and envelope separation ([payswap-reference-pattern.md](references/payswap-reference-pattern.md) maps each to the PaySwap test that proves it).
- Security boundary tests: authoritative plugin id in resolved env, refusals in both opt-in arms on real processes, panels carrying no data while opted out, and — where broker credentials exist — impostor/stale-credential rejection.
- Production build + official seeding + production host launch tests execute verbatim resolved commands (Layer 5).
- A real user-journey acceptance prompt (enable → opt-in → representative task) is handed to the user; mark it pending until observed.

## 9. Updating an existing official plugin

Edit the original package; increment all three versions together (package.json, manifest, definition). Bump `version` even when only `requiredSeedPaths` content changes — the seed cache is version-addressed. Re-run the audit and the launch tests. Never edit installed caches; never re-scaffold implemented source. For distribution or release questions beyond the repo, that is a separate workflow from this skill.
