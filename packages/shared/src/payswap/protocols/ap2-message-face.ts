/**
 * PaySwap P3 —— AP2 消息面实现（协议适配器消息 schema / 验证门）。
 *
 * 实现许可（protocol-contract.ts 法则 5）：AP2 的 `reverifyBeforeAdapter` 清单
 * 已于 2026-11-21 清空（第三批检索 —— delegation 对象、Action Authorization 错误
 * 语义、Checkout Mandate 字段级 schema 逐字段入 pin），本消息面按**已验证事实**
 * 落地，绝不超出 pin 编码（protocol-facts.ts 法则 3）。
 *
 * 2026-11-22 对齐修正（Session B 对抗评审 + Session A 规范核验 + Session C
 * x402 矩阵，均官方源逐字）：constraints 官方**数组**格式 + 判别符精确；cnf
 * open REQUIRED；Payment Mandate 官方 claim 集（transaction_id REQUIRED 等
 * —— 此前的闭集把约束子字段名误提到顶层且漏五枚官方 claim）；receipt 三结构
 * 分离（Checkout Receipt / Payment Receipt / Action Authorization Mandate
 * Receipt —— 此前被合并为一）；checkout_hash 无密钥完整性校验（sha-256，无需
 * 签发者密钥）；base64url 形态检查；validated 术语纪律；宿主结算证据边界。
 *
 * 法则（protocol-contract.ts，normative）：
 * 1. 适配器不是执行者 —— 本面无凭据、无账户、无路由、无授权参数（类型面上
 *    就没有）。
 * 2. 进站消息是不可信输入 —— 验证产物只是**结构验证通过的不可信提案**（
 *    `validated-untrusted-proposal` —— 结构验证不是密码学验证），永不成为
 *    grant、授权或 provider 事实。
 * 3. 收据只从宿主签发的已验证结算证据发出 —— 证据缺席/畸形/非
 *    settled-verified 状态 = typed 拒绝（协议 accepted ≠ 结算）。
 * 4. pinning 强制 —— 描述符与注册表不一致即装配期失败（fail-loud）。
 *
 * 诚实边界（pin 内没说的就不做）：
 * - **不验签**：SD-JWT 签名/发行者/Key Binding JWT 验证需要签发者密钥材料与
 *   信任锚（未在案，也未交付）—— 本面验证**结构**（vct 精确匹配 + 字段闭集 +
 *   条件规则 + 无密钥完整性校验），产物永远标注 untrusted。
 * - **Payment Mandate 约束内容不深度校验**：open payment mandate 的
 *   constraints 数组按官方示例形态接受（type 判别符闭集 = payment.* 前缀
 *   —— 官方 payment_mandate 页列出的约束集），子字段类型官方未逐字段 pin。
 * - **_sd_alg 非 sha-256 的哈希算法不实现**：checkout_hash 校验在
 *   _sd_alg 缺省或 = sha-256 时强制；其它算法（官方允许 _sd_alg 声明）= 本面
 *   不实现该哈希 → typed 拒绝（不伪造校验）。
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
// pinned 词汇（逐字照录 —— 新值 = 契约变更，需官方源再检索）
// ---------------------------------------------------------------------------

/** Mandate vct 精确匹配集（pin：「MUST match the exact `vct` string, including
 *  the version suffix」—— 后缀缺失/未知版本一律拒）。 */
export const PAYSWAP_AP2_VCT_VALUES = [
  "mandate.checkout.1",
  "mandate.checkout.open.1",
  "mandate.payment.1",
  "mandate.payment.open.1",
] as const;

export type PayswapAp2Vct = (typeof PAYSWAP_AP2_VCT_VALUES)[number];

/** Action Authorization 错误码（pin 四枚）与终态/回退分类（官方语义逐字）。 */
export const PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS = [
  { code: "invalid_credential", kind: "terminal" },
  { code: "unresolved_constraint", kind: "fallback-signal" },
  { code: "invalid_mandate", kind: "terminal" },
  { code: "mandates_not_supported", kind: "fallback-signal" },
] as const;

export type PayswapAp2ActionAuthorizationErrorCode =
  (typeof PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS)[number]["code"];

export function payswapAp2ActionAuthorizationErrorKind(
  code: string,
): "terminal" | "fallback-signal" | null {
  const entry = PAYSWAP_AP2_ACTION_AUTHORIZATION_ERRORS.find((e) => e.code === code);
  return entry ? entry.kind : null;
}

/** Checkout Mandate 官方约束判别符闭集（open mandate 的 constraints 面 ——
 *  官方数组格式：每约束对象携带自身 `type` 判别符，逐字）。 */
export const PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES = [
  "checkout.allowed_merchants",
  "checkout.line_items",
] as const;

// ---------------------------------------------------------------------------
// 共享形态（SD-JWT 机制声明 / base64url / cnf）
// ---------------------------------------------------------------------------

/** base64url（RFC 4648 §5 nopad —— mandate/receipt 哈希与 JWT 形态检查）。 */
const base64UrlRegex = /^[A-Za-z0-9_-]+$/;

/** SD-JWT 标准机制声明（解码载荷携带的机器面字段 —— 与 mandate 内容字段并存；
 *  `cnf` 不在此处：closed 可选 / open REQUIRED，各 schema 显式声明）。 */
const sdJwtMachineryShape = {
  _sd_alg: z.string().min(1).optional(),
  sd_hash: z.string().min(1).optional(),
  iss: z.string().min(1).optional(),
  aud: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  nonce: z.string().min(1).optional(),
};

const cnfClaimSchema = z.object({ jwk: z.record(z.string(), z.unknown()) }).strict();

// ---------------------------------------------------------------------------
// Checkout Mandate schema（closed 严格 / open 数组约束 + cnf REQUIRED）
// ---------------------------------------------------------------------------

const checkoutMandateClosedSchema = z
  .object({
    vct: z.literal("mandate.checkout.1"),
    /** merchant 签名的 base64url serialized Checkout payload JWT（pin 逐字）。 */
    /** JWT compact 形态：三段 base64url 以点分隔（header.payload.signature）。 */
    checkout_jwt: z.string().min(1).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    /** checkout_jwt 的 base64url 哈希（_sd_alg 或 sha-256）—— 本面强制
     *  sha-256 无密钥完整性校验（F9 修正：`base64url(sha-256(checkout_jwt))`
     *  必须等于 checkout_hash）。 */
    checkout_hash: z.string().min(1).regex(base64UrlRegex),
    iat: z.number().int().optional(),
    exp: z.number().int().optional(),
    cnf: cnfClaimSchema.optional(),
    ...sdJwtMachineryShape,
  })
  .strict();

/** open mandate 的约束 schema（官方判别符逐字 + payload 字段闭集 + 官方基数
 *  纪律）：allowed 的空数组 = 官方逐字「the constraint is invalid」（min 1
 *  有据）；items/quantity 的基数与正负官方未述 —— schema 不发明（评估语义
 *  在宿主侧执行）。 */
const allowedMerchantsConstraintSchema = z
  .object({
    type: z.literal("checkout.allowed_merchants"),
    allowed: z.array(z.unknown()).min(1),
  })
  .strict();

const lineItemsConstraintSchema = z
  .object({
    type: z.literal("checkout.line_items"),
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          acceptable_items: z.array(z.unknown()),
          quantity: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

/** open checkout mandate（2026-11-22 官方格式修正）：`constraints` 是约束对象
 *  **数组**（每对象携带自身 `type` 判别符），不是对象映射。判别符闭集之外即拒
 *  （官方规范句「Any unknown Constraints MUST be treated as failing evaluation」
 *  —— 判别符预检在 refine 中先行，报错携带具体未知值）。`cnf` REQUIRED。 */
const checkoutMandateOpenSchema = z
  .object({
    vct: z.literal("mandate.checkout.open.1"),
    /** 官方 REQUIRED（open mandate）：cnf 在案 —— 其密码学验证（Key Binding JWT
     *  校验）不在本面（前置条件未在案，诚实边界在 pin）。 */
    cnf: cnfClaimSchema,
    constraints: z.array(
      z.object({ type: z.string().min(1) }).passthrough(),
    ),
    ...sdJwtMachineryShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    // 判别符预检（先于 payload 校验 —— 未知判别符的报错携带具体未知值）。
    for (const [index, constraint] of value.constraints.entries()) {
      if (!(PAYSWAP_AP2_CHECKOUT_CONSTRAINT_NAMES as readonly string[]).includes(constraint.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["constraints", index],
          message: `未知约束 type '${constraint.type}' —— 官方规范句：Any unknown Constraints MUST be treated as failing evaluation`,
        });
      }
    }
    // 已知判别符 → payload 严格校验（按判别符分派）。
    for (const [index, constraint] of value.constraints.entries()) {
      const schema =
        constraint.type === "checkout.allowed_merchants"
          ? allowedMerchantsConstraintSchema
          : constraint.type === "checkout.line_items"
            ? lineItemsConstraintSchema
            : null;
      if (schema === null) continue; // 预检已报
      const parsed = schema.safeParse(constraint);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["constraints", index],
          message: parsed.error.issues[0]?.message ?? "约束 payload 未通过 pinned schema",
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Payment Mandate schema（2026-11-22 官方 claim 集修正 —— Session B F2）
// ---------------------------------------------------------------------------

/** Payment Mandate 官方 claim 集（payment_mandate.md 逐字，Session B F2 修正）：
 *  closed = vct + transaction_id（REQUIRED，checkout_jwt 的 base64url 哈希）+
 *  payee（Merchant 对象）+ payment_amount（Amount 对象）+ payment_instrument
 *  （对象）+ pisp/risk_data/iat/exp（可选）；open MAY 携带 closed 任意字段并
 *  另有 constraints（数组）+ cnf（REQUIRED while open）。此前的闭集把约束子
 *  字段名（allowed/currency/frequency/max/max_occurrences/min/not_after/
 *  not_before）误提到顶层且漏 transaction_id/pisp/risk_data —— 就此修正。 */
const PAYSWAP_AP2_PAYMENT_MANDATE_CLAIM_NAMES = [
  "vct",
  "transaction_id",
  "payee",
  "payment_amount",
  "payment_instrument",
  "pisp",
  "risk_data",
  "iat",
  "exp",
  "constraints",
  "cnf",
  ...Object.keys(sdJwtMachineryShape),
] as const;

const paymentMandateSchema = z
  .object({
    vct: z.enum(["mandate.payment.1", "mandate.payment.open.1"]),
    transaction_id: z.string().min(1).regex(base64UrlRegex),
    cnf: cnfClaimSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    // 字段名闭集（官方 claim 集 + SD-JWT 机制声明）。
    for (const fieldName of Object.keys(value)) {
      if (!(PAYSWAP_AP2_PAYMENT_MANDATE_CLAIM_NAMES as readonly string[]).includes(fieldName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [fieldName],
          message: `字段 '${fieldName}' 不在官方 Payment Mandate claim 集 —— 未知形态 fail-closed`,
        });
      }
    }
    // cnf：open REQUIRED（与 checkout 同款官方规则）。
    if (value.vct === "mandate.payment.open.1" && value.cnf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cnf"],
        message: "open Payment Mandate 的 cnf REQUIRED（官方：cnf REQUIRED if the Mandate is still open）",
      });
    }
    // constraints（open 变体）：数组形态 + type 判别符闭集（payment.* 前缀 ——
    // 官方示例形态；子字段类型官方未逐字段 pin，不发明）。
    const raw = value as { constraints?: unknown };
    if (raw.constraints !== undefined) {
      if (!Array.isArray(raw.constraints)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["constraints"],
          message: "constraints 必须为约束对象数组（官方格式）",
        });
        return;
      }
      for (const constraint of raw.constraints) {
        const type = (constraint as { type?: unknown })?.type;
        if (typeof type !== "string" || type.startsWith("checkout.")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["constraints"],
            message: `payment 约束判别符 '${String(type)}' 不在 Payment Mandate 的约束集（payment.* 前缀）`,
          });
        }
      }
    }
  });

/** mandate 载荷分派（vct 精确匹配 —— 未知/缺后缀 vct = 未知形态）。 */
const mandatePayloadSchema = z.union([
  checkoutMandateClosedSchema,
  checkoutMandateOpenSchema,
  paymentMandateSchema,
]);

/** delegation 对象（agent_authorization.md，检索 2026-11-21 pin 逐字；
 *  delegate_payload 元素 = 官方「Mandate Content payloads as JSON Objects」
 *  —— 元素必须是对象，非对象拒绝）。 */
const delegationObjectSchema = z
  .object({
    type: z.literal("delegate"),
    format: z.string().min(1),
    delegate_payload: z.array(z.record(z.string(), z.unknown())).min(1),
    delegate_disclosures: z.array(z.unknown()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Receipt 三结构（2026-11-22 修正 —— 官方三种不同线格式，绝不合并）
// ---------------------------------------------------------------------------

/** Checkout Receipt（checkout_mandate.md —— status 语义；order_id iff Success；
 *  error iff Error —— 双向 iff 强制，F11 修正）。 */
const checkoutReceiptSchema = z
  .object({
    status: z.enum(["Success", "Error"]),
    iss: z.string().min(1),
    iat: z.number().int(),
    reference: z.string().min(1).regex(base64UrlRegex),
    error: z.string().optional(),
    error_description: z.string().optional(),
    order_id: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // iff 双向强制（F11 修正 —— 同款措辞同款执行力）。
    if (value.status === "Error") {
      if (value.order_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["order_id"], message: "order_id 仅 Success 时在案（pin 逐字：if and only if status is Success）" });
      }
      if (value.error === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "Error receipt 必须携带 error（pin 逐字：Present if and only if status is Error）" });
      }
    } else {
      if (value.order_id === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["order_id"], message: "Success receipt 必须携带 order_id（pin 逐字：Present if and only if status is Success）" });
      }
      if (value.error !== undefined || value.error_description !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "error/error_description 仅 Error 时在案（pin 逐字）" });
      }
    }
  });

/** Payment Receipt（payment_mandate.md —— payment_id REQUIRED；
 *  psp_confirmation_id / network_confirmation_id 仅 Success）。 */
const paymentReceiptSchema = z
  .object({
    status: z.enum(["Success", "Error"]),
    iss: z.string().min(1),
    payment_id: z.string().min(1),
    psp_confirmation_id: z.string().optional(),
    network_confirmation_id: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "Error") {
      if (value.psp_confirmation_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["psp_confirmation_id"], message: "psp_confirmation_id 仅 Success 时在案（pin 逐字）" });
      }
      if (value.network_confirmation_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["network_confirmation_id"], message: "network_confirmation_id 仅 Success 时在案（pin 逐字）" });
      }
    }
  });

/** Action Authorization Mandate Receipt（agent_authorization.md —— result 语义：
 *  iss / result（枚举 success|error）/ reference（_sd_alg 或 sha-256 的
 *  base64url 哈希）/ 可选 error、error_description）。与 Checkout Receipt /
 *  Payment Receipt 是不同线格式。 */
const mandateReceiptSchema = z
  .object({
    result: z.enum(["success", "error"]),
    iss: z.string().min(1),
    reference: z.string().min(1).regex(base64UrlRegex),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result === "error" && value.error === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "error receipt 必须携带 error 码（pin：MUST be present when the result is error）" });
    }
    if (value.result === "success" && value.error !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "success receipt 不得携带 error" });
    }
  });

/** 进站消息路由标签（host 桥的分派面 —— 未知标签 fail-closed）。receipt 按
 *  官方三结构分派（2026-11-22 修正）。 */
const inboundEnvelopeSchema = z
  .object({
    ap2Kind: z.enum(["mandate", "delegation", "checkout-receipt", "payment-receipt", "mandate-receipt"]),
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

async function sha256Base64Url(input: string): Promise<string> {
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64UrlEncode(new Uint8Array(digestBytes));
}

async function payloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalJsonStringify(payload);
  return sha256Base64Url(canonical);
}

// ---------------------------------------------------------------------------
// 适配器工厂（注册门 + translateInbound + emitReceipt）
// ---------------------------------------------------------------------------

function refusal(code: PayswapProtocolRefusal["code"], message: string): PayswapProtocolRefusal {
  return { code, message };
}

/**
 * 创建 AP2 消息面适配器（PayswapProtocolAdapter 的 AP2 实现）。描述符与注册表
 * 不一致 = 装配期 throw（法则 4 fail-loud —— 不存在「带警告创建」）。
 */
export function createPayswapAp2MessageFace(
  descriptor: PayswapProtocolAdapterDescriptor,
): PayswapProtocolAdapter {
  const registration = evaluatePayswapProtocolAdapterRegistration(descriptor);
  if (registration.kind === "refused") {
    throw new Error(
      `AP2 消息面装配被拒（${registration.refusal.code}）：${registration.refusal.message}`,
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
            `进站消息形态未知（ap2Kind 路由标签缺失/未知）—— fail-closed：${envelope.error.issues[0]?.message ?? "schema error"}`,
          ),
        };
      }
      const { ap2Kind, payload } = envelope.data;
      const schema =
        ap2Kind === "mandate"
          ? mandatePayloadSchema
          : ap2Kind === "delegation"
            ? delegationObjectSchema
            : ap2Kind === "checkout-receipt"
              ? checkoutReceiptSchema
              : ap2Kind === "payment-receipt"
                ? paymentReceiptSchema
                : mandateReceiptSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_message_unverifiable",
            `AP2 ${ap2Kind} 消息未通过 pinned schema（未知 vct / 字段越集 / 条件规则违背 —— fail-closed）：${
              parsed.error.issues[0]?.message ?? "schema error"
            }`,
          ),
        };
      }
      // 无密钥完整性校验（F9 修正 —— 不需要签发者密钥）：closed checkout
      // mandate 的 checkout_hash MUST = base64url(sha-256(checkout_jwt))；
      // _sd_alg 在案且非 sha-256 = 本面不实现该算法 → typed 拒绝（不伪造）。
      if (ap2Kind === "mandate") {
        const mandate = payload as { vct?: unknown; checkout_jwt?: unknown; checkout_hash?: unknown; _sd_alg?: unknown };
        if (mandate.vct === "mandate.checkout.1") {
          if (mandate._sd_alg !== undefined && mandate._sd_alg !== "sha-256") {
            return {
              kind: "refused",
              refusal: refusal(
                "protocol_message_unverifiable",
                `_sd_alg '${String(mandate._sd_alg)}' 的哈希算法不在本面实现 —— 不伪造完整性校验（fail-closed）`,
              ),
            };
          }
          const expectedHash = await sha256Base64Url(String(mandate.checkout_jwt));
          if (expectedHash !== mandate.checkout_hash) {
            return {
              kind: "refused",
              refusal: refusal(
                "protocol_message_unverifiable",
                "checkout_hash 与 checkout_jwt 的 sha-256 哈希不一致（官方：base64url-encoded hash of the checkout_jwt field value）—— 无密钥完整性校验失败",
              ),
            };
          }
        }
      }
      // 法则 2：产物 = 结构验证通过的不可信提案（载荷摘要进证据链；typed intent
      // 随 P4）。术语纪律：validated ≠ cryptographically verified —— SD-JWT 签名/
      // 发行者/Key Binding 验证的前置条件未在案，本面绝不模拟。
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
