# Host broker integration (Profile 3 workspace plugins)

Architecture law for official workspace plugins that need domain data: the model calls plugin MCP tools; the plugin process is a **thin proxy** to host-owned services; the host holds the credentials, the permissions and the session authority. Never build a second runtime inside the plugin and never put credentials in the plugin.

```text
model ──tools/call──▶ plugin MCP server (thin proxy)
                          │  bridge over host-injected channel (no credentials of its own)
                          ▼
                     authenticated host broker ──▶ domain service ──▶ provider
```

## The PaySwap worked example (the pattern to copy)

Everything below is implemented code, not design prose.

**Contract first.** `payswap-plugin/src/contract.ts` is the single source of truth: `TOOL_NAMES` (six `payswap_*` tools), `PayswapRefusalCode` (`not_opted_in` / `not_connected` / `financial_mode_disabled`), the `PayswapToolEnvelope` union (`{kind:"ok"|"refused"|"bridge_failure"}`), `SURFACES`, and `FINANCIAL_WORKSPACE_ENV`. `payswap-plugin/contract.ts` (module level) exports `PAYSWAP_PLUGIN_OUTPUTS`, `PAYSWAP_OPT_IN_OPTION`, `PAYSWAP_ENV_NAMESPACE = "PAYSWAP_"`. Shared wire types live in `packages/shared/src/payswap/` (`@zcode/shared/payswap`) so host and child cannot drift — per-op params schemas in `operations.ts` map 1:1 to tool input schemas.

**Tool = 1:1 op proxy.** `payswap-plugin/src/server.ts` registers every tool with a real zod input schema and `annotations.readOnlyHint` (except `payswap_request_authorization`, which creates proposals). `src/bridge.ts` maps `tool → op` by the closed-set rule `toolToOp: "payswap_<op>" → <op>`, extracts the session hint ONLY from the host-namespaced `_meta["com.zcode/request-context"].session_id` (top-level `_meta` is third-party extensible — never a routing credential; broker re-resolves sessions authoritatively, "resolved-not-asserted"), and enforces envelope separation: verified success body → `kind:"ok"` data; verified bridge errors and child-side typed failures → `kind:"bridge_failure"` — never conflated with business refusals (`kind:"refused"`).

**Credentials: five-key group, trusted injection only.** `packages/shared/src/payswap/broker-env.ts` defines `PAYSWAP_BROKER_SOCKET / _TOKEN / _INSTANCE_ID / _HOST_ID / _VERIFY_KEY` with per-key shape validators and all-or-nothing semantics (`readPayswapBrokerCredentialTupleFromEnv`: partial or malformed group → null → fail-closed). These keys:

- never appear in any settings schema, manifest `mcpServers.*.env`, or `${user_config.*}` (broker-env.ts header, §4.2(4) normative);
- are stripped from runtime env and tool-env passthrough (§4.3(1) double list);
- are injected by the host at spawn time only into the trusted server config object: `bootstrap/src/mcp-config.ts` → `resolveTrustedOfficialPayswapServerNames` (reference-identity gate: the config object must be the resolver's own object — copied configs do not inherit credentials, N19 anti-copy) then `injectPayswapBrokerMcpServers` (no credentials → inject nothing, fail-closed);
- are restored by `cli/src/plugin-host-command.ts` `restoreCapturedPayswapEnv` only inside `module.main()` for the authoritative plugin id, with freshness assertions (host id = current boot, instance live in the current registry, socket = current endpoint).

**Child side.** `armPayswapBridgeFromEnv(env)` arms the shared bridge client when the full group is present; otherwise the Wave-1 snapshot refusal path answers (`readFinancialWorkspaceSnapshot` + `snapshotRefusal`). The child holds zero financial state; stderr logs carry only tool name + typed code (`[payswap] <tool>: bridge answered <code>`).

**Host side.** The broker mints per-boot state (`mintBrokerBootState`, Ed25519 verify key + host id, private key host-memory-only), signs every response envelope (`signResponseEnvelope`, no unsigned mode in v1), verifies replay (frozen gap G=64 in `replay.ts`), and answers the three-code law (`payswapBusinessRefusal` in `operations.ts`). Host wiring tests: `bootstrap/tests/payswap-broker-credentials.test.ts`, `bootstrap/tests/payswap-broker-spawn-wiring.test.ts`.

## Where to extend the host (decision table)

| Need | Touch | Do not |
| --- | --- | --- |
| Shared wire types / protocol both sides use | `packages/shared/src/<domain>/` (see `payswap/`, `mcp-apps/`) | duplicate types in the plugin package |
| New host domain service the plugin proxies to | host service layer (bootstrap/app runtime, e.g. `bootstrap/src/mcp-config.ts` injection points) | a plugin-side service runtime |
| New MCP transport behavior | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` | fork the resolver in the plugin |
| Plugin registration/lifecycle | `bootstrap/src/app/official-plugin-definitions.ts` (+ bundled-plugins.ts machinery only for genuinely new seed needs) | invent a parallel registry |
| Env constants shared with the plugin | plugin's own namespace (`PAYSWAP_*` precedent); never `ZCODE_*` keys inside the plugin manifest env | write host-reserved env keys (`ZCODE_PLUGIN_ID` is resolver-authoritative) |

For a plugin whose domain service does not exist yet, the honest staging is exactly PaySwap's: ship the tool surface with typed refusals and the host-side boundary in a later wave — the contract tests pin the semantics so the data arm can land without reshaping the tool surface.

## General vs PaySwap-specific

- General (copy for any Profile 3 plugin): thin-proxy tools; typed envelope; opt-in env snapshot gate; `_meta` session hint handling; credentials injected by host via trusted config objects only; envelope/log discipline; 1:1 tool↔op mapping; shared wire types in `packages/shared`.
- PaySwap-specific (do not generalize blindly): the five-key socket/token/verify-key bridge (a local IPC transport with response signing), per-boot key minting, the financial three-code law, and the CUA parallel (`ZCODE_CUA_*` socket + pluginAuthority in the same files). A plugin talking to an HTTP host service would use `mcpServers.*.auth` (`parseZCodeOfficialAuth` in `adapters/src/mcp-official-auth.ts`) with identity headers injected per outbound message instead.
