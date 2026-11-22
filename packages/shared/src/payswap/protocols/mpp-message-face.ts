/**
 * PaySwap P3 —— MPP 消息面实现（协议适配器消息 schema / 验证门；envelope 级 +
 * 三个 pinned method rails）。
 *
 * 实现许可（protocol-contract.ts 法则 5）：MPP 的核心 draft（draft-httpauth-
 * payment-01）与三个 method rails（stripe-charge / evm-session+charge /
 * tempo-subscription）的字段级细节已入 pin（检索 2026-11-21/22），envelope 级
 * 验证按**已验证事实**落地。
 *
 * 实现范围（诚实边界）：
 * - **envelope 级**：challenge（WWW-Authenticate: Payment）/ credential
 *   （Authorization: Payment）/ receipt（Payment-Receipt）三结构的字段验证 +
 *   intent 闭集（charge/session/subscription）+ method 闭集（stripe/evm/tempo
 *   —— pinned rails）。未 pin 的 method（hedera/lightning/solana/xrpl/...）
 *   → typed 拒绝（不可用，不是模拟 —— 其 per-network credential 内部 schema
 *   未检索，不支持即为不支持）。
 * - **不验签**：MPP credential 的密码学验证需要密钥材料（未在案）—— 本面验证
 *   结构，产物永远标注 untrusted（`validated-untrusted-proposal`）。
 * - **receipt 只读验证**：进站 receipt 按 pinned 字段验证；出站收据走
 *   emitReceipt 的宿主证据门（与 AP2 同款）。
 *
 * 法则（protocol-contract.ts，normative）1-5 同 AP2 面。
 */

import { z } from "zod";
import { canonicalJsonStringify } from "../canonical-json.js";
import {
  type PayswapProtocolAdapter,
  type PayswapProtocolAdapterDescriptor,
  type PayswapProtocolInboundOutcome,
  type PayswapProtocolReceiptOutcome,
  type PayswapProtocolRefusal,
  evaluatePayswapProtocolAdapterRegistration,
} from "./protocol-contract.js";

// ---------------------------------------------------------------------------
// pinned 词汇（逐字照录）
// ---------------------------------------------------------------------------

/** MPP intent 闭集（mpp.dev 官方站 pin：Charge 一次性 / Session 按量计费 /
 *  Subscription 周期固定）。 */
export const PAYSWAP_MPP_INTENT_VALUES = ["charge", "session", "subscription"] as const;

export type PayswapMppIntent = (typeof PAYSWAP_MPP_INTENT_VALUES)[number];

/** MPP method 闭集（pinned rails —— 未 pin 的 per-network method 拒绝：
 *  不可用，不是模拟）。 */
export const PAYSWAP_MPP_METHOD_VALUES = ["stripe", "evm", "tempo"] as const;

export type PayswapMppMethod = (typeof PAYSWAP_MPP_METHOD_VALUES)[number];

// ---------------------------------------------------------------------------
// zod schema（envelope 级 —— challenge / credential / receipt 三结构）
// ---------------------------------------------------------------------------

/** Challenge（WWW-Authenticate: Payment 的结构化形态 —— pin 逐字：id/realm/
 *  method/intent/request REQUIRED；expires 可选）。 */
const challengeSchema = z
  .object({
    id: z.string().min(1),
    realm: z.string().min(1),
    method: z.enum(["stripe", "evm", "tempo"]),
    intent: z.enum(["charge", "session", "subscription"]),
    request: z.string().min(1),
    expires: z.string().optional(),
  })
  .strict();

/** Credential（Authorization: Payment <base64url> 的结构化形态 —— pin 逐字：
 *  challenge 回显 REQUIRED + payload REQUIRED）。 */
const credentialSchema = z
  .object({
    challenge: challengeSchema,
    /** 方法特定数据 REQUIRED —— 空对象与该字段的存在语义矛盾（superRefine 强制非空）。 */
    payload: z.record(z.string(), z.unknown()),
    source: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value.payload).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "payload REQUIRED —— 空对象与 Method-specific data 的存在语义矛盾",
      });
    }
  });

/** Receipt（pin 逐字：method/status/timestamp/reference REQUIRED；externalId
 *  可选回显）。status 官方示例 = "success"（失败路径 = 402 + 新 challenge，
 *  不产 receipt）。 */
const receiptSchema = z
  .object({
    method: z.enum(["stripe", "evm", "tempo"]),
    reference: z.string().min(1),
    status: z.literal("success"),
    timestamp: z.string().min(1),
    externalId: z.string().optional(),
  })
  .strict();

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。 */
const inboundEnvelopeSchema = z
  .object({
    mppKind: z.enum(["challenge", "credential", "receipt"]),
    payload: z.unknown(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 摘要（canonical JSON → SHA-256 → base64url —— 证据链绑定面）
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function payloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalJsonStringify(payload);
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64UrlEncode(new Uint8Array(digestBytes));
}

// ---------------------------------------------------------------------------
// 适配器工厂（注册门 + translateInbound + emitReceipt）
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

/**
 * 创建 MPP 消息面适配器（PayswapProtocolAdapter 的 MPP 实现）。描述符与注册表
 * 不一致 = 装配期 throw（法则 4 fail-loud）。
 */
export function createPayswapMppMessageFace(
  descriptor: PayswapProtocolAdapterDescriptor,
): PayswapProtocolAdapter {
  const registration = evaluatePayswapProtocolAdapterRegistration(descriptor);
  if (registration.kind === "refused") {
    throw new Error(
      `MPP 消息面装配被拒（${registration.refusal.code}）：${registration.refusal.message}`,
    );
  }

  return {
    descriptor,

    async translateInbound(untrustedMessage: unknown): Promise<PayswapProtocolInboundOutcome> {
      const envelope = inboundEnvelopeSchema.safeParse(untrustedMessage);
      if (!envelope.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `进站消息形态未知（mppKind 路由标签缺失/未知）—— fail-closed：${envelope.error.issues[0]?.message ?? "schema error"}`,
          ),
        };
      }
      const { mppKind, payload } = envelope.data;
      const schema =
        mppKind === "challenge"
          ? challengeSchema
          : mppKind === "credential"
            ? credentialSchema
            : receiptSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `MPP ${mppKind} 消息未通过 pinned schema（字段越集 / 缺失必填 / 未知形态 —— fail-closed）：${
              parsed.error.issues[0]?.message ?? "schema error"
            }`,
          ),
        };
      }
      // 法则 2：产物 = 结构验证通过的不可信提案（载荷摘要进证据链；typed intent
      // 随 P4）。术语纪律：validated ≠ cryptographically verified —— MPP
      // credential 的签名验证前置条件未在案，本面绝不模拟。
      return {
        kind: "validated-untrusted-proposal",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        untrustedPayloadDigest: await payloadDigest(parsed.data),
      };
    },

    async emitReceipt(evidence): Promise<PayswapProtocolReceiptOutcome> {
      // 法则 3：收据只从宿主签发的已验证结算证据发出 —— 协议 accepted ≠ 结算，
      // 适配器永不安言铸造结算事实。运行时强制：证据对象结构验证 + 状态门。
      if (evidence === null) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_receipt_unavailable",
            "收据面被要求但宿主结算证据缺席 —— 协议 accepted ≠ 结算（typed 拒绝）",
          ),
        };
      }
      const evidenceShape = z
        .object({
          evidenceRef: z.string().min(1),
          evidenceDigest: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
          state: z.enum(["settled-verified", "indeterminate", "pending", "failed"]),
          capturedAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .safeParse(evidence);
      if (!evidenceShape.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_receipt_unavailable",
            `宿主结算证据形态非法（畸形引用/摘要/时间戳）—— 不伪造结算事实：${
              evidenceShape.error.issues[0]?.message ?? "schema error"
            }`,
          ),
        };
      }
      if (evidenceShape.data.state !== "settled-verified") {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_receipt_unavailable",
            `结算证据状态为 '${evidenceShape.data.state}' —— 不可判定结局不得产生成功收据（协议 accepted ≠ 结算）`,
          ),
        };
      }
      return {
        kind: "receipt-emitted",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        settlementEvidenceRef: evidenceShape.data.evidenceRef,
      };
    },
  };
}
