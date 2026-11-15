/**
 * PaySwap P3 —— PayPal OAuth2 client-credentials token mint 共享步（两个 PayPal
 * adapter 的公共半；事实清单 `docs/payswap/provider-facts/paypal.md` P-1..P-4 +
 * 第三批检索 2026-11-15）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **mint 形态**（P-1）：`POST {base}/v1/oauth2/token`，HTTP Basic
 *    （`CLIENT_ID:CLIENT_SECRET` base64）+ `grant_type=client_credentials`
 *    （application/x-www-form-urlencoded）；base URL 由模式解析（P-3）。
 * 2. **结局闭集**：`ok{accessToken}`（200 + 非空 access_token —— token 只在
 *    调用方本次调用内存中存在，本模块不缓存不持久化不日志）/
 *    `auth-failed`（**401 —— P-4 实测包络，唯一凭据拒绝证据**）/
 *    `unavailable`（其余一切：非 200/401、非 JSON、缺 token、传输异常、超时）。
 * 3. **零秘密外泄**：secret 只进 Basic 头；detail 操作员可读且零凭据材料。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_PAYPAL_AUTH_SPEC,
  resolvePayswapClientCredentialsBaseUrl,
} from "@zcode/shared/payswap";

export interface PayswapPayPalTokenMintDependencies {
  apiClient: ApiClient;
  timeoutMs: number;
  /** 基 URL 覆盖（缺省 = 规格 per-mode base URL，P-3）。 */
  apiBaseOverride?: string;
}

export type PayswapPayPalTokenMintResult =
  | { readonly kind: "ok"; readonly accessToken: string; readonly body: unknown }
  | { readonly kind: "auth-failed"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** 缺省 transport：globalThis.fetch + AbortController 超时执行（ApiClient 契约）。 */
export function createDefaultPayPalApiClient(defaultTimeoutMs: number): ApiClient {
  return {
    async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
      const controller = new AbortController();
      const timeoutMs = init?.timeoutMs && init.timeoutMs > 0 ? init.timeoutMs : defaultTimeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { timeoutMs: _omit, signal: _outerSignal, ...requestInit } = init ?? {};
        return await fetch(input, { ...requestInit, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 铸造 client-credentials access token（P-1/P-3/P-4）。秘密只经参数入、只进
 * Basic 头；access_token 只经返回值出 —— 调用方在本次调用内用毕即弃。
 */
export async function mintPayPalAccessToken(
  input: {
    readonly mode: "test" | "live";
    readonly clientId: string;
    readonly clientSecret: string;
  },
  dependencies: PayswapPayPalTokenMintDependencies,
): Promise<PayswapPayPalTokenMintResult> {
  const baseUrl =
    dependencies.apiBaseOverride ??
    resolvePayswapClientCredentialsBaseUrl(PAYSWAP_PAYPAL_AUTH_SPEC, input.mode);
  const tokenUrl = `${baseUrl}${PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.tokenPath}`;
  const basicCredential = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString(
    "base64",
  );
  let response: Response;
  try {
    response = await dependencies.apiClient.request(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredential}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      timeoutMs: dependencies.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      kind: "unavailable",
      detail: `The PayPal token mint transport failed: ${message}`,
    };
  }
  if (response.status === 401) {
    // 401 = provider 拒绝凭据（P-4 实测包络）—— 唯一的凭据拒绝证据。
    return {
      kind: "auth-failed",
      detail:
        "PayPal rejected the client credentials (HTTP 401 on the token endpoint). " +
        "Check that the client ID/secret belong to the declared environment.",
    };
  }
  if (response.status !== 200) {
    return {
      kind: "unavailable",
      detail: `PayPal answered HTTP ${response.status} on the token endpoint; no token evidence.`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "unavailable",
      detail: "The PayPal token endpoint returned a malformed (non-JSON) body; no token evidence.",
    };
  }
  const accessToken = (body as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return {
      kind: "unavailable",
      detail: "The PayPal token endpoint returned no access token; no token evidence.",
    };
  }
  // body 随 ok 一并返回：读回半消费 app_id/scope 证据字段（P-2/样例）；
  // 数据读半忽略它。wire 面单一事实源在本模块（法则 1）。
  return { kind: "ok", accessToken, body };
}
