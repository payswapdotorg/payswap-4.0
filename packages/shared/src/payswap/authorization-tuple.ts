/**
 * PaySwap 交易授权 tuple（addendum §1.3 —— mission mandate / deliverable 06 §4 的
 * 完整绑定元组；playbook work package P1.7）。
 *
 * 法则（normative）：
 * - grant 绑定**完整** tuple：principal（host 验证的人）、source（connectionId +
 *   账户身份）、recipient（**已验证**收款方 + provider read-back 证据引用）、
 *   amount/currency（精确十进制 + ISO-4217）、purpose（typed 分类）、route+legs
 *   （逐 leg 携 idempotency key 的精确路由图）、fees（最大总费用）、fx（汇率条件）、
 *   expiry（墙钟过期）。schema `.strict()` —— 未知键拒绝（不存在 `display` 之类的
 *   自报字段位）。
 * - digest = tuple 的 **canonical JSON**（RFC 8785，`canonical-json.ts` 单一实现）
 *   的 SHA-256 —— host 与验证侧共用同一实现（单一实现纪律）。
 * - 绑定法则：presented 与 bound 的 canonical 形式**完全一致**才通过；任何实质偏差
 *   （amount +1 minor unit、不同 recipient、多一 leg、更高费上限、不同 purpose/
 *   source/principal/expiry）→ `mismatch`（携带首个偏差字段名供审计），绝不
 *   best-effort 执行（§1.3：typed `authorization_mismatch`）。
 *
 * 生产 tuple 由 host 侧状态组装（P4 意图编译 / P6 路由发现；P1.7 只落法则与
 * 机制）；金额/货币格式是 provider 无关的精确十进制字符串。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";

/** 精确十进制（无符号、无指数；minor unit 语义由 provider 适配层换算）。 */
const exactDecimalSchema = z.string().regex(/^\d+(\.\d+)?$/);

/** ISO-4217 字母码。 */
const iso4217Schema = z.string().regex(/^[A-Z]{3}$/);

const sourceSchema = z
  .object({
    connectionId: z.string().min(1),
    accountId: z.string().min(1),
  })
  .strict();

const recipientSchema = z
  .object({
    /** 已验证的收款方身份（provider read-back 证据背书）。 */
    recipientId: z.string().min(1),
    /** provider read-back 证据引用（P2+ 证据快照）。 */
    evidenceRef: z.string().min(1),
  })
  .strict();

const legSchema = z
  .object({
    legId: z.string().min(1),
    provider: z.string().min(1),
    recipientId: z.string().min(1),
    amount: exactDecimalSchema,
    currency: iso4217Schema,
    /** per-leg idempotency key（P7 executor 的幂等纪律锚点）。 */
    idempotencyKey: z.string().min(1),
  })
  .strict();

const fxSchema = z
  .object({
    rateFloor: exactDecimalSchema.optional(),
    rateSource: z.string().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

/** §1.3 完整绑定元组（strict —— 未知键拒绝；无任何自报 display 位）。 */
export const payswapAuthorizationTupleSchema = z
  .object({
    principal: z.string().min(1),
    source: sourceSchema,
    recipient: recipientSchema,
    amount: z.object({ value: exactDecimalSchema, currency: iso4217Schema }).strict(),
    purpose: z.string().min(1),
    route: z.object({ legs: z.array(legSchema).min(1) }).strict(),
    fees: z.object({ maxTotalFees: exactDecimalSchema }).strict(),
    fx: fxSchema.optional(),
    /** 墙钟过期（epoch ms）—— 过期的 grant 拒绝（N12）。 */
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PayswapAuthorizationTuple = z.infer<typeof payswapAuthorizationTupleSchema>;

/** tuple 的 SHA-256 digest（canonical JSON 单一实现 —— 键序无关）。 */
export function payswapTupleDigest(tuple: PayswapAuthorizationTuple): string {
  return createHash("sha256").update(canonicalJsonStringify(tuple), "utf8").digest("hex");
}

export type PayswapTupleBindingVerdict =
  | { status: "match" }
  | { status: "mismatch"; firstDeviation: string };

/** 绑定法则的比较域（固定顺序 —— 首个偏差字段的报告顺序稳定）。 */
const TUPLE_BINDING_FIELDS = [
  "principal",
  "source",
  "recipient",
  "amount",
  "purpose",
  "route",
  "fees",
  "fx",
  "expiresAt",
] as const satisfies readonly (keyof PayswapAuthorizationTuple)[];

/**
 * §1.3 绑定法则：canonical 形式完全一致 → match；任何实质偏差 → mismatch（首个
 * 偏差字段名供审计）。调用方（enforcement seam）把 mismatch 映射为 typed
 * `authorization_mismatch`。
 */
export function evaluatePayswapTupleBinding(
  bound: PayswapAuthorizationTuple,
  presented: PayswapAuthorizationTuple,
): PayswapTupleBindingVerdict {
  for (const field of TUPLE_BINDING_FIELDS) {
    if (
      canonicalJsonStringify(bound[field] as unknown) !==
      canonicalJsonStringify(presented[field] as unknown)
    ) {
      return { status: "mismatch", firstDeviation: field };
    }
  }
  return { status: "match" };
}
