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
2. **Approval prompts ride the existing mechanism.** Every `payswap_*` tool call is
   `needsApproval: true` always (the MCP precedent verified in deliverable 03 —
   MCP tools are always approval-gated; app-tool "always allow" is session-only).
   Money-moving operations can never be silenced by yolo/accept-edits modes (P1
   hardening task with Worker 2).
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

## 3. The acceptance look

A user with a connected Stripe account asks, in the existing New Task box, "what
can I use to pay a supplier in Kenya?" — the model answers from the evidence-backed
capability registry via `payswap_*` tools; a route card renders inline listing the
direct baseline first, then conditional/opportunity routes clearly marked; any
money movement surfaces an approval prompt whose card binds the full authorization
tuple; execution outcomes come from provider read-back and appear as evidence
cards. Every step of that sentence maps to an existing ZCode surface named in
deliverables 03 and 06 — that mapping is the design.
