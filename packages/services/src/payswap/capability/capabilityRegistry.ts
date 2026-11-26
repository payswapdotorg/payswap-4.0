/**
 * PaySwap P4 wave 1 —— evidence-backed provider capability registry（shared
 * CONTRACT「P4 provider capability registry」+ doc 05 §4 + doc 12 §3 的实现）。
 *
 * 法则（normative；违反即实现缺陷）—— 全文见 shared CONTRACT；此处只列实现要点：
 * 1. **纯确定性**：本模块无 IO、无凭据、无 runtime —— 从「读回结局 + 概览类别
 *    结果」推导不可变能力记录的纯函数 + 一个进程内不可变注册表。
 * 2. **evidence, never claims**：操作状态只从 provider 证据推导；固定表只有
 *    capability 名 → 操作 id 的词汇映射（映射 provider 自己读回的名字）；
 *    读回未提及的操作不进记录的 enabled 集；静态知识只进 restrictions.note。
 * 3. **保守序**：两半证据冲突时低值胜（unavailable < restricted < pending <
 *    available < enabled）—— optimistic defaults 禁令。
 * 4. **typed 缺口**：capabilityGap/identityGap 在场 ⇒ 全部操作 unavailable 且
 *    reason = 缺口 message（provider 级事实压过类别读证据）。
 * 5. **不可变 + revision**：新证据 ⇒ 新记录；registry 保留历史；frozen views；
 *    stale 声明拒绝。
 * 6. **无权威外溢**：不铸造 grant、不路由、不触 provider、不写 ledger —— 只读
 *    证据面（结构断言由电池持有）。
 */

import { z } from "zod";
import {
  PAYSWAP_ACCOUNT_IDENTITY_GAP_CODE,
  PAYSWAP_READONLY_CATEGORIES,
  type PayswapAccountCapabilityEvidence,
  type PayswapAccountReadBackOutcome,
  type PayswapReadonlyCategory,
  type PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";

// ---------------------------------------------------------------------------
// 记录 schema（doc 05 §4 形状；strict）
// ---------------------------------------------------------------------------

export const PAYSWAP_CAPABILITY_OPERATION_STATUSES = [
  "enabled",
  "available",
  "pending",
  "restricted",
  "unavailable",
] as const;
export type PayswapCapabilityOperationStatus = (typeof PAYSWAP_CAPABILITY_OPERATION_STATUSES)[number];

export const PAYSWAP_CAPABILITY_RESTRICTION_KINDS = [
  "country",
  "currency",
  "method",
  "chain",
  "token",
  "wallet",
  "destination",
  "contractOperation",
  "feeCap",
  "finality",
  "amount",
  "product",
  "entitlement",
  "purpose",
  "rate-limit",
  "other",
] as const;
export type PayswapCapabilityRestrictionKind = (typeof PAYSWAP_CAPABILITY_RESTRICTION_KINDS)[number];

export const payswapCapabilityRestrictionSchema = z
  .object({
    kind: z.enum(PAYSWAP_CAPABILITY_RESTRICTION_KINDS),
    note: z.string().min(1).optional(),
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
    min: z.string().regex(/^-?\d+$/).optional(),
    max: z.string().regex(/^-?\d+$/).optional(),
  })
  .strict();
export type PayswapCapabilityRestriction = z.infer<typeof payswapCapabilityRestrictionSchema>;

export const payswapOperationCapabilitySchema = z
  .object({
    operation: z.string().min(1),
    status: z.enum(PAYSWAP_CAPABILITY_OPERATION_STATUSES),
    restrictions: z.array(payswapCapabilityRestrictionSchema),
  })
  .strict();
export type PayswapOperationCapability = z.infer<typeof payswapOperationCapabilitySchema>;

export const payswapCapabilityRecordSchema = z
  .object({
    providerId: z.string().min(1),
    connectionId: z.string().min(1),
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    declaredAt: z.string().min(1),
    /** 产出的原始读回引用（进程内引用；ledger seq 落账随 P7 证据账本切片）。 */
    evidence: z
      .object({
        kind: z.literal("read-back"),
        outcomeKind: z.enum(["verified"]),
        providerAccountId: z.string().min(1).nullable(),
        hasCapabilityEvidence: z.boolean(),
      })
      .strict(),
    operations: z.array(payswapOperationCapabilitySchema).min(1),
  })
  .strict();
export type PayswapCapabilityRecord = z.infer<typeof payswapCapabilityRecordSchema>;

// ---------------------------------------------------------------------------
// 固定词汇表（唯一允许的固定表 —— 映射 provider 自己读回的 capability 名）
// ---------------------------------------------------------------------------

export const PAYSWAP_CAPABILITY_OPERATION_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  card_payments: ["collections.read", "payment_objects.read"],
  transfers: ["transfers.read"],
  payouts: ["payouts.read"],
};

/** 类别 → 只读操作（类别读本身就是该操作真实执行过一次的证据）。 */
const CATEGORY_OPERATION: Readonly<Record<PayswapReadonlyCategory, string>> = {
  balance: "balances.read",
  payment_objects: "payment_objects.read",
  customers: "customers.read",
  disputes: "disputes.read",
};

// ---------------------------------------------------------------------------
// 保守序（两半证据冲突时低值胜 —— optimistic defaults 禁令）
// ---------------------------------------------------------------------------

const CONSERVATIVE_ORDER: Readonly<Record<PayswapCapabilityOperationStatus, number>> = {
  unavailable: 0,
  restricted: 1,
  pending: 2,
  available: 3,
  enabled: 4,
};

function conservativeMin(a: PayswapCapabilityOperationStatus, b: PayswapCapabilityOperationStatus): PayswapCapabilityOperationStatus {
  return CONSERVATIVE_ORDER[a] <= CONSERVATIVE_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// 证据推导（纯函数）
// ---------------------------------------------------------------------------

export interface PayswapCapabilityDerivationInput {
  readonly providerId: string;
  readonly connectionId: string;
  readonly outcome: PayswapAccountReadBackOutcome;
  /** 概览四类别结果（P3 getOverviewData 的 data 半；auth-failed/unavailable 读回时缺席）。 */
  readonly data?: Readonly<Record<PayswapReadonlyCategory, PayswapReadonlyCategoryResult>>;
  readonly now: string;
}

/** 类别结果 → 状态 + restriction（category-evidence law）。 */
function fromCategoryResult(result: PayswapReadonlyCategoryResult): {
  status: PayswapCapabilityOperationStatus;
  restrictions: PayswapCapabilityRestriction[];
} {
  switch (result.status) {
    case "ok":
      return { status: "available", restrictions: [] };
    case "refused": {
      if (result.refusal.code === "insufficient_permission") {
        return {
          status: "restricted",
          restrictions: [
            { kind: "entitlement", note: `provider permission boundary: ${result.refusal.message}` },
          ],
        };
      }
      return {
        status: "unavailable",
        restrictions: [{ kind: "other", note: `provider absence: ${result.refusal.message}` }],
      };
    }
    case "auth-failed":
      return { status: "unavailable", restrictions: [] };
    case "unavailable":
      return { status: "unavailable", restrictions: [] };
  }
}

function requirementsRestrictions(evidence: PayswapAccountCapabilityEvidence): PayswapCapabilityRestriction[] {
  if (evidence.requirements === null) return [];
  const { disabledReason, currentlyDueCount, pastDueCount } = evidence.requirements;
  const parts: string[] = [
    `currently_due=${currentlyDueCount}`,
    `past_due=${pastDueCount}`,
    disabledReason === null ? "disabled_reason=none" : `disabled_reason=${disabledReason}`,
    "(provider requirements summary; ADR-P2-1 amendment 2026-11-17 null semantics)",
  ];
  return [{ kind: "other", note: parts.join(" ") }];
}

/**
 * 从「读回结局 + 概览类别结果」推导一个不可变能力记录（纯函数）。
 * 非 verified 读回 → null（证据缺席不产生记录）；空 providerId/connectionId →
 * 抛出（装配错误）。
 */
export function derivePayswapCapabilityRecord(
  input: PayswapCapabilityDerivationInput,
): PayswapCapabilityRecord | null {
  if (input.providerId.trim().length === 0) {
    throw new Error("capability derivation requires a non-empty providerId");
  }
  if (input.connectionId.trim().length === 0) {
    throw new Error("capability derivation requires a non-empty connectionId");
  }
  if (input.outcome.kind !== "verified") {
    // auth-failed / unavailable：证据缺席不产生记录（unknown ≠ failed；状态由
    // 连接状态机持有 —— 本模块不复制连接状态）。
    return null;
  }
  const typedGapMessage =
    input.outcome.capabilityGap?.message ??
    (input.outcome.identityGap !== undefined
      ? `provider identity not exposed (${PAYSWAP_ACCOUNT_IDENTITY_GAP_CODE}); capability evidence unavailable`
      : undefined);

  const byOperation = new Map<string, PayswapOperationCapability>();
  const upsert = (operation: string, status: PayswapCapabilityOperationStatus, restrictions: PayswapCapabilityRestriction[]) => {
    const existing = byOperation.get(operation);
    if (!existing) {
      byOperation.set(operation, { operation, status, restrictions });
      return;
    }
    // 保守序：低值胜；restrictions 合并去重。
    const merged = [...existing.restrictions];
    for (const r of restrictions) {
      if (!merged.some((m) => m.kind === r.kind && m.note === r.note)) merged.push(r);
    }
    byOperation.set(operation, {
      operation,
      status: conservativeMin(existing.status, status),
      restrictions: merged,
    });
  };

  if (typedGapMessage !== undefined) {
    // typed 缺口连接：全部已知操作 unavailable，reason = 缺口 message（provider 级
    // 事实压过类别读证据 —— capabilities unknown 从余额/交易/客户数据不可推断）。
    const restriction: PayswapCapabilityRestriction[] = [
      { kind: "other", note: typedGapMessage },
    ];
    for (const category of PAYSWAP_READONLY_CATEGORIES) {
      upsert(CATEGORY_OPERATION[category], "unavailable", restriction);
    }
    for (const [, operations] of Object.entries(PAYSWAP_CAPABILITY_OPERATION_VOCABULARY)) {
      for (const operation of operations) {
        upsert(operation, "unavailable", restriction);
      }
    }
  } else {
    // 类别读证据。
    if (input.data !== undefined) {
      for (const category of PAYSWAP_READONLY_CATEGORIES) {
        const result = input.data[category];
        if (!result) continue;
        const derived = fromCategoryResult(result);
        upsert(CATEGORY_OPERATION[category], derived.status, derived.restrictions);
      }
    }
    // Stripe 式能力旗证据（verified + evidence）。
    const evidence = input.outcome.evidence;
    if (evidence !== undefined) {
      const requirementRestrictions = requirementsRestrictions(evidence);
    for (const capability of evidence.capabilities) {
      const operations = PAYSWAP_CAPABILITY_OPERATION_VOCABULARY[capability.name];
      if (operations === undefined) {
        // provider 读回了词汇表之外的名字 —— 记录其存在但不映射为任何操作
        // （不猜测）。证据记录在 collections.read 的 note 里（静态知识的唯一
        // 合法位置），且不得提升任何操作状态。
        const anchor = byOperation.get("collections.read") ?? {
          operation: "collections.read",
          status: "unavailable" as const,
          restrictions: [],
        };
        upsert("collections.read", anchor.status, [
          ...anchor.restrictions,
          {
            kind: "other" as const,
            note: `provider capability '${capability.name}' (${capability.status}) has no PaySwap operation mapping; not interpreted`,
          },
        ]);
        continue;
      }
      const status: PayswapCapabilityOperationStatus =
        capability.status === "active" ? "enabled" : capability.status === "pending" ? "pending" : "unavailable";
      for (const operation of operations) {
        upsert(operation, status, requirementRestrictions);
      }
    }
    }
  }

  if (byOperation.size === 0) {
    // verified 但既无类别数据也无能力旗也无 typed 缺口 —— 没有任何证据：不产记录
    // （verified-only 的空壳记录是 vacuous green 的能力面等价物，禁止）。
    return null;
  }

  const record = {
    providerId: input.providerId,
    connectionId: input.connectionId,
    schemaVersion: 1 as const,
    revision: 0, // 注册表 declare 时定（调用方提供的记录不带 revision 语义）
    declaredAt: input.now,
    evidence: {
      kind: "read-back" as const,
      outcomeKind: "verified" as const,
      providerAccountId: input.outcome.providerAccountId,
      hasCapabilityEvidence: input.outcome.evidence !== undefined,
    },
    operations: [...byOperation.values()].sort((a, b) => a.operation.localeCompare(b.operation)),
  };
  // revision 0 是推导面占位 —— schema 要求正数；注册表 declare 分配真实 revision。
  // schema 校验放行（推导记录的 revision 在 declare 时被覆盖），此处手工满足形状。
  return { ...record, revision: 1 };
}

// ---------------------------------------------------------------------------
// 注册表（不可变 + revision + frozen views）
// ---------------------------------------------------------------------------

export interface PayswapCapabilityRegistry {
  /** 追加一条推导记录（revision 由注册表分配；按 declaredAt 判 stale）。 */
  declare(record: Omit<PayswapCapabilityRecord, "revision">): PayswapCapabilityRecord;
  /** 最新记录（frozen；无记录 = null —— 证据缺席不是零记录）。 */
  latest(providerId: string, connectionId: string): Readonly<PayswapCapabilityRecord> | null;
  /** 全部历史（frozen，按 revision 升序）。 */
  history(providerId: string, connectionId: string): readonly Readonly<PayswapCapabilityRecord>[];
}

export function createPayswapCapabilityRegistry(options: { now?: () => string } = {}): PayswapCapabilityRegistry {
  void options; // 时间由推导方注入（declaredAt）；注册表不持时钟 —— 单一时间源在推导输入。
  const byKey = new Map<string, PayswapCapabilityRecord[]>();

  const key = (providerId: string, connectionId: string) => `${providerId}\u0000${connectionId}`;

  return {
    declare(record) {
      if (record.providerId.trim().length === 0 || record.connectionId.trim().length === 0) {
        throw new Error("capability registry declare requires non-empty providerId and connectionId");
      }
      const k = key(record.providerId, record.connectionId);
      const history = byKey.get(k) ?? [];
      const latest = history[history.length - 1];
      if (latest && record.declaredAt < latest.declaredAt) {
        throw new Error(
          `capability registry refuses a stale declaration: declaredAt ${record.declaredAt} is older than the latest ${latest.declaredAt} (revision ${latest.revision})`,
        );
      }
      const revision = (latest?.revision ?? 0) + 1;
      const parsed = payswapCapabilityRecordSchema.parse({
        ...record,
        revision,
      });
      // zod parse 产出全新对象树 —— 冻结必须在 parse 之后（否则冻结的是弃置副本）。
      const stored = Object.freeze({
        ...parsed,
        operations: Object.freeze(
          parsed.operations.map((op) =>
            Object.freeze({ ...op, restrictions: Object.freeze([...op.restrictions]) }),
          ),
        ),
      }) as PayswapCapabilityRecord;
      history.push(stored);
      byKey.set(k, history);
      return stored;
    },
    latest(providerId, connectionId) {
      const history = byKey.get(key(providerId, connectionId));
      const latest = history && history.length > 0 ? history[history.length - 1] : null;
      return latest ?? null;
    },
    history(providerId, connectionId) {
      return byKey.get(key(providerId, connectionId)) ?? [];
    },
  };
}
