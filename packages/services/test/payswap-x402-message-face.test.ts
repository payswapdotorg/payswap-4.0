/**
 * PaySwap P3 —— x402 消息面法则电池（supported subset —— 五个 spec-silent
 * 行的处分结论允许本面落地）。
 *
 * 被钉住的法则行：
 * 1. **注册门**：描述符与 x402 pin（v2）一致才可创建。
 * 2. **PaymentRequired**：x402Version=2、resource.url REQUIRED、accepts 非空
 *    （scheme/network/amount/asset/payTo/maxTimeoutSeconds REQUIRED）。
 * 3. **PaymentPayload**：x402Version=2、accepted REQUIRED、payload REQUIRED；
 *    validAfter < validBefore 结构校验（Row 1 处分）；nonce 在案（Row 2 处分）。
 * 4. **SettlementResponse**：transaction MUST 非空 when settlement_pending
 *    （Row 5 处分）。
 * 5. **不可信提案术语**：`validated-untrusted-proposal`；产物恰四键。
 * 6. **收据证据门**：emitReceipt 只接受宿主签发的 settled-verified 证据对象。
 */

import {
  canonicalJsonStringify,
  createPayswapX402MessageFace,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  type PayswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

const X402_DESCRIPTOR: PayswapProtocolAdapterDescriptor = {
  protocolId: "x402",
  versionPin: "v2",
  officialSourceUrl:
    "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
  factsRetrievedAt: "2026-11-15",
};

const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: "https://api.example.com/data", description: "Test resource" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000000",
      asset: "0x" + "a".repeat(40),
      payTo: "0x" + "b".repeat(40),
      maxTimeoutSeconds: 60,
    },
  ],
};

const PAYMENT_PAYLOAD = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000000",
    asset: "0x" + "a".repeat(40),
    payTo: "0x" + "b".repeat(40),
    maxTimeoutSeconds: 60,
  },
  payload: {
    signature: "0x" + "f".repeat(130),
    authorization: {
      from: "0x" + "c".repeat(40),
      to: "0x" + "b".repeat(40),
      value: "1000000",
      validAfter: "1763640000",
      validBefore: "1763726400",
      nonce: "0x" + "d".repeat(64),
    },
  },
};

const SETTLEMENT_RESPONSE = {
  success: true,
  transaction: "0x" + "e".repeat(64),
  network: "eip155:84532",
  payer: "0x" + "c".repeat(40),
};

function makeFace(descriptor: PayswapProtocolAdapterDescriptor = X402_DESCRIPTOR) {
  return createPayswapX402MessageFace(descriptor);
}

describe("x402 message face — registration gate", () => {
  it("creates with a registry-consistent descriptor", () => {
    const face = makeFace();
    expect(face.descriptor.protocolId).toBe("x402");
    expect(face.descriptor.versionPin).toBe("v2");
  });

  it("version drift refuses at assembly time", () => {
    expect(() => makeFace({ ...X402_DESCRIPTOR, versionPin: "v1" })).toThrow(
      /protocol_version_unsupported/,
    );
  });

  it("unknown protocol id refuses at assembly time", () => {
    expect(() =>
      makeFace({
        ...X402_DESCRIPTOR,
        protocolId: "unknown" as PayswapProtocolAdapterDescriptor["protocolId"],
      }),
    ).toThrow(/protocol_not_registered/);
  });
});

describe("x402 message face — translateInbound", () => {
  it("PaymentRequired passes → validated-untrusted-proposal (digest only)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-required",
      payload: PAYMENT_REQUIRED,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(Object.keys(outcome).sort()).toEqual([
      "kind",
      "protocolId",
      "untrustedPayloadDigest",
      "versionPin",
    ]);
    expect(outcome.protocolId).toBe("x402");
    expect(outcome.versionPin).toBe("v2");
    expect(outcome.untrustedPayloadDigest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("PaymentPayload passes → validated-untrusted-proposal", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-payload",
      payload: PAYMENT_PAYLOAD,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("validAfter ≥ validBefore refuses (structural window check — Row 1 disposition)", async () => {
    const badWindow = {
      ...PAYMENT_PAYLOAD,
      payload: {
        ...PAYMENT_PAYLOAD.payload,
        authorization: {
          ...PAYMENT_PAYLOAD.payload.authorization,
          validAfter: "1763726400",
          validBefore: "1763640000",
        },
      },
    };
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-payload",
      payload: badWindow,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("SettlementResponse with settlement_pending + empty transaction refuses (Row 5 disposition)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "settlement-response",
      payload: {
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
        network: "eip155:84532",
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("unknown x402Kind routing label refuses (fail-closed dispatch)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "unknown-op",
      payload: {},
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("wrong x402Version refuses (fail-closed on unknown versions)", async () => {
    const wrongVersion = { ...PAYMENT_REQUIRED, x402Version: 1 };
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-required",
      payload: wrongVersion,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("x402 message face — digest binding + receipt evidence gate (laws 2/3)", () => {
  it("same payload → same digest; different payload → different digest", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ x402Kind: "payment-required", payload: PAYMENT_REQUIRED });
    const b = await face.translateInbound({ x402Kind: "payment-required", payload: PAYMENT_REQUIRED });
    const c = await face.translateInbound({
      x402Kind: "payment-required",
      payload: { ...PAYMENT_REQUIRED, error: "different" },
    });
    if (a.kind !== "validated-untrusted-proposal" || b.kind !== "validated-untrusted-proposal" || c.kind !== "validated-untrusted-proposal") {
      throw new Error("expected validated-untrusted-proposal");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
    expect(a.untrustedPayloadDigest).not.toBe(c.untrustedPayloadDigest);
  });

  it("digest is stable across JSON key ordering (canonical JSON, RFC 8785)", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ x402Kind: "payment-required", payload: PAYMENT_REQUIRED });
    const reordered = {
      accepts: PAYMENT_REQUIRED.accepts,
      x402Version: PAYMENT_REQUIRED.x402Version,
      resource: PAYMENT_REQUIRED.resource,
    };
    const b = await face.translateInbound({ x402Kind: "payment-required", payload: reordered });
    if (a.kind !== "validated-untrusted-proposal" || b.kind !== "validated-untrusted-proposal") {
      throw new Error("expected validated-untrusted-proposal");
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

  it("settled-verified host evidence → receipt-emitted (exact keys, no financial authority)", async () => {
    const outcome = await makeFace().emitReceipt({
      evidenceRef: "ledger://evidence/settlement-1",
      evidenceDigest: "a".repeat(64),
      state: "settled-verified",
      capturedAt: "2026-11-22T00:00:00Z",
    });
    expect(outcome.kind).toBe("receipt-emitted");
    if (outcome.kind !== "receipt-emitted") return;
    expect(Object.keys(outcome).sort()).toEqual([
      "kind",
      "protocolId",
      "settlementEvidenceRef",
      "versionPin",
    ]);
    expect(outcome.settlementEvidenceRef).toBe("ledger://evidence/settlement-1");
  });

  it("canonical JSON serialization is deterministic for the challenge payload", () => {
    const a = canonicalJsonStringify(PAYMENT_REQUIRED);
    const b = canonicalJsonStringify({ ...PAYMENT_REQUIRED });
    expect(a).toBe(b);
  });
});
