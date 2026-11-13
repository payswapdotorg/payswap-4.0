/**
 * PaySwap P2 —— 账户只读数据面法则（ADR-P2-1；deliverable 05 §6.1 read taxonomy 的
 * P2 投影 + §4「Capability declaration — evidence, never claims」+ doc 04 §1.2
 * 「the Stripe Account `capabilities` + `requirements` read-back is *exactly* the
 * evidence PaySwap's evidence-backed capability registry should consume」）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **闭集类别枚举**：P2 的对话内只读类别恰为 `balance | payment_objects |
 *    customers | disputes`（register P2 验收「read-only ops (balances, payment
 *    objects, customers, disputes…) run conversationally」）。**无任何 write 类别
 *    存在** —— 只读面是结构性的（N21 的数据面投影：闭集 dispatch 表 + 闭集类别
 *    枚举，写操作在 P2 的任何面上都不可表达）。
 * 2. **按类别的 redacted 数据 schema（strict）**：秘密零携带 + PII 零携带（客户
 *    面只保留 id/created/description —— email/name 不进投影；doc 05 §12.8
 *    redaction 纪律的结构化落地）。畸形 provider 载荷在此即拒（fail-closed）。
 * 3. **能力证据 schema（doc 04 §1.2）**：`capabilities[]`（name + active/inactive/
 *    pending 三值状态）+ `requirements` 摘要（disabledReason / currentlyDueCount /
 *    pastDueCount）—— 全部来自 provider 读回，永不硬编码声明（evidence, never
 *    claims）。
 * 4. **类别读结局四值词汇**：`ok | auth-failed | refused | unavailable`（doc 05
 *    §6.4 unknown ≠ failed + §6.6 typed refusals）：401 是唯一 auth-failed 证据；
 *    403 权限边界 → `refused{insufficient_permission}`（typed，携带 provider 证据
 *    语义而非猜测）；其余（429/5xx/非 JSON/传输异常/超时/畸形）→ `unavailable`
 *    —— 永不假装成功，永不假装 auth 失败。
 * 5. **概览 detail 联合**：`detail`（连接投影 + 能力证据 + 四类别结果）| `expired`
 *    （验证读 401 —— 状态机已翻，无数据可读）| `revoked`（终态，零端口触达）|
 *    `refused`（账户服务 typed 拒绝词汇 —— unknown_connection / 存储 fail-closed /
 *    read_back_unavailable）。与 refreshEvidence 的结果词汇（doc 06 §2.2）同构。
 */

import { z } from "zod";
import type {
  PayswapAccountCapabilityEvidence,
  PayswapAccountRefusal,
  PayswapConnectionStatusProjection,
  PayswapPspSecretKind,
} from "./account-connection.js";

// ---------------------------------------------------------------------------
// 闭集类别枚举（法则 1 —— 无 write 类别）
// ---------------------------------------------------------------------------

/** P2 对话内只读类别（闭集；无 write 类别 —— no-write 面是结构性的）。 */
export const PAYSWAP_READONLY_CATEGORIES = [
  "balance",
  "payment_objects",
  "customers",
  "disputes",
] as const;
export type PayswapReadonlyCategory = (typeof PAYSWAP_READONLY_CATEGORIES)[number];

/**
 * no-write 断言的法则半（battery 断言词汇）：doc 05 §6.1 taxonomy 的 write 动词
 * 集。任何 P2 面（op 名、类别枚举、params schema 键）出现这些动词 = 实现缺陷。
 * 本常量仅供 no-write 断言行消费（battery 的单一事实源），运行时零使用。
 */
export const PAYSWAP_WRITE_OPERATION_VERBS = [
  "create",
  "confirm",
  "capture",
  "cancel",
  "refund",
  "payout",
  "transfer",
  "respond",
  "write",
  "verify_recipient",
] as const;

// ---------------------------------------------------------------------------
// 按类别的 redacted 数据 schema（法则 2 —— strict + 秘密/PII 零携带）
// ---------------------------------------------------------------------------

/** 余额行（Stripe /v1/balance 的 redacted 投影：amount 为 minor-unit 整数字符串）。 */
export const payswapBalanceEntrySchema = z
  .object({
    amount: z.string().regex(/^-?\d+$/),
    currency: z.string().min(3).max(8),
  })
  .strict();
export type PayswapBalanceEntry = z.infer<typeof payswapBalanceEntrySchema>;

export const payswapBalanceDataSchema = z
  .object({
    available: z.array(payswapBalanceEntrySchema),
    pending: z.array(payswapBalanceEntrySchema),
  })
  .strict();
export type PayswapBalanceData = z.infer<typeof payswapBalanceDataSchema>;

/** 支付对象行（Stripe Charge 的 redacted 投影；`succeeded ≠ money in the bank` 的原始证据，doc 04 §1.7）。 */
export const payswapPaymentObjectSchema = z
  .object({
    id: z.string().min(1),
    amount: z.string().regex(/^-?\d+$/),
    currency: z.string().min(3).max(8),
    status: z.string().min(1),
    created: z.number().int().nonnegative(),
    description: z.string().min(1).nullable(),
  })
  .strict();
export type PayswapPaymentObject = z.infer<typeof payswapPaymentObjectSchema>;

/**
 * 客户行（Stripe Customer 的 redacted 投影）：**只保留 id/created/description**
 * —— email/name 等 PII 永不进数据面（redaction-by-construction；携带 PII 的
 * provider 载荷在此之后不存在，不是事后擦除）。
 */
export const payswapCustomerSchema = z
  .object({
    id: z.string().min(1),
    created: z.number().int().nonnegative(),
    description: z.string().min(1).nullable(),
  })
  .strict();
export type PayswapCustomer = z.infer<typeof payswapCustomerSchema>;

/** 争议行（Stripe Dispute 的 redacted 投影）。 */
export const payswapDisputeSchema = z
  .object({
    id: z.string().min(1),
    amount: z.string().regex(/^-?\d+$/),
    currency: z.string().min(3).max(8),
    status: z.string().min(1),
    reason: z.string().min(1).nullable(),
    created: z.number().int().nonnegative(),
  })
  .strict();
export type PayswapDispute = z.infer<typeof payswapDisputeSchema>;

/** 类别 → redacted 数据类型（TS 面的 per-category 映射）。 */
export interface PayswapReadonlyCategoryData {
  readonly balance: PayswapBalanceData;
  readonly payment_objects: readonly PayswapPaymentObject[];
  readonly customers: readonly PayswapCustomer[];
  readonly disputes: readonly PayswapDispute[];
}

// ---------------------------------------------------------------------------
// 类别读结局（法则 4 —— ok | auth-failed | refused | unavailable）
// ---------------------------------------------------------------------------

/** 类别读 typed refusal 码（doc 05 §6.6 词汇的 P2 数据面子集）。 */
export const PAYSWAP_READONLY_REFUSAL_CODES = [
  "insufficient_permission",
  "capability_not_enabled",
  "unsupported_operation",
] as const;
export type PayswapReadonlyRefusalCode = (typeof PAYSWAP_READONLY_REFUSAL_CODES)[number];

export interface PayswapReadonlyRefusal {
  readonly code: PayswapReadonlyRefusalCode;
  /** 操作员可读、零凭据材料（doc 05 §6.6 message 纪律）。 */
  readonly message: string;
}

/**
 * 类别读结局（四值）：`ok`（strict redacted 数据）/ `auth-failed`（401 —— 唯一
 * provider 拒绝证据）/ `refused`（typed：403 权限边界 → insufficient_permission；
 * 未配置能力 → capability_not_enabled；provider 明示不支持 → unsupported_operation）
 * / `unavailable`（unknown ≠ failed：其余一切）。
 */
export type PayswapReadonlyCategoryResult =
  | { readonly status: "ok"; readonly data: PayswapReadonlyCategoryData[PayswapReadonlyCategory] }
  | { readonly status: "auth-failed"; readonly detail: string }
  | { readonly status: "refused"; readonly refusal: PayswapReadonlyRefusal }
  | { readonly status: "unavailable"; readonly detail: string };

// ---------------------------------------------------------------------------
// 数据读端口法则（adapter 函数面 —— 与 PayswapAccountReadBackPort 同款纪律）
// ---------------------------------------------------------------------------

/** 类别读输入（读回输入 + 闭集类别；秘密只经参数入，端口永不持久化/日志/投影它）。 */
export interface PayswapAccountDataReadInput {
  readonly providerId: string;
  readonly mode: "test" | "live";
  readonly secretKind: PayswapPspSecretKind;
  readonly secret: string;
  readonly category: PayswapReadonlyCategory;
}

/**
 * provider 数据读端口（host 进程内的 adapter 函数面；真实 Stripe 实现随 provider
 * 运行时切片）。结局纪律见 `PayswapReadonlyCategoryResult`；装配错配（provider/
 * secretKind 路由错）由 adapter 抛出（fail-closed 响亮），服务侧映射 typed 拒绝。
 */
export type PayswapAccountDataReadPort = (
  input: PayswapAccountDataReadInput,
) => Promise<PayswapReadonlyCategoryResult>;

// ---------------------------------------------------------------------------
// 概览 detail 联合（法则 5 —— 与 refreshEvidence 结果词汇同构）
// ---------------------------------------------------------------------------

/** 验证通过后的完整 detail：连接投影 + 能力证据 + 四类别结果（全部现读）。 */
export interface PayswapAccountOverviewDetailData {
  readonly kind: "detail";
  readonly connection: PayswapConnectionStatusProjection;
  readonly evidence: PayswapAccountCapabilityEvidence;
  readonly data: Readonly<Record<PayswapReadonlyCategory, PayswapReadonlyCategoryResult>>;
}

/**
 * `get_account_overview` 的 detail 联合（connectionId 收窄时的回答负载）：
 * - `detail` —— 验证读通过（状态机 landed connected）+ 四类别已读；
 * - `expired` —— 验证读 401（**唯一 expiry 证据**；状态机已翻 expired 并持久化，
 *   与 refreshEvidence 同一状态机、同一写纪律 —— 状态变更才写记录）；
 * - `revoked` —— 终态（零端口触达，直回投影 —— doc 05 §5「A revoked connection
 *   can never keep a stale "connected" status」）；
 * - `refused` —— 账户服务 typed 拒绝（unknown_connection / 存储 fail-closed /
 *   read_back_unavailable —— 端口缺席/传输异常/畸形结局/证据缺席）。
 */
export type PayswapAccountOverviewDetail =
  | PayswapAccountOverviewDetailData
  | { readonly kind: "expired"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "revoked"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

/** 类别读结局的 strict 校验器（per-category；畸形数据永不进 detail 面）。 */
export const payswapReadonlyCategoryResultSchemas: Readonly<
  Record<PayswapReadonlyCategory, z.ZodType>
> = {
  balance: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: payswapBalanceDataSchema }).strict(),
    z.object({ status: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
    z
      .object({
        status: z.literal("refused"),
        refusal: z
          .object({
            code: z.enum(PAYSWAP_READONLY_REFUSAL_CODES),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z.object({ status: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
  ]),
  payment_objects: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: z.array(payswapPaymentObjectSchema) }).strict(),
    z.object({ status: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
    z
      .object({
        status: z.literal("refused"),
        refusal: z
          .object({
            code: z.enum(PAYSWAP_READONLY_REFUSAL_CODES),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z.object({ status: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
  ]),
  customers: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: z.array(payswapCustomerSchema) }).strict(),
    z.object({ status: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
    z
      .object({
        status: z.literal("refused"),
        refusal: z
          .object({
            code: z.enum(PAYSWAP_READONLY_REFUSAL_CODES),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z.object({ status: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
  ]),
  disputes: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: z.array(payswapDisputeSchema) }).strict(),
    z.object({ status: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
    z
      .object({
        status: z.literal("refused"),
        refusal: z
          .object({
            code: z.enum(PAYSWAP_READONLY_REFUSAL_CODES),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z.object({ status: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
  ]),
};
