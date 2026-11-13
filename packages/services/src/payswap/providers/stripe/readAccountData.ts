/**
 * PaySwap P2.2（ADR-P2-1）—— Stripe 只读数据 adapter（doc 06 §2.9 provider 运行时；
 * 事实清单 `docs/payswap/provider-facts/stripe-readonly-endpoints.md`，检索日期在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现**：`PayswapAccountDataReadPort` 的 Stripe 落地 —— 每次调用读**一个**
 *    闭集类别（ADR-P2-1）：`balance → GET /v1/balance`、`payment_objects →
 *    GET /v1/charges?limit=10`、`customers → GET /v1/customers?limit=10`、
 *    `disputes → GET /v1/disputes?limit=10`。全部 GET（no-write 的 wire 证明），
 *    全部 HTTP Bearer（doc 04 §1.1），全部固定近因窗口（limit=10 —— P2 无任意
 *    分页面；参数面保持闭集）。
 * 2. **结局映射（doc 05 §6.4 + §6.6 + ADR-P2-1）**：
 *    - 200 → strict redacted 解析 → `ok`（解析失败 = 畸形 → `unavailable`，
 *      永不假装成功）；
 *    - **401 → `auth-failed`**（唯一 provider 拒绝证据；401 后的类别不再读 ——
 *      下一次验证读（refreshEvidence / getOverviewData 的状态机半）处置状态）；
 *    - **403 → `refused{insufficient_permission}`**（restricted key 的 per-resource
 *      读权限边界 —— doc 04 §1.3「Restricted keys: per-resource permissions」；
 *      typed 拒绝，携带证据语义而非猜测）；
 *    - 其余一切（404/429/5xx、非 JSON、传输异常、超时）→ `unavailable`
 *      （unknown ≠ failed）。
 * 3. **redaction-by-construction**：只拷贝白名单字段（类别 schema 的字段集）——
 *    客户行只保留 id/created/description（email/name 等 PII 永不进数据面），
 *    争议/支付行不含 evidence URL/受款人明细，余额行只保留 amount/currency。
 *    provider 原始载荷在 strict 解析后即丢弃。
 * 4. **装配防线（先于任何网络触达）**：`providerId ≠ "stripe"` / `secretKind ≠
 *    "api-key"` / 未知类别 = 装配错误 → 抛出（服务侧映射 typed 拒绝）；秘密前缀
 *    推导的模式与记录 `mode` 不一致 = 本地不一致 → `unavailable`，**不触网**。
 * 5. **零秘密外泄**：秘密只进 `Authorization` 头；detail/message 操作员可读且零
 *    凭据材料；本模块不日志、不持久化、不投影秘密。
 * 6. **IO 全注入**：transport 经 `ApiClient`（`@zcode/shared`）；缺省 =
 *    `globalThis.fetch` + AbortController 超时执行（缺省 10 s）；端点基 URL 可注入。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  derivePayswapSecretKeyMode,
  payswapBalanceDataSchema,
  payswapCustomerSchema,
  payswapDisputeSchema,
  payswapPaymentObjectSchema,
  PAYSWAP_STRIPE_AUTH_SPEC,
  payswapReadonlyCategoryResultSchemas,
  type PayswapAccountDataReadInput,
  type PayswapAccountDataReadPort,
  type PayswapBalanceData,
  type PayswapCustomer,
  type PayswapDispute,
  type PayswapPaymentObject,
  type PayswapReadonlyCategory,
  type PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";

/** 生产 API 基 URL（doc 04 §1.1；test/live 同基 —— 模式由键前缀区分）。 */
const DEFAULT_STRIPE_API_BASE = "https://api.stripe.com";

/** 缺省数据读超时（与读回半同款：悬挂端点必须被切断）。 */
const DEFAULT_DATA_READ_TIMEOUT_MS = 10_000;

/** 近因窗口（对话面的固定 limit；ADR-P2-1：P2 无任意分页面）。 */
const LIST_LIMIT = 10;

/** 类别 → 请求路径（闭集映射；事实清单 stripe-readonly-endpoints.md）。 */
const CATEGORY_PATHS: Readonly<Record<PayswapReadonlyCategory, string>> = {
  balance: "/v1/balance",
  payment_objects: `/v1/charges?limit=${LIST_LIMIT}`,
  customers: `/v1/customers?limit=${LIST_LIMIT}`,
  disputes: `/v1/disputes?limit=${LIST_LIMIT}`,
};

export interface PayswapStripeDataReadDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 数据读超时（缺省 10 s）。 */
  timeoutMs?: number;
  /** API 基 URL（缺省 = 生产 URL；真连线/超时行可指向本地服务）。 */
  apiBase?: string;
}

/** 缺省 transport：globalThis.fetch + AbortController 超时执行（与读回半同款）。 */
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
  return `The Stripe data-read transport failed: ${message}`;
}

/** minor-unit 数值 → schema 的整数字符串（Number.isSafeInteger 守卫，畸形即 null）。 */
function minorUnitString(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 余额 redaction：available/pending → {amount, currency}[]（白名单拷贝）。 */
function redactBalance(body: unknown): PayswapBalanceData | null {
  const raw = body as { available?: unknown; pending?: unknown } | null;
  const entry = (value: unknown): { amount: string; currency: string } | null => {
    if (typeof value !== "object" || value === null) return null;
    const amount = minorUnitString((value as { amount?: unknown }).amount);
    const currency = (value as { currency?: unknown }).currency;
    if (amount === null || typeof currency !== "string") return null;
    return { amount, currency };
  };
  if (!Array.isArray(raw?.available) || !Array.isArray(raw?.pending)) return null;
  const available: { amount: string; currency: string }[] = [];
  for (const value of raw.available) {
    const mapped = entry(value);
    if (mapped === null) return null;
    available.push(mapped);
  }
  const pending: { amount: string; currency: string }[] = [];
  for (const value of raw.pending) {
    const mapped = entry(value);
    if (mapped === null) return null;
    pending.push(mapped);
  }
  const parsed = payswapBalanceDataSchema.safeParse({ available, pending });
  return parsed.success ? parsed.data : null;
}

/** 支付对象（Charge）redaction：白名单 id/amount/currency/status/created/description。 */
function redactPaymentObjects(body: unknown): PayswapPaymentObject[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const rows: PayswapPaymentObject[] = [];
  for (const value of data) {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : null;
    const amount = minorUnitString(row.amount);
    const currency = typeof row.currency === "string" ? row.currency : null;
    const status = typeof row.status === "string" ? row.status : null;
    const created = typeof row.created === "number" ? row.created : null;
    if (id === null || amount === null || currency === null || status === null || created === null) {
      return null;
    }
    const parsed = payswapPaymentObjectSchema.safeParse({
      id,
      amount,
      currency,
      status,
      created,
      description: nullableString(row.description),
    });
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

/** 客户 redaction：白名单 id/created/description（email/name 等 PII 永不拷贝）。 */
function redactCustomers(body: unknown): PayswapCustomer[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const rows: PayswapCustomer[] = [];
  for (const value of data) {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : null;
    const created = typeof row.created === "number" ? row.created : null;
    if (id === null || created === null) return null;
    const parsed = payswapCustomerSchema.safeParse({
      id,
      created,
      description: nullableString(row.description),
    });
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

/** 争议 redaction：白名单 id/amount/currency/status/reason/created。 */
function redactDisputes(body: unknown): PayswapDispute[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const rows: PayswapDispute[] = [];
  for (const value of data) {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : null;
    const amount = minorUnitString(row.amount);
    const currency = typeof row.currency === "string" ? row.currency : null;
    const status = typeof row.status === "string" ? row.status : null;
    const created = typeof row.created === "number" ? row.created : null;
    if (id === null || amount === null || currency === null || status === null || created === null) {
      return null;
    }
    const parsed = payswapDisputeSchema.safeParse({
      id,
      amount,
      currency,
      status,
      reason: nullableString(row.reason),
      created,
    });
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

/**
 * 创建真实 Stripe 只读数据端口（`PayswapAccountDataReadPort` 的 Stripe 实现）。
 * 结局映射与装配防线见文件头法则；秘密只经参数入、只进 Authorization 头。
 */
export function createStripeAccountDataReadPort(
  dependencies: PayswapStripeDataReadDependencies = {},
): PayswapAccountDataReadPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_DATA_READ_TIMEOUT_MS;
  const apiBase = (dependencies.apiBase ?? DEFAULT_STRIPE_API_BASE).replace(/\/+$/, "");
  const apiClient = dependencies.apiClient ?? createDefaultStripeApiClient(timeoutMs);

  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    // 装配防线 1：provider/secretKind/类别路由错配 = 装配错误（fail-closed 抛出，
    // 零网络触达；accountService 映射 typed 拒绝）。
    if (input.providerId !== "stripe") {
      throw new Error(
        `The Stripe data-read adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "api-key") {
      throw new Error(
        `The Stripe data-read adapter received secret kind '${input.secretKind}'; the Stripe contract declares exactly [api-key].`,
      );
    }
    const path = CATEGORY_PATHS[input.category];
    if (path === undefined) {
      throw new Error(
        `The Stripe data-read adapter received an unknown read category '${String(input.category)}'.`,
      );
    }
    // 装配防线 2：秘密前缀推导的模式与记录 mode 不一致 = 本地不一致（不触网）。
    const derivedMode = derivePayswapSecretKeyMode(input.secret, PAYSWAP_STRIPE_AUTH_SPEC);
    if (derivedMode === null || derivedMode !== input.mode) {
      return {
        status: "unavailable",
        detail:
          `The stored Stripe key's prefix does not match the connection record's '${input.mode}' mode; ` +
          "revoke and re-connect the account to repair the record.",
      };
    }

    // 数据读触达：秘密只进 Authorization 头（doc 04 §1.1 Bearer）；全部 GET。
    let response: Response;
    try {
      response = await apiClient.request(`${apiBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.secret}` },
        timeoutMs,
      });
    } catch (error) {
      return { status: "unavailable", detail: transportFailureDetail(error) };
    }

    if (response.status === 401) {
      return {
        status: "auth-failed",
        detail: "Stripe rejected the credential (HTTP 401) on the data read.",
      };
    }
    if (response.status === 403) {
      // doc 04 §1.3：restricted key 的 per-resource 权限边界 —— typed 拒绝。
      return {
        status: "refused",
        refusal: {
          code: "insufficient_permission",
          message:
            "Stripe answered HTTP 403 on this read; the key lacks the read permission for this resource " +
            "(restricted keys carry per-resource permissions). Grant the permission or use a key with it.",
        },
      };
    }
    if (response.status !== 200) {
      return {
        status: "unavailable",
        detail: `Stripe answered HTTP ${response.status} on the ${input.category} read; no data evidence.`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: "unavailable",
        detail: `The Stripe ${input.category} read returned a malformed (non-JSON) body; no data evidence.`,
      };
    }

    // redaction-by-construction：白名单拷贝 + strict 法则校验；畸形 → unavailable。
    let data: unknown;
    if (input.category === "balance") {
      data = redactBalance(body);
    } else if (input.category === "payment_objects") {
      data = redactPaymentObjects(body);
    } else if (input.category === "customers") {
      data = redactCustomers(body);
    } else {
      data = redactDisputes(body);
    }
    if (data === null) {
      return {
        status: "unavailable",
        detail: `The Stripe ${input.category} read returned a malformed body; no data evidence.`,
      };
    }
    const parsed = payswapReadonlyCategoryResultSchemas[input.category].safeParse({
      status: "ok",
      data,
    });
    if (!parsed.success) {
      return {
        status: "unavailable",
        detail: `The Stripe ${input.category} read returned data that failed the strict redaction schema.`,
      };
    }
    return parsed.data as PayswapReadonlyCategoryResult;
  };
}
