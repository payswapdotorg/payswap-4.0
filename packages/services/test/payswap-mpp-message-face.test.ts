/**
 * PaySwap P3 —— MPP 消息面法则电池（handoff v3 优先级 1-4+6 + 评审修正项
 * A-D：Tempo currency TIP-20、EVM Permit2 transferDetails+witness、EVM
 * session action-specific schemas、digest RFC 9530、opaque JCS verify、
 * fatal UTF-8、RFC 3339 日历校验、receipt ref=channelId 等式）。
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
import { createPayswapHostEvidenceAuthority } from "@zcode/services/node";
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
const TIP20_TOKEN = "0x20c0000000000000000000000000000000000001";
const TEMPO_RECIPIENT = "0x742d35cc6634c0532925a3b844bc9e7595f8fe00";
const TEMPO_ACCESS_KEY = "0x1111111111111111111111111111111111111111";

function jcsBase64Url(payload: unknown): string {
  const canonical = canonicalJsonStringify(payload);
  const bytes = new TextEncoder().encode(canonical);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
    methodDetails: { chainId: 84532, permit2Address: EVM_ESCROW },
  },
  "evm+session": {
    amount: "100",
    currency: EVM_TOKEN,
    recipient: EVM_RECIPIENT,
    methodDetails: { chainId: 84532, escrowContract: EVM_ESCROW },
  },
  "tempo+subscription": {
    amount: "999",
    currency: TIP20_TOKEN,
    periodUnit: "week",
    periodCount: "4",
    subscriptionExpires: "2027-06-01T00:00:00Z",
    recipient: TEMPO_RECIPIENT,
    methodDetails: { accessKey: { accessKeyAddress: TEMPO_ACCESS_KEY, keyType: "p256" } },
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
    transferDetails: [{ to: EVM_RECIPIENT, requestedAmount: "1000000" }],
    witness: { challengeHash: "ch-hash-1" },
    signature: "0x" + "f".repeat(130),
  },
  "evm+session": {
    action: "open",
    channelId: "chan-1",
    cumulativeAmount: "0",
    signature: "sig-1",
    type: "hash",
    hash: EVM_TX,
    salt: "salt-" + "1".repeat(32),
  },
  "tempo+subscription": { type: "keyAuthorization", signature: "0x" + "f".repeat(130) },
};

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

function makeFace(
  descriptor: PayswapProtocolAdapterDescriptor = MPP_DESCRIPTOR,
  options: Parameters<typeof createPayswapMppMessageFace>[1] = {},
) {
  return createPayswapMppMessageFace(descriptor, options);
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

describe("MPP message face — registration gate", () => {
  it("creates with a registry-consistent descriptor", () => {
    const face = makeFace();
    expect(face.descriptor.protocolId).toBe("mpp");
  });

  it("version drift refuses at assembly time", () => {
    expect(() => makeFace({ ...MPP_DESCRIPTOR, versionPin: "draft-httpauth-payment-02" })).toThrow(
      /protocol_version_unsupported/,
    );
  });

  it("fact-source drift refuses with protocol_facts_drift", () => {
    expect(() => makeFace({ ...MPP_DESCRIPTOR, factsRetrievedAt: "2026-11-20" })).toThrow(
      /protocol_facts_drift/,
    );
  });

  it("unknown protocol id refuses at assembly time", () => {
    expect(() =>
      makeFace({
        ...MPP_DESCRIPTOR,
        protocolId: "unknown-protocol" as PayswapProtocolAdapterDescriptor["protocolId"],
      }),
    ).toThrow(/protocol_not_registered/);
  });
});

describe("MPP message face — compatibility matrix (five pinned combos)", () => {
  it("registry matrix is exactly the five pinned combinations", () => {
    expect(
      [...PAYSWAP_MPP_METHOD_INTENT_MATRIX.map((e) => e.method + "+" + e.intent)].sort(),
    ).toEqual(["evm+charge", "evm+session", "stripe+charge", "stripe+subscription", "tempo+subscription"]);
    expect(payswapMppMethodIntentSupported("stripe", "charge")).toBe(true);
    expect(payswapMppMethodIntentSupported("stripe", "session")).toBe(false);
    expect(payswapMppMethodIntentSupported("evm", "subscription")).toBe(false);
    expect(payswapMppMethodIntentSupported("tempo", "charge")).toBe(false);
    expect(payswapMppMethodIntentSupported("tempo", "session")).toBe(false);
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

  it("four unsupported in-scope combos refuse protocol_feature_unsupported with the combo in the message", async () => {
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
      // 2026-11-23：矩阵外 rail = 注册表 unsupportedCapabilities 的 typed 拒绝面
      // ——「不可用，不是模拟」用其专码，不再与结构违规共用 unverifiable。
      expect(outcome.refusal.code).toBe("protocol_feature_unsupported");
      expect(outcome.refusal.message).toContain(comboKey);
    }
  });

  it("an unpinned rail method name (charge on hedera) refuses protocol_feature_unsupported — unavailable, not simulated", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: {
        id: "ch_x",
        realm: "api.example.com",
        method: "hedera",
        intent: "charge",
        request: jcsBase64Url({ amount: "100", currency: "usd" }),
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_feature_unsupported");
  });

  it("a non-string method/intent is a structural violation, not a rail verdict (stays unverifiable)", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], method: 7 },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("a credential echoing an out-of-matrix rail refuses before payload validation", async () => {
    const outcome = await makeFace().translateInbound({
      mppKind: "credential",
      payload: {
        challenge: {
          id: "ch_x",
          realm: "api.example.com",
          method: "evm",
          intent: "subscription",
          request: jcsBase64Url({ amount: "100", currency: "usd" }),
        },
        payload: { spt: "spt_abc123" },
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_feature_unsupported");
  });
});

describe("MPP message face — request encoding (base64url + JCS + method schema)", () => {
  it("non-canonical JSON refuses (JCS discipline)", async () => {
    const face = makeFace();
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
  });

  it("padded base64url refuses (= characters violate the nopad rule)", async () => {
    const face = makeFace();
    const padded = Buffer.from(JSON.stringify({ amount: "1" })).toString("base64");
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: padded },
    });
    expect(outcome.kind).toBe("refused");
  });

  it("decoded non-JSON refuses", async () => {
    const notJson = btoa("this is not json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const outcome = await makeFace().translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: notJson },
    });
    expect(outcome.kind).toBe("refused");
  });

  it("method-schema violations refuse", async () => {
    const face = makeFace();
    const bad = jcsBase64Url({ amount: "1500", currency: "usd", methodDetails: { paymentMethodTypes: ["card"] } });
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], request: bad },
    });
    expect(outcome.kind).toBe("refused");
  });
});

describe("MPP message face — challenge optional parameters (official semantics)", () => {
  it("expires (RFC3339) accepted; non-RFC3339 refuses", async () => {
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

  it("digest (RFC 9530 Structured Field format) accepted; non-conforming refuses", async () => {
    const face = makeFace();
    const ok = await face.translateInbound({
      mppKind: "challenge",
      payload: {
        ...CHALLENGE_FIXTURES["stripe+charge"],
        digest: "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
      },
    });
    expect(ok.kind).toBe("validated-untrusted-proposal");
    const bad = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], digest: "just-a-hash" },
    });
    expect(bad.kind).toBe("refused");
    if (bad.kind !== "refused") return;
    expect(bad.refusal.message).toContain("RFC 9530");
  });

  it("opaque (JCS canonical flat string map) accepted; non-canonical refuses", async () => {
    const face = makeFace();
    const okOpaque = jcsBase64Url({ correlation: "abc" });
    const ok = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], opaque: okOpaque },
    });
    expect(ok.kind).toBe("validated-untrusted-proposal");
    // 非canonical（键序与 JCS 不同）
    const nonCanonical = btoa(JSON.stringify({ b: "2", a: "1" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], opaque: nonCanonical },
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
  });

  it("unknown challenge parameters are stripped (official client ignore rule)", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["stripe+charge"], custom_vendor_param: "ignored-by-law" },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(outcome.untrustedPayloadDigest).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("MPP message face — credential dispatch (five pinned payload schemas)", () => {
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

  it("evm-charge credential dispatches all four credential types", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+charge");
    // permit2
    const p2 = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: CREDENTIAL_PAYLOADS["evm+charge"] },
    });
    expect(p2.kind).toBe("validated-untrusted-proposal");
    // authorization
    const auth = await face.translateInbound({
      mppKind: "credential",
      payload: {
        challenge,
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
    expect(auth.kind).toBe("validated-untrusted-proposal");
    // transaction
    const tx = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: { type: "transaction", signature: EVM_TX } },
    });
    expect(tx.kind).toBe("validated-untrusted-proposal");
    // hash
    const hash = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: { type: "hash", hash: EVM_TX } },
    });
    expect(hash.kind).toBe("validated-untrusted-proposal");
  });

  it("evm-charge permit2 without transferDetails refuses (REQUIRED — review correction B)", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+charge");
    const missingTransferDetails = {
      type: "permit2",
      permit: { permitted: [{ token: EVM_TOKEN, amount: "1000000" }], nonce: "n1", deadline: "1763726400" },
      witness: { challengeHash: "ch-hash-1" },
      signature: "0x" + "f".repeat(130),
    };
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: missingTransferDetails },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm-charge permit2 without witness refuses (REQUIRED — challenge binding)", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+charge");
    const missingWitness = {
      type: "permit2",
      permit: { permitted: [{ token: EVM_TOKEN, amount: "1000000" }], nonce: "n1", deadline: "1763726400" },
      transferDetails: [{ to: EVM_RECIPIENT, requestedAmount: "1000000" }],
      signature: "0x" + "f".repeat(130),
    };
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: missingWitness },
    });
    expect(outcome.kind).toBe("refused");
  });

  it("evm-session credential without action-specific fields refuses (review correction C)", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+session");
    // open without type/hash/salt
    const openBare = {
      action: "open",
      channelId: "chan-1",
      cumulativeAmount: "0",
      signature: "sig-1",
    };
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: openBare },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("evm-session open credential with type/hash/salt passes", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+session");
    const openFull = {
      action: "open",
      channelId: "chan-1",
      cumulativeAmount: "0",
      signature: "sig-1",
      type: "hash",
      hash: EVM_TX,
      salt: "salt-" + "1".repeat(32),
    };
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: openFull },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("evm-session non-open credential with type refuses (type is only valid for open)", async () => {
    const face = makeFace();
    const challenge = challengeFor("evm+session");
    const topUpWithType = {
      action: "topUp",
      channelId: "chan-1",
      cumulativeAmount: "100",
      signature: "sig-topup",
      type: "hash",
    };
    const outcome = await face.translateInbound({
      mppKind: "credential",
      payload: { challenge, payload: topUpWithType },
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

  it("cross-rail credential placement refuses", async () => {
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

describe("MPP message face — Tempo subscription TIP-20 currency (review correction A)", () => {
  it("Tempo subscription with ISO currency code refuses (TIP-20 address REQUIRED)", async () => {
    const face = makeFace();
    const badCurrency = jcsBase64Url({
      ...REQUEST_OBJECTS["tempo+subscription"],
      currency: "usd",
    });
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["tempo+subscription"], request: badCurrency },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("Tempo subscription with TIP-20 address passes", async () => {
    const face = makeFace();
    const goodRequest = jcsBase64Url(REQUEST_OBJECTS["tempo+subscription"]);
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: { ...CHALLENGE_FIXTURES["tempo+subscription"], request: goodRequest },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });
});

describe("MPP message face — Tempo subscriptionExpires cross-check (review correction A)", () => {
  it("subscriptionExpires NOT strictly later than challenge expires refuses", async () => {
    const face = makeFace();
    const badRequest = jcsBase64Url({
      ...REQUEST_OBJECTS["tempo+subscription"],
      subscriptionExpires: "2026-01-01T00:00:00Z",
    });
    const outcome = await face.translateInbound({
      mppKind: "challenge",
      payload: {
        ...CHALLENGE_FIXTURES["tempo+subscription"],
        expires: "2026-06-01T00:00:00Z",
        request: badRequest,
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.message).toContain("subscriptionExpires");
  });
});

describe("MPP message face — receipt dispatch (five pinned receipt schemas)", () => {
  async function receiptFor(comboKey: string) {
    const face = makeFace();
    const [method, intent] = comboKey.split("+");
    return face.translateInbound({
      mppKind: "receipt",
      intent,
      payload: RECEIPTS[comboKey],
    });
  }

  it("all five supported combos pass with their pinned receipt schemas", async () => {
    const face = makeFace();
    for (const comboKey of COMBO_KEYS) {
      const outcome = await receiptFor(comboKey);
      expect(outcome.kind).toBe("validated-untrusted-proposal");
      if (outcome.kind !== "validated-untrusted-proposal") return;
      expect(outcome.protocolId).toBe("mpp");
    }
  });

  it("evm-session receipt reference ≠ channelId refuses (review correction C)", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "receipt",
      intent: "session",
      payload: {
        ...RECEIPTS["evm+session"],
        reference: "not-the-channel-id",
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("channelId");
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

  it("cross-structure placement refuses (tempo receipt under evm intent)", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "receipt",
      intent: "charge",
      payload: { ...RECEIPTS["tempo+subscription"], method: "evm" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("invalid timestamp (non-RFC3339) refuses", async () => {
    const face = makeFace();
    const outcome = await face.translateInbound({
      mppKind: "receipt",
      intent: "charge",
      payload: { ...RECEIPTS["stripe+charge"], timestamp: "not-a-date" },
    });
    expect(outcome.kind).toBe("refused");
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
    const authority = createPayswapHostEvidenceAuthority();
    const face = makeFace(MPP_DESCRIPTOR, { evidenceVerifier: authority.verifier });
    for (const [index, state] of (["indeterminate", "pending", "failed"] as const).entries()) {
      const evidence = authority.issue({
        evidenceRef: `ledger://evidence/settlement-${index}`,
        evidenceDigest: "a".repeat(64),
        state,
        capturedAt: "2026-11-22T00:00:00Z",
        protocolId: "mpp",
        subjectRef: "execution://exec-1",
      });
      const outcome = await face.emitReceipt(evidence);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_receipt_unavailable");
    }
  });

  it("settled-verified host evidence → receipt-emitted (exact keys, no financial authority)", async () => {
    const authority = createPayswapHostEvidenceAuthority();
    const evidence = authority.issue({
      evidenceRef: "ledger://evidence/settlement-1",
      evidenceDigest: "a".repeat(64),
      state: "settled-verified",
      capturedAt: "2026-11-22T00:00:00Z",
      protocolId: "mpp",
      subjectRef: "execution://exec-1",
    });
    const outcome = await makeFace(MPP_DESCRIPTOR, {
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
    const a = canonicalJsonStringify(CHALLENGE_FIXTURES["stripe+charge"]);
    const b = canonicalJsonStringify({ ...CHALLENGE_FIXTURES["stripe+charge"] });
    expect(a).toBe(b);
  });
});
