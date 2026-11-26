/**
 * PaySwap P4 wave 4 —— money-movement intent 编译器（shared CONTRACT「P4 wave 4」
 * + doc 06 §2.4「NL financial intent compiler」+ doc 05 §9 版本化工具面演化的
 * 实现半；broker `check_eligibility` 接线随 wave-4 PR(b)）。
 *
 * 法则（normative；违反即实现缺陷）—— 全文见 shared CONTRACT；此处只列实现要点：
 * 1. **draft-vs-evidence 分离**：物质字段缺失（kind/amount/currency/recipientId/
 *    senderConnectionId/purpose）→ `{kind:"clarification"}` 逐字段请求；证据缺席
 *    （sender 记录 / verified-recipient 证据）→ typed 拒绝 —— 二者永不混用
 *    （材料缺口操作者可补，证据缺口只能由 provider 证据补）。
 * 2. **typed 拒绝闭集（七枚）**：intent_recipient_unverified / intent_sender_
 *    evidence_unavailable / intent_amount_invalid / intent_currency_invalid /
 *    intent_kind_unknown / intent_rail_unsupported / intent_operation_unsupported。
 *    拒绝消息零凭据材料。kind 的闭集成员资格是语义检查（wire 面不 enum-gate），
 *    闭集外 kind 走 intent_kind_unknown 而非 shape 拒绝。
 * 3. **evidence, never claims**：intentId 由 host 分配（UUIDv7 —— 编译器不产 id
 *    就不产 intent，畸形 id = 装配错误）；principal 来自 broker 已解析的会话
 *    （模型陈述永不是 principal）；rail/operation 只从 sender 能力记录的证据
 *    裁决 —— 用户 rail 偏好与显式 operation 提名永不压过 provider 证据。
 * 4. **确定性映射 v1（TL 决定 2026-11-26）**：send/collect → collections.read；
 *    sweep → payouts.read；refund → payment_objects.read；convert/review 无已证
 *    read-half 操作 → clarification（除非 v2 `operation` 显式提名，提名值必须有
 *    sender 证据）。映射出的操作与提名操作同样必须在记录内有证据
 *    （intent_operation_unsupported）—— intent 永不编译成注定不可证的 query。
 * 5. **无权威外溢**：不铸造 grant、不路由（P5）、不提交（P7）、不写 ledger（P7
 *    证据账本切片接手持久化）；intent/clarification/eligibility 任何答案都不是
 *    授权（doc 12 §2.2）。recipient acceptance 与 draft rail 的相容性对账随 P5
 *    route discovery（本编译器只对齐 sender 证据 + 物质字段 —— 边界如实记录）。
 *
 * 纯确定性：无 IO、无凭据、无 runtime（doc 06 §1.1 domain 1）。draft 形状违规
 * （zod）、畸形 intentId/principal/now = 装配错误 → 抛出（wire 形状违规在 PR(b)
 * 的 per-op params schema 层已先拒 —— §6.1(4) pre-binding）。
 */

import { z } from "zod";
import {
  payswapIsoDateTimeSchema,
  payswapMoneyNonNegativeSchema,
  payswapMoneyValueRegex,
  payswapPartyEvidenceFreshness,
  payswapPaymentRailRefSchema,
  payswapPurposeCodeSchema,
  payswapSenderAccountRefSchema,
  type PayswapClarificationRequest,
  type PayswapVerifiedRecipientEvidence,
} from "@zcode/shared/payswap";
// P4 wave 4 PR(b)：clarification 行类型迁住 shared（operations.ts wire 单一事实源）——
// 本模块 re-export 保持 PR(a) 导出面不变。
export type { PayswapClarificationRequest } from "@zcode/shared/payswap";
import type { PayswapCapabilityRecord } from "../capability/capabilityRegistry.js";
import {
  payswapEligibilityQuerySchema,
  type PayswapEligibilityQuery,
} from "../eligibility/eligibilityEngine.js";

// ---------------------------------------------------------------------------
// kind 闭集 + 确定性 kind→§6.1 操作映射表 v1（TL 决定 2026-11-26 —— 版本化，
// 演化只增行不改行；null = 无已证 read-half 操作）
// ---------------------------------------------------------------------------

export const PAYSWAP_INTENT_KINDS = [
  "send",
  "collect",
  "refund",
  "convert",
  "sweep",
  "review",
] as const;
export type PayswapIntentKind = (typeof PAYSWAP_INTENT_KINDS)[number];

export const PAYSWAP_INTENT_OPERATION_MAP: Readonly<Record<PayswapIntentKind, string | null>> = {
  send: "collections.read",
  collect: "collections.read",
  sweep: "payouts.read",
  refund: "payment_objects.read",
  convert: null,
  review: null,
};

// ---------------------------------------------------------------------------
// typed 拒绝闭集（七枚 —— 闭集，不扩）
// ---------------------------------------------------------------------------

export const PAYSWAP_INTENT_REFUSAL_CODES = [
  "intent_recipient_unverified",
  "intent_sender_evidence_unavailable",
  "intent_amount_invalid",
  "intent_currency_invalid",
  "intent_kind_unknown",
  "intent_rail_unsupported",
  "intent_operation_unsupported",
] as const;
export type PayswapIntentRefusalCode = (typeof PAYSWAP_INTENT_REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// draft（compile_intent params v2 的编译器侧形状 —— PR(b) 在 operations.ts 落
// wire schema；结构性字段（rail/purpose/maxTotalCost/deadline/privacy/数值）在
// wire 层已 gate，此处 zod 失败 = 装配错误。kind/amount/currency 是语义检查面
// —— schema 保持宽（string），闭集/Money 字形在编译逻辑里出 typed 拒绝）
// ---------------------------------------------------------------------------

export const payswapIntentDraftSchema = z
  .object({
    description: z.string().min(1),
    kind: z.string().optional(),
    amount: z.string().optional(),
    currency: z.string().optional(),
    senderConnectionId: z.string().optional(),
    recipientId: z.string().optional(),
    rail: payswapPaymentRailRefSchema.optional(),
    operation: z.string().min(1).optional(),
    purpose: payswapPurposeCodeSchema.optional(),
    deadline: payswapIsoDateTimeSchema.optional(),
    maxTotalCost: payswapMoneyNonNegativeSchema.optional(),
    privacy: z.enum(["standard", "minimize_disclosure"]).optional(),
    allowPartial: z.boolean().optional(),
    fxToleranceBps: z.number().int().nonnegative().optional(),
    minimumReliability: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PayswapIntentDraft = z.infer<typeof payswapIntentDraftSchema>;

// ---------------------------------------------------------------------------
// intent 形状（doc 06 §2.1 FinancialIntent 的 P4 子集；不可变 —— registry 冻结）
// ---------------------------------------------------------------------------

/** host 分配的 UUIDv7（编译器不产 id；畸形 = 装配错误）。 */
const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const payswapFinancialIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** 注册表分配的声明序号（compile 产出占位 1 —— declare 覆写为权威值）。 */
    revision: z.number().int().positive(),
    intentId: z.string().regex(UUIDV7_REGEX, "intentId must be a host-allocated UUIDv7"),
    createdAt: payswapIsoDateTimeSchema,
    principalId: z.string().min(1),
    kind: z.enum(PAYSWAP_INTENT_KINDS),
    amount: payswapMoneyNonNegativeSchema,
    purpose: payswapPurposeCodeSchema,
    sender: payswapSenderAccountRefSchema,
    recipient: z
      .object({
        kind: z.literal("verified-recipient-ref"),
        recipientId: z.string().min(1),
        evidenceRef: z.string().min(1),
        verifiedAt: payswapIsoDateTimeSchema,
      })
      .strict(),
    operation: z.string().min(1),
    rail: payswapPaymentRailRefSchema.optional(),
    deadline: payswapIsoDateTimeSchema.optional(),
    maxTotalCost: payswapMoneyNonNegativeSchema.optional(),
    privacy: z.enum(["standard", "minimize_disclosure"]),
    allowPartial: z.boolean().optional(),
    fxToleranceBps: z.number().int().nonnegative().optional(),
    minimumReliability: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PayswapFinancialIntent = z.infer<typeof payswapFinancialIntentSchema>;

export type PayswapIntentCompileOutcome =
  | {
      readonly kind: "intent";
      readonly intent: PayswapFinancialIntent;
      readonly eligibilityQuery: PayswapEligibilityQuery;
    }
  | { readonly kind: "clarification"; readonly requests: readonly PayswapClarificationRequest[] }
  | {
      readonly kind: "refused";
      readonly refused: { readonly code: PayswapIntentRefusalCode; readonly message: string };
    };

export interface PayswapIntentCompileInput {
  readonly draft: PayswapIntentDraft;
  /** host 分配的 UUIDv7（编译器不产 id —— 无 host id 就不产 intent）。 */
  readonly intentId: string;
  /** broker 已解析的会话 principal（模型陈述永不是 principal）。 */
  readonly principalId: string;
  /** wave 1 注册表的最新能力记录；null = sender 证据缺席（typed 拒绝）。 */
  readonly senderCapabilityRecord: PayswapCapabilityRecord | null;
  /** wave 3 的 verified-recipient 证据；null / stale = 接收方证据缺席（typed 拒绝）。 */
  readonly recipientEvidence: PayswapVerifiedRecipientEvidence | null;
  readonly now: string;
}

// ---------------------------------------------------------------------------
// 深冻结（intent 与派生 query 都不可变 —— frozen views，wave 1 同款）
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object") deepFreeze(child);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// 编译（纯函数；三值 union）
// ---------------------------------------------------------------------------

function refused(code: PayswapIntentRefusalCode, message: string): PayswapIntentCompileOutcome {
  return { kind: "refused", refused: { code, message } };
}

export function compilePayswapIntent(input: PayswapIntentCompileInput): PayswapIntentCompileOutcome {
  // 装配防线（先于一切语义）：draft 形状、host id、principal、时间源。
  const draftParse = payswapIntentDraftSchema.safeParse(input.draft);
  if (!draftParse.success) {
    throw new Error(`intent draft violates the draft schema (wire params gate rides PR(b) operations.ts): ${draftParse.error.message}`);
  }
  const draft = draftParse.data;
  if (!UUIDV7_REGEX.test(input.intentId)) {
    throw new Error("compilePayswapIntent requires a host-allocated UUIDv7 intentId (the compiler never mints ids)");
  }
  if (input.principalId.trim().length === 0) {
    throw new Error("compilePayswapIntent requires a non-empty broker-resolved principalId (model statements are never principals)");
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new Error("compilePayswapIntent requires an ISO-8601 parseable `now` (single time source, injected)");
  }

  // 证据缺席先于一切材料缺口（clarification 永不与 typed 拒绝混用）。
  const record = input.senderCapabilityRecord;
  if (record === null) {
    return refused(
      "intent_sender_evidence_unavailable",
      `No capability record exists for the sender connection; the intent cannot be compiled against claims alone (evidence, never claims — doc 12 §3).`,
    );
  }

  const kindPresent = draft.kind !== undefined && draft.kind.trim().length > 0;
  if (kindPresent && !PAYSWAP_INTENT_KINDS.includes(draft.kind!.trim() as PayswapIntentKind)) {
    return refused(
      "intent_kind_unknown",
      `Intent kind '${draft.kind}' is outside the closed kind set (${PAYSWAP_INTENT_KINDS.join(", ")}); refusing rather than guessing.`,
    );
  }

  // 物质字段缺口 → clarification（逐字段、固定序；deadline 畸形按可由操作者
  // 修复的材料缺口处理 —— 拒绝闭集七枚没有 deadline 位，不发明）。
  const requests: PayswapClarificationRequest[] = [];
  if (!kindPresent) {
    requests.push({ field: "kind", reason: "the intent kind is required (closed set: send, collect, refund, convert, sweep, review)" });
  }
  if (draft.amount === undefined || draft.amount.trim().length === 0) {
    requests.push({ field: "amount", reason: "the intent amount is required (decimal string Money value)" });
  }
  if (draft.currency === undefined || draft.currency.trim().length === 0) {
    requests.push({ field: "currency", reason: "the intent currency is required (ISO-4217 uppercase three-letter code)" });
  }
  if (draft.recipientId === undefined || draft.recipientId.trim().length === 0) {
    requests.push({ field: "recipientId", reason: "the recipientId is required and must resolve to verified-recipient evidence" });
  }
  if (draft.senderConnectionId === undefined || draft.senderConnectionId.trim().length === 0) {
    requests.push({ field: "senderConnectionId", reason: "the sender connectionId is required (the intent compiles against one connected account's evidence)" });
  }
  if (draft.purpose === undefined) {
    requests.push({ field: "purpose", reason: "the purpose code is required (closed PurposeCode set; free text never substitutes the code)" });
  }
  if (requests.length > 0) {
    return { kind: "clarification", requests };
  }

  const kind = kindOf(draft.kind!) as PayswapIntentKind;
  const amount = draft.amount!;
  const currency = draft.currency!;
  const recipientId = draft.recipientId!;
  const senderConnectionId = draft.senderConnectionId!;
  const purpose = draft.purpose!;

  // 接收方证据：缺席 / 不再新鲜 → typed 拒绝（stale 证据在编译时刻不再是
  // verified 证据 —— 保守序，不乐观）。
  const evidence = input.recipientEvidence;
  if (evidence === null || evidence.recipientId !== recipientId) {
    return refused(
      "intent_recipient_unverified",
      `recipientId '${recipientId}' has no verified-recipient evidence; user or model claims alone are insufficient (doc 12 §3).`,
    );
  }
  if (payswapPartyEvidenceFreshness(
    { verifiedAt: evidence.identity.verifiedAt, freshnessBoundMs: evidence.freshnessBoundMs },
    input.now,
  ) === "stale") {
    return refused(
      "intent_recipient_unverified",
      `The verified-recipient evidence for '${recipientId}' (verifiedAt ${evidence.identity.verifiedAt}, bound ${evidence.freshnessBoundMs} ms) is stale at ${input.now}; refresh the recipient evidence and retry.`,
    );
  }

  // Money 字形（decimal string，永不 float；intent 金额非负 —— 负号语义在
  // intent kind，不在 Money）。
  if (!payswapMoneyValueRegex.test(amount) || amount.startsWith("-")) {
    return refused(
      "intent_amount_invalid",
      `amount '${amount}' is not a non-negative decimal string Money value (no exponent, no separators, no floats — doc 04 §2.5).`,
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return refused(
      "intent_currency_invalid",
      `currency '${currency}' is not an ISO-4217 uppercase three-letter code.`,
    );
  }

  // sender 连接必须就是证据记录的连接（记录不迁移、不张冠李戴）。
  if (record.connectionId !== senderConnectionId) {
    return refused(
      "intent_sender_evidence_unavailable",
      `The capability record evidences connection '${record.connectionId}', not '${senderConnectionId}'; the intent compiles against the evidence of exactly one connected account.`,
    );
  }

  // 有效操作：v2 显式提名优先，否则 kind→operation 映射表 v1；convert/review
  // 无映射 → clarification（除非提名）。有效操作必须在 sender 记录内有证据。
  const nominatedRaw = draft.operation?.trim();
  const nominated = nominatedRaw !== undefined && nominatedRaw.length > 0 ? nominatedRaw : undefined;
  const mapped = PAYSWAP_INTENT_OPERATION_MAP[kind];
  const effectiveOperation = nominated ?? mapped;
  if (effectiveOperation === null || effectiveOperation === undefined || effectiveOperation.length === 0) {
    return {
      kind: "clarification",
      requests: [
        {
          field: "operation",
          reason: `kind '${draft.kind}' has no evidenced read-half operation in the versioned mapping v1; nominate the operation explicitly via the optional 'operation' param (it must be evidenced by the sender's capability record)`,
        },
      ],
    };
  }
  const operationEvidence = record.operations.find((op) => op.operation === effectiveOperation);
  if (operationEvidence === undefined) {
    return refused(
      "intent_operation_unsupported",
      nominated !== undefined
        ? `Nominated operation '${effectiveOperation}' is not evidenced by the sender capability record for connection '${record.connectionId}' (unknown = unsupported; user nominations never override provider evidence).`
        : `kind '${draft.kind}' maps to operation '${effectiveOperation}' (mapping v1), which is not evidenced by the sender capability record for connection '${record.connectionId}' (unknown = unsupported).`,
    );
  }

  // rail 偏好永不压过 provider 证据：rail 仅当有效操作的结构化 method 证据
  // （allow 含 rail class，deny 未命中）支持时可用；无 method 证据 = 不支持。
  let rail = draft.rail;
  if (rail !== undefined) {
    const methodRestrictions = operationEvidence.restrictions.filter((r) => r.kind === "method");
    const denied = methodRestrictions.some((r) => Array.isArray(r.deny) && r.deny.includes(rail.class));
    const allowed = methodRestrictions.some((r) => Array.isArray(r.allow) && r.allow.includes(rail.class));
    if (denied || !allowed) {
      return refused(
        "intent_rail_unsupported",
        `rail '${rail.class}' is not evidenced by the sender capability record for operation '${effectiveOperation}' (no structured method evidence allows it${denied ? "; a provider deny explicitly blocks it" : ""}); user rail preferences never override provider evidence.`,
      );
    }
  }

  const sender = payswapSenderAccountRefSchema.parse({
    kind: "connected-account",
    principalId: input.principalId,
    connectionId: draft.senderConnectionId,
    providerId: record.providerId,
    capabilityRevision: record.revision,
  });
  const intent = deepFreeze(
    payswapFinancialIntentSchema.parse({
      schemaVersion: 1,
      revision: 1, // 占位 —— intentRegistry.declare 分配权威 revision（wave 1 推导面同款纪律）
      intentId: input.intentId,
      createdAt: input.now,
      principalId: input.principalId,
      kind,
      amount: { value: amount, currency },
      purpose,
      sender,
      recipient: {
        kind: "verified-recipient-ref",
        recipientId: evidence.recipientId,
        evidenceRef: evidence.identity.evidenceRef,
        verifiedAt: evidence.identity.verifiedAt,
      },
      operation: effectiveOperation,
      ...(rail !== undefined ? { rail } : {}),
      ...(draft.deadline !== undefined ? { deadline: draft.deadline } : {}),
      ...(draft.maxTotalCost !== undefined ? { maxTotalCost: draft.maxTotalCost } : {}),
      privacy: draft.privacy ?? "standard",
      ...(draft.allowPartial !== undefined ? { allowPartial: draft.allowPartial } : {}),
      ...(draft.fxToleranceBps !== undefined ? { fxToleranceBps: draft.fxToleranceBps } : {}),
      ...(draft.minimumReliability !== undefined ? { minimumReliability: draft.minimumReliability } : {}),
    }),
  );

  // eligibilityQuery 派生（check_eligibility 的 intentId 解析目标 —— PR #98
  // 缺口闭合）。amount 不进 constraints：币种最小单位指数无确定性事实源，
  // 换算即发明（如实记录）；purpose/recipientKind 是证据-backed 维度。
  const eligibilityQuery = deepFreeze(
    payswapEligibilityQuerySchema.parse({
      operation: effectiveOperation,
      connectionId: senderConnectionId,
      constraints: {
        currency,
        purpose: purpose.code,
        recipientKind: "verified-recipient",
      },
    }),
  );

  return { kind: "intent", intent, eligibilityQuery };
}

/** trim 后的 kind 闭集成员（空串在物质缺口阶段已被 clarification 拦截）。 */
function kindOf(kind: string): PayswapIntentKind | undefined {
  const trimmed = kind.trim();
  return (PAYSWAP_INTENT_KINDS as readonly string[]).includes(trimmed) ? (trimmed as PayswapIntentKind) : undefined;
}
