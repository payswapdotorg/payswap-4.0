/**
 * PaySwap P3.1 —— 协议契约法则的 services 侧证明（addendum §10 适配器边界 +
 * doc 12 §6 协议互操作；「Paystack, PayPal and protocol contracts」的协议半，
 * 架构师 2026-11-15 交接的 P3 开工第一条垂直切片）。
 *
 * 被测对象：`PAYSWAP_PROTOCOL_PIN_REGISTRY`（pinned 协议事实单一来源）与
 * `evaluatePayswapProtocolAdapterRegistration`（注册门）的法则行为：
 *
 * 1. **注册表不变量**：每个 pin 都有 https 官方源、可解析的 ISO 检索日期、
 *    非空已验证事实、再验证清单与显式不支持能力清单。
 * 2. **消息面实现门（法则 5）机器面**：`reverifyBeforeAdapter` 非空 = 该协议
 *    的消息面不得落地。2026-11-23 修正：MPP（PR #89）与 x402（PR #93）的消息
 *    面落地时清单仍非空 —— 注册表、本电池与源码树互相矛盾。未验证到的变体/
 *    spec 沉默行改记为 `unsupportedCapabilities`（每项带 typed refusal），
 *    三个已落地协议的再验证清单清空；本电池按「已落地消息面 ⇒ 清单必空」
 *    钉住，且注册门自身对非空清单拒绝（`protocol_reverify_pending`）。
 * 3. **版本 pin 或如实缺席**：三个协议均已 pin（AP2 v0.2 / x402 v2 / MPP
 *    draft-httpauth-payment-01，来源均为规范文档本体）；「版本未验证 →
 *    protocol_version_unpinned」的法则行为经合成注册表（null pin）继续
 *    证明 —— 法则不因当前三 pin 全绿而丢失证明面。
 * 4. **注册门闭集**：与注册表一致的描述符 → registered；错误版本 /
 *    事实源漂移 → protocol_version_unsupported；未注册协议 →
 *    protocol_not_registered；合成 null pin → protocol_version_unpinned；
 *    合成非空再验证清单 → protocol_reverify_pending。
 * 5. **事实源漂移拒绝**：描述符的 officialSourceUrl/factsRetrievedAt 与注册
 *    表不一致 → protocol_facts_drift（事实漂移 fail-closed）。
 * 6. **拒绝码闭集**：PAYSWAP_PROTOCOL_REFUSAL_CODES 是唯一词汇 —— 无带警告
 *    注册、无第三结局。
 */

import {
  PAYSWAP_LANDED_PROTOCOL_IDS,
  PAYSWAP_PROTOCOL_MESSAGE_FACE_FACTORIES,
  PAYSWAP_PROTOCOL_PIN_REGISTRY,
  PAYSWAP_PROTOCOL_PIN_AP2,
  PAYSWAP_PROTOCOL_PIN_MPP,
  PAYSWAP_PROTOCOL_PIN_X402,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  evaluatePayswapProtocolAdapterRegistration,
  type PayswapProtocolAdapterDescriptor,
  type PayswapProtocolPin,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

/**
 * 已落地的消息面 = 生产装配用的登记表本身（`protocol-faces.ts`，单一装配源）
 * —— 本电池不另抄一份，法则 5 对生产装配的每一个面逐个成立。
 */
const LANDED_MESSAGE_FACES = PAYSWAP_PROTOCOL_MESSAGE_FACE_FACTORIES;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("PAYSWAP_PROTOCOL_PIN_REGISTRY invariants (doc 04 §5 dated-evidence discipline)", () => {
  it("registers exactly the three P3 protocol pins (ap2, x402, mpp)", () => {
    expect([...PAYSWAP_PROTOCOL_PIN_REGISTRY.keys()].sort()).toEqual(["ap2", "mpp", "x402"]);
  });

  it("every pin carries an https official source, a parseable ISO retrieval date, verified facts, a re-verification list and an unsupported-capability list", () => {
    for (const pin of PAYSWAP_PROTOCOL_PIN_REGISTRY.values()) {
      expect(pin.officialSourceUrl.startsWith("https://")).toBe(true);
      expect(ISO_DATE.test(pin.factsRetrievedAt)).toBe(true);
      expect(pin.verifiedBoundaryFacts.length).toBeGreaterThan(0);
      expect(Array.isArray(pin.reverifyBeforeAdapter)).toBe(true);
      expect(Array.isArray(pin.unsupportedCapabilities)).toBe(true);
    }
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

  it("every protocol with a landed message face has an EMPTY re-verification list (contract law 5)", () => {
    // 法则 5：`reverifyBeforeAdapter` 未空 = 消息面实现不得落地。AP2 的消息面
    // 于 2026-11-21 清空清单后落地；MPP（#89）与 x402（#93）落地时清单仍非空
    // —— 与本电池当时的断言（length > 0）直接矛盾。修正后：三个已落地协议的
    // 清单必空，未验证到的变体改记 unsupportedCapabilities。
    for (const protocolId of PAYSWAP_LANDED_PROTOCOL_IDS) {
      const pin = PAYSWAP_PROTOCOL_PIN_REGISTRY.get(protocolId);
      expect(pin, `pin for ${protocolId}`).toBeDefined();
      expect(pin?.reverifyBeforeAdapter, `${protocolId} has a landed message face`).toEqual([]);
    }
  });

  it("unsupported capabilities are typed: each entry names a closed-vocabulary refusal or declares that no wire behavior is refused", () => {
    for (const pin of PAYSWAP_PROTOCOL_PIN_REGISTRY.values()) {
      for (const entry of pin.unsupportedCapabilities) {
        expect(entry.capability.length).toBeGreaterThan(0);
        expect(entry.officialStatus.length).toBeGreaterThan(0);
        if (entry.refusal !== null) {
          expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain(entry.refusal);
        }
      }
    }
    // x402：五个 spec-silent 行 + 未 pin 的 scheme/转账方法面（不可用，不是模拟）。
    expect(PAYSWAP_PROTOCOL_PIN_X402.unsupportedCapabilities.map((e) => e.refusal)).toEqual(
      expect.arrayContaining([
        null,
        "protocol_feature_unsupported",
      ]),
    );
    // MPP：未检索的 per-network 分册 —— 矩阵外组合 typed 拒绝。
    expect(PAYSWAP_PROTOCOL_PIN_MPP.unsupportedCapabilities.length).toBeGreaterThan(0);
    expect(
      PAYSWAP_PROTOCOL_PIN_MPP.unsupportedCapabilities.every(
        (e) => e.refusal === "protocol_feature_unsupported",
      ),
    ).toBe(true);
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

  it("refuses to register while the registry's re-verification list is non-empty (law 5 — proven on a synthetic registry)", () => {
    // 清单非空 = 注册表自述「消息面实现仍被挡」—— 注册门不得放行任何适配器
    // （不猜、不模拟）。以合成注册表孤立验证门本身，不碰生产注册表。
    const gatedPin: PayswapProtocolPin = {
      ...PAYSWAP_PROTOCOL_PIN_X402,
      reverifyBeforeAdapter: ["synthetic: an official fact is still unretrieved"],
    };
    const outcome = evaluatePayswapProtocolAdapterRegistration(
      {
        protocolId: "x402",
        versionPin: gatedPin.versionPin as string,
        officialSourceUrl: gatedPin.officialSourceUrl,
        factsRetrievedAt: gatedPin.factsRetrievedAt,
      },
      new Map([["x402", gatedPin] as const]),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("protocol_reverify_pending");
      expect(outcome.refusal.message).toContain("synthetic: an official fact is still unretrieved");
    }
  });

  it("every landed message face constructs against the production registry (gate is closed for all three)", () => {
    for (const protocolId of PAYSWAP_LANDED_PROTOCOL_IDS) {
      const pin = PAYSWAP_PROTOCOL_PIN_REGISTRY.get(protocolId);
      if (pin === undefined || pin.versionPin === null) throw new Error(`unpinned: ${protocolId}`);
      expect(() =>
        LANDED_MESSAGE_FACES[protocolId]({
          protocolId: pin.protocolId,
          versionPin: pin.versionPin,
          officialSourceUrl: pin.officialSourceUrl,
          factsRetrievedAt: pin.factsRetrievedAt,
        }),
      ).not.toThrow();
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
      "protocol_evidence_untrusted",
      "protocol_challenge_unknown",
      "protocol_challenge_expired",
      "protocol_challenge_consumed",
      "protocol_challenge_mismatch",
      "protocol_reverify_pending",
    ]);
  });
});
