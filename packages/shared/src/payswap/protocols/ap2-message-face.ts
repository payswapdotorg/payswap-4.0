/**
 * PaySwap P3 —— AP2 消息面实现（协议适配器消息 schema / 验证门）。
 *
 * 实现许可（protocol-contract.ts 法则 5）：AP2 的 `reverifyBeforeAdapter` 清单
 * 已于 2026-11-21 清空（第三批检索 —— delegation 对象、Action Authorization 错误
 * 语义、Checkout Mandate 字段级 schema 逐字段入 pin），本消息面按**已验证事实**
 * 落地，绝不超出 pin 编码（protocol-facts.ts 法则 3）。
 *
 * 法则（protocol-contract.ts，normative）：
 * 1. 适配器不是执行者 —— 本面无凭据、无账户、无路由、无授权参数（类型面上
 *    就没有）。
 * 2. 进站消息是不可信输入 —— 验证产物只是**不可信提案**（payload 摘要进证据
 *    链），永不成为 grant、授权或 provider 事实。
 * 3. 收据只从已验证执行/对账状态发出 —— evidence 缺席 = typed 拒绝
 *    （协议 accepted ≠ 结算）。
 * 4. pinning 强制 —— 描述符与注册表不一致即装配期失败（fail-loud）。
 *
 * 诚实边界（pin 内没说的就不做）：
 * - **不验签**：SD-JWT 签名验证需要签发者密钥材料（pin 未记载，也未交付）——
 *   本面验证**结构**（vct 精确匹配 + 字段闭集 + 条件规则），产物永远标注
 *   untrusted（载荷摘要仅供证据链）。
 * - **Payment Mandate 只到字段名集合**：pin 记录了字段枚举（payment_mandate.md
 *   首批），未记载逐字段类型/必填性 —— 本面验证 vct 精确匹配 + 字段名闭集，
 *   不发明类型断言。
 * - **未知约束 MUST 失败**（官方规范句）—— constraints 内未知约束名即拒绝。
 */

import { z } from "zod";
import { canonicalJsonStringify } from "../canonical-json.js";
import {
  type PayswapProtocolAdapter,
  type PayswapProtocolAdapterDescriptor,
  type PayswapProtocolInboundOutcome,
  type PayswapProtocolReceiptOutcome,
  type PayswapProtocolRefusal,
  evaluatePayswapProtocolAdapterRegistration,
} from "./protocol-contract.js";

// ---------------------------------------------------------------------------
// pinned 词汇（逐字照录 —— 新值 = 契约变更，需官方源再检索）
// ---------------------------------------------------------------------------

/** Mandate vct 精确匹配集（pin：「MUST match the exact `vct` string, including
 *  the version suffix」—— 后缀缺失/未知版本一律拒）。 */
export const PAYSWAP_AP2_VCT_VALUES = [
  "mandate.checkout.1",
  "mandate.checkout.open.1",
  "mandate.payment.1",
  "mandate.payment.open.1",
] as const;

export type PayswapAp2Vct = (typeof PAYSWAP_AP2_VCT_VALUES)[number];

/** Action Authorization 错误码（pin 四枚）与终态/回退分类（官方语义逐字）。 */
export const PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS = [
  { code: "invalid_credential", kind: "terminal" },
  { code: "unresolved_constraint", kind: "fallback-signal" },
  { code: "invalid_mandate", kind: "terminal" },
  { code: "mandates_not_supported", kind: "fallback-signal" },
] as const;

export type PayswapAp2ActionAuthorizationErrorCode =
  (typeof PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS)[number]["code"];

export function payswapAp2ActionAuthorizationErrorKind(
  code: string,
): "terminal" | "fallback-signal" | null {
  const entry = PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS.find((e) => e.code === code);
  return entry ? entry.kind : null;
}

/** Checkout Mandate 官方约束名闭集（open mandate 的 constraints 面）。 */
export const PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES = ["allowed_merchants", "line_items"] as const;

// ---------------------------------------------------------------------------
// zod schema（严格 —— pin 字段闭集；未知字段 = 未知形态 fail-closed）
// ---------------------------------------------------------------------------

const checkoutMandateClosedSchema = z
  .object({
    vct: z.literal("mandate.checkout.1"),
    /** merchant 签名的 base64url serialized Checkout payload JWT（pin 逐字）。 */
    checkout_jwt: z.string().min(1),
    /** checkout_jwt 的 base64url 哈希（_sd_alg 或 sha-256 —— 算法本身不在本面验证）。 */
    checkout_hash: z.string().min(1),
    iat: z.number().int().optional(),
    exp: z.number().int().optional(),
  })
  .strict();

/** open mandate 的约束 schema（pin：allowed_merchants 与 line_items 的子字段）。 */
const allowedMerchantsConstraintSchema = z
  .object({
    type: z.string().min(1),
    allowed: z.array(z.unknown()),
  })
  .strict();

const lineItemsConstraintSchema = z
  .object({
    type: z.string().min(1),
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          acceptable_items: z.array(z.unknown()),
          quantity: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

const checkoutConstraintSchema = z.union([
  allowedMerchantsConstraintSchema,
  lineItemsConstraintSchema,
]);

/** open checkout mandate：vct 精确 + constraints 内未知约束名即拒（官方规范句
 *  「Any unknown Constraints MUST be treated as failing evaluation」）。其余字段
 *  集官方未逐字段 pin —— pass-through 结构（每值 unknown），深度断言不发明。 */
const checkoutMandateOpenSchema = z
  .object({
    vct: z.literal("mandate.checkout.open.1"),
    constraints: z
      .object({
        allowed_merchants: allowedMerchantsConstraintSchema.optional(),
        line_items: lineItemsConstraintSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const raw = value as { constraints?: Record<string, unknown> };
    if (raw.constraints !== undefined) {
      for (const constraintName of Object.keys(raw.constraints)) {
        if (!(PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES as readonly string[]).includes(constraintName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["constraints", constraintName],
            message: `未知约束 '${constraintName}' —— 官方规范句：Any unknown Constraints MUST be treated as failing evaluation`,
          });
        }
      }
    }
  });

/** Payment Mandate：vct 精确 + pin 记录的字段名闭集（payment_mandate.md 首批
 *  枚举）—— 类型/必填性官方未 pin，不发明（字段值一律 unknown）。 */
const PAYSWAP_AP2_PAYMENT_MANDATE_FIELD_NAMES = [
  "_sd_alg",
  "allowed",
  "currency",
  "execution_date",
  "frequency",
  "max",
  "max_occurrences",
  "min",
  "not_after",
  "not_before",
  "payee",
  "payment_amount",
  "payment_instrument",
  "vct",
] as const;

const paymentMandateSchema = z
  .object({ vct: z.enum(["mandate.payment.1", "mandate.payment.open.1"]) })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const fieldName of Object.keys(value)) {
      if (!(PAYSWAP_AP2_PAYMENT_MANDATE_FIELD_NAMES as readonly string[]).includes(fieldName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [fieldName],
          message: `字段 '${fieldName}' 不在 pin 记录的 Payment Mandate 字段枚举 —— 未知形态 fail-closed`,
        });
      }
    }
  });

/** mandate 载荷分派（vct 精确匹配 —— 未知/缺后缀 vct = 未知形态）。 */
const mandatePayloadSchema = z.union([
  checkoutMandateClosedSchema,
  checkoutMandateOpenSchema,
  paymentMandateSchema,
]);

/** delegation 对象（agent_authorization.md，检索 2026-11-21 pin 逐字）。 */
const delegationObjectSchema = z
  .object({
    type: z.literal("delegate"),
    format: z.string().min(1),
    delegate_payload: z.array(z.unknown()).min(1),
    delegate_disclosures: z.array(z.unknown()).optional(),
  })
  .strict();

/** Mandate Receipt（checkout_mandate.md receipt schema + agent_authorization.md
 *  receipt 语义 —— 条件规则逐字：error/error_description 仅 Error；order_id 仅
 *  Success）。 */
const receiptSchema = z
  .object({
    status: z.enum(["Success", "Error"]),
    iss: z.string().min(1),
    iat: z.number().int(),
    reference: z.string().min(1),
    error: z.string().optional(),
    error_description: z.string().optional(),
    order_id: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "Error") {
      if (value.order_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["order_id"], message: "order_id 仅 Success 时在案（pin 逐字）" });
      }
      if (value.error === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "Error receipt 必须携带 error（pin 逐字：only when Error）" });
      }
    } else if (value.error !== undefined || value.error_description !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "error/error_description 仅 Error 时在案（pin 逐字）" });
    }
  });

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。 */
const inboundEnvelopeSchema = z
  .object({
    ap2Kind: z.enum(["mandate", "delegation", "receipt"]),
    payload: z.unknown(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 摘要（canonical JSON → SHA-256 → base64url —— 证据链绑定面）
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function payloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalJsonStringify(payload);
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64UrlEncode(new Uint8Array(digestBytes));
}

// ---------------------------------------------------------------------------
// 适配器工厂（注册门 + translateInbound + emitReceipt）
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

/**
 * 创建 AP2 消息面适配器（PayswapProtocolAdapter 的 AP2 实现）。描述符与注册表
 * 不一致 = 装配期 throw（法则 4 fail-loud —— 不存在「带警告创建」）。
 */
export function createPayswapAp2MessageFace(
  descriptor: PayswapProtocolAdapterDescriptor,
): PayswapProtocolAdapter {
  const registration = evaluatePayswapProtocolAdapterRegistration(descriptor);
  if (registration.kind === "refused") {
    throw new Error(
      `AP2 消息面装配被拒（${registration.refusal.code}）：${registration.refusal.message}`,
    );
  }

  return {
    descriptor,

    async translateInbound(untrustedMessage: unknown): Promise<PayswapProtocolInboundOutcome> {
      const envelope = inboundEnvelopeSchema.safeParse(untrustedMessage);
      if (!envelope.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `进站消息形态未知（ap2Kind 路由标签缺失/未知）—— fail-closed：${envelope.error.issues[0]?.message ?? "schema error"}`,
          ),
        };
      }
      const { ap2Kind, payload } = envelope.data;
      const schema =
        ap2Kind === "mandate"
          ? mandatePayloadSchema
          : ap2Kind === "delegation"
            ? delegationObjectSchema
            : receiptSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `AP2 ${ap2Kind} 消息未通过 pinned schema（未知 vct / 字段越集 / 条件规则违背 —— fail-closed）：${
              parsed.error.issues[0]?.message ?? "schema error"
            }`,
          ),
        };
      }
      // 法则 2：产物 = 不可信提案引用（载荷摘要进证据链；typed intent 随 P4）。
      return {
        kind: "verified-inbound",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        untrustedPayloadDigest: await payloadDigest(parsed.data),
      };
    },

    async emitReceipt(settlementEvidenceRef: string | null): Promise<PayswapProtocolReceiptOutcome> {
      // 法则 3：收据只从已验证执行/对账状态发出 —— 协议 accepted ≠ 结算。
      if (settlementEvidenceRef === null || settlementEvidenceRef.trim().length === 0) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_receipt_unavailable",
            "收据面被要求但执行/对账状态未验证到 —— 协议 accepted ≠ 结算（typed 拒绝）",
          ),
        };
      }
      return {
        kind: "receipt-emitted",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        settlementEvidenceRef,
      };
    },
  };
}
