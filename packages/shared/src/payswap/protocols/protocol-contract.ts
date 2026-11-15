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
 *    消息 schema/验证实现不得落地（本契约是边界，不是消息实现）。未知形态
 *    fail-closed，不模拟支持（doc 12 §6「Unsupported features are unavailable,
 *    not simulated as production support」）。
 */

import type { PayswapProtocolId, PayswapProtocolPin } from "./protocol-facts.js";
import { PAYSWAP_PROTOCOL_PIN_REGISTRY } from "./protocol-facts.js";

// ---------------------------------------------------------------------------
// typed refusal（边界词汇闭集 —— 连接 UI/法则测试按 code 分流；新 code = 契约变更）
// ---------------------------------------------------------------------------

export const PAYSWAP_PROTOCOL_REFUSAL_CODES = [
  /** 协议 id 不在 pinned 注册表（未评估/未批准的协议面）。 */
  "protocol_not_registered",
  /** 注册表尚未验证到该协议的版本串 —— 适配器实现被挡（fail-closed：不猜版本）。 */
  "protocol_version_unpinned",
  /** 适配器 pin 的版本与注册表不一致（含未知/未来版本 —— 不模拟支持）。 */
  "protocol_version_unsupported",
  /** 消息验签/签发者/受众/重放/过期校验失败，或形态未知（unknown → fail-closed）。 */
  "protocol_message_unverifiable",
  /** 协议特性经官方源验证为不适用/未启用（不可用，不是模拟）。 */
  "protocol_feature_unsupported",
  /** 收据面被要求但执行/对账状态未验证到（协议 accepted ≠ 结算）。 */
  "protocol_receipt_unavailable",
] as const;

export type PayswapProtocolRefusalCode = (typeof PAYSWAP_PROTOCOL_REFUSAL_CODES)[number];

/** 协议边界 typed 拒绝（与账户服务 refusal 同形：code + 人类可读消息）。 */
export interface PayswapProtocolRefusal {
  readonly code: PayswapProtocolRefusalCode;
  readonly message: string;
}

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
 * 注册门（法则 4）：按 pin 一致性裁决适配器可否注册。
 * 判定次序：未注册 → 版本未验证 → 版本不匹配 → registered。
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
        code: "protocol_version_unsupported",
        message: `适配器事实源（${descriptor.officialSourceUrl} @ ${descriptor.factsRetrievedAt}）与注册表（${pin.officialSourceUrl} @ ${pin.factsRetrievedAt}）不一致（协议 ${descriptor.protocolId}）—— 事实漂移 fail-closed`,
      },
    };
  }
  return { kind: "registered", protocolId: descriptor.protocolId, versionPin: descriptor.versionPin };
}

// ---------------------------------------------------------------------------
// 翻译边界（法则 2/3 的类型面 —— P3 形态：提案引用 + typed 拒绝）
// ---------------------------------------------------------------------------

/**
 * 进站翻译的已验证结局（P3 形态）：外部消息通过 pinned 版本的验证后，以
 * **不可信提案引用**进入 PaySwap —— `untrustedPayloadDigest` 记录载荷摘要供
 * 证据链；载荷的类型化金融词汇（typed intent）随 P4 intent compiler 落地，
 * 在那之前提案**永不**成为 grant、授权或 provider 事实（法则 2）。
 */
export interface PayswapProtocolInboundVerified {
  readonly kind: "verified-inbound";
  readonly protocolId: PayswapProtocolId;
  readonly versionPin: string;
  /** 载荷摘要（canonical digest —— 证据链与后续评估的绑定面）。 */
  readonly untrustedPayloadDigest: string;
}

/** 进站翻译结局闭集：已验证（成为不可信提案）或 typed 拒绝。 */
export type PayswapProtocolInboundOutcome =
  | PayswapProtocolInboundVerified
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

/**
 * 出站收据结局（法则 3）：收据只从**已验证**的执行/对账状态映射而来
 * （`settlementEvidenceRef` 指向账本/对账证据）；状态未验证到 → typed
 * `protocol_receipt_unavailable`（协议 accepted ≠ 结算）。
 */
export type PayswapProtocolReceiptOutcome =
  | {
      readonly kind: "receipt-emitted";
      readonly protocolId: PayswapProtocolId;
      readonly versionPin: string;
      /** 已验证执行/对账状态的账本证据引用。 */
      readonly settlementEvidenceRef: string;
    }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

/**
 * 协议适配器端口（services 侧实现；host 侧唯一调用面）。
 *
 * 注意（法则 1）：端口上**没有**任何凭据、账户、路由或授权参数 —— 适配器拿
 * 不到金融权威，类型面上就没有。实现侧违反（例如在 adapter 内部拉起 provider
 * 调用）= 架构违约。
 */
export interface PayswapProtocolAdapter {
  readonly descriptor: PayswapProtocolAdapterDescriptor;
  /** 进站：验证不可信外部消息 → 提案引用或 typed 拒绝。 */
  readonly translateInbound: (untrustedMessage: unknown) => Promise<PayswapProtocolInboundOutcome>;
  /** 出站：从已验证执行/对账状态映射回收据，或 typed 拒绝。 */
  readonly emitReceipt: (settlementEvidenceRef: string | null) => Promise<PayswapProtocolReceiptOutcome>;
}
