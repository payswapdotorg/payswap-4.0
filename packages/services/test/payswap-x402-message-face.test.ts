/**
 * PaySwap P3 —— x402 消息面法则电池（supported subset = exact on eip155 via
 * eip3009；五个 spec-silent 行的处分结论见
 * docs/payswap/p3/x402-disposition-2026-11-22.md）。
 *
 * 夹具取自官方规范示例（x402-foundation/x402 @ b711fa9f，检索 2026-11-23：
 * specs/x402-specification-v2.md §5.1/§5.2 + specs/schemes/exact/
 * scheme_exact_evm.md §1）—— 一致性对着已发布的 wire 数据，不对着自造形态。
 *
 * 被钉住的法则行：
 * 1. **注册门**：描述符与 x402 pin（v2）一致才可创建。
 * 2. **PaymentRequired**：x402Version=2、resource.url REQUIRED、accepts 非空
 *    （scheme/network/amount/asset/payTo/maxTimeoutSeconds REQUIRED）。广告未
 *    pin 的 scheme 不使消息结构非法 —— 资格不是消息面的裁决（P6）。
 * 3. **supported subset**（doc 12 §6「Unsupported features are unavailable, not
 *    simulated as production support」）：付款载荷选中的 requirements 必须是
 *    exact + eip155 + eip3009（缺省）+ authorization 流（缺省）；其余 typed
 *    `protocol_feature_unsupported`（不可用，不是模拟）。
 * 4. **exact/EVM eip3009 payload schema**（官方 scheme 分册逐字）：signature =
 *    65-byte；authorization{from/to/value/validAfter/validBefore/nonce} 全部
 *    REQUIRED，nonce = 32-byte；validAfter < validBefore（Row 1 结构校验）；
 *    accepted.extra.name/version REQUIRED（EIP-712 域）；授权的收款人/金额必须
 *    与 accepted 一致。
 * 5. **SettlementResponse**：transaction MUST 非空 when settlement_pending。
 * 6. **不可信提案术语**：`validated-untrusted-proposal`；结构验证不是验签 ——
 *    形态合法的伪造签名同样是 untrusted 提案，绝无「已验证」结局。
 * 7. **收据证据门**：emitReceipt 只接受宿主签发的 settled-verified 证据对象。
 */

import {
  canonicalJsonStringify,
  createPayswapX402MessageFace,
  evaluatePayswapX402RequirementSupport,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  type PayswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";
import { createPayswapHostEvidenceAuthority } from "@zcode/services/node";
import { describe, expect, it } from "vitest";

const X402_DESCRIPTOR: PayswapProtocolAdapterDescriptor = {
  protocolId: "x402",
  versionPin: "v2",
  officialSourceUrl:
    "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
  factsRetrievedAt: "2026-11-15",
};

// —— 官方示例值（core §5.1 / scheme §1）——————————————————————————————
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const SIGNATURE =
  "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c";
const NONCE = "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480";

const REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const PAYMENT_REQUIRED = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
    serviceName: "Example Market Data",
    tags: ["market-data", "finance"],
    iconUrl: "https://api.example.com/icon.png",
  },
  accepts: [REQUIREMENTS],
  extensions: {},
};

const AUTHORIZATION = {
  from: PAYER,
  to: PAYEE,
  value: "10000",
  validAfter: "1740672089",
  validBefore: "1740672154",
  nonce: NONCE,
};

const PAYMENT_PAYLOAD = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
  },
  accepted: REQUIREMENTS,
  payload: { signature: SIGNATURE, authorization: AUTHORIZATION },
  extensions: {},
};

const SETTLEMENT_RESPONSE = {
  success: true,
  transaction: "0x" + "e".repeat(64),
  network: "eip155:84532",
  payer: PAYER,
};

type Payload = typeof PAYMENT_PAYLOAD;

function payloadWith(patch: {
  accepted?: Record<string, unknown>;
  authorization?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}): Payload {
  const accepted =
    patch.accepted === undefined ? PAYMENT_PAYLOAD.accepted : { ...REQUIREMENTS, ...patch.accepted };
  const authorization =
    patch.authorization === undefined ? AUTHORIZATION : { ...AUTHORIZATION, ...patch.authorization };
  // 显式 `undefined` 的 patch 键 = 删除该字段（spread 保留 undefined —— zod 视为缺失）。
  const payload =
    patch.payload === undefined
      ? { signature: SIGNATURE, authorization }
      : { signature: SIGNATURE, authorization, ...patch.payload };
  return { ...PAYMENT_PAYLOAD, accepted, payload };
}

function makeFace(
  descriptor: PayswapProtocolAdapterDescriptor = X402_DESCRIPTOR,
  options: Parameters<typeof createPayswapX402MessageFace>[1] = {},
) {
  return createPayswapX402MessageFace(descriptor, options);
}

async function refusalCodeOf(message: unknown): Promise<string> {
  const outcome = await makeFace().translateInbound(message);
  expect(outcome.kind).toBe("refused");
  if (outcome.kind !== "refused") throw new Error("expected refusal");
  expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain(outcome.refusal.code);
  return outcome.refusal.code;
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

  it("PaymentPayload passes → validated-untrusted-proposal carrying the requirements binding", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-payload",
      payload: PAYMENT_PAYLOAD,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(outcome.challengeBinding?.kind).toBe("x402-requirements-binding");
  });

  it("a PaymentPayload may echo the full ResourceInfo (serviceName/tags/iconUrl are ResourceInfo fields)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-payload",
      payload: { ...PAYMENT_PAYLOAD, resource: PAYMENT_REQUIRED.resource },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
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
    expect(await refusalCodeOf({ x402Kind: "unknown-op", payload: {} })).toBe(
      "protocol_message_unverifiable",
    );
  });

  it.each([
    ["stale", 1],
    ["future", 3],
  ])("%s wire x402Version refuses (fail-closed on unknown versions)", async (_label, version) => {
    expect(
      await refusalCodeOf({ x402Kind: "payment-required", payload: { ...PAYMENT_REQUIRED, x402Version: version } }),
    ).toBe("protocol_message_unverifiable");
    expect(await refusalCodeOf({ x402Kind: "payment-payload", payload: { ...PAYMENT_PAYLOAD, x402Version: version } })).toBe(
      "protocol_message_unverifiable",
    );
  });

  it("missing x402Version refuses (REQUIRED)", async () => {
    const { x402Version: _omitted, ...withoutVersion } = PAYMENT_REQUIRED;
    expect(await refusalCodeOf({ x402Kind: "payment-required", payload: withoutVersion })).toBe(
      "protocol_message_unverifiable",
    );
  });
});

describe("x402 message face — supported subset (exact on eip155 via eip3009; unpinned surfaces are unavailable, not simulated)", () => {
  it("evaluatePayswapX402RequirementSupport accepts the default method and the explicit eip3009 method", () => {
    expect(evaluatePayswapX402RequirementSupport(REQUIREMENTS)).toEqual({ supported: true });
    expect(
      evaluatePayswapX402RequirementSupport({
        ...REQUIREMENTS,
        extra: { ...REQUIREMENTS.extra, assetTransferMethod: "eip3009", paymentFlow: "authorization" },
      }),
    ).toEqual({ supported: true });
  });

  it.each([
    ["an unpinned scheme (upto)", { scheme: "upto" }],
    ["an unpinned scheme (batch-settlement)", { scheme: "batch-settlement" }],
    ["an unpinned network family (solana)", { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }],
    ["the Permit2 transfer method (payload wire not field-level pinned)", { extra: { ...REQUIREMENTS.extra, assetTransferMethod: "permit2" } }],
    ["the ERC-7710 transfer method (payload wire not field-level pinned)", { extra: { ...REQUIREMENTS.extra, assetTransferMethod: "erc7710" } }],
    ["a non-default payment flow (escrow)", { extra: { ...REQUIREMENTS.extra, paymentFlow: "escrow" } }],
  ])("payment payload selecting %s refuses protocol_feature_unsupported", async (_label, patch) => {
    expect(
      await refusalCodeOf({ x402Kind: "payment-payload", payload: payloadWith({ accepted: patch }) }),
    ).toBe("protocol_feature_unsupported");
  });

  it("the support evaluator names the same refusal for the same surfaces (P6 eligibility reuses it)", () => {
    const verdict = evaluatePayswapX402RequirementSupport({ ...REQUIREMENTS, scheme: "upto" });
    expect(verdict).toEqual({
      supported: false,
      refusal: "protocol_feature_unsupported",
      detail: expect.stringContaining("upto"),
    });
  });

  it("a PaymentRequired advertising an unpinned entry stays structurally valid (eligibility is not the message face's call)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-required",
      payload: { ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENTS, scheme: "upto" }] },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });
});

describe("x402 message face — exact/EVM eip3009 payload schema (official scheme binding, verbatim)", () => {
  it("accepts the official spec example payload", async () => {
    const outcome = await makeFace().translateInbound({ x402Kind: "payment-payload", payload: PAYMENT_PAYLOAD });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it.each([
    ["missing signature", { signature: undefined }],
    ["a 64-byte (128-hex) signature", { signature: "0x" + "f".repeat(128) }],
    ["a 66-byte (132-hex) signature", { signature: "0x" + "f".repeat(132) }],
    ["a non-hex signature", { signature: "0x" + "z".repeat(130) }],
    ["an unprefixed signature", { signature: "f".repeat(130) }],
    ["a non-string signature", { signature: 42 }],
    ["a missing authorization", { authorization: undefined }],
  ])("%s refuses protocol_message_unverifiable", async (_label, patch) => {
    const message = { x402Kind: "payment-payload", payload: payloadWith({ payload: patch as Record<string, unknown> }) };
    expect(await refusalCodeOf(message)).toBe("protocol_message_unverifiable");
  });

  it("an empty payment payload object refuses (payload is REQUIRED and scheme-specific)", async () => {
    expect(
      await refusalCodeOf({ x402Kind: "payment-payload", payload: { ...PAYMENT_PAYLOAD, payload: {} } }),
    ).toBe("protocol_message_unverifiable");
  });

  it.each([
    ["from is not an address", { from: "payer" }],
    ["to is not an address", { to: "0x1234" }],
    ["value is not an atomic-unit integer string", { value: "10.000" }],
    ["value is zero", { value: "0" }],
    ["validAfter is not a timestamp string", { validAfter: 1740672089 }],
    ["validBefore is negative", { validBefore: "-1" }],
    ["nonce is not 32 bytes", { nonce: "0x" + "d".repeat(62) }],
    ["nonce is a bare word", { nonce: "nonce-1" }],
  ])("%s refuses protocol_message_unverifiable", async (_label, patch) => {
    expect(
      await refusalCodeOf({ x402Kind: "payment-payload", payload: payloadWith({ authorization: patch }) }),
    ).toBe("protocol_message_unverifiable");
  });

  it("validAfter ≥ validBefore refuses (structural window check — Row 1 disposition)", async () => {
    expect(
      await refusalCodeOf({
        x402Kind: "payment-payload",
        payload: payloadWith({ authorization: { validAfter: "1740672154", validBefore: "1740672089" } }),
      }),
    ).toBe("protocol_message_unverifiable");
    expect(
      await refusalCodeOf({
        x402Kind: "payment-payload",
        payload: payloadWith({ authorization: { validAfter: "1740672154", validBefore: "1740672154" } }),
      }),
    ).toBe("protocol_message_unverifiable");
  });

  it("an unknown payload field refuses (strict — no Permit2-shaped keys ride an eip3009 payload)", async () => {
    expect(
      await refusalCodeOf({
        x402Kind: "payment-payload",
        payload: payloadWith({ payload: { permit2Authorization: { from: PAYER } } }),
      }),
    ).toBe("protocol_message_unverifiable");
  });

  it.each([
    ["name", { version: "2" }],
    ["version", { name: "USDC" }],
  ])("accepted.extra without %s refuses (eip3009 requires the EIP-712 domain fields)", async (_label, extra) => {
    expect(await refusalCodeOf({ x402Kind: "payment-payload", payload: payloadWith({ accepted: { extra } }) })).toBe(
      "protocol_message_unverifiable",
    );
    expect(
      await refusalCodeOf({ x402Kind: "payment-payload", payload: payloadWith({ accepted: { extra: {} } }) }),
    ).toBe("protocol_message_unverifiable");
  });

  it("an eip3009 requirement that names another transfer method refuses (MUST be eip3009 when present)", async () => {
    expect(
      await refusalCodeOf({
        x402Kind: "payment-payload",
        payload: payloadWith({ accepted: { extra: { name: "USDC", version: "2", assetTransferMethod: "eip-3009" } } }),
      }),
    ).toBe("protocol_feature_unsupported");
  });

  it("a malformed extension value refuses (each value carries info + schema objects)", async () => {
    expect(
      await refusalCodeOf({ x402Kind: "payment-payload", payload: { ...PAYMENT_PAYLOAD, extensions: { bazaar: "not-an-object" } } }),
    ).toBe("protocol_message_unverifiable");
  });
});

describe("x402 message face — maxTimeoutSeconds presence (Row 4 disposition: presence + positive integer only; no bounds are invented)", () => {
  it.each([
    ["missing", { maxTimeoutSeconds: undefined }],
    ["zero", { maxTimeoutSeconds: 0 }],
    ["negative", { maxTimeoutSeconds: -1 }],
    ["fractional", { maxTimeoutSeconds: 1.5 }],
    ["a numeric string", { maxTimeoutSeconds: "60" }],
  ])("%s maxTimeoutSeconds refuses protocol_message_unverifiable", async (_label, patch) => {
    const payload = payloadWith({ accepted: patch });
    expect(await refusalCodeOf({ x402Kind: "payment-payload", payload })).toBe("protocol_message_unverifiable");
    expect(
      await refusalCodeOf({ x402Kind: "payment-required", payload: { ...PAYMENT_REQUIRED, accepts: [payload.accepted] } }),
    ).toBe("protocol_message_unverifiable");
  });

  it.each([1, 60, 86_400, 2_147_483_647])("maxTimeoutSeconds = %s is structurally valid (the spec documents no bounds — bounds are a host policy)", async (seconds) => {
    const payload = payloadWith({ accepted: { maxTimeoutSeconds: seconds } });
    expect((await makeFace().translateInbound({ x402Kind: "payment-payload", payload })).kind).toBe(
      "validated-untrusted-proposal",
    );
  });
});

describe("x402 message face — authorization ↔ requirements echo binding", () => {
  it("authorization.to ≠ accepted.payTo refuses (recipient mismatch)", async () => {
    expect(
      await refusalCodeOf({
        x402Kind: "payment-payload",
        payload: payloadWith({ authorization: { to: "0x" + "b".repeat(40) } }),
      }),
    ).toBe("protocol_message_unverifiable");
  });

  it("authorization.value ≠ accepted.amount refuses (value mismatch)", async () => {
    expect(await refusalCodeOf({ x402Kind: "payment-payload", payload: payloadWith({ authorization: { value: "10001" } }) })).toBe(
      "protocol_message_unverifiable",
    );
  });

  it("address comparison is case-insensitive (EIP-55 checksum vs lowercase are the same address)", async () => {
    const outcome = await makeFace().translateInbound({
      x402Kind: "payment-payload",
      payload: payloadWith({
        accepted: { payTo: PAYEE.toLowerCase() },
        authorization: { to: PAYEE },
      }),
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("the binding digests are canonical: key-order independent, and distinct payments (nonces) get distinct credential digests", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ x402Kind: "payment-payload", payload: PAYMENT_PAYLOAD });
    const reordered = {
      ...PAYMENT_PAYLOAD,
      accepted: {
        extra: REQUIREMENTS.extra,
        maxTimeoutSeconds: REQUIREMENTS.maxTimeoutSeconds,
        payTo: REQUIREMENTS.payTo,
        asset: REQUIREMENTS.asset,
        amount: REQUIREMENTS.amount,
        network: REQUIREMENTS.network,
        scheme: REQUIREMENTS.scheme,
      },
    };
    const b = await face.translateInbound({ x402Kind: "payment-payload", payload: reordered });
    const c = await face.translateInbound({
      x402Kind: "payment-payload",
      payload: payloadWith({ authorization: { nonce: "0x" + "e".repeat(64) } }),
    });
    if (
      a.kind !== "validated-untrusted-proposal" ||
      b.kind !== "validated-untrusted-proposal" ||
      c.kind !== "validated-untrusted-proposal" ||
      a.challengeBinding?.kind !== "x402-requirements-binding" ||
      b.challengeBinding?.kind !== "x402-requirements-binding" ||
      c.challengeBinding?.kind !== "x402-requirements-binding"
    ) {
      throw new Error("expected x402-requirements-binding");
    }
    expect(a.challengeBinding.requirementsDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.challengeBinding.requirementsDigest).toBe(a.challengeBinding.requirementsDigest);
    expect(c.challengeBinding.requirementsDigest).toBe(a.challengeBinding.requirementsDigest);
    // 同一 requirements 的第二笔合法付款（新 nonce）是另一笔授权 —— 不是重放。
    expect(c.challengeBinding.credentialDigest).not.toBe(a.challengeBinding.credentialDigest);
  });

  it("the credential digest keys on the payer nonce, never on signature bytes (ECDSA signatures are malleable)", async () => {
    // core §10.1：重放防线是「unique 32-byte nonce」。若把签名字节并入单次使用的
    // 键，同一授权换一个（可延展的）签名就能再次通过 —— 本行钉住该身份不含签名。
    const face = makeFace();
    const first = await face.translateInbound({ x402Kind: "payment-payload", payload: PAYMENT_PAYLOAD });
    const malleated = await face.translateInbound({
      x402Kind: "payment-payload",
      payload: payloadWith({ payload: { signature: "0x" + "1".repeat(130) } }),
    });
    const upperHex = await face.translateInbound({
      x402Kind: "payment-payload",
      payload: payloadWith({
        authorization: { from: PAYER.toLowerCase(), nonce: NONCE.toUpperCase().replace("0X", "0x") },
      }),
    });
    if (
      first.kind !== "validated-untrusted-proposal" ||
      malleated.kind !== "validated-untrusted-proposal" ||
      upperHex.kind !== "validated-untrusted-proposal" ||
      first.challengeBinding?.kind !== "x402-requirements-binding"
    ) {
      throw new Error("expected x402-requirements-binding");
    }
    expect(malleated.challengeBinding?.kind === "x402-requirements-binding" && malleated.challengeBinding.credentialDigest).toBe(
      first.challengeBinding.credentialDigest,
    );
    // 大小写无关的十六进制是同一地址 / 同一 nonce。
    expect(upperHex.challengeBinding?.kind === "x402-requirements-binding" && upperHex.challengeBinding.credentialDigest).toBe(
      first.challengeBinding.credentialDigest,
    );
  });
});

describe("x402 message face — signature posture (structure is not verification)", () => {
  it("a forged-but-well-formed signature is never verified: the outcome stays an untrusted proposal with no verification claim", async () => {
    const forged = payloadWith({ payload: { signature: "0x" + "0".repeat(130) } });
    const outcome = await makeFace().translateInbound({ x402Kind: "payment-payload", payload: forged });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    // 结局键闭集：没有任何 verified/authenticated/settled 位可被下游读取。
    expect(Object.keys(outcome).sort()).toEqual([
      "challengeBinding",
      "kind",
      "protocolId",
      "untrustedPayloadDigest",
      "versionPin",
    ]);
  });

  it("a SettlementResponse claiming success is an untrusted proposal, never settlement evidence", async () => {
    const outcome = await makeFace().translateInbound({ x402Kind: "settlement-response", payload: SETTLEMENT_RESPONSE });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
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
      extensions: PAYMENT_REQUIRED.extensions,
      x402Version: PAYMENT_REQUIRED.x402Version,
      error: PAYMENT_REQUIRED.error,
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
    const authority = createPayswapHostEvidenceAuthority();
    const evidence = authority.issue({
      evidenceRef: "ledger://evidence/settlement-1",
      evidenceDigest: "a".repeat(64),
      state: "settled-verified",
      capturedAt: "2026-11-22T00:00:00Z",
      protocolId: "x402",
      subjectRef: "execution://exec-1",
    });
    const outcome = await makeFace(X402_DESCRIPTOR, {
      evidenceVerifier: authority.verifier,
    }).emitReceipt(evidence);
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
