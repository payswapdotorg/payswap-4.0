/**
 * PaySwap P3.1 —— 协议事实注册表：外部支付协议的 pinned 事实单一来源
 * （agent-native Payment Harness 架构 §6「Protocol interoperability at the
 * boundary」+ 架构师 2026-11-15 交接「versioned AP2/x402/MPP contracts」；
 * addendum §10「adapters are not providers or executors」的 pinning 面）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **事实只来自官方源 + 检索日期在案**（doc 04 §5 的 dated-evidence 纪律
 *    延伸到协议面）：`verifiedBoundaryFacts` 的每一条都对应 `officialSourceUrl`
 *    在 `factsRetrievedAt` 当日可复核的内容。不得转写、不得从二手来源补充、
 *    不得把营销措辞当规范语义。
 * 2. **版本 pin 或如实缺席**：`versionPin: null` 表示**尚无可验证的版本串**
 *    —— 不是「无版本」，而是「本注册表尚未从官方源验证到版本串」。该状态
 *    下适配器实现被 `protocol_version_unpinned` typed 拒绝挡住（fail-closed：
 *    不猜版本）；补上验证过的版本串即解除。
 * 3. **适配器不得超出已验证事实编码**：`reverifyBeforeAdapter` 是适配器实现
 *    （消息 schema、验证规则、收据形态）之前的再验证清单 —— doc 12 §6
 *    「fails closed on unknown versions」的注册表半。清单未空时，协议的
 *    消息面实现不得落地（边界契约可以先落 —— 本文件与 protocol-contract.ts
 *    就是边界，不是消息实现）。
 * 4. **协议在场 ≠ 能力或同意**（doc 12 §3 三注册表分离）：本注册表不记录任何
 *    provider 能力、用户同意或可用性事实 —— 那些分别属于 provider-capability
 *    注册表（证据支撑）与授权面（envelope/grant）。
 */

/** 协议 id 闭集（doc 12 §6 表的 PaySwap 首批协议面；新增 id = 注册表演更）。 */
export type PayswapProtocolId = "ap2" | "x402" | "mpp";

/** pinned 协议事实（单一来源；适配器描述符必须与之一致才可注册）。 */
export interface PayswapProtocolPin {
  readonly protocolId: PayswapProtocolId;
  /** 官方名（照录官方源措辞；两名并存时如实在 verifiedBoundaryFacts 记录）。 */
  readonly officialName: string;
  /** 适配器必须钉住的精确版本/规范引用；null = 尚未从官方源验证到版本串。 */
  readonly versionPin: string | null;
  /** 官方源 URL（https；检索即复核面）。 */
  readonly officialSourceUrl: string;
  /** 事实检索日期（ISO 日期串）。 */
  readonly factsRetrievedAt: string;
  /** 已验证的边界事实（引文级；来源 = officialSourceUrl @ factsRetrievedAt）。 */
  readonly verifiedBoundaryFacts: readonly string[];
  /** 适配器消息面实现前的再验证清单（doc 04 §5 纪律；空 = 门已关）。 */
  readonly reverifyBeforeAdapter: readonly string[];
}

/** 检索日期（本注册表事实的统一检索批次）。 */
const RETRIEVED_AT = "2026-11-15";

/**
 * AP2 v0.2 —— 官方规范页检索 2026-11-15 两批（首批 plain HTTPS；二批补
 * raw.githubusercontent.com 规范 md：specification / payment_mandate /
 * checkout_mandate / agent_authorization，repo google-agentic-commerce/AP2
 * 发布 tag v0.2.0）。版本串 v0.2 照录规范页标题（「Agentic Payment Protocol
 * (v0.2)」）；站点页头同时使用「Agent Payments Protocol」措辞 —— 两名并存
 * 如实记录，不裁决正名。二批事实含两处对首批记录的更正（roles 五枚举、
 * modes 两枚举），更正依据均为规范正文逐字引文。
 */
export const PAYSWAP_PROTOCOL_PIN_AP2: PayswapProtocolPin = {
  protocolId: "ap2",
  officialName: "Agentic Payment Protocol (AP2)",
  versionPin: "v0.2",
  officialSourceUrl: "https://ap2-protocol.org/ap2/specification/",
  factsRetrievedAt: RETRIEVED_AT,
  verifiedBoundaryFacts: [
    "spec 页标题自述「Agentic Payment Protocol (v0.2)」—— 为 agent 执行的支付交易提供安全协议，并使用 Agent Authorization model",
    "站点页头使用「Agent Payments Protocol - AP2」措辞（两名并存，均照录）",
    "【二批更正】角色集为五枚举（Shopping Agent / Credential Provider / Merchant / Merchant Payment Processor / Trusted Surface）；「The following role MUST be non-agentic: Trusted Surface」；单实体可兼多角色。注意：AP2 的角色缩写 MPP（Merchant Payment Processor）与 Machine Payments Protocol 的 MPP 缩写撞名 —— 两者无关，均照录不更名",
    "角色 Trusted Surface (TS)：「a UI surface that is trusted to get informed user consent for an Intent before creating a user-signed Mandate」—— PaySwap 侧对应既有的 trusted 非代理 Class-B 面（doc 12 §6 边界规则）",
    "【二批更正】§Modes 明文只有两模式：「There are two `modes` that AP2 can consider to operate in.」（Human Present (Direct) / Human Not Present (Autonomous)）；§Agent-to-Agent Delegation 明文「This is outside the scope of the current specification.」—— 首批按目录著录的三模式记录就此更正",
    "Mandate Versioning 已公布且为精确匹配：「Each AP2 Mandate type identifies its schema using the `vct` claim. The `vct` value includes a numeric suffix that acts as a schema version number (e.g. `mandate.payment.1`, `mandate.checkout.open.1`). Implementations MUST match the exact `vct` string, including the version suffix.」",
    "VDC 形态已验证：「AP2 specifies the use of `SD-JWT`s for securing the Payment and Checkout Mandates」（其他 VDC 仅列为可能）",
    "Payment Mandate 字段级 schema 已随 spec md 公布（payment_mandate.md：vct=mandate.payment.1 / mandate.payment.open.1；字段含 _sd_alg/allowed/currency/execution_date/frequency/max/max_occurrences/min/not_after/not_before/payee/payment_amount/payment_instrument/vct；Payment Mandate 以 Checkout JWT 的密码学哈希绑定特定 Checkout）",
    "Agent Authorization 机制页已公布（agent_authorization.md：OpenID4VP User Credential delegation（transaction_data 携 base64url 编码的 mandate-delegation 对象，type 必须为 `delegate`）；Mandate Delegation / Mandate Structure / Action Authorization / Errors 各节在案）",
    "Checkout Mandate + Receipt 与 Payment Mandate + Receipt 成对，作为争议时点的证据（spec 自述）",
    "AP2 自述「operates as a security feature within a Commerce Protocol」（协议是 Commerce Protocol 内的安全特性，不是支付执行引擎 —— 与 addendum §10 边界一致）；自述「designed explicitly to be compatible with the Universal Commerce Protocol (UCP)」",
    "OpenID4VP delegation 对象字段级（agent_authorization.md，检索 2026-11-21）：Authorization Request 的 transaction_data 数组承载 base64url 编码 JSON 对象；mandate delegation 对象字段 = type（REQUIRED，MUST 为字符串 \"delegate\"）/ format（REQUIRED，返回 Mandate 的 VDC format，例 \"dc+sd-jwt\"）/ delegate_payload（REQUIRED，Mandate Content payload JSON 对象数组 —— 单请求可委托多项）/ delegate_disclosures（OPTIONAL，delegate_payload 的选择性披露数组）；规范句：「When constructing the Authorization Response, the delegate_payload MUST be included as part of the Key Binding」；「Any unknown Constraints MUST be treated as failing evaluation」；open Mandate 必须密码学 Key Binding（cnf 在 Mandate 仍 open 时 REQUIRED）",
    "Action Authorization 错误语义（agent_authorization.md，检索 2026-11-21）：Verifier MUST 返回签名 Mandate Receipt（字段 iss / result（枚举 success|error）/ reference（链内最终 SD-JWT 的 base64url 哈希 —— _sd_alg 或缺省 sha-256，同 sd_hash 语义）/ 可选 error / error_description）；错误码四枚：invalid_credential（Mandate 验证失败 —— 终态）/ unresolved_constraint（未知约束或无法确认 closed Mandate 满足约束 —— 可触发回退直接批准 closed Mandate 或非代理流）/ invalid_mandate（Mandate 不批准请求动作 —— 终态）/ mandates_not_supported（Verifier 不支持该动作的 mandate —— 可触发非代理回退）；页面不定义 HTTP 状态码 —— 错误经签名 receipt 传达",
    "Checkout Mandate 字段级 schema（checkout_mandate.md，检索 2026-11-21）：closed MUST 用 vct = mandate.checkout.1，open MUST 用 mandate.checkout.open.1；closed 字段集 = vct（string，必填，不可披露）/ checkout_jwt（string，必填，可披露 —— merchant 签名的 base64url serialized Checkout payload JWT）/ checkout_hash（string，必填，不可披露 —— checkout_jwt 的 base64url 哈希，算法 MUST 同 SD-JWT 的 _sd_alg，缺省 sha-256 MUST）/ iat、exp（integer，可选 Unix epoch）；示例签名结构 ES256 SD-JWT（closed 为 kb+sd-jwt，payload 含 delegate_payload/iat/aud:\"merchant\"/nonce/sd_hash/_sd_alg）；约束集 = checkout.allowed_merchants（type + allowed 数组，Merchant MUST 出现在 revealed elements 中，缺失或空 = 约束无效）与 checkout.line_items（type + items：id/acceptable_items/quantity，每项数量须匹配且不得复用）；Checkout Receipt schema = status（Success|Error）/ iss / iat / reference（绑定的 closed Mandate 哈希）/ 可选 error、error_description（仅 Error）与 order_id（仅 Success）",
  ],
  reverifyBeforeAdapter: [],
};

/**
 * x402 v2 —— 规范文档源检索 2026-11-15 二批
 * （https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md，
 * raw 逐字验证：「# X402 Protocol Specification」/「**Protocol Version**: 2」）。
 * 溯源：github.com/coinbase/x402 为 fork（页面内嵌 repository_is_fork: true、
 * repository_parent_nwo: x402-foundation/x402）—— x402 Foundation 仓为 canonical；
 * x402.org 与 docs.x402.org 均链接该仓。官方渲染文档 docs.x402.org 自述
 * 「the credibly neutral source of truth for x402 … under the Apache-2.0
 * license」。首批的如实 null 就此解除：版本串 v2 已从规范文档验证在案。
 */
export const PAYSWAP_PROTOCOL_PIN_X402: PayswapProtocolPin = {
  protocolId: "x402",
  officialName: "x402",
  versionPin: "v2",
  officialSourceUrl: "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
  factsRetrievedAt: RETRIEVED_AT,
  verifiedBoundaryFacts: [
    "自述「an open, neutral standard for internet-native payments」（x402.org 落地页，首批）",
    "规范文档头逐字：「# X402 Protocol Specification」/「**Protocol Version**: 2」（specs/x402-specification-v2.md；同目录存在 v1 规范「**Protocol Version**: 1」）",
    "canonical 仓 x402-foundation/x402（「A payments protocol for the internet. Built on HTTP.」）；coinbase/x402 为 fork（repository_is_fork: true、repository_parent_nwo: x402-foundation/x402）",
    "HTTP transport（specs/transports-v2/http.md）：「The server indicates payment is required using the HTTP 402 'Payment Required' status code.」+「HTTP 402 status code with `PAYMENT-REQUIRED` header」；头集 PAYMENT-REQUIRED（→客户端，base64 编码 PaymentRequired）/ PAYMENT-SIGNATURE（→服务端，base64 编码 PaymentPayload）/ PAYMENT-RESPONSE（→客户端，base64 编码 SettlementResponse）；「None of the three headers above is CORS-safelisted.」",
    "V1→V2 迁移表（docs.x402.org/guides/migration-v1-to-v2.md）：V1 头 X-PAYMENT / X-PAYMENT-RESPONSE、字符串网络格式（base-sepolia）、x402Version: 1；V2 头 PAYMENT-SIGNATURE / PAYMENT-RESPONSE、CAIP-2 网络格式（eip155:84532）、x402Version: 2。【更正】不存在「X-PAY」头 —— V1 客户端头为 X-PAYMENT",
    "402 载荷示例（docs.x402.org/schemes/overview.md）：JSON 含 x402Version: 2、error、resource{url,description,mimeType}、accepts[{scheme,network,amount,asset,payTo,maxTimeoutSeconds,extra}]（示例 scheme=exact、network=eip155:84532、USDC 资产地址；另有 solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1）",
    "scheme 集：v2 核心规范列「including `exact`, `upto`, and `batch-settlement`」；docs overview 增列 auth-capture（escrow 可退款）；exact=固定价、upto=单请求用量计费、batch-settlement=高频/重复微支付",
    "网络（CAIP-2，docs.x402.org/core-concepts/network-and-token-support.md）：eip155:<chainId>、solana:<genesisHash>、tvm/algorand/stellar/aptos/hedera/keeta/near/canton/ccd/xrpl/cardano/sui；scheme overview 另列 Bitcoin Lightning（lnbtc）",
    "EVM 转账方法（specs/schemes/exact/scheme_exact_evm.md）：EIP-3009 / Permit2 / ERC-7710；缺省 assetTransferMethod 为 eip3009",
    "facilitator：「The server verifies and settles the payment independently, or by leveraging an x402 facilitator's /verify and /settle endpoints」（docs introduction）",
    "npm 包溯源：x402 / x402-fetch @ 1.2.0（author 「x402 Foundation」，repository git+https://github.com/x402-foundation/x402.git，Apache-2.0）",
    "三批字段级 schema（specs/x402-specification-v2.md，检索 2026-11-22）：PaymentRequired = x402Version（number，必须 2）/ error（可选）/ resource（必填 ResourceInfo：url 必填，description/mimeType/serviceName（可打印 ASCII ≤32）/tags（≤5 项）/iconUrl 可选）/ accepts（必填 PaymentRequirements 数组：scheme、network（CAIP-2）、amount（原子单位字符串）、asset、payTo、maxTimeoutSeconds 必填，extra 可选且保留键 assetTransferMethod/paymentFlow）/ extensions（可选：info + schema 必填）；PaymentPayload = x402Version / resource（可选）/ accepted（必填，选中的 PaymentRequirements）/ payload（必填，scheme 特定）/ extensions（可选）；exact-EVM payload = signature（EIP-712）+ authorization（from/to/value/validAfter/validBefore/nonce，nonce =「32-byte random nonce to prevent replay attacks」）；SettlementResponse = success（必填）/ errorReason（失败时在案，成功省略）/ errorMessage（可选）/ payer（可选）/ transaction（必填，未广播时空串；errorReason = settlement_pending 时 MUST 非空）/ network（必填 CAIP-2）/ amount（可选）/ extensions（可选）；「no settlement id field exists —— transaction 即标识」；客户端「MUST use the corresponding invalidReason or errorReason code and MUST NOT rely on message text」",
    "HTTP transport 编码与状态码（specs/transports-v2/http.md，检索 2026-11-22）：PAYMENT-REQUIRED = base64 编码 PaymentRequired 响应头；PAYMENT-SIGNATURE = base64 编码 JSON 请求头；PAYMENT-RESPONSE = base64 编码 JSON 头（失败 402 携 errorReason = insufficient_funds 示例；成功 200 携该头）；状态码映射表：Payment Required → 402 / Payment Failed → 402 / Invalid Payment → 400（畸形载荷或 requirements）/ Server Error → 500 / Success → 200（验证并结算成功）",
    "facilitator 语义（docs.x402.org/core-concepts/facilitator，检索 2026-11-22）：调用者是**资源服务器**（客户端永不联系 facilitator —— 客户端只发 PAYMENT-SIGNATURE 头）；流程 = POST Payment Payload + Payment Details 到 /verify，验证有效才执行工作，再 POST /settle；facilitator 校验「payment payload meets the server's declared payment requirements」并检查 scheme 与 networkId；「does not hold funds or act as a custodian - it performs verification and execution of onchain transactions」；settlement_pending = 非终态（广播成功但确认未建立）—— 响应携 transaction 哈希 + network，资源服务器自动重试结算**恰一次**（PendingSettlementStore 按交易哈希键控防双花；适用于 exact/upto/batch-settlement 的 EVM 与 SVM，仅 v2）；facilitator HTTP 请求缺省 90 秒超时，settle 期间超时 = 不可判定结局",
    "窗口/重放/超时的 scheme 级语义（第四批检索 2026-11-22，Session C 矩阵 —— 官方 scheme 分册逐字）：validAfter/validBefore 的执行侧强制在 **scheme 分册**在案而非核心规范 —— exact/EVM 把有效期校验写入 verifier 流程且 Permit2 代理在链上强制 witness.validAfter；upto 对全部网络以 MUST 表述；仅 batch-settlement/SVM 有字面 facilitator MUST。重放保证 **per-scheme 以 MUST 强度**在案：upto 单次使用；batch-settlement/EVM 累计水位线 + 「MUST NOT auto-retry /settle」；SVM 单次 requestId（重放 → duplicate_settlement）—— 核心 §10.1 仅覆盖 EIP-3009/EVM，无跨 scheme 一揽子表述。maxTimeoutSeconds 的 MUST 仅在绑定层（SVM batch、Starknet、Stellar）；EVM 上该字段与 validBefore 的联动官方**明确未记载**（SDK 实现 validBefore = now + maxTimeoutSeconds —— 实现证据，非规范）",
    "九项附加 wire 行为（第四批检索 2026-11-22，Session C 矩阵 —— 官方源逐字）：flow 不变式；/verify 只读（无链上动作）；upto 分阶段金额；412 allowance 路径；extensions 回显规则；纠正式 402（新 challenge）；CORS 语义；/supported 的 signers 字段",
  ],
  reverifyBeforeAdapter: [
    "官方源未记载、spec 沉默的执行细节（第五批候选，未验证到的不发明）：EVM 上 validAfter/validBefore 与 maxTimeoutSeconds 的联动（仅 SDK 实现证据）、核心规范的跨 scheme 重放一揽子表述、核心规范的强制执行者指派、maxTimeoutSeconds 的取值边界、stale-402 的服务端行为",
  ],
};

/**
 * MPP draft-httpauth-payment-01 —— 规范套件源检索 2026-11-15 二批
 * （https://github.com/tempoxyz/mpp-specs/blob/main/specs/core/draft-httpauth-payment-01.md，
 * raw 逐字验证 kramdown-rfc YAML：title: The "Payment" HTTP Authentication
 * Scheme / docname: draft-httpauth-payment-01 / version: "01"；作者 Tempo Labs
 * + Stripe）。渲染版 paymentauth.org/draft-httpauth-payment-01.html；官方站
 * mpp.dev（machinepayments.dev 与 machinepaymentsprotocol.org 均 301 → mpp.dev）。
 * IETF datatracker（draft-ryan-httpauth-payment）本批 Cloudflare 403 不可读 ——
 * 草案名与 -01 修订号由 mpp-specs README 与 paymentauth.org 渲染套件佐证，
 * datatracker 直读仍留在再验证清单。首批的如实 null 就此解除。
 */
export const PAYSWAP_PROTOCOL_PIN_MPP: PayswapProtocolPin = {
  protocolId: "mpp",
  officialName: "Machine Payments Protocol (MPP)",
  versionPin: "draft-httpauth-payment-01",
  officialSourceUrl: "https://github.com/tempoxyz/mpp-specs/blob/main/specs/core/draft-httpauth-payment-01.md",
  factsRetrievedAt: RETRIEVED_AT,
  verifiedBoundaryFacts: [
    "自述「an open standard, internet-native way for agents to pay — co-authored by Tempo and Stripe」（Stripe 公告，首批）",
    "核心草案逐字（abstract）：「This document defines the 'Payment' HTTP authentication scheme, enabling HTTP resources to require a payment challenge to be fulfilled before access. The scheme extends HTTP Authentication, using the HTTP 402 'Payment Required' status code.」",
    "交互流（草案 ASCII 图）：402 + WWW-Authenticate: Payment id/method/intent/request → 客户端支付 → 以 Authorization: Payment <credential> 重试 → 200 OK + Payment-Receipt",
    "术语逐字：「Payment Challenge: A `WWW-Authenticate` header with scheme 'Payment'…」；「Payment Credential: … The default field name is `Authorization`. A Payment challenge MAY select `Payment-Authorization` with the `header` parameter」；「Request: Method-specific data … Encoded as base64url JSON in the `request` parameter」",
    "失败语义：malformed-credential / invalid-challenge / payment-expired / verification-failed 问题类型均答 402 并携新 challenge",
    "intent 集（mpp.dev 官方站）：Charge（一次性）/ Session（按量计费）/ Subscription（周期固定）",
    "SPT 机制（draft-stripe-charge-00.txt，paymentauth.org）：「Shared Payment Token (SPT): A single-use token (prefixed with spt_) that represents authorization to charge a payment method」；§10.1 SPT Single-Use Constraint",
    "治理（mpp.dev/governance）：核心锚定 IETF（「Anchoring the core at the IETF means no single company controls i[t]」；IETF Trust 许可）",
    "草案套件广度（paymentauth.org）：core（-01）+ discovery/charge/session/subscription/transport-mcp 各 rail 分册（多为 -00）",
    "mpp.dev 页面载有 <body data-version=1.0> —— 观察到但语义未标注，不作为协议版本引用（草案修订号才是可辩护的 pin）",
    "SDK 生态（mpp-specs README）：TS wevm/mppx（npm mppx 0.19.0）/ Python tempoxyz/pympp / Rust tempoxyz/mpp-rs / Go tempoxyz/mpp-go / Ruby stripe/mpp-rb",
    "IETF datatracker 直读（https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/，检索 2026-11-21，浏览器渲染会话）：draft-ryan-httpauth-payment-01，「The \"Payment\" HTTP Authentication Scheme」；Document Type = Expired Internet-Draft (individual)、Expired & archived；版本 00/01；Last updated 2026-09-18（Latest revision 2026-03-17）；RFC stream (None)、Intended RFC status (None)；作者 Brendan Ryan / Jake Moxey / Tom Meagher（tempo.xyz）+ Jeff Weinstein（meer.net）+ Steve Kaliski（stripe.com）；datatracker 免责「not endorsed by the IETF … no formal standing」—— IETF 锚定指 IETF Trust 许可，非在案活动草案",
    "charge rail 字段级 wire 细节（draft-stripe-charge-00，paymentauth.org，检索 2026-11-22）：challenge ABNF = \"Payment\" id/realm/method=\"stripe\"/intent=\"charge\"/request=base64url-nopad（intent 大小写敏感且 MUST 小写；402 + Cache-Control: no-store）；request 对象 JCS（RFC 8785）序列化后 base64url —— 共享字段 amount（最小货币单位字符串，REQUIRED）/currency（三字母 ISO，REQUIRED）/description、externalId、recipient（可选）；methodDetails.networkId（Stripe Business Network Profile ID，REQUIRED）/paymentMethodTypes（REQUIRED）/metadata（可选）；credential = Authorization: Payment <base64url>，payload spt（spt_ 前缀，REQUIRED）+ externalId（可选）并回显 challenge（id/realm/method/intent/request/expires）；receipt（仅 200，错误响应 MUST NOT 携带）= method/reference（Stripe PaymentIntent ID）/status=\"success\"/timestamp（RFC 3339）/externalId 可选；MUST 句集：服务端「MUST verify the PaymentIntent status is \"succeeded\"」后才 200 + receipt；失败 402 + 新 challenge；幂等键 SHOULD 由 challenge ID + SPT 派生；「Servers MUST enforce single-use challenge IDs」；「MUST NOT include Connect settlement parameters in the MPP challenge」；先完成 challenge 校验与过期检查再处理 SPT；客户端「MUST verify the payment amount in the challenge matches their expectation before creating an SPT」；全部通信 TLS 1.2+，SPT 仅 HTTPS 传输",
    "subscription rail 字段级 wire 细节（draft-stripe-subscription-00，paymentauth.org，检索 2026-11-22）：intent=\"subscription\"；request 字段 amount（最小单位正整数字符串，无符号/小数/指数/前导零）/currency（小写 ISO 4217）/periodUnit（MUST day|week|month）/periodCount（正整数字符串）均 REQUIRED，description/externalId 可选；recipient MUST NOT 在案（商家经 methodDetails.networkId 标识 —— 「Servers MUST reject request objects that include recipient or subscriptionExpires」）；methodDetails.paymentMethodTypes MUST 支持同步激活与未来 off-session 周期发票（异步首发票类型 MUST 拒）；credential = paymentMethod（Stripe PaymentMethod ID，须适合 off-session 周期扣款）+ customer 可选；receipt（仅成功响应）= method/reference（Stripe invoice ID）/status/subscriptionId/stripeSubscription/timestamp/externalId 可选；创建 MUST 集：collection_method=charge_automatically、payment_behavior=error_if_incomplete、proration_behavior=none、单项 quantity=1、无 add_invoice_items/backdate/cancel_at/pending_invoice_item_interval/schedule；试用/折价/税/用量计费/暂停/年度周期等 MUST 禁用或拒；激活只有首张发票 paid 且校验后成立；访问决策 MUST 用 canonical per-period accounting + paid invoices（绝不信任 Stripe 高层订阅状态）",
    "MCP transport 语义（draft-payment-transport-mcp-00，paymentauth.org，检索 2026-11-22）：付费操作 = tools/call、resources/read、prompts/get；流程 = 客户端请求 → JSON-RPC error code -32042（Payment Required）携 error.data.challenges（数组，字段 id/realm/method/intent/request REQUIRED + expires/description 可选）→ 客户端以 _meta \"org.paymentauth/credential\"（challenge REQUIRED 回显不变 + payload REQUIRED + source 可选）重发 → 结果 _meta 携 \"org.paymentauth/receipt\"（status=\"success\"/method/timestamp/challengeId REQUIRED + reference 可选）；MUST 句集：错误码 -32043（验证失败 + 新 challenge）、-32602（畸形 credential）、-32603（内部支付错误）；「Servers MUST return org.paymentauth/receipt on every successful response to a paid request」；notification 形式的付费操作 MUST NOT 处理；_meta 双位置（params 与根）MUST 都接受；challenge 绑定 = 密码学绑定 realm/method/intent/request（canonical 哈希）/expires（JCS），SHOULD 绑定具体操作；重放 = 未知/过期/已用 challenge ID MUST 拒（原子 check-and-mark）；TLS 1.2+；凭据不得记录/持久化；能力通告 = capabilities.experimental.payment（methods → intents，IANA 注册表）",
    "MPP 分册目录（paymentauth.org 首页，检索 2026-11-22）：核心 = draft-httpauth-payment-01 + discovery-01；charge rail 11 个网络分册（card/evm/hedera/lightning/nearintents-01/solana/stellar/stripe/tempo/usdc/xrpl，多为 -00）；session rail 6 个网络分册（evm/hedera/lightning/solana/tempo/xrpl —— 无 stripe session 分册）；subscription rail 3 个网络分册（solana/stripe/tempo）；transport-mcp-00；源仓 tempoxyz/mpp-specs",
  ],
  reverifyBeforeAdapter: [
    "session rail 字段级 wire 细节（session 分册仅 evm/hedera/lightning/solana/tempo/xrpl —— 无 stripe 变体；未检索的分册不发明）与 charge/subscription 的非 stripe 网络变体（evm/solana/tempo 等）的字段级差异",
  ],
};

/** pinned 注册表（单一来源；law 级测试断言其不变量）。 */
export const PAYSWAP_PROTOCOL_PIN_REGISTRY: ReadonlyMap<PayswapProtocolId, PayswapProtocolPin> =
  new Map([
    ["ap2", PAYSWAP_PROTOCOL_PIN_AP2],
    ["x402", PAYSWAP_PROTOCOL_PIN_X402],
    ["mpp", PAYSWAP_PROTOCOL_PIN_MPP],
  ]);
