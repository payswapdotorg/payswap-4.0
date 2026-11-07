/**
 * PaySwap 两级升级握手法则（addendum §1.6.3 item 7 —— R1 的传输法则）。
 *
 * 法则（normative）：
 * - 顺序：level-1（deployment token）先验证；失败 → `deployment_unauthorized`，
 *   且 **operator 凭据不被读取**（惰性 getter —— 顺序法则由"不调用"证明）。
 * - level-2 恰好两种传输（native header `X-PaySwap-Operator-Token` / 浏览器短期
 *   HttpOnly cookie）；不呈现 operator 凭据 = 普通未绑定客户端（`unauthenticated`，
 *   可升级但无 financial principal —— N28 的 session 级臂）。
 * - 泛化失败（N40）：呈现了 operator 凭据但无效（unknown/revoked/rotated_out/
 *   过期 session cookie）→ 单一 generic `operator_authentication_failed`，
 *   对调用方完全不可区分（防 token 枚举）。
 * - 认证成功 → 绑定 (deployment, principal, roles, session expiry)；本法则返回
 *   stable principal（operatorId）与 session（header 路径新铸，cookie 路径复用）。
 * - N32：client-supplied operator id 永不是身份 —— `evaluatePayswapPrincipalClaim`
 *   只允许"不声明/声明自己"，声明他人 principal 拒绝请求。
 */

import type {
  PayswapOperatorRegistry,
} from "./operator-registry.js";

/** 单一 generic level-2 失败码（unknown/expired/rotated-out/revoked 不可区分）。 */
export const PAYSWAP_OPERATOR_AUTH_FAILED_CODE = "operator_authentication_failed";

/** N32：payload 声明他人 principal 的拒绝码。 */
export const PAYSWAP_FOREIGN_PRINCIPAL_CLAIM_CODE = "foreign_principal_claim";

/** native operator client 的升级头。 */
export const PAYSWAP_OPERATOR_TOKEN_HEADER = "x-payswap-operator-token";

/** 升级/交换请求上 client-supplied operator id 声明字段（永不作为身份）。 */
export const PAYSWAP_OPERATOR_ID_CLAIM_HEADER = "x-payswap-operator-id";

/** 浏览器路径的 operator-session cookie 名（HttpOnly + SameSite=Strict + Path=/ws）。 */
export const PAYSWAP_OPERATOR_SESSION_COOKIE_NAME = "payswap_operator_session";

export type PayswapUpgradeCredentialSource =
  | { kind: "operator_token"; token: string }
  | { kind: "session_cookie"; sessionId: string };

export interface PayswapOperatorUpgradeInput {
  /** level-1（deployment 中间件）的裁决 —— 法则只消费，不复算。 */
  level1Authorized: boolean;
  /**
   * 惰性读取 operator 凭据 —— **level-1 失败时不得被调用**（顺序法则的证明通道：
   * 传入会在被读时抛错的 getter）。
   */
  readOperatorCredential: () => PayswapUpgradeCredentialSource | undefined;
  registry: Pick<PayswapOperatorRegistry, "mintSessionForCredential" | "verifySession">;
}

export type PayswapOperatorUpgradeVerdict =
  | { status: "deployment_unauthorized" }
  | { status: "unauthenticated" }
  | { status: "operator_authentication_failed" }
  | { status: "authenticated"; operatorId: string; sessionId: string };

/**
 * 两级升级法则（纯）。header 路径验证凭据后**新铸** session；cookie 路径验证
 * 既有 session（live 即绑定其 principal —— session 即身份载体）。
 */
export function evaluatePayswapOperatorUpgrade(
  input: PayswapOperatorUpgradeInput,
): PayswapOperatorUpgradeVerdict {
  // 顺序法则：level-1 失败短路，operator 凭据不被读取。
  if (!input.level1Authorized) {
    return { status: "deployment_unauthorized" };
  }
  const source = input.readOperatorCredential();
  if (source === undefined) {
    return { status: "unauthenticated" };
  }
  if (source.kind === "operator_token") {
    const minted = input.registry.mintSessionForCredential(source.token);
    if (minted === null) {
      return { status: "operator_authentication_failed" };
    }
    return { status: "authenticated", operatorId: minted.operatorId, sessionId: minted.sessionId };
  }
  const verdict = input.registry.verifySession(source.sessionId);
  if (verdict.status !== "live") {
    return { status: "operator_authentication_failed" };
  }
  return {
    status: "authenticated",
    operatorId: verdict.operatorId,
    sessionId: source.sessionId,
  };
}

/**
 * N32 法则（纯）：claimed 不声明/声明自己 → ok（字段被忽略，身份仍由凭据解析）；
 * 声明**其它** principal → foreign_principal_claim（请求拒绝）。payload 到 principal
 * 不存在任何代码路径。
 */
export function evaluatePayswapPrincipalClaim(
  authenticatedOperatorId: string,
  claimedOperatorId: string | undefined,
): { status: "ok" } | { status: "foreign_principal_claim" } {
  if (claimedOperatorId === undefined || claimedOperatorId === authenticatedOperatorId) {
    return { status: "ok" };
  }
  return { status: "foreign_principal_claim" };
}
