/**
 * PaySwap P4 wave 2 —— 确定性 eligibility 引擎的法则证明（shared CONTRACT
 * 「P4 确定性 eligibility 引擎」+ doc 05 §7 + P4 验收的 typed 拒绝行）。
 *
 * 被测法则：
 * 1. **状态语义**：enabled/available → eligible；pending → ineligible + blocker；
 *    restricted/unavailable → ineligible + 全部 restrictions（typed 缺口 message
 *    原样流入 blockers）。
 * 2. **unknown ≠ ineligible**：无记录 / stale 记录 → typed 拒绝
 *    （eligibility_evidence_unavailable / eligibility_evidence_stale），绝不答
 *    eligible:false + 空 blockers。
 * 3. **逐类 typed 约束裁决**：结构化 restriction（allow/deny/min/max）裁决
 *    country/currency/amount/method 类约束；命中 deny / 未中 allow / 越界 →
 *    ineligible + 该类 blocker；记录无该类结构化数据而 query 携带 → typed
 *    eligibility_constraint_unevidenced；query 未携带的维度不裁决。
 * 4. **basis 恒为 evidence**；引擎无 IO 面（结构断言）。
 */

import { describe, expect, it } from "vitest";
import {
  derivePayswapCapabilityRecord,
  createPayswapCapabilityRegistry,
  type PayswapCapabilityRecord,
} from "@zcode/services/node";
import {
  PAYSWAP_READONLY_CATEGORIES,
  type PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";
import {
  evaluatePayswapEligibility,
  payswapEligibilityAnswerSchema,
  type PayswapEligibilityQuery,
} from "@zcode/services/node";

// PaySwap P4 wave 4：约束维度 purpose/product/entitlement + 结构化 restriction
// （allow/deny/min/max）的 schema 层证明 —— PR #98 记录在案的另一半。
import {
  payswapCapabilityRestrictionSchema,
  payswapEligibilityConstraintsSchema,
} from "@zcode/services/node";

const NOW = "2026-11-25T18:00:00.000Z";

function categoryResult(status: PayswapReadonlyCategoryResult["status"]): PayswapReadonlyCategoryResult {
  switch (status) {
    case "ok":
      return { status: "ok", data: { available: [], pending: [] } };
    case "auth-failed":
      return { status: "auth-failed", detail: "HTTP 401" };
    case "refused":
      return { status: "refused", refusal: { code: "insufficient_permission", message: "restricted key" } };
    case "unavailable":
      return { status: "unavailable", detail: "transport failed" };
  }
}

function overviewAll(status: PayswapReadonlyCategoryResult["status"]) {
  const data = {} as Record<(typeof PAYSWAP_READONLY_CATEGORIES)[number], PayswapReadonlyCategoryResult>;
  for (const c of PAYSWAP_READONLY_CATEGORIES) data[c] = categoryResult(status);
  return data;
}

function stripeRecord(overrides: {
  capabilities?: Array<{ name: string; status: "active" | "pending" | "inactive" }>;
  categoryStatus?: PayswapReadonlyCategoryResult["status"];
} = {}): PayswapCapabilityRecord {
  const registry = createPayswapCapabilityRegistry();
  const record = derivePayswapCapabilityRecord({
    providerId: "stripe",
    connectionId: "conn-1",
    outcome: {
      kind: "verified",
      providerAccountId: "acct_1",
      evidence: overrides.capabilities
        ? {
            capabilities: overrides.capabilities,
            requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
          }
        : undefined,
    },
    data: overviewAll(overrides.categoryStatus ?? "ok"),
    now: NOW,
  });
  if (record === null) throw new Error("stripe record derivation returned null");
  return registry.declare(record);
}

function gapRecord(providerId: string, connectionId: string): PayswapCapabilityRecord {
  const registry = createPayswapCapabilityRegistry();
  const record = derivePayswapCapabilityRecord({
    providerId,
    connectionId,
    outcome: {
      kind: "verified",
      providerAccountId: null,
      identityGap: { code: "provider_identity_not_exposed", message: "no identity surface" },
      capabilityGap: {
        code: "capability_evidence_not_exposed",
        message: "The provider exposes no capability read-back surface (checked 2026-11-24).",
      },
    },
    data: overviewAll("ok"),
    now: NOW,
  });
  if (record === null) throw new Error("gap record derivation returned null");
  return registry.declare(record);
}

function query(overrides: Partial<PayswapEligibilityQuery> = {}): PayswapEligibilityQuery {
  return {
    operation: "balances.read",
    connectionId: "conn-1",
    constraints: {},
    ...overrides,
  };
}

describe("payswap eligibility engine (P4 wave 2) — the evidence law", () => {
  it("enabled/available → eligible with basis=evidence, an evidenceRef and zero blockers", () => {
    const answer = evaluatePayswapEligibility({ query: query(), record: stripeRecord(), now: NOW });
    expect(answer.kind).toBe("answer");
    if (answer.kind !== "answer") return;
    expect(answer.eligible).toBe(true);
    expect(answer.basis).toBe("evidence");
    expect(answer.blockers).toEqual([]);
    expect(answer.evidenceRef).toMatchObject({ kind: "capability-record", providerId: "stripe" });
    expect(answer.checkedAt).toBe(NOW);
    expect(payswapEligibilityAnswerSchema.safeParse(answer).success).toBe(true);
  });

  it("pending → ineligible with a capability-pending blocker; restricted/unavailable → ineligible carrying the record's restrictions verbatim", () => {
    const pending = evaluatePayswapEligibility({
      query: query({ operation: "transfers.read" }),
      record: stripeRecord({ capabilities: [{ name: "transfers", status: "pending" }] }),
      now: NOW,
    });
    expect(pending.kind).toBe("answer");
    if (pending.kind === "answer") {
      expect(pending.eligible).toBe(false);
      expect(pending.blockers.length).toBeGreaterThan(0);
    }

    const gap = evaluatePayswapEligibility({ query: query(), record: gapRecord("paystack", "conn-2"), now: NOW });
    expect(gap.kind).toBe("answer");
    if (gap.kind === "answer") {
      expect(gap.eligible).toBe(false);
      expect(gap.blockers.length).toBe(gapRecord("paystack", "conn-2").operations.find((o) => o.operation === "balances.read")?.restrictions.length);
      const notes = gap.blockers.map((b) => b.note ?? "").join(" ");
      expect(notes).toContain("capability read-back surface");
    }
  });

  it("unknown != ineligible: a missing record and a stale record refuse typed — never eligible:false with empty blockers", () => {
    const missing = evaluatePayswapEligibility({ query: query(), record: null, now: NOW });
    expect(missing.kind).toBe("refused");
    if (missing.kind === "refused") {
      expect(missing.refused.code).toBe("eligibility_evidence_unavailable");
      expect(missing.refused.message).toMatch(/no capability record|no evidence/i);
    }
    const stale = evaluatePayswapEligibility({
      query: query(),
      record: stripeRecord(),
      now: "2026-12-26T18:00:00.000Z",
    });
    expect(stale.kind).toBe("refused");
    if (stale.kind === "refused") {
      expect(stale.refused.code).toBe("eligibility_evidence_stale");
    }
  });

  it("per-class constraint adjudication: structured deny/allow/min-max on the record decide; unevidenced constraints refuse typed per class", () => {
    // 构造带结构化 restriction 的记录：直接在推导产物上按 registry declare 不可行
    //（wave 1 推导不产结构化数据），所以用 registry.declare 接受的形状 —— 推导记录
    // 的 restrictions 由测试构造（declare 只做 stale 检查与冻结，不改写 restrictions）。
    const base = stripeRecord();
    const withCountry = {
      ...base,
      operations: base.operations.map((op) =>
        op.operation === "balances.read"
          ? {
              ...op,
              restrictions: [
                { kind: "country" as const, deny: ["KP", "IR"], note: "sanctions perimeter (provider evidence)" },
              ],
            }
          : op,
      ),
    };
    const denied = evaluatePayswapEligibility({
      query: query({ constraints: { country: "KP" } }),
      record: withCountry,
      now: NOW,
    });
    expect(denied.kind).toBe("answer");
    if (denied.kind === "answer") {
      expect(denied.eligible).toBe(false);
      expect(denied.blockers.some((b) => b.kind === "country" && (b.note ?? "").includes("sanctions"))).toBe(true);
    }

    const allowed = evaluatePayswapEligibility({
      query: query({ constraints: { country: "GH" } }),
      record: withCountry,
      now: NOW,
    });
    expect(allowed.kind).toBe("answer");
    if (allowed.kind === "answer") expect(allowed.eligible).toBe(true);

    // 记录无 country 结构化数据而 query 携带 → typed unevidenced
    const unevidenced = evaluatePayswapEligibility({
      query: query({ constraints: { country: "US" } }),
      record: stripeRecord(),
      now: NOW,
    });
    expect(unevidenced.kind).toBe("refused");
    if (unevidenced.kind === "refused") {
      expect(unevidenced.refused.code).toBe("eligibility_constraint_unevidenced");
      expect(unevidenced.refused.message).toMatch(/country/i);
    }

    // query 未携带的维度不裁决（有结构化数据也不额外产 blocker）
    const noConstraint = evaluatePayswapEligibility({
      query: query({ constraints: {} }),
      record: withCountry,
      now: NOW,
    });
    expect(noConstraint.kind).toBe("answer");
    if (noConstraint.kind === "answer") expect(noConstraint.eligible).toBe(true);

    // amount 越界 → amount 类 blocker
    const withAmount = {
      ...base,
      operations: base.operations.map((op) =>
        op.operation === "balances.read"
          ? { ...op, restrictions: [{ kind: "amount" as const, min: "100", max: "500000", note: "provider per-transaction bounds" }] }
          : op,
      ),
    };
    const overMax = evaluatePayswapEligibility({
      query: query({ constraints: { amount: "500001" } }),
      record: withAmount,
      now: NOW,
    });
    expect(overMax.kind).toBe("answer");
    if (overMax.kind === "answer") {
      expect(overMax.eligible).toBe(false);
      expect(overMax.blockers.some((b) => b.kind === "amount")).toBe(true);
    }
  });

  it("the engine has no IO face: no route/mint/submit/ledger surface (structural assertion)", () => {
    for (const forbidden of ["route", "mint", "submit", "ledger", "connect", "readBack"]) {
      expect(evaluatePayswapEligibility).not.toHaveProperty(forbidden);
    }
  });
});

describe("payswap eligibility constraint dimensions (P4 wave 4) — purpose/product/entitlement + structured restrictions", () => {
  it("W10a: the query constraints schema accepts the purpose/product/entitlement dimensions (beneficiary rides the existing recipientKind dimension)", () => {
    expect(payswapEligibilityConstraintsSchema.safeParse({ purpose: "tax" }).success).toBe(true);
    expect(payswapEligibilityConstraintsSchema.safeParse({ product: "payout_card" }).success).toBe(true);
    expect(payswapEligibilityConstraintsSchema.safeParse({ entitlement: "payouts_std" }).success).toBe(true);
    expect(payswapEligibilityConstraintsSchema.safeParse({ recipientKind: "verified-recipient" }).success).toBe(true);
    // 未知维度照旧 strict 拒绝（闭集不扩）。
    expect(payswapEligibilityConstraintsSchema.safeParse({ loyaltyTier: "gold" }).success).toBe(false);
  });

  it("W10b: the capability restriction schema accepts the structured allow/deny/min/max form (amount bounds are BigInt-safe integer decimal strings)", () => {
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "purpose", deny: ["loan_repayment"], note: "provider purpose perimeter" }).success).toBe(true);
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "product", allow: ["payout_card"] }).success).toBe(true);
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "entitlement", allow: ["payouts_std", "payouts_pro"] }).success).toBe(true);
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "amount", min: "100", max: "500000", note: "provider per-transaction bounds" }).success).toBe(true);
    // 非整数 decimal min/max 会撞引擎的 BigInt 比较 —— schema 层即拒（不发明）。
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "amount", min: "12.50" }).success).toBe(false);
    // 非结构化 note-only 形状照旧合法（additive，不改写 wave 1 数据）。
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "other", note: "provider absence: transport failed" }).success).toBe(true);
    // 未知键照旧 strict 拒绝。
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "country", rogue: true }).success).toBe(false);
  });

  it("W10c (runtime regression guard): a structured purpose deny adjudicates end to end through the unchanged engine", () => {
    const base = stripeRecord();
    const withPurpose = {
      ...base,
      operations: base.operations.map((op) =>
        op.operation === "balances.read"
          ? {
              ...op,
              restrictions: [
                { kind: "purpose" as const, deny: ["loan_repayment"], note: "provider purpose perimeter" },
              ],
            }
          : op,
      ),
    };
    const denied = evaluatePayswapEligibility({
      query: query({ constraints: { purpose: "loan_repayment" } }),
      record: withPurpose,
      now: NOW,
    });
    expect(denied.kind).toBe("answer");
    if (denied.kind === "answer") {
      expect(denied.eligible).toBe(false);
      expect(denied.blockers.some((b) => b.kind === "purpose" && (b.note ?? "").includes("purpose perimeter"))).toBe(true);
    }
    const permitted = evaluatePayswapEligibility({
      query: query({ constraints: { purpose: "payroll" } }),
      record: withPurpose,
      now: NOW,
    });
    expect(permitted.kind).toBe("answer");
    if (permitted.kind === "answer") expect(permitted.eligible).toBe(true);
  });
});
