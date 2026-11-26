/**
 * PaySwap P4 wave 3 —— 支付参与方能力证据（shared CONTRACT「P4 支付参与方能力证据」
 * + doc 12 §3「payment capability graph」+ doc 06 §2.1 合同形状 + P4 验收
 * 「sender and recipient identities and payment capabilities are evidence-backed and
 * separately scoped」/「participant descriptors are limited to financial role,
 * verified payment capability, authority and availability」的实现半）。
 *
 * 法则（normative；违反即实现缺陷）—— 全文见 shared CONTRACT；此处只列实现要点：
 * 1. **三族证据分立**：发送方 = wave 1 能力记录的只读引用（本模块不重建能力记录）；
 *    接收方/参与方 = 本模块 schema。三族互不充当对方证据；wave 1 记录不可变换为
 *    参与方记录（电池持有结构断言）。
 * 2. **verified-recipient**：记录必须携带证据三元组（evidenceRef + source +
 *    verifiedAt）—— 用户/模型声明单独在场不可成记录（superRefine/必填字段）。
 * 3. **participant**：恰含 financialRole（闭集，sender/recipient 被排除）、
 *    verifiedCapability、authority、availability；name/reputation/rating/listing
 *    等 marketplace 字段 strict 拒绝；能力永不从名字/列表推断。
 * 4. **Money = decimal string，永不 float**（doc 04 §2.5）；rail/purpose 闭集；
 *    purpose freeText 永不参与裁决（wave 4 编译器只消费 code）。
 * 5. **无权威外溢**：无 grant/mint/submit/route/ledger 面，无凭据字段（结构断言）；
 *    参与方记录被列出/被引用不产生任何权限（权限只在 P7 host 授权）。
 *
 * 纯类型 + zod schema + 纯函数：无 IO、无凭据、无 runtime（doc 06 §1.1 domain 1）。
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 共用字形：ISO 时刻字符串
// ---------------------------------------------------------------------------

export const payswapIsoDateTimeSchema = z
  .string()
  .min(1)
  .refine((s) => Number.isFinite(Date.parse(s)), {
    message: "must be an ISO-8601 parseable timestamp",
  });

// ---------------------------------------------------------------------------
// Money（doc 06 §2.1：decimal string，永不 float；ISO-4217 大写三位）
// ---------------------------------------------------------------------------

export const payswapMoneyValueRegex = /^-?\d+(\.\d+)?$/;

export const payswapMoneySchema = z
  .object({
    value: z.string().regex(payswapMoneyValueRegex, "decimal string only (no exponent, no separators, no floats)"),
    currency: z.string().regex(/^[A-Z]{3}$/, "ISO-4217 uppercase three-letter code"),
  })
  .strict();
export type PayswapMoney = z.infer<typeof payswapMoneySchema>;

/** intent 金额与 maxTotalCost 用 —— 负号语义在 intent kind，不在 Money。 */
export const payswapMoneyNonNegativeSchema = payswapMoneySchema.refine(
  (money) => !money.value.startsWith("-"),
  { message: "money value must be non-negative" },
);
export type PayswapMoneyNonNegative = z.infer<typeof payswapMoneyNonNegativeSchema>;

// ---------------------------------------------------------------------------
// 支付 rail 引用（类别闭集 + 可选 provider 命名空间 detail；blockchain 必须带
// 命名空间 detail —— addendum §13 边界的 schema 层投影）
// ---------------------------------------------------------------------------

export const PAYSWAP_PAYMENT_RAIL_CLASSES = [
  "card",
  "bank",
  "mobile_money",
  "wallet",
  "cash",
  "psp_internal",
  "blockchain",
] as const;
export type PayswapPaymentRailClass = (typeof PAYSWAP_PAYMENT_RAIL_CLASSES)[number];

export const payswapPaymentRailRefSchema = z
  .object({
    class: z.enum(PAYSWAP_PAYMENT_RAIL_CLASSES),
    detail: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((rail, ctx) => {
    if (rail.class === "blockchain" && (rail.detail === undefined || rail.detail.trim().length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["detail"],
        message: "a blockchain rail reference must carry a namespaced detail (addendum §13 boundary)",
      });
    }
  });
export type PayswapPaymentRailRef = z.infer<typeof payswapPaymentRailRefSchema>;

// ---------------------------------------------------------------------------
// 证据三元组（record 级 required —— 用户/模型声明单独在场不可成记录）
// ---------------------------------------------------------------------------

export const PAYSWAP_PARTY_EVIDENCE_SOURCES = [
  "provider-read-back",
  "verified-recipient-registry",
  "participant-account-evidence",
] as const;
export type PayswapPartyEvidenceSource = (typeof PAYSWAP_PARTY_EVIDENCE_SOURCES)[number];

export const payswapPartyEvidenceTripleSchema = z
  .object({
    evidenceRef: z.string().min(1),
    source: z.enum(PAYSWAP_PARTY_EVIDENCE_SOURCES),
    verifiedAt: payswapIsoDateTimeSchema,
  })
  .strict();
export type PayswapPartyEvidenceTriple = z.infer<typeof payswapPartyEvidenceTripleSchema>;

// ---------------------------------------------------------------------------
// 发送方面：wave 1 能力记录的只读引用（本模块不重建能力记录）
// ---------------------------------------------------------------------------

export const payswapSenderAccountRefSchema = z
  .object({
    kind: z.literal("connected-account"),
    principalId: z.string().min(1),
    connectionId: z.string().min(1),
    providerId: z.string().min(1),
    capabilityRevision: z.number().int().positive(),
  })
  .strict();
export type PayswapSenderAccountRef = z.infer<typeof payswapSenderAccountRefSchema>;

// ---------------------------------------------------------------------------
// 接收方面：verified-recipient 证据（doc 12 §3 接收方行 —— verified identity +
// 可接受的支付指令，全部从 provider/verified-recipient 边界产出）
// ---------------------------------------------------------------------------

export const payswapRecipientAcceptanceSchema = z
  .object({
    rail: payswapPaymentRailRefSchema,
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    amountBounds: z
      .object({
        min: z.string().regex(payswapMoneyValueRegex).optional(),
        max: z.string().regex(payswapMoneyValueRegex).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PayswapRecipientAcceptance = z.infer<typeof payswapRecipientAcceptanceSchema>;

export const payswapVerifiedRecipientEvidenceSchema = z
  .object({
    kind: z.literal("verified-recipient"),
    recipientId: z.string().min(1),
    identity: z
      .object({
        displayName: z.string().min(1).max(200).optional(),
        evidenceRef: z.string().min(1),
        source: z.enum(PAYSWAP_PARTY_EVIDENCE_SOURCES),
        verifiedAt: payswapIsoDateTimeSchema,
      })
      .strict(),
    acceptances: z.array(payswapRecipientAcceptanceSchema).min(1),
    freshnessBoundMs: z.number().int().positive(),
  })
  .strict();
export type PayswapVerifiedRecipientEvidence = z.infer<typeof payswapVerifiedRecipientEvidenceSchema>;

// ---------------------------------------------------------------------------
// 参与方面：participant 能力证据（恰四类字段；marketplace 字段 strict 拒绝）
// ---------------------------------------------------------------------------

export const PAYSWAP_PARTICIPANT_FINANCIAL_ROLES = [
  "rail_bridge",
  "settlement_participant",
] as const;
export type PayswapParticipantFinancialRole = (typeof PAYSWAP_PARTICIPANT_FINANCIAL_ROLES)[number];

export const payswapParticipantAuthoritySchema = z
  .object({
    scope: z.literal("route-legs"),
    legIds: z.array(z.string().min(1)).optional(),
    maxAmount: payswapMoneyNonNegativeSchema.optional(),
  })
  .strict();
export type PayswapParticipantAuthority = z.infer<typeof payswapParticipantAuthoritySchema>;

export const payswapParticipantAvailabilitySchema = z
  .object({
    status: z.enum(["available", "unavailable"]),
    evidenceRef: z.string().min(1),
    observedAt: payswapIsoDateTimeSchema,
  })
  .strict();
export type PayswapParticipantAvailability = z.infer<typeof payswapParticipantAvailabilitySchema>;

export const payswapParticipantCapabilityEvidenceSchema = z
  .object({
    kind: z.literal("participant-capability"),
    participantId: z.string().min(1),
    financialRole: z.enum(PAYSWAP_PARTICIPANT_FINANCIAL_ROLES),
    verifiedCapability: z
      .object({
        evidenceRef: z.string().min(1),
        source: z.enum(PAYSWAP_PARTY_EVIDENCE_SOURCES),
        verifiedAt: payswapIsoDateTimeSchema,
        providerId: z.string().min(1).optional(),
        connectionId: z.string().min(1).optional(),
      })
      .strict(),
    authority: payswapParticipantAuthoritySchema,
    availability: payswapParticipantAvailabilitySchema,
    freshnessBoundMs: z.number().int().positive(),
  })
  .strict();
export type PayswapParticipantCapabilityEvidence = z.infer<typeof payswapParticipantCapabilityEvidenceSchema>;

// ---------------------------------------------------------------------------
// purpose（闭集 code + 可选 free text；裁决只看 code —— wave 4 编译器/约束裁决消费）
// ---------------------------------------------------------------------------

export const PAYSWAP_PURPOSE_CODES = [
  "family_support",
  "business_payment",
  "payroll",
  "tax",
  "education",
  "medical",
  "supplier_payment",
  "other",
] as const;
export type PayswapPurposeCode = (typeof PAYSWAP_PURPOSE_CODES)[number];

export const payswapPurposeCodeSchema = z
  .object({
    code: z.enum(PAYSWAP_PURPOSE_CODES),
    freeText: z.string().min(1).max(500).optional(),
  })
  .strict();
export type PayswapPurpose = z.infer<typeof payswapPurposeCodeSchema>;

// ---------------------------------------------------------------------------
// 新鲜度（纯函数 —— 与 eligibility 的 stale 纪律同构；malformed 输入 = stale，
// 永不抛错、永不乐观）
// ---------------------------------------------------------------------------

export type PayswapPartyEvidenceFreshness = "fresh" | "stale";

export function payswapPartyEvidenceFreshness(
  evidence: { readonly verifiedAt?: string; readonly observedAt?: string; readonly freshnessBoundMs: number },
  now: string,
): PayswapPartyEvidenceFreshness {
  const observed = evidence.verifiedAt ?? evidence.observedAt;
  const observedMs = observed === undefined ? Number.NaN : Date.parse(observed);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return "stale";
  return nowMs - observedMs <= evidence.freshnessBoundMs ? "fresh" : "stale";
}
