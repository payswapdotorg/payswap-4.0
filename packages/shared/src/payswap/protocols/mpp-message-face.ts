/**
 * PaySwap P3 —— MPP 消息面实现（五个 pinned method/intent 组合的完整消息
 * schema / 验证门；handoff v3 优先级 1-4 + 2026-11-22 评审修正）。
 *
 * 2026-11-22 评审修正（TL1 review——MPP Conformance Completion）：
 * - Tempo subscription：currency = TIP-20 token address（非 ISO 4217 —— 评审
 *   修正项 A）；recipient = 0x 地址；subscriptionExpires = RFC 3339 且 MUST
 *   严格晚于 challenge expires 且 MUST NOT 复制 challenge expiry（TIP-20
 *   profile 规则）；accessKeyAddress = 0x 地址；
 * - EVM charge：permit2Address REQUIRED（官方表）；Permit2 credential 增加
 *   transferDetails + witness（REQUIRED）；splits 逐项 {recipient, amount}
 *   校验 + sum(splits) < amount + splits 仅 permit2 承兑可用；
 * - EVM session：action 特定的 credential schema（open 的 type/hash/salt、
 *   非 open 的 type 禁用）；receipt 的 reference = channelId 等式强制；
 * - digest：RFC 9530 Structured Field 形态校验（algo=:base64:）；
 * - opaque：JCS canonical 编码验证（解码 → 解析 → 重序列化 === 原始值）；
 * - TextDecoder fatal UTF-8（无效字节序列 = 可靠拒绝，非替换）；
 * - RFC 3339 真实日历日期校验（regex + Date.parse 双重）。
 *
 * 诚实边界（不变）：不验签（MPP credential 签名验证需要密钥材料，未在案）；
 * credential-to-challenge 关联与重放/过期/单次使用的生命周期强制 = 宿主边界
 * （本面接口无法接收已签发 challenge 的可信关联上下文 —— 显式留白，不模拟）；
 * emitReceipt 的宿主证据服务 = 设计中的边界（尚无 production 调用者 —— 验收
 * 准则显式留白）。
 */

import { z } from "zod";
import { canonicalJsonStringify } from "../canonical-json.js";
import { PAYSWAP_MPP_METHOD_INTENT_MATRIX } from "./protocol-facts.js";
import {
  type PayswapProtocolAdapter,
  type PayswapProtocolAdapterDescriptor,
  type PayswapProtocolInboundOutcome,
  type PayswapProtocolReceiptOutcome,
  type PayswapProtocolRefusal,
  evaluatePayswapProtocolAdapterRegistration,
} from "./protocol-contract.js";

// ---------------------------------------------------------------------------
// pinned 词汇
// ---------------------------------------------------------------------------

export const PAYSWAP_MPP_INTENT_VALUES = ["charge", "session", "subscription"] as const;
export const PAYSWAP_MPP_METHOD_VALUES = ["stripe", "evm", "tempo"] as const;

// ---------------------------------------------------------------------------
// 共享校验原语
// ---------------------------------------------------------------------------

const base64UrlNopadRegex = /^[A-Za-z0-9_-]+$/;
const positiveIntStringRegex = /^[1-9]\d*$/;
const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const evmTxHashRegex = /^0x[0-9a-fA-F]{64}$/;
const rfc3339Regex = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const isoCurrencyRegex = /^[a-z]{3}$/;
/** RFC 9530 content-digest 形态：algo=:base64:（Structured Field Dictionary）。 */
const rfc9530DigestRegex = /^[a-z0-9-]+=:([A-Za-z0-9+/=]+):$/;

/** RFC 3339 真实日历日期校验（regex 检查形态 + Date 校验日历有效性）。 */
function isValidRfc3339Date(value: string): boolean {
  if (!rfc3339Regex.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

/** fatal UTF-8 解码 —— 无效字节序列可靠拒绝（非替换）。 */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function base64UrlDecode(request: string): { ok: true; decoded: string } | { ok: false; reason: string } {
  try {
    const base64 = request.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    // fatal: true —— 无效 UTF-8 字节序列抛出（非替换）
    return { ok: true, decoded: fatalUtf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))) };
  } catch {
    return { ok: false, reason: "request base64url 解码失败（含无效 UTF-8 字节序列）" };
  }
}

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
// 五个 method/intent 的 request schema（解码后的 JSON 对象 —— 逐字段 pin）
// ---------------------------------------------------------------------------

const stripeChargeRequestSchema = z
  .object({
    amount: z.string().regex(positiveIntStringRegex),
    currency: z.string().regex(isoCurrencyRegex),
    description: z.string().optional(),
    externalId: z.string().optional(),
    recipient: z.string().optional(),
    methodDetails: z
      .object({
        networkId: z.string().min(1),
        paymentMethodTypes: z.array(z.string().min(1)).min(1),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const stripeSubscriptionRequestSchema = z
  .object({
    amount: z.string().regex(positiveIntStringRegex),
    currency: z.string().regex(isoCurrencyRegex),
    periodUnit: z.enum(["day", "week", "month"]),
    periodCount: z.string().regex(positiveIntStringRegex),
    description: z.string().optional(),
    externalId: z.string().optional(),
    methodDetails: z
      .object({
        networkId: z.string().min(1),
        paymentMethodTypes: z.array(z.string().min(1)).min(1),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value as { recipient?: unknown }).recipient !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipient"], message: "recipient MUST NOT 在案（stripe subscription profile）" });
    }
    if ((value as { subscriptionExpires?: unknown }).subscriptionExpires !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriptionExpires"], message: "subscriptionExpires MUST NOT 在案（stripe subscription profile）" });
    }
  });

const evmChargeRequestSchema = z
  .object({
    amount: z.string().regex(positiveIntStringRegex),
    currency: z.string().regex(evmAddressRegex),
    recipient: z.string().regex(evmAddressRegex),
    description: z.string().optional(),
    externalId: z.string().optional(),
    methodDetails: z
      .object({
        chainId: z.number().int().positive(),
        permit2Address: z.string().regex(evmAddressRegex),
        credentialTypes: z.array(z.enum(["permit2", "authorization", "transaction", "hash"])).optional(),
        decimals: z.number().int().optional(),
        splits: z
          .array(
            z
              .object({
                recipient: z.string().regex(evmAddressRegex),
                amount: z.string().regex(positiveIntStringRegex),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // splits 约束（官方：sum(splits[].amount) MUST 严格小于 amount；
    // splits 仅 permit2 承兑可用）。
    const splits = value.methodDetails.splits;
    if (splits !== undefined) {
      const sum = splits.reduce((acc, s) => acc + BigInt((s as { amount: string }).amount), BigInt(0));
      if (sum >= BigInt(value.amount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["methodDetails", "splits"],
          message: "sum(splits[].amount) MUST 严格小于 amount",
        });
      }
      const hasPermit2 = (value.methodDetails as { credentialTypes?: string[] }).credentialTypes?.includes("permit2") ?? false;
      if (!hasPermit2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["methodDetails", "splits"],
          message: "splits 仅 permit2 承兑可用（官方：transaction/authorization/hash 类型 MUST NOT 用于 splits）",
        });
      }
    }
  });

const evmSessionRequestSchema = z
  .object({
    /** 每单位价格（非总价）—— session 与 charge 的语义分界。 */
    amount: z.string().regex(positiveIntStringRegex),
    unitType: z.string().min(1).optional(),
    suggestedDeposit: z.string().optional(),
    currency: z.string().regex(evmAddressRegex),
    recipient: z.string().regex(evmAddressRegex),
    description: z.string().optional(),
    externalId: z.string().optional(),
    methodDetails: z
      .object({
        chainId: z.number().int().positive(),
        escrowContract: z.string().regex(evmAddressRegex),
        channelId: z.string().min(1).optional(),
        minVoucherDelta: z.string().optional(),
        feePayer: z.boolean().optional(),
        credentialTypes: z.array(z.enum(["permit2", "authorization", "hash"])).optional(),
      })
      .strict(),
  })
  .strict();

const tempoSubscriptionRequestSchema = z
  .object({
    amount: z.string().regex(positiveIntStringRegex),
    /** TIP-20 token address（评审修正项 A —— 非 ISO 4217）。 */
    currency: z.string().regex(evmAddressRegex),
    periodUnit: z.enum(["day", "week"]),
    periodCount: z.string().regex(positiveIntStringRegex),
    subscriptionExpires: z.string().regex(rfc3339Regex),
    recipient: z.string().regex(evmAddressRegex),
    description: z.string().optional(),
    externalId: z.string().optional(),
    methodDetails: z
      .object({
        accessKey: z
          .object({
            accessKeyAddress: z.string().regex(evmAddressRegex),
            keyType: z.enum(["p256", "secp256k1", "webAuthn"]),
          })
          .strict(),
        chainId: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();

function requestSchemaFor(method: string, intent: string): z.ZodTypeAny | null {
  if (method === "stripe" && intent === "charge") return stripeChargeRequestSchema;
  if (method === "stripe" && intent === "subscription") return stripeSubscriptionRequestSchema;
  if (method === "evm" && intent === "charge") return evmChargeRequestSchema;
  if (method === "evm" && intent === "session") return evmSessionRequestSchema;
  if (method === "tempo" && intent === "subscription") return tempoSubscriptionRequestSchema;
  return null;
}

// ---------------------------------------------------------------------------
// 五个 method/intent 的 credential payload schema
// ---------------------------------------------------------------------------

const stripeChargeCredentialSchema = z
  .object({
    spt: z.string().regex(/^spt_[A-Za-z0-9]+$/),
    externalId: z.string().optional(),
  })
  .strict();

const stripeSubscriptionCredentialSchema = z
  .object({
    paymentMethod: z.string().min(1),
    customer: z.string().min(1).optional(),
  })
  .strict();

const evmPermit2PayloadSchema = z
  .object({
    type: z.literal("permit2"),
    permit: z
      .object({
        permitted: z.array(z.object({ token: z.string().min(1), amount: z.string().min(1) }).strict()).min(1),
        nonce: z.string().min(1),
        deadline: z.string().min(1),
      })
      .strict(),
    /** 官方 REQUIRED：transferDetails 数组（{to, requestedAmount}）。 */
    transferDetails: z
      .array(
        z
          .object({
            to: z.string().regex(evmAddressRegex),
            requestedAmount: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    /** 官方 REQUIRED：witness（challenge 绑定）。 */
    witness: z
      .object({
        challengeHash: z.string().min(1),
      })
      .strict(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

const evmAuthorizationPayloadSchema = z
  .object({
    type: z.literal("authorization"),
    from: z.string().regex(evmAddressRegex),
    to: z.string().regex(evmAddressRegex),
    value: z.string().min(1),
    validAfter: z.string().min(1),
    validBefore: z.string().min(1),
    nonce: z.string().min(1),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

const evmTransactionPayloadSchema = z
  .object({
    type: z.literal("transaction"),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

const evmHashPayloadSchema = z
  .object({
    type: z.literal("hash"),
    hash: z.string().regex(evmTxHashRegex),
  })
  .strict();

const evmChargeCredentialSchema = z.union([
  evmPermit2PayloadSchema,
  evmAuthorizationPayloadSchema,
  evmTransactionPayloadSchema,
  evmHashPayloadSchema,
]);

/** EVM session credential —— action 特定 schema（评审修正项 C：open 的
 *  type/hash/salt REQUIRED；非 open 禁用 type）。 */
const evmSessionCredentialSchema = z
  .object({
    action: z.enum(["open", "topUp", "voucher", "close"]),
    channelId: z.string().min(1),
    cumulativeAmount: z.string().min(1),
    signature: z.string().min(1),
    type: z.enum(["hash", "authorization", "permit2"]).optional(),
    hash: z.string().min(1).optional(),
    salt: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "open") {
      if (value.type === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["type"],
          message: "open credential requires type discriminator (hash/authorization/permit2)",
        });
      }
      if (value.type === "hash" && value.hash === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hash"],
          message: "open-hash credential requires hash",
        });
      }
      if (value.type === "hash" && value.salt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["salt"],
          message: "open-hash credential requires salt",
        });
      }
    } else if (value.type !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: "type is only valid for the open action",
      });
    }
  });

const tempoSubscriptionCredentialSchema = z
  .object({
    type: z.literal("keyAuthorization"),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

function credentialSchemaFor(method: string, intent: string): z.ZodTypeAny | null {
  if (method === "stripe" && intent === "charge") return stripeChargeCredentialSchema;
  if (method === "stripe" && intent === "subscription") return stripeSubscriptionCredentialSchema;
  if (method === "evm" && intent === "charge") return evmChargeCredentialSchema;
  if (method === "evm" && intent === "session") return evmSessionCredentialSchema;
  if (method === "tempo" && intent === "subscription") return tempoSubscriptionCredentialSchema;
  return null;
}

// ---------------------------------------------------------------------------
// 五个 method/intent 的 receipt schema
// ---------------------------------------------------------------------------

const stripeChargeReceiptSchema = z
  .object({
    method: z.literal("stripe"),
    reference: z.string().min(1),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

const stripeSubscriptionReceiptSchema = z
  .object({
    method: z.literal("stripe"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

const evmChargeReceiptSchema = z
  .object({
    method: z.literal("evm"),
    challengeId: z.string().min(1).optional(),
    reference: z.string().regex(evmTxHashRegex),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败"),
    chainId: z.number().int().positive(),
    externalId: z.string().optional(),
  })
  .strict();

const evmSessionReceiptSchema = z
  .object({
    method: z.literal("evm"),
    intent: z.literal("session"),
    reference: z.string().min(1),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败"),
    challengeId: z.string().min(1),
    channelId: z.string().min(1),
    acceptedCumulative: z.string().min(1),
    spent: z.string().min(1),
    chainId: z.number().int().positive(),
    units: z.string().optional(),
    txHash: z.string().optional(),
    confirmations: z.number().int().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 官方：reference MUST equal channelId（评审修正项 C）。
    if (value.reference !== value.channelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message: "reference MUST equal channelId（官方 EVM session receipt 语义）",
      });
    }
  });

const tempoSubscriptionReceiptSchema = z
  .object({
    method: z.literal("tempo"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

function receiptSchemaFor(method: string, intent: string | null): z.ZodTypeAny | null {
  if (method === "stripe" && intent === "charge") return stripeChargeReceiptSchema;
  if (method === "stripe" && intent === "subscription") return stripeSubscriptionReceiptSchema;
  if (method === "stripe") return null;
  if (method === "evm" && intent === "session") return evmSessionReceiptSchema;
  if (method === "evm") return evmChargeReceiptSchema;
  if (method === "tempo") return tempoSubscriptionReceiptSchema;
  return null;
}

// ---------------------------------------------------------------------------
// challenge schema（含可选参数官方语义 + request 解码/JCS + matrix）
// ---------------------------------------------------------------------------

const challengeBaseSchema = z
  .object({
    id: z.string().min(1),
    realm: z.string().min(1),
    method: z.enum(["stripe", "evm", "tempo"]),
    intent: z.enum(["charge", "session", "subscription"]),
    request: z.string().regex(base64UrlNopadRegex),
    expires: z.string().refine((v) => isValidRfc3339Date(v), "RFC 3339 日历日期校验失败").optional(),
    digest: z.string().regex(rfc9530DigestRegex, "digest MUST use the RFC 9530 Structured Field format (algo=:base64:)").optional(),
    description: z.string().optional(),
    header: z.literal("Payment-Authorization").optional(),
    opaque: z.string().min(1).optional(),
  })
  // 未知参数按官方客户端规则忽略（strip —— 不拒绝，不当事实）。
  .strip();

/** opaque 的官方结构：base64url(JCS JSON) 且为扁平 string-to-string map 且
 *  JCS canonical 编码验证（解码 → 解析 → 重序列化 === 解码值）。 */
function decodeAndValidateOpaque(value: string): { ok: boolean; reason?: string } {
  if (!base64UrlNopadRegex.test(value)) {
    return { ok: false, reason: "opaque 非标准 base64url（无填充）形态" };
  }
  let decoded: string;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    decoded = fatalUtf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return { ok: false, reason: "opaque base64 解码失败（含无效 UTF-8 字节序列）" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "opaque 解码后非 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "opaque 解码后必须为 JSON 对象" };
  }
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return { ok: false, reason: "opaque 必须为扁平 string-to-string map" };
    }
  }
  // JCS canonical 编码验证。
  let canonical: string;
  try {
    canonical = canonicalJsonStringify(parsed);
  } catch {
    return { ok: false, reason: "opaque JCS 序列化失败" };
  }
  if (canonical !== decoded) {
    return { ok: false, reason: "opaque 非 JCS canonical 编码（解码值 ≠ 重序列化值）" };
  }
  return { ok: true };
}

const challengeSchema = challengeBaseSchema.superRefine((value, ctx) => {
  // 法则 4 机器面：method/intent 兼容矩阵。
  if (!PAYSWAP_MPP_METHOD_INTENT_MATRIX.some((e) => e.method === value.method && e.intent === value.intent)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["intent"],
      message: `method/intent 组合 '${value.method}+${value.intent}' 不在兼容矩阵 —— 未 pin 的 rail 面（fail-closed）`,
    });
    return;
  }
  // opaque 官方结构 + JCS canonical 校验。
  if (value.opaque !== undefined) {
    const opaque = decodeAndValidateOpaque(value.opaque);
    if (!opaque.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["opaque"], message: opaque.reason ?? "opaque 形态非法" });
    }
  }
  // request 解码（fatal UTF-8）+ JCS canonical + method-specific schema。
  const decodedRequest = base64UrlDecode(value.request);
  if (!decodedRequest.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: decodedRequest.reason });
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decodedRequest.decoded);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request 解码后非合法 JSON" });
    return;
  }
  let canonicalRequest: string;
  try {
    canonicalRequest = canonicalJsonStringify(parsedJson);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `request 的 JSON 无法 canonical 化（JCS 纪律）：${(error as Error).message}`,
    });
    return;
  }
  if (canonicalRequest !== decodedRequest.decoded) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: "request 的 JSON 非 JCS canonical 形态（官方：JSON MUST be serialized using JCS）",
    });
    return;
  }
  const schema = requestSchemaFor(value.method, value.intent);
  if (schema === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `method/intent 组合 '${value.method}+${value.intent}' 不在兼容矩阵`,
    });
    return;
  }
  const methodParsed = schema.safeParse(parsedJson);
  if (!methodParsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `request 未通过 ${value.method}/${value.intent} pinned schema：${
        methodParsed.error.issues[0]?.message ?? "schema error"
      }`,
    });
    return;
  }
  // Tempo subscription 专属：subscriptionExpires 与 challenge.expires 的
  // 跨字段校验（官方：MUST 严格晚于 + MUST NOT 复制 challenge expiry）。
  if (value.method === "tempo" && value.intent === "subscription") {
    const request = parsedJson as { subscriptionExpires?: string };
    const challengeExpires = value.expires;
    const subscriptionExpires = request.subscriptionExpires;
    if (subscriptionExpires !== undefined && challengeExpires !== undefined) {
      const sub = Date.parse(subscriptionExpires);
      const exp = Date.parse(challengeExpires);
      if (sub <= exp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["request"],
          message: "subscriptionExpires MUST 严格晚于 challenge expires（且 MUST NOT 复制该值）",
        });
      }
    }
  }
});

/** Credential（pin 逐字：challenge 回显 REQUIRED + payload REQUIRED 非空）。
 *  回显 challenge 按完整 challenge schema 校验（含解码与 method schema）——
 *  回显与原始 challenge 的关联由宿主边界强制（本面接口无法接收已签发
 *  challenge 的可信关联上下文 —— 该验收准则显式留白）。 */
const credentialSchema = z
  .object({
    challenge: challengeSchema,
    payload: z.unknown(),
    source: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const echo = challengeSchema.safeParse(value.challenge);
    if (!echo.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["challenge"],
        message: `credential 的 challenge 回显未通过校验：${echo.error.issues[0]?.message ?? "schema error"}`,
      });
      return;
    }
    const schema = credentialSchemaFor(echo.data.method, echo.data.intent);
    if (schema === null) return;
    const payloadParsed = schema.safeParse(value.payload);
    if (!payloadParsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `credential payload 未通过 ${echo.data.method}/${echo.data.intent} pinned schema：${
          payloadParsed.error.issues[0]?.message ?? "schema error"
        }`,
      });
    }
  });

// ---------------------------------------------------------------------------
// receipt 分派（method(+intent) → 五种 schema）
// ---------------------------------------------------------------------------

const receiptBaseSchema = z.object({ method: z.enum(["stripe", "evm", "tempo"]) }).passthrough();

function receiptSchemaForEnvelope(
  payload: unknown,
  envelopeIntent: string | null,
): { schema: z.ZodTypeAny; intent: string } | { error: string } {
  const base = receiptBaseSchema.safeParse(payload);
  if (!base.success) {
    return { error: `receipt 缺失/畸形 method 字段：${base.error.issues[0]?.message ?? "schema error"}` };
  }
  const method = base.data.method;
  const dispatchIntent = envelopeIntent;
  if (dispatchIntent === null) {
    return { error: "receipt 分派需要 envelope intent 上下文 —— 缺席即 fail-closed" };
  }
  if (method === "tempo") {
    if (dispatchIntent !== "subscription") {
      return { error: `tempo receipt 在 '${dispatchIntent}' intent 下不可分派（仅 subscription）` };
    }
    return { schema: tempoSubscriptionReceiptSchema, intent: "subscription" };
  }
  if (method === "evm") {
    const sessionSelf = (payload as { intent?: unknown })?.intent === "session";
    if (sessionSelf && dispatchIntent !== "session") {
      return { error: `receipt 自标识 session 但 envelope intent 为 '${dispatchIntent}' —— 置位不一致` };
    }
    if (!sessionSelf && dispatchIntent === "session") {
      return { error: `envelope intent 为 session 但 receipt 未自标识 session —— 置位不一致` };
    }
    return sessionSelf
      ? { schema: evmSessionReceiptSchema, intent: "session" }
      : { schema: evmChargeReceiptSchema, intent: "charge" };
  }
  if (method === "stripe") {
    if (dispatchIntent === "charge") return { schema: stripeChargeReceiptSchema, intent: "charge" };
    if (dispatchIntent === "subscription") return { schema: stripeSubscriptionReceiptSchema, intent: "subscription" };
    return { error: "stripe receipt 需要 intent 分派（charge|subscription）—— 缺席即 fail-closed" };
  }
  return { error: `receipt method '${method}' 不在 pinned rails` };
}

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。 */
const inboundEnvelopeSchema = z
  .object({
    mppKind: z.enum(["challenge", "credential", "receipt"]),
    intent: z.enum(["charge", "session", "subscription"]).optional(),
    payload: z.unknown(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 适配器工厂
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

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

      if (mppKind === "receipt") {
        const dispatch = receiptSchemaForEnvelope(payload, envelope.data.intent ?? null);
        if ("error" in dispatch) {
          return {
            kind: "refused",
            refusal: refusal("protocol_message_unverifiable", dispatch.error),
          };
        }
        const receiptParsed = dispatch.schema.safeParse(payload);
        if (!receiptParsed.success) {
          return {
            kind: "refused",
            refusal: refusal(
              "protocol_message_unverifiable",
              `MPP ${dispatch.intent} receipt 未通过 pinned schema：${
                receiptParsed.error.issues[0]?.message ?? "schema error"
              }`,
            ),
          };
        }
        return {
          kind: "validated-untrusted-proposal",
          protocolId: descriptor.protocolId,
          versionPin: descriptor.versionPin,
          untrustedPayloadDigest: await payloadDigest(receiptParsed.data),
        };
      }

      const schema = mppKind === "challenge" ? challengeSchema : credentialSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `MPP ${mppKind} 消息未通过 pinned schema（字段越集 / 缺失必填 / 矩阵外组合 / request 编码违规 —— fail-closed）：${
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
