/**
 * PaySwap P3 provider half —— Paystack 只读数据 adapter（`PayswapAccountDataReadPort`
 * 的 Paystack 实现；PAYSWAP_PAYSTACK_EVIDENCE_PIN 的事实，检索 2026-11-20 在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **闭集类别 → 官方端点（全只读）**：
 *    - balance    → GET /balance（官方「Fetch the available balance on your
 *      integration」→ data: [{currency, balance}]，balance 为 subunit 整数）。
 *      Paystack 官方响应无 pending 概念 → `pending: []` 是显式的 provider 缺席
 *      投影（绝不伪造 pending 条目）；
 *    - payment_objects → GET /transaction（官方 List Transactions → 条目
 *      {id: number, amount: number(subunit), currency, status: string,
 *      created_at: ISO 8601, message}）→ id/amount 投影为 minor-unit 整数字符串，
 *      created_at 投影为 epoch 秒，description ← message（非空字符串才携带）；
 *    - customers  → GET /customer（官方 List Customers → 条目 {customer_code,
 *      createdAt: ISO 8601}）→ id ← customer_code；**email/name/phone 等 PII
 *      绝不读取**（redaction-by-construction —— 载荷字段在投影之后不存在）；
 *    - disputes   → GET /dispute 官方存在，但其条目**无顶层 amount/currency/
 *      reason**（官方样例 refund_amount/currency 为 null，无 reason 字段）——
 *      redacted dispute schema 不容伪造 → 类别诚实回答 `unavailable`（投影不
 *      兼容，非临时故障；PIN 再验证清单在案）。
 * 2. **结局映射（doc 05 §6.4）**：401 = 唯一 auth-failed 证据；403 →
 *    `refused{insufficient_permission}`；官方封套 status !== true / 非 JSON /
 *    data 非数组 / 条目投影失败（all-or-nothing —— 畸形条目毁整类，绝不带病
 *    采纳）/ 非 200/401/403 / 传输异常 / 超时 → `unavailable`。
 * 3. **装配防线（先于任何网络触达）**：providerId ≠ "paystack" / secretKind ≠
 *    "api-key" = 装配错误 → 抛出；**ADR-P2-3 custodian 标记凭据 → typed
 *    `unavailable` 零触达**（Stripe 限定托管通道绝不借道）；前缀/模式不一致 →
 *    `unavailable` 零触达。
 * 4. **零秘密外泄**：秘密只进 Authorization 头；detail 操作员可读且零凭据材料。
 * 5. **IO 全注入**：transport 经 `ApiClient`（timeoutMs 随 init）；缺省 =
 *    globalThis.fetch + AbortController（缺省 10 s）；端点 base 可注入
 *    （缺省 = 官方 https://api.paystack.co）。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  derivePayswapSecretKeyMode,
  PAYSWAP_PAYSTACK_AUTH_SPEC,
  type PayswapAccountDataReadInput,
  type PayswapReadonlyCategoryResult,
  type PayswapAccountDataReadPort,
} from "@zcode/shared/payswap";
import { CUSTODIAN_SECRET_MARKER } from "../../accounts/accountService.js";

/** 生产数据读 base（官方；test/live 同端点 —— 键决定环境）。 */
const DEFAULT_PAYSTACK_API_BASE = "https://api.paystack.co";

/** 缺省数据读超时（用户面只读 —— 悬挂端点必须被切断）。 */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export interface PayswapPaystackDataReadDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 数据读超时（缺省 10 s）。 */
  timeoutMs?: number;
  /** API base（缺省 = 生产；本地真连线测试可注入）。 */
  apiBase?: string;
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

/** ISO 8601 → epoch 秒（非整数/NaN = 投影失败 → 调用方 fail-closed 整类）。 */
function epochSeconds(iso: string): number | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed / 1000);
}

/** 官方封套守卫：{status: true, data: array} 之外的形状 → null（畸形）。 */
function officialEnvelope(body: unknown): { data: readonly unknown[] } | null {
  const envelope = body as { status?: unknown; data?: unknown } | null;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.status !== true ||
    !Array.isArray(envelope.data)
  ) {
    return null;
  }
  return { data: envelope.data };
}

/**
 * 创建真实 Paystack 数据读端口（`PayswapAccountDataReadPort` 的 Paystack 实现）。
 * 类别 → 端点映射、投影与装配防线见文件头法则；秘密只经参数入、只进 Authorization 头。
 */
export function createPaystackAccountDataReadPort(
  dependencies: PayswapPaystackDataReadDependencies = {},
): PayswapAccountDataReadPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const apiBase = (dependencies.apiBase ?? DEFAULT_PAYSTACK_API_BASE).replace(/\/+$/, "");
  const apiClient = dependencies.apiClient ?? createDefaultPaystackApiClient(timeoutMs);

  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    if (input.providerId !== "paystack") {
      throw new Error(
        `The Paystack data-read adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    if (input.secretKind !== "api-key") {
      throw new Error(
        `The Paystack data-read adapter received secret kind '${input.secretKind}'; the Paystack contract declares exactly [api-key].`,
      );
    }
    // ADR-P2-3：custodian 标记凭据 = Stripe 限定的托管通道 —— Paystack 绝不借道。
    if (input.secret.includes(CUSTODIAN_SECRET_MARKER)) {
      return {
        status: "unavailable",
        detail:
          "The Paystack data reads require a loadable provider credential; the custodian-managed " +
          "credential channel is Stripe-scoped (ADR-P2-3 P2 acceptance) and cannot serve Paystack. " +
          "Custodian support for Paystack is a separate tracked P3 slice.",
      };
    }
    const derivedMode = derivePayswapSecretKeyMode(input.secret, PAYSWAP_PAYSTACK_AUTH_SPEC);
    if (derivedMode === null || derivedMode !== input.mode) {
      return {
        status: "unavailable",
        detail:
          `The stored Paystack key's prefix does not match the connection record's '${input.mode}' mode; ` +
          "revoke and re-connect the account to repair the record.",
      };
    }

    const categoryPath =
      input.category === "balance"
        ? "/balance"
        : input.category === "payment_objects"
          ? "/transaction"
          : input.category === "customers"
            ? "/customer"
            : "/dispute";
    let response: Response;
    try {
      response = await apiClient.request(`${apiBase}${categoryPath}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.secret}` },
        timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { status: "unavailable", detail: `The Paystack ${input.category} read transport failed: ${message}` };
    }
    if (response.status === 401) {
      return {
        status: "auth-failed",
        detail: "Paystack rejected the credential (HTTP 401). Rotate or re-enter the key, then refresh again.",
      };
    }
    if (response.status === 403) {
      return {
        status: "refused",
        refusal: {
          code: "insufficient_permission",
          message: "Paystack answered HTTP 403 on the data read; the key lacks permission for this surface.",
        },
      };
    }
    if (response.status !== 200) {
      return {
        status: "unavailable",
        detail: `Paystack answered HTTP ${response.status} on the ${input.category} read; no data evidence.`,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: "unavailable",
        detail: `The Paystack ${input.category} read returned a malformed (non-JSON) body; no data evidence.`,
      };
    }
    const envelope = officialEnvelope(body);
    if (envelope === null) {
      return {
        status: "unavailable",
        detail: `The Paystack ${input.category} read returned an unexpected envelope; no data evidence.`,
      };
    }

    if (input.category === "balance") {
      const entries: { amount: string; currency: string }[] = [];
      for (const raw of envelope.data) {
        const item = raw as { currency?: unknown; balance?: unknown } | null;
        if (
          typeof item !== "object" ||
          item === null ||
          typeof item.currency !== "string" ||
          item.currency.trim().length === 0 ||
          typeof item.balance !== "number" ||
          !Number.isInteger(item.balance)
        ) {
          return {
            status: "unavailable",
            detail: "The Paystack balance read returned a malformed entry; no data evidence (all-or-nothing).",
          };
        }
        entries.push({ amount: String(item.balance), currency: item.currency });
      }
      // Paystack 官方 /balance 无 pending 概念 —— pending: [] 是显式缺席投影。
      return { status: "ok", data: { available: entries, pending: [] } };
    }

    if (input.category === "payment_objects") {
      const rows: {
        id: string;
        amount: string;
        currency: string;
        status: string;
        created: number;
        description: string | null;
      }[] = [];
      for (const raw of envelope.data) {
        const item = raw as {
          id?: unknown;
          amount?: unknown;
          currency?: unknown;
          status?: unknown;
          created_at?: unknown;
          message?: unknown;
        } | null;
        const created =
          typeof item?.created_at === "string" ? epochSeconds(item.created_at) : null;
        if (
          typeof item !== "object" ||
          item === null ||
          (typeof item.id !== "number" && typeof item.id !== "string") ||
          typeof item.amount !== "number" ||
          !Number.isInteger(item.amount) ||
          typeof item.currency !== "string" ||
          item.currency.trim().length === 0 ||
          typeof item.status !== "string" ||
          item.status.trim().length === 0 ||
          created === null
        ) {
          return {
            status: "unavailable",
            detail: "The Paystack transactions read returned a malformed entry; no data evidence (all-or-nothing).",
          };
        }
        rows.push({
          id: String(item.id),
          amount: String(item.amount),
          currency: item.currency,
          status: item.status,
          created,
          description:
            typeof item.message === "string" && item.message.trim().length > 0 ? item.message : null,
        });
      }
      return { status: "ok", data: rows };
    }

    if (input.category === "customers") {
      const rows: { id: string; created: number; description: string | null }[] = [];
      for (const raw of envelope.data) {
        const item = raw as { customer_code?: unknown; createdAt?: unknown; created_at?: unknown } | null;
        const iso =
          typeof item?.createdAt === "string"
            ? item.createdAt
            : typeof item?.created_at === "string"
              ? item.created_at
              : null;
        const created = iso === null ? null : epochSeconds(iso);
        if (
          typeof item !== "object" ||
          item === null ||
          typeof item.customer_code !== "string" ||
          item.customer_code.trim().length === 0 ||
          created === null
        ) {
          return {
            status: "unavailable",
            detail: "The Paystack customers read returned a malformed entry; no data evidence (all-or-nothing).",
          };
        }
        // PII（email/name/phone）绝不读取 —— redaction-by-construction。
        rows.push({ id: item.customer_code, created, description: null });
      }
      return { status: "ok", data: rows };
    }

    // disputes：官方条目无顶层 amount/currency/reason（样例 refund_amount/currency
    // 为 null）—— redacted dispute schema 不容伪造 → 类别诚实 unavailable。
    return {
      status: "unavailable",
      detail:
        "PayStack's documented dispute records carry no top-level amount/currency/reason fields " +
        "(official reference checked 2026-11-20); the redacted dispute schema cannot be populated " +
        "without fabricating values. Pinned for re-verification against official shape changes.",
    };
  };
}
