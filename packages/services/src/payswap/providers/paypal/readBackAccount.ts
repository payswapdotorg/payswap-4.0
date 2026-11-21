/**
 * PaySwap P3 provider half —— PayPal 读回 adapter（`PayswapAccountReadBackPort`
 * 的 PayPal 实现；PAYSWAP_PAYPAL_EVIDENCE_PIN 的事实，检索 2026-11-20 在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现（token 交换即凭据证明）**：`POST {apiBaseUrl[mode]}/v1/oauth2/token`
 *    + HTTP Basic（`client_id:client_secret` 的 Base64）+ form body
 *    `grant_type=client_credentials`（官方 authentication 文档）。读回不发明
 *    数据面 —— 官方 identity/userinfo 面对 client_credentials 的可达性未证实，
 *    不采用。
 * 2. **结局映射（doc 05 §6.4 读回纪律）**：
 *    - 200 + 官方 token 形状（非空字符串 `access_token` 且非空字符串 `app_id`）
 *      → `verified{providerAccountId: app_id}` —— app_id 是官方记载的非秘密
 *      app 标识（token 响应字段之一），PayPal 的官方身份面（与 Paystack 的
 *      结构性身份缺口相反）；
 *    - **401 是唯一的 auth-failed 证据**（client credentials 被 provider 拒绝
 *      —— 唯一能把连接状态翻到 `expired` 的证据）；
 *    - 其余一切（非 200/401 状态、非 JSON、access_token/app_id 缺失或非字符串、
 *      传输异常、超时）→ `unavailable` —— 永不假装成功，永不假装 auth 失败。
 *    - access_token 是短期凭据 —— 本端口**绝不持久化/缓存/投影它**（读回证据
 *      只有 providerAccountId；token 随本端口作用域消亡）。
 * 3. **装配防线（先于任何网络触达）**：
 *    - `providerId ≠ "paypal"` / `secretKind ≠ "client-secret"` = 装配错误 →
 *      抛出（accountService 映射 typed `read_back_unavailable`，状态不变）；
 *    - `clientId` 缺席 = 记录/装配不一致（client-credentials 读回需要凭据对
 *      的另一半）→ `unavailable`，零触达；
 *    - **ADR-P2-3 custodian 标记凭据 → typed `unavailable`，零网络触达**
 *      （托管通道是 Stripe 限定的 P2 已验收边界；PayPal 绝不借道）。
 * 4. **零秘密外泄**：client id/secret 只进 Basic Authorization 头；任何
 *    detail/message 操作员可读且零凭据材料；本模块不日志、不持久化、不投影
 *    秘密（Base64 编码只发生在请求头构造内）。
 * 5. **IO 全注入**：transport 经 `ApiClient`（timeoutMs 随 init 传递）；缺省 =
 *    `globalThis.fetch` + AbortController 超时执行（缺省 10 s）；token 端点
 *    URL 可注入（缺省 = 按 mode 取官方 pin 的 base + tokenPath）—— 缺省
 *    transport 的超时/真连线行可被真实本地 HTTP 服务证明。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_PAYPAL_AUTH_SPEC,
  type PayswapAccountReadBackInput,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
} from "@zcode/shared/payswap";
import { CUSTODIAN_SECRET_MARKER } from "../../accounts/accountService.js";

/**
 * v1.2 托管 token 交换端口（runtime 从 custodian 桥注入）：URL 由 mode 决定
 * （官方 pin 的 token 端点），Basic 凭据由托管按双槽现读，应答 {status, body}。
 */
export interface PayswapPaypalCustodianTokenPost {
  (params: {
    readonly mode: "test" | "live";
    readonly clientSlot: string;
    readonly secretSlot: string;
  }): Promise<{ status: number; body: string }>;
}

/** custodian 标记里的槽名（"…custodian-managed:<存储键>" 后缀；缺省 = 旧版单槽）。 */
function slotFromMarker(value: string): string {
  const markerIndex = value.indexOf(CUSTODIAN_SECRET_MARKER);
  return value.slice(markerIndex + CUSTODIAN_SECRET_MARKER.length).replace(/^:/, "");
}

/** token 交换应答 → 读回结局（401 = 唯一 auth-failed；verified 需 access_token + app_id）。 */
function mapTokenExchangeReply(reply: { status: number; body: string }): PayswapAccountReadBackOutcome {
  if (reply.status === 401) {
    return {
      kind: "auth-failed",
      detail:
        "PayPal rejected the client credentials (HTTP 401). Rotate or re-enter the key, then refresh again.",
    };
  }
  if (reply.status !== 200) {
    return {
      kind: "unavailable",
      detail: `PayPal answered HTTP ${reply.status} on the credential read-back; no account evidence.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return {
      kind: "unavailable",
      detail: "The PayPal credential read-back returned a malformed (non-JSON) body; no account evidence.",
    };
  }
  const token = (parsed as { access_token?: unknown } | null)?.access_token;
  const appId = (parsed as { app_id?: unknown } | null)?.app_id;
  if (typeof token !== "string" || token.trim().length === 0 || typeof appId !== "string" || appId.trim().length === 0) {
    return {
      kind: "unavailable",
      detail: "The PayPal credential read-back returned no access token or app identity; no account evidence.",
    };
  }
  return { kind: "verified", providerAccountId: appId };
}

/** 缺省读回超时（用户面验证读回 —— 悬挂端点必须被切断，永不无限等待）。 */
const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;

export interface PayswapPaypalReadBackDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** v1.2 托管 token 交换端口（runtime 从 custodian 桥注入；缺席 = 托管凭据
   *  typed unavailable 零触达 —— 单测注入面 preserved）。 */
  custodianTokenPost?: PayswapPaypalCustodianTokenPost;
  /** 读回超时（缺省 10 s；随 init 传递给 transport —— 执行归实现）。 */
  timeoutMs?: number;
  /** token 端点覆盖（缺省 = 官方 pin 的 base[mode] + tokenPath；测试注入本地服务）。 */
  tokenUrl?: string;
}

/** 缺省 transport：globalThis.fetch + AbortController 超时执行（ApiClient 契约）。 */
function createDefaultPaypalApiClient(defaultTimeoutMs: number): ApiClient {
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

function transportFailureDetail(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `The PayPal credential read-back transport failed: ${message}`;
}

/** 官方 pin 的端点面（test = sandbox 官方示例 base；live = 官方 scope-string host）。 */
function tokenEndpointForMode(mode: "test" | "live"): string {
  return PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.apiBaseUrl[mode] + PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.tokenPath;
}

/**
 * 创建真实 PayPal 读回端口（`PayswapAccountReadBackPort` 的 PayPal 实现）。
 * 结局映射与装配防线见文件头法则；凭据对只进 Basic 头，access_token 永不出端口。
 */
export function createPaypalAccountReadBackPort(
  dependencies: PayswapPaypalReadBackDependencies = {},
): PayswapAccountReadBackPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS;
  const custodianTokenPost = dependencies.custodianTokenPost;
  const apiClient = dependencies.apiClient ?? createDefaultPaypalApiClient(timeoutMs);

  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    // 装配防线 1：provider/secretKind 路由错配 = 装配错误（fail-closed 抛出，零
    // 网络触达；accountService 映射 typed 拒绝，状态不变）。
    if (input.providerId !== "paypal") {
      throw new Error(
        `The PayPal read-back adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "client-secret") {
      throw new Error(
        `The PayPal read-back adapter received secret kind '${input.secretKind}'; the PayPal contract's primary secret is exactly [client-secret].`,
      );
    }
    // v1.2 装配防线 2（ADR-P2-3 托管凭据）：凭据对是 custodian 标记 = 走注入的
    // token 交换代理（服务端按双槽补 Basic 凭据；URL 闭集服务端强制）。代理缺席
    // （纯单测注入面）或只有一半标记 = typed unavailable，零网络触达。
    const secretIsMarker = input.secret.includes(CUSTODIAN_SECRET_MARKER);
    const clientIdIsMarker =
      input.clientId !== undefined && input.clientId.includes(CUSTODIAN_SECRET_MARKER);
    if (secretIsMarker || clientIdIsMarker) {
      if (!custodianTokenPost || !secretIsMarker || !clientIdIsMarker) {
        return {
          kind: "unavailable",
          detail:
            "The PayPal read-back under credential custody requires the custodian token-exchange " +
            "proxy and both credential slots; the proxy is absent or the pair is incomplete " +
            "(no wire touch; state unchanged).",
        };
      }
      return custodianTokenPost({
        mode: input.mode,
        clientSlot: slotFromMarker(input.clientId),
        secretSlot: slotFromMarker(input.secret),
      }).then((reply) => mapTokenExchangeReply(reply));
    }
    // 装配防线 3：client-credentials 读回需要凭据对的另一半 —— clientId 缺席 =
    // 记录/装配不一致（不触网 —— 无 provider 证据不翻状态）。
    const clientId = input.clientId?.trim() ?? "";
    if (clientId.length === 0) {
      return {
        kind: "unavailable",
        detail:
          "The stored PayPal connection is missing its client id; revoke and re-connect the account " +
          "to repair the record.",
      };
    }

    // 读回触达：凭据对只进 Basic 头（官方 CLIENT_ID:CLIENT_SECRET Base64）；
    // body = grant_type=client_credentials（官方 form 参数）。
    const basic = Buffer.from(`${clientId}:${input.secret}`, "utf8").toString("base64");
    let response: Response;
    try {
      response = await apiClient.request(dependencies.tokenUrl ?? tokenEndpointForMode(input.mode), {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        timeoutMs,
      });
    } catch (error) {
      // 传输异常/超时 = unknown ≠ expired（doc 05 §6.4）。
      return { kind: "unavailable", detail: transportFailureDetail(error) };
    }

    if (response.status === 401) {
      // 401 = provider 拒绝凭据 —— 唯一的 auth-failed 证据。detail 操作员可读、零秘密。
      return {
        kind: "auth-failed",
        detail:
          "PayPal rejected the client credentials (HTTP 401). Rotate or re-enter the credential pair, then refresh again.",
      };
    }
    if (response.status !== 200) {
      return {
        kind: "unavailable",
        detail: `PayPal answered HTTP ${response.status} on the credential read-back; no account evidence.`,
      };
    }

    // 200：官方 token 形状（{scope, access_token, token_type, app_id, expires_in, nonce}）。
    // 非 JSON / access_token 或 app_id 缺失非字符串 = 畸形结局 —— 无证据，
    // fail-closed unavailable（永不假装成功）。
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "unavailable",
        detail: "The PayPal credential read-back returned a malformed (non-JSON) body; no account evidence.",
      };
    }
    const token = (body as { access_token?: unknown } | null)?.access_token;
    const appId = (body as { app_id?: unknown } | null)?.app_id;
    if (typeof token !== "string" || token.trim().length === 0 || typeof appId !== "string" || appId.trim().length === 0) {
      return {
        kind: "unavailable",
        detail: "The PayPal credential read-back returned no access token or app identity; no account evidence.",
      };
    }
    // 官方身份面：app_id 是 PayPal 官方记载的非秘密 app 标识 —— verified 的
    // providerAccountId 有官方来源（access_token 绝不离开本端口 —— 只作认证
    // 证据，不持久化、不投影）。
    return { kind: "verified", providerAccountId: appId };
  };
}
