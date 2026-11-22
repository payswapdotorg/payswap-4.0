/**
 * PaySwap P3 —— x402 消息面实现（supported subset —— 五个 spec-silent 行的
 * 处分结论：结构验证可行，执行语义显式不支持）。
 *
 * 五处分行（docs/payswap/p3/x402-disposition-2026-11-22.md）：
 * 1. EVM validAfter/validBefore ↔ maxTimeoutSeconds 联动 —— 本面做结构校验
 *    （validAfter < validBefore），不声称链上执行语义；
 * 2. 跨 scheme 重放 —— 本面校验 nonce 在案，不声称跨 scheme 重放安全；
 * 3. enforcement actor —— 本面不做 enforcement（不是 facilitator/执行者）；
 * 4. maxTimeoutSeconds bounds —— 本面校验正整数，不声称 bounds 语义；
 * 5. stale-402 —— 宿主边界。
 *
 * 诚实边界：不验签（x402 credential 签名验证需要签发者密钥材料，未在案）；
 * 不执行链上交易；不持有资金；不充当 facilitator。
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

/** x402 v2 协议版本（pin 逐字）。 */
const X402_VERSION = 2;

const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const caip2Regex = /^[a-z0-9-]+:[a-zA-Z0-9_-]+$/;

/** PaymentRequired schema（pinned wire schema，第四批检索逐字）。 */
const paymentRequiredSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    error: z.string().optional(),
    resource: z
      .object({
        url: z.string().min(1),
        description: z.string().optional(),
        mimeType: z.string().optional(),
        serviceName: z.string().max(32).optional(),
        tags: z.array(z.string().max(32)).max(5).optional(),
        iconUrl: z.string().max(2048).optional(),
      })
      .strict(),
    accepts: z
      .array(
        z
          .object({
            scheme: z.string().min(1),
            network: z.string().regex(/^[a-z0-9-]+:[a-zA-Z0-9_-]+$/),
            amount: z.string().regex(/^[1-9]\d*$/),
            asset: z.string().min(1),
            payTo: z.string().min(1),
            maxTimeoutSeconds: z.number().int().positive(),
            extra: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** PaymentPayload schema（exact-EVM 结构）。 */
const paymentPayloadSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    resource: z
      .object({
        url: z.string().min(1),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .strict()
      .optional(),
    accepted: z
      .object({
        scheme: z.string().min(1),
        network: z.string().min(1),
        amount: z.string().min(1),
        asset: z.string().min(1),
        payTo: z.string().min(1),
        maxTimeoutSeconds: z.number().int().positive(),
        extra: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    payload: z.unknown(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 结构性窗口校验（Row 1 处分：本面做 validAfter < validBefore 结构校验，
    // 不声称链上窗口执行语义）。
    const exactPayload = value.payload as {
      signature?: unknown;
      authorization?: { validAfter?: unknown; validBefore?: unknown } | null;
    };
    if (
      exactPayload?.authorization &&
      typeof exactPayload.authorization === "object" &&
      exactPayload.authorization !== null
    ) {
      const auth = exactPayload.authorization as Record<string, unknown>;
      const after = Number(auth.validAfter);
      const before = Number(auth.validBefore);
      if (!Number.isNaN(after) && !Number.isNaN(before) && after >= before) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "authorization"],
          message: "validAfter MUST be earlier than validBefore（结构性窗口校验）",
        });
      }
      // Row 2 处分：nonce 在案校验（不声称跨 scheme 重放安全，但缺失即拒）。
      if (typeof auth.nonce !== "string" || auth.nonce.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "authorization", "nonce"],
          message: "nonce MUST 在案（32-byte random nonce to prevent replay attacks）",
        });
      }
    }
  });

/** SettlementResponse schema（pinned wire schema）。 */
const settlementResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string().min(1),
    amount: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 官方：transaction "MUST be non-empty when errorReason is settlement_pending"
    // （Row 5 处分：stale-402 宿主边界，此处只验结构规则）。
    if (value.errorReason === "settlement_pending" && value.transaction.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transaction"],
        message: "transaction MUST be non-empty when errorReason is settlement_pending",
      });
    }
  });

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。 */
const inboundEnvelopeSchema = z
  .object({
    x402Kind: z.enum(["payment-required", "payment-payload", "settlement-response"]),
    payload: z.unknown(),
  })
  .strict();

async function payloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalJsonStringify(payload);
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digestBytes)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// 适配器工厂
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

export function createPayswapX402MessageFace(
  descriptor: PayswapProtocolAdapterDescriptor,
): PayswapProtocolAdapter {
  const registration = evaluatePayswapProtocolAdapterRegistration(descriptor);
  if (registration.kind === "refused") {
    throw new Error(
      `x402 消息面装配被拒（${registration.refusal.code}）：${registration.refusal.message}`,
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
            `进站消息形态未知（x402Kind 路由标签缺失/未知）—— fail-closed：${envelope.error.issues[0]?.message ?? "schema error"}`,
          ),
        };
      }
      const { x402Kind, payload } = envelope.data;
      const schema =
        x402Kind === "payment-required"
          ? paymentRequiredSchema
          : x402Kind === "payment-payload"
            ? paymentPayloadSchema
            : settlementResponseSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `x402 ${x402Kind} 消息未通过 pinned schema（未知字段 / 窗口结构违规 / 形态违规 —— fail-closed）：${
              parsed.error.issues[0]?.message ?? "schema error"
            }`,
          ),
        };
      }
      return {
        kind: "validated-untrusted-proposal",
        protocolId: descriptor.protocolId,
        versionPin: descriptor.versionPin,
        untrustedPayloadDigest: await payloadDigest(parsed.data),
      };
    },

    async emitReceipt(evidence): Promise<PayswapProtocolReceiptOutcome> {
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
            `宿主结算证据形态非法 —— 不伪造结算事实：${
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
            `结算证据状态为 '${evidenceShape.data.state}' —— 不可判定结局不得产生成功收据`,
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
