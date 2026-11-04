# PaySwap P0 — The Provider Plugin Contract

**Worker:** P0-W3 (audit/architecture) · **Recorded:** 2026-11 · **Status:** design input, not implementation permission

This document defines the contract a **PaySwap provider plugin** (a payment-service-provider adapter, e.g. Stripe, Paystack, PayPal) implements. It is the boundary between PaySwap's common layer (routing, authorization, execution, ledger — doc 06) and per-provider code.

**Governing principle:** a provider plugin describes and executes *provider facts and operations*. It never owns routing, authorization policy, or ledger semantics. The model (LLM) is never in this contract's trust boundary — it consumes a narrow, common-layer tool surface (§10).

---

## 1. Extension surfaces this contract rides (repo-verified)

I verified the following surfaces in this worktree at `a9fe401`. Another P0 worker owns the deep audit of plugin/MCP architecture; everything below I read myself.

| Surface | Evidence (path / symbol) |
|---|---|
| Plugin manifest with `mcpServers`, `commands`, `agents`, `skills`, `hooks`, `ui`, `userConfig` | `apps/zcode-cli/packages/contracts/src/plugins/index.ts` — `PluginManifest`, `PluginMetadata`, `PluginConfig` |
| Plugin user config options incl. `sensitive?: boolean` | same file — `PluginUserConfigOption` |
| Plugin discovery/load outcome (namespaced MCP servers, skill roots, diagnostics) | same file — `PluginLoadOutcome`, `PluginPort.discoverPlugins` |
| Plugin MCP server identity: `plugin:<pluginName>:<serverKey>` runtime namespace; official plugin id form `computer-use@zcode-plugins-official` | `packages/shared/src/mcp.ts` — `ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME`, `ZCODE_PLUGIN_ID_ENV_KEY` |
| MCP server config (stdio/http/sse, command/args/env, headers, OAuth machine credentials) | `packages/shared/src/mcp.ts` — `McpServerConfig`, `McpOAuthConfig` (`authorization_code` \| `client_credentials`), `ZCodeAgentMcpServer` (isolation session/workspace, protocolVersion) |
| MCP workspace trust with manifest digest | `packages/shared/src/zcode-protocol/index.ts` — `zcodeWorkspaceMcpTrustParamsSchema` (`declarationDigest` sha256, `trusted`), `WorkspaceMcpTrustReview` |
| Plugin-scoped, agent-side fail-closed MCP UI/read/sampling proxies | same file — `zcodeMcpUiOpenInstanceParamsSchema` (pluginId-scoped), `zcodeMcpUiSamplingParamsSchema` |
| Host credential store (the ONLY secret store) | `packages/services/src/credential/credential.ts` (`ICredentialService`, RPC via `ServiceChannels.Credential`, `packages/shared/src/channels.ts`); `credentialService.ts` (AES-256-GCM `enc:v1:` at `credentials.json`, file-locked, atomic, corrupt-refuse-overwrite) |
| OAuth service pattern (host-side flow, state lifecycle, token exchange, credential storage) | `packages/services/src/oauth/oauth.ts` — `IOAuthService` |
| Service descriptor / RPC channel pattern for host services | `packages/services/src/descriptors.ts` — `createServiceDescriptor`; `packages/shared/src/channels.ts` — `ServiceChannels`; `packages/services/src/accessor.ts` — `IServiceAccessor` |
| Tool registry in the agent runtime (name/alias identity protection) | `apps/zcode-cli/packages/core/src/tool/registry.ts` — `ToolRegistry` |
| **Known gap:** plugin `userConfig` values marked `sensitive` have **no secure persistence today** | `apps/zcode-cli/packages/zcode-guide-plugin/skills/diagnosing-plugins/SKILL.md`: "There is no secure credential store yet … it cannot be persisted today" |

**Consequence of the gap:** PaySwap cannot rely on plugin `userConfig.sensitive` for PSP credentials. The contract below defines credential acquisition/storage as a **PaySwap-owned host service** that uses the existing `ICredentialService` — this is additive, fills a real gap, and does not modify the plugin runtime.

---

## 2. Two adapter topologies, one contract

The contract is transport-agnostic; two conforming topologies:

1. **First-party in-process adapter (P0, money-critical):** TypeScript modules in `packages/services/src/payswap/providers/<providerId>/`, running inside the desktop/web **host process** (where `packages/services` services already run). The execution authority calls them directly. No IPC hop on the money path; full static typing; contract enforced by shared zod schemas.
2. **Third-party plugin-shipped adapter (P1, reach):** a plugin whose `plugin.json` declares `mcpServers` exposing the same JSON tool contract (`payswap_*` tool names, §10) over stdio/http. Subject to the existing workspace trust review (declaration digest), plus PaySwap capability-schema version checks. **Money movement through third-party adapters is out of P0 scope** until the acceptance suite (§12) can prove the boundary remotely.

Rationale: ZCode's model-provider stack keeps first-party providers in trusted packages (`packages/provider`, `packages/provider-node`, `packages/services/src/model-provider/`) while plugins extend via MCP; PaySwap mirrors that split — trusted first-party adapters for money movement, plugin surface for distribution/extension later.

---

## 3. Manifest & identity

A PaySwap provider adapter declares identity in its provider descriptor (first-party: a TypeScript constant registered in the provider catalog; third-party: manifest extension):

```ts
// Illustrative — canonical types live in packages/shared/src/payswap/ (doc 06 §2.1)
interface PayswapProviderDescriptor {
  providerId: "stripe" | "paystack" | "paypal" | `${string}`;   // stable, lowercase
  displayName: string;
  contractVersion: number;        // this document's contract major version
  capabilitySchemaVersion: number;
  authSpec: PayswapAuthSpec;                       // §5
  operations: readonly PayswapOperationId[];       // §6 — operations it implements
  researchFactSheet: string;                      // docs/payswap/provider-facts/<id>.md (evidence-stamped)
}
```

- `providerId` is namespaced like plugin identity (`name@marketplace` precedent: `PluginReferenceCatalogEntry.pluginId`). Conflicting duplicate `providerId`s fail closed (precedent: duplicate-provider rejection in `packages/provider/src/registry.ts` `#rebuildIndexes`; ambiguous plugin ids fail closed in `PluginReferenceCatalogEntry.conflictingPluginIds`).
- Version mismatch between adapter `capabilitySchemaVersion` and the common layer → adapter **quarantined** (its connection stays, operations refuse typed `policy_blocked: contract_version_mismatch`). Fail-closed precedent: `createFailClosedAccountProviderConfigSnapshot` (`packages/provider/src/sources.ts`).

## 4. Capability declaration — evidence, never claims

The adapter's core duty after connecting is to produce a **capability record derived from the account's actual state**:

```ts
interface PayswapCapabilityRecord {
  providerId: string;
  connectionId: string;
  schemaVersion: number;
  declaredAt: string;                    // ISO timestamp
  evidence: PayswapEvidenceRef;          // ledger seq of the raw read-back that produced this record
  operations: readonly OperationCapability[];
}

interface OperationCapability {
  operation: PayswapOperationId;         // §6 taxonomy
  status: "enabled" | "available" | "pending" | "restricted" | "unavailable";
  restrictions: readonly OperationRestriction[];  // empty = unrestricted within operation semantics
}

interface OperationRestriction {
  kind: "country" | "currency" | "method" | "amount" | "product" | "entitlement"
       | "purpose" | "rate-limit" | "other";
  allow?: readonly string[];             // ISO country codes, ISO-4217 currencies, method names…
  deny?: readonly string[];
  min?: string; max?: string;            // decimal strings — never floats (Paystack subunits!)
  note?: string;                         // human explanation + fact-sheet citation
}
```

Rules:

- **Evidence sources, per provider (as of 2026-11, ⚠ RE-VERIFY per doc 04 §5):** Stripe → Account `capabilities`/`requirements` read-back; Paystack → balance/transfer-control/recipient-type availability read-back per market; PayPal → token scopes + payouts permission probe in the account's environment.
- An adapter that cannot produce evidence for an operation **must** declare it `unavailable` with a reason. Hardcoded marketing capability tables are forbidden as capability sources; static provider knowledge may only fill `note` fields with citations to the research fact sheet.
- Restrictions are declared at the finest grain the provider's evidence supports. Unknown = `unavailable`, not optimistic defaults.
- The capability record is **immutable and revisioned** — mirroring `ProviderRegistry`'s frozen views + revision counter + `onDidChange` (`packages/provider/src/registry.ts`). New evidence ⇒ new record; the registry keeps history.

## 5. Authentication surface

One spec per provider, matching the three real-world models compared in doc 04:

```ts
interface PayswapAuthSpec {
  providerId: string;
  acquisition: (
    | { kind: "operator-supplied-secret";
        label: string;                       // e.g. "Stripe restricted key"
        placeholder: string;                 // "sk_live_<placeholder>" — never a real key
        formatCheck: string;                 // defensive pattern; final authority is provider read-back
        modeDistinguishable: "key-prefix" | "separate-credentials" | "environment"; }
    | { kind: "oauth-authorization-code";    // host-side flow, IOAuthService pattern
        authorizeUrl: string; tokenUrl: string; scopes: readonly string[];
        stateValidation: "host-managed"; }
    | { kind: "client-credentials";          // PayPal own-account
        tokenUrl: string; scopes: readonly string[];
        environmentSplit: "sandbox-app" | "live-app"; }
  )[];
  secretKinds: readonly ("api-key" | "client-id" | "client-secret" | "refresh-token"
                       | "webhook-secret" | "webhook-id")[];
  storageKeyTemplate: "payswap:psp:<providerId>:<connectionId>:<secretKind>";
  rotationUrl?: string;                       // dashboard deep link (apiKeyManagementUrl precedent)
  revoke: "delete-local-only" | "delete-and-provider-deauthorize";
}
```

- **Acquisition:** operator-supplied secrets enter through a settings UI surface (additive `model-provider-section`-pattern section) or through the conversation via a *credential-request* interaction that opens the same host UI — never typed into chat. OAuth flows run in the host process with `state` validation (extend `IOAuthService` pattern additively).
- **Storage:** `ICredentialService` only, under the namespaced keys above. The renderer and the agent never receive secret values — only opaque connection status (`connected | expired | revoked | test | live`). The account service (doc 06 §2.2) is the only writer.
- **Session/refresh:** short-lived tokens (PayPal access tokens) live in host memory only; refresh tokens live in the credential store; expiry is projected as connection status, never as a hard error mid-leg (executor re-validates before submit).
- **Revocation:** delete local secrets → provider-side deauthorize where supported (`revoke: "delete-and-provider-deauthorize"`) → **verify** loss of access via evidence refresh. A revoked connection can never keep a stale "connected" status.

## 6. Operation surface

### 6.1 Operation taxonomy (P0 set)

```
collections.read        payment_objects.read    customers.read/write
recipients.read/create/verify
refunds.read/create     transfers.read/create   payouts.read/create
invoices.read/write     subscriptions.read/write
disputes.read/respond   balances.read           reporting.read
webhooks.verify         reconciliation.read
```

`create` = money-affecting write. Write ops are only ever invoked by the **execution authority** (doc 06 §2.8), never by the model, never by the adapter's own initiative.

### 6.2 Typed request/response

```ts
interface PayswapOperationRequest {
  operation: PayswapOperationId;
  connectionId: string;
  params: unknown;                          // per-operation zod schema in shared contracts
  idempotencyKey?: string;                  // REQUIRED for writes; executor-allocated (§6.3)
  dryRun?: boolean;                         // where provider sandbox semantics allow
}

type PayswapOperationResult =
  | { kind: "accepted"; providerRef: string;        // provider's stable object id
      provisionalOutcome: unknown;                   // e.g. Paystack transfer "processing"
      recordedAt: string }
  | { kind: "refused"; refusal: PayswapRefusal }
  | { kind: "unknown"; unknown: PayswapUnknownOutcome };
```

### 6.3 Idempotency

- Idempotency keys are **allocated by the execution authority per leg at route-validation time** and are immutable for the leg's lifetime. Adapters **relay** them onto the provider's native mechanism: Stripe `Idempotency-Key` header; Paystack unique transfer `reference`; PayPal `sender_batch_id`/`sender_item_id` (⚠ RE-VERIFY dedupe windows per doc 04 §5).
- Adapters never generate their own idempotency identity for writes. A crash-recovered resubmit reuses the same key; a provider duplicate rejection maps to typed `duplicate_reference`, which the executor interprets as "already in flight — reconcile, don't recreate".

### 6.4 Read-back

Every write operation must have a read counterpart used by the executor immediately after submit and by reconciliation later (`transfers.read { providerRef }` etc.). The adapter returns the provider's **current authoritative status**, mapped to PaySwap's normalized outcome vocabulary (`pending | processing | succeeded-provisional | failed | reversed | unknown`), preserving the raw provider status as evidence.

### 6.5 Webhook ingestion & signature verification

```ts
interface PayswapWebhookIngress {
  verify(rawBody: Buffer, headers: Record<string, string>): "verified" | "unverified";
  parse(rawBody: Buffer): NormalizedPayswapEvent;   // event id, provider event type, refs, timestamps
}
```

- Verification uses the raw body **before parsing** (Paystack HMAC-SHA512; Stripe `t.${payload}` HMAC-SHA256; PayPal transmission-header verify call — doc 04).
- Adapters normalize provider events to a common event envelope; **dedupe is the common layer's job** (PayPal events are at-least-once; Stripe/Paystack retries exist too). Events never mutate execution state directly — they flow through event processing + reconciliation semantics (doc 06 §2.10/§2.11).

### 6.6 Error taxonomy — typed refusals, never silent passes

```ts
interface PayswapRefusal {
  code: ( "auth_failed" | "insufficient_permission" | "capability_not_enabled"
        | "recipient_invalid" | "amount_limit" | "currency_unsupported"
        | "region_unsupported" | "risk_flagged" | "duplicate_reference"
        | "rate_limited" | "validation_failed" | "provider_unavailable"
        | "policy_blocked" | "unsupported_operation" );
  providerCode?: string;      // raw provider error code, for evidence & research tooling
  message: string;            // operator-readable, credential-free
  retryable: boolean;         // true ONLY when duplication is provably impossible
  evidenceRef?: PayswapEvidenceRef;
}
```

- **`kind: "unknown"` is a first-class result.** Timeouts after submit, connection drops mid-response, provider 5xx with no idempotent replay guarantee ⇒ `unknown` with what-was-submitted as evidence. The executor parks unknown legs; it never auto-retries them (doc 06 §8, invariant 2). An adapter that maps an ambiguous provider response to `accepted` or `refused` fails its acceptance suite.
- Unmapped provider errors must surface as `provider_unavailable` (or `unknown` post-submit) with the raw code preserved — silent normalization into "success" is a contract violation.

## 7. Eligibility surface

Adapters answer per-operation eligibility **from evidence** (optionally with a live provider check where evidence is stale or insufficient):

```ts
interface PayswapEligibilityQuery {
  operation: PayswapOperationId;
  connectionId: string;
  constraints: { country?: string; currency?: string; amount?: string;
                 method?: string; recipientKind?: string };
}
interface PayswapEligibilityAnswer {
  eligible: boolean;
  basis: "evidence" | "live-check";
  evidenceRef: PayswapEvidenceRef;      // capability record or live-check ledger entry
  checkedAt: string;
  blockers: readonly OperationRestriction[];
}
```

Eligibility answers feed route discovery (doc 06 §2.7). An adapter answering from anything other than evidence/live-check (e.g. hardcoded country lists) fails the acceptance suite.

## 8. What the plugin does NOT own (boundary restated)

| Concern | Owner |
|---|---|
| Route discovery & ranking (direct-route baseline, conditional/opportunity routes) | Common layer (doc 06 §2.7) |
| Authorization records, approvals, reauthorization policy | Common layer (doc 06 §4) |
| Ledger semantics (append-only evidence, financial facts) | Common layer (doc 06 §2.12) |
| Intent interpretation (NL → typed intent) | Common layer compiler (doc 06 §2.4) |
| Idempotency key allocation | Execution authority (doc 06 §2.8) |
| Retry/compensation decisions | Execution authority (doc 06 §2.8) |
| Model-facing tool surface | PaySwap official plugin (doc 06 §1.1), not the provider adapter |

## 9. Agent-facing surface (what the model actually sees)

The model gets **zero** direct provider tools. It sees the narrow common-layer MCP toolset exposed by the PaySwap official plugin (namespaced `plugin:payswap:*`, per the `plugin:<name>:<server>` convention):

`payswap_compile_intent` · `payswap_check_eligibility` · `payswap_discover_routes` (always includes direct-route baseline) · `payswap_request_authorization` · `payswap_get_execution_status` · `payswap_get_account_overview` (redacted, evidence-based)

Every tool is a thin, typed proxy. The MCP server process (stdio child of the host)
holds no financial state, no credentials, and no ledger access; tool calls reach the
host financial services **only** through the authenticated broker bridge (addendum
§3, normative): `Model → payswap_* MCP tool → authenticated host-owned broker →
financial service → provider adapter`. The broker authenticates the **calling
process** — per-process-instance credentials, OS peer verification against the
host-registered plugin instance, socket/pipe filesystem restrictions, endpoint
replacement protection, **broker-instance replay protection** (request identity
is (instance id, sequence number); the per-instance seen-record is a
**contiguous watermark** — the highest sequence below which every request has
been accepted — plus a retained set of every accepted sequence above it,
**completed requests included**, held until the watermark advances past them,
so an out-of-order request that already completed cannot be replayed before
the missing lower sequence arrives; a bounded maximum sequence gap refuses
skips ahead typed; duplicates are rejected before dispatch; the record
survives connection changes at broker-instance scope, with durable
operation-level idempotency — §6.3 — complementary underneath), and, on Windows,
a native spawn-verified helper that holds the pipe endpoint, verifies each
client's pid and image path, and relays only verified requests to the host over
its parent-pid-bound, token-authenticated channel (addendum §3.5.7–§3.5.9) —
a plugin identity claim alone is never
sufficient. The broker's dispatch table is closed — exactly these six operations,
no general `ServiceChannels` access (ServiceChannels is the renderer↔host fabric;
it is not an API for an external MCP process). Tool registration rides the agent
runtime's `ToolRegistry` (`apps/zcode-cli/packages/core/src/tool/registry.ts`);
invocation permission rides the existing permission protocol
(`packages/shared/src/zcode-protocol/index.ts`) with money movement
`riskLevel: "critical"` — and **no money operation executes without a valid,
single-use Authorization Grant** (addendum §1.3: host-minted, tuple-bound,
expiry-bound; the permission layer governs invocation noise, the grant governs
money). State refusals are three distinct typed codes, never conflated, with
reachability semantics fixed in addendum §2.1: `not_opted_in` (S1) and
`not_connected` (S2, no account) are returned by the broker for live tool
calls; `financial_mode_disabled` is the broker's refusal for **residual calls**
from sessions that predate a disable/uninstall (in steady-state S0 the tools
are not registered at all — upstream `emptyComponents` semantics — so nothing
else could return it).
Negative E2E rows N1–N42 (addendum §1.7) prove the bypass resistance, the
approval-origin and server-principal boundaries (including the credential
lifecycle and workspace-scoped roles), the broker boundary (including the
out-of-order completed-request replay), and the ledger single-writer boundary
(including lease fencing and owner-checked release).

## 10. Persistence & state rules for adapters

- **No adapter-owned databases or stores.** Adapters are stateless beyond in-memory token caches; every durable fact they produce goes into the ledger or capability registry via common-layer services (single-writer rules, doc 06 §5).
- **No adapter-side Zustand/state.** UI reads only common-layer projections (`packages/ui/src/store/` additive store, doc 06 §5).
- Token caches are rebuilt from the credential store on restart; nothing financial lives in renderer-local state (AGENTS.md: UI 局部状态不应被误当作服务端事实).

## 11. Versioning & compatibility

- `contractVersion` (this document) and `capabilitySchemaVersion` advance independently; the common layer refuses/quarantines on major mismatch (fail-closed).
- Capability records embed `schemaVersion`; the registry can render old records read-only for audit but never executes against a stale schema.

## 12. Acceptance suite (gate to ship / to enable live mode per provider)

Conformance harness with recorded fixtures (precedent: model-provider fixture testing `packages/provider/test/provider-config-fixtures.ts`, regression tooling `apps/zcode-cli/tools/provider-regression/`):

1. **Auth fixtures** per acquisition kind: valid, malformed, expired, wrong-mode (test key offered as live).
2. **Evidence generation**: connect sandbox → capability record produced from real read-back; restrictions match the fixture account's actual state.
3. **Refusal taxonomy coverage**: at least one fixture per refusal code; every fixture asserts the typed code (not just "failed").
4. **Webhook verification fixtures**: known-signed payloads (Stripe `t/v1`, Paystack HMAC-SHA512, PayPal verify-call stub) + tampered payloads ⇒ `unverified`.
5. **Idempotency test**: submit → crash → resubmit with same key ⇒ same `providerRef`, no duplicate money movement (sandbox or recorded).
6. **Unknown-outcome test**: injected post-submit timeout ⇒ `kind: "unknown"`, no retry, ledger records submitted payload.
7. **Read-back mapping test**: each provider status (incl. Paystack `reversed`, PayPal `UNCLAIMED`) maps to the normalized vocabulary correctly.
8. **Redaction test**: no fixture output contains credential-shaped strings (scanned).

All eight green for a provider ⇒ that provider's adapter may request live-mode enablement (still behind the global live gate, doc 06 §8, invariant 4).

---

## 13. Open questions for the TL (contract level)

1. **Third-party adapter timeline** — is P1 MCP-topology adapter distribution in scope for the mission, or do we declare first-party-only for the foreseeable horizon?
2. **Credential-entry-in-conversation UX** — when an operator says "connect my Stripe" in the New Task flow, do we open the settings surface (safe, existing patterns) or design an in-conversation credential attachment flow (new interaction contract)? P0 recommendation: settings surface + deep-link from conversation.
3. **PayPal payouts-permission probing** — probing capabilities on a sandbox vs live app may differ; do we accept "live evidence collected at live-mode-gate time" as the first live capability record?
4. **Webhook ingress topology** — desktop P0 runs poll-based reconciliation (doc 06 §2.10); confirm no desktop-local webhook listener is wanted for P0.
