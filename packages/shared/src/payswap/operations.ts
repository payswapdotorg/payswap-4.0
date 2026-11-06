/**
 * PaySwap 六操作 params schema、§6.1 请求信封 schema 与三码业务拒绝（契约 w2-01
 * §6.1(3)、§6.2、§7.1、§7.3；Step 4 落地本文件）。
 *
 * 纪律（§6.1(3)，normative）：params schema per-op、`.strict()`、住在
 * `packages/shared/src/payswap/` —— 与 Wave 1 工具面（deliverable 05 §9，
 * `payswap-plugin/src/contract.ts` 的 `TOOL_NAMES` + inputSchema）**1:1 结构映射**：
 * 每个工具的 params schema 就是其操作的 params schema（§7.1）。七个操作不存在；
 * `authorizationId` 不是 Wave 1 已知键 —— §7.4 的 dormant grant hook 在 Wave 2 只
 * 存在于 dispatch 层的预留设计里，schema 层按未知键拒绝（绝不到达任何 grant 逻辑）。
 *
 * 三码法则（§7.3）的单一事实源在插件契约（`PayswapRefusalCode`）；本文件给出
 * **broker 侧**的业务拒绝 data（§6.2：业务拒绝骑在 `data` 里，与桥接错误
 * （§6.3）永不混淆）。插件侧 Wave 1 快照拒绝（`snapshotRefusal`）与其消息同文 ——
 * bootstrap 不能 import 插件包（方向相反），单一事实源注释在此（与 Step 3 的
 * not_connected 临时回答同一条纪律）。
 */

import { z } from "zod";
import type { PayswapBrokerOp } from "./envelope.js";
import { PAYSWAP_BROKER_OPS } from "./envelope.js";
import { PAYSWAP_RETIRED_SEQS_MAX } from "./replay.js";

// ---------------------------------------------------------------------------
// per-op params schema（§6.1(3)/§7.1 —— Wave 1 工具面 1:1）
// ---------------------------------------------------------------------------

const compileIntentParams = z
  .object({
    description: z.string().min(1),
    amount: z.string().optional(),
    currency: z.string().optional(),
    recipient: z.string().optional(),
    reference: z.string().optional(),
  })
  .strict();

const intentIdParams = z
  .object({
    intentId: z.string().min(1),
  })
  .strict();

const executionStatusParams = z
  .object({
    executionId: z.string().min(1).optional(),
    intentId: z.string().min(1).optional(),
  })
  .strict();

const accountOverviewParams = z
  .object({
    connectionId: z.string().min(1).optional(),
  })
  .strict();

/** 闭集 dispatch 表的 per-op params（§7.1 的六个操作，无第七个）。 */
export const PAYSWAP_OPERATION_PARAMS_SCHEMAS: Readonly<
  Record<PayswapBrokerOp, z.ZodType>
> = {
  compile_intent: compileIntentParams,
  check_eligibility: intentIdParams,
  discover_routes: intentIdParams,
  request_authorization: intentIdParams,
  get_execution_status: executionStatusParams,
  get_account_overview: accountOverviewParams,
};

// ---------------------------------------------------------------------------
// §6.1 请求信封 schema（`.strict()` —— 未知键拒绝；shipped trace triple）
// ---------------------------------------------------------------------------

const traceSchema = z
  .object({
    traceId: z.string().trim().min(1),
    spanId: z.string().trim().min(1).optional(),
    parentSpanId: z.string().trim().min(1).optional(),
  })
  .strict();

/** §6.1 请求 schema：host 解析（§5.5 步 (2)），child 构造 —— 共享单一实现（§6.4(5)）。 */
export const payswapBrokerRequestSchema = z
  .object({
    instanceId: z.string().uuid(),
    seq: z.number().int().positive(),
    op: z.enum(PAYSWAP_BROKER_OPS),
    params: z.record(z.string(), z.unknown()),
    token: z.string().length(64),
    sessionId: z.string().trim().min(1),
    // §6.1(4)/§9.3(6)：有界传输簿记 —— 形状违例（>8 条、非正/非整数元素）在此即拒
    // （request_invalid，pre-binding）；语义错报（非严格递增/≥载体 seq）由引擎容忍。
    retiredSeqs: z.array(z.number().int().positive()).max(PAYSWAP_RETIRED_SEQS_MAX).optional(),
    trace: traceSchema.optional(),
  })
  .strict();

/** 解析后的请求类型（schema 输出）。 */
export type PayswapBrokerRequest = z.infer<typeof payswapBrokerRequestSchema>;

// ---------------------------------------------------------------------------
// §7.3 三码业务拒绝（broker 侧 data；§6.2：骑在 data 里，永不与桥接错误混淆）
// ---------------------------------------------------------------------------

/** 业务拒绝 data（`{kind:"refused", refusal:{code,message}}`，merged PR #3 的信封形状）。 */
export interface PayswapBusinessRefusalData {
  kind: "refused";
  refusal: {
    code: "not_opted_in" | "not_connected" | "financial_mode_disabled";
    message: string;
  };
}

/**
 * 三码法则的 broker 侧单一实现（§7.3）：插件禁用/卸载（残留调用）→
 * financial_mode_disabled；enabled + 未 opt-in（S1）→ not_opted_in；enabled +
 * opted-in + 无账户（S2）→ not_connected（§13：本 wave 无账户数据）。
 */
export function payswapBusinessRefusal(
  code: "not_opted_in" | "not_connected" | "financial_mode_disabled",
): PayswapBusinessRefusalData {
  return {
    kind: "refused",
    refusal: {
      code,
      message: PAYSWAP_REFUSAL_MESSAGES[code],
    },
  };
}

/** 与 payswap-plugin/src/contract.ts 的 snapshotRefusal 同文（单一事实源注释；见文件头）。 */
const PAYSWAP_REFUSAL_MESSAGES = {
  not_opted_in:
    "PaySwap financial workspace is not enabled. Turn on the 'Financial workspace' " +
    "option in the PaySwap plugin settings, then try again.",
  not_connected:
    "PaySwap financial workspace is enabled, but no account is connected yet. " +
    "Connect a provider account before using financial tools.",
  financial_mode_disabled:
    "PaySwap financial mode is disabled (the plugin was disabled or uninstalled). " +
    "Calls from this session are refused; re-enable the plugin and start a new " +
    "session to continue.",
} as const;
