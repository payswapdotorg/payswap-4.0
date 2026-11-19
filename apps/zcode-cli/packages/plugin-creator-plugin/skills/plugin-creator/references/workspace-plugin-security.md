# Workspace plugin security and consent review

Run this review BEFORE implementing a Profile 2/3 plugin (it decides the shape), and record the outcome next to the plan. The rules below are enforced by real host code and by `scripts/official-plugin-audit.mjs`; a violation fails the audit even if the plugin "works".

## Step 1 — Classify the request

- **Local plugin (Profile 1)** if it is a personal/workflow plugin distributed through a dev marketplace. No official machinery, no host services.
- **Official built-in (Profile 2)** if it ships inside the ZCode host repo for every user.
- **Official workspace plugin (Profile 3)** if Profile 2 AND the plugin reads domain/workspace state that belongs to the host (accounts, documents, financials, device access). Profile 3 requires the broker/service boundary — see [host-broker-integration.md](host-broker-integration.md).

## Step 2 — Credential boundary (the law)

1. The plugin MCP process must be able to do its job with **no credentials of its own**. If you are about to give the plugin an API key, token, or wallet, stop: the correct shape is a host-side service or broker that the plugin proxies to (PaySwap: "MCP 进程无金融状态").
2. Manifest `mcpServers.*.env` may carry only plugin-own, non-secret variables (precedent `PAYSWAP_*`, `ANDROID_PLUGIN_*`, `IOS_SIM_*`). Credential-shaped keys (`*_TOKEN`, `*_SECRET`, `*_API_KEY`, `PAYSWAP_BROKER_*`) are rejected by the audit; `ZCODE_PLUGIN_ID` and other host-reserved keys are overwritten by the resolver (`adapters/src/plugins/mcp.ts` writes `env[ZCODE_PLUGIN_ID_ENV_KEY] = context.loaded.id` after the manifest spread).
3. Host-injected credentials flow only through trusted config injection (reference-identity gate, `resolveTrustedOfficialPayswapServerNames`) and survive only inside the trusted plugin-host dispatch (`restoreCapturedPayswapEnv`). A plugin must not try to fetch credentials from env files, settings, or user config.
4. `userConfig` options with `sensitive: true` resolve ONLY in env sinks (`resolveTemplate(..., { allowSensitive: true })`); using one in command/args/url is a configuration error the resolver rejects and the audit reports. Prefer a host-managed boundary over sensitive user config entirely.

## Step 3 — Opt-in and consent semantics

- A plugin touching sensitive workspace domains declares a boolean opt-in `userConfig` option with `default: false` (payswap: `financialWorkspace`), injected into the plugin process via `${user_config.X}` → plugin-own env key (`PAYSWAP_FINANCIAL_WORKSPACE_ENV`).
- The official definition then keeps `defaultEnabled: false` — opt-in gates and default-on registration are mutually exclusive (audit-enforced; see [official-plugin-definition.md](official-plugin-definition.md)).
- **`alwaysLoad:true` is not consent** — it only bypasses tool deferral.
- State model (payswap S-states; generalizable): disabled (S0b) → enabled, not opted in (S1: tools registered, every call returns typed `not_opted_in`) → opted in, no account/dependency (S2: typed `not_connected`) → connected. Define your typed refusal codes as a closed set in the contract and never conflate distinct states (`payswap-launch-path.test.ts` asserts both codes plus "never conflates the two reachable codes").
- **Launcher visibility ≠ data reachability.** `listPluginUiSurfacesFromPlugins` filters by `plugin.enabled` only — it never reads `userConfig`. Opted-out surfaces legitimately appear in the launcher; the data boundary is proven by the tool refusals + static panel skeletons, not by hiding entries. Do not "fix" visibility; prove reachability.

## Step 4 — Read-only vs privileged actions

- Mark informational tools `annotations: { readOnlyHint: true }`; leave mutation-capable tools unmarked (payswap leaves `payswap_request_authorization` unmarked because it creates a proposal).
- UI surfaces are Class A (informational) only. Authorization/approval flows are Class B and are rendered by the HOST, never by a plugin surface (payswap N25: the authorization card is host-rendered; panels must not contain approve/confirm semantics — asserted in `server.test.ts` "panels stay informational").
- Panels carry zero placeholder data and zero external dependencies (no `<script src>`, no remote fonts) — sandbox-CSP friendly and auditable.

## Step 5 — Which tests prove the model cannot bypass the boundary

1. **Typed refusal contracts on real processes** — every tool answers the envelope (never raw errors that could leak state) in both opt-in arms; `payswap-launch-path.test.ts` runs this through the real seed + resolution pipeline.
2. **Impostor rejection** — `plugin-host-command.ts` refuses to serve captured credentials to a plugin whose authoritative id is not the trusted one (`assertCapturedPayswapCredentialServingContext`; CUA equivalent `assertCapturedBrokerLaunchIsAuthorized`). A copied MCP config does not inherit credentials (reference-identity gate).
3. **Stale credential rejection** — captured tuples whose hostId/instance/socket do not match the current boot are rejected (`assertCapturedPayswapBrokerLaunchIsAuthorized`). `bootstrap/tests/payswap-broker-credentials.test.ts` pins the fail-closed arms.
4. **Resolver-authoritative identity** — discovery tests assert `ZCODE_PLUGIN_ID` equals `payswap@zcode-plugins-official` regardless of manifest content.
5. **Panel reachability arms** — opted-out panels serve static skeletons with no data markers (`expect(html).toContain("no financial data is shown on this surface yet")` and the no-placeholder regex), proving the visual surface carries nothing sensitive while invisible to data.
6. **The deterministic audit** — credential-shaped env keys, namespace violations, `alwaysLoad` misuse, and default-on opt-in are machine-checked before any test runs.

## Recording unresolved decisions

When the review cannot decide (e.g. whether a capability needs a new host service or an existing broker), write the decision point into the delivery: what was chosen, what default was applied (repository-consistent: opt-out of new privileges), and what evidence would flip it. Never ship a credential-bearing plugin server "temporarily" — stage the tool surface with typed refusals instead (the PaySwap Wave-1 pattern).
