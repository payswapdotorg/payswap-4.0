/**
 * PaySwap P3-A —— 协议宿主边界法则电池（handoff v4 P3-A）。
 *
 * 被钉住的法则（违反即实现缺陷）：
 * 1. **宿主是唯一生产调用面**：只有协议宿主调用适配器的 translateInbound /
 *    emitReceipt；宿主用登记表（`createPayswapProtocolMessageFaces`）装配。
 * 2. **challenge 绑定**：凭据回显必须与宿主签发记录逐字一致（id/realm/method/
 *    intent/request/expires/digest/opaque/header）—— 任一改动 → challenge_mismatch。
 * 3. **过期由宿主时钟裁决**：进站调用不接收时间；过期 → challenge_expired，
 *    且不消费记录。
 * 4. **原子单次使用**：并发重复恰有一个成功；重连后重放 → challenge_consumed；
 *    已消费的记录在其后过期时仍答 consumed（重放事实不被过期掩盖）。
 * 5. **未知即拒绝**：从未签发 / 已清理 → challenge_unknown。
 * 6. **消费 ≠ 认证**：消费成功的结局是 `challenge-consumed` 且
 *    `credential: "unverified"` —— 没有任何「已验证/已结算」位可被下游读取。
 * 7. **x402 双身份**：requirements（绑定宿主签发的 402，可重发、有宿主有效期）
 *    ≠ 付款授权（network + from + nonce —— 单次使用的键）。同一 requirements 的
 *    第二笔合法付款不是重放；同一授权换签名字节重放仍是重放。
 * 8. **收据来源可追溯**：只有宿主证据权威签发过的证据可发收据；伪造引用 →
 *    protocol_receipt_unavailable；跨协议复用 → protocol_evidence_untrusted。
 * 9. **适配器不可铸造证据**：结构合法但未签发的对象、克隆对象均被拒。
 */

import {
  canonicalJsonStringify,
  createPayswapProtocolMessageFaces,
  payswapProtocolAdapterDescriptor,
} from "@zcode/shared/payswap";
import {
  createPayswapHostEvidenceAuthority,
  createPayswapProtocolChallengeRegistry,
  createPayswapProtocolHost,
} from "@zcode/services/node";
import { describe, expect, it } from "vitest";

const NOW_MS = Date.parse("2026-11-22T00:00:00Z");
const NOW = new Date(NOW_MS);
const LATER = new Date(NOW_MS + 5 * 60_000);
const EXPIRES = "2026-11-22T00:10:00Z";

function jcsBase64Url(payload: unknown): string {
  const canonical = canonicalJsonStringify(payload);
  const bytes = new TextEncoder().encode(canonical);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 可推进的宿主时钟（被测宿主的唯一时间源）。 */
function makeClock(start = NOW) {
  let current = start;
  return {
    now: () => current,
    set(next: Date) {
      current = next;
    },
  };
}

const STRIPE_CHARGE_REQUEST = {
  amount: "1500",
  currency: "usd",
  methodDetails: { networkId: "net_stripe_profile_1", paymentMethodTypes: ["card"] },
};

function mppChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch_stripe_charge",
    realm: "api.example.com",
    method: "stripe",
    intent: "charge",
    request: jcsBase64Url(STRIPE_CHARGE_REQUEST),
    expires: EXPIRES,
    ...overrides,
  };
}

function mppCredential(challenge: unknown = mppChallenge(), payload?: unknown) {
  return { challenge, payload: payload ?? credentialPayloadFor(challenge) };
}

/** 每条 rail 的结构合法凭据载荷 —— 篡改行必须先过适配器，才能证明是**宿主**裁决的错配。 */
function credentialPayloadFor(challenge: unknown): unknown {
  const { method, intent } = challenge as { method: string; intent: string };
  if (method === "evm" && intent === "charge") return { type: "hash", hash: "0x" + "d".repeat(64) };
  if (method === "stripe" && intent === "subscription") return { paymentMethod: "pm_1" };
  return { spt: "spt_abc123" };
}

async function mppCredentialOutcome(
  host: ReturnType<typeof createPayswapProtocolHost>,
  challenge: unknown = mppChallenge(),
) {
  return host.handleInbound({ protocolId: "mpp", message: { mppKind: "credential", payload: mppCredential(challenge) } });
}

const EVM_ADDRESS = "0x" + "a".repeat(40);

/** evm+charge 的结构合法 challenge（同 id —— 用来证明宿主对 method/intent 的绑定裁决）。 */
const EVM_CHARGE_CHALLENGE_SAME_ID = {
  id: "ch_stripe_charge",
  realm: "api.example.com",
  method: "evm",
  intent: "charge",
  request: jcsBase64Url({
    amount: "1500",
    currency: EVM_ADDRESS,
    recipient: "0x" + "b".repeat(40),
    methodDetails: { chainId: 1, permit2Address: "0x" + "c".repeat(40) },
  }),
  expires: EXPIRES,
};

/** stripe+subscription 的结构合法 challenge（同 id）。 */
const STRIPE_SUBSCRIPTION_CHALLENGE_SAME_ID = {
  id: "ch_stripe_charge",
  realm: "api.example.com",
  method: "stripe",
  intent: "subscription",
  request: jcsBase64Url({
    amount: "1500",
    currency: "usd",
    periodUnit: "month",
    periodCount: "1",
    methodDetails: { networkId: "net_stripe_profile_1", paymentMethodTypes: ["card"] },
  }),
  expires: EXPIRES,
};

// —— x402 官方示例值（core §5 / scheme exact/EVM @ b711fa9f）————————————————
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
/** 65-byte（0x + 130 hex）。 */
const SIGNATURE = "0x" + "2d6a".repeat(32) + "1c";
const NONCE = "0x" + "f374".repeat(16);

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
  resource: { url: "https://api.example.com/premium-data", description: "Access to premium market data" },
  accepts: [REQUIREMENTS],
  extensions: {},
};

function x402Payment(
  nonce = NONCE,
  signature = SIGNATURE,
  accepted: Record<string, unknown> = {},
  authorization: Record<string, unknown> = {},
) {
  return {
    x402Version: 2,
    accepted: { ...REQUIREMENTS, ...accepted },
    payload: {
      signature,
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: "10000",
        validAfter: String(Math.floor(NOW_MS / 1000) - 60),
        validBefore: String(Math.floor(NOW_MS / 1000) + 3600),
        nonce,
        ...authorization,
      },
    },
    extensions: {},
  };
}

async function x402PaymentOutcome(
  host: ReturnType<typeof createPayswapProtocolHost>,
  payment: unknown = x402Payment(),
) {
  return host.handleInbound({ protocolId: "x402", message: { x402Kind: "payment-payload", payload: payment } });
}

const CHECKOUT_JWT = "eyJhbGciOiJFUzI1NiJ9.e30.signature";

async function checkoutHash(jwt: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ap2Mandate() {
  return {
    vct: "mandate.checkout.1",
    checkout_jwt: CHECKOUT_JWT,
    checkout_hash: await checkoutHash(CHECKOUT_JWT),
    iat: 1763640000,
    iss: "agent-provider-1",
    aud: "merchant",
  };
}

function makeHost(options: { clock?: ReturnType<typeof makeClock>; withVerifier?: boolean } = {}) {
  const authority = createPayswapHostEvidenceAuthority();
  const clock = options.clock ?? makeClock();
  const host = createPayswapProtocolHost({
    adapters: createPayswapProtocolMessageFaces(
      options.withVerifier === false ? {} : { evidenceVerifier: authority.verifier },
    ),
    evidenceAuthority: authority,
    clock: clock.now,
  });
  return { authority, host, clock };
}

function settledEvidence(
  authority: ReturnType<typeof createPayswapHostEvidenceAuthority>,
  protocolId: "ap2" | "x402" | "mpp",
  evidenceRef = "ledger://evidence/settlement-1",
) {
  return authority.issue({
    evidenceRef,
    evidenceDigest: "a".repeat(64),
    state: "settled-verified",
    capturedAt: NOW.toISOString(),
    protocolId,
    subjectRef: "execution://exec-1",
  });
}

function refusalCodeOf(outcome: { kind: string }): string {
  if (outcome.kind !== "refused") throw new Error(`expected refusal, got ${outcome.kind}`);
  return (outcome as { refusal: { code: string } }).refusal.code;
}

describe("Payswap protocol host — assembly", () => {
  it("assembles the three landed faces from the registry (descriptors derived from the pins)", () => {
    const { host } = makeHost();
    const outcomes = [
      host.handleInbound({ protocolId: "ap2", message: { ap2Kind: "mandate", payload: { vct: "nope" } } }),
      host.handleInbound({ protocolId: "mpp", message: { mppKind: "challenge", payload: mppChallenge() } }),
      host.handleInbound({ protocolId: "x402", message: { x402Kind: "payment-required", payload: PAYMENT_REQUIRED } }),
    ];
    return Promise.all(outcomes).then(([ap2, mpp, x402]) => {
      expect(ap2.kind).toBe("refused");
      expect(mpp.kind).toBe("validated-untrusted-proposal");
      expect(x402.kind).toBe("validated-untrusted-proposal");
    });
  });

  it("refuses two adapters for the same protocol (exactly one adapter per protocol)", () => {
    const authority = createPayswapHostEvidenceAuthority();
    const ap2Descriptor = payswapProtocolAdapterDescriptor("ap2");
    expect(() =>
      createPayswapProtocolHost({
        adapters: [
          ...createPayswapProtocolMessageFaces({ evidenceVerifier: authority.verifier }),
          createPayswapProtocolMessageFaces({ evidenceVerifier: authority.verifier }).find(
            (a) => a.descriptor.protocolId === ap2Descriptor.protocolId,
          )!,
        ],
        evidenceAuthority: authority,
      }),
    ).toThrow(/exactly one adapter per protocol/);
  });

  it("an inbound message for a protocol with no registered adapter refuses protocol_not_registered", async () => {
    const { host } = makeHost();
    const outcome = await host.handleInbound({
      protocolId: "visa-tap" as never,
      message: {},
    });
    expect(refusalCodeOf(outcome)).toBe("protocol_not_registered");
  });

  it("faces assembled without the evidence verifier fail closed on receipts even for host-issued evidence (mis-assembly cannot mint receipts)", async () => {
    const { authority, host } = makeHost({ withVerifier: false });
    settledEvidence(authority, "mpp");
    expect(
      refusalCodeOf(await host.emitReceipt({ protocolId: "mpp", evidenceRef: "ledger://evidence/settlement-1" })),
    ).toBe("protocol_evidence_untrusted");
  });
});

describe("Payswap protocol host — MPP challenge binding (P3-A)", () => {
  it("issues a challenge and consumes its exact credential echo once — the outcome is challenge-consumed with an UNVERIFIED credential", async () => {
    const { host } = makeHost();
    const challenge = mppChallenge();
    const record = await host.issueMppChallenge({ wireChallenge: challenge });
    expect(record.challengeId).toBe(challenge.id);
    expect(record.protocolId).toBe("mpp");
    expect(record.state).toBe("issued");

    const outcome = await mppCredentialOutcome(host);
    expect(outcome.kind).toBe("challenge-consumed");
    if (outcome.kind !== "challenge-consumed") return;
    // 结局键闭集：没有任何 verified / authenticated / settled 位。
    expect(Object.keys(outcome).sort()).toEqual([
      "challenge",
      "credential",
      "kind",
      "protocolId",
      "untrustedPayloadDigest",
      "versionPin",
    ]);
    expect(outcome.credential).toBe("unverified");
    // 记录的过期时刻是宿主规范化后的 ISO 串。
    expect(outcome.challenge).toEqual({
      challengeId: challenge.id,
      expiresAt: new Date(EXPIRES).toISOString(),
      consumedAt: NOW.toISOString(),
    });
  });

  it.each([
    ["request", "protocol_challenge_mismatch", () => mppChallenge({ request: jcsBase64Url({ ...STRIPE_CHARGE_REQUEST, amount: "9999" }) })],
    ["expires", "protocol_challenge_mismatch", () => mppChallenge({ expires: "2026-11-22T00:05:00Z" })],
    // 改了 id = 指向一个宿主从未签发的 challenge —— 如实答 unknown。
    ["id", "protocol_challenge_unknown", () => mppChallenge({ id: "ch_other" })],
    ["realm", "protocol_challenge_mismatch", () => mppChallenge({ realm: "evil.example.com" })],
    ["digest", "protocol_challenge_mismatch", () => mppChallenge({ digest: `sha-256=:${btoa("other-body")}:` })],
    ["opaque", "protocol_challenge_mismatch", () => mppChallenge({ opaque: jcsBase64Url({ session: "hijacked" }) })],
    ["header", "protocol_challenge_mismatch", () => mppChallenge({ header: "Payment-Authorization" })],
    [
      "method (evm+charge, structurally valid for that rail)",
      "protocol_challenge_mismatch",
      () => EVM_CHARGE_CHALLENGE_SAME_ID,
    ],
    [
      "intent (stripe+subscription, structurally valid for that rail)",
      "protocol_challenge_mismatch",
      () => STRIPE_SUBSCRIPTION_CHALLENGE_SAME_ID,
    ],
  ])(
    "an altered %s in the credential echo refuses %s (and stays unconsumed)",
    async (_field, expectedCode, echoedChallenge) => {
      const { host } = makeHost();
      await host.issueMppChallenge({ wireChallenge: mppChallenge() });
      expect(refusalCodeOf(await mppCredentialOutcome(host, echoedChallenge()))).toBe(expectedCode);
      // 篡改的尝试不烧掉真 challenge：原样凭据仍可消费一次。
      expect((await mppCredentialOutcome(host)).kind).toBe("challenge-consumed");
    },
  );

  it("an echo that drops an optional bound parameter refuses (opaque is part of the binding)", async () => {
    const { host } = makeHost();
    await host.issueMppChallenge({
      wireChallenge: mppChallenge({ opaque: jcsBase64Url({ session: "s1" }) }),
    });
    expect(refusalCodeOf(await mppCredentialOutcome(host))).toBe("protocol_challenge_mismatch");
  });

  it("the display-only description is NOT part of the binding (a client may omit it)", async () => {
    const { host } = makeHost();
    await host.issueMppChallenge({ wireChallenge: mppChallenge({ description: "Premium data" }) });
    expect((await mppCredentialOutcome(host, mppChallenge())).kind).toBe("challenge-consumed");
  });

  it("unknown challenge id refuses with protocol_challenge_unknown (fail-closed)", async () => {
    const { host } = makeHost();
    expect(refusalCodeOf(await mppCredentialOutcome(host, mppChallenge({ id: "ch_never_issued" })))).toBe(
      "protocol_challenge_unknown",
    );
  });

  it("expiry is adjudicated by the host clock: inbound calls take no time; advancing the clock flips the verdict", async () => {
    const { host, clock } = makeHost();
    await host.issueMppChallenge({ wireChallenge: mppChallenge() });

    clock.set(new Date(Date.parse(EXPIRES) - 1));
    expect((await mppCredentialOutcome(host)).kind).toBe("challenge-consumed");

    const second = makeHost();
    await second.host.issueMppChallenge({ wireChallenge: mppChallenge() });
    second.clock.set(new Date(Date.parse(EXPIRES)));
    expect(refusalCodeOf(await mppCredentialOutcome(second.host))).toBe("protocol_challenge_expired");

    // 过期裁决不消费记录：时钟回到有效期内仍可消费一次。
    second.clock.set(LATER);
    expect((await mppCredentialOutcome(second.host)).kind).toBe("challenge-consumed");
  });

  it("a replay of a consumed challenge answers consumed even after the challenge has expired (the replay fact is not masked by expiry)", async () => {
    const { host, clock } = makeHost();
    await host.issueMppChallenge({ wireChallenge: mppChallenge() });
    expect((await mppCredentialOutcome(host)).kind).toBe("challenge-consumed");
    clock.set(new Date(Date.parse(EXPIRES) + 1000));
    expect(refusalCodeOf(await mppCredentialOutcome(host))).toBe("protocol_challenge_consumed");
  });

  it("concurrent duplicate submissions consume exactly one (atomic single-use)", async () => {
    const { host } = makeHost();
    await host.issueMppChallenge({ wireChallenge: mppChallenge() });

    const attempts = await Promise.all(Array.from({ length: 16 }, () => mppCredentialOutcome(host)));
    expect(attempts.filter((o) => o.kind === "challenge-consumed")).toHaveLength(1);
    for (const outcome of attempts.filter((o) => o.kind === "refused")) {
      expect(refusalCodeOf(outcome)).toBe("protocol_challenge_consumed");
    }
  });

  it("replay after reconnect refuses with protocol_challenge_consumed (registry is host state, not adapter or agent state)", async () => {
    const registry = createPayswapProtocolChallengeRegistry();
    const authority = createPayswapHostEvidenceAuthority();
    const adapters = () => createPayswapProtocolMessageFaces({ evidenceVerifier: authority.verifier });
    const clock = makeClock();
    const first = createPayswapProtocolHost({ adapters: adapters(), evidenceAuthority: authority, challengeRegistry: registry, clock: clock.now });
    await first.issueMppChallenge({ wireChallenge: mppChallenge() });
    expect((await mppCredentialOutcome(first)).kind).toBe("challenge-consumed");

    // 「重连」= 适配器全部重建、宿主面重建 —— 注册表仍是同一个宿主实例状态。
    clock.set(LATER);
    const reconnected = createPayswapProtocolHost({ adapters: adapters(), evidenceAuthority: authority, challengeRegistry: registry, clock: clock.now });
    expect(refusalCodeOf(await mppCredentialOutcome(reconnected))).toBe("protocol_challenge_consumed");
  });

  it("issue refuses structurally invalid challenges, challenges without expires, and already-expired challenges (host policy — nothing is registered)", async () => {
    const { host } = makeHost();
    await expect(
      host.issueMppChallenge({ wireChallenge: mppChallenge({ request: "not-base64url-json" }) }),
    ).rejects.toThrow(/protocol_message_unverifiable/);
    const { expires: _omitted, ...withoutExpires } = mppChallenge();
    await expect(host.issueMppChallenge({ wireChallenge: withoutExpires })).rejects.toThrow(/expires/);
    await expect(
      host.issueMppChallenge({ wireChallenge: mppChallenge({ expires: "2026-11-21T23:00:00Z" }) }),
    ).rejects.toThrow(/expires/);
    expect(refusalCodeOf(await mppCredentialOutcome(host))).toBe("protocol_challenge_unknown");
  });

  it("challenge ids are single-issue: re-issuing a live id refuses (a second challenge must carry a new id)", async () => {
    const { host } = makeHost();
    await host.issueMppChallenge({ wireChallenge: mppChallenge() });
    await expect(host.issueMppChallenge({ wireChallenge: mppChallenge() })).rejects.toThrow(/already issued/);
  });

  it("after a consumed challenge is swept an old credential answers unknown (still refused — never re-acceptable)", async () => {
    const registry = createPayswapProtocolChallengeRegistry();
    const authority = createPayswapHostEvidenceAuthority();
    const clock = makeClock();
    const host = createPayswapProtocolHost({
      adapters: createPayswapProtocolMessageFaces({ evidenceVerifier: authority.verifier }),
      evidenceAuthority: authority,
      challengeRegistry: registry,
      clock: clock.now,
    });
    await host.issueMppChallenge({ wireChallenge: mppChallenge() });
    expect((await mppCredentialOutcome(host)).kind).toBe("challenge-consumed");

    clock.set(new Date(Date.parse("2026-11-23T00:00:00Z")));
    expect(registry.size).toBeGreaterThan(0);
    expect(registry.sweep(clock.now())).toBe(1);
    expect(registry.size).toBe(0);
    expect(refusalCodeOf(await mppCredentialOutcome(host))).toBe("protocol_challenge_unknown");
  });
});

describe("Payswap protocol host — x402 requirements binding + payment single-use (P3-A)", () => {
  it("advertises a 402 and consumes its payment once — challenge-consumed with an UNVERIFIED credential", async () => {
    const { host } = makeHost();
    const records = await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect(records).toHaveLength(1);
    expect(records[0].requirementsDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 宿主策略（Row 5 处分）：有效期 = 广告时刻 + 该条目的 maxTimeoutSeconds。
    expect(records[0].expiresAt).toBe(new Date(NOW_MS + 60_000).toISOString());

    const outcome = await x402PaymentOutcome(host);
    expect(outcome.kind).toBe("challenge-consumed");
    if (outcome.kind !== "challenge-consumed") return;
    expect(outcome.credential).toBe("unverified");
    expect(outcome.challenge.challengeId).toBe(records[0].challengeId);
  });

  it("a SECOND legitimate purchase of the same resource (new payer nonce) is a new authorization, not a replay", async () => {
    const { host } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
    expect((await x402PaymentOutcome(host, x402Payment("0x" + "e".repeat(64)))).kind).toBe("challenge-consumed");
  });

  it("a different payer's authorization on the same nonce is a different credential (identity = network + from + nonce)", async () => {
    const { host } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
    const otherPayer = x402Payment();
    (otherPayer.payload.authorization as { from: string }).from = "0x" + "9".repeat(40);
    expect((await x402PaymentOutcome(host, otherPayer)).kind).toBe("challenge-consumed");
  });

  it("replaying the same authorization refuses protocol_challenge_consumed — even with a different (malleable) signature", async () => {
    const { host } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
    expect(refusalCodeOf(await x402PaymentOutcome(host))).toBe("protocol_challenge_consumed");
    expect(
      refusalCodeOf(await x402PaymentOutcome(host, x402Payment(NONCE, "0x" + "1".repeat(130)))),
    ).toBe("protocol_challenge_consumed");
  });

  it("replaying after the requirements were re-advertised is still refused (consumed authorizations outlive the 402)", async () => {
    const { host, clock } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
    clock.set(new Date(NOW_MS + 120_000));
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect(refusalCodeOf(await x402PaymentOutcome(host))).toBe("protocol_challenge_consumed");
  });

  it("re-advertising the same 402 is idempotent and refreshes the host expiry (a stale 402 becomes payable again)", async () => {
    const { host, clock } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    clock.set(new Date(NOW_MS + 61_000));
    expect(refusalCodeOf(await x402PaymentOutcome(host))).toBe("protocol_challenge_expired");

    const records = await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    expect(records[0].expiresAt).toBe(new Date(NOW_MS + 61_000 + 60_000).toISOString());
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
  });

  it("a payment for requirements that were never advertised refuses protocol_challenge_unknown", async () => {
    const { host } = makeHost();
    expect(refusalCodeOf(await x402PaymentOutcome(host))).toBe("protocol_challenge_unknown");
  });

  it("a payment whose requirements differ by one field never binds to the honest record (amount tamper → unknown)", async () => {
    const { host } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    // 篡改后的载荷自身一致（amount 与 value 同改）—— 过得了适配器，但它的 requirements
    // 从未被宿主广告：摘要不命中诚实记录。
    const tampered = x402Payment(
      NONCE,
      SIGNATURE,
      { amount: "10001", extra: { name: "USDC", version: "2" } },
      { value: "10001" },
    );
    expect(refusalCodeOf(await x402PaymentOutcome(host, tampered))).toBe("protocol_challenge_unknown");
    // 诚实的付款不受影响。
    expect((await x402PaymentOutcome(host)).kind).toBe("challenge-consumed");
  });

  it("concurrent duplicate payments consume exactly one", async () => {
    const { host } = makeHost();
    await host.issueX402PaymentRequired({ wirePaymentRequired: PAYMENT_REQUIRED });
    const attempts = await Promise.all(Array.from({ length: 16 }, () => x402PaymentOutcome(host)));
    expect(attempts.filter((o) => o.kind === "challenge-consumed")).toHaveLength(1);
    for (const outcome of attempts.filter((o) => o.kind === "refused")) {
      expect(refusalCodeOf(outcome)).toBe("protocol_challenge_consumed");
    }
  });

  it("advertising refuses structurally invalid 402s and requirements outside the supported subset (nothing is registered)", async () => {
    const { host } = makeHost();
    await expect(host.issueX402PaymentRequired({ wirePaymentRequired: { x402Version: 2 } })).rejects.toThrow(
      /protocol_message_unverifiable/,
    );
    await expect(
      host.issueX402PaymentRequired({
        wirePaymentRequired: { ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENTS, scheme: "upto" }] },
      }),
    ).rejects.toThrow(/protocol_feature_unsupported/);
    expect(refusalCodeOf(await x402PaymentOutcome(host))).toBe("protocol_challenge_unknown");
  });

  it("the PaymentRequired message itself and SettlementResponses stay untrusted proposals on the inbound face", async () => {
    const { host } = makeHost();
    const required = await host.handleInbound({ protocolId: "x402", message: { x402Kind: "payment-required", payload: PAYMENT_REQUIRED } });
    const settlement = await host.handleInbound({
      protocolId: "x402",
      message: { x402Kind: "settlement-response", payload: { success: true, transaction: "0x" + "e".repeat(64), network: "eip155:84532" } },
    });
    expect(required.kind).toBe("validated-untrusted-proposal");
    expect(settlement.kind).toBe("validated-untrusted-proposal");
  });
});

describe("Payswap protocol host — receipt provenance (P3-A)", () => {
  it("emits a receipt only for host-issued evidence, per protocol, looked up by reference", async () => {
    const { authority, host } = makeHost();
    settledEvidence(authority, "mpp");

    const outcome = await host.emitReceipt({ protocolId: "mpp", evidenceRef: "ledger://evidence/settlement-1" });
    expect(outcome.kind).toBe("receipt-emitted");
    if (outcome.kind !== "receipt-emitted") return;
    expect(outcome.settlementEvidenceRef).toBe("ledger://evidence/settlement-1");
  });

  it("fabricated evidence ref refuses protocol_receipt_unavailable", async () => {
    const { host } = makeHost();
    expect(
      refusalCodeOf(await host.emitReceipt({ protocolId: "ap2", evidenceRef: "ledger://evidence/never-issued" })),
    ).toBe("protocol_receipt_unavailable");
  });

  it("cross-protocol evidence reuse refuses protocol_evidence_untrusted", async () => {
    const { authority, host } = makeHost();
    settledEvidence(authority, "mpp");
    expect(
      refusalCodeOf(await host.emitReceipt({ protocolId: "ap2", evidenceRef: "ledger://evidence/settlement-1" })),
    ).toBe("protocol_evidence_untrusted");
  });

  it("non-settled host evidence refuses protocol_receipt_unavailable (indeterminate / pending / failed)", async () => {
    const { authority, host } = makeHost();
    for (const [index, state] of (["indeterminate", "pending", "failed"] as const).entries()) {
      authority.issue({
        evidenceRef: `ledger://evidence/${state}`,
        evidenceDigest: "b".repeat(64),
        state,
        capturedAt: NOW.toISOString(),
        protocolId: "ap2",
        subjectRef: `execution://exec-${index}`,
      });
      expect(refusalCodeOf(await host.emitReceipt({ protocolId: "ap2", evidenceRef: `ledger://evidence/${state}` }))).toBe(
        "protocol_receipt_unavailable",
      );
    }
  });

  it("no evidence has been issued in a fresh host → every protocol refuses every reference (P3 production posture: no issuer, no receipts)", async () => {
    const { host } = makeHost();
    for (const protocolId of ["ap2", "x402", "mpp"] as const) {
      expect(refusalCodeOf(await host.emitReceipt({ protocolId, evidenceRef: "ledger://evidence/anything" }))).toBe(
        "protocol_receipt_unavailable",
      );
    }
  });

  it("the authority refuses malformed claims at issue (no evidence record can exist in a shape the gate would refuse)", () => {
    const authority = createPayswapHostEvidenceAuthority();
    expect(() =>
      authority.issue({
        evidenceRef: "",
        evidenceDigest: "b".repeat(64),
        state: "settled-verified",
        capturedAt: NOW.toISOString(),
        protocolId: "ap2",
        subjectRef: "execution://exec-1",
      }),
    ).toThrow(/evidenceRef/);
    expect(() =>
      authority.issue({
        evidenceRef: "ledger://evidence/bad-digest",
        evidenceDigest: "not a digest",
        state: "settled-verified",
        capturedAt: NOW.toISOString(),
        protocolId: "ap2",
        subjectRef: "execution://exec-1",
      }),
    ).toThrow(/evidenceDigest/);
  });
});

describe("Payswap protocol host — AP2 (same production call path, no host challenge semantics)", () => {
  it("an AP2 mandate is an untrusted proposal with no challenge consumption", async () => {
    const { host } = makeHost();
    const outcome = await host.handleInbound({ protocolId: "ap2", message: { ap2Kind: "mandate", payload: await ap2Mandate() } });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
    expect(outcome.challengeBinding).toBeUndefined();
  });

  it("replaying the same AP2 mandate yields the same untrusted proposal — no state, no single-use claim, no authority", async () => {
    const { host } = makeHost();
    const mandate = await ap2Mandate();
    const first = await host.handleInbound({ protocolId: "ap2", message: { ap2Kind: "mandate", payload: mandate } });
    const replay = await host.handleInbound({ protocolId: "ap2", message: { ap2Kind: "mandate", payload: mandate } });
    expect(first).toEqual(replay);
    expect(host.challengeRegistry.size).toBe(0);
  });

  it("AP2 receipts travel the same host evidence path as MPP and x402", async () => {
    const { authority, host } = makeHost();
    settledEvidence(authority, "ap2", "ledger://evidence/ap2-settlement");
    expect((await host.emitReceipt({ protocolId: "ap2", evidenceRef: "ledger://evidence/ap2-settlement" })).kind).toBe(
      "receipt-emitted",
    );
  });
});

describe("Payswap host evidence authority — non-forgeability (P3-A)", () => {
  it("verifies only the exact frozen object it issued", async () => {
    const authority = createPayswapHostEvidenceAuthority();
    const evidence = settledEvidence(authority, "mpp");

    await expect(authority.verifier.verify(evidence)).resolves.toBe(true);

    const clone = { ...evidence };
    await expect(authority.verifier.verify(clone)).resolves.toBe(false);

    const roundTripped = JSON.parse(JSON.stringify(evidence)) as typeof evidence;
    await expect(authority.verifier.verify(roundTripped)).resolves.toBe(false);

    const fabricated = {
      evidenceRef: "ledger://evidence/settlement-1",
      evidenceDigest: "a".repeat(64),
      state: "settled-verified" as const,
      capturedAt: NOW.toISOString(),
      hostAttestationId: "forged",
      protocolId: "mpp" as const,
      subjectRef: "execution://exec-1",
    };
    await expect(authority.verifier.verify(fabricated)).resolves.toBe(false);
  });

  it("two authorities are mutually untrusted (an evidence object from another host instance is not ours)", async () => {
    const issuer = createPayswapHostEvidenceAuthority();
    const other = createPayswapHostEvidenceAuthority();
    const evidence = settledEvidence(issuer, "mpp");
    await expect(other.verifier.verify(evidence)).resolves.toBe(false);
    expect(other.lookup(evidence.evidenceRef)).toBeNull();
  });

  it("a structurally valid but unissued evidence object is refused by the adapter", async () => {
    const authority = createPayswapHostEvidenceAuthority();
    const [mppFace] = createPayswapProtocolMessageFaces({ evidenceVerifier: authority.verifier }).filter(
      (a) => a.descriptor.protocolId === "mpp",
    );
    const fabricated = {
      evidenceRef: "ledger://evidence/settlement-1",
      evidenceDigest: "a".repeat(64),
      state: "settled-verified",
      capturedAt: NOW.toISOString(),
      hostAttestationId: "forged",
      protocolId: "mpp",
      subjectRef: "execution://exec-1",
    };
    expect(refusalCodeOf(await mppFace!.emitReceipt(fabricated as never))).toBe("protocol_evidence_untrusted");
  });

  it("an adapter without an evidence verifier fails closed", async () => {
    const [x402Face] = createPayswapProtocolMessageFaces({}).filter((a) => a.descriptor.protocolId === "x402");
    expect(
      refusalCodeOf(
        await x402Face!.emitReceipt({
          evidenceRef: "ledger://evidence/settlement-1",
          evidenceDigest: "a".repeat(64),
          state: "settled-verified",
          capturedAt: NOW.toISOString(),
          hostAttestationId: "anything",
          protocolId: "x402",
          subjectRef: "execution://exec-1",
        } as never),
      ),
    ).toBe("protocol_evidence_untrusted");
  });
});
