/**
 * PaySwap P3 —— AP2 消息面法则电池（protocol-contract.ts 法则 1-5 的 AP2 实现
 * 证明；registry 法则 5 的实现许可 = AP2 reverifyBeforeAdapter 已清空 —— 第三批
 * 检索 2026-11-21 在案）。
 *
 * 2026-11-22 对齐修正轮（Session B 对抗评审 F1-F14 + Session A 规范核验，
 * 全部官方源逐字）：constraints 官方数组格式 + 判别符精确；cnf open REQUIRED；
 * Payment Mandate 官方 claim 集（transaction_id REQUIRED 等 —— 此前闭集把约束
 * 子字段名误提到顶层且漏五枚官方 claim，任何官方 payment mandate 都被拒）；
 * receipt 三结构分离（Checkout Receipt / Payment Receipt / Action Authorization
 * Mandate Receipt —— 三种不同线格式，错置即拒）；checkout_hash 无密钥完整性
 * 校验（sha-256，不需要签发者密钥）；base64url 形态检查；order_id iff 双向
 * 强制；validated 术语纪律（结构验证 ≠ 密码学验证）；宿主结算证据边界
 * （emitReceipt 只接受宿主签发的结构化 settled-verified 证据对象）。
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

const CHECKOUT_JWT = "eyJhbGciOiJFUzI1NiJ9.e30.signature";

/** 无密钥完整性校验的期望哈希（官方：base64url(sha-256(checkout_jwt))）——
 *  与实现同算式独立计算（测试侧自证，不复制实现内部函数）。 */
async function expectedCheckoutHash(jwt: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeFace(descriptor: PayswapProtocolAdapterDescriptor = AP2_DESCRIPTOR) {
  return createPayswapAp2MessageFace(descriptor);
}

async function closedCheckoutMandate(overrides: {
  checkout_hash?: string;
  _sd_alg?: string;
} = {}) {
  const checkout_hash =
    overrides.checkout_hash ?? (await expectedCheckoutHash(CHECKOUT_JWT));
  return {
    vct: "mandate.checkout.1",
    checkout_jwt: CHECKOUT_JWT,
    checkout_hash,
    iat: 1763640000,
    ...(overrides._sd_alg !== undefined ? { _sd_alg: overrides._sd_alg } : {}),
    iss: "agent-provider-1",
    aud: "merchant",
  };
}

const OPEN_CONSTRAINTS = [
  { type: "checkout.allowed_merchants", allowed: [{ id: "merchant-1" }] },
  {
    type: "checkout.line_items",
    items: [{ id: "sku-1", acceptable_items: ["sku-1a"], quantity: 1 }],
  },
];

const OPEN_CHECKOUT_MANDATE = {
  vct: "mandate.checkout.open.1",
  cnf: {
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
      y: "4Etl6SRW2YiLUrN5gofvRgHJbtNf91cZ4PthhGmJt5g",
    },
  },
  constraints: OPEN_CONSTRAINTS,
};

/** 官方 closed Payment Mandate fixture（payment_mandate.md 示例逐字段 ——
 *  Session B F2-repro A）。 */
const OFFICIAL_CLOSED_PAYMENT_MANDATE = {
  vct: "mandate.payment.1",
  transaction_id: "NivWhuqfzcvZNapvIEJ2-3tsdQLkiuIcye2g46WVgX8",
  payee: { id: "merchant_1", name: "Demo Merchant", website: "https://demo-merchant.example" },
  payment_amount: { amount: 19900, currency: "USD" },
  payment_instrument: { id: "stub", type: "card", description: "Card 4242" },
};

describe("AP2 message face — registration gate (law 4, assembly-time fail-loud)", () => {
  it("creates with a registry-consistent descriptor", () => {
    const face = makeFace();
    expect(face.descriptor.protocolId).toBe("ap2");
    expect(face.descriptor.versionPin).toBe("v0.2");
  });

  it("version drift refuses at assembly time (protocol_version_unsupported)", () => {
    expect(() => makeFace({ ...AP2_DESCRIPTOR, versionPin: "v0.3" })).toThrow(
      /protocol_version_unsupported/,
    );
  });

  it("fact-source drift refuses with its OWN code (protocol_facts_drift — F14: fact drift ≠ version unsupported)", () => {
    expect(() => makeFace({ ...AP2_DESCRIPTOR, factsRetrievedAt: "2026-11-20" })).toThrow(
      /protocol_facts_drift/,
    );
    expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain("protocol_facts_drift");
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

describe("AP2 message face — translateInbound mandate (vct exact-match + keyless integrity + closures)", () => {
  it("closed checkout mandate (official example shape) → validated-untrusted-proposal (digest only)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate(),
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
    if (outcome.kind !== "validated-untrusted-proposal") return;
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
      payload: { ...(await closedCheckoutMandate()), vct: "mandate.checkout.2" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(PAYSWAP_PROTOCOL_REFUSAL_CODES).toContain(outcome.refusal.code);
  });

  it("suffix-less vct refuses (the version suffix is part of the exact match)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...(await closedCheckoutMandate()), vct: "mandate.checkout" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("keyless integrity: wrong checkout_hash refuses (F9 — sha-256(checkout_jwt) mismatch needs no keys)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate({
        checkout_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("checkout_hash");
  });

  it("unsupported _sd_alg refuses (the face implements only sha-256 — no forged verification)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate({ _sd_alg: "sha-512" }),
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("non-base64url checkout_hash refuses (F13 — cheap structural charset check)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate({ checkout_hash: "### not base64url ###" }),
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("missing checkout_jwt refuses (pinned required field)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { vct: "mandate.checkout.1", checkout_hash: await expectedCheckoutHash("x") },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("unknown non-machinery field refuses (content closure — SD-JWT machinery claims remain lawful)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...(await closedCheckoutMandate()), grand_total_usd: "1.00" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("open checkout mandate WITHOUT cnf refuses (official REQUIRED while open — F3)", async () => {
    const { cnf: _cnf, ...withoutCnf } = OPEN_CHECKOUT_MANDATE;
    void _cnf;
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: withoutCnf,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("open checkout mandate with MALFORMED cnf refuses (cnf.jwk structure pinned)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { ...OPEN_CHECKOUT_MANDATE, cnf: { not_jwk: true } },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("open checkout mandate with cnf + official constraints ARRAY passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: OPEN_CHECKOUT_MANDATE,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("constraints as an OBJECT MAP (the superseded format) refuses (F1)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: {
          allowed_merchants: { type: "checkout.allowed_merchants", allowed: [{ id: "m1" }] },
        },
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("unknown constraint discriminator refuses WITH its name (Any unknown Constraints MUST fail — F4)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: [{ type: "checkout.currency_whitelist", allowed: ["GHS"] }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("currency_whitelist");
  });

  it("wrong discriminator literal refuses (exact official strings — F4)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: [{ type: "allowed_merchants", allowed: [{ id: "m1" }] }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("constraint missing required payload fields refuses (allowed without its array)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: [{ type: "checkout.allowed_merchants" }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("empty items array refuses (official minimum cardinality — F6)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: [{ type: "checkout.line_items", items: [] }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("empty allowed array refuses (official: empty revealed allowed = invalid constraint — F6)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.checkout.open.1",
        cnf: OPEN_CHECKOUT_MANDATE.cnf,
        constraints: [{ type: "checkout.allowed_merchants", allowed: [] }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("zero and negative quantities refuse (positive-integer constraint — F6)", async () => {
    const face = makeFace();
    for (const quantity of [0, -1]) {
      const outcome = await face.translateInbound({
        ap2Kind: "mandate",
        payload: {
          vct: "mandate.checkout.open.1",
          cnf: OPEN_CHECKOUT_MANDATE.cnf,
          constraints: [
            { type: "checkout.line_items", items: [{ id: "sku-1", acceptable_items: ["sku-1a"], quantity }] },
          ],
        },
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    }
  });

  it("official closed Payment Mandate passes (F2-repro A — transaction_id REQUIRED, payee/payment_amount/payment_instrument objects)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: OFFICIAL_CLOSED_PAYMENT_MANDATE,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("invented payment-mandate shape refuses (F2-repro B — constraint sub-fields are not top-level claims)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: { vct: "mandate.payment.1", frequency: "MONTHLY", max: 12 },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("payment mandate missing REQUIRED transaction_id refuses (F2 — official required claim)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.payment.1",
        payee: { id: "merchant_1" },
        payment_amount: { amount: 19900, currency: "USD" },
        payment_instrument: { id: "stub", type: "card" },
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("open payment mandate (constraints + cnf) passes; cnf-less open payment mandate refuses (F2-repro C + F3)", async () => {
    const face = makeFace();
    const openOk = await face.translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.payment.open.1",
        transaction_id: "NivWhuqfzcvZNapvIEJ2-3tsdQLkiuIcye2g46WVgX8",
        payee: { id: "merchant_1" },
        payment_amount: { amount: 19900, currency: "USD" },
        payment_instrument: { id: "stub", type: "card" },
        constraints: [{ type: "payment.amount_range", min: 100, max: 500 }],
        cnf: { jwk: { kty: "EC" } },
        iat: 1763640000,
        exp: 1763726400,
      },
    });
    expect(openOk.kind).toBe("validated-untrusted-proposal");
    const { cnf: _cnf, ...withoutCnf } = {
      vct: "mandate.payment.open.1",
      transaction_id: "NivWhuqfzcvZNapvIEJ2-3tsdQLkiuIcye2g46WVgX8",
      payee: { id: "merchant_1" },
      payment_amount: { amount: 19900, currency: "USD" },
      payment_instrument: { id: "stub", type: "card" },
      cnf: { jwk: { kty: "EC" } },
    };
    void _cnf;
    const cnfLess = await face.translateInbound({ ap2Kind: "mandate", payload: withoutCnf });
    expect(cnfLess.kind).toBe("refused");
    if (cnfLess.kind !== "refused") return;
    expect(cnfLess.refusal.message).toContain("cnf");
  });

  it("payment mandate with a checkout-prefixed constraint discriminator refuses (rail separation)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate",
      payload: {
        vct: "mandate.payment.open.1",
        transaction_id: "NivWhuqfzcvZNapvIEJ2-3tsdQLkiuIcye2g46WVgX8",
        cnf: { jwk: { kty: "EC" } },
        constraints: [{ type: "checkout.line_items", items: [] }],
      },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
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
    expect(outcome.kind).toBe("validated-untrusted-proposal");
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

  it("non-object delegate_payload elements refuse (official: JSON Objects — F12)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "delegation",
      payload: { ...DELEGATION, delegate_payload: [42] },
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

describe("AP2 message face — Checkout Receipt (status semantics, ap2Kind checkout-receipt)", () => {
  const SUCCESS_RECEIPT = {
    status: "Success",
    iss: "merchant-1",
    iat: 1763640000,
    reference: "hashRef",
    order_id: "order-77",
  };

  it("Success receipt with order_id passes (order_id iff Success — F11 both directions)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: SUCCESS_RECEIPT,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("Success receipt WITHOUT order_id refuses (if-and-only-if enforced both ways — F11)", async () => {
    const { order_id: _order, ...withoutOrder } = SUCCESS_RECEIPT;
    void _order;
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: withoutOrder,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
    expect(outcome.refusal.message).toContain("order_id");
  });

  it("Error receipt without error refuses (only when Error)", async () => {
    const { order_id: _order, ...errorReceipt } = SUCCESS_RECEIPT;
    void _order;
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: { ...errorReceipt, status: "Error" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("Error receipt with order_id refuses (order_id only when Success)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: { ...SUCCESS_RECEIPT, status: "Error", error: "invalid_mandate" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("Success receipt with error refuses (error only when Error)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: { ...SUCCESS_RECEIPT, error: "invalid_credential" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("AP2 message face — Payment Receipt (payment_id semantics, ap2Kind payment-receipt — F5)", () => {
  const SUCCESS_PAYMENT_RECEIPT = {
    status: "Success",
    iss: "mpp-1",
    payment_id: "pay-9",
    psp_confirmation_id: "psp-1",
    network_confirmation_id: "net-1",
  };

  it("official Payment Receipt (payment_id + both confirmation ids) passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "payment-receipt",
      payload: SUCCESS_PAYMENT_RECEIPT,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("missing REQUIRED payment_id refuses", async () => {
    const { payment_id: _pid, ...withoutPid } = SUCCESS_PAYMENT_RECEIPT;
    void _pid;
    const outcome = await makeFace().translateInbound({
      ap2Kind: "payment-receipt",
      payload: withoutPid,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("confirmation ids on Error refuse (only when Success)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "payment-receipt",
      payload: { ...SUCCESS_PAYMENT_RECEIPT, status: "Error" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("checkout-style order_id field under payment-receipt refuses (structure separation)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "payment-receipt",
      payload: { ...SUCCESS_PAYMENT_RECEIPT, order_id: "order-77" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });
});

describe("AP2 message face — Action Authorization Mandate Receipt (result semantics, ap2Kind mandate-receipt)", () => {
  const SUCCESS_MANDATE_RECEIPT = { result: "success", iss: "verifier-1", reference: "sdHashRef" };

  it("success mandate receipt passes", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate-receipt",
      payload: SUCCESS_MANDATE_RECEIPT,
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
  });

  it("error mandate receipt without error code refuses (error MUST be present when result is error)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate-receipt",
      payload: { ...SUCCESS_MANDATE_RECEIPT, result: "error" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("success mandate receipt carrying error refuses", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate-receipt",
      payload: { ...SUCCESS_MANDATE_RECEIPT, error: "invalid_credential" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("status-based payload under mandate-receipt refuses (three wire structures are distinct)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate-receipt",
      payload: { status: "Success", iss: "merchant-1", iat: 1763640000, reference: "hashRef" },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("result-based payload under checkout-receipt refuses (structure separation holds both ways)", async () => {
    const outcome = await makeFace().translateInbound({
      ap2Kind: "checkout-receipt",
      payload: SUCCESS_MANDATE_RECEIPT,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("protocol_message_unverifiable");
  });

  it("error code outside the pinned four is unclassified (the face does not invent codes)", async () => {
    expect(payswapAp2ActionAuthorizationErrorKind("invented_error_code")).toBe(null);
    const outcome = await makeFace().translateInbound({
      ap2Kind: "mandate-receipt",
      payload: { ...SUCCESS_MANDATE_RECEIPT, result: "error", error: "invented_error_code" },
    });
    expect(outcome.kind).toBe("validated-untrusted-proposal");
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

  it("checkout constraint discriminator closure is exactly the two pinned constraints", () => {
    expect([...PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES]).toEqual([
      "checkout.allowed_merchants",
      "checkout.line_items",
    ]);
  });
});

describe("AP2 message face — digest binding + receipt evidence gate (laws 2/3)", () => {
  it("same payload → same digest; different payload → different digest", async () => {
    const face = makeFace();
    const a = await face.translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate({ _sd_alg: "sha-256" }),
    });
    const b = await face.translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate({ _sd_alg: "sha-256" }),
    });
    const c = await face.translateInbound({
      ap2Kind: "mandate",
      payload: await closedCheckoutMandate(),
    });
    if (a.kind !== "validated-untrusted-proposal" || b.kind !== "validated-untrusted-proposal" || c.kind !== "validated-untrusted-proposal") {
      throw new Error("expected validated-untrusted-proposal");
    }
    expect(a.untrustedPayloadDigest).toBe(b.untrustedPayloadDigest);
    expect(a.untrustedPayloadDigest).not.toBe(c.untrustedPayloadDigest);
  });

  it("digest is stable across JSON key ordering (canonical JSON, RFC 8785)", async () => {
    const face = makeFace();
    const mandate = await closedCheckoutMandate();
    const a = await face.translateInbound({ ap2Kind: "mandate", payload: mandate });
    // 重排 fixture 只含 mandate 的已定义键（显式 undefined 属性会被 canonicalizer
    // 拒绝 —— RFC 8785 丢弃 undefined，本实现按纪律抛错）。
    const reordered = {
      iss: mandate.iss,
      checkout_hash: mandate.checkout_hash,
      iat: mandate.iat,
      aud: mandate.aud,
      vct: mandate.vct,
      checkout_jwt: mandate.checkout_jwt,
    };
    const b = await face.translateInbound({ ap2Kind: "mandate", payload: reordered });
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

  it("malformed evidence objects refuse (fabricated/malformed/missing digest shapes)", async () => {
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

  it("canonical JSON serialization is deterministic for the mandate payload", () => {
    const a = canonicalJsonStringify(OFFICIAL_CLOSED_PAYMENT_MANDATE);
    const b = canonicalJsonStringify({ ...OFFICIAL_CLOSED_PAYMENT_MANDATE });
    expect(a).toBe(b);
    // 无缩进/空白（字符串值内的空格合法 —— "Demo Merchant"）。
    expect(a.startsWith("{")).toBe(true);
  });
});
