/**
 * PaySwap P3 provider half —— Paystack 读回 adapter（`PayswapAccountReadBackPort`
 * 的 Paystack 实现；PAYSWAP_PAYSTACK_EVIDENCE_PIN 的事实，检索 2026-11-20 在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现**：`GET https://api.paystack.co/balance` + HTTP Bearer 秘密头
 *    （官方：「Fetch the available balance on your integration」；test/live 同
 *    端点 —— 环境由键决定，无 per-request 模式开关，不发明）。adapter 是唯一
 *    知道 provider wire 格式的代码。
 * 2. **结局映射（doc 05 §6.4 读回纪律）**：
 *    - **401 是唯一的 auth-failed 证据**（官方「Unauthenticated requests fail
 *      with the status code 401: Unauthorized」—— provider 拒绝凭据，唯一能把
 *      连接状态翻到 `expired` 的证据）；
 *    - 200 + 官方封套（`status === true` 且 `data` 为数组）= 凭据被 provider
 *      认证 —— 但 `verified` 结局要求的 `providerAccountId` 在 Paystack 官方
 *      API **没有事实来源**（无 merchant/business self-identity 端点，官方
 *      reference 检索 2026-11-20 在案；settlement 派生的身份在测试模式结构性
 *      缺席 —— 官方「settlements aren't processed in test mode」）。缺证据 ≠
 *      捏造：映射为显式 typed `unavailable`（身份缺口 detail 操作员可读）——
 *      状态不变（unknown ≠ expired），绝不伪造身份摘要；
 *    - 其余一切（非 200/401 状态、`status !== true` 封套、非 JSON、`data` 非
 *      数组、传输异常、超时）→ `unavailable` —— 永不假装成功，永不假装 auth
 *      失败。
 * 3. **装配防线（先于任何网络触达）**：
 *    - `providerId ≠ "paystack"` / `secretKind ≠ "api-key"` = 装配错误 → 抛出
 *      （accountService 把端口异常映射为 `read_back_unavailable` typed 拒绝，
 *      状态不变）；
 *    - **ADR-P2-3 custodian 标记凭据 → typed `unavailable`，零网络触达**：
 *      custodian 托管通道是 Stripe 限定的 P2 已验收边界（api.stripe.com +
 *      五路径闭集，`CustodianAllowedPaths`）—— 占位标记凭据若触达 Paystack 端
 *      点，请求会被 custodian 以 Stripe 语义错误路由。Paystack 读回要求可加载
 *      的 provider 凭据；custodian 侧的 Paystack 支持是后续 P3 切片（含
 *      per-provider 托管与出站主机设计），绝不悄悄借 Stripe 托管通道；
 *    - 秘密前缀推导的模式（shared 法则 `derivePayswapSecretKeyMode`）与记录
 *      `mode` 不一致 = 本地不一致 → `unavailable`，不触网。
 * 4. **零秘密外泄**：秘密只进 `Authorization` 头；任何 detail/message 操作员
 *    可读且零凭据材料；本模块不日志、不持久化、不投影秘密。
 * 5. **IO 全注入**：transport 经 `ApiClient`（timeoutMs 随 init 传递）；缺省 =
 *    `globalThis.fetch` + AbortController 超时执行（缺省 10 s）；读回端点 URL
 *    可注入（缺省 = 生产 URL）—— 缺省 transport 的超时/真连线行可被真实本地
 *    HTTP 服务证明。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  derivePayswapSecretKeyMode,
  PAYSWAP_PAYSTACK_AUTH_SPEC,
  type PayswapAccountReadBackInput,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
} from "@zcode/shared/payswap";
import { CUSTODIAN_SECRET_MARKER } from "../../accounts/accountService.js";

/** 生产读回端点（官方 transfer-control 文档；test/live 同端点）。 */
const DEFAULT_PAYSTACK_BALANCE_URL = "https://api.paystack.co/balance";

/** 缺省读回超时（用户面验证读回 —— 悬挂端点必须被切断，永不无限等待）。 */
const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;

export interface PayswapPaystackReadBackDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 读回超时（缺省 10 s；随 init 传递给 transport —— 执行归实现）。 */
  timeoutMs?: number;
  /** 读回端点（缺省 = 生产 URL；缺省 transport 的超时/真连线行可指向本地服务）。 */
  balanceUrl?: string;
}

/** 缺省 transport：globalThis.fetch + AbortController 超时执行（ApiClient 契约）。 */
function createDefaultPaystackApiClient(defaultTimeoutMs: number): ApiClient {
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
  return `The Paystack balance read-back transport failed: ${message}`;
}

/**
 * 创建真实 Paystack 读回端口（`PayswapAccountReadBackPort` 的 Paystack 实现）。
 * 结局映射与装配防线见文件头法则；秘密只经参数入、只进 Authorization 头。
 */
export function createPaystackAccountReadBackPort(
  dependencies: PayswapPaystackReadBackDependencies = {},
): PayswapAccountReadBackPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS;
  const balanceUrl = dependencies.balanceUrl ?? DEFAULT_PAYSTACK_BALANCE_URL;
  const apiClient = dependencies.apiClient ?? createDefaultPaystackApiClient(timeoutMs);

  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    // 装配防线 1：provider/secretKind 路由错配 = 装配错误（fail-closed 抛出，零网络
    // 触达；accountService 映射 typed 拒绝，状态不变）。
    if (input.providerId !== "paystack") {
      throw new Error(
        `The Paystack read-back adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "api-key") {
      throw new Error(
        `The Paystack read-back adapter received secret kind '${input.secretKind}'; the Paystack contract declares exactly [api-key].`,
      );
    }
    // 装配防线 2（ADR-P2-3）：custodian 标记凭据 = Stripe 限定的托管通道 ——
    // Paystack 绝不借道（零网络触达；typed unavailable，状态不变）。
    if (input.secret.includes(CUSTODIAN_SECRET_MARKER)) {
      return {
        kind: "unavailable",
        detail:
          "The Paystack read-back requires a loadable provider credential; the custodian-managed " +
          "credential channel is Stripe-scoped (ADR-P2-3 P2 acceptance) and cannot serve Paystack " +
          "reads. Custodian support for Paystack is a separate tracked P3 slice.",
      };
    }
    // 装配防线 3：秘密前缀推导的模式与记录 mode 不一致 = 本地不一致（不触网 ——
    // 无 provider 证据不翻状态；操作员 revoke 或重连处置）。
    const derivedMode = derivePayswapSecretKeyMode(input.secret, PAYSWAP_PAYSTACK_AUTH_SPEC);
    if (derivedMode === null || derivedMode !== input.mode) {
      return {
        kind: "unavailable",
        detail:
          `The stored Paystack key's prefix does not match the connection record's '${input.mode}' mode; ` +
          "revoke and re-connect the account to repair the record.",
      };
    }

    // 读回触达：秘密只进 Authorization 头（官方 Bearer SECRET_KEY）。
    let response: Response;
    try {
      response = await apiClient.request(balanceUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.secret}` },
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
        detail: "Paystack rejected the credential (HTTP 401). Rotate or re-enter the key, then refresh again.",
      };
    }
    if (response.status !== 200) {
      return {
        kind: "unavailable",
        detail: `Paystack answered HTTP ${response.status} on the balance read-back; no account evidence.`,
      };
    }

    // 200：官方封套（{status: boolean, message, data}）。非 JSON / status 非 true /
    // data 非数组 = 畸形结局 —— 无证据，fail-closed unavailable（永不假装成功）。
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "unavailable",
        detail: "The Paystack balance read-back returned a malformed (non-JSON) body; no account evidence.",
      };
    }
    const envelope = body as { status?: unknown; data?: unknown } | null;
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      envelope.status !== true ||
      !Array.isArray(envelope.data)
    ) {
      return {
        kind: "unavailable",
        detail: "The Paystack balance read-back returned an unexpected envelope; no account evidence.",
      };
    }
    // 官方封套成立 = 凭据被 provider 认证。verified 结局的 providerAccountId 需要
    // 官方身份面 —— Paystack 官方 API 不暴露 merchant/business self-identity
    // （PAYSWAP_PAYSTACK_EVIDENCE_PIN，检索 2026-11-20 在案）。缺证据 ≠ 捏造：
    // 显式 typed unavailable（状态不变 —— unknown ≠ expired；401 的 expiry 证据
    // 不受影响）。官方身份端点发布时按再验证清单映射 verified。
    return {
      kind: "unavailable",
      detail:
        "Paystack authenticated the credential (the balance read-back succeeded), but the verified " +
        "outcome requires an official provider account identity and Paystack's documented API exposes " +
        "no merchant/business self-identity endpoint (official reference checked 2026-11-20). " +
        "The connection stays in its current state; no account evidence is fabricated.",
    };
  };
}
