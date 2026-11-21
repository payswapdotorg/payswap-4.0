/**
 * PaySwap P3 provider half —— PayPal 只读数据 adapter（`PayswapAccountDataReadPort`
 * 的 PayPal 实现；PAYSWAP_PAYPAL_EVIDENCE_PIN 的事实，检索 2026-11-21 在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **token 交换（非托管路径）**：POST {base[mode]}/v1/oauth2/token（Basic
 *    client_id:client_secret，form grant_type=client_credentials —— 官方 pin）
 *    → access_token → Bearer 调数据端点。token 缓存于端口闭包（短期、不持久化、
 *    不投影）；401 交换失败 = 类别 unavailable（unknown ≠ expired —— 类别读不翻
 *    状态；翻状态是 read-back 的专权）。托管标记凭据（ADR-P2-3）→ typed
 *    unavailable 零触达（token 交换需要明文凭据对 —— 托管下明文不经桌面；
 *    v1.2 的服务端 POST 代理只覆盖 read-back，数据面代理是 v1.3 追踪项）。
 * 2. **闭集类别 → 官方端点（全只读）**：
 *    - balance         → GET /v1/reporting/balances（官方 pin P-7：可选 as_of_time；
 *      应答含 per-currency total_balance / available_balance / withheld_balance
 *      {currency_code, value}）。投影：available ← available_balance（缺席时
 *      total_balance 逐币种回退）；pending: [] 是显式的 provider 缺席投影
 *      （PayPal 的 withheld 是独立概念 —— 绝不误标为 pending）；
 *    - payment_objects → GET /v1/reporting/transactions（官方：必填 start_date/
 *      end_date，RFC3339 秒精度，最大窗口 31 天 —— 本端口固定最近 31 天窗口）。
 *      transaction_details[].transaction_info {transaction_id, transaction_amount
 *      {currency_code, value}, transaction_status, transaction_initiation_date,
 *      transaction_subject} → redacted 行（amount 十进制 → minor-unit 整数字符串
 *      —— 按 ISO 4217 指数换算，见下；description ← transaction_subject）；
 *    - customers       → PayPal 官方商户 REST API 无 customers 列举端点
 *      （provider 缺席事实，pin 在案）→ refused{unsupported_operation}；
 *    - disputes        → GET /v1/customer/disputes（官方：items[] {dispute_id,
 *      status, dispute_amount {currency_code, value}, reason, create_time}）→
 *      redacted 行。
 * 3. **金额换算纪律（ISO 4217）**：PayPal 的 value 是十进制主单位字符串；redacted
 *    schema 要求 minor-unit 整数字符串。换算按 ISO 4217 指数（官方标准，检索
 *    2026-11-21 在案：USD/EUR/GBP/NGN 2、JPY 0、KWD 3）字符串操作完成（无浮点）；
 *    指数表外的货币 = 类别 unavailable（诚实 fail-closed，绝不猜）。小数位超过
 *    指数（精度丢失）= 同样 unavailable（绝不截断）。
 * 4. **结局映射（doc 05 §6.4）**：类别 GET 401（token 交换 401 或数据端点 401）=
 *    唯一 auth-failed 证据；403 → refused{insufficient_permission}；其余非 200、
 *    非 JSON、畸形条目（all-or-nothing）、传输异常、超时 → unavailable。
 * 5. **装配防线（先于任何网络触达）**：providerId ≠ "paypal" / secretKind ≠
 *    "client-secret" = 装配错误 → 抛出。
 * 6. **零秘密外泄**：凭据对只进 token 交换的 Basic 头；access_token 只进数据端点
 *    Bearer 头；任何 detail/message 操作员可读且零凭据材料；本模块不日志、不
 *    持久化、不投影秘密。token 缓存不跨端口实例、不落盘。
 * 7. **IO 全注入**：transport 经 `ApiClient`（timeoutMs 随 init）；缺省 =
 *    globalThis.fetch + AbortController（缺省 10 s）；apiBase 可注入。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_PAYPAL_AUTH_SPEC,
  type PayswapAccountDataReadInput,
  type PayswapReadonlyCategoryResult,
  type PayswapAccountDataReadPort,
} from "@zcode/shared/payswap";
import { CUSTODIAN_SECRET_MARKER } from "../../accounts/accountService.js";

/** 缺省数据读超时（用户面只读 —— 悬挂端点必须被切断）。 */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** 支付对象查询窗口：官方最大 31 天（"The maximum supported range is 31 days"）。 */
const TRANSACTION_WINDOW_DAYS = 31;

/**
 * ISO 4217 minor-unit 指数表（官方标准，检索 2026-11-21 在案：iso.org 4217 页
 * 确认 minor unit 关系「100 或 1000」；指数值经 ISO 4217 表核验 —— USD/EUR/GBP/
 * NGN 2、JPY 0、KWD 3）。表外货币 = 类别 unavailable（诚实 fail-closed）。
 */
const ISO4217_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  NGN: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  KWD: 3,
};

export interface PayswapPaypalDataReadDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** v1.3 托管 token+data 代理端口（runtime 从 custodian 桥注入；缺席 = 托管凭据
   *  typed unavailable 零触达 —— 单测注入面 preserved）。端口做 token 交换 + 数据
   *  GET 服务端完成，access_token 绝不出代理。 */
  custodianTokenGet?: PayswapPaypalCustodianTokenGet;
  /** 数据读超时（缺省 10 s）。 */
  timeoutMs?: number;
  /** API base（缺省 = 官方 pin 的 base[mode]；本地真连线测试可注入）。 */
  apiBase?: string;
}

/**
 * v1.3 托管 token+data 代理端口（custodian token-get op 的 wrapper；runtime 从桥
 * 注入）。端口做 token 交换 + 数据 GET 服务端完成，access_token 绝不出代理。
 */
export interface PayswapPaypalCustodianTokenGet {
  (params: {
    readonly mode: "test" | "live";
    readonly clientSlot: string;
    readonly secretSlot: string;
    readonly dataUrl: string;
  }): Promise<{ status: number; body: string }>;
}

/** custodian 标记里的槽名（"…custodian-managed:<存储键>" 后缀；缺省 = 旧版单槽）。 */
function slotFromCustodianMarker(value: string): string {
  const markerIndex = value.indexOf(CUSTODIAN_SECRET_MARKER);
  return value.slice(markerIndex + CUSTODIAN_SECRET_MARKER.length).replace(/^:/, "");
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

function transportFailureDetail(error: unknown, category: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `The PayPal ${category} read transport failed: ${message}`;
}

/** 十进制主单位字符串 → minor-unit 整数字符串（ISO 4217 指数；无浮点）。 */
function decimalToMinorUnits(value: string, exponent: number): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [intPart, fracPartRaw = ""] = unsigned.split(".");
  if (fracPartRaw.length > exponent) return null; // 精度丢失 → 拒绝换算
  const fracPadded = fracPartRaw + "0".repeat(exponent - fracPartRaw.length);
  const digits = (intPart === "0" ? "" : intPart) + fracPadded;
  const minor = digits.replace(/^0+(?=\d)/, "");
  return (negative ? "-" : "") + (minor.length > 0 ? minor : "0");
}

/** RFC 3339 (ISO) → epoch 秒（非整数/NaN = 投影失败 → 调用方 fail-closed 整类）。 */
function epochSeconds(iso: string): number | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed / 1000);
}

/** RFC 3339 现在时刻（秒精度 —— PayPal start_date/end_date 要求秒粒度）。 */
function rfc3339Seconds(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 类别 → 官方数据端点路径+查询串（customers 在调用方已 refused —— 不可达）。 */
function categoryPathAndQuery(category: "balance" | "payment_objects" | "disputes"): string {
  if (category === "balance") return "/v1/reporting/balances";
  if (category === "payment_objects") {
    // 官方窗口上限 31 天；固定最近 31 天（start_date/end_date 必填，RFC3339 秒精度）。
    const now = new Date();
    const endDate = rfc3339Seconds(now, 0);
    const startDate = rfc3339Seconds(now, TRANSACTION_WINDOW_DAYS);
    return `/v1/reporting/transactions?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
  }
  return "/v1/customer/disputes";
}

/**
 * 类别数据投影（共享面 —— 直连与托管两臂同投影）：官方载 envelopes/
 * transaction_details/items → redacted 行（ISO 4217 minor-unit 换算、PII 零携带、
 * all-or-nothing 畸形拒绝）。畸形 → unavailable（诚实 fail-closed）。
 */
function projectPaypalCategoryData(
  category: "balance" | "payment_objects" | "disputes",
  data: unknown,
): PayswapReadonlyCategoryResult {
  if (category === "balance") {
    const envelopes = (data as { balances?: unknown } | null)?.balances;
    if (!Array.isArray(envelopes)) {
      return { status: "unavailable", detail: "The PayPal balances read returned an unexpected envelope; no data evidence." };
    }
    const available: { amount: string; currency: string }[] = [];
    for (const raw of envelopes) {
      const item = raw as {
        currency?: unknown;
        total_balance?: { value?: unknown } | null;
        available_balance?: { value?: unknown } | null;
      } | null;
      if (typeof item !== "object" || item === null || typeof item.currency !== "string" || item.currency.trim().length === 0) {
        return { status: "unavailable", detail: "The PayPal balances read returned a malformed entry; no data evidence (all-or-nothing)." };
      }
      const exponent = ISO4217_EXPONENTS[item.currency];
      if (exponent === undefined) {
        return { status: "unavailable", detail: `The PayPal currency exponent table has no entry for '${item.currency}'; no data evidence (honest fail-closed).` };
      }
      const source = item.available_balance ?? item.total_balance;
      const value = typeof source === "object" && source !== null && typeof (source as { value?: unknown }).value === "string"
        ? (source as { value: string }).value
        : null;
      if (value === null) {
        return { status: "unavailable", detail: "The PayPal balances read returned a malformed balance value; no data evidence (all-or-nothing)." };
      }
      const minor = decimalToMinorUnits(value, exponent);
      if (minor === null) {
        return { status: "unavailable", detail: "The PayPal balances read returned a value that cannot be projected without precision loss; no data evidence." };
      }
      available.push({ amount: minor, currency: item.currency });
    }
    // PayPal 的 withheld_balance 是独立概念 —— pending: [] 是显式缺席投影。
    return { status: "ok", data: { available, pending: [] } };
  }

  if (category === "payment_objects") {
    const details = (data as { transaction_details?: unknown } | null)?.transaction_details;
    if (!Array.isArray(details)) {
      return { status: "unavailable", detail: "The PayPal transactions read returned an unexpected envelope; no data evidence." };
    }
    const rows: {
      id: string;
      amount: string;
      currency: string;
      status: string;
      created: number;
      description: string | null;
    }[] = [];
    for (const raw of details) {
      const info = (raw as { transaction_info?: unknown } | null)?.transaction_info as {
        transaction_id?: unknown;
        transaction_amount?: { currency_code?: unknown; value?: unknown } | null;
        transaction_status?: unknown;
        transaction_initiation_date?: unknown;
        transaction_subject?: unknown;
      } | null;
      if (typeof info !== "object" || info === null) {
        return { status: "unavailable", detail: "The PayPal transactions read returned a malformed entry; no data evidence (all-or-nothing)." };
      }
      const exponent = typeof info.transaction_amount === "object" && info.transaction_amount !== null
        ? ISO4217_EXPONENTS[(info.transaction_amount as { currency_code?: unknown }).currency_code as string]
        : undefined;
      const currency = typeof info.transaction_amount === "object" && info.transaction_amount !== null
        ? (info.transaction_amount as { currency_code?: unknown }).currency_code
        : null;
      const created = typeof info.transaction_initiation_date === "string" ? epochSeconds(info.transaction_initiation_date) : null;
      if (
        typeof info.transaction_id !== "string" ||
        info.transaction_id.trim().length === 0 ||
        typeof info.transaction_amount !== "object" ||
        info.transaction_amount === null ||
        typeof currency !== "string" ||
        currency.trim().length === 0 ||
        typeof info.transaction_amount.value !== "string" ||
        typeof info.transaction_status !== "string" ||
        info.transaction_status.trim().length === 0 ||
        created === null
      ) {
        return { status: "unavailable", detail: "The PayPal transactions read returned a malformed entry; no data evidence (all-or-nothing)." };
      }
      const minor = decimalToMinorUnits(info.transaction_amount.value, exponent ?? -1);
      if (minor === null) {
        return { status: "unavailable", detail: "The PayPal transactions read returned an amount that cannot be projected without precision loss or an unpinned currency; no data evidence." };
      }
      const subject = typeof info.transaction_subject === "string" && info.transaction_subject.trim().length > 0
        ? info.transaction_subject
        : null;
      rows.push({ id: info.transaction_id, amount: minor, currency, status: info.transaction_status, created, description: subject });
    }
    return { status: "ok", data: rows };
  }

  // disputes：items[] 投影。
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    return { status: "unavailable", detail: "The PayPal disputes read returned an unexpected envelope; no data evidence." };
  }
  const rows: {
    id: string;
    amount: string;
    currency: string;
    status: string;
    reason: string | null;
    created: number;
  }[] = [];
  for (const raw of items) {
    const item = raw as {
      dispute_id?: unknown;
      status?: unknown;
      reason?: unknown;
      create_time?: unknown;
      dispute_amount?: { currency_code?: unknown; value?: unknown } | null;
    } | null;
    const created = typeof item?.create_time === "string" ? epochSeconds(item.create_time) : null;
    const currency = typeof item?.dispute_amount === "object" && item?.dispute_amount !== null
      ? (item.dispute_amount as { currency_code?: unknown }).currency_code
      : null;
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.dispute_id !== "string" ||
      item.dispute_id.trim().length === 0 ||
      typeof item.status !== "string" ||
      item.status.trim().length === 0 ||
      typeof item.dispute_amount !== "object" ||
      item.dispute_amount === null ||
      typeof currency !== "string" ||
      currency.trim().length === 0 ||
      typeof item.dispute_amount.value !== "string" ||
      created === null
    ) {
      return { status: "unavailable", detail: "The PayPal disputes read returned a malformed entry; no data evidence (all-or-nothing)." };
    }
    const exponent = ISO4217_EXPONENTS[currency];
    const minor = decimalToMinorUnits(item.dispute_amount.value, exponent ?? -1);
    if (minor === null) {
      return { status: "unavailable", detail: "The PayPal disputes read returned an amount that cannot be projected without precision loss or an unpinned currency; no data evidence." };
    }
    const reason = typeof item.reason === "string" && item.reason.trim().length > 0 ? item.reason : null;
    rows.push({ id: item.dispute_id, amount: minor, currency, status: item.status, reason, created });
  }
  return { status: "ok", data: rows };
}

/**
 * 创建真实 PayPal 数据读端口（`PayswapAccountDataReadPort` 的 PayPal 实现）。
 * 类别映射、ISO 4217 金额换算与结局纪律见文件头法则；凭据只进 token 交换的
 * Basic 头，access_token 只进数据端点 Bearer 头。
 */
export function createPaypalAccountDataReadPort(
  dependencies: PayswapPaypalDataReadDependencies = {},
): PayswapAccountDataReadPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const apiClient = dependencies.apiClient ?? createDefaultPaypalApiClient(timeoutMs);
  const custodianTokenGet = dependencies.custodianTokenGet;
  const base = (mode: "test" | "live") =>
    (dependencies.apiBase ?? PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.apiBaseUrl[mode]).replace(/\/+$/, "");
  let cachedToken: { token: string; expiresAt: number; mode: "test" | "live"; secret: string; clientId: string } | null = null;

  /** client_credentials token 交换（闭包缓存 —— 短期、不持久化、不投影）。 */
  async function exchangeToken(
    mode: "test" | "live",
    clientId: string,
    clientSecret: string,
  ): Promise<{ ok: true; token: string } | { ok: false; status: number; detail: string }> {
    const now = Date.now();
    if (
      cachedToken !== null &&
      cachedToken.mode === mode &&
      cachedToken.clientId === clientId &&
      cachedToken.secret === clientSecret &&
      now < cachedToken.expiresAt - 30_000
    ) {
      return { ok: true, token: cachedToken.token };
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    let response: Response;
    try {
      response = await apiClient.request(base(mode) + PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.tokenPath, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        timeoutMs,
      });
    } catch (error) {
      return { ok: false, status: 0, detail: transportFailureDetail(error, "token exchange") };
    }
    if (response.status === 401) {
      return { ok: false, status: 401, detail: "PayPal rejected the client credentials (HTTP 401 on the token exchange)." };
    }
    if (response.status !== 200) {
      return { ok: false, status: response.status, detail: `PayPal answered HTTP ${response.status} on the token exchange; no data evidence.` };
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      return { ok: false, status: response.status, detail: "The PayPal token exchange returned a malformed (non-JSON) body; no data evidence." };
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.trim().length === 0) {
      return { ok: false, status: response.status, detail: "The PayPal token exchange returned no access token; no data evidence." };
    }
    const expiresIn = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 3600;
    cachedToken = { token: parsed.access_token, expiresAt: now + expiresIn * 1000, mode, secret: clientSecret, clientId };
    return { ok: true, token: parsed.access_token };
  }

  /** 带 Bearer token 的类别 GET（官方路径）。 */
  async function categoryGet(
    mode: "test" | "live",
    token: string,
    pathAndQuery: string,
    category: string,
  ): Promise<{ ok: true; data: unknown } | { ok: false; result: PayswapReadonlyCategoryResult }> {
    let response: Response;
    try {
      response = await apiClient.request(base(mode) + pathAndQuery, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs,
      });
    } catch (error) {
      return { ok: false, result: { status: "unavailable", detail: transportFailureDetail(error, category) } };
    }
    if (response.status === 401) {
      return {
        ok: false,
        result: { status: "auth-failed", detail: "PayPal rejected the credential (HTTP 401). Rotate or re-enter the key, then refresh again." },
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        result: {
          status: "refused",
          refusal: {
            code: "insufficient_permission",
            message: "PayPal answered HTTP 403 on the data read; the token lacks the required scope for this surface.",
          },
        },
      };
    }
    if (response.status !== 200) {
      return { ok: false, result: { status: "unavailable", detail: `PayPal answered HTTP ${response.status} on the ${category} read; no data evidence.` } };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, result: { status: "unavailable", detail: `The PayPal ${category} read returned a malformed (non-JSON) body; no data evidence.` } };
    }
    return { ok: true, data: body };
  }

  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    // 装配防线：provider/secretKind 路由错配 = 装配错误（fail-closed 抛出）。
    if (input.providerId !== "paypal") {
      throw new Error(
        `The PayPal data-read adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "client-secret") {
      throw new Error(
        `The PayPal data-read adapter received secret kind '${input.secretKind}'; the PayPal contract's primary secret is exactly [client-secret].`,
      );
    }
    // customers：PayPal 官方商户 REST API 无 customers 列举端点（provider 缺席
    // 事实，pin 在案）—— 任何路径都零触达直拒。
    if (input.category === "customers") {
      return {
        status: "refused",
        refusal: {
          code: "unsupported_operation",
          message:
            "PayPal's official merchant REST API exposes no customers listing endpoint " +
            "(provider-absence fact, pinned 2026-11-20); the category is not fabricatable.",
        },
      };
    }
    // v1.3：托管标记凭据 → 走注入的 token+data 代理端口（custodian token-get op:
    // 服务端完成 token 交换 + 数据 GET；access_token 瞬态绝不出代理）。代理缺席 =
    // typed unavailable 零触达（不降级、不猜）。非托管路径继续走明文凭据对。
    const secretIsMarker = input.secret.includes(CUSTODIAN_SECRET_MARKER);
    const clientIdIsMarker = input.clientId !== undefined && input.clientId.includes(CUSTODIAN_SECRET_MARKER);
    if (secretIsMarker || clientIdIsMarker) {
      if (!custodianTokenGet || !secretIsMarker || !clientIdIsMarker) {
        return {
          status: "unavailable",
          detail:
            "The PayPal data reads under credential custody require the custodian token+data proxy " +
            "(v1.3); the proxy is absent or the credential pair is incomplete (no wire touch; state unchanged).",
        };
      }
      // 托管臂：按类别构建 dataUrl → 调端口（custodian 服务端完成 token 交换 + 数据
      // GET）→ 应答 {status, body} → 共享投影。
      const clientSlot = slotFromCustodianMarker(input.clientId);
      const secretSlot = slotFromCustodianMarker(input.secret);
      const dataUrl = base(input.mode) + categoryPathAndQuery(input.category);
      const reply = await custodianTokenGet({ mode: input.mode, clientSlot, secretSlot, dataUrl });
      if (reply.status === 401) {
        return { status: "auth-failed", detail: "PayPal rejected the credential (HTTP 401 on the token+data proxy)." };
      }
      if (reply.status === 403) {
        return {
          status: "refused",
          refusal: {
            code: "insufficient_permission",
            message: "PayPal answered HTTP 403 on the token+data proxy; the app lacks the required scope for this surface.",
          },
        };
      }
      if (reply.status !== 200) {
        return { status: "unavailable", detail: `PayPal answered HTTP ${reply.status} on the token+data proxy; no data evidence.` };
      }
      let data: unknown;
      try {
        data = JSON.parse(reply.body);
      } catch {
        return { status: "unavailable", detail: `The PayPal ${input.category} read (via custody) returned a malformed body; no data evidence.` };
      }
      return projectPaypalCategoryData(input.category, data);
    }
    const clientId = input.clientId?.trim() ?? "";
    if (clientId.length === 0) {
      return { status: "unavailable", detail: "The stored PayPal connection is missing its client id; revoke and re-connect, then retry." };
    }

    // token 交换（闭包缓存）。
    const tokenResult = await exchangeToken(input.mode, clientId, input.secret);
    if (!tokenResult.ok) {
      if (tokenResult.status === 401) {
        return { status: "auth-failed", detail: tokenResult.detail };
      }
      return { status: "unavailable", detail: tokenResult.detail };
    }
    const token = tokenResult.token;

    // 直连臂：token → 类别 GET（官方闭集路径 + 查询串）→ 共享投影。
    const fetched = await categoryGet(input.mode, token, categoryPathAndQuery(input.category), input.category);
    if (!fetched.ok) return fetched.result;
    return projectPaypalCategoryData(input.category, fetched.data);
  };
}