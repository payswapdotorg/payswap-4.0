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
 * AP2 v0.2 —— 官方规范页检索 2026-11-15（https://ap2-protocol.org/ap2/specification/）。
 * 版本串 v0.2 照录规范页标题（「Agentic Payment Protocol (v0.2)」）；站点页头
 * 同时使用「Agent Payments Protocol」措辞 —— 两名并存如实记录，不裁决正名。
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
    "角色集含 Trusted Surface (TS)：「a UI surface that is trusted to get informed user consent for an Intent before creating a user-signed Mandate」—— PaySwap 侧对应既有的 trusted 非代理 Class-B 面（doc 12 §6 边界规则）",
    "Payment Mandate 模式三枚举照录规范页目录：Direct (Human Present) / Autonomous (Human Not Present) / Agent-to-Agent Delegation",
    "Checkout Mandate + Receipt 与 Payment Mandate + Receipt 成对，作为争议时点的证据（spec 自述）",
    "AP2 自述「operates as a security feature within a Commerce Protocol」（协议是 Commerce Protocol 内的安全特性，不是支付执行引擎 —— 与 addendum §10 边界一致）",
  ],
  reverifyBeforeAdapter: [
    "mandate/receipt 的字段级 schema（规范页结构需逐节核对后才能定型消息面）",
    "Verifiable Digital Credential Formats (VDCs) 的形态与验证规则",
    "Agent Authorization Framework 的机制细节（进站消息的签名/验签要求）",
    "Mandate Versioning 规则（版本兼容矩阵与拒收语义）",
  ],
};

/**
 * x402 —— 官方站检索 2026-11-15（https://x402.org）。落地页未发布可引用的
 * 版本串（H1/文案无版本号）→ versionPin 如实为 null：适配器实现被
 * protocol_version_unpinned 挡住，直至从官方规范源验证到版本串。
 */
export const PAYSWAP_PROTOCOL_PIN_X402: PayswapProtocolPin = {
  protocolId: "x402",
  officialName: "x402",
  versionPin: null,
  officialSourceUrl: "https://x402.org",
  factsRetrievedAt: RETRIEVED_AT,
  verifiedBoundaryFacts: [
    "自述「an open, neutral standard for internet-native payments」",
    "交互流自述：未付费请求到达时服务端回 HTTP 402 Payment Required，客户端支付后重试（「If a request arrives without payment, the server responds with HTTP 402, prompting the client to pay and retry」）",
    "落地页示例为服务端 middleware 形态（paymentMiddleware 按路由声明 accepts 网络/scheme 列表）",
    "落地页文案提及 AI agent 以 stablecoins 即时支付（「AI agent pays instantly with stablecoins」）—— rail 事实以官方规范为准，落地页文案不编码为规则",
  ],
  reverifyBeforeAdapter: [
    "官方规范文档的 URL 与可引用版本串（落地页未暴露 —— 找到规范源并检索日期在案前不猜）",
    "402 payment request/response 的字段级 wire format",
    "接受的资产/网络/scheme 闭集与验证要求",
    "收据/重放保护语义（未知 —— 不发明）",
  ],
};

/**
 * MPP —— Stripe 官方公告检索 2026-11-15
 * （https://stripe.com/blog/machine-payments-protocol）。公告页非规范文档，
 * 无版本串 → versionPin 如实为 null（同 x402 处理）。
 */
export const PAYSWAP_PROTOCOL_PIN_MPP: PayswapProtocolPin = {
  protocolId: "mpp",
  officialName: "Machine Payments Protocol (MPP)",
  versionPin: null,
  officialSourceUrl: "https://stripe.com/blog/machine-payments-protocol",
  factsRetrievedAt: RETRIEVED_AT,
  verifiedBoundaryFacts: [
    "自述「an open standard, internet-native way for agents to pay — co-authored by Tempo and Stripe」",
    "自述「provides a specification for agents and services to coordinate payments programmatically, enabling microtransactions, recurring payments, and more」",
    "自述 Stripe 用户可经 MPP 以法币收款：「fiat with cards and buy now, pay later payment methods via Shared Payment Tokens (SPTs)」",
    "公告示例含按会话计费的服务消费（Browserbase 按 session 付费的 headless 浏览器）—— 与 doc 12 §6「Metered/repeated charges require envelope bounds」的边界对应",
  ],
  reverifyBeforeAdapter: [
    "规范文档的官方 URL 与版本串（公告页非规范 —— 找到规范源并检索日期在案前不猜）",
    "machine-payment session 的生命周期与消息 schema",
    "SPT（Shared Payment Tokens）机制与 PaySwap 凭据面的关系",
    "microtransaction/recurring 的计费事件语义与验证规则",
  ],
};

/** pinned 注册表（单一来源；law 级测试断言其不变量）。 */
export const PAYSWAP_PROTOCOL_PIN_REGISTRY: ReadonlyMap<PayswapProtocolId, PayswapProtocolPin> =
  new Map([
    ["ap2", PAYSWAP_PROTOCOL_PIN_AP2],
    ["x402", PAYSWAP_PROTOCOL_PIN_X402],
    ["mpp", PAYSWAP_PROTOCOL_PIN_MPP],
  ]);
