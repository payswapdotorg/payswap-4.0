/**
 * PaySwap P3.1 —— 协议适配器边界契约（addendum §10「Payment-protocol adapters
 * are not providers or executors」+ doc 12 §6「Protocol interoperability at the
 * boundary」的法则面）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **适配器不是执行者**：协议适配器把版本化外部协议翻译进 PaySwap 公共金融
 *    词汇、并把已验证的执行/对账状态映射回收据 —— 它不拥有账户身份、provider
 *    凭据、路由、资格、交易 grant、资金提交、结算真相或账本（addendum §10
 *    逐字）。
 * 2. **进站消息是不可信输入**：任何协议消息（含 402 challenge、mandate、
 *    session 事件）到达时都是不可信的 —— 翻译产物只能是**提案**（供 host 侧
 *    确定性服务评估）或 typed 拒绝；永不直接成为 grant、授权或 provider 事实
 *    （doc 12 §6「A 402/payment challenge is untrusted input, not consent」）。
 * 3. **收据只从已验证状态发出**：收据由经验证的执行/对账状态映射而来；协议
 *    侧「accepted」事件不是结算（doc 12 §6「a protocol "accepted" event is
 *    not settlement」）—— 未验证到执行/对账状态时收据面 typed 拒绝。
 * 4. **pinning 强制**：适配器描述符必须与协议事实注册表（protocol-facts.ts）
 *    的 pin 一致才可注册 —— 未注册协议 / 注册表版本未验证 / 版本不匹配均
 *    typed 拒绝（doc 12 §6「pins an exact version … fails closed on unknown
 *    versions」的机器面）。
 * 5. **消息面实现门**：注册表的 `reverifyBeforeAdapter` 清单未空时，协议的
 *    消息 schema/验证实现不得落地（本契约是边界，不是消息实现），注册门对
 *    一切适配器 typed 拒绝 `protocol_reverify_pending`。已知的「不支持」（未
 *    检索的变体、spec 沉默行、未实现的验证）不是「未验证」—— 记入注册表的
 *    `unsupportedCapabilities`（每项带 typed refusal），不留在清单里。未知形态
 *    fail-closed，不模拟支持（doc 12 §6「Unsupported features are unavailable,
 *    not simulated as production support」）。
 */

import type { PayswapProtocolId, PayswapProtocolPin } from "./protocol-facts.js";
import { PAYSWAP_PROTOCOL_PIN_REGISTRY } from "./protocol-facts.js";
import type { PayswapProtocolRefusal } from "./protocol-refusal.js";

// ---------------------------------------------------------------------------
// typed refusal（边界词汇闭集 —— 连接 UI/法则测试按 code 分流；新 code = 契约变更）
// 词汇本体住叶子模块 protocol-refusal.ts：注册表（protocol-facts.ts）的不支持
// 能力清单也引用 refusal 码 —— 词汇若住本文件，facts ↔ contract 即成环。
// ---------------------------------------------------------------------------

export {
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  type PayswapProtocolRefusal,
  type PayswapProtocolRefusalCode,
} from "./protocol-refusal.js";

// ---------------------------------------------------------------------------
// 适配器描述符与注册门（法则 4 的机器面）
// ---------------------------------------------------------------------------

/** 协议适配器描述符：身份即 pinning —— 与注册表一致才可注册。 */
export interface PayswapProtocolAdapterDescriptor {
  readonly protocolId: PayswapProtocolId;
  /** 适配器实现钉住的精确版本/规范引用（必须等于注册表 pin）。 */
  readonly versionPin: string;
  readonly officialSourceUrl: string;
  readonly factsRetrievedAt: string;
}

/** 注册门结局：registered 或 typed 拒绝（无第三种 —— 不存在「带警告注册」）。 */
export type PayswapProtocolRegistrationOutcome =
  | { readonly kind: "registered"; readonly protocolId: PayswapProtocolId; readonly versionPin: string }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

/**
 * 注册门（法则 4 + 法则 5）：按 pin 一致性裁决适配器可否注册。
 * 判定次序：未注册 → 版本未验证 → 版本不匹配 → 事实源漂移 → 再验证清单未空
 * → registered。
 * 生产与 law 级测试共用同一实现（单一事实源）。
 */
export function evaluatePayswapProtocolAdapterRegistration(
  descriptor: PayswapProtocolAdapterDescriptor,
  registry: ReadonlyMap<PayswapProtocolId, PayswapProtocolPin> = PAYSWAP_PROTOCOL_PIN_REGISTRY,
): PayswapProtocolRegistrationOutcome {
  const pin = registry.get(descriptor.protocolId);
  if (pin === undefined) {
    return {
      kind: "refused",
      refusal: {
        code: "protocol_not_registered",
        message: `协议 '${descriptor.protocolId}' 不在 pinned 注册表 —— 未评估/未批准的协议面（fail-closed）`,
      },
    };
  }
  if (pin.versionPin === null) {
    return {
      kind: "refused",
      refusal: {
        code: "protocol_version_unpinned",
        message: `协议 '${descriptor.protocolId}' 的版本串尚未从官方源验证（检索 ${pin.factsRetrievedAt}）—— 适配器实现被挡：不猜版本`,
      },
    };
  }
  if (descriptor.versionPin !== pin.versionPin) {
    return {
      kind: "refused",
      refusal: {
        code: "protocol_version_unsupported",
        message: `适配器 pin '${descriptor.versionPin}' 与注册表 pin '${pin.versionPin}' 不一致（协议 ${descriptor.protocolId}）—— 未知/不匹配版本 fail-closed`,
      },
    };
  }
  if (descriptor.officialSourceUrl !== pin.officialSourceUrl || descriptor.factsRetrievedAt !== pin.factsRetrievedAt) {
    return {
      kind: "refused",
      refusal: {
        code: "protocol_facts_drift",
        message: `适配器事实源（${descriptor.officialSourceUrl} @ ${descriptor.factsRetrievedAt}）与注册表（${pin.officialSourceUrl} @ ${pin.factsRetrievedAt}）不一致（协议 ${descriptor.protocolId}）—— 事实漂移 fail-closed`,
      },
    };
  }
  // 法则 5：清单未空 = 注册表自述「消息面实现仍被挡」—— 未验证到的不编码、不模拟。
  if (pin.reverifyBeforeAdapter.length > 0) {
    return {
      kind: "refused",
      refusal: {
        code: "protocol_reverify_pending",
        message: `协议 '${descriptor.protocolId}' 的消息面再验证清单未空（${pin.reverifyBeforeAdapter.length} 项：${pin.reverifyBeforeAdapter.join("；")}）—— 适配器实现被挡：未验证到的不编码`,
      },
    };
  }
  return { kind: "registered", protocolId: descriptor.protocolId, versionPin: descriptor.versionPin };
}

/**
 * 由注册表 pin 派生适配器描述符（URL / 检索日期 / 版本不在调用方手抄）。
 * 未注册或版本未验证 = 注册表状态不允许装配 → 抛错（装配期编程/事实错误，
 * 不是消息拒绝）。
 */
export function payswapProtocolAdapterDescriptor(
  protocolId: PayswapProtocolId,
  registry: ReadonlyMap<PayswapProtocolId, PayswapProtocolPin> = PAYSWAP_PROTOCOL_PIN_REGISTRY,
): PayswapProtocolAdapterDescriptor {
  const pin = registry.get(protocolId);
  if (pin === undefined || pin.versionPin === null) {
    throw new Error(
      `Payswap protocol '${protocolId}' has no verified version pin in the registry; no adapter descriptor can be derived.`,
    );
  }
  return {
    protocolId,
    versionPin: pin.versionPin,
    officialSourceUrl: pin.officialSourceUrl,
    factsRetrievedAt: pin.factsRetrievedAt,
  };
}

// ---------------------------------------------------------------------------
// 翻译边界（法则 2/3 的类型面 —— P3 形态：提案引用 + typed 拒绝）
// ---------------------------------------------------------------------------

/**
 * 进站翻译的结局（P3 形态）：外部消息通过 pinned 版本的**结构验证**后，以
 * **不可信提案引用**进入 PaySwap —— `untrustedPayloadDigest` 记录载荷摘要供
 * 证据链；载荷的类型化金融词汇（typed intent）随 P4 intent compiler 落地，
 * 在那之前提案**永不**成为 grant、授权或 provider 事实（法则 2）。
 *
 * 术语纪律（2026-11-22 评审）：结局名是 `validated-untrusted-proposal` ——
 * **结构验证不是密码学验证**（SD-JWT 签名/发行者/Key Binding 验证的前置条件
 * 未在案，绝不模拟）。`validated` 只指「通过了 pinned 结构 schema」；该结局
 * 不得被任何调用方解读为已认证或已密码学验证的 mandate。
 */
export interface PayswapProtocolInboundValidated {
  readonly kind: "validated-untrusted-proposal";
  readonly protocolId: PayswapProtocolId;
  readonly versionPin: string;
  /** 载荷摘要（canonical digest —— 证据链与后续评估的绑定面）。 */
  readonly untrustedPayloadDigest: string;
  /**
   * 凭据/付款载荷消息携带的 challenge 绑定（challenge 自身、收据与 AP2 消息为
   * undefined）。这是**适配器的不受信声明**：宿主必须用自己签发的 challenge 记录
   * 比对后才可采信（protocol_challenge_* 拒绝）。按协议分型（`kind` 判别）：
   * MPP = challenge 回显；x402 = requirements + 付款授权双身份。
   * 适配器不得在绑定字段之外解释金融语义。
   */
  readonly challengeBinding?: PayswapProtocolChallengeBinding;
}

/** MPP：challenge 回显绑定（wire 上有 id；宿主对回显做绑定投影后逐字比对）。 */
export interface PayswapMppChallengeBinding {
  readonly kind: "mpp-challenge-echo";
  readonly challengeId: string;
  readonly method: string;
  readonly intent: string;
  /** 协议原始 request 串（base64url-nopad）。 */
  readonly request: string;
  /** 逐字回显的 challenge 对象（已过 pinned schema；宿主投影后比对）。 */
  readonly echoedChallenge: unknown;
}

/** exact/EVM eip3009 付款授权（已过 pinned schema 的六个必填 string 字段）。 */
export interface PayswapX402ExactEvmAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

/** 已过 pinned schema 且落在 supported subset 内的 PaymentRequirements。 */
export interface PayswapX402SupportedRequirements {
  readonly scheme: "exact";
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>> & { readonly name: string; readonly version: string };
}

/**
 * x402：无 challenge id —— 两个身份分开绑定（官方：重放防线是付款人 nonce/签名，
 * 不是 requirements）。二者都是适配器的不受信声明，宿主按自己的签发记录裁决。
 */
export interface PayswapX402RequirementsBinding {
  readonly kind: "x402-requirements-binding";
  /** 选中 requirements 的 canonical 摘要 —— 绑定宿主签发的 402。 */
  readonly requirementsDigest: string;
  /** 付款授权身份（network + from + nonce + signature）的 canonical 摘要 —— 单次使用的键。 */
  readonly credentialDigest: string;
  readonly accepted: PayswapX402SupportedRequirements;
  readonly authorization: PayswapX402ExactEvmAuthorization;
}

/** 适配器对 challenge 绑定的不受信声明（宿主比对后才成为事实）。 */
export type PayswapProtocolChallengeBinding =
  | PayswapMppChallengeBinding
  | PayswapX402RequirementsBinding;

/** 进站翻译结局闭集：结构验证通过（成为不可信提案）或 typed 拒绝。 */
export type PayswapProtocolInboundOutcome =
  | PayswapProtocolInboundValidated
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

/**
 * 宿主签发的结算证据对象（法则 3 的运行时权威边界）：
 *
 * 只有宿主的证据服务（权威执行/对账证据源）构造此对象 —— 适配器**永不安言**
 * 铸造或推定结算事实。适配器侧的运行时强制 = 结构验证（引用形态、摘要形态、
 * 状态枚举、时间戳形态）+ 状态门（仅 `settled-verified` 可产收据）：
 * - `indeterminate`/`pending`/任何其他状态 → typed 拒绝（不可判定结局不得产
 *   成功收据）；
 * - 畸形引用/摘要/时间戳 → typed 拒绝；
 * - 证据的**真实性**由宿主证据源保证（适配器无法也不需要验证底层账本 ——
 *   法则 1：适配器不拥有结算真相）。
 */
export interface PayswapProtocolSettlementEvidence {
  /** 宿主签发的证据引用（host evidence URI —— 形态由宿主证据服务定义）。 */
  readonly evidenceRef: string;
  /** 结算记录的 canonical 摘要（宿主计算 —— 绑定具体证据内容）。 */
  readonly evidenceDigest: string;
  /** 证据状态：仅 `settled-verified` 可到达收据发射路径。 */
  readonly state: "settled-verified" | "indeterminate" | "pending" | "failed";
  /** 证据捕获时间（ISO 8601 —— 过期/未来形态拒绝）。 */
  readonly capturedAt: string;
  /** 宿主证据权威的签发标识（一次性、不可由适配器铸造）。 */
  readonly hostAttestationId: string;
  /** 该证据所属协议 —— 跨协议复用即 `protocol_evidence_untrusted`。 */
  readonly protocolId: PayswapProtocolId;
  /** 证据主体（执行/对账记录引用）—— 宿主选择证据时绑定具体交易。 */
  readonly subjectRef: string;
}

/**
 * 宿主证据权威的验证端口（适配器侧唯一可用的证据可信度判据）。
 *
 * 实现由宿主提供（权威证据源持有的不可伪造状态/签名密钥），适配器只拿到
 * `verify` 函数 —— 拿不到签发能力，因此**结构上无法铸造**自己的结算证据。
 * 缺席 verifier = 所有收据请求 fail-closed（`protocol_evidence_untrusted`）。
 */
export interface PayswapProtocolEvidenceVerifier {
  readonly verify: (evidence: PayswapProtocolSettlementEvidence) => Promise<boolean>;
}

/**
 * 出站收据结局（法则 3）：收据只从**宿主签发的已验证结算证据**映射而来；
 * 证据缺席/畸形/非 settled-verified 状态 → typed
 * `protocol_receipt_unavailable`（协议 accepted ≠ 结算）。
 */
export type PayswapProtocolReceiptOutcome =
  | {
      readonly kind: "receipt-emitted";
      readonly protocolId: PayswapProtocolId;
      readonly versionPin: string;
      /** 已验证执行/对账状态的账本证据引用（来自宿主证据对象）。 */
      readonly settlementEvidenceRef: string;
    }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

/**
 * 协议适配器端口。消息面实现住 shared 的 `protocols/*-message-face.ts`（纯
 * schema + 摘要，无 IO）；services 侧的协议宿主是其**唯一生产调用面**。
 *
 * 注意（法则 1）：端口上**没有**任何凭据、账户、路由或授权参数 —— 适配器拿
 * 不到金融权威，类型面上就没有。实现侧违反（例如在 adapter 内部拉起 provider
 * 调用）= 架构违约。
 */
export interface PayswapProtocolAdapter {
  readonly descriptor: PayswapProtocolAdapterDescriptor;
  /** 进站：结构验证不可信外部消息 → 不可信提案或 typed 拒绝（绝不代表密码学验证）。 */
  readonly translateInbound: (untrustedMessage: unknown) => Promise<PayswapProtocolInboundOutcome>;
  /** 出站：从宿主签发的已验证结算证据映射回收据，或 typed 拒绝。 */
  readonly emitReceipt: (evidence: PayswapProtocolSettlementEvidence | null) => Promise<PayswapProtocolReceiptOutcome>;
}
