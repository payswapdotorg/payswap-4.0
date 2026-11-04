# PaySwap 4.0 P0 — Worker 1: Source-Verified ZCode Feature Inventory

- Audit basis: worktree `/home/z/work-p0-w1`, branch `p4/p0-w1`, base `a9fe401` ("chore: sync ZCode source v3.17.2").
- Method: read-only audit. Every claim below cites repository paths that were actually opened or searched with `ls`/`Read`/`rg`. Documentation was used only to locate features; ownership statements are backed by source files.
- Symbols are quoted exactly as they appear in source.
- Where a feature could not be verified, it is marked **UNVERIFIED** with what was checked.
- Related worker inputs: this inventory feeds `02-preservation-matrix.md` (same directory).

## 0. Repository shape (verified)

- Root `package.json` name `zcode`, version `3.17.2`, `private: true`, pnpm workspace, `packageManager: pnpm@10.33.2`, engines `node >=24.0.0`.
- Workspace packages (`packages/`): `android`, `client`, `desktop`, `e2e-report`, `formal-proof`, `model-option-map`, `provider`, `provider-node`, `rpc`, `server`, `services`, `share-ui`, `shared`, `stream-animate`, `ui`, `web`, `web-share`, `zcode-cua`, `zcode-server-cli`.
- Apps: `apps/zcode-cli` (Agent CLI + runtime; its own pnpm workspace with packages `adapters`, `bootstrap`, `browser-use-plugin`, `cli`, `contracts`, `core`, `dynamic-workflow`, `dynamic-workflow-runtime`, `tui`, `node-repl-host`, `superpowers-plugin`, `zcode-cua-plugin`, `bundled-skills`, etc.), `apps/dev-docs`.
- Root gate commands (root `package.json`): `pnpm typecheck`, `pnpm lint` (oxlint), `pnpm fmt:check` (oxfmt), `pnpm verify:pre-push`, `pnpm architecture:check --changed`, `pnpm test:engineering`, `pnpm test:engineering:affected --scope push`, `pnpm db:schema:check`, `pnpm knip`, `pnpm test:e2e` (→ `@zcode/desktop` WDIO), `pnpm test:architecture`.
- `AGENTS.md` (root) is the governing agent instruction set; `apps/zcode-cli/AGENTS.md` governs the CLI.
- Architecture policy: `architecture-policy.yaml` (root) — module map with `managed`/legacy modules and per-file exceptions; enforced by `pnpm architecture:check` (`scripts/architecture/`).
- **Critical testing fact** (from `docs/testing/unit-test-quality.md` + root `package.json` + `vitest.config.ts`): App business unit tests were **retired 2026-10-26**. Current automated behavior guards are: desktop E2E (WDIO, `packages/desktop/test/e2e/`), engineering/tooling Vitest (explicit list `scripts/engineering-test-files.json`, 158 files), CLI tests (`apps/zcode-cli`, per-package `tests/`, ~850+ files), CUA package tests (`packages/zcode-cua/test/availability.test.ts`), architecture/schema/lint/typecheck gates. There are **no unit tests** under `packages/ui`, `packages/services`, `packages/shared`, `packages/provider*`, `packages/rpc`, `packages/client`, `packages/server`, `packages/web`.
- Pre-existing semantic feature graph: `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` — 415 nodes (`rg -c "^  - id:"` = 415), each node carrying `codeSeeds` (file + symbol). This is upstream's own machine-readable feature→code map and is directly reusable for PaySwap regression planning.

---

## 1. Conversation lifecycle & the New Task page (V4 chat)

**What it is.** The primary user surface: a workspace tab contains a task (conversation); the user creates a "New Task", types prompts with attachments/mentions, watches streamed assistant/tool turns rendered from the V4 product projection, and manages queue, stop, edit, fork, compact, goal. The renderer is a read-only projection consumer; the CLI runtime owns conversation truth.

- **Source ownership**: `packages/ui/src/v4/` (176 files). Key files: `SessionPane.tsx` (6238 lines, main session surface), `V4ChatPane.tsx`, `ConversationTimeline.tsx`, `ConversationRowView.tsx`, `ConversationComposer.tsx`, `conversationProjectionStore.ts`, `agentConversationTransport.ts`, `sessionDataLayer.ts`, `ConversationQueuePanel.tsx`, `ConversationGoalBanner.tsx`, `ConversationFileRewindDialog.tsx`, `composer/composerDraftStore.ts` (draft persistence), `pendingCommandRegistry.ts`.
- **Key symbols**: `SessionPane`, `ConversationTimeline`, `conversationProjectionStore`, `agentConversationTransport`, `useConversationProjection`, `ConversationComposer`, `V4InteractionDialogs`, `useZCodeSessionStore` (see §26).
- **Entry points / callers**: `packages/ui/src/Root.tsx` → `RootShell`/`RootWorkspaceContent` → `SessionPane`; New Task entry: `packages/ui/src/NewTaskButtonGroup.tsx`, `WelcomeScreen.tsx`, `TaskList.tsx`; creation path calls `IZCodeTaskService.createTask` (`packages/services/src/session/zcodeTaskService.ts:204`).
- **State/persistence owner**: CLI runtime is the authority (V4 product projection in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`); renderer keeps only projections/drafts (`composerDraftStore`, `conversationProjectionStore`). Session/task records persist via `ZCodeSessionService` + `tasksDatabase` (SQLite, `packages/services/src/session/tasksDatabase/`).
- **Existing tests/gates**: 375 WDIO specs in `packages/desktop/test/e2e/conversation-session/*.test.ts` (verified count via `ls …/*.test.ts | wc -l`; plus 146 more in `manual-review/pending/` not yet in the automated lane), including `conversation-session-compact*.test.ts`, `conversation-session-fork-*.test.ts`, `conversation-session-goal*.test.ts`, `conversation-session-queue-operations.test.ts`, `conversation-session-model-switch-queue.test.ts`, `conversation-session-v4-rewind-*.test.ts`. Engineering support: `packages/desktop/test/conversationSessionNetwork.test.ts`, `conversationTurnEvidence.test.ts`, `e2eV4TurnCompletion.test.ts`. Coverage audits: `docs/testing/conversation-session-e2e-coverage-matrix.md`, `docs/testing/conversation-session-case-coverage-audit.md`, gate `pnpm audit:conversation-session-coverage`.

## 2. ZCode Protocol V4 (agent↔client protocol authority)

**What it is.** The typed, runtime-validated wire protocol between the Agent CLI runtime and all clients (desktop renderer via stdio→host, mobile replayable chain, bots). Defines sessions, commands, queue (`CommandInbox`), snapshots, workflow runs, input intent/prediction.

- **Source ownership**: shared schema `packages/shared/src/zcode-protocol-v4/` (`command.ts`, `snapshot.ts`, `wire.ts`, `wire-codec.ts`, `transport.ts`, `workflow-runs-*.ts`, `input-prediction/`, `sessions-index.ts`, ...); CLI-side authority `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` (`product-projection.ts`, `command-inbox.ts`, `commands/` handlers, `queue-auto-drain.ts`, `projection-rows.ts`); legacy protocol types `packages/shared/src/zcode-protocol-legacy-types.ts` and `packages/shared/src/zcode-protocol/`.
- **Key symbols**: `ZCodeTaskSnapshot`, `CommandInbox`, `product-projection`, `wire-codec`, `clientMode` enum `"desktop-continuous" | "web-remote-replayable"` (`packages/shared/src/validation.ts:803,1580`).
- **Entry points / callers**: protocol crosses Electron stdio (`packages/services/src/zcode-agent/zcodeStdioTransport.ts`, `zcodeProtocolClient.ts`) and the mobile relay chain (`packages/client`).
- **State/persistence owner**: CLI runtime owns sessions/queue; `ZCodeTaskSnapshot.runtime` is ephemeral runtime supplement and is never written back to session JSON (per domain map; consistent with `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` file layout).
- **Existing tests/gates**: heavy E2E (whole `conversation-session-*` suite), CLI tests (`apps/zcode-cli/packages/bootstrap/tests/`, 238 files; `apps/zcode-cli/packages/contracts/tests/event-reducer.test.ts` etc.), engineering `packages/desktop/test/e2eModelProviderReplayContract.test.ts`. `AGENTS.md` mandates: protocol changes must update `packages/shared/src/zcode-protocol/index.ts` (legacy entrypoint; still present alongside v4).

## 3. Agent runtime & process management (CLI core loop)

**What it is.** The Node.js coding-agent runtime: long-running agent loop, tool scheduling, provider adapters, TUI. Spawned per workspace by the desktop host over stdio; also runs standalone as a terminal CLI.

- **Source ownership**: `apps/zcode-cli/packages/core/src/` (`runtime.ts`, `runtime/`, `agent/`, `tool/`, `tool/handlers/`, `permission/`, `memory/`, `subagent/`, `workflow/`, `compact/`, `context/`, `session-context/`, `runtime-task/`); process spawning on app side: `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`, `zcodeAgentService.ts` (7471 lines), `zcodeStdioTransport.ts`, `zcodeProtocolTransport.ts`.
- **Key symbols**: `ZCodeAgentProcessManager`, `createZCodeAgentService`, `ZCodeAgentService` (interface `IZCodeAgentService` in `packages/services/src/zcode-agent/zcodeAgent.ts:650`, 1089 lines of service surface), `PermissionService` (`apps/zcode-cli/packages/core/src/permission/service.ts:90`).
- **Entry points / callers**: CLI entry `apps/zcode-cli/packages/cli/src/main.ts` (`void main()`, protocol vs TUI invocation); desktop spawns via host (one CLI per workspace, shared for projectless tasks — invariant recorded in `zcode-feature-graph.yaml` node `capability.shared-task-cli`, codeSeeds `ZCodeAgentProcessManager`).
- **State/persistence owner**: runtime session state in CLI session files + SQLite (task index); host keeps no task/session business state (root `AGENTS.md` "Main 负责窗口… 不承载 task/session 业务状态").
- **Existing tests/gates**: `apps/zcode-cli` per-package tests (core 289, bootstrap 238, adapters 166, contracts 44, tui 29, cli 27 files — verified by directory counts); `pnpm --dir apps/zcode-cli typecheck` / `test` per `apps/zcode-cli/AGENTS.md`; E2E `packages/desktop/test/e2e/workspace-agent-warmup-lifecycle.test.ts`, `workspace-removal-runtime-release.test.ts`, `confirmedProcess.test.ts`.

## 4. Session management (multi-session, resume, fork, draft registry)

**What it is.** Creation/restoration/forking of agent sessions; draft sessions before first prompt; session import/repair for external (Claude) sessions.

- **Source ownership**: `packages/services/src/zcode-session/` (`zcodeSession.ts` — `IZCodeSessionService` at line 142, `zcodeSessionService.ts`, `zcodeSessionDraftRegistry.ts`, `importedClaudeSessionRepair.ts`, `zcodeSessionApiRetry.ts`); CLI side `apps/zcode-cli/packages/bootstrap/src/sessions.ts`, `session-lifecycle/` (managed module with CONTRACT.md/contract.ts), `session-execution/`, `session-transcript.ts`, `zcode-protocol-v4/cold-session-resume.ts`.
- **Key symbols**: `IZCodeSessionService`, `zcodeSessionDraftRegistry`, `session-lifecycle/controller.ts`, `cold-session-resume`.
- **Entry points / callers**: `IZCodeTaskService` wraps it for UI; bots/host use `v4Create` drafts (see `createTask` params in `zcodeTaskService.ts:204-231`).
- **State/persistence owner**: CLI session files + `tasksDatabase` SQLite; UI draft registry is host-side ephemeral.
- **Existing tests/gates**: E2E `conversation-session-config-and-multisession.test.ts`, `conversation-session-attachment-resume.test.ts`, `conversation-session-anthropic-reasoning-history-replay.test.ts`, `conversation-session-fork-*.test.ts`, `conversation-session-chat-loading-live-tail.test.ts`; engineering `packages/desktop/test/e2eSqliteReadiness.test.ts`, `e2eRemoteSessionDatabaseFault.test.ts`.

## 5. Task list, history & the tasks SQLite index

**What it is.** The workspace task list (open/archived/grouped tasks, task titles, search), the cross-session history index, automation/off-peak rows, and task groups — persisted in `tasks-index.sqlite`.

- **Source ownership**: repo `packages/services/src/session/taskIndexRepo.ts`, `tasksDatabase/` (`schema-v1.ts`, `migrations.ts`, `controller-remote-schema-v4.ts`, `source-server-schema-v5.ts`, `provider-selection-v2.ts`, `official-glm-selection-v3.ts`, `prepared.ts`), `task-groups/`, `zcodeTaskListTypes.ts`; UI `packages/ui/src/TaskList.tsx`, `TaskListItem*.tsx`, `TaskSearchDialog.tsx`, `TaskRenameDialog.tsx`, `DeleteAllArchivedTasksButton.tsx`, `workspace-grouped-tasks/`, `v4/sessionsIndexStore.ts`, `v4/useSessionsIndex.ts`, `windowControllerTaskListRegistry.ts`.
- **Key symbols**: `TaskIndexRepo`, `ZCodeTaskListQuery`, `sessionsIndexStore`, `TaskList`.
- **Entry points / callers**: sidebar workspace view via `useGlobalTaskList`/`useWorkspaceSessionsIndexItems` hooks (`packages/ui/src/hooks/`).
- **State/persistence owner**: `tasks-index.sqlite` per workspace identity, written only through `taskIndexRepo.ts` / scheduler; schema guarded by `pnpm db:schema:check` (`scripts/test/sqlite-schema-contract.test.mjs` + `scripts/check-sqlite-schema.ts`).
- **Existing tests/gates**: E2E `conversation-session-archive-management.test.ts`, `task-list-archive-confirmation.test.ts`, `conversation-session-history-first.test.ts`; docs `docs/task/task-sqlite-index.md`; schema gate above. Note: `taskIndexRepo.ts` itself has **no unit test** (App unit tests retired) — it is covered indirectly by E2E and `db:schema:check`.

## 6. Model selection, model registry & provider configuration

**What it is.** Provider registry (built-in + custom OpenAI-compatible/Anthropic/z.ai/bigmodel providers), model/reasoning-level selection persisted per workspace/task, provider settings UI, account providers (Coding Plan), builtin provider config download/refresh, provider endpoint routing, model facade used by runtime.

- **Source ownership**: `packages/provider/src/` (`registry.ts` — `ProviderRegistry` class, `registry-service.ts`, `resolver.ts`, `config-service.ts`, `config-overlay.ts`, `effective-model-selection.ts`, `model-selection-config.ts`, `account-provider-*.ts`); `packages/provider-node/src/` (`model-selection-config-repository.ts`, `personal-provider-config-repository.ts`, `provider-config-runtime.ts`, `zcode-builtin-*.ts` download/materializer/remote-synchronizer); `packages/services/src/model-provider/` (`providerRuntime.ts`, `providerFacadeServices.ts` — `IModelSelectionService`, `IProviderSettingsService`, `providerProvisioning.ts`, account provider credential services); `packages/model-option-map/` (option map parser/compiler/evaluator used by adapters); runtime side `apps/zcode-cli/packages/adapters/src/model/` (`model-execution.ts`, `model-option-map-fetch.ts`, `endpoint-routing-edition/`); UI `packages/ui/src/settings/ModelProviderSection.tsx`, `chat-input-toolbar/ComposerModelMenu.tsx`, `ComposerProviderMenu.tsx`, hooks `useModelProviders.ts`, `useModelSelectionView.ts`, `useProviderSettingsView.ts`.
- **Key symbols**: `ProviderRegistry`, `ProviderRegistryView`, `ModelSelection`, `IModelSelectionService`, `IProviderSettingsService`, `effective-model-selection`, `BUILTIN_MODEL_PROVIDER_IDS` (`packages/shared/src/model-provider-types.ts`), `HIGHSPEED_PROVIDER_IDS` (§22).
- **Entry points / callers**: composer toolbar menus; settings page; `createTask({ modelSelection })`; runtime `defaultModelRef` (domain map cross-axis).
- **State/persistence owner**: provider registry + selection config on disk via `provider-node` repositories; app-global registry with per-workspace overrides (`legacyPersonalProviderConfigImporter.ts` exists for migration).
- **Existing tests/gates**: E2E `packages/desktop/test/e2e/settings/provider-*.test.ts` (9 files incl. `provider-builtin-refresh.test.ts`, `provider-model-smart-config.test.ts`, `provider-settings-write-recovery.test.ts`), `upstream-provider.test.ts`, `provider-family-responsive.test.ts`, `conversation-session-model-switch-*.test.ts`, `conversation-session-composer-provider-identity.test.ts`; engineering `customOpenAIProviderStore.test.ts`, `modelProviderCatalogE2EMock.test.ts`, `modelProviderRestart{Config,Runtime,Workspace}.test.ts`, `upstreamReplayServer.test.ts`, `providerRefreshWorkspace.test.ts`, `upstreamProviderPreferenceSeed.test.ts`; CLI `apps/zcode-cli/packages/adapters/tests/model-option-map-fetch.test.ts` + auth/model wire tests. Coverage docs: `docs/testing/model-selection-regression-*.md/yaml`, `docs/testing/model-trajectory-e2e-coverage-matrix.md`, `docs/testing/provider-settings-batch-20260910.md`.

## 7. MCP integration

**What it is.** Model Context Protocol servers: user-directory CLI MCP config, native MCP servers, per-workscope trust, MCP elicitation, status snapshots, remote (SSH) MCP sync, and MCP Apps (hosted app tools + sampling for plugin UIs).

- **Source ownership**: `packages/shared/src/mcp.ts`, `mcp-sync.ts`, `mcp-apps/` (`contract.ts`, `hostContract.ts`, `appTools.ts`, `sampling.ts`, `schemas.ts`); services `packages/services/src/mcp-sync/`, `packages/services/src/session/mcpWorkspaceScope.ts`; UI `packages/ui/src/store/mcpStore.ts` (+ `mcpStoreDesktop.ts`, `mcpStoreHelpers.ts`, `mcpStoreMigration.ts`, `mcpStoreStatusList.ts`), `packages/ui/src/settings/McpServerForm.tsx`, `McpServerList.tsx`, `McpSettingsSection.tsx`; CLI `apps/zcode-cli/packages/core/src/mcp/`, `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts`, `workspace-mcp-trust/`; agent surface methods on `IZCodeAgentService` (`ZCodeMcpListResult`, `ZCodeMcpUiCallToolResult`, `WorkspaceMcpTrustDecision` — imports at top of `packages/services/src/zcode-agent/zcodeAgent.ts`).
- **Key symbols**: `ZCodeAgentMcpServer`, `McpServerStatus`, `mcpStore`, `ServiceChannels.McpSync`, `convertToZCodeAgentMcpServer`, `PluginSandboxPlatformPort` (`packages/shared/src/mcp-apps/contract.ts`).
- **Entry points / callers**: settings page MCP section; workspace load `useEnsureWorkspaceMcpLoaded.ts`; V4 dialogs for elicitation (`V4InteractionDialogs.tsx`).
- **State/persistence owner**: user `~/.zcode` CLI MCP config + per-scope store files; runtime MCP list owned by agent process; UI `mcpStore` is a projection.
- **Existing tests/gates**: E2E `conversation-session-plugin-mcp-skill-*.test.ts` (8 files covering installed/disabled/workspace-scope matrix), `settings/mcp-dual-era-version-negotiation.test.ts`, `conversation-session-plan-mode-mcp-permission.test.ts`; engineering `mcp-image-payload-test-server.mjs` consumers; docs `docs/mcp-platform-boundary.md`, `docs/testing/hooks-e2e-coverage-matrix.md` (MCP trust adjacency).

## 8. Plugins & the plugin store/marketplace lifecycle

**What it is.** Plugin discovery from marketplaces (official `zcode-plugins-official`, inline, custom marketplace sources incl. Claude/Codex marketplace triplets), install/uninstall/enable/disable per scope (user/workspace), plugin settings UI surfaces, plugin sandbox (iframe + `ui://` bridge), plugin sync to remote, bundled/official plugins.

- **Source ownership**: `packages/shared/src/plugin-types.ts`, `plugin-marketplaces.ts`, `plugin-sync.ts`, `pluginStoreOrder*.ts`, `plugin-display-name.ts`; services `packages/services/src/plugins/` (`pluginsService.ts`, `pluginManagementService.ts`, `installedPluginRoots.ts`, `officialPluginCache.ts`) and `plugin-sync/`, `plugin-ui-bridge/` (host reads `ui://`, proxies tool calls); UI `packages/ui/src/store/pluginStore.ts`, `pluginManagementStore*.ts`, `packages/ui/src/settings/Plugin*.tsx` (store page, detail view, sources dialog, uninstall confirm), `workspace-plugin-preview/`, `plugin-ui/`; sandbox runtime `packages/desktop/src/renderer/src/plugin-sandbox/` (+ `packages/desktop/src/main/pluginSandbox/`, `packages/desktop/src/host/pluginSandbox/`); CLI plugins `apps/zcode-cli/packages/bootstrap/src/plugins.ts`, `apps/zcode-cli/packages/cli/src/plugins-command.ts`, `plugins-marketplace-command.ts`, `plugin-host-command.ts`, plus plugin packages (`superpowers-plugin`, `browser-use-plugin`, `image-search-plugin`, `pdf-plugin`, `spreadsheets-plugin`, `presentations-plugin`, `documents-plugin`, `office-runtime`, `visualize-plugin`, `skill-creator-plugin`, `plugin-creator-plugin`, `restore-legacy-sessions-plugin`, `android-emulator-plugin`, `ios-simulator-plugin`).
- **Key symbols**: `IPluginsService`, `IPluginManagementService`, `IPluginSyncService`, `ServiceChannels.Plugins`/`PluginManagement`/`PluginUiBridge`/`PluginUiAppTools`, `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` (`packages/shared/src`, imported by `skillsService.ts`), `pluginStore`, `pluginManagementStore`.
- **Entry points / callers**: settings plugins section; plugin store page; slash commands contributed by plugins (`slashCommandPanelSections.tsx`); E2E container `test:e2e:container:plugins`.
- **State/persistence owner**: plugin roots on disk (`installedPluginRoots.ts`), enabled-state in scoped settings via `pluginManagementService`; store order persisted (`pluginStoreOrder.ts`).
- **Existing tests/gates**: 15 specs in `packages/desktop/test/e2e/plugins/` (lifecycle, persistence, market UI, CDN zip install, concurrent install, subagent override cold start, telemetry); engineering `pluginE2EAdmissionScripts.test.ts`, `pluginMarketStartupCredentials.test.ts`; CLI `apps/zcode-cli/packages/cli/tests` plugin command tests; container gate `pnpm test:e2e:container:plugins`; docs `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md`, `docs/claude-code-marketplace-plugin-compat.md`.

## 9. Skills

**What it is.** Skill (SKILL.md) discovery across user dir, workspace, plugins and bundled skills; enable/disable and capability projection; remote skill sync; agent-side skill commands; repo-local `.agents/skills/*` for development agents.

- **Source ownership**: `packages/shared/src/skills-types.ts`, `skill-sync.ts`, `skill-scan-policy.ts`; services `packages/services/src/skills/` (`skillsService.ts` — discovery/validation/status, `skillDiscoveryWalk.ts`), `skill-sync/`; UI `packages/ui/src/store/skillStore.ts`, `settings/SkillsSection.tsx`, hook `useSkills.ts`; CLI `apps/zcode-cli/packages/bootstrap/src/skills.ts`, `skill-command-overrides.ts`, `bundled-skills/skills/dynamic-workflows/` (SKILL.md + examples + patterns); dev skills `.agents/skills/` (11 skills incl. `feature-boundary-planner`, `architecture-governance`, `session-management`).
- **Key symbols**: `ISkillsService`, `ISkillSyncService`, `SkillSummary`, `SKILL_FILE_NAME` ("SKILL.md"), `walkSkillMarkdownPaths`, `skillStore`.
- **Entry points / callers**: settings skills section; slash-command surface (`slash-command-surface.ts` in bootstrap); plugin-bundled skills via plugin roots.
- **State/persistence owner**: skills discovered from disk; per-skill state in `~/.zcode/v2` `_meta.json` + CLI config (`SKILL_SETTINGS_DIR` constants in `skillsService.ts`).
- **Existing tests/gates**: E2E `conversation-session-plugin-mcp-skill-*.test.ts` (matrix incl. workspace isolation), `plugin-management-discovery-presentation.test.ts`; CLI bootstrap tests; **no dedicated skills unit test in packages/services** (retired) — finding.

## 10. Hooks (workspace hooks)

**What it is.** User-configurable hooks that run on agent events (lifecycle/tool events) with per-workspace config discovery, trust review (digest/monotonicity), mutation, and remote (R3) hook execution.

- **Source ownership**: `packages/shared/src/hooks.ts`, `workspace-hook-config.ts`, `workspace-hook-digest.ts`, `workspace-hook-discovery.ts`, `workspace-hook-mutation.ts`, `workspace-hook-review-monotonicity.ts`, `workspace-hook-trust-store-file.ts`; services `packages/services/src/hooks/` (`hooksService.ts`, `workspaceHookConfigMutation.ts`, `workspaceHookSettingsModel.ts`); UI `packages/ui/src/store/hooksStore.ts`, `workspaceHookReviewStore.ts`, `settings/HooksSection.tsx`, `HookForm.tsx`, `HooksList.tsx`, `WorkspaceHookTrustNotice.tsx`; CLI `apps/zcode-cli/packages/core/src/hooks/`, `apps/zcode-cli/packages/bootstrap/src/workspace-hook-trust-cli.ts`, `apps/zcode-cli/packages/cli/src/hooks-trust-command.ts`.
- **Key symbols**: `IHooksService`, `hooksStore`, `workspaceHookReviewStore`, `ServiceChannels.Hooks`.
- **Entry points / callers**: settings hooks section; workspace open triggers discovery + trust review flow.
- **State/persistence owner**: workspace hook config files on disk + trust store file; UI stores are projections.
- **Existing tests/gates**: E2E `conversation-session-hooks-lifecycle.test.ts`, `conversation-session-hook-trust.test.ts`, `conversation-session-r3-hooks-local-scope.test.ts`, `conversation-session-r3-remote-hooks.test.ts`, `conversation-session-permission-hook-race.test.ts`, `conversation-session-permission-hook-rewrite.test.ts`; engineering `create-workspace-hook-trust-uat-fixture.mjs` + `scripts/test/` UAT; docs `docs/testing/hooks-e2e-coverage-matrix.md`, `docs/testing/workspace-hook-trust-manual-acceptance.md`.

## 11. Subagents

**What it is.** Agent-defined subagent profiles (frontmatter markdown, general-purpose/explore built-ins), per-subagent model overrides, runtime task registry, drilldown UI, background subagents, MCP/tool borrowing.

- **Source ownership**: `packages/shared/src/subagents-types.ts`, `subagent-profile*.ts`, `subagent-state-migration.ts`, `subagent-runtime-config.ts`, `subagent-markdown-selection.ts`; services `packages/services/src/subagents/` (`subagentsService.ts`, `subagentStorage.ts`, `subagentModelSelection.ts`, `subagentConfigScope.ts`); UI `packages/ui/src/store/subagentsStore.ts` (+`Loading`, `ContextStore`), `v4/SubagentDrilldown.tsx`, `settings/SubagentsSection.tsx`, `SubagentReasoningField.tsx`; CLI `apps/zcode-cli/packages/core/src/subagent/` (`runner.ts`, `definitions.ts`, `general-purpose.ts`, `explore.ts`, `tool-policy.ts`, `runtime-task-registry.ts`, `computer-use-policy.ts`, `borrowed-mcp-port.ts`), `apps/zcode-cli/packages/bootstrap/src/subagents.ts`, `runtime-subagents/`.
- **Key symbols**: `ISubagentsService`, `subagentsStore`, `subagentStorage`, `runner.ts` subagent runner.
- **Entry points / callers**: settings subagents section; runtime spawns via coordinator; mentions `@` in composer (`ChannelMentionContent`/mention panel).
- **State/persistence owner**: subagent profiles on disk (per-scope storage); runtime registry in CLI.
- **Existing tests/gates**: E2E `conversation-session-built-in-subagent-model-overrides.test.ts`, `conversation-session-background-subagent-rate-limit.test.ts`, `conversation-session-plugin-subagent-override-cold.test.ts`, `conversation-session-plugin-reference-subagent.test.ts`, `conversation-session-browser-use-subagent-boundary.test.ts`, `subagent-coding-plan-login-catalog-stale.test.ts`; engineering `subagentConfigProxy.test.ts`, `subagentSettingsReadiness.test.ts`, `subagentSnapshotWait.test.ts`; docs `docs/testing/subagents-built-in-model-overrides-e2e-coverage-matrix.md`.

## 12. Automations (scheduled tasks) & the cron scheduler process

**What it is.** User-defined recurring/one-shot scheduled prompts ("定时任务") with schedule rules (minute…yearly, cron compat display), lifecycle statuses, run history, and a dedicated Electron utility process that claims due automations from SQLite and dispatches them to workspace hosts.

- **Source ownership**: types `packages/shared/src/automation-types.ts` (`AUTOMATION_CREATE_LIMIT = 20`, `ZCodeAutomationScheduleRule`); services `packages/services/src/session/automationService.ts` (`AutomationService` at line 71), `automationRepo.ts` (`AutomationRepo.claimDue`), `automationCron.ts`, `automationCronValidation.ts`, `automationIntervalCarrier.ts`; scheduler process `packages/desktop/src/scheduler/` (`index.ts` — resident cron scheduler via `electronUtilityProcess.fork`, protocol `schedulerProtocol.ts`, `manualClaimRelease.ts`, `offPeakDispatchSettlement.ts`); host dispatch `packages/desktop/src/host/cronRunLifecycle.ts`, `cronBotDelivery.ts`, `automationModelSelection.ts`; UI `packages/ui/src/store/automationManagementStore.ts`, `settings/AutomationsSection.tsx`, `AutomationEditView.tsx`, `automationTemplateCatalog.ts`, `v4/ConversationQueuePanel` adjacency, `AutomationsMainBreadcrumbFrame.tsx`.
- **Key symbols**: `AutomationService`, `AutomationRepo`, `ZCodeAutomation`, `automationManagementStore`, `schedulerProtocol`.
- **Entry points / callers**: settings automations section; scheduler utility process; bot delivery for Feishu targets (`ZCodeAutomationBotDeliveryTarget`).
- **State/persistence owner**: `tasks-index.sqlite` tables `automation` / `automation_runs` (stated in `automation-types.ts` header comment); scheduler is the only claimer.
- **Existing tests/gates**: E2E `automations-create-manage.test.ts`, `automations-custom-monthly-interval.test.ts`, `automations-custom-yearly-schedule.test.ts`, `automations-workflows-hub.test.ts`, `conversation-session-automation-cron-{create,relative,update}.test.ts`, `conversation-session-automation-pause-self.test.ts`, `conversation-session-automation-run-title-stable.test.ts`; engineering `dynamicWorkflowConfigMockServer.test.ts` (adjacent); docs `docs/automation-*.md` (7 docs), `docs/testing/automation-workspace-selection-boundary.md`.

## 13. Off-peak tasks (闲时任务)

**What it is.** Deferred "run at idle hours" tasks: queue of off-peak task definitions, eligibility, resident executions, notifications, and scheduler recovery — deliberately separate table/service from automations.

- **Source ownership**: `packages/services/src/session/offPeakTask.ts` (`IOffPeakTaskService`), `offPeakTaskRepo.ts`, `offPeakTaskService.ts`, `offPeakResidentExecutions.ts`, `offPeakRuntimeModel.ts`, `offPeakServerClient.ts`, `offPeakMockGateway.ts`, `offPeakWorkspaceIdentityMigration.ts`; shared `packages/shared/src/off-peak-types.ts`, `off-peak-execution.ts`; scheduler claim logic in `packages/desktop/src/scheduler/index.ts` (no misfire-skip semantics, per header comment); UI `packages/ui/src/v4/OffPeakNewTaskEntry.tsx`, `settings/OffPeak*.tsx` (edit view, history tab, task list, template icon), hooks `useOffPeakEligibility.ts`, `useOffPeakTaskNotifications.ts`, store `offPeakTaskStore.ts`.
- **Key symbols**: `IOffPeakTaskService`, `OffPeakTaskRepo`, `ZCodeOffPeakTask`, `offPeakTaskStore`, `ServiceChannels.OffPeakTask`.
- **Existing tests/gates**: E2E `off-peak-automations-home-layout.test.ts`, `off-peak-create-manage.test.ts`, `off-peak-limit-pre-gate.test.ts`; docs `docs/testing/r3-remote-automation-*.md` (remote matrix), `docs/coding-plan/` usage adjacency.

## 14. Dynamic workflows (saved workflows / workflow runs)

**What it is.** The agent-authored workflow system: `create_workflow`/`amend_workflow`/`fill_workflow_hole` tools, workflow drafts, run settings, run directory, artifacts, holes/notifications, saved-workflow hub, availability mode setting, and the workflow runtime package.

- **Source ownership**: `apps/zcode-cli/packages/dynamic-workflow/` (analysis engine incl. `causality-order-*`), `dynamic-workflow-runtime/`; CLI handlers `apps/zcode-cli/packages/core/src/tool/handlers/create-workflow*.ts`, `amend-workflow*.ts`, `fill-workflow-hole*.ts`, `workflow-entrypoints/`; contracts `apps/zcode-cli/packages/contracts/src/tools/*workflow*`; protocol `packages/shared/src/zcode-protocol-v4/workflow-*.ts` (runs actor, caps, concurrency, delta, entries, eviction, holes, artifacts, rejections); UI `packages/ui/src/v4/workflow*.ts(x)` (`workflowDraftJoin.ts`, `workflowRunDirectoryModel.ts`, `workflowResumeGate.ts`, `WorkflowNotification*.tsx`), `packages/ui/src/store/savedWorkflowStore.ts`, `workflowRunSavedStore.ts`, `dynamicWorkflowAvailabilityStore.ts`, `settings/saved-workflows/`, `DynamicWorkflowModeSetting.tsx`; shared `packages/shared/src/dynamic-workflow-feature.ts`.
- **Key symbols**: `CREATE_WORKFLOW`/`AMEND_WORKFLOW`/`FILL_WORKFLOW_HOLE` tool names (imported in `core/src/permission/service.ts` as `AMEND_WORKFLOW_TOOL_NAME`, `FILL_WORKFLOW_HOLE_TOOL_NAME`), `savedWorkflowStore`, `DynamicWorkflowMode`.
- **State/persistence owner**: workflow drafts/runs inside agent sessions + workflow artifacts on disk (`packages/desktop/src/main/workflowArtifactFile.ts`); UI stores are projections.
- **Existing tests/gates**: CLI `apps/zcode-cli/packages/contracts/tests/{create,amend,fill}-workflow*.test.ts`, `dynamic-workflow/` 25 test files, `dynamic-workflow-runtime/` 17; E2E `automations-workflows-hub.test.ts`, `conversation-session-highspeed-queue-edit.test.ts` (queue×workflow), `conversation-session-v4-rewind-queue-background.test.ts`; engineering `dynamicWorkflowConfigMockServer.test.ts`; docs `docs/testing/conversation-session-tool-cross-product-matrix.md`.

## 15. Browser use (embedded agent browser)

**What it is.** Agent-driven browser automation: Playwright-style command executor over Electron browser views/guests, human viewport mode, screenshots, tab residency/suspension/restore, video recording, site permissions, virtual clipboard, Chrome profile/cookie import, and the browser-use plugin distribution for the CLI.

- **Source ownership**: shared `packages/shared/src/browser-use/` (`commands.ts`, `command-metadata.ts`, `backend.ts`, `nodeReplBroker.ts`, `snapshot.ts`); desktop main `packages/desktop/src/main/browserView/` (31 files: `browserCommandExecutor.ts`, `browserPlaywrightExecutor.ts`, `browserGuestManager.ts`, `browserTabResidencyCoordinator.ts`, `browserScreenshotSurfaceCoordinator.ts`, `browserVideoRecorder.ts`, `browserVirtualClipboard.ts`, ...), `browserDataManager.ts`, `chrome*Manager.ts` (cookies/credentials/profiles); UI `packages/ui/src/browser-use/` (`UnifiedBrowserView.tsx`, `HumanBrowserView.tsx`, `ResponsiveBrowserViewport.tsx`, `BrowserUseSidePaneContent.tsx`, `BrowserSitePermissionsPage.tsx`), store `embeddedBrowserPermissionStore.ts`; CLI `apps/zcode-cli/packages/browser-use-plugin/` (src `browser-client.ts`), `apps/zcode-cli/packages/core/src/browser-client/`, node-repl browser via `node-repl-host`.
- **Key symbols**: `BrowserViewOperationPayload`, `BrowserTabResidencyState` (`packages/shared/src/platform.ts`), `BROWSER_VIEW_RESTORE_BOOTSTRAP_URL`, `browserCommandExecutor`, `embeddedBrowserPermissionStore`, `ServiceChannels` browser IPC payloads (`BrowserViewResidencyReportPayload` etc. in `channels.ts`).
- **Entry points / callers**: tool calls from agent open browser tabs in the workspace side pane; `WebRemoteControlMobileShell` renders remote browser state on mobile; main routes browser ops to origin renderer (`BrowserViewOperationPayload` doc comment).
- **State/persistence owner**: Electron main owns browser views/guests and tab recovery store (`browserTabRecoveryStore.ts`); site permissions in `embeddedBrowserPermissionStore` + platform persistence.
- **Existing tests/gates**: E2E `browser-*.test.ts` (8 specs: residency, permission prompt, tab close idempotent/cross-workspace, empty state, human viewport, external file URL), `conversation-session-browser-use-iab-multitab-lifecycle.test.ts`, `conversation-session-browser-use-subagent-boundary.test.ts`, `conversation-session-browser-zoom-coordinates.test.ts`, `conversation-session-node-repl-stateless-browser-multisession.test.ts`; smoke scripts `test:browser-*-smoke` in `packages/desktop/package.json`; regression fixtures `docs/testing/browser-*-regression-2026-09-0*.json`; coverage doc `docs/testing/browser-use-coverage-matrix.md`.

## 16. Computer Use (zcode-cua) — **runtime disabled placeholder in this build**

**What it is.** The Computer Use capability surface: OS screenshot/keyboard/mouse control for the agent. **Finding**: in this build the producer package is a fail-closed placeholder. `packages/zcode-cua/package.json` description: "API-compatible placeholder package for Computer Use. This build ships without Computer Use: every runtime surface reports unavailable and fails closed." `createComputerUseRuntime` (`packages/zcode-cua/index.js`) always returns `isError: true` with `"Computer Use is not available in this build."`, and `callBrokerMethod` rejects with code `unavailable`.

- **Source ownership**: `packages/zcode-cua/` (placeholder JS + `test/availability.test.ts`); app-side surfaces that REMAIN: `packages/services/src/cua-permission-broker/` (`cuaPermissionService.ts`, `cuaPipSessionService.ts`, `cuaHelperInstaller.ts`, `stableCuaTransport.ts`, `windowsCua*.ts`, deprecated `cuaAgentAdmissionGate.ts`), `packages/shared/src/cuaAccessibilitySettings.ts`, desktop main `cuaPermissionDragPanel.ts`, `cuaPermissionPanelPositioner.ts`, `cuaPipFocusRouter.ts`, `windowsCuaOperationIndicator.ts`, renderer `cua-permission-panel.html` + `cuaPermissionPanel.ts`, UI `packages/ui/src/cua-permission/`, hooks `useCuaPermissionStatus.ts`, `useCuaComposerEntry.ts`, settings `ComputerUseSection.tsx` + `computerUseAvailability.ts`; CLI plugin `apps/zcode-cli/packages/zcode-cua-plugin/` (skills + SDK client scripts; execution via shared node_repl host).
- **Key symbols**: `createComputerUseRuntime`, `callBrokerMethod`, `ICuaPermissionService` (`ServiceChannels.CuaPermission`, `CuaPipSession`), `prepareCuaHelperPermissionDragResult` (platform.ts).
- **Entry points / callers**: composer CUA entry (`useCuaComposerEntry.ts`), settings Computer Use section, subagent `computer-use-policy.ts`.
- **State/persistence owner**: none at runtime (fails closed); permission settings owned by OS + `cuaAccessibilitySettings` service.
- **Existing tests/gates**: `packages/zcode-cua/test/availability.test.ts` (runs as root Vitest project `cua-placeholder` via `packages/zcode-cua/vitest.config.ts`; the package `package.json` has only a `build` script — the `pnpm --filter @zcode/zcode-cua test` wording in `docs/testing/pre-push-hook.md` is stale); desktop CUA permission surfaces exercised by `sharpComputerUseRequirement.test.ts`, `dev-desktop-cua-env.mjs`; case catalog `docs/testing/cua-e2e-case-catalog.md` documents live lanes **not** runnable against this placeholder.
- **Discrepancy note**: docs (e.g. `docs/testing/cua-e2e-case-catalog.md`) still describe full CUA product behavior including `live-macos`/`live-windows` lanes — the source shows those cannot pass in this build. Any PaySwap work must treat CUA as "surface present, runtime fail-closed".

## 17. Terminal (in-app side pane terminal)

**What it is.** A real PTY terminal inside the workspace side pane (desktop; remote transport for mobile), with font/theme profiles and shell detection per OS.

- **Source ownership**: `packages/services/src/terminal/` (`terminalService.ts` — node-pty lazy loading, `terminalProfile.ts`, `terminalProfileMacOs.ts`, `terminalProfileTypes.ts`); UI `packages/ui/src/Terminal.tsx`, `SidePaneTerminalPane.tsx`, `webRemoteControlTerminalTransportState.ts`, `terminal/`; hook `useTerminalService.ts`; channel `ServiceChannels.Terminal`.
- **Key symbols**: `ITerminalService`, `TerminalInstance`, `resolveTerminalFontProfile`.
- **Entry points / callers**: workspace side pane toggle (`WorkspaceTerminalToggleButton.tsx`); mobile remote renders terminal via replayable transport.
- **State/persistence owner**: PTY processes owned by host `TerminalService`; UI keeps scrollback only.
- **Existing tests/gates**: E2E `conversation-session-r3-terminal.test.ts` (remote terminal); engineering `webRemoteTerminalProbe.test.ts`, `node-pty-package-assets.test.ts`, `node-pty-rebuild.test.ts`, `powershell-command.test.ts`, `spawn-command.test.ts`; docs `docs/testing/e2e-fs-fault-injection.md` (fs faults in terminal flows).

## 18. Memory (project memory system)

**What it is.** Agent memory: MEMORY.md-style project memory with dream/extraction/index/recall pipeline, memory settings UI viewer, project-stable reads, and memory diagnostics.

- **Source ownership**: runtime `apps/zcode-cli/packages/core/src/memory/` (`memory-agent-loop.ts`, `dream.ts`, `extraction.ts`, `index-content.ts`, `recall/`, `directory.ts`, `persistent-memory` also under `subagent/`); shared `packages/shared/src/memory.ts`, `memoryDiagnostics.ts`; services `packages/services/src/memory/` (`memoryService.ts` — `IMemoryService` at `memory.ts:26`, `projectMemoryStableRead.ts`); UI `packages/ui/src/settings/MemorySettingsSection.tsx`, `MemorySettingsViewer.tsx`; channel `ServiceChannels.Memory`.
- **Key symbols**: `IMemoryService`, `Memory`, `MemoryConfig`, memory-agent-loop.
- **Entry points / callers**: runtime injects recalled memory into context; settings memory section reads/writes memory file.
- **State/persistence owner**: memory file(s) in the workspace/user dir, written by the CLI runtime; services expose read/write.
- **Existing tests/gates**: E2E `conversation-session-memory.test.ts`; CLI tests `apps/zcode-cli/tests/memory/` + `tests/compact-microcompact/` (memory×compact interactions); **no services-layer unit test** (retired).

## 19. Permissions system (tool approval, plan mode, full access)

**What it is.** Risk-based tool permission engine: rulesets (allow/ask/deny), plan-mode policy, workflow draft pre-approval, bash readonly policy analysis, dangerous-command approval, full-access mode, permission options surfaced through V4 interaction dialogs to desktop and mobile.

- **Source ownership**: CLI authority `apps/zcode-cli/packages/core/src/permission/` (`service.ts` — `PermissionService`, `rule-matching.ts`, `plan-mode-policy.ts`, `broker.ts`, `workflow-draft-path.ts`), bash policy family `core/src/tool/handlers/bash-readonly-policy-*.ts` (~20 files), `bash-command-permission-policy.ts`, tool executor permission plumbing `core/src/tool/executor/permission-rules.ts`; contracts `apps/zcode-cli/packages/contracts/src/` (`PermissionRuleset`, `PermissionUpdate`, `CollaborationMode`, `RiskLevel` — imported in service.ts); UI `packages/ui/src/PermissionDialog.tsx`, `V4InteractionDialogs.tsx`, `WorkflowPermissionBlock.tsx`, `SaveWorkflowPermissionBlock.tsx`, `permissionWorkflowSettings.ts`, `ToolCallBlocks/`; shared `packages/shared/src/permission-request-preview.ts`, `zcode-protocol-v4/cuaPermission.ts`.
- **Key symbols**: `PermissionService`, `PermissionContext`, `PermissionRuleset`, `WORKFLOW_DRAFT_PREAPPROVED_RULE_ID`, `OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME`.
- **Entry points / callers**: tool executor asks runtime `PermissionService`; runtime emits permission requests over V4; renderer shows `PermissionDialog`/`V4InteractionDialogs`; mobile receives the same options (must not be re-derived by UI — domain map rule).
- **State/persistence owner**: rules in session/workspace config (CLI); decisions persisted by runtime; UI stateless dialogs.
- **Existing tests/gates**: E2E `conversation-session-permission-full-access.test.ts`, `conversation-session-permission-hook-{race,rewrite}.test.ts`, `conversation-session-plan-mode-mcp-permission.test.ts`, `permissionInteractionId.test.ts`, `e2eBashPrefixPermissionShim.test.ts`, `e2eToolFullAccess.test.ts`; CLI contracts tests (`ask-user-question.test.ts`, tool permission tests); docs `docs/permission-project-approval.md`, `docs/testing/plan-mode-e2e-coverage-plan.md`.

## 20. Settings (app settings, personalization, shortcuts, settings sync)

**What it is.** The settings page with sections (personalization/theme/locale, providers, MCP, plugins, skills, subagents, hooks, memory, automations, off-peak, commands, shortcuts, computer use, usage, source server devices, browser settings, workspace file search) plus first-launch settings sync, data-sync (user config sync across devices), and window-size persistence.

- **Source ownership**: `packages/ui/src/SettingsPage.tsx` + `packages/ui/src/settings/` (130 files) + `settingsPageConfig.ts`; services `packages/services/src/setting/`, `settings-sync/`, `data-sync/`, `client-config/`, `client-scenes/`; shared `packages/shared/src/protocol.ts` (`AppSettings`, `Locale`), `settings-sync.ts`, `settings-source.ts`, `config-schema.ts`, `validationAppSettings.ts`, `app-runtime-preferences.ts`; stores `sourceSettingsServiceStore.ts`; platform persistence via `IPlatformService`.
- **Key symbols**: `AppSettings`, `ISettingService`, `ISettingsSyncService`, `settingsPageConfig`, `Locale`.
- **Entry points / callers**: `Root.tsx` mounts `SettingsPage` on settings tab; `setPendingSettingsSectionIntent` navigation (`lib/settingsNavigation.ts`).
- **State/persistence owner**: settings file per scope owned by `ISettingService` on host; broadcast sync for theme/locale via `APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL` (loop-guarded per AGENTS.md).
- **Existing tests/gates**: E2E `packages/desktop/test/e2e/settings/` (20 specs: language, personalization, shortcut rebind/search/realkeys, provider*, subagent persistence, coding-plan entitlement, mcp dual era, window size); engineering `settingsSync`/`clientScenes` mock servers (`clientScenesMockServer.test.ts`, `help-client-config-e2e.md` cases); docs `docs/testing/settings-language-e2e-coverage-matrix.md`, `docs/client-config-service.md`.

## 21. Remote workspaces (SSH / WSL / Docker) & remote control chains

**What it is.** Connecting the desktop app to workspaces on remote machines: SSH/WSL/Docker backends, remote runtime asset deployment (CDN or local-upload), remote project browsing/creation, remote sync services (MCP/skills/plugins/settings), per-window connection registry, remote conversation sessions, and the strict distinction between desktop `desktop-continuous` (live stream) and mobile `web-remote-replayable` (snapshot+replay) delivery semantics.

- **Source ownership**: connection backends `packages/server/src/remote/` (`ssh-backend.ts`, `wsl-backend.ts`, `docker-backend.ts`, `remoteAsset*.ts`, `zcodeAgentDeploy.ts`, `zcodeAgentBundleWrapper.ts`...); host side `packages/desktop/src/host/` (`remoteWorkspaceServiceCollection.ts`, `remoteWorkspaceRpcContract.ts`, `remoteWorkspacePreparation.ts`, `windowRemoteConnectionRegistry.ts`, `windowHostAttachmentRegistry.ts`, `serverRemoteConnection.ts`, `sourceServer*` family, `remoteProviderProvisioningService.ts`, `remoteDynamicWorkflowUserMode.ts`); services `packages/services/src/remote-projects/`, `remote-sync/`, `source-server-management/`, `source-server-workspace/`, `skill-sync/`, `mcp-sync/`, `plugin-sync/`, `settings-sync/`, `data-sync/`; UI `packages/ui/src/remote/`, `remote-connection/`, `remote-connection-flow/`, `SSHDialog.tsx`, `RemoteConnectionDialogContent.tsx`, store `remoteWorkspaceSessionStore.ts`, `tabWorkspaceIdentity.ts` (identity key rule `workspaceIdentity?.trim() || workspacePath`); identity `packages/shared/src/remote-workspace-identity.ts`, `remoteTarget.ts`, `workspaceSessionRestore.ts`; mobile chain `packages/desktop/src/main/webRemoteControlManager.ts` + `web-remote-relay/`, `packages/client/src/webRemoteControlRelay*.ts` (acknowledged relay protocol), `packages/web/src/web-remote-control/` (admission, device list, transport, read-only views), `packages/ui/src/WebRemoteControlMobileShell.tsx`, `web-remote-control/`.
- **Key symbols**: `RemoteTarget`, `SSHConnectOptions`/`WSLConnectOptions`/`DockerConnectOptions`, `workspaceIdentity`, `clientMode: z.enum(["desktop-continuous", "web-remote-replayable"])` (`packages/shared/src/validation.ts:803`), `webRemoteControlManager`, `createAcknowledgedWebRemoteControlRelayProtocol`, `remoteWorkspaceSessionStore`.
- **Entry points / callers**: `SSHDialog`/`RemoteConnectionWizard*` from workspace header; `IPlatformService.connectRemote` is the single UI entry (verified in `usePlatform.tsx`); scheduler/automations dispatch to remote hosts; mobile bridges attach to existing host sessions only.
- **State/persistence owner**: remote runtime state owned by remote CLI process + relayed snapshots; host owns connection registry per window; external relay holds no business state (root AGENTS.md).
- **Existing tests/gates**: E2E `ssh*.test.ts` family (10+ specs incl. `conversation-session-ssh-remote-connection-p0.test.ts`, `conversation-session-ssh-remote-development-p0.test.ts`, `conversation-session-ssh-remote-local-download-proxy.test.ts`, `conversation-session-remote-*.test.ts` (device cards, install progress, presentation states, sidebar, project policy), `conversation-session-existing-remote-project.test.ts`, `conversation-session-chat-remote-{folder,project-choice}.test.ts`); engineering `sshHostProbe.test.ts`, `sshConnectionCompletion.test.ts`, `sshDirectoryFlow.test.ts`, `sshFirstConnectionProxy.test.ts`, `sshHeldResponseProxy.test.ts`, `sshLifecycleProjectDraft.test.ts`, `sshProjectSelection.test.ts`, `sshRemoteP0Replay.test.ts`, `sshStallableProxy.test.ts`, `sshControlCommandTimeout.test.ts`, `remoteAssetHttpProxy.test.ts`, `e2eSshRemoteReleaseAssets.test.ts`, `sourceServerReleaseFaults.test.ts`, `sourceServerUpdateFixture.test.ts`, `webRemoteControlActionRequests.test.ts`, `webRemoteControlAuthGateFixture.test.ts`, `webRemoteTerminalProbe.test.ts`, `mobilePairingDiagnostics.test.ts`, `mobileReplayFixture.test.ts`, `mobileLogPull*.test.ts`, `e2eRemoteSessionDatabaseFault.test.ts`, `remoteRendererReadyEvidence.test.ts`, `remoteToolExecutionEvidence.test.ts`, `remoteProjectE2EActions.test.ts`, `e2eRemoteTargetsCheck` (`check:e2e-remote-targets` gate); mobile E2E `web-remote-control-session-events.test.ts`, `conversation-session-virtual-project-mobile.test.ts`; docs `docs/architecture/r3-source-server-remote-architecture.md`, `docs/web-remote-control/`, `docs/testing/r3-remote-*.md`.

## 22. Account, coding plan, highspeed card, usage stats & rewards

**What it is.** Login (z.ai OAuth + JWT), Coding Plan subscription purchase/upgrade/quota, highspeed "acceleration card" extraction/share, local usage statistics (per model/provider), quota banners, rewards/referrals embedded page.

- **Source ownership**: services `packages/services/src/oauth/`, `credential/`, `coding-plan-subscription/`, `usage-stats/`, `highspeed/`, `rewardsBridge` shared types `packages/shared/src/rewardsBridge.ts`, `rewardsEmbedded.ts`, `coding-plan-subscription.ts`, `coding-plan-reset.ts`, `usage-stats.ts`, `usage-quota.ts`, `api-key-usage-scene.ts`, `oauth.ts`; UI `packages/ui/src/login/`, `CodingPlan*.tsx`, `settings/usage-stats/`, `settings/CodingPlan*.tsx`, `rewards/`, `hooks/useOAuth.ts`, `useCredentials.ts`, `useTokenRefresh.ts`, `useUsageStats.ts`, `useCodingPlan*`; account providers under `packages/provider/src/account-provider-*.ts` + `packages/services/src/model-provider/account*`.
- **Key symbols**: `ICredentialService`, `IOAuthService`, `ICodingPlanSubscriptionService`, `IUsageStatsService`, `IHighspeedCardService`, `HIGHSPEED_PROVIDER_IDS` (`packages/shared/src/highspeed.ts`: `account:zai-highspeed-card`, `account:bigmodel-highspeed-card`), `HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE` ("3402").
- **Entry points / callers**: `WelcomeScreen.tsx` login flow; composer coding-plan usage meter (`chat-input-toolbar/ChatCodingPlanMcpUsageMeter.tsx`); settings usage section.
- **State/persistence owner**: credentials in OS-safe store via `ICredentialService`; usage stats locally computed (`packages/services/src/usage-stats/providers/`).
- **Existing tests/gates**: E2E `access-token-401-auto-logout.test.ts`, `jwt-401-auto-logout.test.ts`, `jwt-expiry-reauthentication.test.ts`, `oauth-*.test.ts` (3), `coding-plan-*.test.ts` (5), `account-key-usage-scene.test.ts`, `usage-stats/usage-stats-app-usage.test.ts`, `feedback/`; engineering `codingPlanDataPlaneResponse.test.ts`, `codingPlanE2EMockEnv.test.ts`, `codingPlanUpgradeMockServer.test.ts`, `upstreamProviderPreferenceSeed.test.ts`; docs `docs/testing/usage-stats-e2e-coverage-matrix.md`, `docs/testing/coding-plan-team-e2e-cases.md`.

## 23. Bots (Feishu / Telegram / Weixin channels)

**What it is.** External chat-channel bots: Feishu group/private/topic delivery, Telegram and Weixin channel runtimes, bot-bound groups, command parsing, streaming cards, private task sync, session expiry callbacks.

- **Source ownership**: `packages/services/src/bots/` (32 files: `botsService.ts`, `feishuChannelRuntime.ts`, `telegramChannelRuntime.ts`, `weixinChannelRuntime.ts`, `groupSessions.ts`, `groupResultDelivery.ts`, `taskStreamHub.ts`, `topicPreparationState.ts`, ...), `bot-project-runtime/`; shared `packages/shared/src/bots.ts`, `channel-mention.ts`, `channels.ts`; UI `packages/ui/src/BotsDialog*.tsx`, `botsUi.ts`, hooks `useBot*.ts`; host `packages/desktop/src/host/botGroupTaskScope.ts`, `botRemoteWorkspaceResolver.ts`, `cronBotDelivery.ts`; zcode-agent `botTopicAdmission.ts`, `topicResource*.ts` (relay/upload/peers).
- **Key symbols**: `IBotsService`, `ZCodeAutomationBotDeliveryTarget`, `ServiceChannels.Bots`, channel runtimes.
- **State/persistence owner**: bot configs persisted by `repo.ts`/`config.ts`; runtime sessions bound to workspace hosts.
- **Existing tests/gates**: E2E `conversation-session-bot-channel-worker.test.ts`, `conversation-session-bot-continuous-worker.test.ts`, `conversation-session-bot-topic-worker.test.ts`; engineering mocks for bots exist in docs; coverage docs `docs/testing/bots-e2e-coverage-matrix.md`, `docs/bots.md` + 10 `docs/bots-*.md` specs; `docs/feishu-zct-*.md` verification records.

## 24. Gen-UI (plugin-generated UI) & plugin UI bridge

**What it is.** Plugins can render UI components inside chat (gen-ui), with host-side `ui://` resource serving, sampling bridge, app tools, and a tweak runtime; gen-ui model state attaches to conversation input (`untrusted_gen_ui_state`).

- **Source ownership**: `packages/shared/src/mcp-apps/` (`appTools.ts`, `sampling.ts`, `schemas.ts`, `toolMeta.ts`); services `packages/services/src/gen-ui/` (managed module: CONTRACT.md, `contract.ts`, `adapters/`, `app/`), `plugin-ui-bridge/`; UI `packages/ui/src/gen-ui/`, `plugin-ui/`; desktop `packages/desktop/src/renderer/src/plugin-sandbox/` (incl. `genUiTweakRuntime.js` — architecture exception documented), `packages/desktop/src/main/pluginSandbox/`, `host/pluginSandbox/`.
- **Key symbols**: `IPluginUiBridgeService`, `IPluginUiSamplingService`, `IPluginUiAppToolsService`, `PluginSandboxPlatformPort`, gen-ui widget state nodes in `zcode-feature-graph.yaml` (`state.gen-ui-widget-state`).
- **State/persistence owner**: widget state scoped to conversation input (untrusted, feature-graph invariant); host bridges resource reads.
- **Existing tests/gates**: engineering `genUiPresentationClipboard.test.ts`, `packages/desktop/scripts/gen-ui-runtime-assets.test.ts`; E2E **pending manual review** `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-gen-ui-context.test.ts` — finding: gen-ui automated coverage is thin (manual-review pending).

## 25. Share: conversation share, share-ui, web-share

**What it is.** Publishing a conversation (selection of turns/rows) to a share URL with access modes, preflight/redaction, artifact discovery; public read-only landing pages served by `web-share` app using `share-ui` components; import/continuation.

- **Source ownership**: services `packages/services/src/conversation-share/` (`conversationShareService.ts`, `conversationShareHttpClient.ts`, `conversationSharePublicProjection.ts`, `conversationShareIntegrity.ts`, `conversationShareWorkflowSnapshot.ts`, ...); shared `packages/shared/src/conversation-share*.ts`; UI `packages/ui/src/v4/ConversationShare*.tsx` (workflow, selection panel, docks, readonly timeline), `ConversationShareMenu.tsx`, `ConversationShareLinkRow.tsx`, store `conversationShareSelectionStore.ts`, `conversation-share-interaction/`; web landing `packages/web/src/share/ConversationShareLandingPage.tsx`, `conversationShareRoute.ts`; standalone app `packages/web-share/` (`ShareAuthPages.tsx`), `packages/share-ui/` (dnd-kit + pptx renderer components).
- **Key symbols**: `IConversationShareService`, `PublishTextConversationInput`, `ConversationShareSelection` (`all | productTurns | rowAnchors`), `ServiceChannels.ConversationShare`.
- **Entry points / callers**: share menu in conversation header; landing route in web app (`isConversationSharePath`).
- **State/persistence owner**: share records server-side via HTTP client; local selection state in `conversationShareSelectionStore`.
- **Existing tests/gates**: E2E `conversation-session-share-popover.test.ts`, `conversation-session-share-publish-import.test.ts`, `conversation-session-share-tool-presentation.test.ts`; engineering `conversationShareMockRoute.test.ts`; dev harness `pnpm dev:web-share:{test,mock}` (`scripts/dev-web-share-env.mjs`).

## 26. Zustand store layer (UI state)

**What it is.** All shared UI state lives in Zustand stores under `packages/ui/src/store/` (47 files) — session workspace buckets, tabs, MCP, plugins, skills, hooks, subagents, automations, alerts, whiteboard, model trajectory, etc. E2E store bridges are exposed only when WDIO explicitly enables them.

- **Source ownership**: `packages/ui/src/store/` — `StoreProvider.tsx`, `TabStoreProvider.tsx`, `zcodeSessionStore.ts` (+ `zcodeSessionStoreTaskSlice.ts`, `zcodeSessionStoreWorkspaceSlice.ts`, `zcodeSessionStoreNavigation.ts`, `zcodeSessionStoreSelectors.ts`, `zcodeSessionStoreTypes.ts`), `tabStore.ts`, `tabWorkspaceIdentity.ts`, `mcpStore*.ts`, `pluginStore.ts`, `pluginManagementStore*.ts`, `skillStore.ts`, `hooksStore.ts`, `subagentsStore*.ts`, `automationManagementStore.ts`, `savedWorkflowStore.ts`, `dynamicWorkflowAvailabilityStore.ts`, `offPeakTaskStore.ts`, `modelTrajectoryStore.ts`, `whiteboardStore.ts`, `remoteWorkspaceSessionStore.ts`, `commandsStore.ts`, `taskQueryCacheStore.ts`, `embeddedBrowserPermissionStore.ts`, `workspaceHookReviewStore.ts`, `conversationShareSelectionStore.ts`, `alertDialogStore.ts`, `confirmDialogStore.ts`, `codeCommentPreviewStore.ts`, `composerAttachmentUploadStore.ts`, `workflowRunSavedStore.ts`, `sourceServer*Registry.ts`, `serviceAuthorityKey.ts`.
- **Key symbols**: `useZCodeSessionStore` (`create<ZCodeSessionStoreState>()`), `useTabStore`, `getWorkspaceState`, E2E bridges `window.__zcodeSessionStoreE2E`, `window.__whiteboardStoreE2E` (gated by `shouldExposeE2EStoreBridge()`).
- **Entry points / callers**: `Root.tsx` wires `StoreProvider`/`TabStoreProvider`; one workspace bucket per tab (doc comment in `zcodeSessionStore.ts`).
- **State/persistence owner**: stores are UI-layer owners only; server facts stay in services/runtime (root AGENTS.md rule).
- **Existing tests/gates**: no dedicated unit tests (retired); behavior covered by the E2E suites above; store bridges used by E2E specs (`packages/desktop/test/e2e/...` uses `__zcodeSessionStoreE2E`, e.g. in helper code; `desktopAppTestIdLookup.test.ts` guards test ids).

## 27. Platform service abstraction (IPlatformService)

**What it is.** The single typed contract for renderer platform capabilities (dialogs, window controls, remote connect, OAuth registration, telemetry, browser lifecycle, CUA accessibility, updates, plugin sandbox platform, web-remote-control methods). UI must go through it — never `window.zcode` directly (root AGENTS.md).

- **Source ownership**: `packages/shared/src/platform.ts` (`export interface IPlatformService` at line 742; also `TaskNotificationPayload`, `BrowserViewOperationPayload`, `BrowserTabResidencyState`, `BROWSER_VIEW_RESTORE_BOOTSTRAP_URL`); desktop implementation `packages/desktop/src/renderer/src/desktopPlatform.ts` (`createDesktopPlatform(options): IPlatformService` delegating to `window.zcode.*` preload bridge); web implementation `packages/web/src/platform/index.ts` (`createWebPlatform`), contract `packages/web/src/platform/contract.ts` (`WebRemoteControlPlatformProxy` for web-remote-control method proxying); provider in UI `packages/ui/src/hooks/usePlatform.tsx` (`PlatformProvider`, `usePlatform`, `useSelectDirectory`, `useConnectRemote`).
- **Key symbols**: `IPlatformService`, `createDesktopPlatform`, `createWebPlatform`, `PlatformProvider`, `usePlatform`, `WebRemoteControlPlatformMethod`.
- **Entry points / callers**: `packages/ui` components/hooks; web main.tsx and desktop renderer main.tsx construct and inject implementations.
- **State/persistence owner**: stateless facade; underlying owners are Electron main / web / remote hosts.
- **Existing tests/gates**: typecheck (contract change breaks `pnpm typecheck` across ui/desktop/web); E2E exercises platform methods via UI flows; **no unit test of the implementations** (retired) — finding; the mcpStore platform port (`setMcpStorePlatform`) is tested indirectly via `conversation-session-plugin-mcp-skill-*` specs.

## 28. Platform surface: Desktop (Electron main / host / renderer / scheduler / preload)

**What it is.** The Electron app: main process (windows, menus, auto-update, browser views, CUA helpers, relay, storage scanning, resource manager window, crash capture, ARMS telemetry), per-window host utility process (service graph + remote attachment), renderer (React app + platform bridge), resident cron scheduler utility process, preload bridges.

- **Source ownership**: `packages/desktop/src/main/` (~180 files incl. `index.ts`, `appLaunchCoordinator.ts`, `autoUpdater.ts`, `broadcastHub.ts`, `webRemoteControlManager.ts`, `resourceManagerWindow.ts`, `zcodeDataSizeScanner.ts`), `src/host/` (`index.ts` — "每个窗口对应一个独立的 host process", `hostInitialization.ts`, `windowHostControllerService.ts`, `taskRealtimeBridge.ts`), `src/renderer/` (`src/main.tsx`, `desktopPlatform.ts`, `databaseStartupAdmission.ts`, `remoteWorkspaceServicePortBridge.ts`, `cuaPermissionPanel.ts`, plugin-sandbox, resource-manager), `src/scheduler/`, `src/preload/`, `src/shared/`; packaging `electron-builder.config.js`, `tsup.config.ts`, WDIO `wdio.conf.ts`.
- **Key symbols**: `appLaunchCoordinator`, `hostInitialization`, `windowHostControllerService`, `taskRealtimeBridge`, `broadcastHub`.
- **Entry points / callers**: `pnpm dev:desktop` (`scripts/dev-desktop-env.mjs`); E2E boots the same app via WDIO.
- **State/persistence owner**: main owns window/process lifecycle only; host owns per-window service graph; renderer owns nothing persistent.
- **Existing tests/gates**: `pnpm test:e2e` (WDIO), `test:e2e:all:coverage`, `test:e2e:windows:sharded`, `test:e2e:container` (+ conversation/plugins variants), 158 engineering tests mostly under `packages/desktop/test/`, `pnpm typecheck` (main/host/renderer/remote-main tsconfigs), installer smokes (`test:installer-nsh-smoke`, `test:auto-update-*-smoke`), `electronBuilder*.test.ts`, `packagedPlatformDependencyPrune.test.ts`.

## 29. Platform surface: Web (`packages/web`)

**What it is.** The browser deployment of the same UI: OAuth login/callback pages, community/help config, conversation-share landing, and the mobile web-remote-control app (admission, device list, transport, read-only task views).

- **Source ownership**: `packages/web/src/main.tsx` (entry: `createWebPlatform` + route splitting auth/share/remote-control), `src/auth/`, `src/share/`, `src/web-remote-control/` (`CONTRACT.md`, `app/webRemoteControlEntry.ts`, `ui/`, `adapters/`, `contracts/`, `domain/`), `src/platform/`.
- **Key symbols**: `createWebPlatform`, `WebCallbackPage`, `ConversationShareLandingPage`, `webRemoteControlEntry`.
- **Entry points / callers**: `pnpm dev:web`; production build `build:web-remote-control:test` (base `/remote/__test__/`).
- **State/persistence owner**: web app holds no durable state; remote-control state mirrored from desktop host (replayable).
- **Existing tests/gates**: engineering `packages/web/test/viteConfigLoad.test.ts`; E2E via desktop web-remote-control suites + `webRemoteControlAuthGateFixture.test.ts`; **no web-app unit tests** (retired) — the web remote-control chain is guarded indirectly by the engineering fixtures named in §21.

## 30. Platform surface: Android companion app

**What it is.** A native Android shell (`com.example.zcode_mobile`) that wraps the web remote-control UI in a WebView with QR-camera pairing, recent-links store, keep-alive foreground service.

- **Source ownership**: `packages/android/` — Gradle project; `app/src/main/java/com/example/zcode_mobile/MainActivity.kt`, `remote/RemoteControlKeepAliveService.kt`, `remote/RemoteControlRecentLinksStore.kt`, `remote/RemoteControlUrlPolicy.kt`, `ui/RemoteControlApp.kt`, `ui/theme/`; manifest `app/src/main/AndroidManifest.xml` (permissions: INTERNET, CAMERA, FOREGROUND_SERVICE, POST_NOTIFICATIONS).
- **Key symbols**: `MainActivity`, `RemoteControlApp`, `RemoteControlKeepAliveService`, `RemoteControlUrlPolicy`.
- **Entry points / callers**: launched by QR deep link (`resolveRemoteUrlFromIntent`) or recent links.
- **State/persistence owner**: Android-local recent links store; remote control state stays with desktop host.
- **Existing tests/gates**: device acceptance is manual/Android-side; app-repo tests exist for log pull (`packages/desktop/test/mobileLogPull.test.ts`, `mobileLogPullExport.test.ts`, `mobileLogSink.test.ts`) and pairing diagnostics (`mobilePairingDiagnostics.test.ts`) — these test the desktop side of the mobile pipeline. **No automated Android instrumentation tests in this repo** — finding (UNVERIFIED whether CI builds the APK; no android CI script found in `scripts/`).

## 31. Platform surface: Agent CLI & TUI (`apps/zcode-cli`)

**What it is.** The terminal product: interactive TUI (keyboard-first), non-interactive prompt mode, headless/workflow modes, plugin host mode, protocol server mode (for desktop), SEA packaging, resume, custom commands, command center, internal search tools.

- **Source ownership**: `apps/zcode-cli/packages/cli/src/` (`main.ts`, `run.ts`, `resume.ts`, `prompt-command.ts`, `command-center/`, `internal-search/`, `headless-*.ts`, `plugin-host-command.ts`, `plugins-command.ts`, `plugins-marketplace-command.ts`, `hooks-trust-command.ts`, `login-command.ts`, `sea-playwright-runtime.ts`), `packages/tui/src/` (`app-*.ts(x)` family: input, keyboard, markdown, model/mode commands, approvals, compact timeline, MCP status, file mentions), `packages/core/`, `packages/bootstrap/`, `packages/adapters/`, `packages/contracts/`, `packages/i18n/`, `packages/debug/`, `packages/telemetry/`, `packages/node-repl-host/`, plugin packages (§8), `packages/swift-bridge/`, `packages/office-runtime/`.
- **Key symbols**: `main()` in `cli/src/main.ts`, TUI `app-input.ts`/`app-keyboard.ts`, `isProtocolServerInvocation`, `isPluginHostInvocation`.
- **Entry points / callers**: `pnpm build:zcode`/`build:sea` packaging; desktop spawns the protocol server variant; users run the TUI directly.
- **State/persistence owner**: CLI owns sessions, config, storage (`docs/design/v2/` specs; SQLite storage with migrations owned per `AGENTS.md`).
- **Existing tests/gates**: per-package Vitest (`apps/zcode-cli/vitest.config.ts` includes `test/`, `tests/`, `packages/*/test*/`); counts verified: adapters 166, bootstrap 238, cli 27, contracts 44, core 289, dynamic-workflow 25, dynamic-workflow-runtime 17, tui 29, telemetry 9, node-repl-host 7, debug 4, i18n 1, plugins 1 each for android-emulator/ios-simulator/browser-use-plugin; plus `apps/zcode-cli/tests/` (compact-microcompact, file-tools-atomic-write, memory) and `tests/cli.test.mjs`; `pnpm --dir apps/zcode-cli typecheck`, `lint`, `test`; release `release:cli`.

## 32. Source server & zcode-server-cli (remote backend distribution)

**What it is.** The remotely deployable server runtime ("source server"): a CLI + supervisor that stages and runs the agent server on remote machines (SSH/WSL), update daemon, packaging of remote assets; plus `packages/server` with stdio/HTTP entries and remote deploy machinery.

- **Source ownership**: `packages/zcode-server-cli/src/` (`main.ts` → `runServerCli`, `cli.ts`, `supervisor/`, `server-core/`, `runtime/` incl. `agentWiring.ts`, `updateHandoff.ts`, `packaging/`, `platform/`, `ipc/`, `contracts.ts`); `packages/server/src/` (`entry-http.ts`, `entry-stdio.ts`, `http.ts`, `stdio.ts`, `stdioDeviceMid.ts`, `stdio-lifecycle.ts`, `hostCapability.ts`, `remote/`, `source-server/`, `bundledZCodeBuiltinProviderConfig.ts`).
- **Key symbols**: `runServerCli`, `resolveBundledAgentWiring`, `createUpdateDaemonHandoff`, `createHttpServer`.
- **Entry points / callers**: staged by `pnpm prepare:remote-assets` (`packages/zcode-server-cli` `stage:remote-assets`); desktop connects via `packages/server/src/remote/*-backend.ts`.
- **State/persistence owner**: remote filesystem; supervisor owns release lifecycle.
- **Existing tests/gates**: engineering `packages/zcode-server-cli/test/{packaging,stageRemoteAssetsCli,tsupConfig,verifyRemoteSshTarget}.test.ts`, `packages/server/test/tsupConfig.test.ts`; E2E `sourceServerReleaseFaults.test.ts`, `sourceServerUpdateFixture.test.ts`, `e2eSshRemoteReleaseAssets.test.ts`; docs `docs/architecture/r2-server-cli-and-daemon*.md`, `r3-source-server-remote-*.md`, `docs/testing/r3-remote-server-harness.md`.

## 33. RPC framework (`packages/rpc`)

**What it is.** The VS Code-style layered IPC framework used between renderer↔host (MessagePort), host↔remote (socket), and web-remote-control: serialization (VQL + type tags), protocols, channels, 1:N IPCServer, proxy channels from service descriptors, persistent protocol, logging/network-telemetry middleware.

- **Source ownership**: `packages/rpc/src/` (`index.ts` with the 7-layer diagram, `foundation.ts` — `IDisposable`/`DisposableStore`/`Event`/`Emitter`/`CancellationToken`, `buffer.ts`, `serialization.ts`, `ipc.ts`, `channelServer.ts`, `channelClient.ts`, `proxy-channel.ts` (`fromService`/`toService`), `persistent-protocol.ts`, `remote.ts`, `logging-middleware.ts`, `network-telemetry-middleware.ts`, `delayedChannel.ts`).
- **Key symbols**: `Event`, `Emitter`, `VSBuffer`, `serialize`/`deserialize`, `IPCServer`, `fromService`, `toService`, `MessagePortProtocol`, `SocketProtocol`.
- **Entry points / callers**: `packages/client` builds service proxies; desktop host/renderer and web-remote-control transport consume it; `packages/desktop/src/host/electronPort.ts` adapts Electron MessagePorts.
- **State/persistence owner**: transport only — "不拥有业务语义" (`docs/architecture/architecture.md`).
- **Existing tests/gates**: **no unit tests** (App unit tests retired; `packages/rpc` has no test dir) — finding: RPC changes are guarded only by `pnpm typecheck` and by consumers' E2E/engineering tests (dependents verified in package.json: `services`, `client`, `ui`, `desktop`, `server`, `zcode-server-cli`); architecture policy lists rpc as an unmanaged module.

## 34. Agent client SDK (`packages/client`)

**What it is.** Renderer-side client SDK: typed service proxies over RPC, websocket/messageport transports, web-remote-control acknowledged relay batch queue/deadline protocol and payload serializer, renderer logging env.

- **Source ownership**: `packages/client/src/` (`index.ts`, `websocket.ts`, `messageport.ts`, `remoteServiceAccess.ts`, `webRemoteControlAcknowledgedRelayBatchQueue.ts`, `webRemoteControlAcknowledgedRelayDeadline.ts`, `webRemoteControlAcknowledgedRelayProtocol.ts`, `webRemoteControlRelayProtocol.ts`, `webRemoteControlRelayPayloadSerializer.ts`, `logger.ts`, `rendererLoggingEnv.ts`).
- **Key symbols**: `createAcknowledgedWebRemoteControlRelayProtocol`, `WebRemoteControlPayloadSendResult` (imported by `webRemoteControlManager.ts`).
- **Entry points / callers**: desktop renderer bootstrap, web main.tsx (`connectViaProtocol`, `connectViaWebSocket`).
- **State/persistence owner**: in-flight transport state only.
- **Existing tests/gates**: no package-local tests (retired); covered indirectly by mobile/relay E2E + engineering fixtures (`shared/test/fixtures/fake-relay-v2` retained per `docs/testing/unit-test-quality.md`).

## 35. e2e-report

**What it is.** Reporting companion for the desktop E2E suite: node library to read E2E summary JSON and generate viewer URLs + a Vite viewer app (coverage panels, charts, trends).

- **Source ownership**: `packages/e2e-report/src/node/index.ts` (`readE2EReportSummary`, `createE2EReportViewerUrl`, `DEFAULT_E2E_REPORT_VIEWER_BASE_URL`), `src/viewer/` (`App.tsx`, `CoveragePanel.tsx`, `ChartPanels.tsx`, `trendData.ts`), `src/shared/types.ts` (`E2EReportSummary`).
- **Entry points / callers**: `pretest:e2e` builds it (`packages/desktop/package.json`); `pnpm dev:e2e-report` serves viewer on 4173.
- **State/persistence owner**: reads artifacts produced by E2E runs; owns no persistent state.
- **Existing tests/gates**: E2E reporting lifecycle is itself tested by engineering tests `packages/desktop/test/e2eReportingLifecycle.test.ts`, `e2eReportingErrorClassification.test.ts`, `e2eReportingSummarySkipped.test.ts`, `e2eCoverageHeatmap.test.ts`, `e2eAllCoverageRunner.test.ts` (tooling-level); the package itself has no unit tests — acceptable as tooling; `pnpm typecheck` includes `packages/e2e-report`.

## 36. formal-proof (conversation state-space enumerator)

**What it is.** A standalone Vite app enumerating the conversation product state space (compact/fork/goal/queue/edit combinations) as an interactive model; "ZCode 的产品行为状态空间枚举器" (README).

- **Source ownership**: `packages/formal-proof/src/{main.ts,model.ts,styles.css}`, `index.html`, spec `docs/conversation-product-state-space.md`.
- **Entry points / callers**: `pnpm --filter @zcode/formal-proof dev` (port 4176); manual analysis tool.
- **State/persistence owner**: none (pure in-browser model).
- **Existing tests/gates**: **NO automated tests** — only `pnpm typecheck` (root typecheck list) and lint. Finding: unguarded beyond types; model drift vs protocol would not be caught.

## 37. stream-animate (streaming animation benchmark tool)

**What it is.** Dev-only Vite app + Node server to create/fetch/inspect "runs" of streaming animation frames (frame charts, run history, aggregates) — a performance experiment harness.

- **Source ownership**: `packages/stream-animate/src/{App.tsx,main.tsx,client/,server/,shared/}`.
- **Entry points / callers**: `pnpm --filter @zcode/stream-animate dev`; `run:sample` CLI.
- **State/persistence owner**: run artifacts in local storage (server side); no product state.
- **Existing tests/gates**: **NO automated tests**; typecheck + lint only. Dev tooling; low risk.

## 38. Telemetry, monitoring & performance instrumentation

**What it is.** ARMS RUM integration (electron + web), conversation telemetry engine (message/step semantics, parity between desktop and execution), service logging (`createServiceLogger`), renderer action trace, process resource telemetry (many samplers), launch marks, local TTFT, network capture/redaction, product identity/privacy redaction.

- **Source ownership**: `packages/shared/src/telemetry.ts`, `telemetryRedaction.ts`, `conversation-telemetry/` (managed module), `rendererActionTrace.ts`, `launchMarks.ts`, `local-ttft/`, `processResourceTelemetry.ts`, `networkCapture.ts`; services `packages/services/src/telemetry/`, `conversation-telemetry/`, `logger/serviceLogger.ts`; UI `packages/ui/src/lib/appTelemetry.ts`, `uiPerfArmsTelemetry.ts`, `v4/telemetry/` (supervisor, parity E2E helper); desktop main `appARMSBootstrap.ts`, `armsEventRedaction.ts`, `processResource*` family (14 files), `rendererActionTrace*`, `startupTelemetryDelivery.ts`, `storageScanWorker*`; CLI `apps/zcode-cli/packages/telemetry/`.
- **Key symbols**: `createServiceLogger(scope)`, `ArmsCustomEventPayload`, `RendererTelemetryEventPayload`, `conversationTelemetryEngine`, `clientMode` telemetry guard (`messageTelemetry.ts`).
- **State/persistence owner**: telemetry pipelines own no product state; redaction rules centralized.
- **Existing tests/gates**: engineering `conversationTelemetryParity.test.ts`, `telemetryFieldContract.test.ts`, `e2eNetworkCaptureRedaction.test.ts`, `processResourceTelemetryRoles.test.ts`, `armsEventRedaction` covered via desktop tests (`desktopArmsCustomEvent`), `e2eConversationPreparation.test.ts`; docs `docs/monitoring/*.md`.

## 39. Supporting user-facing capabilities (verified, briefer)

Each of these is a real product surface with source ownership; full per-feature test mapping is in `02-preservation-matrix.md`.

- **Workspace shell & tabs**: `packages/ui/src/App.tsx`, `Root.tsx`, `root/`, `app-shell/`, `WorkspaceHeader*.tsx`, `WorkspaceSidebar*`, `store/tabStore.ts` (`WorkspaceTabState`, settings vs workspace tabs).
- **Workspace file tree & file search**: `packages/ui/src/WorkspaceFileTree.tsx`, `workspace-file-tree/`, `workspace-file-search/`, `hooks/useFileService.ts`, `useFileWatcherService.ts`; services `file/`, `fileWatcher/`; E2E `workspace-file-tree/` (2 specs + refresh spec) and `conversation-session-workspace-file-search-filter.test.ts`.
- **Git pane, checkpoints, branch switcher, commit dialog**: `packages/ui/src/GitPane*`, `git-branch-switcher/`, `git-graph/`, `GitActionMenu.tsx`; services `git/` (`git.ts`, `gitCheckpoint.ts`); E2E `git/` dir, `git-commit-dialog-e2e-coverage.md`.
- **Preview pane** (code/image/markdown/office/pdf/patch): `packages/ui/src/PreviewPane.tsx`, `previewPane*.tsx` (14 files), office runtimes in CLI plugin packages (`office-runtime`, `spreadsheets-plugin`, `presentations-plugin`, `documents-plugin`, `pdf-plugin`); E2E `preview-pane-image-copy.test.ts`, docs `docs/cloud-content-dialog*.md`.
- **Command center & slash commands**: `packages/ui/src/command-center/CommandCenterDialog.tsx`, `SlashCommandPlugin.tsx`, `slashCommandPanelSections.tsx`, `v4/slashCommands.ts`; services `commands/` (`ICommandsService`); E2E `ui-shell/command-center-{focus,selection}.test.ts`; composer prefix routing spec.
- **Model trajectory viewer**: `packages/ui/src/ModelTrajectory*.tsx` (12 files), `store/modelTrajectoryStore.ts`, hook `useModelTrajectory.ts`, services `zcode-agent/modelTrajectory.ts`; E2E `conversation-session-model-trajectory-viewer.test.ts`.
- **Input prediction**: `packages/shared/src/zcode-protocol-v4/input-prediction/`, services `zcode-agent/inputPredictionSwitch.ts`; **no dedicated E2E found** (rg for `inputPrediction` in e2e specs returned nothing) — unguarded finding.
- **Whiteboard**: `packages/ui/src/WhiteboardPane.tsx`, `lib/whiteboard.ts`, `store/whiteboardStore.ts`; only indirect E2E mention (composer mention routing `conversation-session-composer-prefix-routing.test.ts`); whiteboard→chat flow — thinly guarded finding.
- **Todo panel**: `packages/ui/src/TodoPanel.tsx`; runtime todo tool in CLI core tools.
- **Onboarding**: `packages/ui/src/onboarding/` (`OccupationOnboarding`, `OnboardingDialog`), services `onboarding/`; settings `MigrationSection` for Claude session import (`useClaudeSessionMigration.ts`, `ExternalAgentImportDialog.tsx`, `MigrationCandidatesCard.tsx`).
- **Feedback**: `packages/ui/src/feedback/`, services `feedback/` (`IFeedbackService`), shared `feedback.ts`, `feedbackPrivacy.ts`; E2E `feedback/` dir.
- **Marketing touch**: services `marketing-touch/`, UI `marketing-touch-contract/`, shared `marketingTouch.ts`; engineering `marketing-touch-coverage-audit.mjs` + docs.
- **Cloud content dialog**: services `cloud-content/` (`cloudContentService.ts`), shared `cloudContent.ts`, UI dialogs; E2E coverage doc `docs/testing/cloud-content-dialog-coverage.md`.
- **Media preview & image editor**: services `media-preview/`, UI `image-preview-editor/`, `ChatMediaAttachmentPreviewDialog.tsx`; platform `createLocalMediaPreviewUrl`.
- **Shortcuts**: `packages/ui/src/shortcuts/`, settings `ShortcutSettingsSection.tsx`, shared `shortcutCommands.ts`; E2E 3 specs.
- **Resource manager window**: `packages/desktop/src/main/resourceManagerWindow.ts` + renderer `resource-manager.tsx`; E2E `resource-manager*.test.ts` (3).
- **Auto-update**: `packages/desktop/src/main/autoUpdater.ts`, shared `update.ts`, `platformUpdate.ts`, `forceUpdate.ts`; E2E `macosUpdateManifest.test.ts`, auto-update smokes; UI `updateReleaseNotes.ts`, `updateStatus*`.
- **Native search tools** (ripgrep et al.): `scripts/build-native-search-tools.mjs`, `download-ripgrep.mjs`, `packages/desktop/native/`; engineering `prepare-native-search-tools.test.ts`, `test:native-search:e2e`.
- **Broadcast hub** (cross-window): `packages/desktop/src/main/broadcastHub.ts`, services `broadcast/` (`IBroadcastService`), shared `app-runtime-preferences.ts`.
- **Elicitation & ask-user-question**: shared `zcode-protocol-v4` interaction types, `packages/ui/src/ElicitationDialog.tsx`, `V4UserInputDialog.tsx`, CLI `ask-user-question.ts` handler; 10+ E2E specs `conversation-session-ask-user-question-*.test.ts`.
- **Background bash/tasks**: shared `background-bash-*.ts`, `background-task-*.ts`; CLI `bash-background-*.ts` handlers; UI `ConversationBackgroundWorks.tsx`, `BackgroundTaskElapsedLabel.tsx`, hook `useBackgroundBashOutput.ts`; E2E `conversation-session-background*.test.ts` (7).
- **Compact (auto/manual)**: CLI `core/src/compact/`, protocol v4 compact flows; E2E `conversation-session-compact*.test.ts` (6) + CLI `tests/compact-microcompact/`.
- **i18n & theming**: `packages/ui/src/i18n/`, `useTheme.ts`, `docs/ui/zai-themes.md`; E2E `settings-language-system-default.test.ts`, `settings-client-language-header.test.ts`, mobile theme doc.
- **Highspeed card** — see §22 (shared constants verified in `packages/shared/src/highspeed.ts`).
- **Rewind (file rewind)**: `packages/ui/src/v4/ConversationFileRewindDialog.tsx`; E2E `conversation-session-v4-rewind-*.test.ts` (3); CLI checkpoint support via git checkpoint service.
- **Developer tools pane**: `packages/ui/src/DeveloperToolsPane.tsx`, hook `useDeveloperToolsVisibility.ts`.
- **Quickpick**: `packages/ui/src/quickpick/`.
- **Off-peak/coding-plan quota banners**: `v4/ConversationQuotaBanner.tsx`, `useV4SessionQuotaBanner.ts`, `startPlanQuota*`.
- **Rewards**: `packages/ui/src/rewards/` (`RewardsProvider` mounted in `Root.tsx`), shared `rewardsEmbedded.ts`; feature-graph node `capability.referrals-embedded`.

## 40. Explicitly UNVERIFIED / not present

- `specs/` directory: exists at repo root but contains only `zcode-unified-distribution.md` (verified with `ls specs/`). The CLI's own specs live in `apps/zcode-cli/docs/design/v2/` (referenced by `apps/zcode-cli/AGENTS.md`; not exhaustively read in this audit).
- Android CI build: no script in `scripts/` references `packages/android`; UNVERIFIED how the APK is built/released.
- Whether the desktop "browser acceptance" tests mentioned in `AGENTS.md` ("浏览器验收") are a separate suite from WDIO: the only browser-acceptance-named artifacts found are `packages/desktop/scripts/browser-*-smoke.mjs` (electron smoke scripts) and `docs/testing/*-e2e-coverage-matrix.md` documents; no `pnpm test:browser-acceptance` style entry exists in root or desktop `package.json`. Treat "browser acceptance" as the smoke scripts + WDIO specs.
- Docs claim (README) remote resources flow via mock-cdn in dev; verified `packages/desktop/mock-cdn` referenced in dev script ignore lists but not opened.
