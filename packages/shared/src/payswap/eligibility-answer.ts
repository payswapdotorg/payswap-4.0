/**
 * PaySwap P4 —— eligibility answer 法则（shared CONTRACT「P4 确定性 eligibility
 * 引擎」的 answer 半；P4 wave 4 PR(b) 从 services eligibilityEngine.ts **迁住**
 * shared —— wire 形状单一事实源：`check_eligibility` 的业务 data
 * `{kind:"eligibility", answer}` 由 broker 与插件共用，永不漂移。单一实现随迁，
 * services 侧 re-export 保持 wave-2 导出面不变）。
 *
 * 法则不变（normative；违反即实现缺陷）：
 * 1. answer 联合（kind:"answer" | kind:"refused"）—— 求值半仍在 services
 *    eligibilityEngine.ts（本文件只承载形状与拒绝闭集）。
 * 2. 不变量：eligible ⇒ 零 blocker；ineligible ⇒ 至少一个 blocker（unknown ≠
 *    ineligible 法则在 schema 层的投影）。
 * 3. basis 恒为 "evidence"；拒绝闭集四枚。
 */

import { z } from "zod";

export const PAYSWAP_ELIGIBILITY_REFUSAL_CODES = [
  "eligibility_evidence_unavailable",
  "eligibility_evidence_stale",
  "eligibility_constraint_unevidenced",
  "eligibility_live_check_unavailable",
] as const;
export type PayswapEligibilityRefusalCode = (typeof PAYSWAP_ELIGIBILITY_REFUSAL_CODES)[number];

export const payswapEligibilityAnswerSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("answer"),
        eligible: z.boolean(),
        basis: z.literal("evidence"),
        evidenceRef: z
          .object({
            kind: z.literal("capability-record"),
            providerId: z.string().min(1),
            connectionId: z.string().min(1),
            revision: z.number().int().positive(),
            declaredAt: z.string().min(1),
          })
          .strict(),
        checkedAt: z.string().min(1),
        blockers: z
          .array(
            z
              .object({
                kind: z.string().min(1),
                note: z.string().min(1).optional(),
              })
              .strict(),
          ),
      })
      .strict(),
    z
      .object({
        kind: z.literal("refused"),
        refused: z
          .object({
            code: z.enum(PAYSWAP_ELIGIBILITY_REFUSAL_CODES),
            message: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((answer, ctx) => {
    if (answer.kind !== "answer") return;
    // 不变量：eligible ⇒ 零 blocker；ineligible ⇒ 至少一个 blocker（无 vacuous
    // ineligible —— 那是 unknown ≠ ineligible 法则在 schema 层的投影）。
    if (answer.eligible && answer.blockers.length > 0) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "an eligible answer carries zero blockers" });
    }
    if (!answer.eligible && answer.blockers.length === 0) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "an ineligible answer carries at least one blocker" });
    }
  });
export type PayswapEligibilityAnswer = z.infer<typeof payswapEligibilityAnswerSchema>;
