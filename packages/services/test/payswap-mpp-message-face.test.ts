/**
 * PaySwap P3 —— MPP 消息面法则电池（protocol-contract.ts 法则 1-5 的 MPP 实现
 * 证明；实现范围 = envelope 级 + 三个 pinned method rails —— stripe/evm/tempo；
 * 未 pin 的 per-network method 拒绝 = 不可用而非模拟）。
 *
 * 被钉住的法则行：
 * 1. **注册门**：描述符与 MPP pin（draft-httpauth-payment-01）一致才可创建；
 *    漂移 = 装配期 throw。
 * 2. **method 闭集**：stripe/evm/tempo 之外（hedera/lightning/solana/...）
 *    = typed 拒绝（不可用，不是模拟 —— per-network credential 内部 schema
 *    未检索）。
 * 3. **intent 闭集**：charge/session/subscription 之外 = typed 拒绝。
 * 4. **三结构**：challenge（id/realm/method/intent/request REQUIRED）/
 *    credential（challenge 回显 + payload REQUIRED）/ receipt（method/
 *    reference/status="success"/timestamp REQUIRED）。
 * 5. **不可信提案术语**：`validated-untrusted-proposal`（结构验证 ≠ 密码学
 *    验证）；产物恰四键。
 * 6. **收据证据门**：emitReceipt 只接受宿主签发的结构化 settled-verified
 *    证据对象。
 */

import {
  canonicalJsonStringify,
  createPayswapMppMessageFace,
  PAYSWAP_MPP_INTENT_VALUES,
  PAYSWAP_MPP_METHOD_VALUES,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  type PayswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

const MPP_DESCRIPTOR: PayswapProtocolAdapterDescriptor = {
  protocolId: "mpp",
  versionPin: "draft-httpauth-payment-01",
  officialSourceUrl:
    "https://github.com/tempoxyz/mpp-specs/blob/main/specs/core/draft-httpauth-payment-01.md",
  factsRetrievedAt: "2026-11-15",
};

const CHALLENGE = {
  id: "ch_1a2b3c4d5e",
  realm: "api.example.com",
  method: "stripe",
  intent: "charge",
  request: "eyJhbW91bnQiOiIxNTAwIiwiY3VycmVuY3k6InVzZCJ9",
};

const CREDENTIAL = {
  challenge: CHALLENGE,
  payload: { spt: "spt_1N4example", externalId: "order-9" },
};

const RECEIPT = {
  method: "stripe",
  reference: "pi_1N4example",
  status: "success",
  timestamp: "2026-11-22T12:00:00Z",
};

function makeFace(descriptor: PayswapProtocolAdapterDescriptor = MPP_DESCRIPTOR) {
  return createPayswapMppMessageFace(descriptor);
}

describe("MPP message face — registration gate (law 4, assembly-time fail-loud)", () => {
  it("creates with a registry-consistent descriptor", () => {
    const face = makeFace();
    expect(face.descriptor.protocolId).toBe("mpp");
    expect(face.descriptor.versionPin).toBe("draft-httpauth-payment-01");
  });

  it("version drift refuses at assembly time (protocol_version_unsupported)", () => {
    expect(() => makeFace({ ...MPP_DESCRIPTOR, versionPin: "draft-httpauth-payment-02" })).toThrow(
      /protocol_version_unsupported/,
    );
  });

  it("fact-source drift refuses with its OWN code (protocol_facts_drift)", () => {
    expect(() => makeFace({ ...MPP_DESCRIPTOR, factsRetrievedAt: "2026-11-20" })).toThrow(
      /protocol_facts_drift/,
    );
  });

  it("unknown protocol id refuses at assembly time (protocol_not_registered)", () => {
    expect(() =>
      makeFace({
        ...MPP_DESCRIPTOR,
        protocolId: "unknown-protocol" as PayswapProtocolAdapterDescriptor["protocolId"],
      }),
    ).toThrow(/protocol_not_registered/);
  });
});

describe("MPP message face — challenge structure (method + intent closures)", () => {
  it("pinned challenge (stripe/charge) passes → validated-untrusted-proposal (digest only)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: CHALLENGE,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(Object.keys(outcome).sort()).toEqual([
      "kind",
      "protocolId",
      "untrustedPayloadDigest",
      "versionPin",
    ]);
    expect(outcome.protocolId).toBe("mpp");
    expect(outcome.versionPin).toBe("draft-httpauth-payment-01");
    expect(outcome.untrustedPayloadDigest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("unpinned method refuses (hedera/lightning/solana/... — unavailable, not simulated)", async () => {
    const face = makeFace();
    for (const method of ["hedera", "lightning", "solana", "xrpl", "usdc", "card"]) {
      const outcome = await face.translateInbound({
        mppKind: "challenge",
        payload: { ...CHALLENGE, method },
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    }
  });

  it("unknown intent refuses (charge/session/subscription closure)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE, intent: "donation" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("missing REQUIRED challenge fields refuse (id/realm/request)", async () => {
    const face = makeFace();
    for (const dropped of ["id", "realm", "request"] as const) {
      const payload = { ...CHALLENGE };
      delete payload[dropped];
      const outcome = await face.translateInbound({ mppKind: "challenge", payload });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    }
  });

  it("unknown extra field refuses (strict closure)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE, settlement_params: "smuggled" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm and tempo methods pass at envelope level (pinned rails)", async () => {
    const face = makeFace();
    for (const method of ["evm", "tempo"] as const) {
      const outcome = await face.translateInbound({
        mppKind: "challenge",
        payload: { ...CHALLENGE, method },
      });
      expect(outcome.kind).toBe("validated-untrusted-proposal");
    }
  });
});

describe("MPP message face — credential structure (challenge echo REQUIRED)", () => {
  it("pinned credential shape passes (challenge echo + payload)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "credential",
      payload: CREDENTIAL,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("credential without the challenge echo refuses (pin: challenge REQUIRED)", async () => {
    const { challenge: _challenge, ...withoutEcho } = CREDENTIAL;
    void _challenge;
    const outcome = await makeFace().translateInbound({
      mppKind: "credential",
      payload: withoutEcho,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("empty payload refuses (REQUIRED)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "credential",
      payload: { challenge: CHALLENGE, payload: {} },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("MPP message face — receipt structure (success-only + required fields)", () => {
  it("pinned receipt shape passes", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "receipt",
      payload: RECEIPT,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("receipt with externalId echo passes (optional, echoed from credential)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "receipt",
      payload: { ...RECEIPT, externalId: "order-9" },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("non-success status refuses (failure path = 402 + fresh challenge, no receipt)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "receipt",
      payload: { ...RECEIPT, status: "failed" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("missing reference refuses (REQUIRED)", async () => {
    const { reference: _reference, ...withoutRef } = RECEIPT;
    void _reference;
    const outcome = await makeFace().translateInbound({
      mppKind: "receipt",
      payload: withoutRef,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("method outside the pinned rails refuses", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "receipt",
      payload: { ...RECEIPT, method: "solana" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("MPP message face — pinned vocabularies", () => {
  it("intent set is exactly the three pinned values", () => {
    expect([...PAYSWAP_MPP_INTENT_VALUES]).toEqual(["charge", "session", "subscription"]);
  });

  it("method set is exactly the three pinned rails (unpinned networks refuse)", () => {
    expect([...PAYSWAP_MPP_METHOD_VALUES]).toEqual(["stripe", "evm", "tempo"]);
  });
});

describe("MPP message face — digest binding + receipt evidence gate (laws 2/3)", () => {
  it("same challenge → same digest; different challenge → different digest", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ mppKind: "challenge", payload: CHALLENGE });
    const b = await face.translateInbound({ mppKind: "challenge", payload: CHALLENGE });
    const c = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE, expires: "2026-12-31T23:59:59Z" },
    });
    if (a.kind !== "validated-untrusted-proposal" || b.kind !== "validated-untrusted-proposal" || c.kind !== "validated-untrusted-proposal") {
      throw new Error("expected validated-untrusted-proposal");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
    expect(a.untrustedPayloadDigest).not.toBe(c.untrustedPayloadDigest);
  });

  it("digest is stable across JSON key ordering (canonical JSON, RFC 8785)", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ mppKind: "challenge", payload: CHALLENGE });
    const reordered = {
      request: CHALLENGE.request,
      intent: CHALLENGE.intent,
      method: CHALLENGE.method,
      realm: CHALLENGE.realm,
      id: CHALLENGE.id,
    };
    const b = await face.translateInbound({ mppKind: "challenge", payload: reordered });
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

  it("malformed evidence objects refuse (fabricated/malformed/missing shapes)", async () => {
    const face = makeFace();
    const fabricated = { evidenceRef: "ledger://evidence/x", evidenceDigest: "not-a-digest", state: "settled-verified", capturedAt: "2026-11-22T00:00:00Z" };
    expect((await face.emitReceipt(fabricated as never)).kind).toBe("refused");
    const missingDigest = { evidenceRef: "ledger://evidence/x", state: "settled-verified", capturedAt: "2026-11-22T00:00:00Z" };
    expect((await face.emitReceipt(missingDigest as never)).kind).toBe("refused");
    const badTimestamp = { evidenceRef: "ledger://evidence/x", evidenceDigest: "a".repeat(64), state: "settled-verified", capturedAt: "not-a-date" };
    expect((await face.emitReceipt(badTimestamp as never)).kind).toBe("refused");
    expect((await face.emitReceipt("trust-me-i-settled" as never)).kind).toBe("refused");
  });

  it("indeterminate / pending / failed evidence states refuse (indeterminate ≠ successful receipt)", async () => {
    const face = makeFace();
    for (const state of ["indeterminate", "pending", "failed"] as const) {
      const outcome = await face.emitReceipt({
        evidenceRef: "ledger://evidence/settlement-1",
        evidenceDigest: "a".repeat(64),
        state,
        capturedAt: "2026-11-22T00:00:00Z",
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_receipt_unavailable");
    }
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
    const a = canonicalJsonStringify(CHALLENGE);
    const b = canonicalJsonStringify({ ...CHALLENGE });
    expect(a).toBe(b);
  });
});
