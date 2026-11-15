/**
 * PaySwap P3.1 —— 协议契约法则的 services 侧证明（addendum §10 适配器边界 +
 * doc 12 §6 协议互操作；「Paystack, PayPal and protocol contracts」的协议半，
 * 架构师 2026-11-15 交接的 P3 开工第一条垂直切片）。
 *
 * 被测对象：`PAYSWAP_PROTOCOL_PIN_REGISTRY`（pinned 协议事实单一来源）与
 * `evaluatePayswapProtocolAdapterRegistration`（注册门）的法则行为：
 *
 * 1. **注册表不变量**：每个 pin 都有 https 官方源、可解析的 ISO 检索日期、
 *    非空已验证事实与非空再验证清单（清单空 = 消息面门已关 —— P3 开工时
 *    三个协议的门都还没关，如实）。
 * 2. **版本 pin 或如实缺席**：x402/mpp 的 versionPin 为 null（官方源未暴露
 *    可引用版本串 —— fail-closed：不猜版本）。
 * 3. **注册门闭集**：AP2 v0.2 与注册表一致 → registered；错误版本 →
 *    protocol_version_unsupported；x402/mpp（版本未验证）→
 *    protocol_version_unpinned；未注册协议 → protocol_not_registered。
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

  it("every pin carries an https official source, a parseable ISO retrieval date, verified facts and an open re-verification list", () => {
    for (const pin of PAYSWAP_PROTOCOL_PIN_REGISTRY.values()) {
      expect(pin.officialSourceUrl.startsWith("https://")).toBe(true);
      expect(ISO_DATE.test(pin.factsRetrievedAt)).toBe(true);
      expect(pin.verifiedBoundaryFacts.length).toBeGreaterThan(0);
      // P3 开工事实：三个协议的消息面再验证清单都未清空（适配器实现被挡）。
      expect(pin.reverifyBeforeAdapter.length).toBeGreaterThan(0);
    }
  });

  it("AP2 pins the v0.2 spec page; x402 and MPP honestly record an unverified version string", () => {
    expect(PAYSWAP_PROTOCOL_PIN_AP2.versionPin).toBe("v0.2");
    expect(PAYSWAP_PROTOCOL_PIN_AP2.officialSourceUrl).toBe("https://ap2-protocol.org/ap2/specification/");
    expect(PAYSWAP_PROTOCOL_PIN_X402.versionPin).toBeNull();
    expect(PAYSWAP_PROTOCOL_PIN_X402.officialSourceUrl).toBe("https://x402.org");
    expect(PAYSWAP_PROTOCOL_PIN_MPP.versionPin).toBeNull();
    expect(PAYSWAP_PROTOCOL_PIN_MPP.officialSourceUrl).toBe("https://stripe.com/blog/machine-payments-protocol");
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

  it("refuses adapters for protocols whose version string is not yet verified (never guess a version)", () => {
    for (const pin of [PAYSWAP_PROTOCOL_PIN_X402, PAYSWAP_PROTOCOL_PIN_MPP]) {
      const outcome = evaluatePayswapProtocolAdapterRegistration({
        protocolId: pin.protocolId,
        versionPin: "invented-v1",
        officialSourceUrl: pin.officialSourceUrl,
        factsRetrievedAt: pin.factsRetrievedAt,
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") {
        expect(outcome.refusal.code).toBe("protocol_version_unpinned");
      }
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

  it("refuses fact-source drift between descriptor and registry", () => {
    const outcome = evaluatePayswapProtocolAdapterRegistration({
      protocolId: "ap2",
      versionPin: "v0.2",
      officialSourceUrl: "https://mirror.invalid/ap2",
      factsRetrievedAt: "2026-11-15",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_version_unsupported");
    }
  });
});

describe("PAYSWAP_PROTOCOL_REFUSAL_CODES vocabulary (closed set)", () => {
  it("is the exact closed refusal vocabulary for the protocol boundary", () => {
    expect([...PAYSWAP_PROTOCOL_REFUSAL_CODES]).toEqual([
      "protocol_not_registered",
      "protocol_version_unpinned",
      "protocol_version_unsupported",
      "protocol_message_unverifiable",
      "protocol_feature_unsupported",
      "protocol_receipt_unavailable",
    ]);
  });
});
