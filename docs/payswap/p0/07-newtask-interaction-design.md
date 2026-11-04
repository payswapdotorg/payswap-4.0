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
   model-originated approvals. Negative E2E rows N1–N42 (addendum §1.7)
   are the proof.
3. **Additive cards in two trust classes (addendum §1.6.0, normative).**
   Financial context renders through two distinct surfaces:
   - **Class A — informational cards** through the existing generative-UI/plugin
     surface contract (`ui.surfaces[]` + `ui://` resources in the hardened
     plugin sandbox webview, mounted via `pluginUiBridgeService` — deliverable
     03 §6): account-connection cards, route-plan cards (existing /
     conditional / opportunity clearly labelled, never "executable" until
     requirements are satisfied), and reconciliation/ledger evidence cards.
   - **Class B — the authorization card is not one of them.** It is
     **host-rendered in the trusted application renderer**, following the
     permission-prompt projection pattern (host-computed payload → rendered as
     data → interaction-resolution return path; addendum §1.6), binding
     principal, account, recipient, amount, currency, purpose, full route+legs,
     fees, FX conditions, expiry. It is never declared in `ui.surfaces[]`, never
     a `ui://` resource, never resolvable via `mcp/uiCallTool` — upstream's
     plugin-UI contract validates `ui://` content structurally only and trusts
     the plugin's declaration
     (`packages/services/src/plugin-ui-bridge/contract.ts:27-31`), which is
     exactly why a plugin surface can never host a money authorization. The
     manifest validator rejects authorization-styled declarations (N25).
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

The state model replaces the earlier on/off zero-diff wording (two rounds of
architect correction applied):

- **S0a** (not installed): identical to upstream with no such plugin — the
  zero-difference proof compares this state against upstream.
- **S0b** (installed, disabled): identical to upstream's installed-and-disabled
  state (upstream itself renders management rows for disabled plugins; a
  disabled plugin contributes zero runtime components).
- **S1** (enabled, not opted in): the rendered-surface delta vs S0 is exactly
  the standard upstream delta of any enabled plugin with an MCP server
  (`@`-mention list, MCP settings rows, plugin-UI launcher entries) — **no
  PaySwap-specific chrome**; no cards, no composer toggle, no navigation
  change. Tools are registered and inert (`not_opted_in` typed refusal —
  distinct from `not_connected`, addendum §2.1).
- **S2** (opted in): only (a) Class-A surfaces declared in the `ui.surfaces[]`
  registry may render — informational classes only; authorization-styled
  declarations are rejected at manifest validation (N25) — and (b) the
  host-rendered authorization card (Class B), which renders only while a grant
  proposal is pending.
- **S3** (invariant): composer, model selector, Browser/Terminal/Computer-Use
  controls, theme, navigation, layout unchanged in every state. Local-workspace
  bridge capability limitation preserved (Web/remote surfaces that do not declare
  the plugin-UI capability render no PaySwap cards).

The S1-vs-S0 oracle is **delta-equivalence against a control plugin**, not
zero-diff — upstream visibly renders enabled plugins, so "tools registered"
and "no visual delta" cannot both hold (addendum §2 states the upstream
evidence). Refusal-code flips are immediate (live broker state); plugin-UI
surfaces follow the upstream per-session lifecycle ("Takes effect in new
sessions").

**The exact opt-in path (addendum §2.1):** the plugin's boolean `userConfig`
option `financialWorkspace` (default `false`), rendered by the **existing**
plugin settings surface (`packages/ui/src/settings/PluginConfigControls.tsx:148-158`
— boolean `userConfig` options render a `Switch`). Opt-in is the user
flipping that switch; no new settings page, no composer control, no navigation
change. State refusals are three distinct codes with reachability semantics
fixed in addendum §2.1 — `not_opted_in` (S1) and `not_connected` (S2, no
account) come from the broker's live state; `financial_mode_disabled` is the
broker's refusal for residual calls from sessions that predate a
disable/uninstall — never conflated.

**Transition acceptance tests (P1, addendum §2.2):** T1 enable (S0b→S1 —
delta-equivalence + inert tools), T2 opt-in (S1→S2 — immediate code flip,
surfaces per upstream session lifecycle, authorization card only on pending
proposals), T3 opt-out (S2→S1 — revert; surfaces already open at the moment
of opt-out follow the host-side revocation semantics), T4 disable (→S0b — new
sessions upstream-identical; running sessions keep their frozen tool surface
per upstream semantics but money ops refuse `financial_mode_disabled`), T5
uninstall (→S0a — credentials revoked, ledger evidence retained per retention
rules or exported by explicit operator choice), T6 settings page unchanged
beyond the plugin's own declared options, **T7 opt-out with live surfaces**
(S2→S1 while an informational surface and an authorization proposal are open
— addendum §2.3, both arms asserted: the surface's data queries refuse
`not_opted_in` **and** every instance that already rendered protected account
data is disposed or replaced by the host — its DOM and JavaScript context no
longer exist, the replacement instance is fresh and dataless, and the per-key
renderer-side retention (feed snapshot, widget state) is cleared, so reopening
the surface cannot restore stale balances; the surface is non-actionable, the
pending proposal and its challenge are invalidated so a late approval click is
rejected, new sessions follow the updated state, and the upstream plugin
lifecycle is untouched).

**Opt-out is host-side revocation, not a per-surface courtesy (addendum §2.3,
normative):** the broker's live state closes the data path to open surfaces,
the host's challenge registry invalidates pending proposals, and — for
surfaces that have already rendered protected account data — the host
**disposes or replaces the surface instance itself**, on upstream's own
teardown discipline (bounded `ui/resource-teardown` cleanup window, then
`disposeSandbox` by the captured `sandboxId`/`initId`; the per-key
renderer-side feed/widget retention cleared with it), so already-rendered
content stops being exposed rather than merely failing to refresh. The
guarantee never depends on the surface's cooperation, and no upstream plugin
lifecycle semantics are modified — disposal touches only PaySwap-tracked
instances.

## 4. The acceptance look

A user with a connected Stripe account asks, in the existing New Task box, "what
can I use to pay a supplier in Kenya?" — the model answers from the evidence-backed
capability registry via `payswap_*` tools; a route card renders inline listing the
direct baseline first, then conditional/opportunity routes clearly marked; any
money movement surfaces the **host-rendered authorization card** binding the full
grant tuple (addendum §1.3/§1.6.0 — Class B, never a plugin webview surface);
execution outcomes come from provider read-back and appear as
evidence cards. Every step of that sentence maps to an existing ZCode surface named
in deliverables 03 and 06 — that mapping is the design.
