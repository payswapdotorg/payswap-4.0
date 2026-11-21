/**
 * PaySwap P3 provider half —— PayPal 只读数据 adapter 法则的 services 侧证明
 * （PAYSWAP_PAYPAL_EVIDENCE_PIN 的事实 + ISO 4217 指数换算，检索 2026-11-21
 * 在案；account-data.ts 文件头法则 —— 闭集类别、redaction-by-construction、
 * 四值结局）。
 *
 * 被测法则：
 * 1. **token 交换先行**：POST {base[mode]}/v1/oauth2/token（Basic client_id:
 *    client_secret，form grant_type）→ access_token → Bearer 调数据端点；
 *    token 闭包缓存（同凭据 + 未过期 = 复用）。
 * 2. **balance 投影**：官方 per-currency total_balance/available_balance
 *    {currency_code, value} → available 条目（available_balance 优先，
 *    total_balance 逐币种回退）；pending: [] = 显式缺席投影（withheld 是独立
 *    概念）；十进制 → minor-unit 整数字符串（ISO 4217 指数，无浮点）。
 * 3. **payment_objects 投影**：/v1/reporting/transactions（31 天窗口，
 *    start_date/end_date RFC3339 秒精度）→ transaction_details[].transaction_info
 *    → redacted 行（PII 载荷字段绝不投影）。
 * 4. **disputes 投影**：items[] {dispute_id, status, dispute_amount, reason,
 *    create_time} → redacted 行。
 * 5. **customers = refused{unsupported_operation}**：官方商户 REST API 无
 *    customers 列举端点（provider 缺席事实，pin 在案）。
 * 6. **金额换算纪律**：ISO 4217 指数换算（无浮点）；精度丢失（小数位 > 指数）
 *    或表外货币 → 类别 unavailable（诚实 fail-closed，绝不截断/猜）。
 * 7. **托管标记凭据 → typed unavailable 零触达**（数据面托管代理是 v1.3）。
 * 8. **结局映射**：401 = 唯一 auth-failed；403 → refused{insufficient_permission}；
 *    其余 → unavailable。
 */

import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  payswapReadonlyCategoryResultSchemas,
} from "@zcode/shared/payswap";
import { createPaypalAccountDataReadPort } from "@zcode/services/node";
import { describe, expect, it } from "vitest";

const CLIENT_ID = "AeTestDataClientId12345678901234567890";
const CLIENT_SECRET = "EXTestDataClientSecret1234567890123456789012345678";
const SANDBOX_TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const APP_ID = "APP-80W284485P519543T";
const TOKEN_RESPONSE = {
  scope: "https://uri.paypal.com/services/reporting/search/read",
  access_token: "A21AAFE0unittest0token0value000000000000",
  token_type: "Bearer",
  app_id: APP_ID,
  expires_in: 31668,
  nonce: "nonce",
};
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

function tokenThenData(dataHandler: (path: string) => Promise<Response> | Response) {
  return recordingApiClient((input) => {
    if (input.includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
    return dataHandler(input);
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "paypal",
    mode: "test" as const,
    secretKind: "client-secret" as const,
    secret: CLIENT_SECRET,
    clientId: CLIENT_ID,
    category: "payment_objects" as const,
    ...overrides,
  };
}

describe("payswap paypal data-read adapter (P3 provider half) — token exchange + wire shape", () => {
  it("exchanges the token first (POST token endpoint, Basic pair, form grant) then rides the Bearer token on the reporting endpoint", async () => {
    const calls: Array<{ input: string; init?: ApiRequestInit }> = [];
    const client: RecordingApiClient = {
      calls,
      async request(input, init) {
        calls.push({ input: String(input), init });
        if (String(input).includes("/v1/oauth2/token")) {
          return jsonResponse(200, TOKEN_RESPONSE);
        }
        return jsonResponse(200, { transaction_details: [] });
      },
    };
    const port = createPaypalAccountDataReadPort({ apiClient: client, timeoutMs: 4321 });
    const result = await port(baseInput({ category: "payment_objects" }));
    expect(result.status).toBe("ok");
    expect(payswapReadonlyCategoryResultSchemas.payment_objects.safeParse(result).success).toBe(true);
    // token 交换形状：POST token 端点 + Basic 凭据对 + form grant。
    const tokenCall = calls[0];
    expect(tokenCall?.input).toBe(SANDBOX_TOKEN_URL);
    expect(tokenCall?.init?.method).toBe("POST");
    const expectedBasic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64");
    expect((tokenCall?.init?.headers as Record<string, string>)?.Authorization).toBe(`Basic ${expectedBasic}`);
    expect((tokenCall?.init?.headers as Record<string, string>)?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCall?.init?.body).toBe("grant_type=client_credentials");
    // 数据端点形状：GET reporting 端点 + Bearer token（绝不复用 Basic 凭据对）。
    const dataCall = calls[1];
    expect(dataCall?.init?.method).toBe("GET");
    expect((dataCall?.init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN_RESPONSE.access_token}`);
    expect(dataCall?.init?.timeoutMs).toBe(4321);
  });

  it("the token is cached in the port closure (same credentials + unexpired = reused; never persisted or projected)", async () => {
    const calls: Array<{ input: string; init?: ApiRequestInit }> = [];
    const client: RecordingApiClient = {
      calls,
      async request(input, init) {
        calls.push({ input: String(input), init });
        if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
        return jsonResponse(200, { items: [] });
      },
    };
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    await port(baseInput({ category: "disputes" }));
    await port(baseInput({ category: "disputes" }));
    const tokenCalls = calls.filter((c) => c.input.includes("/v1/oauth2/token")).length;
    expect(tokenCalls).toBe(1);
  });
});

describe("payswap paypal data-read adapter (P3 provider half) — category projections", () => {
  it("payment_objects: /v1/reporting/transactions (31-day window) projects the official item with ISO 4217 minor-unit conversion and no PII payload fields", async () => {
    const officialItem = {
      transaction_info: {
        transaction_id: "5XY12345678901234",
        transaction_status: "S",
        transaction_amount: { currency_code: "USD", value: "10.99" },
        transaction_initiation_date: "2026-11-20T09:14:24.000Z",
        transaction_subject: "Payment for order 42",
        payer_info: { email_address: "pii@example.com" },
        shipping_info: { name: "Pii Person" },
      },
    };
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, { transaction_details: [officialItem], total_items: 1 });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "payment_objects" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = result.data as readonly unknown[];
      expect(rows).toEqual([
        {
          id: "5XY12345678901234",
          amount: "1099",
          currency: "USD",
          status: "S",
          created: Math.floor(Date.parse("2026-11-20T09:14:24.000Z") / 1000),
          description: "Payment for order 42",
        },
      ]);
      const serialized = JSON.stringify(rows);
      expect(serialized.includes("pii@example.com")).toBe(false);
      expect(serialized.includes("Pii Person")).toBe(false);
    }
    expect(payswapReadonlyCategoryResultSchemas.payment_objects.safeParse(result).success).toBe(true);
  });

  it("disputes: items[] projects into the redacted dispute schema (amount minor-unit converted, reason carried)", async () => {
    const officialItem = {
      dispute_id: "PP-D-27804",
      status: "OPEN",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      create_time: "2026-11-01T10:00:00.000Z",
      update_time: "2026-11-05T10:00:00.000Z",
      dispute_amount: { currency_code: "USD", value: "25.50" },
      dispute_life_cycle_stage: "INQUIRY",
    };
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, { items: [officialItem] });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "disputes" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = result.data as readonly unknown[];
      expect(rows).toEqual([
        {
          id: "PP-D-27804",
          amount: "2550",
          currency: "USD",
          status: "OPEN",
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          created: Math.floor(Date.parse("2026-11-01T10:00:00.000Z") / 1000),
        },
      ]);
    }
    expect(payswapReadonlyCategoryResultSchemas.disputes.safeParse(result).success).toBe(true);
  });

  it("balance: /v1/reporting/balances projects available_balance (total_balance fallback) with pending: [] as the explicit absence projection", async () => {
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, {
        balances: [
          {
            currency: "USD",
            primary: true,
            total_balance: { currency_code: "USD", value: "100.00" },
            available_balance: { currency_code: "USD", value: "95.00" },
            withheld_balance: { currency_code: "USD", value: "5.00" },
          },
          { currency: "JPY", total_balance: { currency_code: "JPY", value: "10000" }, available_balance: { currency_code: "JPY", value: "10000" } },
        ],
        last_refresh_time: "2026-11-20T00:00:00Z",
      });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({
        available: [
          { amount: "9500", currency: "USD" },
          { amount: "10000", currency: "JPY" },
        ],
        pending: [],
      });
    }
    expect(payswapReadonlyCategoryResultSchemas.balance.safeParse(result).success).toBe(true);
  });

  it("customers: refused{unsupported_operation} — PayPal's official merchant REST API has no customers listing endpoint (provider-absence fact, pinned)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, TOKEN_RESPONSE));
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "customers" }));
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.refusal.code).toBe("unsupported_operation");
      expect(result.refusal.message).toMatch(/no customers listing endpoint/i);
    }
    // 无数据端点触达 —— 只有 token 交换（ refuses 在端点调用之前）。
    expect(client.calls.filter((c) => c.input.includes("/v1/customer")).length).toBe(0);
  });

  it("currencies outside the pinned ISO 4217 exponent table refuse the category honestly (no fabricated conversion)", async () => {
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, {
        balances: [{ currency: "XYZ", total_balance: { currency_code: "XYZ", value: "10.00" } }],
      });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "balance" }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toMatch(/exponent table|currency/i);
    }
  });
});

describe("payswap paypal data-read adapter (P3 provider half) — outcome mapping + assembly guards", () => {
  it("401 on the token exchange is the only auth-failed evidence; everything else is unavailable (unknown ≠ expired)", async () => {
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(401, { error: "invalid_client" });
      return jsonResponse(200, { transaction_details: [] });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "payment_objects" }));
    expect(result.status).toBe("auth-failed");
    if (result.status === "auth-failed") {
      expect(result.detail).toMatch(/401/);
      expect(result.detail.includes(CLIENT_SECRET)).toBe(false);
    }
  });

  it("providerId ≠ 'paypal' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, TOKEN_RESPONSE));
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    await expect(port(baseInput({ providerId: "stripe" }))).rejects.toThrow(/paypal/i);
    expect(client.calls.length).toBe(0);
  });

  it("secretKind ≠ 'client-secret' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, TOKEN_RESPONSE));
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    await expect(port(baseInput({ secretKind: "client-id" }))).rejects.toThrow(/client-secret/i);
    expect(client.calls.length).toBe(0);
  });

  it("custodian-managed marker credentials are refused typed BEFORE any wire touch (token exchange needs the plaintext pair — the data-face custody proxy is the tracked v1.3 slice)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, TOKEN_RESPONSE));
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(
      baseInput({
        secret: "EXTestClientSecret_custodian-managed:payswap:psp:paypal:c1:client-secret",
        clientId: "AeTestClientId_custodian-managed:payswap:psp:paypal:c1:client-id",
      }),
    );
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toMatch(/custody|token\+data proxy/i);
      expect(result.detail.includes(CLIENT_SECRET)).toBe(false);
    }
    expect(client.calls.length).toBe(0);
  });

  it("precision loss (fractional digits beyond the ISO 4217 exponent) refuses the category honestly", async () => {
    const client = recordingApiClient((input) => {
      if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "5XY12345678901234",
              transaction_status: "S",
              transaction_amount: { currency_code: "USD", value: "10.999" },
              transaction_initiation_date: "2026-11-20T09:14:24.000Z",
            },
          },
        ],
      });
    });
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ category: "payment_objects" }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toMatch(/precision loss|unpinned currency/i);
    }
  });

  it("live mode targets the live host (operator-declared environment)", async () => {
    const calls: Array<{ input: string; init?: ApiRequestInit }> = [];
    const client: RecordingApiClient = {
      calls,
      async request(input, init) {
        calls.push({ input: String(input), init });
        if (String(input).includes("/v1/oauth2/token")) return jsonResponse(200, TOKEN_RESPONSE);
        return jsonResponse(200, { transaction_details: [] });
      },
    };
    const port = createPaypalAccountDataReadPort({ apiClient: client });
    const result = await port(baseInput({ mode: "live" }));
    expect(result.status).toBe("ok");
    const tokenCall = calls.find((c) => c.input.includes("/v1/oauth2/token"));
    expect(tokenCall?.input).toBe("https://api-m.paypal.com/v1/oauth2/token");
  });
});
