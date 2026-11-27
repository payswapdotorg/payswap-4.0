/**
 * PaySwap P4 wave 2 —— 确定性 eligibility 引擎（shared CONTRACT「P4 确定性
 * eligibility 引擎」+ doc 05 §7「Eligibility surface」的实现）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **纯确定性求值**：无 IO、无凭据、无 provider 触达 —— 从能力记录（wave 1
 *    注册表的记录，唯一证据来源）+ query 约束求值 doc 05 §7 的 answer。
 * 2. **unknown ≠ ineligible**：无记录 → typed `eligibility_evidence_unavailable`；
 *    记录 stale（declaredAt + stalenessMs < now）→ typed
 *    `eligibility_evidence_stale` —— 绝不答 eligible:false + 空 blockers。
 * 3. **状态语义**：enabled/available → eligible；pending → ineligible +
 *    capability-pending blocker；restricted/unavailable → ineligible + 该操作记录
 *    的全部 restrictions 原样（P3 typed 缺口 message 流入 blockers）。
 * 4. **逐类约束裁决**：记录有该类结构化 restriction（deny/allow/min/max）→ 按其
 *    裁决（命中 deny / 未中 allow / 越界 → ineligible + 该类 blocker）；记录无该
 *    类结构化数据而 query 携带该约束 → typed
 *    `eligibility_constraint_unevidenced`（Unknown = unavailable，不乐观默认）；
 *    query 未携带的维度不裁决。
 * 5. **basis 恒为 "evidence"**；`basis: "live-check"` 请求 typed 拒绝（可选增强
 *    未实现 —— 不假装）。
 * 6. **无权威外溢**：不路由、不铸造、不写账 —— P6 routing 消费 answer；答案本身
 *    不是授权（doc 12 §2.2）。
 */

import { z } from "zod";
import type { PayswapCapabilityRecord } from "../capability/capabilityRegistry.js";
import type {
  PayswapEligibilityAnswer,
  PayswapEligibilityRefusalCode,
} from "@zcode/shared/payswap";

// ---------------------------------------------------------------------------
// query / answer 形状（doc 05 §7）
// ---------------------------------------------------------------------------

export const payswapEligibilityConstraintsSchema = z
  .object({
    country: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    amount: z.string().regex(/^-?\d+$/).optional(),
    method: z.string().min(1).optional(),
    recipientKind: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
    product: z.string().min(1).optional(),
    entitlement: z.string().min(1).optional(),
    chain: z.string().min(1).optional(),
    // P4 wave 6：验收点名的区块链约束尾部。token/wallet/destination/contractOperation/
    // finality 的值面与兄弟维度同纪律（自由字符串 —— 链专属词汇不发明，canonical
    // 形由证据/adapter 切片承载）；feeCap = gas/fee 上限的最小单位非负整数字符串
    //（BigInt 安全，与 amount 同形 —— 共用 min/max 界限裁决）。network 不另立维度
    //（canonical chain id 即网络身份）—— TL 决定，见 shared CONTRACT「P4 wave 6」。
    token: z.string().min(1).optional(),
    wallet: z.string().min(1).optional(),
    destination: z.string().min(1).optional(),
    contractOperation: z.string().min(1).optional(),
    feeCap: z.string().regex(/^\d+$/).optional(),
    finality: z.string().min(1).optional(),
  })
  .strict();
export type PayswapEligibilityConstraints = z.infer<typeof payswapEligibilityConstraintsSchema>;

export const payswapEligibilityQuerySchema = z
  .object({
    operation: z.string().min(1),
    connectionId: z.string().min(1),
    constraints: payswapEligibilityConstraintsSchema,
  })
  .strict();
export type PayswapEligibilityQuery = z.infer<typeof payswapEligibilityQuerySchema>;

// P4 wave 4 PR(b)：answer 法则迁住 shared（eligibility-answer.ts —— wire 形状
// 单一事实源）。本模块 re-export 保持 wave-2 导出面不变：单一实现，永不漂移。
export {
  payswapEligibilityAnswerSchema,
  PAYSWAP_ELIGIBILITY_REFUSAL_CODES,
} from "@zcode/shared/payswap";
export type {
  PayswapEligibilityAnswer,
  PayswapEligibilityRefusalCode,
} from "@zcode/shared/payswap";

// ---------------------------------------------------------------------------
// 求值（纯函数）
// ---------------------------------------------------------------------------

export interface PayswapEligibilityEvaluationInput {
  readonly query: PayswapEligibilityQuery;
  /** wave 1 注册表的最新能力记录；null = 无证据（typed 拒绝，不是 ineligible）。 */
  readonly record: PayswapCapabilityRecord | null;
  readonly now: string;
  /** 记录新鲜度上界（declaredAt + stalenessMs ≥ now 才可用）。缺省 = 24h。 */
  readonly stalenessMs?: number;
}

const DEFAULT_STALENESS_MS = 24 * 60 * 60 * 1000;

/** 约束维度 → 结构化 restriction 的裁决（wave 2 覆盖 doc 05 §7 的类）。 */
function adjudicateConstraint(
  dimension: keyof PayswapEligibilityConstraints,
  value: string,
  restrictions: ReadonlyArray<{ kind: string; allow?: readonly string[]; deny?: readonly string[]; min?: string; max?: string; note?: string }>,
): { blocked: boolean; blocker?: { kind: string; note?: string } } {
  const forClass = restrictions.filter((r) => r.kind === dimension);
  if (forClass.length === 0) return { blocked: false };
  for (const r of forClass) {
    if (r.deny && r.deny.includes(value)) {
      return { blocked: true, blocker: { kind: r.kind, note: r.note ?? `constraint '${dimension}=${value}' denied by provider evidence` } };
    }
    if (r.allow && !r.allow.includes(value)) {
      return { blocked: true, blocker: { kind: r.kind, note: r.note ?? `constraint '${dimension}=${value}' not in the provider-evidenced allowlist` } };
    }
    if (dimension === "amount" || dimension === "feeCap") {
      if (r.min !== undefined && BigInt(value) < BigInt(r.min)) {
        const note =
          r.note ??
          (dimension === "amount"
            ? `amount ${value} below the evidenced minimum ${r.min}`
            : `constraint 'feeCap=${value}' below the evidenced minimum ${r.min}`);
        return { blocked: true, blocker: { kind: r.kind, note } };
      }
      if (r.max !== undefined && BigInt(value) > BigInt(r.max)) {
        const note =
          r.note ??
          (dimension === "amount"
            ? `amount ${value} above the evidenced maximum ${r.max}`
            : `constraint 'feeCap=${value}' above the evidenced maximum ${r.max}`);
        return { blocked: true, blocker: { kind: r.kind, note } };
      }
    }
  }
  return { blocked: false };
}

function isUnevidenced(
  dimension: keyof PayswapEligibilityConstraints,
  restrictions: ReadonlyArray<{ kind: string }>,
): boolean {
  return !restrictions.some((r) => r.kind === dimension);
}

export function evaluatePayswapEligibility(
  input: PayswapEligibilityEvaluationInput,
): PayswapEligibilityAnswer {
  const { query, now } = input;
  const stalenessMs = input.stalenessMs ?? DEFAULT_STALENESS_MS;

  if (input.record === null) {
    return {
      kind: "refused",
      refused: {
        code: "eligibility_evidence_unavailable",
        message: `No capability record exists for connection '${query.connectionId}' (providerId '${query.connectionId.split(":")[0] ?? ""}' evidence never declared or the connection is unknown); eligibility cannot be answered from evidence.`,
      },
    };
  }
  const record = input.record;
  const declaredMs = Date.parse(record.declaredAt);
  if (Number.isFinite(declaredMs) && Date.parse(now) - declaredMs > stalenessMs) {
    return {
      kind: "refused",
      refused: {
        code: "eligibility_evidence_stale",
        message: `The capability record for connection '${query.connectionId}' was declared at ${record.declaredAt} and is older than the ${stalenessMs} ms evidence-freshness bound; refresh the connection evidence and retry.`,
      },
    };
  }

  const operation = record.operations.find((op) => op.operation === query.operation);
  if (operation === undefined) {
    // 读回未提及的操作 = Unknown = unavailable（doc 05 §4；不乐观默认）。
    return {
      kind: "answer",
      eligible: false,
      basis: "evidence",
      evidenceRef: {
        kind: "capability-record",
        providerId: record.providerId,
        connectionId: record.connectionId,
        revision: record.revision,
        declaredAt: record.declaredAt,
      },
      checkedAt: now,
      blockers: [
        {
          kind: "other",
          note: `operation '${query.operation}' is not evidenced by the provider read-back for this connection; unknown = unavailable`,
        },
      ],
    };
  }

  const blockers: Array<{ kind: string; note?: string }> = [];
  if (operation.status === "pending") {
    blockers.push({ kind: "other", note: `capability pending for '${query.operation}' (provider status)` });
  } else if (operation.status === "restricted" || operation.status === "unavailable") {
    for (const r of operation.restrictions) {
      blockers.push({ kind: r.kind, note: r.note });
    }
    if (blockers.length === 0) {
      blockers.push({ kind: "other", note: `capability ${operation.status} for '${query.operation}'` });
    }
  }

  if (blockers.length === 0) {
    // 约束裁决（状态可行才进行 —— 状态已挡时约束不是答案的一部分）。
    for (const [dimension, value] of Object.entries(query.constraints) as Array<[keyof PayswapEligibilityConstraints, string]>) {
      if (value === undefined) continue;
      const unevidenced = isUnevidenced(dimension, operation.restrictions);
      if (unevidenced) {
        return {
          kind: "refused",
          refused: {
            code: "eligibility_constraint_unevidenced",
            message: `Constraint '${dimension}=${value}' cannot be answered from the provider read-back evidence for '${query.operation}' on connection '${query.connectionId}' (the capability record carries no structured '${dimension}' restriction); unknown = unavailable, not optimistic defaults.`,
          },
        };
      }
      const verdict = adjudicateConstraint(dimension, value, operation.restrictions);
      if (verdict.blocked && verdict.blocker) blockers.push(verdict.blocker);
    }
  }

  if (blockers.length > 0) {
    return {
      kind: "answer",
      eligible: false,
      basis: "evidence",
      evidenceRef: {
        kind: "capability-record",
        providerId: record.providerId,
        connectionId: record.connectionId,
        revision: record.revision,
        declaredAt: record.declaredAt,
      },
      checkedAt: now,
      blockers,
    };
  }

  return {
    kind: "answer",
    eligible: true,
    basis: "evidence",
    evidenceRef: {
      kind: "capability-record",
      providerId: record.providerId,
      connectionId: record.connectionId,
      revision: record.revision,
      declaredAt: record.declaredAt,
    },
    checkedAt: now,
    blockers: [],
  };
}
