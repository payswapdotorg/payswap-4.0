# P0 Deliverable 7 — New Task Financial Interaction Design (preserving the original UI)

**Owner:** TL · **Inputs:** deliverables 01–06 · **Rule:** the original ZCode New Task
experience remains intact — theme, design system, layout, header, navigation,
composer, Browser/Terminal/Computer-Use controls, model selection, responsive and
remote behaviour. PaySwap appears **inside** that experience, additively.

## 1. What the user actually sees (and does not see)

Nothing about New Task changes until the user opts in. With PaySwap active:

1. **Conversation-first.** Financial discovery and operation happen as model answers
   in the normal message stream — the model is an orchestrator over PaySwap's
   `payswap_*` MCP tools (deliverable 05). No new chat application, no replacement
   composer, no hardcoded model list.
2. **Approval rides two independent layers** (addendum §1, normative). Layer 1:
   `payswap_*` tools are ordinary MCP tools — `needsApproval: true` at registration
   (`core/src/mcp/index.ts:148`) — so they prompt like every MCP tool in
   build/edit mode. **That registration alone is not a security boundary:** the
   permission service's decision order lets yolo/guarded modes, session allow
   rules, `allowedTools` config, owned workflow amendments, and subagent/automation
   contexts reach `allow` without a prompt (`core/src/permission/service.ts:148`,
   `:399-456` — verified in addendum §1.1). Layer 2 is therefore where money is
   actually controlled: the host execution authority refuses every money-affecting
   operation without a valid, single-use, expiry-bound, tuple-bound Authorization
   Grant that only a host-verified human approval event can create. Yolo mode can
   silence prompts; it cannot mint grants. The approval origin itself is
   specified in addendum §1.6: host-controlled approval surface, one-time
   host-generated challenge, transaction-digest binding, renderer/window
   ownership verification, and structural exclusion of plugin-webview and
   model-originated approvals. Negative E2E rows N1–N24 (addendum §1.7)
   are the proof.
3. **Additive cards, not new pages.** Financial context renders through the existing
   generative-UI/plugin surface contract (`ui.surfaces[]` + `ui://` resources in
   the hardened plugin sandbox webview, mounted via `pluginUiBridgeService` —
   deliverable 03 §6): account-connection cards, route-plan cards (existing /
   conditional / opportunity clearly labelled, never "executable" until
   requirements are satisfied), authorization-request cards binding principal,
   account, recipient, amount, currency, purpose, full route+legs, fees, FX
   conditions, expiry, and reconciliation/ledger evidence cards.
4. **An optional financial workspace toggle** — added through the same extension
   surface as existing workspace panels, never by editing the New Task layout.
   Off by default; invisible when no account is connected.
5. **Connection onboarding** happens in a plugin-sandboxed UI surface
   (`payment=()` permissions policy already excludes payment handlers — provider
   flows open through the platform shell, per the platform-service abstraction),
   with credentials going directly to the PaySwap account service →
   `ICredentialService` — never through chat, logs, or model context.

## 2. What never happens

- No replacement or restyling of the header, navigation, composer, theme, or any
  original control (preservation matrix, deliverable 02, is the enforcement record).
- No direct `window.zcode` calls, no UI→Repo references, no cross-domain imports
  (AGENTS.md + architecture check own this).
- No provider secrets in `userConfig` (plaintext persistence verified in
  deliverable 03 §4.1) — credentials ride `ICredentialService` exclusively.
- No simulated accounts, balances, beneficiary IDs or capabilities presented as
  real — every capability claim is evidence-backed (deliverable 05 §2) or the typed
  refusal.
- The model never authorizes; approval binds the human principal server-side
  (deliverable 06 §authorization).

## 3. Acceptance criteria (corrected — addendum §2, normative)

The four-state model replaces the earlier on/off zero-diff wording:

- **S0** (plugin absent/disabled): identical to upstream `a9fe401` — the
  zero-difference proof compares this state against upstream.
- **S1** (enabled, not opted in): rendered interface identical to S0. Tools may
  register and are inert (`not_opted_in` typed refusal — distinct from
  `not_connected`, addendum §2.1). No cards, no toggle.
- **S2** (opted in): only surfaces declared in the `ui.surfaces[]` registry may
  render — the registry is the complete, closed definition of what PaySwap adds.
- **S3** (invariant): composer, model selector, Browser/Terminal/Computer-Use
  controls, theme, navigation, layout unchanged in every state. Local-workspace
  bridge capability limitation preserved (Web/remote surfaces that do not declare
  the plugin-UI capability render no PaySwap cards).

**The exact opt-in path (addendum §2.1):** the plugin's boolean `userConfig`
option `financialWorkspace` (default `false`), rendered by the **existing**
plugin settings surface (`packages/ui/src/settings/PluginConfigControls.tsx` —
already renders `userConfig` options with a `Switch`). Opt-in is the user
flipping that switch; no new settings page, no composer control, no navigation
change. State refusals are three distinct codes — `financial_mode_disabled` /
`not_opted_in` / `not_connected` — never conflated.

**Transition acceptance tests (P1, addendum §2.2):** T1 enable (S0→S1,
zero-diff), T2 opt-in (S1→S2, declared surfaces only, code `not_opted_in` →
`not_connected`), T3 opt-out (S2→S1, surfaces disappear), T4 disable (→S0,
tools unregistered), T5 uninstall (→S0, credentials revoked, ledger evidence
retained per retention rules or exported by explicit operator choice), T6
settings page unchanged beyond the plugin's own declared options.

## 4. The acceptance look

A user with a connected Stripe account asks, in the existing New Task box, "what
can I use to pay a supplier in Kenya?" — the model answers from the evidence-backed
capability registry via `payswap_*` tools; a route card renders inline listing the
direct baseline first, then conditional/opportunity routes clearly marked; any
money movement surfaces an authorization-request card binding the full grant tuple
(addendum §1.3); execution outcomes come from provider read-back and appear as
evidence cards. Every step of that sentence maps to an existing ZCode surface named
in deliverables 03 and 06 — that mapping is the design.
