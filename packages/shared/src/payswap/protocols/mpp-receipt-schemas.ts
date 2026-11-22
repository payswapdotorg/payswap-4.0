/**
 * PaySwap P3 —— MPP receipt schema（五个 method/intent 组合的收据 schema 与
 * 分派函数）。从 mpp-message-face.ts 拆出以遵守架构 800 行上限（分层拆分：
 * request/credential schema 留在主面文件，receipt schema 独立文件）。
 *
 * 被钉住的 receipt 形态（官方源逐字，检索 2026-11-22）：
 * - stripe-charge：method/reference（Stripe PaymentIntent ID）/status="success"/
 *   timestamp（RFC 3339 日历校验）/externalId 可选；
 * - stripe-subscription：同上 + subscriptionId REQUIRED；
 * - evm-charge：method/challengeId 可选/reference（0x 64 hex 交易哈希）/
 *   status/timestamp/chainId REQUIRED/externalId 可选；
 * - evm-session：method/intent="session"/reference（MUST = channelId）/
 *   status/timestamp/challengeId/channelId/acceptedCumulative/spent/chainId
 *   REQUIRED + units/txHash/confirmations 可选；
 * - tempo-subscription：method/reference（交易哈希）/status/subscriptionId
 *   REQUIRED/timestamp/externalId 可选。
 */

import { z } from "zod";
import { evmTxHashRegex, isValidRfc3339Date } from "./mpp-validation-primitives.js";

// ---------------------------------------------------------------------------
// 五个 method/intent 的 receipt schema
// ---------------------------------------------------------------------------

export const stripeChargeReceiptSchema = z
  .object({
    method: z.literal("stripe"),
    reference: z.string().min(1),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => {
      
      return isValidRfc3339Date(v);
    }, "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

export const stripeSubscriptionReceiptSchema = z
  .object({
    method: z.literal("stripe"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().refine((v) => {
      
      return isValidRfc3339Date(v);
    }, "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

export const evmChargeReceiptSchema = z
  .object({
    method: z.literal("evm"),
    challengeId: z.string().min(1).optional(),
    reference: z.string().regex(evmTxHashRegex),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => {
      
      return isValidRfc3339Date(v);
    }, "RFC 3339 日历日期校验失败"),
    chainId: z.number().int().positive(),
    externalId: z.string().optional(),
  })
  .strict();

export const evmSessionReceiptSchema = z
  .object({
    method: z.literal("evm"),
    intent: z.literal("session"),
    reference: z.string().min(1),
    status: z.literal("success"),
    timestamp: z.string().refine((v) => {
      
      return isValidRfc3339Date(v);
    }, "RFC 3339 日历日期校验失败"),
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

export const tempoSubscriptionReceiptSchema = z
  .object({
    method: z.literal("tempo"),
    reference: z.string().min(1),
    status: z.literal("success"),
    subscriptionId: z.string().min(1),
    timestamp: z.string().refine((v) => {
      
      return isValidRfc3339Date(v);
    }, "RFC 3339 日历日期校验失败"),
    externalId: z.string().optional(),
  })
  .strict();

/** method+intent → receipt schema 分派（五种 —— 矩阵外的组合 = null）。 */
export function mppReceiptSchemaFor(
  method: string,
  intent: string | null,
): z.ZodTypeAny | null {
  if (method === "stripe" && intent === "charge") return stripeChargeReceiptSchema;
  if (method === "stripe" && intent === "subscription") return stripeSubscriptionReceiptSchema;
  if (method === "stripe") return null;
  if (method === "evm" && intent === "session") return evmSessionReceiptSchema;
  if (method === "evm") return evmChargeReceiptSchema;
  if (method === "tempo") return tempoSubscriptionReceiptSchema;
  return null;
}
