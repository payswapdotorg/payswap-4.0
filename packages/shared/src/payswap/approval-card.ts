/**
 * PaySwap Class-B 授权卡 payload（addendum §1.6.0/§1.6.2 item 2 —— 受信 renderer 渲染
 * 的授权卡；permission-prompt 投影模式 + 一处**有意 delta**；playbook P1.7）。
 *
 * 法则（normative）：
 * - **Class B**：授权卡由 host 在受信 application renderer 渲染（permission-prompt
 *   投影模式：host 计算类型化 payload → 受信 renderer 按数据渲染 → resolveInteraction
 *   回传通道），**不是**插件表面、不可声明在 `ui.surfaces[]`、不是 `ui://` 资源。
 * - **内容 origin = host**（§1.6.0）：payload 的每个展示值（amount/recipient/legs/
 *   fees/fx/expiry/purpose）都由 host 代码从 proposal 记录派生 —— 展示的与记录的是
 *   同一份数据。构建器 `buildPayswapAuthorizationCardPayload` 是单一派生路径；
 *   `payswapTupleDisplayProjection` 是 byte-equal 断言面（N14）。
 * - **有意 delta**：上游 permission prompt 允许工具自报 `display` 预览
 *   （snapshot.ts:253-255）；授权卡**不使用**任何插件/工具自报 display 字段作为
 *   授权 tuple 值 —— schema `.strict()` 且无 display 位（携带即拒绝）。
 * - **challenge 骑卡**（§1.6.2 item 1）：一次性 challenge 只发给该卡实例 —— payload
 *   携带 {challengeId, secret}，只存在于 host↔受信-renderer 层，永不进入模型上下文、
 *   永不经过插件 MCP server 进程（bridge 信封面结构上无此字段）。
 * - options 恰好 approve/deny 两枚（人的一次明确决定 —— 无第三态）。
 */

import { z } from "zod";
import type { PayswapAuthorizationTuple } from "./authorization-tuple.js";

/** 展示投影域（§1.6.0 列举的展示值 —— 与 tuple 字段结构相同但独立声明：这是渲染面）。 */
const displaySourceSchema = z
  .object({ connectionId: z.string().min(1), accountId: z.string().min(1) })
  .strict();

const displayRecipientSchema = z
  .object({ recipientId: z.string().min(1), evidenceRef: z.string().min(1) })
  .strict();

const displayLegSchema = z
  .object({
    legId: z.string().min(1),
    provider: z.string().min(1),
    recipientId: z.string().min(1),
    amount: z.string().min(1),
    currency: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const displayFxSchema = z
  .object({
    rateFloor: z.string().min(1).optional(),
    rateSource: z.string().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

export const payswapAuthorizationCardPayloadSchema = z
  .object({
    kind: z.literal("payswap-authorization"),
    proposalId: z.string().min(1),
    /** host 计算的摘要行（permission-prompt 的 summary 同位）。 */
    summary: z.string().min(1),
    /** host 派生的授权展示投影 —— 与 proposal 记录 byte-equal（N14）。 */
    authorization: z
      .object({
        source: displaySourceSchema,
        recipient: displayRecipientSchema,
        amount: z.object({ value: z.string().min(1), currency: z.string().min(1) }).strict(),
        purpose: z.string().min(1),
        route: z.object({ legs: z.array(displayLegSchema).min(1) }).strict(),
        fees: z.object({ maxTotalFees: z.string().min(1) }).strict(),
        fx: displayFxSchema.optional(),
        expiresAt: z.number().int().positive(),
      })
      .strict(),
    /** 一次性 challenge（只发给该卡实例；§1.6.2 item 1）。 */
    challenge: z
      .object({ challengeId: z.string().min(1), secret: z.string().min(1) })
      .strict(),
    options: z
      .array(
        z
          .object({ optionId: z.enum(["approve", "deny"]), label: z.string().min(1) })
          .strict(),
      )
      .length(2),
  })
  .strict();

export type PayswapAuthorizationCardPayload = z.infer<typeof payswapAuthorizationCardPayloadSchema>;

/** proposal 记录的展示投影（N14 的 byte-equal 断言面 —— 独立函数保证单一投影语义）。 */
export function payswapTupleDisplayProjection(tuple: PayswapAuthorizationTuple) {
  return {
    source: { ...tuple.source },
    recipient: { ...tuple.recipient },
    amount: { ...tuple.amount },
    purpose: tuple.purpose,
    route: {
      legs: tuple.route.legs.map((leg) => ({ ...leg })),
    },
    fees: { ...tuple.fees },
    ...(tuple.fx !== undefined ? { fx: { ...tuple.fx } } : {}),
    expiresAt: tuple.expiresAt,
  };
}

/** host 计算的摘要行（无用户/模型可控内容 —— 纯 tuple 派生）。 */
function computeSummary(tuple: PayswapAuthorizationTuple): string {
  return `Authorize ${tuple.amount.value} ${tuple.amount.currency} to ${tuple.recipient.recipientId} (${tuple.purpose})`;
}

/** 卡 payload 的最小 proposal 面（approval-flow 的记录满足它）。 */
export interface PayswapCardProposalSource {
  proposalId: string;
  tuple: PayswapAuthorizationTuple;
}

/**
 * 单一派生路径：payload **只**从 host 侧 proposal 记录 + 已签发 challenge 构造 ——
 * 不存在任何插件/工具/模型供给的内容位。重建结果与签发时 byte-equal（法则行）。
 */
export function buildPayswapAuthorizationCardPayload(input: {
  proposal: PayswapCardProposalSource;
  challenge: { challengeId: string; secret: string };
}): PayswapAuthorizationCardPayload {
  const { proposal, challenge } = input;
  return {
    kind: "payswap-authorization",
    proposalId: proposal.proposalId,
    summary: computeSummary(proposal.tuple),
    authorization: payswapTupleDisplayProjection(proposal.tuple),
    challenge: { challengeId: challenge.challengeId, secret: challenge.secret },
    options: [
      { optionId: "approve", label: "Approve" },
      { optionId: "deny", label: "Deny" },
    ],
  };
}
