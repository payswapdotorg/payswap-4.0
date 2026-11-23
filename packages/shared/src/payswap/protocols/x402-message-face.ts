/**
 * PaySwap P3 —— x402 消息面实现（supported subset = exact on eip155 via eip3009；
 * 处分见 docs/payswap/p3/x402-disposition-2026-11-22.md）。
 *
 * 实现许可（protocol-contract.ts 法则 5）：x402 的 `reverifyBeforeAdapter` 已于
 * 2026-11-23 清空 —— 未验证到的变体与 spec 沉默行改记注册表的
 * `unsupportedCapabilities`（每项带 typed refusal）。本面绝不超出 pin 编码。
 *
 * supported subset（doc 12 §6「Unsupported features are unavailable, not
 * simulated as production support」）：
 * - 核心三类消息（PaymentRequired / PaymentPayload / SettlementResponse）按 core
 *   §5 的 wire schema 做结构验证 —— 任何 scheme 的 **结构** 都可验证；
 * - 付款载荷选中的 requirements 必须落在 exact + eip155 + eip3009（缺省）+
 *   authorization 流（缺省）内，才对该载荷做 scheme 级验证；其余 typed
 *   `protocol_feature_unsupported`（不可用，不是模拟）—— 判定与 P6 资格评估
 *   共用 `evaluatePayswapX402RequirementSupport`；
 * - exact/EVM eip3009 payload 逐字按官方 scheme 分册（x402-foundation/x402 @
 *   b711fa9f，检索 2026-11-23）：signature = 65-byte；authorization 六字段全部
 *   REQUIRED，nonce = 32-byte；accepted.extra.name/version REQUIRED。
 *
 * 诚实边界（pin 内没说的就不做）：
 * - **不验签、不强制窗口**：spec 把验签 / 余额 / 有效期窗口 / 代币与网络校验
 *   记为 facilitator 的 /verify 逻辑（「Verify the signature is valid and
 *   recovers to the authorization.from address」）。本面只做签名的**形态**校验
 *   —— 形态合法的伪造签名同样是 untrusted 提案，绝无「已验证」结局。真实验签
 *   需要 secp256k1 + keccak256 的审计依赖（仓库未批准）；addendum §10 的验证
 *   要求未撤回，集成在验签落地前保持禁用。
 * - **不执行链上交易、不持有资金、不充当 facilitator / 资源服务器**。
 * - **重放身份 = 付款人 nonce**（core §10.1：重放防线是「unique 32-byte
 *   nonce」，不是 requirements，也不是签名字节 —— ECDSA 签名可延展）：本面在
 *   绑定里给出 `requirementsDigest`（绑定宿主签发的 402）与 `credentialDigest`
 *   （network + from + nonce）两个身份，单次使用的裁决在宿主。
 */

import { z } from "zod";
import type {
  PayswapX402ExactEvmAuthorization,
  PayswapX402SupportedRequirements,
} from "./protocol-contract.js";
import {
  type PayswapProtocolAdapter,
  type PayswapProtocolAdapterDescriptor,
  type PayswapProtocolEvidenceVerifier,
  type PayswapProtocolInboundOutcome,
  type PayswapProtocolReceiptOutcome,
  type PayswapProtocolRefusal,
  evaluatePayswapProtocolAdapterRegistration,
} from "./protocol-contract.js";
import { evaluatePayswapProtocolReceiptEvidence } from "./evidence-gate.js";
import { payswapCanonicalDigest } from "./canonical-digest.js";

/** x402 v2 协议版本（pin 逐字）。 */
const X402_VERSION = 2;

/** 本面支持的 scheme / 网络族 / 转账方法 / 付款流（注册表 unsupportedCapabilities 的补集）。 */
const SUPPORTED_SCHEME = "exact";
const SUPPORTED_NETWORK_REGEX = /^eip155:[1-9]\d*$/;
const SUPPORTED_ASSET_TRANSFER_METHOD = "eip3009";
const SUPPORTED_PAYMENT_FLOW = "authorization";

const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const caip2Regex = /^[a-z0-9-]+:[a-zA-Z0-9_-]+$/;
const atomicUnitsRegex = /^[1-9]\d*$/;
const unixTimestampStringRegex = /^(0|[1-9]\d*)$/;
/** 「The 65-byte signature」—— 0x + 130 hex。 */
const signatureRegex = /^0x[0-9a-fA-F]{130}$/;
/** 「32-byte random nonce」—— 官方示例为 0x + 64 hex。 */
const nonceRegex = /^0x[0-9a-fA-F]{64}$/;
/** 「Printable ASCII」。 */
const printableAsciiRegex = /^[\x20-\x7E]*$/;

/** ResourceInfo（core §5.1.2 —— PaymentRequired 与 PaymentPayload 的 `resource` 同型）。 */
const resourceInfoSchema = z
  .object({
    url: z.string().min(1),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    serviceName: z.string().max(32).regex(printableAsciiRegex).optional(),
    tags: z.array(z.string().max(32).regex(printableAsciiRegex)).max(5).optional(),
    iconUrl: z.string().max(2048).regex(/^https?:\/\//i).optional(),
  })
  .strict();

/** Extensions 值（core §5.1.2：info 与 schema 均 Required object）。 */
const extensionSchema = z
  .object({
    info: z.record(z.string(), z.unknown()),
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();
const extensionsSchema = z.record(z.string(), extensionSchema);

/** PaymentRequirements（core §5.1.2 —— scheme 无关的结构）。 */
const paymentRequirementsSchema = z
  .object({
    scheme: z.string().min(1),
    network: z.string().regex(caip2Regex),
    amount: z.string().regex(atomicUnitsRegex),
    asset: z.string().min(1),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** PaymentRequired schema（pinned wire schema，core §5.1 逐字）。 */
const paymentRequiredSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    error: z.string().optional(),
    resource: resourceInfoSchema,
    accepts: z.array(paymentRequirementsSchema).min(1),
    extensions: extensionsSchema.optional(),
  })
  .strict();

/** PaymentPayload 的 scheme 无关核心（core §5.2.2；`payload` 是 scheme 特定 → 过了 subset 判定再验）。 */
const paymentPayloadCoreSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    resource: resourceInfoSchema.optional(),
    accepted: paymentRequirementsSchema,
    payload: z.unknown(),
    extensions: extensionsSchema.optional(),
  })
  .strict();

/** exact/EVM eip3009 的 authorization（core §5.2.2 Authorization 表 —— 六字段全 REQUIRED string）。 */
const exactEvmAuthorizationSchema = z
  .object({
    from: z.string().regex(evmAddressRegex),
    to: z.string().regex(evmAddressRegex),
    value: z.string().regex(atomicUnitsRegex),
    validAfter: z.string().regex(unixTimestampStringRegex),
    validBefore: z.string().regex(unixTimestampStringRegex),
    nonce: z.string().regex(nonceRegex),
  })
  .strict();

/** exact/EVM eip3009 的 payload（scheme 分册 §1：「must contain」signature + authorization）。 */
const exactEvmEip3009PayloadSchema = z
  .object({
    signature: z.string().regex(signatureRegex),
    authorization: exactEvmAuthorizationSchema,
  })
  .strict();

/** eip3009 的 requirements `extra`：name / version REQUIRED（EIP-712 域）；其余键 scheme-specific，原样保留。 */
const eip3009RequirementsExtraSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .passthrough();

/**
 * exact/EVM eip3009 载荷的 scheme 级验证（payload + accepted.extra + 载荷内一致性）。
 * 一致性取自 facilitator 的 Verification Logic 第 3 步「Verify the authorization
 * parameters (Amount, Validity Window) meet the PaymentRequirements」—— 这里比对
 * 的是客户端回显的 `accepted`（本面拿不到宿主签发记录）；对宿主签发记录的绑定
 * 在 services 侧协议宿主。
 */
const exactEvmEip3009PaymentSchema = z
  .object({
    payload: exactEvmEip3009PayloadSchema,
    acceptedExtra: eip3009RequirementsExtraSchema,
    acceptedPayTo: z.string().min(1),
    acceptedAmount: z.string().regex(atomicUnitsRegex),
  })
  .superRefine((value, ctx) => {
    const { authorization } = value.payload;
    // 结构性窗口校验（Row 1 处分：只验 validAfter < validBefore，不派生 maxTimeoutSeconds 联动）。
    if (BigInt(authorization.validAfter) >= BigInt(authorization.validBefore)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "authorization"],
        message: "validAfter MUST be earlier than validBefore（结构性窗口校验）",
      });
    }
    // 地址比对大小写无关（EIP-55 校验和大小写不改变地址）。
    if (authorization.to.toLowerCase() !== value.acceptedPayTo.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "authorization", "to"],
        message: "authorization.to MUST equal accepted.payTo（recipient mismatch）",
      });
    }
    if (authorization.value !== value.acceptedAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "authorization", "value"],
        message: "authorization.value MUST exactly equal accepted.amount（value mismatch）",
      });
    }
  });

/** SettlementResponse schema（pinned wire schema，core §5.3 逐字）。 */
const settlementResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string().regex(caip2Regex),
    amount: z.string().optional(),
    extensions: extensionsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 官方：transaction 「MUST be non-empty when errorReason is settlement_pending」。
    if (value.errorReason === "settlement_pending" && value.transaction.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transaction"],
        message: "transaction MUST be non-empty when errorReason is settlement_pending",
      });
    }
  });

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。 */
const inboundEnvelopeSchema = z
  .object({
    x402Kind: z.enum(["payment-required", "payment-payload", "settlement-response"]),
    payload: z.unknown(),
  })
  .strict();

// ---------------------------------------------------------------------------
// supported subset 判定（单一实现 —— 消息面与 P6 资格评估共用）
// ---------------------------------------------------------------------------

export type PayswapX402RequirementSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly refusal: "protocol_feature_unsupported";
      readonly detail: string;
    };

function unsupportedRequirement(detail: string): PayswapX402RequirementSupport {
  return { supported: false, refusal: "protocol_feature_unsupported", detail };
}

/**
 * 裁决一条 PaymentRequirements 是否落在本面已逐字段 pin 的 subset 内：
 * exact + eip155:* + eip3009（`extra.assetTransferMethod` 缺省即 eip3009）+
 * authorization 流（`extra.paymentFlow` 缺省即 authorization）。
 *
 * 官方依据（core §6.1 + scheme 分册 Summary）：缺省值「Omitting
 * `extra.assetTransferMethod` or `extra.paymentFlow` means the mechanism default」；
 * eip3009「if present, MUST be "eip3009"」。subset 之外 = 不可用，不是模拟。
 * 结构畸形（非对象等）不是本函数的裁决 —— 由核心 schema 以
 * `protocol_message_unverifiable` 拒绝。
 */
export function evaluatePayswapX402RequirementSupport(
  requirements: unknown,
): PayswapX402RequirementSupport {
  if (typeof requirements !== "object" || requirements === null || Array.isArray(requirements)) {
    return unsupportedRequirement("PaymentRequirements 不是 JSON 对象");
  }
  const record = requirements as Record<string, unknown>;
  const extra =
    typeof record.extra === "object" && record.extra !== null && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : {};
  const assetTransferMethod = extra.assetTransferMethod ?? SUPPORTED_ASSET_TRANSFER_METHOD;
  const paymentFlow = extra.paymentFlow ?? SUPPORTED_PAYMENT_FLOW;
  if (record.scheme !== SUPPORTED_SCHEME) {
    return unsupportedRequirement(
      `scheme '${String(record.scheme)}' 的付款 payload wire 未逐字段入 pin（本面只支持 ${SUPPORTED_SCHEME}）`,
    );
  }
  if (typeof record.network !== "string" || !SUPPORTED_NETWORK_REGEX.test(record.network)) {
    return unsupportedRequirement(
      `network '${String(record.network)}' 不在 eip155 族（本面只支持 exact on EVM）`,
    );
  }
  if (assetTransferMethod !== SUPPORTED_ASSET_TRANSFER_METHOD) {
    return unsupportedRequirement(
      `assetTransferMethod '${String(assetTransferMethod)}' 未逐字段入 pin（本面只支持缺省 ${SUPPORTED_ASSET_TRANSFER_METHOD}）`,
    );
  }
  if (paymentFlow !== SUPPORTED_PAYMENT_FLOW) {
    return unsupportedRequirement(
      `paymentFlow '${String(paymentFlow)}' 未 pin（本面只支持缺省 ${SUPPORTED_PAYMENT_FLOW} 流）`,
    );
  }
  return { supported: true };
}

// ---------------------------------------------------------------------------
// 适配器工厂
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

function unverifiable(detail: string): PayswapProtocolInboundOutcome {
  return {
    kind: "refused",
    refusal: refusal(
      "protocol_message_unverifiable",
      `x402 消息未通过 pinned schema（未知字段 / 缺失必填 / 形态或一致性违规 —— fail-closed）：${detail}`,
    ),
  };
}

export function createPayswapX402MessageFace(
  descriptor: PayswapProtocolAdapterDescriptor,
  options: { readonly evidenceVerifier?: PayswapProtocolEvidenceVerifier } = {},
): PayswapProtocolAdapter {
  const registration = evaluatePayswapProtocolAdapterRegistration(descriptor);
  if (registration.kind === "refused") {
    throw new Error(
      `x402 消息面装配被拒（${registration.refusal.code}）：${registration.refusal.message}`,
    );
  }

  async function translatePaymentPayload(payload: unknown): Promise<PayswapProtocolInboundOutcome> {
    const core = paymentPayloadCoreSchema.safeParse(payload);
    if (!core.success) {
      return unverifiable(core.error.issues[0]?.message ?? "schema error");
    }
    // subset 判定先于 scheme 级验证：未 pin 的 scheme/网络族/转账方法/付款流不可用。
    const support = evaluatePayswapX402RequirementSupport(core.data.accepted);
    if (!support.supported) {
      return {
        kind: "refused",
        refusal: refusal(support.refusal, `${support.detail} —— 不可用，不是模拟`),
      };
    }
    const exact = exactEvmEip3009PaymentSchema.safeParse({
      payload: core.data.payload,
      acceptedExtra: core.data.accepted.extra,
      acceptedPayTo: core.data.accepted.payTo,
      acceptedAmount: core.data.accepted.amount,
    });
    if (!exact.success) {
      return unverifiable(exact.error.issues[0]?.message ?? "schema error");
    }
    const { authorization } = exact.data.payload;
    const accepted: PayswapX402SupportedRequirements = {
      scheme: SUPPORTED_SCHEME,
      network: core.data.accepted.network,
      amount: core.data.accepted.amount,
      asset: core.data.accepted.asset,
      payTo: core.data.accepted.payTo,
      maxTimeoutSeconds: core.data.accepted.maxTimeoutSeconds,
      extra: exact.data.acceptedExtra as PayswapX402SupportedRequirements["extra"],
    };
    return {
      kind: "validated-untrusted-proposal",
      protocolId: descriptor.protocolId,
      versionPin: descriptor.versionPin,
      untrustedPayloadDigest: await payswapCanonicalDigest(core.data),
      challengeBinding: {
        kind: "x402-requirements-binding",
        requirementsDigest: await payswapCanonicalDigest(accepted),
        // 重放身份 = 付款人 nonce（core §10.1）—— 不含签名字节（ECDSA 可延展）。
        credentialDigest: await payswapCanonicalDigest({
          network: accepted.network,
          from: authorization.from.toLowerCase(),
          nonce: authorization.nonce.toLowerCase(),
        }),
        accepted,
        authorization: authorization as PayswapX402ExactEvmAuthorization,
      },
    };
  }

  return {
    descriptor,

    async translateInbound(untrustedMessage: unknown): Promise<PayswapProtocolInboundOutcome> {
      const envelope = inboundEnvelopeSchema.safeParse(untrustedMessage);
      if (!envelope.success) {
        return unverifiable(
          `进站消息形态未知（x402Kind 路由标签缺失/未知）—— ${envelope.error.issues[0]?.message ?? "schema error"}`,
        );
      }
      const { x402Kind, payload } = envelope.data;
      if (x402Kind === "payment-payload") {
        return translatePaymentPayload(payload);
      }
      const schema = x402Kind === "payment-required" ? paymentRequiredSchema : settlementResponseSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return unverifiable(`${x402Kind}：${parsed.error.issues[0]?.message ?? "schema error"}`);
      }
      return {
        kind: "validated-untrusted-proposal",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        untrustedPayloadDigest: await payswapCanonicalDigest(parsed.data),
      };
    },

    async emitReceipt(evidence): Promise<PayswapProtocolReceiptOutcome> {
      const gate = await evaluatePayswapProtocolReceiptEvidence({
        evidence,
        protocolId: descriptor.protocolId,
        verifier: options.evidenceVerifier,
      });
      if (gate.kind === "refused") {
        return { kind: "refused", refusal: gate.refusal };
      }
      return {
        kind: "receipt-emitted",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        settlementEvidenceRef: gate.evidence.evidenceRef,
      };
    },
  };
}
