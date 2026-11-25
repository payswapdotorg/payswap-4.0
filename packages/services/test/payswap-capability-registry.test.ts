/**
 * PaySwap P4 wave 1 —— evidence-backed provider capability registry 的法则证明
 * （shared CONTRACT「P4 provider capability registry」+ doc 05 §4 + doc 12 §3）。
 *
 * 被测法则：
 * 1. **证据推导**：读回结局 + 概览类别结果 → 不可变能力记录 —— 类别读证据
 *    （ok→available / 403→restricted / unsupported→unavailable / unknown→unavailable）、
 *    Stripe 式能力旗证据（固定词汇表 card_payments→collections.read 等）、
 *    typed 缺口连接（全部 unavailable + 缺口 message 进 reason）、保守序
 *    （两半证据冲突时低值胜）。
 * 2. **记录不可变 + revision 递增**：新证据 ⇒ 新记录；注册表保留历史；
 *    frozen views（外部拿不到可变引用）。
 * 3. **硬编码能力表禁止**：capability 名 → 操作 id 的固定词汇表是唯一固定表；
 *    读回未提及的操作一律 unavailable（Unknown = unavailable）。
 * 4. **无权威外溢**：注册表不铸造 grant、不触 provider、不写 ledger（结构断言）；
 *    agent-catalog 形状的记录在 schema 层不可变换为 capability 记录。
 * 5. **畸形拒绝**：畸形读回结局 / 未知类别 / 空 providerId → typed 拒绝（fail-closed）。
 */

import { describe, expect, it } from "vitest";
import {
  PAYSWAP_READONLY_CATEGORIES,
  type PayswapAccountCapabilityEvidence,
  type PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";
import {
  createPayswapCapabilityRegistry,
  derivePayswapCapabilityRecord,
  PAYSWAP_CAPABILITY_OPERATION_VOCABULARY,
  payswapCapabilityRecordSchema,
} from "@zcode/services/node";

const STRIPE_EVIDENCE: PayswapAccountCapabilityEvidence = {
  capabilities: [
    { name: "card_payments", status: "active" },
    { name: "transfers", status: "pending" },
  ],
  requirements: { disabledReason: null, currentlyDueCount: 2, pastDueCount: 0 },
};

function categoryResult(
  status: PayswapReadonlyCategoryResult["status"],
  overrides: Record<string, unknown> = {},
): PayswapReadonlyCategoryResult {
  switch (status) {
    case "ok":
      return { status: "ok", data: { available: [], pending: [] } };
    case "auth-failed":
      return { status: "auth-failed", detail: "HTTP 401" };
    case "refused":
      return { status: "refused", refusal: overrides as never };
    case "unavailable":
      return { status: "unavailable", detail: (overrides.detail as string) ?? "transport failed" };
  }
}

function overviewData(
  perCategory: Partial<Record<(typeof PAYSWAP_READONLY_CATEGORIES)[number], PayswapReadonlyCategoryResult>>,
): Readonly<Record<(typeof PAYSWAP_READONLY_CATEGORIES)[number], PayswapReadonlyCategoryResult>> {
  const data = {} as Record<(typeof PAYSWAP_READONLY_CATEGORIES)[number], PayswapReadonlyCategoryResult>;
  for (const category of PAYSWAP_READONLY_CATEGORIES) {
    data[category] = perCategory[category] ?? categoryResult("unavailable");
  }
  return data;
}

describe("payswap capability registry (P4 wave 1) — the evidence-derivation law", () => {
  it("category reads are operation evidence: ok→available, 403→restricted, unsupported→unavailable, unknown→unavailable", () => {
    const record = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1" },
      data: overviewData({
        balance: categoryResult("ok"),
        payment_objects: categoryResult("refused", { code: "insufficient_permission", message: "restricted key" }),
        customers: categoryResult("refused", { code: "unsupported_operation", message: "no surface" }),
        disputes: categoryResult("unavailable", { detail: "transport failed" }),
      }),
      now: "2026-11-25T18:00:00.000Z",
    });
    expect(record.schemaVersion).toBe(1);
    expect(record.declaredAt).toBe("2026-11-25T18:00:00.000Z");
    const byOp = Object.fromEntries(record.operations.map((o) => [o.operation, o]));
    expect(byOp["balances.read"]).toMatchObject({ status: "available", restrictions: [] });
    expect(byOp["payment_objects.read"]).toMatchObject({ status: "restricted" });
    expect(byOp["payment_objects.read"].restrictions[0]?.kind).toBe("entitlement");
    expect(byOp["customers.read"]).toMatchObject({ status: "unavailable" });
    expect(byOp["disputes.read"]).toMatchObject({ status: "unavailable" });
    expect(payswapCapabilityRecordSchema.safeParse(record).success).toBe(true);
  });

  it("Stripe capability flags map through the fixed vocabulary with status semantics; unmapped provider names are recorded, never guessed", () => {
    const record = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1", evidence: STRIPE_EVIDENCE },
      data: overviewData({
        // 类别读证据与能力旗同 Operation 重叠处由保守序裁决 —— 这里给出 ok 类别
        // 使 payment_objects.read 的旗半（enabled）可与类别半（available）相加。
        payment_objects: categoryResult("ok"),
      }),
      now: "2026-11-25T18:00:00.000Z",
    });
    const byOp = Object.fromEntries(record.operations.map((o) => [o.operation, o]));
    expect(byOp["collections.read"]).toMatchObject({ status: "enabled" });
    // card_payments 同时证据 payment_objects.read（charges = 收款面 + 支付对象面）；
    // 类别读 ok × 旗 enabled → 两半都高 → available（保守序取低值，这里恰为高值）。
    expect(byOp["payment_objects.read"]).toMatchObject({ status: "available" });
    expect(byOp["transfers.read"]).toMatchObject({ status: "pending" });
    // requirements 摘要进 restrictions note（静态知识的唯一合法位置）
    const due = byOp["collections.read"].restrictions.find((r) => r.kind === "other");
    expect(due?.note).toContain("currently_due=2");
    // 读回未提及的操作一律 unavailable（Unknown = unavailable）
    expect(byOp["payouts.read"]).toBeUndefined();
  });

  it("typed capability gaps make every vocabulary operation unavailable with the gap message as reason — never fabricated statuses", () => {
    const record = derivePayswapCapabilityRecord({
      providerId: "paystack",
      connectionId: "conn-2",
      outcome: {
        kind: "verified",
        providerAccountId: null,
        identityGap: { code: "provider_identity_not_exposed", message: "no identity surface" },
        capabilityGap: {
          code: "capability_evidence_not_exposed",
          message: "Paystack exposes no capability read-back surface (checked 2026-11-24).",
        },
      },
      data: overviewData({ balance: categoryResult("ok") }),
      now: "2026-11-25T18:00:00.000Z",
    });
    expect(record.operations.length).toBeGreaterThan(0);
    for (const op of record.operations) {
      expect(op.status).toBe("unavailable");
      expect(op.restrictions[0]?.note).toContain("capability read-back surface");
    }
    // 类别读证据（balance ok）不得抵消 typed 缺口 —— 缺口是 provider 级事实
    const balance = record.operations.find((o) => o.operation === "balances.read");
    expect(balance?.status).toBe("unavailable");
  });

  it("conservative ordering wins on real evidence overlap: a pending card_payments flag keeps the category-ok payment_objects read at pending", () => {
    // card_payments pending → collections.read + payment_objects.read 均 pending；
    // 类别读 payment_objects ok → available。保守序：pending（低值）胜。
    const record = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: {
        kind: "verified",
        providerAccountId: "acct_1",
        evidence: {
          capabilities: [{ name: "card_payments", status: "pending" }],
          requirements: null,
        },
      },
      data: overviewData({ payment_objects: categoryResult("ok") }),
      now: "2026-11-25T18:00:00.000Z",
    });
    const paymentObjects = record.operations.find((o) => o.operation === "payment_objects.read");
    expect(paymentObjects?.status).toBe("pending");
    const collections = record.operations.find((o) => o.operation === "collections.read");
    expect(collections?.status).toBe("pending");
  });

  it("the vocabulary is the only fixed table and it maps provider-read names, not guesses", () => {
    expect(Object.keys(PAYSWAP_CAPABILITY_OPERATION_VOCABULARY).sort()).toEqual([
      "card_payments",
      "payouts",
      "transfers",
    ]);
    expect([...PAYSWAP_CAPABILITY_OPERATION_VOCABULARY.card_payments]).toEqual([
      "collections.read",
      "payment_objects.read",
    ]);
    expect([...PAYSWAP_CAPABILITY_OPERATION_VOCABULARY.transfers]).toEqual(["transfers.read"]);
    expect([...PAYSWAP_CAPABILITY_OPERATION_VOCABULARY.payouts]).toEqual(["payouts.read"]);
  });

  it("malformed inputs refuse typed: empty providerId, unknown connection, non-verified outcome with no data", () => {
    expect(() =>
      derivePayswapCapabilityRecord({
        providerId: "",
        connectionId: "conn-1",
        outcome: { kind: "verified", providerAccountId: "acct_1" },
        data: overviewData({}),
        now: "2026-11-25T18:00:00.000Z",
      }),
    ).toThrow(/providerId/i);
    expect(() =>
      derivePayswapCapabilityRecord({
        providerId: "stripe",
        connectionId: "",
        outcome: { kind: "verified", providerAccountId: "acct_1" },
        data: overviewData({}),
        now: "2026-11-25T18:00:00.000Z",
      }),
    ).toThrow(/connectionId/i);
    // auth-failed 读回不产生记录（证据缺席不产生记录）
    const refused = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "auth-failed", detail: "HTTP 401" },
      now: "2026-11-25T18:00:00.000Z",
    });
    expect(refused).toBeNull();
  });
});

describe("payswap capability registry (P4 wave 1) — the registry laws", () => {
  it("declare appends an immutable revision; history is retained; external views are frozen", () => {
    const registry = createPayswapCapabilityRegistry({ now: () => "2026-11-25T18:00:00.000Z" });
    const first = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1", evidence: STRIPE_EVIDENCE },
      data: overviewData({ balance: categoryResult("ok") }),
      now: "2026-11-25T18:00:00.000Z",
    });
    const second = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1", evidence: STRIPE_EVIDENCE },
      data: overviewData({ balance: categoryResult("ok"), disputes: categoryResult("ok") }),
      now: "2026-11-25T19:00:00.000Z",
    });
    const rev1 = registry.declare(first);
    const rev2 = registry.declare(second);
    expect(rev2.revision).toBe(rev1.revision + 1);
    expect(registry.latest("stripe", "conn-1")?.revision).toBe(2);
    expect(registry.history("stripe", "conn-1").map((r) => r.revision)).toEqual([1, 2]);
    // frozen views：变异外部拿到的数组不得影响注册表
    const view = registry.latest("stripe", "conn-1");
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view.operations as unknown as unknown[]).push({});
    }).toThrow();
    expect(registry.latest("stripe", "conn-1")?.operations.length).toBe(view.operations.length);
  });

  it("stale-revision declaration is refused: the registry rejects an older record over a newer one", () => {
    const registry = createPayswapCapabilityRegistry({ now: () => "2026-11-25T18:00:00.000Z" });
    const newer = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1" },
      data: overviewData({}),
      now: "2026-11-25T19:00:00.000Z",
    });
    const older = derivePayswapCapabilityRecord({
      providerId: "stripe",
      connectionId: "conn-1",
      outcome: { kind: "verified", providerAccountId: "acct_1" },
      data: overviewData({}),
      now: "2026-11-25T18:00:00.000Z",
    });
    registry.declare(newer);
    expect(() => registry.declare(older)).toThrow(/stale|older|revision/i);
  });

  it("no authority spillover: the registry exposes no grant, route, provider or ledger face", () => {
    const registry = createPayswapCapabilityRegistry({ now: () => "2026-11-25T18:00:00.000Z" });
    for (const forbidden of ["mint", "authorize", "route", "submit", "ledger", "readBack", "connect"]) {
      expect(registry).not.toHaveProperty(forbidden);
    }
  });
});
