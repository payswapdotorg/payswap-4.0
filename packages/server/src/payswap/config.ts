/**
 * PaySwap server financial 激活法则（addendum §1.6.2 item 5(a)/§1.6.3 item 7；
 * N27 —— fail-closed 激活）。
 *
 * 法则（normative）：financial 模式是**显式请求**（`ZCODE_PAYSWAP_FINANCIAL_MODE=1`，
 * 部署级 opt-in）；请求 financial 而未配置 deployment 凭据（ZCODE_SERVER_AUTH_TOKEN）
 * → 激活拒绝（typed refusal）—— financial 服务绝不以弱姿态启动。
 * 未请求 → inactive（上游行为原样，S-保真）。
 */

export const PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE = "financial_mode_deployment_auth_required";

/** 部署级 financial opt-in 环境变量（值 "1" 请求激活）。 */
export const PAYSWAP_FINANCIAL_MODE_ENV_KEY = "ZCODE_PAYSWAP_FINANCIAL_MODE";

export type PayswapFinancialActivation =
  | { status: "activated" }
  | { status: "inactive" }
  | { status: "refused"; code: typeof PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE };

/**
 * N27 激活法则（纯）：requested ∧ 无有效 deployment token → refused；
 * requested ∧ 有 token → activated；¬requested → inactive（上游路径不动）。
 */
export function resolvePayswapFinancialActivation(input: {
  requested: boolean;
  deploymentAuthToken?: string;
}): PayswapFinancialActivation {
  if (!input.requested) return { status: "inactive" };
  const token = input.deploymentAuthToken?.trim();
  if (!token) {
    return { status: "refused", code: PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE };
  }
  return { status: "activated" };
}

/** 读取部署级 financial opt-in（env 显式 "1"）。 */
export function readPayswapFinancialModeRequested(env: NodeJS.ProcessEnv): boolean {
  return env[PAYSWAP_FINANCIAL_MODE_ENV_KEY]?.trim() === "1";
}
