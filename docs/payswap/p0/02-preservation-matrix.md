# PaySwap 4.0 P0 — Worker 1: Feature-Preservation Matrix

Companion to `01-feature-inventory.md` (same audit basis: `p4/p0-w1` @ `a9fe401`, source-verified). Purpose: for every inventoried ZCode capability, state what must keep its behaviour, which existing gates detect a regression, where PaySwap will touch near it, and the rule that keeps it safe.

## 0. Gate commands that exist today (verified in root `package.json` / `packages/desktop/package.json` / `apps/zcode-cli/AGENTS.md`)

| Gate | What it actually runs |
| --- | --- |
| `pnpm typecheck` | `tsc -b` over shared(+testing), rpc, provider, provider-node, services, client, server, zcode-server-cli, ui, web, dev-docs, e2e-report, desktop (main/host/e2e), remote-main, zcode-cua |
| `pnpm lint` / `lint:fix` | oxlint (root, incl. zcode-cua `.oxlintrc.json`) |
| `pnpm fmt:check` | oxfmt |
| `pnpm verify:pre-push` | worktree check → `check:e2e-remote-targets` → lint → `docs:stale-phrases:check` → `db:schema:check` → `test:architecture` → `architecture:check -- --changed` → `test:engineering:affected --scope push` |
| `pnpm architecture:check --changed` | `scripts/architecture/architecture-check.mjs` vs `architecture-policy.yaml` |
| `pnpm test:architecture` | node --test over 7 governance test scripts in `scripts/test/` |
| `pnpm db:schema:check` | `scripts/test/sqlite-schema-contract.test.mjs` + `scripts/check-sqlite-schema.ts` |
| `pnpm test:engineering <file>` | vitest project `engineering` (explicit list `scripts/engineering-test-files.json`, 158 files) |
| `pnpm test:engineering-tools` | node --test over 4 tooling tests |
| `pnpm test:e2e` / `:e2e:all:coverage` / `:e2e:windows:sharded` | desktop WDIO suites (`packages/desktop/test/e2e/`: 497 automated-lane spec files + 153 under `manual-review/`) |
| `pnpm test:e2e:container[:conversation|:plugins]` | containerized E2E lanes |
| CUA placeholder | root Vitest project `cua-placeholder` (`packages/zcode-cua/vitest.config.ts`, runs with the root vitest projects; note: `pnpm --filter @zcode/zcode-cua test` in `docs/testing/pre-push-hook.md` is stale — the package has no `test` script) |
| `pnpm --dir apps/zcode-cli test` / `typecheck` / `lint` | CLI workspace (per-package vitest, turbo-selected) |
| `pnpm knip` | unused deps/exports |
| `pnpm audit:conversation-session-coverage` / `:complete` | conversation E2E case coverage vs catalog |

There are **no App unit tests** (retired 2026-10-26, `docs/testing/unit-test-quality.md`); behavior detection = E2E + engineering tooling + typecheck/lint/architecture. PaySwap must not assume a unit-test safety net exists in `packages/{ui,services,shared,provider*,rpc,client,server,web}`.

## 1. Matrix — conversation & runtime core

| # | Feature (inventory §) | Source that MUST keep behaviour | Current guards | Breakage detection | PaySwap contact surface & safety rule |
| --- | --- | --- | --- | --- | --- |
| 1 | Conversation lifecycle / New Task (§1) | `packages/ui/src/v4/SessionPane.tsx`, `conversationProjectionStore.ts`, `agentConversationTransport.ts`, `sessionDataLayer.ts`, `composer/composerDraftStore.ts` | 375 automated specs in `packages/desktop/test/e2e/conversation-session/` | E2E suite (any of the 375); `pnpm typecheck`; `pnpm audit:conversation-session-coverage` | Additive UI only: new surfaces mount beside `SessionPane` (e.g. new side-pane/panel components), never edit V4 row rendering semantics; new financial intents go through existing composer → `IZCodeTaskService.createTask` path. Never fork the projection store. |
| 2 | ZCode Protocol V4 (§2) | `packages/shared/src/zcode-protocol-v4/*`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/*` | CLI bootstrap/contracts tests; E2E; wire-codec typed | `pnpm typecheck` (shared + CLI), CLI package tests, E2E | PaySwap adds protocol messages only as **new optional fields/commands** with runtime validation; never edits `command.ts`/`wire.ts` shapes in place. Follow AGENTS rule: protocol change ⇒ update `packages/shared/src/zcode-protocol/index.ts` types too. |
| 3 | Agent runtime / CLI loop (§3) | `apps/zcode-cli/packages/core/**`, `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`, `zcodeAgentService.ts` | ~850 CLI test files; E2E warmup specs | `pnpm --dir apps/zcode-cli test` (affected), `pnpm test:e2e` | No in-place edits to loop/tool scheduling. Financial tools = new tool handlers registered through `core/src/tool/registry.ts` patterns + `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` process. |
| 4 | Session mgmt / resume / fork (§4) | `packages/services/src/zcode-session/*`, `bootstrap/src/session-lifecycle/` | E2E multisession/attachment-resume/fork specs | E2E conversation-session suite; CLI bootstrap tests | New session kinds (if any) via new config params on `createTask`; `forkedFromTaskId` semantics untouched. |
| 5 | Task list & SQLite index (§5) | `packages/services/src/session/taskIndexRepo.ts`, `tasksDatabase/*` | `pnpm db:schema:check`; E2E archive/history specs | `db:schema:check` catches schema drift; E2E `conversation-session-archive-management.test.ts` etc. | PaySwap must not add tables to `tasks-index.sqlite` without a migration registered in `tasksDatabase/migrations.ts` + schema gate update; prefer separate DB. |
| 6 | Automations + scheduler (§12) | `packages/services/src/session/automation*.ts`, `packages/desktop/src/scheduler/*` | E2E `automations-*.test.ts`, automation cron conversation specs | E2E suite; `pnpm typecheck` (scheduler tsconfig) | Recurring financial ops should reuse `AutomationService` surfaces additively; never bypass `AutomationRepo.claimDue` claiming or add a second scheduler. |
| 7 | Off-peak tasks (§13) | `packages/services/src/session/offPeak*.ts` | E2E `off-peak-*.test.ts` (3) | E2E suite | Leave untouched; if PaySwap needs scheduled money movement, treat as new feature domain, not off-peak edits. |
| 8 | Dynamic workflows (§14) | `apps/zcode-cli/packages/dynamic-workflow*/**`, `core/src/tool/handlers/*workflow*.ts`, `shared/src/zcode-protocol-v4/workflow-*` | CLI workflow tests (contracts + dwf + dwf-runtime ≈ 86 files); E2E hub/queue-edit | CLI package tests; E2E | No edits to workflow analyzer semantics; PaySwap workflows may be *authored by the agent* through existing tools — that is usage, not modification. |

## 2. Matrix — models, providers & extensions

| # | Feature | Source that MUST keep behaviour | Current guards | Breakage detection | PaySwap contact surface & rule |
| --- | --- | --- | --- | --- | --- |
| 9 | Model selection & provider config (§6) | `packages/provider/**`, `packages/provider-node/**`, `services/src/model-provider/**`, `ui/src/settings/ModelProviderSection.tsx`, composer model/provider menus | E2E `settings/provider-*.test.ts` (9), `upstream-provider.test.ts`, `conversation-session-model-switch-*.test.ts`; engineering `modelProvider*`, `providerRefreshWorkspace`, `upstream*` tests; CLI adapters tests | E2E + engineering lists above; `pnpm typecheck` | Additive providers only via existing registry/config services; never edit `ProviderRegistry` semantics or selection precedence. PaySwap-specific models must go through `packages/provider/src/config` sources. |
| 10 | model-option-map (§6) | `packages/model-option-map/src/*` | CLI `adapters/tests/model-option-map-fetch.test.ts` | CLI package test | Read-only consumer for PaySwap; no edits. |
| 11 | MCP (§7) | `packages/shared/src/mcp*.ts`, `mcp-apps/`, `services/src/mcp-sync/`, `ui/src/store/mcpStore*.ts`, CLI `core/src/mcp/` | E2E `conversation-session-plugin-mcp-skill-*.test.ts` (8), `settings/mcp-dual-era-version-negotiation.test.ts` | E2E suite | PaySwap servers register as ordinary MCP servers through user config; never touch trust flow (`mcpWorkspaceScope.ts`) or store migration paths. |
| 12 | Plugins & store (§8) | `services/src/plugins/**`, `plugin-sync/`, `plugin-ui-bridge/`, `ui/src/store/plugin*.ts`, `settings/Plugin*.tsx`, desktop plugin sandbox | E2E `plugins/` (15 specs); engineering `pluginE2EAdmissionScripts`, `pluginMarketStartupCredentials`; container lane `test:e2e:container:plugins` | E2E plugins lane + engineering tests | **Preferred PaySwap extension point**: ship financial capabilities as a plugin (marketplace-compatible, sandboxed). Do not fork plugin lifecycle code. |
| 13 | Skills (§9) | `services/src/skills/**`, `skill-sync/`, `ui/src/store/skillStore.ts`, CLI `bootstrap/src/skills.ts`, `bundled-skills/` | E2E plugin-mcp-skill matrix; CLI bootstrap tests | E2E matrix; CLI tests | PaySwap skills = new SKILL.md bundles (plugin-bundled or workspace); no edits to discovery/scan policy. |
| 14 | Hooks (§10) | `shared/src/workspace-hook-*.ts`, `services/src/hooks/**`, `ui/src/store/hooksStore.ts`, CLI trust chain | E2E hooks specs (6); UAT fixture script | E2E suite | Do not add implicit hooks; if PaySwap needs event reactions, consume existing V4 events instead of new hook types. |
| 15 | Subagents (§11) | `shared/src/subagent-*.ts`, `services/src/subagents/**`, `core/src/subagent/**`, `ui/src/store/subagents*.ts` | E2E subagent specs (6); engineering `subagent*` (3) | E2E + engineering | New PaySwap subagent profiles are data, not code. Never touch `runner.ts`/`tool-policy.ts`. |
| 16 | Gen-UI & plugin UI bridge (§24) | `shared/src/mcp-apps/`, `services/src/gen-ui/`, `plugin-ui-bridge/`, renderer plugin-sandbox | engineering `genUiPresentationClipboard.test.ts`, `desktop/scripts/gen-ui-runtime-assets.test.ts`; E2E **manual-review pending** | engineering tests; typecheck | PaySwap plugin UIs use the same `ui://` sandbox contract; no bridge edits. Note thin automated coverage — see §5 unguarded. |

## 3. Matrix — surfaces, platform & remote

| # | Feature | Source that MUST keep behaviour | Current guards | Breakage detection | PaySwap contact surface & rule |
| --- | --- | --- | --- | --- | --- |
| 17 | Browser use (§15) | `desktop/src/main/browserView/**`, `shared/src/browser-use/`, `ui/src/browser-use/`, CLI browser plugin | E2E browser specs (12 incl. conversation-session); browser smoke scripts | E2E + smokes (`test:browser-*-smoke`) | Untouched. If PaySwap needs page-reading for statements, use agent browser tools, not new main-process browser code. |
| 18 | Computer Use (§16) | `packages/zcode-cua/**` (fail-closed placeholder), remaining permission surfaces in services/desktop/ui | `pnpm --filter @zcode/zcode-cua test` (availability contract) | CUA package test — any change to fail-closed behavior fails it | Keep fail-closed; do not "restore" CUA runtime as part of PaySwap. UI permission surfaces may not be removed (settings `ComputerUseSection.tsx`). |
| 19 | Terminal (§17) | `services/src/terminal/**`, `ui/src/Terminal.tsx`, `SidePaneTerminalPane.tsx` | E2E `conversation-session-r3-terminal.test.ts`; engineering `webRemoteTerminalProbe.test.ts`, node-pty tests | E2E + engineering | No edits; PaySwap may add *new panes*, not modify terminal pane. |
| 20 | Memory (§18) | `core/src/memory/**`, `services/src/memory/**`, settings memory section | E2E `conversation-session-memory.test.ts`; CLI `tests/memory/` | E2E + CLI tests | Do not couple PaySwap financial memory into project memory pipeline without a spec; reading is safe. |
| 21 | Permissions (§19) | `core/src/permission/**`, bash-readonly-policy family, `ui/src/PermissionDialog.tsx`, `V4InteractionDialogs.tsx` | E2E permission specs (7+); `permissionInteractionId.test.ts`; `e2eBashPrefixPermissionShim.test.ts`; CLI contracts tests | E2E + CLI tests | New PaySwap tools MUST declare `inputSchema`/risk levels and flow through `PermissionService`; never add a side-door approval path. |
| 22 | Settings (§20) | `ui/src/SettingsPage.tsx`, `settings/**`, `services/src/setting/**`, `settings-sync/`, `data-sync/` | E2E `settings/` (20 specs) | E2E suite | Additive sections only: register new section via `settingsPageConfig.ts`; never repurpose existing section ids (deep links/E2E depend on them). |
| 23 | Remote workspaces & chains (§21) | `server/src/remote/**`, `desktop/src/host/remoteWorkspace*`, `services/src/remote-*`, `source-server-*`, `ui/src/remote*`, `shared/src/remote-*.ts`, `client/src/webRemoteControl*`, `web/src/web-remote-control/`, `desktop/src/main/webRemoteControlManager.ts` | 40+ E2E/engineering specs (ssh*, remote*, webRemoteControl*, mobile*, sourceServer*) — see §21 | E2E + engineering lists; `check:e2e-remote-targets` gate | **Highest-risk adjacency**: PaySwap must never assume desktop-continuous semantics for mobile. New remote-visible state must be snapshot-projectable and flow through existing transport (`agentConversationTransport`, relay V2). No new Desktop Remote Host, no second relay. |
| 24 | Mobile web & Android (§29, §30) | `web/src/web-remote-control/**`, `ui/src/WebRemoteControlMobileShell.tsx`, `packages/android/**` | E2E `web-remote-control-session-events.test.ts`, `conversation-session-virtual-project-mobile.test.ts`; engineering mobile fixtures (4) | E2E + engineering | PaySwap mobile surfaces render through the same mobile shell; mobile stays replayable/read-only for new content unless a spec adds owner-command support through protocol v4. |
| 25 | Desktop platform (§28) | `desktop/src/{main,host,renderer,scheduler,preload}/**` | 158 engineering tests (mostly desktop), WDIO suites, packaging smokes | `pnpm test:engineering`, `pnpm test:e2e`, typecheck tsconfigs | Main-process changes require architecture-governance skill flow (`.agents/skills/architecture-governance/SKILL.md`); prefer renderer-side additive UI. |
| 26 | Web platform (§29) | `web/src/**` | engineering `viteConfigLoad.test.ts` + E2E | typecheck + E2E | Additive routes only (new pages beside auth/share/remote-control entries in `main.tsx`). |
| 27 | CLI & TUI (§31) | `apps/zcode-cli/**` | ~850 CLI test files; `pnpm --dir apps/zcode-cli test` | CLI tests + typecheck + lint | New commands = new files in `cli/src/` following argument-parsing contracts; TUI state rules (no business state in TUI) mandatory. |
| 28 | Source server / zcode-server-cli (§32) | `zcode-server-cli/src/**`, `server/src/**` | engineering packaging/stage tests; E2E sourceServer* | engineering + E2E | Deployment topology untouched by PaySwap features. |
| 29 | RPC framework (§33) | `packages/rpc/src/**` | typecheck + consumers only (**no unit tests**) | `pnpm typecheck`; breakage surfaces in host/E2E — weak | No PaySwap edits to `packages/rpc`. If new channel needs arise, use existing `ServiceChannels` + descriptor pattern (`services/src/descriptors.ts`). |
| 30 | Client SDK (§34) | `packages/client/src/**` | consumer E2E only | E2E (mobile/relay fixtures) | No edits; new proxies generated via existing `fromService` descriptors. |
| 31 | IPlatformService (§27) | `packages/shared/src/platform.ts` (interface @ line 742), `desktopPlatform.ts`, `web/src/platform/index.ts` | typecheck contract; E2E via UI flows | `pnpm typecheck` (3 packages) — interface breaks loudly; behavior drift only via E2E | New platform capabilities = **additive optional methods** with web+desktop implementations; never repurpose existing method ids (web-remote-control proxy maps them by name). |
| 32 | Zustand stores (§26) | `packages/ui/src/store/**` | E2E (store bridges); no unit tests | E2E suite; `desktopAppTestIdLookup.test.ts` for test ids | New PaySwap stores = new files in `store/`; never add write paths into existing stores owned by other features (single-owner rule, root AGENTS.md). |
| 33 | Share (§25) | `services/src/conversation-share/**`, `ui/src/v4/ConversationShare*`, `web/src/share/`, `packages/web-share`, `packages/share-ui` | E2E share specs (3); engineering `conversationShareMockRoute.test.ts` | E2E + engineering | Statement sharing should reuse conversation-share preflight/redaction; do not build a second share pipeline. |
| 34 | e2e-report (§35) | `packages/e2e-report/src/**` | engineering e2eReporting* (5) | engineering tests; typecheck | Tooling only; keep summary schema (`E2EReportSummary`) stable or extend additively. |
| 35 | formal-proof (§36) | `packages/formal-proof/src/{main,model}.ts` | typecheck/lint only (**no tests**) | none automated | Do not rely on it as a gate; if PaySwap changes conversation state space, update the model manually (docs/conversation-product-state-space.md). |
| 36 | stream-animate (§37) | `packages/stream-animate/src/**` | typecheck/lint only | none | Untouched dev tool. |
| 37 | Telemetry (§38) | `shared/src/conversation-telemetry/**` (managed module), desktop telemetry family, `services/src/logger/serviceLogger.ts` | engineering conversationTelemetryParity, telemetryFieldContract, e2eNetworkCaptureRedaction, processResourceTelemetryRoles | engineering tests | New PaySwap events must go through `ArmsCustomEventPayload`/redaction rules; no raw user content in telemetry (AGENTS logging rules). |
| 38 | Bots (§23) | `services/src/bots/**`, `desktop/src/host/*bot*`, `ui/src/BotsDialog*` | E2E bot worker specs (3); coverage docs | E2E | Financial notifications via bots = new delivery templates through existing channel runtimes; never edit Feishu card reliability paths. |
| 39 | Login/credentials/coding-plan/highspeed/usage/rewards (§22) | `services/src/{oauth,credential,coding-plan-subscription,usage-stats,highspeed}/**`, `ui/src/login/`, rewards | E2E oauth/jwt/coding-plan/usage specs (12); engineering codingPlan*/upstream* | E2E + engineering | Credentials untouched; PaySwap reads usage via `IUsageStatsService` only. |
| 40 | Workspace shell/tabs/file tree/git/preview/command center/trajectory/i18n/etc. (§39) | per §39 listing | per-feature E2E specs cited there | E2E suite | Additive panes/sections; reuse components per `DESIGN.md`. |

## 4. Discrepancies & stale-doc findings (from audit)

1. **Computer Use runtime is a fail-closed placeholder** (`packages/zcode-cua/package.json` description; `index.js` `UNAVAILABLE_TEXT`; `test/availability.test.ts` asserts failure), while `docs/testing/cua-e2e-case-catalog.md` still catalogs live OS lanes. Docs overstate the shipped capability.
2. **App unit tests are gone** — `docs/testing/unit-test-quality.md` records the retirement; any older doc (or memory) claiming unit coverage for `packages/ui|services|shared|...` is stale. Coverage matrices now mark `retired:` evidence.
3. `docs/architecture/architecture.md` self-declares as **historical** ("早期分层架构（历史）") — current truth is `docs/architecture/zcode-code-architecture-overview.md`; PaySwap docs must not cite the historical one as current.
4. README says "mise.toml is source of truth" but the linked text renders `ise.toml](mise.toml)` — the file is `mise.toml`; cosmetic doc bug.
5. Root `AGENTS.md` names `packages/shared/src/zcode-protocol/index.ts` as the protocol sync point while the live protocol is v4 (`zcode-protocol-v4/`); both exist — v4 is the authority for new work (verified by import graph in §2).
6. The E2E spec count is large but `manual-review/pending/` directories hold not-yet-promoted specs (e.g. gen-ui context, r3-mobile) — "exists in repo" ≠ "in automated lane"; the promotion gate is `e2ePromotionAuditTransaction.test.ts`.
7. `docs/testing/pre-push-hook.md` says CUA runs via `pnpm --filter @zcode/zcode-cua test`, but `packages/zcode-cua/package.json` has only a `build` script; the test actually runs as root Vitest project `cua-placeholder` (`packages/zcode-cua/vitest.config.ts`).
8. `specs/` at repo root contains only `zcode-unified-distribution.md` — the real product specs live in `docs/` (334 entries) and `apps/zcode-cli/docs/design/v2/`; "update the spec first" (AGENTS) refers to those.

## 5. Unguarded or thinly-guarded features (input for TL regression plan)

These have **no or weak automated detection** today:

| Feature | Gap | Proposed detection method |
| --- | --- | --- |
| `packages/rpc` framework | No unit tests; only typecheck + downstream E2E | Add engineering vitest for serialization round-trip + channel call/listen semantics (register in `scripts/engineering-test-files.json`); PaySwap TL can own this as a P1 addition |
| `packages/client` relay protocols (acknowledged batch queue/deadline) | No package tests; covered only via mobile E2E fixtures | Engineering vitest with `shared/test/fixtures/fake-relay-v2` (fixture retained) asserting ACK/deadline semantics |
| Input prediction (`shared/src/zcode-protocol-v4/input-prediction/`, `zcode-agent/inputPredictionSwitch.ts`) | No E2E spec matched `inputPrediction` (rg over e2e dirs) | Add one conversation-session E2E exercising predicted-input acceptance, or an engineering test on the prediction schema/switch |
| Whiteboard | Only indirect E2E (mention routing); no spec opens the pane and draws | Add WDIO spec using `window.__whiteboardStoreE2E` bridge + `dispatchWhiteboardAddToChat` |
| Gen-UI runtime | Automated spec is `manual-review/pending` | Promote `conversation-session-gen-ui-context.test.ts` out of pending (uses existing promotion flow `e2ePromotionAuditTransaction`) |
| `packages/formal-proof` | No tests; model can drift from protocol v4 | Minimum: engineering test asserting the enumerated combos equal the v4 command/queue capability lists |
| `packages/e2e-report` viewer | Only downstream lifecycle tests | Optional engineering test on `readE2EReportSummary` + URL builder (pure functions) |
| `packages/web-share` + `packages/share-ui` | No tests at all (build only) | Rely on E2E share specs (exist); add vite build to CI is already implicit via `pnpm build` |
| Android app | No instrumentation/CI in repo | Manual device acceptance + keep desktop-side mobile fixtures green; document as accepted risk |
| Services-layer business logic generally (taskIndexRepo, automationService, etc.) | Unit tests retired; E2E covers happy+fault paths partially | Treat the E2E catalog matrices (`docs/testing/*coverage-matrix.md`) as the regression inventory; extend matrices rather than reintroducing unit tests (repo policy) |

## 6. Preservation invariants PaySwap must adopt (from source + AGENTS.md, not invented)

1. Every existing capability stays available; PaySwap features are **additive** (new files, new optional protocol fields, new stores, new settings sections, new plugin packages).
2. Single state owner per fact (root AGENTS.md); no second write path into `tasks-index.sqlite`, session JSON, or provider registry.
3. `workspaceKey = workspaceIdentity?.trim() || workspacePath` everywhere (AGENTS Workspace Identity section; `store/tabWorkspaceIdentity.ts`).
4. Desktop `desktop-continuous` vs mobile `web-remote-replayable` must both be validated on any stream/snapshot/queue/reconnect change (AGENTS 进程、协议与远程控制).
5. Mobile attaches to existing host sessions only; relay holds no business state.
6. UI reaches services via `packages/ui/src/hooks/` and platform via `IPlatformService`; no `window.zcode` direct calls; no UI→Repo direct calls.
7. Protocol changes: update `packages/shared/src/zcode-protocol-v4/` + legacy `zcode-protocol/index.ts` types, keep runtime validation.
8. Permissions for any new tool flow through CLI `PermissionService` with declared risk levels; permission options are passed through from agent responses, never re-derived in UI.
9. Architecture gate: `pnpm architecture:check -- --changed` must pass; new PaySwap modules should be registered (adopt) rather than accumulating exceptions.
10. Test policy: App behavior changes need E2E first (`packages/desktop/test/e2e/conversation-session/` for chat behaviors); CLI/CUA changes need their own package tests; tooling changes need engineering tests. No new App unit tests.
