# PaySwap 4.0 — Unified PSP Interface and Money-Movement Discovery Architecture

**Decision date:** 2026-11-15  
**Decision state:** approved P3–P9 product architecture; this is a design baseline, not evidence that implementation is complete.  
**Authority:** the canonical roadmap is `10-roadmap.md`; the normative security and authorization rules are in `11-architecture-addendum.md`.

## 1. Product decision

PaySwap 4.0 is a **payment-only product** built on the existing ZCode application and PaySwap financial core. It has two complementary user-facing capabilities:

1. **The unified PSP operations interface.** A user connects payment-service-provider accounts and uses PaySwap as the primary day-to-day interface to inspect account/payment data and perform supported payment-related read and write operations across those PSPs. The interface presents common concepts while preserving provider-specific capabilities, restrictions and evidence.
2. **Intent-driven money-movement discovery.** A user states the financial outcome they want. PaySwap evaluates the sender's and recipient's verified payment capabilities, then discovers the best feasible route—direct, composed or multi-party—against the user's cost, speed, reliability, feasibility, privacy and deadline constraints.

PaySwap only knows about payment operations, payment rails, financial parties and payment protocols. It does not integrate general-purpose non-payment service providers, search for non-payment products/services, or become a general-purpose agent marketplace. A third party can participate only as a financial party contributing a verified payment capability to a proposed money route and explicitly accepting its financial role.

There is one application, one ZCode runtime, one provider capability authority, one financial authorization authority, one execution authority and one append-only financial evidence ledger. PaySwap does not take custody of participant funds or acquire authority over another party's account.

### Explicit non-goals

- Do not fork or replace ZCode's agent runtime, model-provider stack, task/session semantics, MCP, plugins, skills, workflows, automations, permission system or New Task shell.
- Do not add a second agent runtime, customer-facing agent catalog/marketplace, general-purpose mission marketplace, non-payment provider registry, duplicate PSP capability registry, authorization authority, execution engine, ledger or reconciliation system.
- Do not turn PaySwap into procurement, supplier sourcing, product discovery, invoice/workflow management or general business operations. Documents such as invoices may be used only as evidence/input to a payment intent.
- Do not expose arbitrary PSP API passthrough or claim parity with every feature of every provider dashboard. Expose typed payment-related operations supported by verified provider evidence; unsupported or non-payment features stay outside PaySwap.
- Do not add PaySwap-issued or PaySwap-custodied wallets, deposits, stored value, escrow, custody, pooled float, merchant-of-record, PaySwap lending/credit or PaySwap-operated settlement. A separately specified externally controlled payment rail may be considered only through its own payment boundary and authorization rules.
- Do not let a model, agent, plugin, protocol adapter, participant, webhook or automation mint financial authority.
- No provider write before P7 acceptance; no live-money operation before the separate operator-controlled live gate.

## 2. One payment product, three layers

```text
EXISTING ZCODE APPLICATION
  Existing chat, tasks, agents, tools, permissions, plugins and workflows
  Preserved as the interaction/runtime substrate
                         |
                         v
PAYSWAP USER INTERFACE
  Unified connected-PSP payment operations
  Money-movement intent submission and clarification
  Route/participant comparison, approvals, status and evidence
                         |
                         v
ONE PAYSWAP FINANCIAL CORE
  PSP accounts and credentials
  Evidence-backed provider/rail/recipient capabilities
  Intent compiler -> eligibility and policy
  Single-intent route discovery
  Multi-intent / multi-party opportunity discovery
  FX and route evaluation
  Host-owned authorization -> ONE execution authority
  Provider events -> reconciliation -> ONE append-only ledger
                         |
                         v
PAYMENT PARTIES AND PAYMENT NETWORKS
  Senders, recipients/merchants, consenting payment participants
  Banks, licensed PSPs, mobile-money/e-money providers, card rails,
  cash-assisted or other payment rails only through verified boundaries
```

### 2.1 ZCode remains the interaction and agent-execution substrate

PaySwap appears inside the existing ZCode New Task experience. Existing conversations, model selection, tools, agents, tasks, sessions, plugins, workflows and automation semantics remain upstream-owned. The user should not have to learn a separate agent framework to use PaySwap.

### 2.2 Agents assist payment work; they are not the product's marketplace

Existing ZCode agents may help with payment-specific tasks such as interpreting an intent draft, retrieving provider facts, comparing candidate routes, identifying missing evidence, exploring combinations of submitted payment intents and explaining trade-offs. Their output is untrusted proposal material. Deterministic PaySwap services validate provider capabilities, participant evidence, eligibility, route structure and authorization. Agents cannot access raw PSP credentials, invoke provider writes directly, commit another party, alter a principal/beneficiary or mint a grant.

There is no need for a PaySwap-owned agent directory. Users may continue to use ZCode's ordinary agent features, but PaySwap's domain and customer-facing discovery remain payment-only.

### 2.3 Exactly one payment capability and execution authority

The existing PaySwap domains remain authoritative for connected PSP accounts, provider operations, payment capabilities, verified recipients, eligibility, purpose classification, FX, route discovery, transaction grants, provider writes, provider events, evidence and settlement reconciliation. The unified PSP interface and route-discovery engine compose these domains; they do not replicate them.

The PSP provider capability registry is the authority for what a connected provider account can do. Payment-participant evidence records describe a financial party's verified ability and willingness to contribute a particular payment leg. Protocol facts describe message interoperability. These are distinct records with distinct authority; none can grant consent or execution rights by being listed.

## 3. Payment capability graph and participant commitments

| Record | What it describes | Authority |
|---|---|---|
| PSP account capability | Evidence-backed operations, countries, currencies, rails, methods, amounts, recipient types, entitlements and restrictions for an actual connected PSP account | Existing PaySwap provider capability registry; immutable, versioned and evidence-referenced |
| Recipient/payment instructions | Verified identity and payment methods a recipient can accept, with freshness and source evidence | Verified-recipient and provider evidence boundaries; user/model claims alone are insufficient |
| Payment participant capability | A financial party's verified payment rail/account capability and availability relevant to a proposed route | Evidence tied to that participant and its own authorized account; no general service listing |
| Participant offer/commitment | Proposed or accepted route role, exact legs, give/receive amounts, compensation, conditions, expiry and route digest | Offer is only a proposal; commitment requires explicit authenticated acceptance by that participant |
| Protocol capability | Exact external payment protocol/version, supported features, evidence freshness and conformance | Host protocol adapter; protocol presence does not prove provider capability, user consent or route eligibility |

The payment capability graph is assembled from these records. It must not become a generic provider marketplace or infer that a party can execute a payment from a name, reputation, listing or model-generated description.

## 4. Payment-task coordination

A financial task graph may use existing ZCode agents for bounded payment work. Tasks carry a mission/intent reference, principal and workspace scope, agent identity/version, parent task, typed inputs/outputs, allowed tools/scopes, deadline, cancellation state and evidence references.

Permitted examples include intent clarification, connected-PSP data retrieval, provider-capability analysis, route enumeration, multi-intent opportunity analysis, payment-specific risk/policy review, participant commitment verification, execution-status explanation and reconciliation review. Extracting an invoice or reading a payment notice is allowed only as a means of formulating or substantiating a money-movement intent—not as a general procurement or document-management product.

Every task output is an untrusted proposal. Cross-agent artifacts cannot change the financial principal, recipient, payment purpose, verified provider facts, participant consent or authorization state. There is deliberately no autonomous execution agent; the executor is the deterministic host-side PaySwap service.

ZCode owns conversation/task execution state. PaySwap records only the financial intent/mission references, task provenance needed for payment audit, mandate/delegation events, participant commitments, exact grants, provider events and reconciliation in its existing ledger; it does not duplicate full prompts or conversation transcripts.

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

Official references checked 2026-11-15 (they establish initiative scope, not PaySwap certification, partner access or Ghana availability):
- AP2 specification: https://ap2-protocol.org/ap2/specification/
- Google AP2 v0.2 / FIDO Alliance announcement, 2026-04-28: https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/
- Stripe Machine Payments Protocol announcement, 2026-03-18: https://stripe.com/blog/machine-payments-protocol
- Linux Foundation x402 Foundation operational launch, 2026-07-14: https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications
- Visa/BILL/Billtrust invoice-payment pilot, 2026-10-20: https://corporate.visa.com/en/sites/visa-perspectives/press-releases/visa-bill-billtrust-launch-pilot.html
- Mastercard Agent Pay for Machines, 2026-06-10: https://www.mastercard.com/global/en/news-and-trends/press/2026/june/mastercard-launches-agent-pay-for-machines.html

## 7. Non-custodial product boundary

Funds remain with the user's bank, licensed PSP, e-money issuer, card issuer/network, external wallet or other independently controlled payment account. PaySwap submits an instruction only after the host execution authority consumes the exact grant applicable to that operation and financial principal. A third-party participant controls its own account and separately authorizes its own route legs.

PaySwap does not accept deposits, maintain customer stored-value balances, hold float, pool/safeguard funds, issue or custody wallets/stored value, perform its own settlement, become merchant of record, lend, extend credit or take custody of participant funds. The append-only ledger is an operational/evidence journal for intents, offers, commitments, instructions, provider events and reconciliation—not a customer balance ledger, general ledger, balance sheet or proof that PaySwap holds money. Provider API acceptance is not settlement; provider/bank/rail read-back and reconciliation remain required.

The unified PSP interface exposes supported payment-related operations only. It does not proxy arbitrary provider APIs or imply PaySwap can replace provider dashboards for non-payment administration, legal onboarding or unsupported features.

Provider API keys/tokens are sensitive credentials, not funds. They remain in the secure host credential store or server secret manager. Agents receive scoped host-mediated tool capabilities and never raw provider credentials. A participant's credentials and financial authority are never shared with another participant or agent.

## 8. Initial payment use cases and Ghana perimeter

The initial product wedge is a unified interface for connected PSP accounts plus money-movement discovery across fragmented payment rails. Priority use cases include domestic and cross-border transfers, merchant payments, collections, payouts, refunds, payment-status and beneficiary operations, reconciliation, and routes that bridge sender/recipient payment-method incompatibility.

An illustrative use case is a customer who has mobile money but needs to pay a merchant that accepts only cards. PaySwap can discover whether an independently controlled participant has a verified, eligible card-payment capability and is willing to pay the merchant in exchange for an agreed mobile-money leg. A similar cash-assisted route is considered only when a legally appropriate participant, verifiable handoff/evidence and explicit commitments exist. This is payment-route discovery, not discovery of a general-purpose intermediary service.

Multi-intent opportunities may identify independently evidenced obligations that can be offset or coordinated. They must preserve each original intent until all affected financial principals explicitly accept a new route; no party's grant can authorize another party's account or obligation.

GHS, local bank and mobile-money rail support must be established from actual connected-provider capability evidence; a provider's presence in Ghana does not prove a particular product/corridor is available. Cash-assisted and other offline routes require a documented participant-evidence, dispute and legal model before being treated as executable.

Non-custodial design does not itself establish a licensing exemption. Ghana launch requires counsel to assess the deployed functions under the Payment Systems and Services Act, 2019 (Act 987), current Bank of Ghana categories/notices, and the specific operating model. Act 987 includes technological services facilitating switching, routing, clearing and data management among regulated activities; BoG publishes PFTSP and PSP categories. This is a perimeter-review trigger, not a conclusion that a specific licence is required or not required. Obtain a written assessment, identify any required BoG engagement and determine the need for licensed PSP/bank partners before Ghana-facing commercial launch.

Official BoG references checked 2026-11-15:
- Act 987: https://www.bog.gov.gh/wp-content/uploads/2019/08/Payment-Systems-and-Services-Act-2019-Act-987-.pdf
- Licence categories: https://www.bog.gov.gh/fintech-innovation/licence-categories/
- Licensing application pack notice, 2026-11-09: https://www.bog.gov.gh/notice/licensing-application-pack-for-payment-service-providers/
- Licensed PSP list: https://www.bog.gov.gh/supervision-regulation/registered-institutions/list-of-licensed-psps/
