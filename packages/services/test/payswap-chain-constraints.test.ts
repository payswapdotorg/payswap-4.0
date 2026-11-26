/**
 * PaySwap P4 wave 5 —— blockchain/wallet 约束证据的法则证明（shared CONTRACT
 * 「P4 wave 5」+ addendum §13 边界的 schema 层投影行）。
 *
 * 被测法则：
 * 1. **canonical network identity**：CAIP-2 对齐形状与字符串形；不发明链表。
 * 2. **address proof-of-control 只证明控制（§13.2）**：challenge 绑定必填；
 *    密钥材料字段 strict 拒绝；chainId 必须是 canonical 字符串形。
 * 3. **四族证据分立**：wallet 证据与 wave 3 三族互不充当、互不可变换。
 * 4. **chain 约束维度**：query constraints 接受该维度；通用逐维法则不变
 *    （unevidenced → 逐类 typed 拒绝；结构化 allow/deny 裁决）。
 * 5. **restriction kind "chain"**（结构化形）入闭集；未知 kind 照旧拒绝。
 * 6. **无权威外溢**：无 sign/submit/broadcast/adapter 面（结构断言）。
 */
import { describe, expect, it } from "vitest";
import {
  PAYSWAP_WALLET_EVIDENCE_SOURCES,
  payswapCanonicalChainIdOf,
  payswapCanonicalChainIdSchema,
  payswapChainNetworkRefSchema,
  payswapParticipantCapabilityEvidenceSchema,
  payswapSenderAccountRefSchema,
  payswapVerifiedRecipientEvidenceSchema,
  payswapWalletAddressControlEvidenceSchema,
  type PayswapWalletAddressControlEvidence,
} from "@zcode/shared/payswap";
import {
  createPayswapCapabilityRegistry,
  derivePayswapCapabilityRecord,
  evaluatePayswapEligibility,
  payswapCapabilityRestrictionSchema,
  payswapEligibilityConstraintsSchema,
  type PayswapCapabilityRecord,
  type PayswapEligibilityQuery,
} from "@zcode/services/node";

const NOW = "2026-11-26T12:00:00.000Z";

function stripeRecord(): PayswapCapabilityRecord {
  const registry = createPayswapCapabilityRegistry();
  const record = derivePayswapCapabilityRecord({
    providerId: "stripe",
    connectionId: "conn-1",
    outcome: {
      kind: "verified",
      providerAccountId: "acct_1",
      evidence: {
        capabilities: [
          { name: "card_payments", status: "active" },
          { name: "payouts", status: "active" },
        ],
        requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
      },
    },
    now: NOW,
  });
  if (record === null) throw new Error("stripe record derivation returned null");
  return registry.declare(record);
}

function withChainRestriction(
  base: PayswapCapabilityRecord,
  restriction: { kind: "chain"; allow?: string[]; deny?: string[]; note?: string },
): PayswapCapabilityRecord {
  return {
    ...base,
    operations: base.operations.map((op) =>
      op.operation === "collections.read"
        ? { ...op, restrictions: [...op.restrictions, restriction] }
        : op,
    ),
  };
}

function query(overrides: Partial<PayswapEligibilityQuery> = {}): PayswapEligibilityQuery {
  return {
    operation: "collections.read",
    connectionId: "conn-1",
    constraints: {},
    ...overrides,
  };
}

function walletEvidence(): PayswapWalletAddressControlEvidence {
  return {
    kind: "wallet-address-control",
    wallet: {
      address: "0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5",
      chainId: "eip155:1",
    },
    proof: {
      evidenceRef: "evd-wallet-1",
      source: "address-proof-of-control",
      verifiedAt: NOW,
      challengeId: "chal-0001",
    },
    freshnessBoundMs: 3_600_000,
  };
}

function recipientEvidence() {
  return {
    kind: "verified-recipient",
    recipientId: "rcpt-1",
    identity: {
      evidenceRef: "evd-rcpt-1",
      source: "verified-recipient-registry",
      verifiedAt: NOW,
    },
    acceptances: [{ rail: { class: "card" }, currency: "USD" }],
    freshnessBoundMs: 3_600_000,
  };
}

describe("payswap chain constraints (P4 wave 5) — the §13 boundary law", () => {
  it("W1: canonical network identity — CAIP-2-aligned shape and string form, no invented chain lists", () => {
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "eip155", reference: "1" }).success).toBe(true);
    expect(payswapCanonicalChainIdSchema.safeParse("eip155:1").success).toBe(true);
    expect(payswapCanonicalChainIdOf({ namespace: "eip155", reference: "1" })).toBe("eip155:1");
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "EIP155", reference: "1" }).success).toBe(false);
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "ab", reference: "1" }).success).toBe(false);
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "eip155", reference: "" }).success).toBe(false);
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "eip155", reference: "1", rogue: true }).success).toBe(false);
    expect(payswapCanonicalChainIdSchema.safeParse("1").success).toBe(false);
    expect(payswapCanonicalChainIdSchema.safeParse("eip155:").success).toBe(false);
  });

  it("W2: address proof-of-control is challenge-bound and carries no key material (§13.2)", () => {
    expect(payswapWalletAddressControlEvidenceSchema.safeParse(walletEvidence()).success).toBe(true);
    expect(
      payswapWalletAddressControlEvidenceSchema.safeParse({
        ...walletEvidence(),
        proof: {
          evidenceRef: "evd-wallet-1",
          source: "address-proof-of-control",
          verifiedAt: NOW,
        },
      }).success,
    ).toBe(false);
    expect(payswapWalletAddressControlEvidenceSchema.safeParse({ ...walletEvidence(), privateKey: "0xdeadbeef" }).success).toBe(false);
    expect(payswapWalletAddressControlEvidenceSchema.safeParse({ ...walletEvidence(), seedPhrase: "twelve words here" }).success).toBe(false);
    expect(payswapWalletAddressControlEvidenceSchema.safeParse({
      ...walletEvidence(),
      wallet: { ...walletEvidence().wallet, mnemonic: "twelve words here" },
    }).success).toBe(false);
    expect(payswapWalletAddressControlEvidenceSchema.safeParse({
      ...walletEvidence(),
      wallet: { ...walletEvidence().wallet, chainId: "1" },
    }).success).toBe(false);
    expect(PAYSWAP_WALLET_EVIDENCE_SOURCES).toEqual(["address-proof-of-control"]);
  });

  it("W3: four-family separation — wallet evidence is not sender/recipient/participant evidence, and none of the three is wallet evidence", () => {
    const wallet = walletEvidence();
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(wallet).success).toBe(false);
    expect(payswapSenderAccountRefSchema.safeParse(wallet).success).toBe(false);
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(wallet).success).toBe(false);
    expect(payswapWalletAddressControlEvidenceSchema.safeParse(recipientEvidence()).success).toBe(false);
  });

  it("W4: the chain constraint dimension rides the generic per-dimension law unchanged", () => {
    expect(payswapEligibilityConstraintsSchema.safeParse({ chain: "eip155:1" }).success).toBe(true);
    // 维度值面与其他维度同纪律（自由字符串）；canonical 字形由 payswapCanonicalChainIdSchema 承载（W1）。
    expect(payswapEligibilityConstraintsSchema.safeParse({ chain: "1" }).success).toBe(true);
    const unevidenced = evaluatePayswapEligibility({
      query: query({ constraints: { chain: "eip155:1" } }),
      record: stripeRecord(),
      now: NOW,
    });
    expect(unevidenced.kind).toBe("refused");
    if (unevidenced.kind === "refused") {
      expect(unevidenced.refused.code).toBe("eligibility_constraint_unevidenced");
      expect(unevidenced.refused.message).toMatch(/chain/i);
    }
    const denied = evaluatePayswapEligibility({
      query: query({ constraints: { chain: "eip155:137" } }),
      record: withChainRestriction(stripeRecord(), {
        kind: "chain",
        deny: ["eip155:137"],
        note: "provider chain perimeter",
      }),
      now: NOW,
    });
    expect(denied.kind).toBe("answer");
    if (denied.kind === "answer") {
      expect(denied.eligible).toBe(false);
      expect(denied.blockers.some((b) => b.kind === "chain" && (b.note ?? "").includes("chain perimeter"))).toBe(true);
    }
    const permitted = evaluatePayswapEligibility({
      query: query({ constraints: { chain: "eip155:1" } }),
      record: withChainRestriction(stripeRecord(), {
        kind: "chain",
        deny: ["eip155:137"],
      }),
      now: NOW,
    });
    expect(permitted.kind).toBe("answer");
    if (permitted.kind === "answer") expect(permitted.eligible).toBe(true);
  });

  it("W5: restriction kind \"chain\" joins the closed set in the structured form; unknown kinds stay rejected", () => {
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "chain", allow: ["eip155:1"] }).success).toBe(true);
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "chain", deny: ["eip155:137"], note: "provider chain perimeter" }).success).toBe(true);
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "teleport" }).success).toBe(false);
  });

  it("W6: no authority overflow — the chain module exposes no sign/submit/broadcast/adapter surface and no key-material fields", () => {
    for (const forbidden of ["sign", "submit", "broadcast", "route", "mint", "connect", "adapter"]) {
      expect(payswapCanonicalChainIdOf).not.toHaveProperty(forbidden);
      expect(payswapChainNetworkRefSchema).not.toHaveProperty(forbidden);
      expect(payswapWalletAddressControlEvidenceSchema).not.toHaveProperty(forbidden);
    }
    expect(payswapChainNetworkRefSchema.safeParse({ namespace: "eip155", reference: "1", privateKey: "x" }).success).toBe(false);
  });
});
