/**
 * PaySwap P3 —— MPP 消息面实现（五个 pinned method/intent 组合的完整消息
 * schema / 验证门；handoff v3 优先级 1-4）。
 *
 * 实现许可（protocol-contract.ts 法则 5）：五个受支持组合（stripe-charge /
 * stripe-subscription / evm-charge / evm-session / tempo-subscription）的
 * 字段级细节已入 pin（检索 2026-11-21/22，protocol-facts.ts PAYSWAP_MPP_
 * METHOD_INTENT_MATRIX 为单一事实源）—— 本面只编码这些事实；矩阵外的
 * method/intent 组合与未检索的 per-network 变体 typed 拒绝（不可用，不是
 * 模拟）。
 *
 * 2026-11-22 handoff v3 修正（对抗评审 + 官方源逐字）：
 * - method/intent 独立枚举 → 兼容矩阵（五个组合；矩阵外拒绝）；
 * - request 非空字符串 → base64url-nopad 校验 + 解码 + UTF-8 JSON + JCS
 *   canonical 校验（线串必须已是 canonical 形态）+ method-specific schema；
 * - challenge 可选参数（digest/expires/description/header/opaque）按官方语义
 *   支持并验证；未知参数按官方客户端规则忽略（strip，不当事实）；
 * - 五个 method/intent 特定的 credential payload schema（stripe spt 前缀、
 *   evm 四类 credential 分派、tempo keyAuthorization）；
 * - 五个 method/intent 特定的 receipt schema（含 subscription/session 专属
 *   扩展字段）；
 * - credential-to-challenge 绑定：本面验证回显 challenge 的结构 + 暴露回显
 *   摘要供宿主关联；**原始 challenge 与回显的关联由宿主边界强制**（本面接口
 *   无法接收已签发 challenge 的可信关联上下文 —— 该验收准则显式留白，不模拟
 *   等价判定）。
 *
 * 诚实边界（不变）：不验签（MPP credential 签名验证需要密钥材料，未在案）；
 * 不签名、不调用钱包、不提交链上交易、不调用 provider、不授权支付、不宣称
 * 结算。产物永远是 `validated-untrusted-proposal`（结构验证 ≠ 密码学验证）。
 */

import { z } from "zod";
import { canonicalJsonStringify } from "../canonical-json.js";
import {
  PAYSWAP_MPP_METHOD_INTENT_MATRIX,
} from "./protocol-facts.js";
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

/** MPP intent 闭集（mpp.dev pin）。 */
export const PAYSWAP_MPP_INTENT_VALUES = ["charge", "session", "subscription"] as const;

/** MPP method 闭集（pinned rails —— 未 pin 的 per-network method 拒绝）。 */
export const PAYSWAP_MPP_METHOD_VALUES = ["stripe", "evm", "tempo"] as const;

// ---------------------------------------------------------------------------
// 共享形态
// ---------------------------------------------------------------------------

const base64UrlNopadRegex = /^[A-Za-z0-9_-]+$/;
const positiveIntStringRegex = /^[1-9]\d*$/;
const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const evmTxHashRegex = /^0x[0-9a-fA-F]{64}$/;
const rfc3339Regex = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const isoCurrencyRegex = /^[a-z]{3}$/;

/** SD-JWT/EVM 无关的 MPP 机制声明（MPP 不用 SD-JWT —— 无 _sd_alg/sd_hash）。 */

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
    // 官方 MUST 句：「Servers MUST reject request objects that include
    // recipient or subscriptionExpires」—— 本面在结构层即拒。
    if ((value as { recipient?: unknown }).recipient !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipient"],
        message: "recipient MUST NOT 在案（stripe subscription profile）",
      });
    }
    if ((value as { subscriptionExpires?: unknown }).subscriptionExpires !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscriptionExpires"],
        message: "subscriptionExpires MUST NOT 在案（stripe subscription profile）",
      });
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
        permit2Address: z.string().regex(evmAddressRegex).optional(),
        credentialTypes: z.array(z.enum(["permit2", "authorization", "transaction", "hash"])).optional(),
        decimals: z.number().int().optional(),
        splits: z.array(z.unknown()).max(10).optional(),
      })
      .strict(),
  })
  .strict();

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
    currency: z.string().regex(isoCurrencyRegex),
    periodUnit: z.enum(["day", "week"]),
    periodCount: z.string().regex(positiveIntStringRegex),
    subscriptionExpires: z.string().min(1),
    recipient: z.string().min(1),
    description: z.string().optional(),
    externalId: z.string().optional(),
    methodDetails: z
      .object({
        accessKey: z
          .object({
            accessKeyAddress: z.string().min(1),
            keyType: z.enum(["p256", "secp256k1", "webAuthn"]),
          })
          .strict(),
        chainId: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();

/** method+intent → request schema（矩阵分派）。 */
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

const evmSessionCredentialSchema = z
  .object({
    action: z.enum(["open", "topUp", "voucher", "close"]),
    channelId: z.string().min(1).optional(),
    cumulativeAmount: z.string().optional(),
    signature: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // session credential 的 action 闭集 + 签名在案（结构层；生命周期强制在宿主）。
    if (value.signature === undefined && value.action !== "close") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature"],
        message: "session credential 必须携带 voucher 签名（close 允许空签名仅当 cumulativeAmount <= channel.settled —— 宿主裁决）",
      });
    }
  });

const tempoSubscriptionCredentialSchema = z
  .object({
    type: z.literal("keyAuthorization"),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();

/** method+intent → credential payload schema（矩阵分派）。 */
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
    timestamp: z.string().regex(rfc3339Regex),
    externalId: z.string().optional(),
  })
  .strict();

const stripeSubscriptionReceiptSchema = z
  .object({
    method: z.literal("stripe"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().regex(rfc3339Regex),
    externalId: z.string().optional(),
  })
  .strict();

const evmChargeReceiptSchema = z
  .object({
    method: z.literal("evm"),
    challengeId: z.string().min(1).optional(),
    reference: z.string().regex(evmTxHashRegex),
    status: z.literal("success"),
    timestamp: z.string().regex(rfc3339Regex),
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
    timestamp: z.string().regex(rfc3339Regex),
    challengeId: z.string().min(1),
    channelId: z.string().min(1),
    acceptedCumulative: z.string().min(1),
    spent: z.string().min(1),
    chainId: z.number().int().positive(),
    units: z.string().optional(),
    txHash: z.string().optional(),
    confirmations: z.number().int().optional(),
  })
  .strict();

const tempoSubscriptionReceiptSchema = z
  .object({
    method: z.literal("tempo"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().regex(rfc3339Regex),
    externalId: z.string().optional(),
  })
  .strict();

/** method+intent(+receipt 内的 intent 自标识) → receipt schema。 */
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
// challenge schema（含可选参数 + request 解码/JCS + matrix + method schema）
// ---------------------------------------------------------------------------

/** Challenge（pin 逐字 + 可选参数官方语义）：id/realm/method/intent/request
 *  REQUIRED；expires（RFC 3339）/digest（RFC 9530 形态）/description（仅展示，
 *  不入绑定）/header（在案时 MUST = "Payment-Authorization"）/opaque（JCS
 *  base64url 扁平 string map）可选；**未知参数按官方客户端规则忽略**（strip
 *  —— 不当事实，也不拒绝）。 */
const challengeBaseSchema = z
  .object({
    id: z.string().min(1),
    realm: z.string().min(1),
    method: z.enum(["stripe", "evm", "tempo"]),
    intent: z.enum(["charge", "session", "subscription"]),
    request: z.string().regex(base64UrlNopadRegex),
    expires: z.string().regex(rfc3339Regex).optional(),
    digest: z.string().min(1).optional(),
    description: z.string().optional(),
    header: z.literal("Payment-Authorization").optional(),
    opaque: z.string().min(1).optional(),
  })
  // 未知参数按官方客户端规则忽略（strip —— 不拒绝，不当事实）。
  .strip();

/** opaque 的官方结构：base64url(JCS JSON) 且为扁平 string-to-string map。 */
function decodeOpaque(value: string): { ok: boolean; reason?: string } {
  if (!base64UrlNopadRegex.test(value)) {
    return { ok: false, reason: "opaque 非标准 base64url（无填充）形态" };
  }
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { ok: false, reason: "opaque base64 解码失败" };
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
  return { ok: true };
}

/** request 的官方序列化纪律：base64url-nopad(JSON JCS)。校验 = 解码 + UTF-8
 *  JSON 解析 + 重序列化与线串一致（canonical 形态必须已在案）。 */
function decodeAndValidateRequest(
  request: string,
  method: string,
  intent: string,
  ctx: z.RefinementCtx,
): void {
  let decoded: string;
  try {
    const base64 = request.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request base64url 解码失败" });
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decoded);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request 解码后非合法 JSON" });
    return;
  }
  let canonical: string;
  try {
    canonical = canonicalJsonStringify(parsedJson);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `request 的 JSON 无法 canonical 化（JCS 纪律）：${(error as Error).message}`,
    });
    return;
  }
  if (canonical !== decoded) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: "request 的 JSON 非 JCS canonical 形态（官方：JSON MUST be serialized using JCS）",
    });
    return;
  }
  const schema = requestSchemaFor(method, intent);
  if (schema === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `method/intent 组合 '${method}+${intent}' 不在兼容矩阵 —— 未 pin 的 rail 面`,
    });
    return;
  }
  const methodParsed = schema.safeParse(parsedJson);
  if (!methodParsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request"],
      message: `request 未通过 ${method}/${intent} pinned schema：${
        methodParsed.error.issues[0]?.message ?? "schema error"
      }`,
    });
  }
}

const challengeSchema = challengeBaseSchema.superRefine((value, ctx) => {
  // 法则 4 机器面：method/intent 兼容矩阵（protocol-facts.ts 单一事实源）。
  if (!PAYSWAP_MPP_METHOD_INTENT_MATRIX.some((e: { method: string; intent: string }) => e.method === value.method && e.intent === value.intent)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["intent"],
      message: `method/intent 组合 '${value.method}+${value.intent}' 不在兼容矩阵 —— 未 pin 的 rail 面（fail-closed）`,
    });
    return;
  }
  // opaque 官方结构校验。
  if (value.opaque !== undefined) {
    const opaque = decodeOpaque(value.opaque);
    if (!opaque.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["opaque"], message: opaque.reason ?? "opaque 形态非法" });
    }
  }
  // request 解码 + JCS canonical + method-specific schema。
  decodeAndValidateRequest(value.request, value.method, value.intent, ctx);
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
    // challenge 回显完整校验（矩阵 + 解码 + method schema）。
    const echo = challengeSchema.safeParse(value.challenge);
    if (!echo.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["challenge"],
        message: `credential 的 challenge 回显未通过校验：${echo.error.issues[0]?.message ?? "schema error"}`,
      });
      return;
    }
    // method/intent → credential payload schema 分派。
    const schema = credentialSchemaFor(echo.data.method, echo.data.intent);
    if (schema === null) return; // 矩阵预检已报
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
// receipt schemas（method(+intent) 分派 —— 五种）
// ---------------------------------------------------------------------------

const receiptBaseSchema = z.object({ method: z.enum(["stripe", "evm", "tempo"]) }).passthrough();

/** receipt 分派（method REQUIRED；stripe 的双 intent 由 envelope.context.intent
 *  分派；evm-session 的 receipt 自带 intent 字段自标识）。 */
function receiptSchemaForEnvelope(
  payload: unknown,
  envelopeIntent: string | null,
): { schema: z.ZodTypeAny; intent: string } | { error: string } {
  const base = receiptBaseSchema.safeParse(payload);
  if (!base.success) {
    return { error: `receipt 缺失/畸形 method 字段：${base.error.issues[0]?.message ?? "schema error"}` };
  }
  const method = base.data.method;
  // envelope intent 是分派权威 —— 与 receipt 自标识不一致 = 置位错误，拒绝。
  const dispatchIntent = envelopeIntent;
  if (dispatchIntent === null) {
    return { error: "receipt 分派需要 envelope intent 上下文（host 桥的 method/intent 路由）—— 缺席即 fail-closed" };
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
  // stripe：双 intent —— envelope intent 分派。
  const intent = envelopeIntent ?? (payload as { intent?: unknown })?.intent;
  if (intent === "charge") return { schema: stripeChargeReceiptSchema, intent: "charge" };
  if (intent === "subscription") return { schema: stripeSubscriptionReceiptSchema, intent: "subscription" };
  return { error: "stripe receipt 需要 intent 分派（charge|subscription）—— 缺席即 fail-closed" };
}

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。receipt 携带
 *  可选 intent 上下文（stripe 双意图分派所需）。 */
const inboundEnvelopeSchema = z
  .object({
    mppKind: z.enum(["challenge", "credential", "receipt"]),
    intent: z.enum(["charge", "session", "subscription"]).optional(),
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
      const parsed =
        mppKind === "challenge"
          ? challengeSchema.safeParse(payload)
          : mppKind === "credential"
            ? credentialSchema.safeParse(payload)
            : null;
      if (mppKind === "receipt") {
        // receipt：method(+intent) 分派 → 严格 schema 校验。进站 receipt 仍是
        // 不可信协议数据 —— 绝不因此推进账户状态或创建账本条目。
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
      if (!parsed || !parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `MPP ${mppKind} 消息未通过 pinned schema（字段越集 / 缺失必填 / 矩阵外组合 / request 编码违规 —— fail-closed）：${
              parsed && !parsed.success ? parsed.error.issues[0]?.message ?? "schema error" : "schema error"
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
