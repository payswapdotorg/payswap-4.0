/**
 * PaySwap P4 wave 3 —— 支付参与方能力证据的法则证明（shared CONTRACT
 * 「P4 支付参与方能力证据」+ doc 12 §3 + doc 06 §2.1 + P4 验收的三族分立行）。
 *
 * 被测法则：
 * 1. **三族证据分立**：sender = wave 1 记录引用；recipient/participant = 本模块
 *    schema；wave 1 能力记录在 schema 层不可变换为任何参与方记录（R10）。
 * 2. **verified-recipient**：无证据三元组的记录不可表达（用户/模型声明单独在场
 *    = 拒绝，R3）；acceptance rail 类别闭集（R4）。
 * 3. **participant**：恰四类字段，marketplace 字段 strict 拒绝（R5）；financialRole
 *    闭集排除 sender/recipient（R6）；availability 无证据即拒绝（R7）。
 * 4. **Money/rail/purpose 字形**：decimal string 永不 float（R1/R2）；purpose 闭集
 *    且 freeText 永不改变裁决面（R8）。
 * 5. **无权威外溢**：模块无 grant/mint/submit/route/ledger/connect 面，无凭据字段
 *    （R9 结构断言）。
 * 6. **新鲜度**：verifiedAt + bound ≥ now → fresh；否则 stale；malformed = stale
 *    不抛错（R12）。
 */

import { describe, expect, it } from "vitest";
import * as payswapShared from "@zcode/shared/payswap";
import {
  PAYSWAP_PARTICIPANT_FINANCIAL_ROLES,
  PAYSWAP_PAYMENT_RAIL_CLASSES,
  PAYSWAP_PURPOSE_CODES,
  payswapIsoDateTimeSchema,
  payswapMoneyNonNegativeSchema,
  payswapMoneySchema,
  payswapParticipantAvailabilitySchema,
  payswapParticipantCapabilityEvidenceSchema,
  payswapPartyEvidenceFreshness,
  payswapPaymentRailRefSchema,
  payswapPurposeCodeSchema,
  payswapSenderAccountRefSchema,
  payswapVerifiedRecipientEvidenceSchema,
} from "@zcode/shared/payswap";

const NOW = "2026-11-25T18:00:00.000Z";

function verifiedRecipient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "verified-recipient",
    recipientId: "rcpt-1",
    identity: {
      displayName: "Acme Ltd",
      evidenceRef: "inmem:rr-1",
      source: "verified-recipient-registry",
      verifiedAt: NOW,
    },
    acceptances: [{ rail: { class: "bank", detail: "psp:stripe:sepa_credit" } }],
    freshnessBoundMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function participant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "participant-capability",
    participantId: "part-1",
    financialRole: "rail_bridge",
    verifiedCapability: {
      evidenceRef: "inmem:pc-1",
      source: "participant-account-evidence",
      verifiedAt: NOW,
    },
    authority: { scope: "route-legs", maxAmount: { value: "500000", currency: "GHS" } },
    availability: { status: "available", evidenceRef: "inmem:pc-1", observedAt: NOW },
    freshnessBoundMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("payswap payment parties (P4 wave 3) — the evidence law", () => {
  it("R1: Money accepts decimal strings and ISO-4217 uppercase currency; rejects floats-in-disguise, separators, blanks, lowercase", () => {
    expect(payswapMoneySchema.safeParse({ value: "12.34", currency: "GHS" }).success).toBe(true);
    expect(payswapMoneySchema.safeParse({ value: "0", currency: "USD" }).success).toBe(true);
    expect(payswapMoneySchema.safeParse({ value: "1e5", currency: "GHS" }).success).toBe(false);
    expect(payswapMoneySchema.safeParse({ value: "1,000", currency: "GHS" }).success).toBe(false);
    expect(payswapMoneySchema.safeParse({ value: " 5", currency: "GHS" }).success).toBe(false);
    expect(payswapMoneySchema.safeParse({ value: "", currency: "GHS" }).success).toBe(false);
    expect(payswapMoneySchema.safeParse({ value: "12", currency: "usd" }).success).toBe(false);
    expect(payswapMoneySchema.safeParse({ value: "12", currency: "EURO" }).success).toBe(false);
  });

  it("R2: intent amounts and maxTotalCost reject negative values", () => {
    expect(payswapMoneyNonNegativeSchema.safeParse({ value: "-1", currency: "GHS" }).success).toBe(false);
    expect(payswapMoneyNonNegativeSchema.safeParse({ value: "0", currency: "GHS" }).success).toBe(true);
  });

  it("R3: a verified-recipient record without its evidence triple is unrepresentable — user/model claims alone are insufficient", () => {
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(verifiedRecipient()).success).toBe(true);
    const noEvidence = verifiedRecipient({
      identity: { displayName: "Claimed by model" },
    });
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(noEvidence).success).toBe(false);
    const unverifiableTime = verifiedRecipient({
      identity: {
        displayName: "Acme Ltd",
        evidenceRef: "inmem:rr-1",
        source: "verified-recipient-registry",
        verifiedAt: "not-a-timestamp",
      },
    });
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(unverifiableTime).success).toBe(false);
    // 畸形时刻在共用字形上即拒
    expect(payswapIsoDateTimeSchema.safeParse("2026-13-45T99:00:00Z").success).toBe(false);
  });

  it("R4: recipient acceptance rail classes are a closed set; blockchain requires a namespaced detail", () => {
    expect(Object.values(PAYSWAP_PAYMENT_RAIL_CLASSES).sort()).toEqual(
      ["bank", "blockchain", "card", "cash", "mobile_money", "psp_internal", "wallet"].sort(),
    );
    expect(payswapPaymentRailRefSchema.safeParse({ class: "carrier_pigeon" }).success).toBe(false);
    expect(
      payswapPaymentRailRefSchema.safeParse({ class: "blockchain" }).success,
    ).toBe(false);
    expect(
      payswapPaymentRailRefSchema.safeParse({ class: "blockchain", detail: "chain:ethereum:usdt" }).success,
    ).toBe(true);
    const emptyAcceptances = verifiedRecipient({ acceptances: [] });
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(emptyAcceptances).success).toBe(false);
  });

  it("R5: participant descriptors reject marketplace fields via strict schemas", () => {
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(participant()).success).toBe(true);
    const marketplace = participant({ name: "Acme Rails", reputation: 4.9, rating: 5, listingUrl: "https://example.test/acme" });
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(marketplace).success).toBe(false);
    const freeDescription = participant({ description: "a trusted rail bridge partner" });
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(freeDescription).success).toBe(false);
  });

  it("R6: participant financialRole is a closed set that excludes sender/recipient — intent parties are not participants", () => {
    expect([...PAYSWAP_PARTICIPANT_FINANCIAL_ROLES].sort()).toEqual(["rail_bridge", "settlement_participant"].sort());
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(participant({ financialRole: "sender" })).success).toBe(false);
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(participant({ financialRole: "recipient" })).success).toBe(false);
  });

  it("R7: participant availability without evidence is unrepresentable", () => {
    const noEvidence = participant({
      availability: { status: "available" },
    });
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(noEvidence).success).toBe(false);
    expect(
      payswapParticipantAvailabilitySchema.safeParse({ status: "available", evidenceRef: "x", observedAt: "bad" }).success,
    ).toBe(false);
  });

  it("R8: purpose codes are a closed set; freeText never changes the adjudication surface (code only)", () => {
    expect(PAYSWAP_PURPOSE_CODES).toContain("other");
    expect(payswapPurposeCodeSchema.safeParse({ code: "family_support" }).success).toBe(true);
    expect(payswapPurposeCodeSchema.safeParse({ code: "vacation" }).success).toBe(false);
    expect(payswapPurposeCodeSchema.safeParse({ code: "other", freeText: "school fees" }).success).toBe(true);
    const parsed = payswapPurposeCodeSchema.parse({ code: "other", freeText: "school fees" });
    expect(parsed.code).toBe("other");
    expect(parsed.freeText).toBe("school fees");
  });

  it("R9: no authority spillover — the module exposes no grant/mint/submit/route/ledger/connect face and no secret-bearing field", () => {
    // 结构断言（wave 1/2 同款）：本文件导出面不含权威动词；schema 键不含秘密键形态。
    const exportedNames = Object.keys(payswapShared).filter((name) =>
      /^payswap(Party|Sender|Recipient|Participant|Payment|Purpose|Money|Iso)/.test(name),
    );
    for (const forbidden of ["grant", "mint", "submit", "route", "ledger", "connect", "authorize"]) {
      expect(exportedNames.some((n) => n.toLowerCase().includes(forbidden))).toBe(false);
    }
    const secretKeys = ["secret", "apiKey", "api_key", "token", "password", "clientSecret"];
    const walk = (value: unknown, depth = 0): void => {
      if (value === null || typeof value !== "object" || depth > 4) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        expect(secretKeys.some((s) => key.toLowerCase().includes(s))).toBe(false);
        walk(child, depth + 1);
      }
    };
    walk(payswapVerifiedRecipientEvidenceSchema.shape);
    walk(payswapParticipantCapabilityEvidenceSchema.shape);
    walk(payswapSenderAccountRefSchema.shape);
  });

  it("R10: a wave-1 capability record is not transformable into any party record — three evidence families are separate", () => {
    const capabilityRecordShape = {
      providerId: "stripe",
      connectionId: "conn-1",
      schemaVersion: 1,
      revision: 2,
      declaredAt: NOW,
      evidence: { kind: "read-back", outcomeKind: "verified", providerAccountId: "acct_1", hasCapabilityEvidence: true },
      operations: [{ operation: "balances.read", status: "available", restrictions: [] }],
    };
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(capabilityRecordShape).success).toBe(false);
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(capabilityRecordShape).success).toBe(false);
    // sender 引用必须绑定 principal + revision —— 裸连接形状不可充当 sender 证据
    expect(
      payswapSenderAccountRefSchema.safeParse({ connectionId: "conn-1", providerId: "stripe" }).success,
    ).toBe(false);
  });

  it("R11: strictness — unknown extra keys are rejected on every party schema", () => {
    expect(payswapMoneySchema.safeParse({ value: "1", currency: "GHS", note: "extra" }).success).toBe(false);
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(verifiedRecipient({ extra: true })).success).toBe(false);
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(participant({ extra: true })).success).toBe(false);
    expect(payswapPurposeCodeSchema.safeParse({ code: "other", note: "extra" }).success).toBe(false);
  });

  it("R12: freshness helper — verifiedAt + bound >= now is fresh, older is stale, malformed is stale (never throws)", () => {
    expect(payswapPartyEvidenceFreshness({ verifiedAt: NOW, freshnessBoundMs: 60000 }, "2026-11-25T18:00:30.000Z")).toBe("fresh");
    expect(payswapPartyEvidenceFreshness({ verifiedAt: NOW, freshnessBoundMs: 60000 }, "2026-11-25T18:02:00.000Z")).toBe("stale");
    expect(payswapPartyEvidenceFreshness({ observedAt: NOW, freshnessBoundMs: 60000 }, "2026-11-25T18:00:30.000Z")).toBe("fresh");
    expect(payswapPartyEvidenceFreshness({ verifiedAt: "not-a-timestamp", freshnessBoundMs: 60000 }, NOW)).toBe("stale");
    expect(payswapPartyEvidenceFreshness({ verifiedAt: NOW, freshnessBoundMs: 60000 }, "also-bad")).toBe("stale");
  });
});
