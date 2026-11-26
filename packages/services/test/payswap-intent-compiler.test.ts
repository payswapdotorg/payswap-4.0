/**
 * PaySwap P4 wave 4 —— money-movement intent 编译器 + intent 注册表的法则证明
 * （shared CONTRACT「P4 wave 4」+ doc 06 §2.4 + P4 验收的 evidence-backed 行）。
 *
 * 被测法则（RED 矩阵 W1–W9；W10 行住在 payswap-eligibility-engine.test.ts 的
 * 约束维度追加块；W11 broker 行随 wave-4 PR(b)）：
 * 1. **draft-vs-evidence 分离**：物质字段缺失 → clarification 逐字段请求；
 *    证据缺席（sender 记录 / verified-recipient 证据）→ typed 拒绝 —— 永不混用。
 * 2. **typed 拒绝闭集（七枚）**：recipient/sender/amount/currency/kind/rail/
 *    operation —— 用户 rail 偏好与显式 operation 提名永不压过 provider 证据。
 * 3. **确定性映射 v1**：send/collect → collections.read；sweep → payouts.read；
 *    refund → payment_objects.read；convert/review → clarification（除非提名）。
 * 4. **intent 不可变 + 注册表纪律**：host UUIDv7、frozen views、全局 revision
 *    递增、同 id 永不重声明、stale createdAt 拒绝、未知 id = null。
 * 5. **无权威外溢**：编译器/注册表无 route/mint/submit/ledger 面（结构断言）。
 */

import { describe, expect, it } from "vitest";
import {
  compilePayswapIntent,
  createPayswapCapabilityRegistry,
  createPayswapIntentRegistry,
  derivePayswapCapabilityRecord,
  PAYSWAP_INTENT_KINDS,
  PAYSWAP_INTENT_REFUSAL_CODES,
  payswapIntentDraftSchema,
  type PayswapCapabilityRecord,
  type PayswapIntentDraft,
} from "@zcode/services/node";
import {
  PAYSWAP_READONLY_CATEGORIES,
  payswapVerifiedRecipientEvidenceSchema,
  type PayswapReadonlyCategoryResult,
  type PayswapVerifiedRecipientEvidence,
} from "@zcode/shared/payswap";

const NOW = "2026-11-26T12:00:00.000Z";
/** host 分配的 UUIDv7（编译器不产 id —— 畸形 id 是装配错误）。 */
const INTENT_ID = "01926f1a-7c3b-7e21-8a9b-4c1d2e3f4a5b";

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

function senderRecord(overrides: {
  capabilities?: Array<{ name: string; status: "active" | "pending" | "inactive" }>;
  connectionId?: string;
} = {}): PayswapCapabilityRecord {
  const registry = createPayswapCapabilityRegistry();
  const record = derivePayswapCapabilityRecord({
    providerId: "stripe",
    connectionId: overrides.connectionId ?? "conn-1",
    outcome: {
      kind: "verified",
      providerAccountId: "acct_1",
      evidence: {
        capabilities: overrides.capabilities ?? [
          { name: "card_payments", status: "active" },
          { name: "payouts", status: "active" },
        ],
        requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
      },
    },
    data: overviewAll("ok"),
    now: NOW,
  });
  if (record === null) throw new Error("sender record derivation returned null");
  return registry.declare(record);
}

function withOperationRestriction(
  base: PayswapCapabilityRecord,
  operation: string,
  restriction: { kind: "method"; allow?: string[]; deny?: string[]; note?: string },
): PayswapCapabilityRecord {
  return {
    ...base,
    operations: base.operations.map((op) =>
      op.operation === operation
        ? { ...op, restrictions: [...op.restrictions, restriction] }
        : op,
    ),
  };
}

function recipientEvidence(overrides: {
  recipientId?: string;
  verifiedAt?: string;
  freshnessBoundMs?: number;
} = {}): PayswapVerifiedRecipientEvidence {
  return {
    kind: "verified-recipient",
    recipientId: overrides.recipientId ?? "rcpt-1",
    identity: {
      evidenceRef: "evd-rcpt-1",
      source: "verified-recipient-registry",
      verifiedAt: overrides.verifiedAt ?? "2026-11-26T11:00:00.000Z",
    },
    acceptances: [{ rail: { class: "card" }, currency: "USD" }],
    freshnessBoundMs: overrides.freshnessBoundMs ?? 3_600_000,
  };
}

function fullDraft(overrides: Partial<PayswapIntentDraft> = {}): PayswapIntentDraft {
  return {
    description: "pay Acme 100 USD for October services",
    kind: "send",
    amount: "100.00",
    currency: "USD",
    senderConnectionId: "conn-1",
    recipientId: "rcpt-1",
    purpose: { code: "business_payment" },
    ...overrides,
  };
}

function compile(overrides: {
  draft?: PayswapIntentDraft;
  intentId?: string;
  principalId?: string;
  senderCapabilityRecord?: PayswapCapabilityRecord | null;
  recipientEvidence?: PayswapVerifiedRecipientEvidence | null;
  now?: string;
} = {}) {
  return compilePayswapIntent({
    draft: fullDraft(),
    intentId: INTENT_ID,
    principalId: "principal-1",
    senderCapabilityRecord: senderRecord(),
    recipientEvidence: recipientEvidence(),
    now: NOW,
    ...overrides,
  });
}

/** 从 happy path 派生一条形状合法的 intent（改 id/createdAt 供注册表行使用）。 */
function builtIntent(overrides: { intentId: string; createdAt: string }): ReturnType<typeof happyIntent> {
  return { ...happyIntent(), intentId: overrides.intentId, createdAt: overrides.createdAt };
}

function happyIntent() {
  const outcome = compile();
  if (outcome.kind !== "intent") throw new Error("happy-path compile did not produce an intent");
  return outcome.intent;
}

describe("payswap intent compiler (P4 wave 4) — the draft-vs-evidence law", () => {
  it("W1: the draft schema keeps strict unknown-key rejection and still parses a v1-only draft", () => {
    expect(payswapIntentDraftSchema.safeParse({ ...fullDraft(), rogueField: true }).success).toBe(false);
    expect(payswapIntentDraftSchema.safeParse({ description: "move money" }).success).toBe(true);
    expect(payswapIntentDraftSchema.safeParse(fullDraft()).success).toBe(true);
  });

  it("W2: full evidence + full draft → intent union with the host UUIDv7, frozen intent and a derived eligibilityQuery", () => {
    const outcome = compile();
    expect(outcome.kind).toBe("intent");
    if (outcome.kind !== "intent") return;
    expect(outcome.intent.intentId).toBe(INTENT_ID);
    expect(Object.isFrozen(outcome.intent)).toBe(true);
    expect(outcome.intent.amount).toEqual({ value: "100.00", currency: "USD" });
    expect(outcome.intent.sender).toMatchObject({
      kind: "connected-account",
      principalId: "principal-1",
      connectionId: "conn-1",
      providerId: "stripe",
      capabilityRevision: 1,
    });
    expect(outcome.intent.recipient).toEqual({
      kind: "verified-recipient-ref",
      recipientId: "rcpt-1",
      evidenceRef: "evd-rcpt-1",
      verifiedAt: "2026-11-26T11:00:00.000Z",
    });
    expect(outcome.intent.operation).toBe("collections.read");
    expect(outcome.intent.privacy).toBe("standard");
    expect(outcome.eligibilityQuery).toEqual({
      operation: "collections.read",
      connectionId: "conn-1",
      constraints: { currency: "USD", purpose: "business_payment", recipientKind: "verified-recipient" },
    });
    expect(Object.isFrozen(outcome.eligibilityQuery)).toBe(true);

    const registry = createPayswapIntentRegistry();
    const declared = registry.declare(outcome.intent);
    expect(declared.revision).toBe(1);
    expect(Object.isFrozen(declared)).toBe(true);
  });

  it("W3: missing material fields → clarification naming every missing field, never a refusal", () => {
    const minimal = compile({ draft: { description: "send money home", kind: "send" } });
    expect(minimal.kind).toBe("clarification");
    if (minimal.kind === "clarification") {
      expect(minimal.requests.map((r) => r.field)).toEqual([
        "amount",
        "currency",
        "recipientId",
        "senderConnectionId",
        "purpose",
      ]);
    }
    const bare = compile({ draft: { description: "move money" } });
    expect(bare.kind).toBe("clarification");
    if (bare.kind === "clarification") {
      expect(bare.requests.map((r) => r.field)).toEqual([
        "kind",
        "amount",
        "currency",
        "recipientId",
        "senderConnectionId",
        "purpose",
      ]);
    }
  });

  it("W4: recipientId without verified evidence (or stale evidence) → intent_recipient_unverified", () => {
    const noEvidence = compile({ recipientEvidence: null });
    expect(noEvidence.kind).toBe("refused");
    if (noEvidence.kind === "refused") {
      expect(noEvidence.refused.code).toBe("intent_recipient_unverified");
      expect(noEvidence.refused.message).toMatch(/claims alone are insufficient/i);
    }
    const wrongRecipient = compile({ recipientEvidence: recipientEvidence({ recipientId: "rcpt-other" }) });
    expect(wrongRecipient.kind).toBe("refused");
    if (wrongRecipient.kind === "refused") expect(wrongRecipient.refused.code).toBe("intent_recipient_unverified");
    const stale = compile({
      recipientEvidence: recipientEvidence({ verifiedAt: "2026-11-26T08:00:00.000Z", freshnessBoundMs: 3_600_000 }),
    });
    expect(stale.kind).toBe("refused");
    if (stale.kind === "refused") {
      expect(stale.refused.code).toBe("intent_recipient_unverified");
      expect(stale.refused.message).toMatch(/stale/i);
    }
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(recipientEvidence()).success).toBe(true);
  });

  it("W5: sender connection without a capability record (or a record for another connection) → intent_sender_evidence_unavailable", () => {
    const noRecord = compile({ senderCapabilityRecord: null });
    expect(noRecord.kind).toBe("refused");
    if (noRecord.kind === "refused") {
      expect(noRecord.refused.code).toBe("intent_sender_evidence_unavailable");
      expect(noRecord.refused.message).toMatch(/evidence|capability record/i);
    }
    const otherConnection = compile({ senderCapabilityRecord: senderRecord({ connectionId: "conn-2" }) });
    expect(otherConnection.kind).toBe("refused");
    if (otherConnection.kind === "refused") {
      expect(otherConnection.refused.code).toBe("intent_sender_evidence_unavailable");
      expect(otherConnection.refused.message).toContain("conn-2");
    }
  });

  it("W6: Money glyph violations → intent_amount_invalid / intent_currency_invalid (decimal string, never float)", () => {
    for (const bad of ["1e5", "1,000", "-5", "12.5.0"]) {
      const outcome = compile({ draft: fullDraft({ amount: bad }) });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.refused.code).toBe("intent_amount_invalid");
    }
    for (const bad of ["usd", "EURO", "USDD", "us1"]) {
      const outcome = compile({ draft: fullDraft({ currency: bad }) });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.refused.code).toBe("intent_currency_invalid");
    }
  });

  it("W7: a rail the sender evidence does not allow → intent_rail_unsupported (preference never overrides evidence)", () => {
    const unevidenced = compile({ draft: fullDraft({ rail: { class: "card" } }) });
    expect(unevidenced.kind).toBe("refused");
    if (unevidenced.kind === "refused") {
      expect(unevidenced.refused.code).toBe("intent_rail_unsupported");
      expect(unevidenced.refused.message).toMatch(/never override/i);
    }
    const denied = compile({
      draft: fullDraft({ rail: { class: "card" } }),
      senderCapabilityRecord: withOperationRestriction(senderRecord(), "collections.read", {
        kind: "method",
        deny: ["card"],
        note: "provider method perimeter",
      }),
    });
    expect(denied.kind).toBe("refused");
    if (denied.kind === "refused") expect(denied.refused.code).toBe("intent_rail_unsupported");
    const allowed = compile({
      draft: fullDraft({ rail: { class: "card" } }),
      senderCapabilityRecord: withOperationRestriction(senderRecord(), "collections.read", {
        kind: "method",
        allow: ["card"],
        note: "provider method evidence",
      }),
    });
    expect(allowed.kind).toBe("intent");
    if (allowed.kind === "intent") expect(allowed.intent.rail).toEqual({ class: "card" });
  });

  it("W8: the registry keeps intents immutable — revision increments, history retained, frozen views, stale and duplicate declarations refused, unknown id → null", () => {
    const registry = createPayswapIntentRegistry();
    const first = registry.declare(builtIntent({ intentId: INTENT_ID, createdAt: "2026-11-26T12:00:00.000Z" }));
    expect(first.revision).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    const secondId = "01926f1a-7c3b-7e21-8a9b-4c1d2e3f4a5c";
    const second = registry.declare(builtIntent({ intentId: secondId, createdAt: "2026-11-26T12:00:01.000Z" }));
    expect(second.revision).toBe(2);
    expect(Object.isFrozen(second.recipient)).toBe(true);

    expect(() => registry.declare(builtIntent({ intentId: INTENT_ID, createdAt: "2026-11-26T12:00:02.000Z" })))
      .toThrow(/re-declaration/);
    expect(() => registry.declare(builtIntent({ intentId: "01926f1a-7c3b-7e21-8a9b-4c1d2e3f4a5d", createdAt: "2026-11-26T11:00:00.000Z" })))
      .toThrow(/stale declaration/);

    expect(registry.latest("01926f1a-7c3b-7e21-8a9b-ffffffffffff")).toBeNull();
    expect(registry.latest(INTENT_ID)?.intentId).toBe(INTENT_ID);
    expect(registry.history(INTENT_ID)).toHaveLength(1);
    expect(Object.isFrozen(registry.history(INTENT_ID))).toBe(true);
  });

  it("W9: no authority overflow — compiler and registry expose no route/mint/submit/ledger surface (structural assertion)", () => {
    for (const forbidden of ["route", "mint", "submit", "ledger", "connect", "authorize"]) {
      expect(compilePayswapIntent).not.toHaveProperty(forbidden);
      expect(createPayswapIntentRegistry).not.toHaveProperty(forbidden);
      expect(createPayswapIntentRegistry()).not.toHaveProperty(forbidden);
    }
  });

  it("the refusal closed set is exactly seven codes and kind membership is semantic (unknown kind → intent_kind_unknown)", () => {
    expect(PAYSWAP_INTENT_REFUSAL_CODES).toEqual([
      "intent_recipient_unverified",
      "intent_sender_evidence_unavailable",
      "intent_amount_invalid",
      "intent_currency_invalid",
      "intent_kind_unknown",
      "intent_rail_unsupported",
      "intent_operation_unsupported",
    ]);
    expect(PAYSWAP_INTENT_KINDS).toEqual(["send", "collect", "refund", "convert", "sweep", "review"]);
    const unknownKind = compile({ draft: fullDraft({ kind: "purchase" }) });
    expect(unknownKind.kind).toBe("refused");
    if (unknownKind.kind === "refused") expect(unknownKind.refused.code).toBe("intent_kind_unknown");
  });

  it("mapping v1: sweep → payouts.read, refund → payment_objects.read; convert/review → operation clarification unless an evidenced operation is nominated", () => {
    const sweep = compile({ draft: fullDraft({ kind: "sweep" }) });
    expect(sweep.kind).toBe("intent");
    if (sweep.kind === "intent") expect(sweep.intent.operation).toBe("payouts.read");
    const refund = compile({ draft: fullDraft({ kind: "refund" }) });
    expect(refund.kind).toBe("intent");
    if (refund.kind === "intent") expect(refund.intent.operation).toBe("payment_objects.read");

    const convert = compile({ draft: fullDraft({ kind: "convert" }) });
    expect(convert.kind).toBe("clarification");
    if (convert.kind === "clarification") {
      expect(convert.requests.map((r) => r.field)).toEqual(["operation"]);
    }
    const review = compile({ draft: fullDraft({ kind: "review" }) });
    expect(review.kind).toBe("clarification");

    const nominated = compile({ draft: fullDraft({ kind: "convert", operation: "payment_objects.read" }) });
    expect(nominated.kind).toBe("intent");
    if (nominated.kind === "intent") expect(nominated.intent.operation).toBe("payment_objects.read");
  });

  it("nominated and kind-mapped operations must be evidenced by the sender record (intent_operation_unsupported)", () => {
    const unevidencedNomination = compile({ draft: fullDraft({ kind: "send", operation: "charges.read" }) });
    expect(unevidencedNomination.kind).toBe("refused");
    if (unevidencedNomination.kind === "refused") {
      expect(unevidencedNomination.refused.code).toBe("intent_operation_unsupported");
      expect(unevidencedNomination.refused.message).toMatch(/nominated/i);
    }
    const payoutsOnly = senderRecord({ capabilities: [{ name: "payouts", status: "active" }] });
    const unmappedSend = compile({ draft: fullDraft({ kind: "send" }), senderCapabilityRecord: payoutsOnly });
    expect(unmappedSend.kind).toBe("refused");
    if (unmappedSend.kind === "refused") {
      expect(unmappedSend.refused.code).toBe("intent_operation_unsupported");
      expect(unmappedSend.refused.message).toMatch(/mapping v1/i);
    }
  });

  it("optional draft structure passes through: maxTotalCost, deadline, privacy, allowPartial, fxToleranceBps, minimumReliability", () => {
    const outcome = compile({
      draft: fullDraft({
        maxTotalCost: { value: "2.50", currency: "USD" },
        deadline: "2026-11-27T12:00:00.000Z",
        privacy: "minimize_disclosure",
        allowPartial: true,
        fxToleranceBps: 50,
        minimumReliability: 0.9,
      }),
    });
    expect(outcome.kind).toBe("intent");
    if (outcome.kind === "intent") {
      expect(outcome.intent.maxTotalCost).toEqual({ value: "2.50", currency: "USD" });
      expect(outcome.intent.deadline).toBe("2026-11-27T12:00:00.000Z");
      expect(outcome.intent.privacy).toBe("minimize_disclosure");
      expect(outcome.intent.allowPartial).toBe(true);
      expect(outcome.intent.fxToleranceBps).toBe(50);
      expect(outcome.intent.minimumReliability).toBe(0.9);
    }
  });
});
