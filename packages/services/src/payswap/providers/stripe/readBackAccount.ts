/**
 * PaySwap P2.2 slice 3 —— 真实 Stripe 读回 adapter（doc 06 §2.9 provider 运行时的
 * Stripe 落地；doc 04 §1.1 事实，检索日期在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现**：`GET https://api.stripe.com/v1/account` + HTTP Bearer 秘密头
 *    （doc 04 §1.1「Auth is HTTP Bearer with the secret/restricted key against
 *    https://api.stripe.com」；test/live 同端点 —— 模式由键前缀区分，无 per-request
 *    模式开关，不发明）。adapter 是唯一知道 provider wire 格式的代码。
 * 2. **结局映射（doc 05 §6.4 读回纪律）**：
 *    - 200 + 非空字符串 `id` → `verified{providerAccountId}`（账户 id 是非秘密
 *      证据摘要，如 `acct_*`）；
 *    - **401 是唯一的 auth-failed 证据**（provider 拒绝凭据 —— 唯一能把连接状态
 *      翻到 `expired` 的证据）；
 *    - 其余一切（非 200/401 状态、非 JSON、缺 id、传输异常、超时）→
 *      `unavailable` —— unknown ≠ expired：读回失败永不假装成功，也永不假装
 *      auth 失败。
 * 3. **装配防线（先于任何网络触达）**：`providerId ≠ "stripe"` /
 *    `secretKind ≠ "api-key"` = 装配错误 → 抛出（accountService 把任何端口异常
 *    映射为 `read_back_unavailable` typed 拒绝，状态不变 —— 安全且响亮）；秘密
 *    前缀推导的模式（shared 法则 `derivePayswapSecretKeyMode`）与记录 `mode`
 *    不一致 = 本地不一致 → `unavailable`，**不触网**（无 provider 证据不翻状态）。
 * 4. **零秘密外泄**：秘密只进 `Authorization` 头；任何 detail/message 操作员可读
 *    且零凭据材料；本模块不日志、不持久化、不投影秘密。
 * 5. **IO 全注入**：transport 经 `ApiClient`（`@zcode/shared` 既有抽象 ——
 *    `timeoutMs` 随 init 传递，超时执行归 transport 实现，与 NodeApiClient 同一
 *    契约）；缺省 = `globalThis.fetch` + AbortController 超时执行（缺省 10 s）。
 *    读回端点 URL 可注入（缺省 = 生产 URL）—— 缺省 transport 的超时行可被真实
 *    HTTP 服务证明，而非 mock 断言。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  derivePayswapSecretKeyMode,
  payswapAccountCapabilityEvidenceSchema,
  PAYSWAP_STRIPE_AUTH_SPEC,
  type PayswapAccountCapabilityEvidence,
  type PayswapAccountReadBackInput,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
} from "@zcode/shared/payswap";

/** 生产读回端点（doc 04 §1.1；test/live 同端点）。 */
const DEFAULT_STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";

/** 缺省读回超时（用户面验证读回 —— 悬挂端点必须被切断，永不无限等待）。 */
const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;

export interface PayswapStripeReadBackDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 读回超时（缺省 10 s；随 init 传递给 transport —— 执行归实现）。 */
  timeoutMs?: number;
  /** 读回端点（缺省 = 生产 URL；缺省 transport 的超时/真连线行可指向本地服务）。 */
  accountUrl?: string;
}

/** 缺省 transport：globalThis.fetch + AbortController 超时执行（ApiClient 契约）。 */
function createDefaultStripeApiClient(defaultTimeoutMs: number): ApiClient {
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
  return `The Stripe account read-back transport failed: ${message}`;
}

/**
 * 创建真实 Stripe 读回端口（`PayswapAccountReadBackPort` 的 Stripe 实现）。
 * 结局映射与装配防线见文件头法则；秘密只经参数入、只进 Authorization 头。
 */
export function createStripeAccountReadBackPort(
  dependencies: PayswapStripeReadBackDependencies = {},
): PayswapAccountReadBackPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS;
  const accountUrl = dependencies.accountUrl ?? DEFAULT_STRIPE_ACCOUNT_URL;
  const apiClient = dependencies.apiClient ?? createDefaultStripeApiClient(timeoutMs);

  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    // 装配防线 1：provider/secretKind 路由错配 = 装配错误（fail-closed 抛出，零网络
    // 触达；accountService 映射 typed 拒绝，状态不变）。
    if (input.providerId !== "stripe") {
      throw new Error(
        `The Stripe read-back adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "api-key") {
      throw new Error(
        `The Stripe read-back adapter received secret kind '${input.secretKind}'; the Stripe contract declares exactly [api-key].`,
      );
    }
    // 装配防线 2：秘密前缀推导的模式与记录 mode 不一致 = 本地不一致（不触网 ——
    // 无 provider 证据不翻状态；操作员 revoke 或重连处置）。
    const derivedMode = derivePayswapSecretKeyMode(input.secret, PAYSWAP_STRIPE_AUTH_SPEC);
    if (derivedMode === null || derivedMode !== input.mode) {
      return {
        kind: "unavailable",
        detail:
          `The stored Stripe key's prefix does not match the connection record's '${input.mode}' mode; ` +
          "revoke and re-connect the account to repair the record.",
      };
    }

    // 读回触达：秘密只进 Authorization 头（doc 04 §1.1 Bearer）。
    let response: Response;
    try {
      response = await apiClient.request(accountUrl, {
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
        detail: "Stripe rejected the credential (HTTP 401). Rotate or re-enter the key, then refresh again.",
      };
    }
    if (response.status !== 200) {
      return {
        kind: "unavailable",
        detail: `Stripe answered HTTP ${response.status} on the account read-back; no account evidence.`,
      };
    }

    // 200：解析账户 id（非秘密证据摘要）。非 JSON / 缺 id / id 非字符串 = 畸形结局
    // —— 无证据，fail-closed unavailable（永不假装成功）。
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "unavailable",
        detail: "The Stripe account read-back returned a malformed (non-JSON) body; no account evidence.",
      };
    }
    const providerAccountId = (body as { id?: unknown } | null)?.id;
    if (typeof providerAccountId !== "string" || providerAccountId.trim().length === 0) {
      return {
        kind: "unavailable",
        detail: "The Stripe account read-back returned no account id; no account evidence.",
      };
    }
    // ADR-P2-1：能力证据捕获（doc 04 §1.2 —— capabilities + requirements 读回是
    // 能力注册表应消费的证据）。strict 全有或全无：任一半畸形 → 省略 evidence
    // （verified 的认证语义不受影响；概览 detail 面对缺席证据 fail-closed 拒绝）。
    const evidence = captureCapabilityEvidence(body);
    return evidence === null
      ? { kind: "verified", providerAccountId }
      : { kind: "verified", providerAccountId, evidence };
  };
}

/**
 * 从 /v1/account 载荷捕获能力证据（doc 04 §1.2）：`capabilities`（name →
 * active/inactive/pending）+ `requirements`（currently_due/past_due 计数摘要 +
 * disabled_reason）。全有或全无：任一半畸形/缺席 → null（调用方省略 evidence）。
 */
function captureCapabilityEvidence(body: unknown): PayswapAccountCapabilityEvidence | null {
  const raw = body as {
    capabilities?: unknown;
    requirements?: { currently_due?: unknown; past_due?: unknown; disabled_reason?: unknown } | null;
  } | null;
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.capabilities !== "object" || raw.capabilities === null) return null;
  const capabilityEntries = Object.entries(raw.capabilities as Record<string, unknown>);
  if (capabilityEntries.length === 0) return null;
  const capabilities: { name: string; status: "active" | "inactive" | "pending" }[] = [];
  for (const [name, status] of capabilityEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof name !== "string" || name.trim().length === 0) return null;
    if (status !== "active" && status !== "inactive" && status !== "pending") return null;
    capabilities.push({ name, status });
  }
  const requirements = raw.requirements;
  if (typeof requirements !== "object" || requirements === null) return null;
  const dueCount = (value: unknown): number | null =>
    Array.isArray(value) ? value.length : null;
  const currentlyDueCount = dueCount(requirements.currently_due);
  const pastDueCount = dueCount(requirements.past_due);
  if (currentlyDueCount === null || pastDueCount === null) return null;
  const disabledReason =
    typeof requirements.disabled_reason === "string" && requirements.disabled_reason.trim().length > 0
      ? requirements.disabled_reason
      : null;
  const evidence = {
    capabilities,
    requirements: { disabledReason, currentlyDueCount, pastDueCount },
  };
  const parsed = payswapAccountCapabilityEvidenceSchema.safeParse(evidence);
  return parsed.success ? parsed.data : null;
}
