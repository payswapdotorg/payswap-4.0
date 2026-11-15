/**
 * PaySwap P3 —— PayPal 只读数据 adapter（doc 06 §2.9 provider 运行时；ADR-P2-1
 * 四类别闭集）的 services 侧证明（provider-facts/paypal.md P-5..P-10 + 第三批
 * 检索 2026-11-15 官方 OpenAPI schema 事实 + doc 05 §6.4/§6.6 结局纪律）。
 * 全部凭据为合成假值（零真实秘密、零写）。
 *
 * 被测对象：`createPayPalAccountDataReadPort`（`providers/paypal/readAccountData.ts`
 * + 共享 mint 步）—— shared 法则 `PayswapAccountDataReadPort` 的 PayPal 实现：
 *
 * 1. **ok 行**：200 → strict redacted 解析 → `ok`；余额 available/withheld →
 *    available/pending（P-7 + balances_response schema）；transactions
 *    transaction_info 白名单（P-8 + search_response schema）；disputes
 *    dispute_info 白名单（P-9 + dispute_search schema）；金额一律
 *    `amountFormat: "major-unit"`（官方 money schema —— 整数或小数字符串）；
 *    RFC3339 → epoch 秒确定性换算。
 * 2. **redaction-by-construction**：payer email 等 PII 永不拷贝；非白名单字段
 *    永不拷贝。
 * 3. **customers → refused{unsupported_operation}**：PayPal 已验证读面无客户
 *    列表面 —— typed 拒绝、零网络触达（不 mint）。
 * 4. **结局映射（client-credentials 语义精化）**：mint 401 → `auth-failed`
 *    （唯一 expiry 证据，P-4）；mint 非 200/401 → `unavailable`；数据端点
 *    401/403（mint 成功后）→ `refused{insufficient_permission}`（权限边界，
 *    不是凭据拒绝）；其余 → `unavailable`（unknown ≠ failed）。
 * 5. **wire 形状**（P-1/P-3/P-7/P-8/P-9）：先 POST mint（Basic +
 *    grant_type=client_credentials）再 GET 数据端点（Bearer minted token）；
 *    transactions 携带必填 start_date/end_date（RFC3339 带秒 —— 注入时钟的
 *    31 天固定近因窗口）+ page_size=10；全部 GET（no-write 的 wire 证明）。
 * 6. **装配防线（先于网络）**：providerId ≠ "paypal" / secrets 键集 ≠ 恰
 *    [client-id, client-secret] / 未知类别 → 抛出（零网络触达）。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  payswapReadonlyCategoryResultSchemas,
} from "@zcode/shared/payswap";
import {
  createPayPalAccountDataReadPort,
} from "@zcode/services/node";
import { describe, expect, it } from "vitest";

const TEST_CLIENT_ID = "AYqNDTESTCLIENTIDPLACEHOLDER0000000000000000000";
const TEST_CLIENT_SECRET = "EGnJTESTCLIENTSECRETPLACEHOLDER00000000000000";
const MINTED_TOKEN = "A21AAFEpH4PsADK7qSS7pSRTESTTOKENPLACEHOLDER";
/** 注入时钟（transactions 近因窗口的确定性）。 */
const NOW = new Date("2026-11-15T22:57:00Z");

/** 捕获型假 transport（ApiClient 契约：request(input, init) → Response）。 */
interface RecordingApiClient extends ApiClient {
  readonly calls: Array<{ input: string; init?: ApiRequestInit }>;
}

function recordingApiClient(
  handler: (input: string, init: ApiRequestInit | undefined) => Promise<Response> | Response,
): RecordingApiClient {
  const calls: Array<{ input: string; init?: ApiRequestInit }> = [];
  return {
    calls,
    async request(input, init) {
      calls.push({ input: String(input), init });
      return handler(String(input), init);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function tokenResponse(): Response {
  return jsonResponse(200, {
    scope: "https://uri.paypal.com/services/reporting/search/read openid",
    access_token: MINTED_TOKEN,
    token_type: "Bearer",
    app_id: "APP-80W284485P519543T",
    expires_in: 31668,
    nonce: "2020-04-03T15:35:36ZTESTNONCEPLACEHOLDER",
  });
}

function dataInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "paypal",
    mode: "test" as const,
    secrets: { "client-id": TEST_CLIENT_ID, "client-secret": TEST_CLIENT_SECRET } as Record<
      string,
      string
    >,
    category: "balance" as const,
    ...overrides,
  };
}

/** 官方 schema 形态的 balances 响应（balances_response，第三批检索在案）。 */
function balancesBody(overrides: Record<string, unknown> = {}) {
  return {
    balances: [
      {
        currency: "USD",
        primary: true,
        total_balance: { currency_code: "USD", value: "432.00" },
        available_balance: { currency_code: "USD", value: "400.00" },
        withheld_balance: { currency_code: "USD", value: "32.00" },
      },
    ],
    account_id: "PPACCOUNTTESTID",
    as_of_time: "2026-11-15T22:00:00Z",
    last_refresh_time: "2026-11-15T22:05:00Z",
    ...overrides,
  };
}

/** 官方 schema 形态的 transactions 响应（search_response，第三批检索在案）。 */
function transactionsBody(overrides: Record<string, unknown> = {}) {
  return {
    transaction_details: [
      {
        transaction_info: {
          paypal_account_id: "PPACCOUNTTESTID",
          transaction_id: "9XY12345AB",
          paypal_reference_id: "8Z REFER",
          transaction_initiation_date: "2026-11-10T12:34:56Z",
          transaction_amount: { currency_code: "USD", value: "12.34" },
          transaction_status: "S",
          transaction_subject: "Test payment",
        },
        payer_info: { email_address: "someone@example.com" },
      },
    ],
    account_number: "PPACCOUNTTESTID",
    start_date: "2026-10-15T22:57:00Z",
    end_date: "2026-11-15T22:57:00Z",
    page: 1,
    total_items: 1,
    total_pages: 1,
    ...overrides,
  };
}

/** 官方 schema 形态的 disputes 响应（dispute_search，第三批检索在案）。 */
function disputesBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        dispute_id: "PP-D-12345",
        create_time: "2026-11-01T10:00:00Z",
        update_time: "2026-11-02T10:00:00Z",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "OPEN",
        dispute_state: "OPEN_INQUIRY",
        dispute_amount: { currency_code: "USD", value: "9.99" },
        disputed_transactions: [{ seller_transaction_id: "9XY12345AB" }],
      },
    ],
    links: [],
    ...overrides,
  };
}

describe("payswap paypal data-read adapter (P3) — ok rows with redaction-by-construction", () => {
  it("balance: 200 → ok{available, pending}; available_balance → available, withheld_balance → pending; amounts carry amountFormat major-unit", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, balancesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({
        available: [{ amount: "400.00", currency: "USD", amountFormat: "major-unit" }],
        pending: [{ amount: "32.00", currency: "USD", amountFormat: "major-unit" }],
      });
      expect(payswapReadonlyCategoryResultSchemas.balance.safeParse(result).success).toBe(true);
    }
  });

  it("payment_objects: 200 → ok rows (id/amount/currency/amountFormat/status/created/description); PII and non-whitelist fields never copied", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, transactionsBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "payment_objects" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          id: "9XY12345AB",
          amount: "12.34",
          currency: "USD",
          amountFormat: "major-unit",
          status: "S",
          created: 1794314096,
          description: "Test payment",
        },
      ]);
      expect(JSON.stringify(result.data).includes("someone@example.com")).toBe(false);
      expect(JSON.stringify(result.data).includes("PPACCOUNTTESTID")).toBe(false);
      expect(payswapReadonlyCategoryResultSchemas.payment_objects.safeParse(result).success).toBe(
        true,
      );
    }
  });

  it("disputes: 200 → ok rows (id/amount/currency/amountFormat/status/reason/created)", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, disputesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "disputes" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          id: "PP-D-12345",
          amount: "9.99",
          currency: "USD",
          amountFormat: "major-unit",
          status: "OPEN",
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          created: 1793527200,
        },
      ]);
      expect(payswapReadonlyCategoryResultSchemas.disputes.safeParse(result).success).toBe(true);
    }
  });

  it("integer money values (JPY-style) pass as major-unit integer strings", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token")
        ? tokenResponse()
        : jsonResponse(200, balancesBody({
            balances: [
              {
                currency: "JPY",
                primary: true,
                total_balance: { currency_code: "JPY", value: "1000" },
                available_balance: { currency_code: "JPY", value: "1000" },
                withheld_balance: { currency_code: "JPY", value: "0" },
              },
            ],
          })),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.available).toEqual([
        { amount: "1000", currency: "JPY", amountFormat: "major-unit" },
      ]);
    }
  });

  it("malformed rows (bad amount / bad date / missing container) → unavailable, never pretend success", async () => {
    const cases: Array<{ label: string; body: unknown; category: "balance" | "payment_objects" | "disputes" }> = [
      { label: "comma amount", body: balancesBody({ balances: [{ available_balance: { currency_code: "USD", value: "4,00" }, withheld_balance: { currency_code: "USD", value: "0" } }] }), category: "balance" },
      { label: "missing container", body: { nope: [] }, category: "balance" },
      { label: "bad date", body: transactionsBody({ transaction_details: [{ transaction_info: { transaction_id: "X", transaction_amount: { currency_code: "USD", value: "1.00" }, transaction_status: "S", transaction_initiation_date: "not-a-date" } }] }), category: "payment_objects" },
      { label: "non-numeric amount", body: disputesBody({ items: [{ dispute_id: "PP-D-1", status: "OPEN", reason: "OTHER", dispute_amount: { currency_code: "USD", value: "abc" }, create_time: "2026-11-01T10:00:00Z" }] }), category: "disputes" },
    ];
    for (const { label, body, category } of cases) {
      const client = recordingApiClient((input) =>
        input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, body),
      );
      const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
      const result = await port(dataInput({ category }));
      expect(result.status, label).toBe("unavailable");
    }
  });
});

describe("payswap paypal data-read adapter (P3) — outcome law (client-credentials refinement)", () => {
  it("customers → refused{unsupported_operation} with zero transport calls (no mint — the verified read plane has no customer-list surface)", async () => {
    const client = recordingApiClient(() => tokenResponse());
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "customers" }));
    expect(result).toEqual({
      status: "refused",
      refusal: {
        code: "unsupported_operation",
        message: expect.stringContaining("no customer-list surface"),
      },
    });
    expect(client.calls.length).toBe(0);
  });

  it("mint 401 → auth-failed (the only expiry evidence; P-4)", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("auth-failed");
    if (result.status === "auth-failed") {
      expect(result.detail.includes(TEST_CLIENT_SECRET)).toBe(false);
    }
    expect(client.calls.length).toBe(1);
  });

  it("mint non-200/401 → unavailable (unknown ≠ failed)", async () => {
    const client = recordingApiClient(() => jsonResponse(503, {}));
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("unavailable");
  });

  it("data-endpoint 401/403 after a successful mint → refused{insufficient_permission} (scope boundary, not credential rejection)", async () => {
    for (const status of [401, 403]) {
      const client = recordingApiClient((input) =>
        input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(status, {}),
      );
      const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
      const result = await port(dataInput({ category: "balance" }));
      expect(result.status, String(status)).toBe("refused");
      if (result.status === "refused") {
        expect(result.refusal.code).toBe("insufficient_permission");
        expect(result.refusal.message).toContain("freshly minted token");
      }
      expect(client.calls.length).toBe(2);
    }
  });

  it("data-endpoint 500 → unavailable", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(500, {}),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "disputes" }));
    expect(result.status).toBe("unavailable");
  });

  it("transport failure on the data endpoint → unavailable", async () => {
    const client = recordingApiClient((input) => {
      if (input.includes("/v1/oauth2/token")) return tokenResponse();
      throw new Error("ETIMEDOUT");
    });
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("unavailable");
  });
});

describe("payswap paypal data-read adapter (P3) — wire shape (P-1/P-3/P-7/P-8/P-9)", () => {
  it("mints first (Basic + grant_type) then GETs the data endpoint with the minted Bearer token", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, balancesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    await port(dataInput({ category: "balance" }));
    expect(client.calls.length).toBe(2);
    const [mint, read] = client.calls;
    expect(mint?.input).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(mint?.init?.method).toBe("POST");
    const expectedBasic = Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`, "utf8").toString("base64");
    expect((mint?.init?.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${expectedBasic}`,
    );
    expect(read?.input).toBe("https://api-m.sandbox.paypal.com/v1/reporting/balances");
    expect(read?.init?.method).toBe("GET");
    expect((read?.init?.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${MINTED_TOKEN}`,
    );
  });

  it("transactions carries the required RFC3339-with-seconds window (31-day recency from the injected clock) + page_size=10", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, transactionsBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    await port(dataInput({ category: "payment_objects" }));
    const read = client.calls[1];
    expect(read?.init?.method).toBe("GET");
    expect(read?.input).toBe(
      "https://api-m.sandbox.paypal.com/v1/reporting/transactions" +
        "?start_date=2026-10-15T22%3A57%3A00Z&end_date=2026-11-15T22%3A57%3A00Z&page_size=10",
    );
  });

  it("disputes reads GET /v1/customer/disputes with no query", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, disputesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    await port(dataInput({ category: "disputes" }));
    expect(client.calls[1]?.input).toBe(
      "https://api-m.sandbox.paypal.com/v1/customer/disputes",
    );
  });

  it("live mode resolves the live base URL (P-3)", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, balancesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    await port(dataInput({ category: "balance", mode: "live" }));
    expect(client.calls[1]?.input).toBe("https://api-m.paypal.com/v1/reporting/balances");
  });
});

describe("payswap paypal data-read adapter (P3) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'paypal' / secret-kind set ≠ exactly [client-id, client-secret] / unknown category throw with zero transport calls", async () => {
    const client = recordingApiClient((input) =>
      input.includes("/v1/oauth2/token") ? tokenResponse() : jsonResponse(200, balancesBody()),
    );
    const port = createPayPalAccountDataReadPort({ apiClient: client, now: () => NOW });
    await expect(port(dataInput({ providerId: "stripe" }))).rejects.toThrow(/paypal/i);
    await expect(port(dataInput({ secrets: { "api-key": "sk_test_x" } }))).rejects.toThrow(
      /client-id, client-secret/i,
    );
    await expect(
      port(dataInput({ category: "transfers" as never })),
    ).rejects.toThrow(/unknown read category/i);
    expect(client.calls.length).toBe(0);
  });
});
