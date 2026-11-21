/**
 * PaySwap P3 —— AP2 消息面法则电池（protocol-contract.ts 法则 1-5 的 AP2 实现
 * 证明；registry 法则 5 的实现许可 = AP2 reverifyBeforeAdapter 已清空 —— 第三批
 * 检索 2026-11-21 在案）。
 *
 * 被钉住的法则行（每行都是 pin 逐字纪律的机器面）：
 * 1. **注册门**：描述符与注册表 pin 一致才可创建；版本/事实源漂移 = 装配期
 *    throw（fail-loud，不存在带警告创建）。
 * 2. **vct 精确匹配**：四枚 pinned vct 之外的一切（未知版本、缺后缀）= typed
 *    拒绝（官方规范句「MUST match the exact vct string, including the version
 *    suffix」）。
 * 3. **字段闭集**：closed checkout mandate / delegation / receipt 的 pinned
 *    字段集之外的字段 = 未知形态 fail-closed；缺失必填 = 拒绝。
 * 4. **条件规则**：receipt 的 error/error_description 仅 Error、order_id 仅
 *    Success（pin 逐字）；open mandate 未知约束名 MUST 失败（官方规范句）。
 * 5. **错误码分类**：terminal（invalid_credential / invalid_mandate）与
 *    fallback-signal（unresolved_constraint / mandates_not_supported）二分在案；
 *    未知码 = null。
 * 6. **不可信提案纪律**：验证产物只有 kind/protocolId/versionPin/digest 四键
 *    —— 无任何金融权威字段（法则 1 的类型面证明）；同载荷同摘要、异载荷异摘要
 *    （证据链绑定）。
 * 7. **收据门**：evidence 缺席 = protocol_receipt_unavailable（协议 accepted
 *    ≠ 结算）；evidence 在场 = receipt-emitted。
 */

import {
  canonicalJsonStringify,
  createPayswapAp2MessageFace,
  PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS,
  PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES,
  PAYSWAP_AP2_VCT_VALUES,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  payswapAp2ActionAuthorizationErrorKind,
  type PayswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

const AP2_DESCRIPTOR: PayswapProtocolAdapterDescriptor = {
  protocolId: "ap2",
  versionPin: "v0.2",
  officialSourceUrl: "https://ap2-protocol.org/ap2/specification/",
  factsRetrievedAt: "2026-11-15",
};

const CLOSED_CHECKOUT_MANDATE = {
  vct: "mandate.checkout.1",
  checkout_jwt: "eyJhbGciOiJFUzI1NiJ9.e30.signature",
  checkout_hash: "xK9base64urlHashOfTheCheckoutJwtValue_",
};

function makeFace(descriptor: PayswapProtocolAdapterDescriptor = AP2_DESCRIPTOR) {
  return createPayswapAp2MessageFace(descriptor);
}

describe("AP2 message face — registration gate (law 4, assembly-time fail-loud)", () => {
  it("creates with a registry-consistent descriptor", () => {
    const face = makeFace();
    expect(face.descriptor.protocolId).toBe("ap2");
    expect(face.descriptor.versionPin).toBe("v0.2");
  });

  it("version drift refuses at assembly time (protocol_version_unsupported)", () => {
    expect(() =>
      makeFace({ ...AP2_DESCRIPTOR, versionPin: "v0.3" }),
    ).toThrow(/protocol_version_unsupported/);
  });

  it("fact-source drift refuses at assembly time (fact drift fail-closed)", () => {
    expect(() =>
      makeFace({ ...AP2_DESCRIPTOR, factsRetrievedAt: "2026-11-20" }),
    ).toThrow(/protocol_version_unsupported/);
  });

  it("unknown protocol id refuses at assembly time (protocol_not_registered)", () => {
    expect(() =>
      makeFace({
        ...AP2_DESCRIPTOR,
        protocolId: "unknown-protocol" as PayswapProtocolAdapterDescriptor["protocolId"],
      }),
    ).toThrow(/protocol_not_registered/);
  });
});

describe("AP2 message face — translateInbound mandate (vct exact-match + field closure)", () => {
  it("closed checkout mandate passes → verified-inbound proposal (digest only)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: CLOSED_CHECKOUT_MANDATE,
    });
    expect(outcome.kind).toBe("verified-inbound");
    if (outcome.kind !== "verified-inbound") return;
    // 法则 2 的类型面证明：产物恰四键 —— 无任何金融权威字段。
    expect(Object.keys(outcome).sort()).toEqual([
      "kind",
      "protocolId",
      "untrustedPayloadDigest",
      "versionPin",
    ]);
    expect(outcome.protocolId).toBe("ap2");
    expect(outcome.versionPin).toBe("v0.2");
    expect(outcome.untrustedPayloadDigest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("unknown vct version refuses (exact-match law: mandate.checkout.2)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...CLOSED_CHECKOUT_MANDATE, vct: "mandate.checkout.2" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain(outcome.refusal.code);
  });

  it("suffix-less vct refuses (the version suffix is part of the exact match)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...CLOSED_CHECKOUT_MANDATE, vct: "mandate.checkout" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("missing checkout_jwt refuses (pinned required field)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { vct: "mandate.checkout.1", checkout_hash: "hash" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("unknown extra field refuses (field closure — fail-closed on unknown shapes)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...CLOSED_CHECKOUT_MANDATE, grand_total_usd: "1.00" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("iat/exp optional (pinned: required=No)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...CLOSED_CHECKOUT_MANDATE, iat: 1763640000, exp: 1763726400 },
    });
    expect(outcome.kind).toBe("verified-inbound");
  });

  it("open checkout mandate with pinned constraints passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        constraints: {
          allowed_merchants: { type: "checkout.allowed_merchants", allowed: [{ id: "m1" }] },
          line_items: {
            type: "checkout.line_items",
            items: [{ id: "sku-1", acceptable_items: ["sku-1a"], quantity: 1 }],
          },
        },
      },
    });
    expect(outcome.kind).toBe("verified-inbound");
  });

  it("unknown constraint name MUST fail (official normative sentence)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        constraints: {
          currency_whitelist: { type: "checkout.currency_whitelist", allowed: ["GHS"] },
        },
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("currency_whitelist");
  });

  it("constraint sub-field drift refuses (pinned allowed_merchants/line_items shapes)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        constraints: {
          allowed_merchants: { type: "checkout.allowed_merchants" },
        },
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("payment mandate: pinned field-name set honored, unknown field refuses", async () => {
    const face = makeFace();
    const ok = await face.translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.payment.1",
        currency: "GHS",
        payment_amount: "15000",
        payee: "merchant-1",
        _sd_alg: "sha-256",
      },
    });
    expect(ok.kind).toBe("verified-inbound");
    const unknown = await face.translateInbound({
      ap2Kind: "mandate",
      payload: { vct: "mandate.payment.1", wire_routing: "unknown-field" },
    });
    expect(unknown.kind).toBe("refused");
    if (unknown.kind !== "refused") return;
    expect(unknown.refusal.code).toBe("protocol_message_unverifiable");
    expect(unknown.refusal.message).toContain("wire_routing");
  });

  it("unknown ap2Kind routing label refuses (fail-closed dispatch)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "intent-compiler",
      payload: {},
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("AP2 message face — delegation object (pinned field-level schema)", () => {
  const DELEGATION = {
    type: "delegate",
    format: "dc+sd-jwt",
    delegate_payload: [{ vct: "mandate.checkout.1" }],
  };

  it("pinned shape passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "delegation",
      payload: DELEGATION,
    });
    expect(outcome.kind).toBe("verified-inbound");
  });

  it("wrong type value refuses (type MUST be the string value \"delegate\")", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "delegation",
      payload: { ...DELEGATION, type: "delegate-v2" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("empty delegate_payload refuses (REQUIRED array)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "delegation",
      payload: { ...DELEGATION, delegate_payload: [] },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("unknown extra field refuses (strict closure)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "delegation",
      payload: { ...DELEGATION, delegate_signature: "claimed" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("AP2 message face — receipt conditionals (pinned only-when rules)", () => {
  const SUCCESS_RECEIPT = { status: "Success", iss: "merchant-1", iat: 1763640000, reference: "hashRef" };

  it("Success receipt with order_id passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "receipt",
      payload: { ...SUCCESS_RECEIPT, order_id: "order-77" },
    });
    expect(outcome.kind).toBe("verified-inbound");
  });

  it("Error receipt without error refuses (only when Error)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "receipt",
      payload: { ...SUCCESS_RECEIPT, status: "Error" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("only when Error");
  });

  it("Error receipt with order_id refuses (order_id only when Success)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "receipt",
      payload: { ...SUCCESS_RECEIPT, status: "Error", error: "invalid_mandate", order_id: "order-77" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("Success receipt with error refuses (error only when Error)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "receipt",
      payload: { ...SUCCESS_RECEIPT, error: "invalid_credential" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("AP2 message face — pinned vocabularies", () => {
  it("vct set is exactly the four pinned values", () => {
    expect([...PAYSWAP_AP2_VCT_VALUES]).toEqual([
      "mandate.checkout.1",
      "mandate.checkout.open.1",
      "mandate.payment.1",
      "mandate.payment.open.1",
    ]);
  });

  it("action-authorization error codes carry the pinned terminal/fallback classification", () => {
    expect(payswapAp2ActionAuthorizationErrorKind("invalid_credential")).toBe("terminal");
    expect(payswapAp2ActionAuthorizationErrorKind("invalid_mandate")).toBe("terminal");
    expect(payswapAp2ActionAuthorizationErrorKind("unresolved_constraint")).toBe("fallback-signal");
    expect(payswapAp2ActionAuthorizationErrorKind("mandates_not_supported")).toBe("fallback-signal");
    expect(payswapAp2ActionAuthorizationErrorKind("unknown_code")).toBe(null);
    expect(PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS).toHaveLength(4);
  });

  it("checkout constraint name closure is exactly the two pinned constraints", () => {
    expect([...PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES]).toEqual(["allowed_merchants", "line_items"]);
  });
});

describe("AP2 message face — digest binding + receipt gate (laws 2/3)", () => {
  it("same payload → same digest; different payload → different digest", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ ap2Kind: "mandate", payload: CLOSED_CHECKOUT_MANDATE });
    const b = await face.translateInbound({ ap2Kind: "mandate", payload: CLOSED_CHECKOUT_MANDATE });
    const c = await face.translateInbound({
      ap2Kind: "mandate",
      payload: { ...CLOSED_CHECKOUT_MANDATE, exp: 1763726400 },
    });
    if (a.kind !== "verified-inbound" || b.kind !== "verified-inbound" || c.kind !== "verified-inbound") {
      throw new Error("expected verified-inbound");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
    expect(a.untrustedPayloadDigest).not.toBe(c.untrustedPayloadDigest);
  });

  it("digest is stable across JSON key ordering (canonical JSON, RFC 8785)", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ ap2Kind: "mandate", payload: CLOSED_CHECKOUT_MANDATE });
    const reordered = {
      checkout_hash: CLOSED_CHECKOUT_MANDATE.checkout_hash,
      vct: CLOSED_CHECKOUT_MANDATE.vct,
      checkout_jwt: CLOSED_CHECKOUT_MANDATE.checkout_jwt,
    };
    const b = await face.translateInbound({ ap2Kind: "mandate", payload: reordered });
    if (a.kind !== "verified-inbound" || b.kind !== "verified-inbound") {
      throw new Error("expected verified-inbound");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
  });

  it("emitReceipt(null) refuses protocol_receipt_unavailable (protocol accepted ≠ settlement)", async () => {
    const outcome = await makeFace().emitReceipt(null);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_receipt_unavailable");
    expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain(outcome.refusal.code);
  });

  it("emitReceipt with verified evidence → receipt-emitted (exact keys, no financial authority)", async () => {
    const outcome = await makeFace().emitReceipt("ledger://evidence/settlement-1");
    expect(outcome.kind).toBe("receipt-emitted");
    if (outcome.kind !== "receipt-emitted") return;
    expect(Object.keys(outcome).sort()).toEqual([
      "kind",
      "protocolId",
      "settlementEvidenceRef",
      "versionPin",
    ]);
  });

  it("canonical JSON serialization is deterministic for the mandate payload", () => {
    const a = canonicalJsonStringify(CLOSED_CHECKOUT_MANDATE);
    const b = canonicalJsonStringify({ ...CLOSED_CHECKOUT_MANDATE });
    expect(a).toBe(b);
    expect(a).not.toContain(" ");
  });
});
