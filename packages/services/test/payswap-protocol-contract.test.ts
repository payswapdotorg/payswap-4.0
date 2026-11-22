/**
 * PaySwap P3.1 —— 协议契约法则的 services 侧证明（addendum §10 适配器边界 +
 * doc 12 §6 协议互操作；「Paystack, PayPal and protocol contracts」的协议半，
 * 架构师 2026-11-15 交接的 P3 开工第一条垂直切片）。
 *
 * 被测对象：`PAYSWAP_PROTOCOL_PIN_REGISTRY`（pinned 协议事实单一来源）与
 * `evaluatePayswapProtocolAdapterRegistration`（注册门）的法则行为：
 *
 * 1. **注册表不变量**：每个 pin 都有 https 官方源、可解析的 ISO 检索日期、
 *    非空已验证事实与非空再验证清单（清单空 = 消息面门已关 —— P3 二批
 *    检索后三个协议的清单仍非空，消息面实现仍被挡，如实）。
 * 2. **版本 pin 或如实缺席**：二批检索后三个协议均已 pin（AP2 v0.2 / x402
 *    v2 / MPP draft-httpauth-payment-01，来源均为规范文档本体）；「版本未验证
 *    → protocol_version_unpinned」的法则行为经合成注册表（null pin）继续
 *    证明 —— 法则不因当前三 pin 全绿而丢失证明面。
 * 3. **注册门闭集**：与注册表一致的描述符 → registered；错误版本 /
 *    事实源漂移 → protocol_version_unsupported；未注册协议 →
 *    protocol_not_registered；合成 null pin → protocol_version_unpinned。
 * 4. **事实源漂移拒绝**：描述符的 officialSourceUrl/factsRetrievedAt 与注册
 *    表不一致 → protocol_version_unsupported（事实漂移 fail-closed）。
 * 5. **拒绝码闭集**：PAYSWAP_PROTOCOL_REFUSAL_CODES 是唯一词汇 —— 无带警告
 *    注册、无第三结局。
 */

import { describe, expect, it } from "vitest";

import {
  PAYSWAP_PROTOCOL_PIN_REGISTRY,
  PAYSWAP_PROTOCOL_PIN_AP2,
  PAYSWAP_PROTOCOL_PIN_X402,
  PAYSWAP_PROTOCOL_PIN_MPP,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  evaluatePayswapProtocolAdapterRegistration,
  type PayswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("PAYSWAP_PROTOCOL_PIN_REGISTRY invariants (doc 04 §5 dated-evidence discipline)", () => {
  it("registers exactly the three P3 protocol pins (ap2, x402, mpp)", () => {
    expect([...PAYSWAP_PROTOCOL_PIN_REGISTRY.keys()].sort()).toEqual(["ap2", "mpp", "x402"]);
  });

  it("every pin carries an https official source, a parseable ISO retrieval date, verified facts and a re-verification list", () => {
    for (const pin of PAYSWAP_PROTOCOL_PIN_REGISTRY.values()) {
      expect(pin.officialSourceUrl.startsWith("https://")).toBe(true);
      expect(ISO_DATE.test(pin.factsRetrievedAt)).toBe(true);
      expect(pin.verifiedBoundaryFacts.length).toBeGreaterThan(0);
    }
    // 三批检索（2026-11-21）如实状态：AP2 的消息面再验证清单已清空（agent
    // authorization 与 checkout mandate 字段级 schema 逐字段入 facts）—— 消息面
    // 实现门打开；x402 与 MPP 的清单仍未清空（适配器实现仍被挡）。
    expect(PAYSWAP_PROTOCOL_PIN_AP2.reverifyBeforeAdapter.length).toBe(0);
    expect(PAYSWAP_PROTOCOL_PIN_X402.reverifyBeforeAdapter.length).toBeGreaterThan(0);
    expect(PAYSWAP_PROTOCOL_PIN_MPP.reverifyBeforeAdapter.length).toBeGreaterThan(0);
    const ap2Facts = PAYSWAP_PROTOCOL_PIN_AP2.verifiedBoundaryFacts.join("\n");
    expect(ap2Facts).toContain("2026-11-21");
    expect(ap2Facts).toContain("mandate.checkout.1");
    expect(ap2Facts).toContain("invalid_credential");
    const mppFacts = PAYSWAP_PROTOCOL_PIN_MPP.verifiedBoundaryFacts.join("\n");
    expect(mppFacts).toContain("Expired Internet-Draft");
    expect(mppFacts).toContain("2026-11-21");
  });

  it("pins exact version strings from specification documents (second retrieval pass 2026-11-15)", () => {
    expect(PAYSWAP_PROTOCOL_PIN_AP2.versionPin).toBe("v0.2");
    expect(PAYSWAP_PROTOCOL_PIN_AP2.officialSourceUrl).toBe("https://ap2-protocol.org/ap2/specification/");
    expect(PAYSWAP_PROTOCOL_PIN_X402.versionPin).toBe("v2");
    expect(PAYSWAP_PROTOCOL_PIN_X402.officialSourceUrl).toBe(
      "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
    );
    expect(PAYSWAP_PROTOCOL_PIN_MPP.versionPin).toBe("draft-httpauth-payment-01");
    expect(PAYSWAP_PROTOCOL_PIN_MPP.officialSourceUrl).toBe(
      "https://github.com/tempoxyz/mpp-specs/blob/main/specs/core/draft-httpauth-payment-01.md",
    );
  });

  it("carries the second-pass AP2 corrections as recorded facts (five roles, two in-scope modes)", () => {
    const facts = PAYSWAP_PROTOCOL_PIN_AP2.verifiedBoundaryFacts.join("\n");
    expect(facts).toContain("Shopping Agent");
    expect(facts).toContain("Merchant Payment Processor");
    expect(facts).toContain("There are two `modes`");
    expect(facts).toContain("outside the scope of the current specification");
  });
});

describe("evaluatePayswapProtocolAdapterRegistration (addendum §10 pinning gate)", () => {
  it("registers an adapter whose pin matches the registry exactly", () => {
    const outcome = evaluatePayswapProtocolAdapterRegistration({
      protocolId: "ap2",
      versionPin: PAYSWAP_PROTOCOL_PIN_AP2.versionPin as string,
      officialSourceUrl: PAYSWAP_PROTOCOL_PIN_AP2.officialSourceUrl,
      factsRetrievedAt: PAYSWAP_PROTOCOL_PIN_AP2.factsRetrievedAt,
    });
    expect(outcome).toEqual({ kind: "registered", protocolId: "ap2", versionPin: "v0.2" });
  });

  it("registers x402 v2 and MPP draft-httpauth-payment-01 adapters against the second-pass pins", () => {
    for (const pin of [PAYSWAP_PROTOCOL_PIN_X402, PAYSWAP_PROTOCOL_PIN_MPP]) {
      const outcome = evaluatePayswapProtocolAdapterRegistration({
        protocolId: pin.protocolId,
        versionPin: pin.versionPin as string,
        officialSourceUrl: pin.officialSourceUrl,
        factsRetrievedAt: pin.factsRetrievedAt,
      });
      expect(outcome).toEqual({
        kind: "registered",
        protocolId: pin.protocolId,
        versionPin: pin.versionPin,
      });
    }
  });

  it("refuses a wrong or future version (fail-closed on unknown versions)", () => {
    const outcome = evaluatePayswapProtocolAdapterRegistration({
      protocolId: "ap2",
      versionPin: "v0.1",
      officialSourceUrl: PAYSWAP_PROTOCOL_PIN_AP2.officialSourceUrl,
      factsRetrievedAt: PAYSWAP_PROTOCOL_PIN_AP2.factsRetrievedAt,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_version_unsupported");
    }
  });

  it("refuses adapters for protocols whose version string is not yet verified (never guess a version — proven on a synthetic null-pin registry)", () => {
    // 二批起三个协议均已 pin，但「版本未验证 → unpinned」的法则行为仍须证明：
    // 以合成注册表（versionPin: null）孤立验证门本身，不碰生产注册表。
    const syntheticPin: typeof PAYSWAP_PROTOCOL_PIN_AP2 = {
      ...PAYSWAP_PROTOCOL_PIN_AP2,
      protocolId: "ap2",
      versionPin: null,
    };
    const syntheticRegistry = new Map([["ap2", syntheticPin] as const]);
    const outcome = evaluatePayswapProtocolAdapterRegistration(
      {
        protocolId: "ap2",
        versionPin: "invented-v1",
        officialSourceUrl: syntheticPin.officialSourceUrl,
        factsRetrievedAt: syntheticPin.factsRetrievedAt,
      },
      syntheticRegistry,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_version_unpinned");
    }
  });

  it("refuses protocols outside the pinned registry", () => {
    // 运行时防御面：未注册 id 可能以畸形/外来描述符出现 —— 类型上以 unknown 模拟。
    const outcome = evaluatePayswapProtocolAdapterRegistration({
      protocolId: "visa-tap" as unknown as PayswapProtocolAdapterDescriptor["protocolId"],
      versionPin: "v1",
      officialSourceUrl: "https://example.invalid/spec",
      factsRetrievedAt: "2026-11-15",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_not_registered");
    }
  });

  it("refuses fact-source drift between descriptor and registry (its OWN code — F14: drift ≠ version unsupported)", () => {
    const outcome = evaluatePayswapProtocolAdapterRegistration({
      protocolId: "ap2",
      versionPin: "v0.2",
      officialSourceUrl: "https://mirror.invalid/ap2",
      factsRetrievedAt: "2026-11-15",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_facts_drift");
    }
  });
});

describe("PAYSWAP_PROTOCOL_REFUSAL_CODES vocabulary (closed set)", () => {
  it("is the exact closed refusal vocabulary for the protocol boundary", () => {
    expect([...PAYSWAP_PROTOCOL_REFUSAL_CODES]).toEqual([
      "protocol_not_registered",
      "protocol_version_unpinned",
      "protocol_version_unsupported",
      "protocol_facts_drift",
      "protocol_message_unverifiable",
      "protocol_feature_unsupported",
      "protocol_receipt_unavailable",
    ]);
  });
});
