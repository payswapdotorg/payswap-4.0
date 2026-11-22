/**
 * PaySwap P3 —— MPP 消息面法则电池（handoff v3 优先级 1-4+6：五个 pinned
 * method/intent 组合的完整消息 schema / 验证门证明）。
 *
 * 被钉住的法则行：
 * 1. **兼容矩阵**：五个受支持组合（stripe-charge / stripe-subscription /
 *    evm-charge / evm-session / tempo-subscription）在 challenge/credential/
 *    receipt 三层全部通过；四个不受支持组合（stripe-session / evm-
 *    subscription / tempo-charge / tempo-session）与未知组合全部拒绝 ——
 *    矩阵源自 protocol-facts.ts（单一事实源，一致性由本电池断言）。
 * 2. **request 编码纪律**：base64url-nopad 字符集 + 解码 + UTF-8 JSON +
 *    JCS canonical 重序列化一致 + method-specific schema 逐字段校验 ——
 *    非canonical/畸形/越集一律拒绝。
 * 3. **method-specific schema**：五组合各自的结构（stripe-charge 的
 *    methodDetails.networkId/paymentMethodTypes；stripe-subscription 的
 *    recipient/subscriptionExpires MUST-NOT；evm-charge 的 ERC-20/EIP-55/
 *    chainId/splits ≤10；evm-session 的每单位金额/escrowContract；
 *    tempo-subscription 的 month 拒/subscriptionExpires REQUIRED/accessKey）。
 * 4. **credential 分派**：五组合各自的 payload schema（stripe spt_ 前缀 /
 *    evm 四类 credential 分派 / tempo keyAuthorization）—— 错置即拒。
 * 5. **receipt 分派**：五组合各自的 receipt schema —— method/intent 错置
 *    即拒；stripe 双 intent 由 envelope.context 分派。
 * 6. **收据证据门**：emitReceipt 只接受宿主签发的结构化 settled-verified
 *    证据对象。
 */

import {
  canonicalJsonStringify,
  createPayswapMppMessageFace,
  PAYSWAP_MPP_METHOD_INTENT_MATRIX,
  PAYSWAP_MPP_INTENT_VALUES,
  PAYSWAP_MPP_METHOD_VALUES,
  PAYSWAP_PROTOCOL_REFUSAL_CODES,
  payswapMppMethodIntentSupported,
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

const EVM_TOKEN = "0x" + "a".repeat(40);
const EVM_RECIPIENT = "0x" + "b".repeat(40);
const EVM_ESCROW = "0x" + "c".repeat(40);
const EVM_TX = "0x" + "e".repeat(64);

function jcsBase64Url(payload: unknown): string {
  const canonical = canonicalJsonStringify(payload);
  const bytes = new TextEncoder().encode(canonical);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 五个受支持组合的 request 对象（官方格式 fixture）。 */
const REQUEST_OBJECTS: Record<string, Record<string, unknown>> = {
  "stripe+charge": {
    amount: "1500",
    currency: "usd",
    methodDetails: { networkId: "net_stripe_profile_1", paymentMethodTypes: ["card"] },
  },
  "stripe+subscription": {
    amount: "999",
    currency: "usd",
    periodUnit: "month",
    periodCount: "3",
    methodDetails: { networkId: "net_stripe_profile_1", paymentMethodTypes: ["card"] },
  },
  "evm+charge": {
    amount: "1000000",
    currency: EVM_TOKEN,
    recipient: EVM_RECIPIENT,
    methodDetails: { chainId: 84532 },
  },
  "evm+session": {
    amount: "100",
    currency: EVM_TOKEN,
    recipient: EVM_RECIPIENT,
    methodDetails: { chainId: 84532, escrowContract: EVM_ESCROW },
  },
  "tempo+subscription": {
    amount: "999",
    currency: "usd",
    periodUnit: "week",
    periodCount: "4",
    subscriptionExpires: "2026-12-31T00:00:00Z",
    recipient: "tempo-recipient-1",
    methodDetails: { accessKey: { accessKeyAddress: "ak-tempo-1", keyType: "p256" } },
  },
};

const COMBO_KEYS = Object.keys(REQUEST_OBJECTS);

const CHALLENGE_FIXTURES: Record<string, { id: string; realm: string; method: string; intent: string; request: string }> = {};
for (const comboKey of COMBO_KEYS) {
  const [method, intent] = comboKey.split("+");
  CHALLENGE_FIXTURES[comboKey] = {
    id: "ch_" + comboKey.replace("+", "_"),
    realm: "api.example.com",
    method,
    intent,
    request: jcsBase64Url(REQUEST_OBJECTS[comboKey]),
  };
}

function challengeFor(comboKey: string, requestOverride?: unknown) {
  const [method, intent] = comboKey.split("+");
  return {
    id: "ch_" + comboKey.replace("+", "_"),
    realm: "api.example.com",
    method,
    intent,
    request: requestOverride ?? jcsBase64Url(REQUEST_OBJECTS[comboKey]),
  };
}

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
    expect(() =>
      makeFace({ ...MPP_DESCRIPTOR, versionPin: "draft-httpauth-payment-02" }),
    ).toThrow(/protocol_version_unsupported/);
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

describe("MPP message face — method/intent compatibility matrix (grounded in protocol-facts)", () => {
  it("the registry matrix is exactly the five pinned combinations", () => {
    expect([...PAYSWAP_MPP_METHOD_INTENT_MATRIX.map((e) => e.method + "+" + e.intent)].sort()).toEqual([
      "evm+charge",
      "evm+session",
      "stripe+charge",
      "stripe+subscription",
      "tempo+subscription",
    ]);
    for (const entry of PAYSWAP_MPP_METHOD_INTENT_MATRIX) {
      expect(payswapMppMethodIntentSupported(entry.method, entry.intent)).toBe(true);
    }
    expect(payswapMppMethodIntentSupported("stripe", "session")).toBe(false);
    expect(payswapMppMethodIntentSupported("evm", "subscription")).toBe(false);
    expect(payswapMppMethodIntentSupported("tempo", "charge")).toBe(false);
    expect(payswapMppMethodIntentSupported("tempo", "session")).toBe(false);
    expect(payswapMppMethodIntentSupported("hedera", "charge")).toBe(false);
  });

  it("all five supported combos pass at the challenge level", async () => {
    const face = makeFace();
    for (const comboKey of COMBO_KEYS) {
      const outcome = await face.translateInbound({
        mppKind: "challenge",
        payload: challengeFor(comboKey),
      });
      expect(outcome.kind).toBe("validated-untrusted-proposal");
      if (outcome.kind !== "validated-untrusted-proposal") return;
      expect(Object.keys(outcome).sort()).toEqual([
        "kind",
        "protocolId",
        "untrustedPayloadDigest",
        "versionPin",
      ]);
    }
  });

  it("the four unsupported in-scope combos refuse (stripe-session / evm-subscription / tempo-charge / tempo-session)", async () => {
    const face = makeFace();
    const unsupported = ["stripe+session", "evm+subscription", "tempo+charge", "tempo+session"];
    for (const comboKey of unsupported) {
      const [method, intent] = comboKey.split("+");
      const outcome = await face.translateInbound({
        mppKind: "challenge",
        payload: {
          id: "ch_x",
          realm: "api.example.com",
          method,
          intent,
          request: jcsBase64Url({ amount: "100", currency: "usd" }),
        },
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
      expect(outcome.refusal.message).toContain(comboKey);
    }
  });

  it("unknown method and intent values refuse", async () => {
    const face = makeFace();
    const unknownMethod = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], method: "hedera" },
    });
    expect(unknownMethod.kind).toBe("refused");
    if (unknownMethod.kind !== "refused") return;
    expect(unknownMethod.refusal.code).toBe("protocol_message_unverifiable");
    const unknownIntent = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], intent: "donation" },
    });
    expect(unknownIntent.kind).toBe("refused");
  });
});

describe("MPP message face — challenge request encoding (base64url + JCS + method schema)", () => {
  it("non-canonical JSON representation refuses (JCS discipline — key order ≠ canonical)", async () => {
    const face = makeFace();
    // 非canonical：键序与 JCS 排序不同（"currency" 在 "amount" 前）
    const nonCanonical = btoa(
      JSON.stringify({ currency: "usd", amount: "1500", methodDetails: { networkId: "n1", paymentMethodTypes: ["card"] } }),
    ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: nonCanonical },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.message).toContain("JCS");
  });

  it("invalid base64url charset refuses", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: "not base64!!" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("decoded non-JSON refuses", async () => {
    const notJson = btoa("this is not json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: notJson },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("method-schema violations refuse (stripe-charge: missing methodDetails.networkId)", async () => {
    const face = makeFace();
    const bad = jcsBase64Url({ amount: "1500", currency: "usd", methodDetails: { paymentMethodTypes: ["card"] } });
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: bad },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("MPP message face — challenge optional parameters (official semantics)", () => {
  it("expires (RFC3339) accepted at challenge level; non-RFC3339 refuses", async () => {
    const face = makeFace();
    const ok = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], expires: "2026-12-31T23:59:59Z" },
    });
    expect(ok.kind).toBe("validated-untrusted-proposal");
    const bad = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], expires: "tomorrow" },
    });
    expect(bad.kind).toBe("refused");
    if (bad.kind !== "refused") return;
    expect(bad.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("opaque (base64url JCS flat string map) accepted; non-flat-map refuses", async () => {
    const face = makeFace();
    const okOpaque = jcsBase64Url({ correlation: "abc" });
    const ok = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], opaque: okOpaque },
    });
    expect(ok.kind).toBe("validated-untrusted-proposal");
    const badOpaque = btoa(JSON.stringify({ nested: { deep: 1 } })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], opaque: badOpaque },
    });
    expect(bad.kind).toBe("refused");
    if (bad.kind !== "refused") return;
    expect(bad.refusal.message).toContain("opaque");
  });

  it("header MUST be Payment-Authorization when present", async () => {
    const face = makeFace();
    const bad = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], header: "X-Payment" },
    });
    expect(bad.kind).toBe("refused");
    if (bad.kind !== "refused") return;
    expect(bad.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("digest accepted as a pinned-format string", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: {
        ...CHALLENGE_FIXTURES["stripe+charge"],
        digest: 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
      },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("unknown challenge parameters are IGNORED (official client rule — not rejected)", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], custom_vendor_param: "ignored-by-law" },
    });
    // 未知参数忽略 —— 结局与其他 stripe-charge challenge 相同
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(outcome.untrustedPayloadDigest).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("MPP message face — credential dispatch (five pinned payload schemas)", () => {
  const CREDENTIAL_PAYLOADS: Record<string, Record<string, unknown>> = {
    "stripe+charge": { spt: "spt_1N4example" },
    "stripe+subscription": { paymentMethod: "pm_1N4example" },
    "evm+charge": {
      type: "permit2",
      permit: {
        permitted: [{ token: EVM_TOKEN, amount: "1000000" }],
        nonce: "nonce-1",
        deadline: "1763726400",
      },
      signature: "0x" + "f".repeat(130),
    },
    "evm+session": { action: "open", channelId: "chan-1", cumulativeAmount: "0", signature: "sig-1" },
    "tempo+subscription": { type: "keyAuthorization", signature: "0x" + "f".repeat(130) },
  };

  async function credentialFor(comboKey: string, payloadOverride?: Record<string, unknown>) {
    const face = makeFace();
    const challenge = challengeFor(comboKey);
    return face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: payloadOverride ?? CREDENTIAL_PAYLOADS[comboKey] },
    });
  }

  it("all five supported combos pass with their pinned credential payload schemas", async () => {
    const face = makeFace();
    for (const comboKey of COMBO_KEYS) {
      const outcome = await credentialFor(comboKey);
      expect(outcome.kind).toBe("validated-untrusted-proposal");
      if (outcome.kind !== "validated-untrusted-proposal") return;
      expect(outcome.protocolId).toBe("mpp");
    }
  });

  it("stripe-charge credential without the spt_ prefix refuses", async () => {
    const outcome = await credentialFor("stripe+charge", { spt: "wrong_prefix_1" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("stripe-subscription credential with paymentMethod-missing payload refuses", async () => {
    const outcome = await credentialFor("stripe+subscription", {});
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm-charge credential dispatches all four credential types (permit2/authorization/transaction/hash)", async () => {
    const face = makeFace();
    const permit2 = await credentialFor("evm+charge");
    expect(permit2.kind).toBe("validated-untrusted-proposal");
    const authorization = await face.translateInbound({
      mppKind: "credential",
      payload: {
        challenge: challengeFor("evm+charge"),
        payload: {
          type: "authorization",
          from: EVM_RECIPIENT,
          to: EVM_TOKEN,
          value: "1000000",
          validAfter: "0",
          validBefore: "1763726400",
          nonce: EVM_TX,
          signature: "0x" + "f".repeat(130),
        },
      },
    });
    expect(authorization.kind).toBe("validated-untrusted-proposal");
    const transaction = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge: challengeFor("evm+charge"), payload: { type: "transaction", signature: EVM_TX } },
    });
    expect(transaction.kind).toBe("validated-untrusted-proposal");
    const hash = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge: challengeFor("evm+charge"), payload: { type: "hash", hash: EVM_TX } },
    });
    expect(hash.kind).toBe("validated-untrusted-proposal");
  });

  it("evm-charge credential with an unknown type refuses", async () => {
    const outcome = await credentialFor("evm+charge", { type: "direct_transfer", signature: "0x1" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm-session credential with an unknown action refuses", async () => {
    const outcome = await credentialFor("evm+session", {
      action: "rebalance",
      channelId: "chan-1",
      signature: "sig-1",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("tempo-subscription credential without keyAuthorization type refuses", async () => {
    const outcome = await credentialFor("tempo+subscription", { type: "direct_debit", signature: "0x1" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("cross-rail credential placement refuses (tempo credential under stripe-charge challenge)", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge: challengeFor("stripe+charge"), payload: { type: "keyAuthorization", signature: "0x" + "f".repeat(130) } },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("MPP message face — receipt dispatch (five pinned receipt schemas)", () => {
  const RECEIPTS: Record<string, Record<string, unknown>> = {
    "stripe+charge": {
      method: "stripe",
      reference: "pi_1N4example",
      status: "success",
      timestamp: "2026-11-22T12:00:00Z",
    },
    "stripe+subscription": {
      method: "stripe",
      reference: "in_1N4example",
      status: "success",
      subscriptionId: "sub_1N4example",
      timestamp: "2026-11-22T12:00:00Z",
    },
    "evm+charge": {
      method: "evm",
      challengeId: "ch_evm_1",
      reference: EVM_TX,
      status: "success",
      timestamp: "2026-11-22T12:00:00Z",
      chainId: 84532,
    },
    "evm+session": {
      method: "evm",
      intent: "session",
      reference: "chan-1",
      status: "success",
      timestamp: "2026-11-22T12:00:00Z",
      challengeId: "ch_evm_s1",
      channelId: "chan-1",
      acceptedCumulative: "500",
      spent: "400",
      chainId: 84532,
    },
    "tempo+subscription": {
      method: "tempo",
      reference: EVM_TX,
      status: "success",
      subscriptionId: "sub-tempo-1",
      timestamp: "2026-11-22T12:00:00Z",
    },
  };

  it("all five supported combos pass with their pinned receipt schemas (intent-dispatched)", async () => {
    const face = makeFace();
    for (const comboKey of COMBO_KEYS) {
      const [method, intent] = comboKey.split("+");
      const outcome = await face.translateInbound({
        mppKind: "receipt",
        intent,
        payload: RECEIPTS[comboKey],
      });
      expect(outcome.kind).toBe("validated-untrusted-proposal");
      if (outcome.kind !== "validated-untrusted-proposal") return;
      expect(outcome.protocolId).toBe("mpp");
    }
  });

  it("cross-structure placement refuses (tempo receipt under evm intent, session receipt under charge intent)", async () => {
    const face = makeFace();
    const tempoUnderEvm = await face.translateInbound({
      mppKind: "receipt",
      intent: "charge",
      payload: { ...RECEIPTS["tempo+subscription"], method: "evm" },
    });
    console.log("DEBUG-TUE:", JSON.stringify(tempoUnderEvm).slice(0, 300));
    expect(tempoUnderEvm.kind).toBe("refused");
    const sessionUnderCharge = await face.translateInbound({
      mppKind: "receipt",
      intent: "charge",
      payload: { ...RECEIPTS["evm+session"], method: "evm" },
    });
    expect(sessionUnderCharge.kind).toBe("refused");
    if (sessionUnderCharge.kind !== "refused") return;
    expect(sessionUnderCharge.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm-charge receipt with a non-tx-hash reference refuses", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "receipt",
      intent: "charge",
      payload: { ...RECEIPTS["evm+charge"], reference: "not-a-tx-hash" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("stripe-subscription receipt missing subscriptionId refuses", async () => {
    const face = makeFace();
    const { subscriptionId: _sub, ...withoutSub } = RECEIPTS["stripe+subscription"];
    void _sub;
    const outcome = await face.translateInbound({
      mppKind: "receipt",
      intent: "subscription",
      payload: withoutSub,
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

  it("method set is exactly the three pinned rails", () => {
    expect([...PAYSWAP_MPP_METHOD_VALUES]).toEqual(["stripe", "evm", "tempo"]);
  });
});

describe("MPP message face — digest binding + receipt evidence gate (laws 2/3)", () => {
  it("same challenge → same digest; different challenge → different digest", async () => {
    const face = makeFace();
    const a = await face.translateInbound({ mppKind: "challenge", payload: challengeFor("stripe+charge") });
    const b = await face.translateInbound({ mppKind: "challenge", payload: challengeFor("stripe+charge") });
    const c = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...challengeFor("stripe+charge"), expires: "2026-12-31T23:59:59Z" },
    });
    if (a.kind !== "validated-untrusted-proposal" || b.kind !== "validated-untrusted-proposal" || c.kind !== "validated-untrusted-proposal") {
      throw new Error("expected validated-untrusted-proposal");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
    expect(a.untrustedPayloadDigest).not.toBe(c.untrustedPayloadDigest);
  });

  it("digest is stable across JSON key ordering (canonical JSON, RFC 8785)", async () => {
    const face = makeFace();
    const mandate = challengeFor("stripe+charge");
    const a = await face.translateInbound({ mppKind: "challenge", payload: mandate });
    const reordered = {
      request: mandate.request,
      intent: mandate.intent,
      method: mandate.method,
      realm: mandate.realm,
      id: mandate.id,
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
    const a = canonicalJsonStringify(CHALLENGE_FIXTURES["stripe+charge"]);
    const b = canonicalJsonStringify({ ...CHALLENGE_FIXTURES["stripe+charge"] });
    expect(a).toBe(b);
  });
});
