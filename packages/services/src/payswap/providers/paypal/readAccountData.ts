/**
 * PaySwap P3 —— PayPal 只读数据 adapter（doc 06 §2.9 provider 运行时的 PayPal
 * 落地；ADR-P2-1 四类别闭集；事实清单 `docs/payswap/provider-facts/paypal.md`
 * P-5..P-10 + 第三批检索 2026-11-15 —— 官方 OpenAPI schema
 * （developer.paypal.com/api/<area>/v1/schema.json，OpenAPI 3.2.0）为 wire 面
 * 事实源，检索日期在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现**：`PayswapAccountDataReadPort` 的 PayPal 落地 —— 每次调用
 *    读**一个**闭集类别：先 mint client-credentials token（P-1，共享步
 *    oauth2.ts），再 `GET` 数据端点（Bearer token）：
 *    - `balance → GET /v1/reporting/balances`（P-7）—— 响应 `balances[]`，每行
 *      `available_balance` / `withheld_balance` 是 money{currency_code, value}
 *      （官方 schema balances_response 逐字在案）：available → available、
 *      withheld → pending（被扣留 = 当前不可用 —— 投影语义，doc 05 §6.1 类目）；
 *    - `payment_objects → GET /v1/reporting/transactions`（P-8）——
 *      `start_date`/`end_date` 必填（RFC3339 带秒，20–64）+ `page_size`（已
 *      验证参数）—— **固定近因窗口**（31 天，自注入时钟；page_size = 10 与
 *      Stripe 的 limit=10 同款近因哲学，无任意分页面）—— 响应
 *      `transaction_details[].transaction_info`（官方 schema search_response
 *      逐字在案）；
 *    - `disputes → GET /v1/customer/disputes`（P-9）—— 响应 `items[]`
 *      dispute_info（官方 schema dispute_search 逐字在案：dispute_id/
 *      status/reason/dispute_amount/create_time）；
 *    - `customers → refused{unsupported_operation}`（PayPal 已验证读面**没有**
 *      客户列表面 —— P-5..P-10 无此端点；typed 拒绝而非猜测，零网络触达）。
 * 2. **结局映射（doc 05 §6.4 + §6.6 + ADR-P2-1；client-credentials 语义精化）**：
 *    - **mint 401 → `auth-failed`**（P-4 —— 唯一凭据拒绝证据；expiry 语义
 *      单点在 mint，数据端点不产生 expiry 证据）；
 *    - 数据端点 **401/403（mint 成功后）→ `refused{insufficient_permission}`**
 *      —— 刚铸造的 token 已认证凭据，数据面拒绝是 scope/权限边界（P-5 的
 *      read-only scope 面；⚠ 项 2 的 sandbox 授予问题即在此如实呈现），不是
 *      凭据拒绝 —— typed 拒绝携带证据语义而非猜测；
 *    - 200 → strict redacted 解析 → `ok`（畸形 → `unavailable`，永不假装成功）；
 *    - 其余一切（404/429/5xx、非 JSON、传输异常、超时）→ `unavailable`
 *      （unknown ≠ failed）。
 * 3. **redaction-by-construction**：只拷贝白名单字段。金额行携带
 *    `amountFormat: "major-unit"`（官方 money schema：value 是 provider-native
 *    字符串 ——「整数（JPY 类）或小数分数（TND 类）」，主单位计；第三批检索
 *    逐字在案 —— account-data 法则 2 的显式约定标记）。时间戳换算是确定性
 *    投影算术：官方 date_time = RFC3339 §5.6（秒必选、小数可选、20–64）→
 *    epoch 秒整数 —— 严格语法校验先行（完整日期 + `T` + `HH:mm:ss` +
 *    `Z`/`±HH:MM` 时区 + 真实日历日；JS 会把 `2026-02-30` 之类非法日历
 *    静默归一化，且能解析 date-only / 空格分隔 / 散文日期等非 RFC3339 串，
 *    因此必须形状与日历双重拒绝），校验通过后才交给 Date.parse 做确定性
 *    换算（NaN = 畸形行 → 全有或全无 unavailable）。provider 原始载荷在
 *    strict 解析后即丢弃。
 * 4. **装配防线（先于任何网络触达）**：`providerId ≠ "paypal"` / `secrets`
 *    键集 ≠ 恰 [client-id, client-secret] / 未知类别 = 装配错误 → 抛出。
 * 5. **零秘密外泄**：secret 只进 Basic 头；token 只进 Bearer 头且只在本次
 *    调用内存中存在；detail/message 操作员可读且零凭据材料。
 * 6. **IO 全注入**：transport 经 `ApiClient`（`@zcode/shared`）；时间源注入
 *    （transactions 近因窗口的确定性测试）；缺省 = globalThis.fetch +
 *    AbortController 超时执行（缺省 10 s）；端点基 URL 可注入。
 */

import type { ApiClient } from "@zcode/shared";
import {
  payswapBalanceDataSchema,
  payswapDisputeSchema,
  payswapPaymentObjectSchema,
  payswapReadonlyCategoryResultSchemas,
  resolvePayswapClientCredentialsBaseUrl,
  PAYSWAP_PAYPAL_AUTH_SPEC,
  type PayswapAccountDataReadInput,
  type PayswapAccountDataReadPort,
  type PayswapBalanceData,
  type PayswapDispute,
  type PayswapPaymentObject,
  type PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";
import {
  createDefaultPayPalApiClient,
  mintPayPalAccessToken,
} from "./oauth2.js";

/** 缺省数据读超时（与读回半同款：悬挂端点必须被切断）。 */
const DEFAULT_DATA_READ_TIMEOUT_MS = 10_000;

/** 近因窗口（与 Stripe limit=10 同款固定近因哲学；page_size = 10，P-8 已验证参数）。 */
const TRANSACTION_PAGE_SIZE = 10;
const TRANSACTION_WINDOW_DAYS = 31;

export interface PayswapPayPalDataReadDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 数据读超时（缺省 10 s）。 */
  timeoutMs?: number;
  /** API 基 URL 覆盖（缺省 = 规格 per-mode base URL，P-3）。 */
  apiBaseOverride?: string;
  /** ISO 时间源（缺省 = 真实时钟；transactions 近因窗口的确定性测试注入点）。 */
  now?(): Date;
}

function transportFailureDetail(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `The PayPal data-read transport failed: ${message}`;
}

/** money{currency_code, value}（官方 schema）→ 投影行 {amount, currency, amountFormat}。 */
function majorUnitMoneyEntry(value: unknown): { amount: string; currency: string; amountFormat: "major-unit" } | null {
  if (typeof value !== "object" || value === null) return null;
  const money = value as { currency_code?: unknown; value?: unknown };
  if (typeof money.currency_code !== "string" || money.currency_code.length < 3) return null;
  if (typeof money.value !== "string" || !/^-?\d+(\.\d+)?$/.test(money.value)) return null;
  // PayPal native 金额约定（官方 money schema，第三批检索逐字在案）。
  return { amount: money.value, currency: money.currency_code, amountFormat: "major-unit" };
}

/**
 * RFC3339 §5.6 严格校验（P-24：秒必选、小数可选、20–64、时区必选）→ epoch
 * 秒整数；形状不符（含 Date.parse 可解析但非 RFC3339 的串）、非法日历日
 * （JS 会静默归一化 2 月 30 日之类）或换算失败 = null（全有或全无
 * unavailable，永不假装成功）。
 */
const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

/** 该年该月的真实天数（闰年正确；month 1–12）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function rfc3339ToEpochSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (value.length < 20 || value.length > 64) return null;
  const match = RFC3339_DATE_TIME_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // 时区偏移分量与 time-hour/time-minute 同界（RFC3339 time-numoffset）。
  if (match[9] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) {
    return null;
  }
  // 语法与日历校验通过的串才交给 Date.parse 做确定性换算（RFC3339 注记
  // 允许小写 t/z；统一归一化为大写后再解析，避免引擎差异）。
  const normalized = value.endsWith("z") ? `${value.slice(0, -1)}Z` : value;
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return null;
  const epochSeconds = Math.floor(parsed / 1000);
  return Number.isSafeInteger(epochSeconds) && epochSeconds >= 0 ? epochSeconds : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 余额 redaction（P-7 + balances_response schema）：available_balance → available、withheld_balance → pending。 */
function redactBalance(body: unknown): PayswapBalanceData | null {
  const raw = body as { balances?: unknown } | null;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.balances)) return null;
  const available: { amount: string; currency: string; amountFormat: "major-unit" }[] = [];
  const pending: { amount: string; currency: string; amountFormat: "major-unit" }[] = [];
  for (const row of raw.balances) {
    if (typeof row !== "object" || row === null) return null;
    const balanceRow = row as { available_balance?: unknown; withheld_balance?: unknown };
    for (const [target, money] of [
      [available, balanceRow.available_balance],
      [pending, balanceRow.withheld_balance],
    ] as const) {
      if (money === undefined) return null;
      const mapped = majorUnitMoneyEntry(money);
      if (mapped === null) return null;
      target.push(mapped);
    }
  }
  const parsed = payswapBalanceDataSchema.safeParse({ available, pending });
  return parsed.success ? parsed.data : null;
}

/** 支付对象 redaction（P-8 + search_response schema）：transaction_info 白名单拷贝。 */
function redactPaymentObjects(body: unknown): PayswapPaymentObject[] | null {
  const raw = body as { transaction_details?: unknown } | null;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.transaction_details)) {
    return null;
  }
  const rows: PayswapPaymentObject[] = [];
  for (const detail of raw.transaction_details) {
    if (typeof detail !== "object" || detail === null) return null;
    const info = (detail as { transaction_info?: unknown }).transaction_info;
    if (typeof info !== "object" || info === null) return null;
    const row = info as Record<string, unknown>;
    const id = typeof row.transaction_id === "string" ? row.transaction_id : null;
    const money = majorUnitMoneyEntry(row.transaction_amount);
    const status = typeof row.transaction_status === "string" ? row.transaction_status : null;
    const created = rfc3339ToEpochSeconds(row.transaction_initiation_date);
    if (id === null || money === null || status === null || created === null) return null;
    const parsed = payswapPaymentObjectSchema.safeParse({
      id,
      amount: money.amount,
      currency: money.currency,
      amountFormat: money.amountFormat,
      status,
      created,
      description: nullableString(row.transaction_subject),
    });
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

/** 争议 redaction（P-9 + dispute_search schema）：dispute_info 白名单拷贝。 */
function redactDisputes(body: unknown): PayswapDispute[] | null {
  const raw = body as { items?: unknown } | null;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.items)) return null;
  const rows: PayswapDispute[] = [];
  for (const item of raw.items) {
    if (typeof item !== "object" || item === null) return null;
    const row = item as Record<string, unknown>;
    const id = typeof row.dispute_id === "string" ? row.dispute_id : null;
    const money = majorUnitMoneyEntry(row.dispute_amount);
    const status = typeof row.status === "string" ? row.status : null;
    const created = rfc3339ToEpochSeconds(row.create_time);
    if (id === null || money === null || status === null || created === null) return null;
    const parsed = payswapDisputeSchema.safeParse({
      id,
      amount: money.amount,
      currency: money.currency,
      amountFormat: money.amountFormat,
      status,
      reason: nullableString(row.reason),
      created,
    });
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

/** RFC3339 带秒、无小数（date_time 合法形态：20 字符 `YYYY-MM-DDTHH:mm:ssZ`）。 */
function rfc3339WithSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 创建真实 PayPal 只读数据端口（`PayswapAccountDataReadPort` 的 PayPal 实现）。
 * 结局映射与装配防线见文件头法则；token 只在本次调用内存中存在（每次类别读
 * 现铸 —— P2 的「重用至过期」是运行时层关切，端口保持无状态）。
 */
export function createPayPalAccountDataReadPort(
  dependencies: PayswapPayPalDataReadDependencies = {},
): PayswapAccountDataReadPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_DATA_READ_TIMEOUT_MS;
  const apiClient = dependencies.apiClient ?? createDefaultPayPalApiClient(timeoutMs);
  const now = dependencies.now ?? (() => new Date());

  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    // 装配防线 1：provider/秘密键集/类别路由错配 = 装配错误（fail-closed 抛出，
    // 零网络触达；accountService 映射 typed 拒绝）。
    if (input.providerId !== "paypal") {
      throw new Error(
        `The PayPal data-read adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    const secretKeys = Object.keys(input.secrets).sort();
    if (
      secretKeys.length !== 2 ||
      secretKeys[0] !== "client-id" ||
      secretKeys[1] !== "client-secret"
    ) {
      throw new Error(
        `The PayPal data-read adapter received secret kinds [${secretKeys.join(", ") || "none"}]; the PayPal contract declares exactly [client-id, client-secret].`,
      );
    }
    const clientId = input.secrets["client-id"] ?? "";
    const clientSecret = input.secrets["client-secret"] ?? "";
    if (!clientId || !clientSecret) {
      throw new Error(
        "The PayPal data-read adapter received an empty client-id or client-secret; check the credential store wiring.",
      );
    }

    // customers：PayPal 已验证读面没有客户列表面（P-5..P-10）—— typed 拒绝，
    // 零网络触达（不 mint、不猜测）。
    if (input.category === "customers") {
      return {
        status: "refused",
        refusal: {
          code: "unsupported_operation",
          message:
            "PayPal's verified read data plane (reporting/transactions, reporting/balances, " +
            "customer/disputes, identity) has no customer-list surface; the customers category " +
            "is refused rather than guessed.",
        },
      };
    }

    // 类别端点路径 + 查询串（闭集映射；P-7/P-8/P-9）。
    let path: string;
    if (input.category === "balance") {
      path = "/v1/reporting/balances";
    } else if (input.category === "payment_objects") {
      const end = now();
      const start = new Date(end.getTime() - TRANSACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const params = new URLSearchParams({
        start_date: rfc3339WithSeconds(start),
        end_date: rfc3339WithSeconds(end),
        page_size: String(TRANSACTION_PAGE_SIZE),
      });
      path = `/v1/reporting/transactions?${params.toString()}`;
    } else if (input.category === "disputes") {
      path = "/v1/customer/disputes";
    } else {
      throw new Error(
        `The PayPal data-read adapter received an unknown read category '${String(input.category)}'.`,
      );
    }

    // mint（P-1，共享步）：401 → auth-failed（唯一凭据拒绝证据 —— expiry 语义
    // 单点在 mint）；unavailable → 同名 unavailable（unknown ≠ failed）。
    const mint = await mintPayPalAccessToken(
      { mode: input.mode, clientId, clientSecret },
      { apiClient, timeoutMs, apiBaseOverride: dependencies.apiBaseOverride },
    );
    if (mint.kind === "auth-failed") {
      return { status: "auth-failed", detail: mint.detail };
    }
    if (mint.kind === "unavailable") {
      return { status: "unavailable", detail: mint.detail };
    }

    // 数据读触达：token 只进 Authorization 头；全部 GET（no-write 的 wire 证明）。
    // base URL 由规格解析（P-3 单一事实源）。
    const baseUrl = (
      dependencies.apiBaseOverride ??
      resolvePayswapClientCredentialsBaseUrl(PAYSWAP_PAYPAL_AUTH_SPEC, input.mode)
    ).replace(/\/+$/, "");
    let response: Response;
    try {
      response = await apiClient.request(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${mint.accessToken}` },
        timeoutMs,
      });
    } catch (error) {
      return { status: "unavailable", detail: transportFailureDetail(error) };
    }

    if (response.status === 401 || response.status === 403) {
      // mint 刚成功（凭据已被 provider 认证）—— 数据面 401/403 是 scope/权限
      // 边界（P-5 read-only scope 面；sandbox 授予问题如实呈现），不是凭据
      // 拒绝：typed 拒绝，永不翻 expiry（expiry 证据单点在 mint）。
      return {
        status: "refused",
        refusal: {
          code: "insufficient_permission",
          message:
            `PayPal answered HTTP ${response.status} on the ${input.category} read with a freshly minted token; ` +
            "the app likely lacks the read scope for this resource (check the app's scope grants in the developer dashboard).",
        },
      };
    }
    if (response.status !== 200) {
      return {
        status: "unavailable",
        detail: `PayPal answered HTTP ${response.status} on the ${input.category} read; no data evidence.`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: "unavailable",
        detail: `The PayPal ${input.category} read returned a malformed (non-JSON) body; no data evidence.`,
      };
    }

    // redaction-by-construction：白名单拷贝 + strict 法则校验；畸形 → unavailable。
    let data: unknown;
    if (input.category === "balance") {
      data = redactBalance(body);
    } else if (input.category === "payment_objects") {
      data = redactPaymentObjects(body);
    } else {
      data = redactDisputes(body);
    }
    if (data === null) {
      return {
        status: "unavailable",
        detail: `The PayPal ${input.category} read returned a malformed body; no data evidence.`,
      };
    }
    const parsed = payswapReadonlyCategoryResultSchemas[input.category].safeParse({
      status: "ok",
      data,
    });
    if (!parsed.success) {
      return {
        status: "unavailable",
        detail: `The PayPal ${input.category} read returned data that failed the strict redaction schema.`,
      };
    }
    return parsed.data as PayswapReadonlyCategoryResult;
  };
}
