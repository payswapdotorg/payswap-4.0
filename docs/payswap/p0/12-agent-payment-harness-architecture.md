# PaySwap 4.0 — Agent-native Payment Harness Architecture

**Decision date:** 2026-11-15  
**Decision state:** approved P3–P9 product architecture; this is a design baseline, not evidence that implementation is complete.  
**Authority:** the canonical roadmap is `10-roadmap.md`; the normative security and authorization rules are in `11-architecture-addendum.md`.

## 1. Product decision

PaySwap 4.0 becomes one **payment-centric, multi-agent ZCode harness backed by the existing PaySwap financial core**. It combines outcome-oriented agent discovery, delegated specialist workflows, provider-neutral payment orchestration and payment-protocol interoperability with the accounts, capabilities, eligibility, FX, routing, authorization, execution, evidence and reconciliation architecture already defined in PaySwap 4.0.

There are not two products joined by a bridge. There is one application, one agent runtime, one financial control plane, one execution authority and one financial evidence ledger.

PaySwap orchestrates payments; it does not take custody of customer funds.

### Explicit non-goals

- Do not fork or replace ZCode's agent runtime, model-provider stack, task/session semantics, MCP, plugins, skills, workflows, automations, permission system or New Task shell.
- Do not add a second agent runtime, payment broker, account registry, provider-capability registry, authorization authority, execution engine, ledger or reconciliation system.
- Do not vendor/copy TReg source. Its product concepts may inform an independent implementation; source reuse requires separate licence and legal review.
- Do not issue or manage customer wallets/keys, accept deposits, maintain stored value, escrow, extend credit/lend, custody or pool customer funds, hold float, become merchant of record or operate settlement. Users may connect wallets they already control through a separate WalletConnector; that connector cannot import/export keys, create a PaySwap wallet or grant ambient spending permission.
- Do not let a model, agent, plugin, protocol adapter, webhook or automation mint financial authority.
- No provider writes before P7 acceptance; no live-money operation before the separate operator-controlled live gate.

## 2. One product, three layers

```text
PAYMENT-CENTRIC ZCODE HARNESS
  Existing ZCode application, runtime, model selection, tasks, MCP, agents,
  plugins, skills, workflows and automations
  + outcome-oriented discovery and financial task interaction
  + mission coordination using existing ZCode agents
                         |
                         v
PAYSWAP AGENTIC CONTROL PLANE
  Agent Catalog (derived from existing manifests and trust state)
  Mission Planner / Coordinator (no second runtime)
  Host-owned Delegation and Authority Envelope policy
  Protocol Adapters (AP2 / x402 / MPP / agent identity)
                         |
                         v
ONE PAYSWAP FINANCIAL CORE
  Accounts and Credentials
  Provider Capability + Evidence Registry
  Intent Compiler -> Eligibility / Policy -> FX / Liquidity
  Deterministic Routing -> Transaction Authorization
  ONE Execution Authority -> Provider Events -> Reconciliation
  ONE Append-only Financial Evidence Ledger
                         |
                         v
EXTERNAL FINANCIAL PARTIES
  Banks, licensed PSPs, mobile-money/e-money providers, card networks,
  cross-border providers, merchants and suppliers
```

### 2.1 ZCode remains the agent execution substrate

The mission coordinator schedules work using existing ZCode agent/task/session/workflow machinery. It does not supervise a separate agent fleet or copy conversation histories into another database. Existing general-purpose ZCode behavior remains available outside the explicitly enabled financial workspace.

### 2.2 Agent control plane is not financial authority

Agents may propose supplier matches, invoice facts, policy findings, capability lookups, route comparisons and explanations. Outputs are untrusted until validated by the owning deterministic PaySwap service. An agent's publisher, skill name, reputation or marketplace listing does not confer permission.

### 2.3 Exactly one financial core

The existing PaySwap domains remain authoritative for connected accounts, provider capabilities, eligibility, purpose classification, FX, routing, transaction grants, provider writes, provider events, evidence and settlement reconciliation. The agent harness composes these domains; it does not replicate them.

There is exactly one owner for each of: credentials, account connections, provider capability evidence, policy eligibility, authorization grants, provider submission, financial ledger and reconciliation. External protocols are boundary adapters, not new payment engines.

## 3. Keep three catalogs distinct

| Catalog | What it describes | Authority |
|---|---|---|
| Agent catalog | Installed/discoverable agent, skill or workflow; publisher/version; outcomes; task types; typed I/O; required tools/scopes; data classes; credential posture; platform requirements; cost terms and trust evidence | Derived/read-only view of existing ZCode manifests and host trust state. It cannot grant install, tool, hook, network or financial permission. |
| Provider capability registry | Verified operations and restrictions for an actual connected provider account: country, currency, rail, amount, product, method, purpose, recipient and entitlement | Existing PaySwap evidence-backed capability registry remains sole authority for route eligibility. |
| Protocol registry | Exact external protocol/version, enabled features, evidence freshness and conformance state | Host protocol adapters only; protocol presence does not prove provider capability or user consent. |

An untrusted descriptor may be searchable but cannot execute. Installation/trust stays with existing ZCode lifecycle. The agent catalog is a rebuildable discovery projection, not an alternative source of identity or executable code.

## 4. Multi-agent financial missions

A financial mission is a typed task graph running through existing ZCode agents. Every task carries a mission/task ID, principal and workspace scope, assigned agent identity/version, parent task, typed input/output schema, allowed tools/scopes, deadline, cancellation state and evidence references. Cross-agent artifacts are proposals, not trusted authorization or provider facts.

Illustrative B2B supplier-payables mission:

| Specialist | Allowed work | Must never do |
|---|---|---|
| Procurement | Compare requisition, quotes, purchase order and delivery evidence | Approve payment or change budget |
| Invoice | Extract invoice fields and match line items | Treat OCR/model output as verified invoice truth |
| Supplier verification | Match legal supplier and beneficiary to provider-backed evidence | Guess recipient from a name or email |
| Budget/policy | Check project, cost centre, limits and business policy | Widen policy or mint authority |
| Compliance | Collect purpose/jurisdiction/sanctions/KYC evidence and flag gaps | Waive a legal/provider refusal |
| Payment discovery | Query connected accounts, provider capabilities and available protocols | Call provider write endpoints |
| Route analyst | Compare only eligible routes, fees, timing and FX evidence | Make conditional routes executable |
| Reconciliation | Compare events/read-back and surface unknown/mismatch states | Declare settlement without required read-back |
| Audit | Assemble provenance and explain the decision chain | Alter the append-only ledger |

There is deliberately no autonomous “execution agent”. The executor is a deterministic host-side PaySwap service. Any agent that invokes it remains an untrusted caller subject to broker, session, principal, role, eligibility, grant and live-gate enforcement.

ZCode owns conversation/task execution state. PaySwap records only financial mission references, agent provenance, mandate/delegation events, exact grants, provider events and reconciliation in its existing ledger; it does not duplicate full prompts or conversation transcripts.

## 5. Delegated authority: human-signed envelope, host-derived grants

### 5.1 Preserve human-present approval; add a bounded autonomous mode

The existing human-present path is unchanged: the trusted host-rendered Class-B card displays the exact closed transaction tuple and the authenticated operator approves or rejects it.

The autonomous path introduces a **Financial Authority Envelope (FAE)**. A human operator, acting under an authenticated workspace role, approves a bounded policy envelope on a trusted, deterministic, non-agentic Class-B surface. The envelope lets host policy evaluate a bounded class of future tasks; it is not a payment instruction, transaction grant or permission to bypass eligibility. Envelope approval carries the same approval-event security as transaction approval — one-time challenge, exact canonical-digest binding, host-derived rendering, no ambient approval (addendum §9.5).

### 5.2 Envelope constraints

Every FAE is structured and binds, at minimum:

- the **operator principal** (the authenticated human who signs, bound to the
  approving session and its one-time challenge) and the **financial principal**
  (the business/workspace whose funds and policies the envelope governs),
  recorded separately and never conflated (addendum §9.6);
- explicitly connected source accounts;
- permitted agent IDs, publishers, versions and task classes;
- business purpose codes and cost-centre/project scope;
- exact verified beneficiary allowlist or deterministic rules over a pre-approved vendor register;
- permitted country/corridor, currencies, providers, rails and methods;
- per-transaction ceiling, aggregate budget, maximum transaction count;
- maximum fees, FX quote/rate tolerance and slippage;
- rate/frequency limits, not-before and expiry;
- revocation handle, policy version and maximum delegation depth;
- explicit permission for child delegation (off by default).

Unknown/missing/unverifiable constraints fail closed. Free-text explanations are not executable policy. An envelope must have bounded lifetime and explicit revocation.

### 5.3 Parent-child delegation is monotonic narrowing

A host-owned delegation service may derive a child envelope for one agent and one task. It intersects the parent envelope with workspace policy, agent scope, principal/role and current PaySwap eligibility. Every child must be equal to or narrower than its parent across accounts, recipients, purpose, geography, currency, provider, rail, amount, fees, FX, aggregate budget, count, rate, time and delegation depth.

The human/business operator remains the financial principal; the agent is recorded as the delegated actor. Each child records its parent, issuer, agent/version, task, mission and policy version. Delegation depth is zero unless a parent explicitly permits a bounded depth. Descendants inherit parent expiry and revocation. Revocation immediately blocks new grants; already-submitted operations proceed to reconciliation and are not assumed reversible.

Aggregate spend and count are authoritative ledger-derived values under an atomic
budget lifecycle — **reserve** (worst-case cost + one count unit, atomically with
grant mint), **consume** (atomically with execution; reserved-vs-actual difference
releases), **release** (expiry/cancel/never-submitted; unknown outcomes hold their
reservation) — defined in addendum §9.7. No renderer counter, agent memory, cache
or protocol session is budget authority.

Envelope approval is itself an approval event under the full §1.6 security
contract — trusted-renderer host-derived content, one-time challenge, and
exact canonical-digest binding; there is no ambient approval of envelope
classes (addendum §9.5). The autonomous path carries its own negative and
concurrency matrix (the F-series, addendum §9.8) — the N1–N42 matrix covers
only transaction-bound approval and does not substitute.

### 5.4 Exact closed transaction grant remains mandatory

Every provider write requires the same exact, closed, single-use Authorization Grant defined in the addendum §1.3. There are only two host-owned mint paths:

1. **Human Present:** the trusted Class-B card approves the exact transaction tuple; host code recomputes its digest and mints the grant.
2. **Human Not Present:** a previously human-signed FAE is active; deterministic host policy evaluates the proposed tuple, child constraints, fresh provider evidence, roles, verified beneficiary, budgets, replay/expiry and live-mode gate; the host authorization service derives and mints the closed grant.

Agents may request a child delegation or propose a transaction. They never approve an envelope, mint or consume grants, edit a signed envelope, or become the financial principal. Material transaction changes require fresh direct approval or a new deterministic host evaluation under the active FAE. Grant consumption stays atomic at the single execution authority.

Every financial event records principal, agent identity/publisher/version, mission/task, parent-child envelope chain, policy version, authorization mode, exact tuple digest, provider/route and evidence references. Secrets never enter agents, prompts, MCP tool arguments, inter-agent artifacts or the evidence ledger.

### 5.5 Refusal conditions

No active envelope means no autonomous payment. Expired/revoked/exhausted/over-budget/over-count/over-frequency, wrong principal/role, out-of-scope task/agent, stale evidence, unverified recipient, unsupported provider/country/currency/purpose, changed tuple or unknown route all produce typed refusal and zero provider writes. Splitting routes or delegating agents never changes purpose, AML classification or eligibility (INV-30).

## 6. Protocol interoperability at the boundary

External protocols exchange mandates, challenges, agent identities, payment requests or receipts. Adapters verify them and map them into the same PaySwap intent, eligibility, routing, authorization, execution and reconciliation contracts. No protocol adapter owns financial authority.

| Protocol / initiative | PaySwap role | Boundary rule |
|---|---|---|
| AP2 v0.2 | Human-present and human-not-present mandate/receipt interoperability | Trusted Surface is non-agentic. Agent-to-agent mandate delegation is outside AP2 v0.2 scope; PaySwap child delegation is its own extension. |
| x402 | HTTP payment request/challenge and response interoperability | A 402/payment challenge is untrusted input, not consent. Compile to a typed intent and evaluate host authority/eligibility. |
| Stripe/Tempo MPP | Machine-payment sessions, programmatic/recurring/micropayment interoperability | Session is protocol data, not a PaySwap grant. Metered/repeated charges require envelope bounds; every closed transaction still passes host policy. |
| Visa Trusted Agent Protocol | Verified agent identity/portal access in participating business/supplier systems | Agent identity and portal access are not payment authorization. |
| Mastercard Agent Pay for Machines | Scheme/network integration target | Requires actual partner specifications, access and conformance; not assumed to be a universal public provider API. |
| MCP / future A2A | Agent/tool discovery and task invocation | Identity and task messages confer neither PSP credentials nor financial authority. |

Every protocol adapter pins an exact version and official evidence URL/retrieval date, verifies signatures/issuer/audience/replay/expiry/nonce as applicable, validates feature support, tests malformed/stale/forged messages and fails closed on unknown versions. Receipts are emitted only from verified execution/reconciliation state; a protocol "accepted" event is not settlement. Unsupported features are unavailable, not simulated as production support.

### 6.1 Blockchain rail and external-wallet boundary

Blockchain is a first-class rail in the existing PaySwap financial core,
not a conventional PSP and not a second payment engine. Keep four interfaces
distinct:

- `BlockchainRailAdapter`: chain-specific transaction construction,
  simulation, submission lifecycle and finality/event observation.
- `WalletConnector`: connects an externally user-controlled wallet, proves
  address control and requests signatures for exact host-approved
  transactions. It is not an authority or custody service.
- `ChainInfrastructureProvider`: RPC, gas, indexer, simulation and event
  observations. Infrastructure output is evidence, not eligibility or
  settlement truth.
- `PaymentProtocolAdapter`: AP2/x402/MPP and other protocol translation;
  it does not become a wallet or chain executor.

Wallet proof-of-control is a single-use, expiring, origin/domain/audience/
chain-bound challenge. A connected wallet may expose supported public
balances and capabilities, but connection is not transaction consent.
PaySwap never asks for or stores seed phrases/private keys. The first
transaction path is human-present: PaySwap constructs and validates an
exact transaction, obtains the existing host Authorization Grant, asks
the external wallet to sign, verifies binding, and lets exactly one
designated submission owner broadcast. No blockchain write or token
approval ships before P7.

The P7 grant binds the connected address, chain/network identity, sender,
recipient, native value, token contract/amount/decimals, method and calldata
hash, spender/allowance if applicable, nonce/replay domain, fee ceiling,
beneficiary, route and expiry. Any material change needs a new grant and
signature. Approval transactions are separately granted; unlimited
approvals are prohibited by default. Autonomous chain execution is not
available to ordinary EOAs; it requires a separately specified and audited
user-controlled smart-account policy that enforces the FAE constraints.

Chain submission, mempool acceptance and block inclusion are not finality.
Reconciliation must account for confirmations/finality, expected events,
reorganizations, replacement/dropped/reverted transactions, RPC disagreement
and unknown outcomes. Unknown outcomes are not blindly retried. Bridges,
swaps and wrapped assets are conditional until their own risk, legal and
conformance gates pass. This roadmap does not authorize PaySwap-issued
wallets, PaySwap-managed keys, custody, a proprietary chain/rollup or
PaySwap-operated settlement.


Official references checked 2026-11-15 (they establish initiative scope, not PaySwap certification, partner access or Ghana availability):
- AP2 specification: https://ap2-protocol.org/ap2/specification/
- Google AP2 v0.2 / FIDO Alliance announcement, 2026-04-28: https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/
- Stripe Machine Payments Protocol announcement, 2026-03-18: https://stripe.com/blog/machine-payments-protocol
- Linux Foundation x402 Foundation operational launch, 2026-07-14: https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications
- Visa/BILL/Billtrust invoice-payment pilot, 2026-10-20: https://corporate.visa.com/en/sites/visa-perspectives/press-releases/visa-bill-billtrust-launch-pilot.html
- Mastercard Agent Pay for Machines, 2026-06-10: https://www.mastercard.com/global/en/news-and-trends/press/2026/june/mastercard-launches-agent-pay-for-machines.html

## 7. Non-custodial product boundary

Funds remain with the user's bank, licensed PSP, e-money issuer, card issuer/network or other authorized provider. PaySwap submits an instruction only after the host execution authority consumes a valid grant.

PaySwap does not accept deposits, maintain customer stored-value balances, hold float, pool/safeguard funds, issue wallets/stored value, perform its own settlement, become merchant of record, lend, extend credit or custody funds. The append-only ledger is an operational/evidence journal for mandates, instructions, provider events and reconciliation—not a customer balance ledger, general ledger, balance sheet or proof that PaySwap holds money. Provider API acceptance is not settlement; provider/bank read-back and reconciliation remain required.

Provider API keys/tokens are sensitive credentials, not funds. They remain in the secure host credential store or server secret manager. Agents receive scoped host-mediated tool capabilities and never raw provider credentials.

## 8. Initial market focus and Ghana perimeter

The first commercial wedge is **B2B accounts payable, procurement and supplier payments**, followed by cross-border business payments and agent purchases of digital services. That gives a workflow advantage over a generic multi-PSP API: invoice and purchase-order matching, supplier verification, project budgets, bounded mandates, route discovery, payment initiation through an authorized provider and reconciliation in one mission.

An initial workflow can reconcile a requisition, quote, purchase order, delivery record, supplier invoice and verified beneficiary before proposing a GHS supplier payment. GHS, local bank and mobile-money rail support must be established from actual connected-provider capability evidence; a provider's presence in Ghana does not prove a particular product/corridor is available.

Non-custodial design does not itself establish a licensing exemption. Ghana launch requires counsel to assess the deployed functions under the Payment Systems and Services Act, 2019 (Act 987), current Bank of Ghana categories/notices, and the specific operating model. Act 987 includes technological services facilitating switching, routing, clearing and data management among regulated activities; BoG publishes PFTSP and PSP categories. This is a perimeter-review trigger, not a conclusion that a specific licence is required or not required. Obtain a written assessment, identify any required BoG engagement and determine the need for licensed PSP/bank partners before Ghana-facing commercial launch.

Official BoG references checked 2026-11-15:
- Act 987: https://www.bog.gov.gh/wp-content/uploads/2019/08/Payment-Systems-and-Services-Act-2019-Act-987-.pdf
- Licence categories: https://www.bog.gov.gh/fintech-innovation/licence-categories/
- Licensing application pack notice, 2026-11-09: https://www.bog.gov.gh/notice/licensing-application-pack-for-payment-service-providers/
- Licensed PSP list: https://www.bog.gov.gh/supervision-regulation/registered-institutions/list-of-licensed-psps/

No statement here is legal advice or a definitive licence determination. Apply the same jurisdiction-specific analysis to other corridors.

## 9. Proposed package seams (not implemented yet)

These are target boundaries for P3 onward, not claims about existing source files:

| Responsibility | Target seam | Owner rule |
|---|---|---|
| Agent catalog | `packages/services/src/payswap/agent-catalog/` | Read-only projection of existing ZCode manifests/trust state |
| Mission orchestration | `packages/services/src/payswap/orchestration/` | Schedules existing ZCode tasks; no new runtime or conversation store |
| Delegation law | `packages/shared/src/payswap/delegation/` plus existing host authorization service | Pure schema/intersection rules and one host-owned writer |
| Protocol schemas | `packages/shared/src/payswap/protocols/` | Versioned typed contracts; no I/O or credentials |
| Protocol adapters | `packages/services/src/payswap/protocols/<protocolId>/` | Boundary translation to common financial contracts |
| Blockchain rail adapters | `packages/services/src/payswap/blockchain/<chainFamily>/` | Chain-specific transaction and finality boundary; no authority or ledger |
| Wallet connectors | `packages/services/src/payswap/wallet-connectors/<connectorId>/` | External wallet connection/signature transport; no key custody or policy |
| Chain infrastructure | Existing provider/infrastructure seam, with chain-scoped adapters | RPC/indexer/gas/simulation observations; not account or settlement authority |
| UI | Existing New Task, plugin and approved host surfaces | Additive projections; Class-B approval remains host-rendered |

Before adding any store, identify the existing authoritative owner, migration, lock/fencing rule and read model. Protocol transport state may be bounded adapter state; financial facts and mandate/transaction history remain in the one PaySwap ledger.

## 10. Invariants

1. One ZCode runtime; no parallel agent harness.
2. One PaySwap core, authorization authority, execution authority and ledger.
3. Agent, provider and protocol catalogs are distinct.
4. Model/agent/protocol outputs are untrusted until deterministic verification.
5. Agent tasks are principal/workspace/tool scoped and traceable to a mission.
6. Delegation is human-signed (challenge- and digest-bound — addendum §9.5), host-issued, bounded, expiring, revocable and monotonic-narrowing; the signing operator and the financial principal are distinct (§9.6), and the budget reserve/consume/release lifecycle is atomic and ledger-authoritative (§9.7).
7. Both approval modes lead to exact closed transaction grants; agents never mint them.
8. Trusted authorization surfaces are deterministic and non-agentic.
9. No provider write before P7; no live mode before the separate operator gate.
10. No custody; provider/bank evidence is the settlement truth.
11. External provider/protocol facts are versioned, dated and re-verified.
12. All non-financial ZCode behavior remains preserved.
13. Blockchain rail, wallet connector, chain infrastructure and payment protocol are distinct contracts.
14. Wallet connection proves address control only; it does not create spend permission or financial authority.
15. All chain writes pass through the same host grant and single execution authority; agents never receive keys/signers.
16. Chain transaction inclusion is not finality; reconciliation handles reorgs and unknown outcomes without blind retries.
17. No PaySwap-issued wallet, key custody, proprietary chain/rollup or settlement business is implied by external wallet connectivity.
