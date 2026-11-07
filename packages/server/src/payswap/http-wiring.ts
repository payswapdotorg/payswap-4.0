/**
 * PaySwap operator 认证的 HTTP/WS 接线（addendum §1.6.3 item 7 —— 两级握手的
 * server 落点；ADR-11）。
 *
 * 装配面（financial 部署专用；非 financial 路径一行不动 —— S-保真）：
 * - `app.use("/ws", …)`：level-2 守卫 —— level-1（全局中间件）通过后运行；
 *   呈现但无效的 operator 凭据 → 401 单一 generic `operator_authentication_failed`；
 *   N32 声明他人 principal → 401 `foreign_principal_claim`；认证成功 → 绑定
 *   （WeakMap 以 Request 为键，升级工厂在 onOpen 处取回）。
 * - `POST /api/payswap/operator-session`：浏览器路径的 operator-session cookie
 *   铸造端点（level-1 = lite cookie；level-2 = Authorization Bearer operator 凭据）。
 * - `bindUpgradedConnection(request, socket)`：升级成功后由 /ws 路由 onOpen 调用，
 *   把连接登记进 store（撤销/过窗收尾时 server 侧关闭）。
 */

import type { Hono, Context } from "hono";
import {
  evaluatePayswapPrincipalClaim,
  PAYSWAP_FOREIGN_PRINCIPAL_CLAIM_CODE,
  PAYSWAP_OPERATOR_AUTH_FAILED_CODE,
  PAYSWAP_OPERATOR_ID_CLAIM_HEADER,
  PAYSWAP_OPERATOR_TOKEN_HEADER,
} from "@zcode/shared/payswap";
import type { PayswapClosableSocket, PayswapOperatorStore } from "./operator-store.js";

export interface PayswapOperatorAuthWiring {
  /** /ws 升级成功后绑定连接（由路由 onOpen 调用；未认证连接为 no-op）。 */
  bindUpgradedConnection(request: Request, socket: PayswapClosableSocket): void;
}

/** 从请求头/cookie 提取 N32 声明字段（operatorId / principal / onBehalfOf）。 */
async function readClaimedOperatorId(c: Context): Promise<string | undefined> {
  const headerClaim = c.req.header(PAYSWAP_OPERATOR_ID_CLAIM_HEADER);
  if (headerClaim !== undefined) return headerClaim;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      operatorId?: unknown;
      principal?: unknown;
      onBehalfOf?: unknown;
    };
    for (const value of [body.operatorId, body.principal, body.onBehalfOf]) {
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // 无 body / 非 JSON —— 声明字段缺省。
  }
  return undefined;
}

export function installPayswapOperatorAuth(
  app: Hono,
  store: PayswapOperatorStore,
): PayswapOperatorAuthWiring {
  /** Request → 认证绑定（守卫写入；升级工厂在 onOpen 读取 —— 同一 Request 实例）。 */
  const upgradeBindings = new WeakMap<Request, { sessionId: string }>();

  app.use("/ws", async (c, next) => {
    const verdict = store.upgradeAuth({
      operatorToken: c.req.header(PAYSWAP_OPERATOR_TOKEN_HEADER),
      cookieHeader: c.req.header("cookie"),
    });
    if (verdict.status === "operator_authentication_failed") {
      return c.json({ error: PAYSWAP_OPERATOR_AUTH_FAILED_CODE }, 401);
    }
    if (verdict.status === "authenticated") {
      const claimed = await readClaimedOperatorId(c);
      const claim = evaluatePayswapPrincipalClaim(verdict.operatorId, claimed);
      if (claim.status === "foreign_principal_claim") {
        return c.json({ error: PAYSWAP_FOREIGN_PRINCIPAL_CLAIM_CODE }, 401);
      }
      upgradeBindings.set(c.req.raw, { sessionId: verdict.sessionId });
    }
    await next();
  });

  app.post("/api/payswap/operator-session", async (c) => {
    const authorization = c.req.header("authorization");
    const operatorToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    const claimed = await readClaimedOperatorId(c);
    // 先验凭据（不铸 session），再验声明，最后铸造 —— 拒绝路径零状态污染。
    const credentialVerdict = operatorToken
      ? store.verifyCredential(operatorToken)
      : undefined;
    if (!credentialVerdict || credentialVerdict.status !== "valid") {
      return c.json({ error: PAYSWAP_OPERATOR_AUTH_FAILED_CODE }, 401);
    }
    const claim = evaluatePayswapPrincipalClaim(credentialVerdict.operatorId, claimed);
    if (claim.status === "foreign_principal_claim") {
      return c.json({ error: PAYSWAP_FOREIGN_PRINCIPAL_CLAIM_CODE }, 401);
    }
    const minted = store.mintOperatorSessionCookie(operatorToken!);
    if (minted === null) {
      return c.json({ error: PAYSWAP_OPERATOR_AUTH_FAILED_CODE }, 401);
    }
    c.header("Set-Cookie", minted.setCookie);
    return c.json({ ok: true }, 200);
  });

  return {
    bindUpgradedConnection(request, socket) {
      const binding = upgradeBindings.get(request);
      if (binding) {
        store.bindConnection(binding.sessionId, socket);
      }
    },
  };
}
