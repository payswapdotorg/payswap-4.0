/**
 * PaySwap P3 provider half —— Paystack 只读数据 adapter 与数据路由器法则的
 * services 侧证明（PAYSWAP_PAYSTACK_EVIDENCE_PIN 的事实，官方检索 2026-11-20
 * 在案；account-data.ts 文件头法则 —— 闭集类别、redaction-by-construction、
 * no-write、四值结局）。
 *
 * 被测法则：
 * 1. **wire 形状**：GET {base}/{官方类别端点}（balance|transaction|customer|
 *    dispute）+ Bearer 秘密头 + timeoutMs 随 init。
 * 2. **balance 投影**：官方 data:[{currency, balance(subunit 整数)}] →
 *    {available: [{amount: 字符串整数, currency}], pending: []}（官方无 pending
 *    概念 —— pending: [] 是显式缺席投影，绝不伪造条目）。
 * 3. **payment_objects 投影**：官方 transaction 条目 {id: number, amount: number,
 *    currency, status, created_at: ISO, message} → redacted 行（id/amount 字符串
 *    化、created_at → epoch 秒、description ← message）；PII（ip_address/
 *    metadata/authorization 等载荷字段）绝不投影。
 * 4. **customers 投影**：id ← customer_code；createdAt ISO → epoch 秒；
 *    **email/name/phone 绝不读取**（redaction-by-construction）。
 * 5. **disputes 诚实投影缺口**：官方条目无顶层 amount/currency/reason →
 *    `unavailable`（redacted schema 不容伪造；PIN 再验证清单在案）。
 * 6. **结局映射**：401 = 唯一 auth-failed；403 → refused{insufficient_permission}；
 *    非 200/401/403、status:false 封套、非 JSON、data 非数组、畸形条目
 *    （all-or-nothing）、传输异常 → unavailable。
 * 7. **装配防线（先于网络）**：providerId/secretKind 错配 → 抛出（零触达）；
 *    custodian 标记凭据 → unavailable 零触达；前缀/模式不一致 → unavailable
 *    零触达。
 * 8. **路由器**：按 providerId 分发；未注册 provider → 抛出（服务端映射
 *    honest unavailable）。
 */

import { createServer, type Server } from "node:http";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { payswapReadonlyCategoryResultSchemas } from "@zcode/shared/payswap";
import {
  createPaystackAccountDataReadPort,
  createPayswapAccountDataReadRouter,
  CUSTODIAN_SECRET_MARKER,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"c3d4e5f6".repeat(6)}`;

const spawnedServers: Server[] = [];

afterAll(async () => {
  for (const server of spawnedServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "paystack",
    mode: "test" as const,
    secretKind: "api-key" as const,
    secret: TEST_SECRET,
    category: "balance" as const,
    ...overrides,
  };
}

function makePort(handler: (input: string, init: ApiRequestInit | undefined) => Promise<Response> | Response) {
  const client = recordingApiClient(handler);
  return { port: createPaystackAccountDataReadPort({ apiClient: client }), client };
}

describe("payswap paystack data-read adapter (P3 provider half) — wire shape + projections", () => {
  it("balance: GET /balance projects the official entries with pending: [] as the explicit provider-absence projection", async () => {
    const { port, client } = makePort(() =>
      jsonResponse(200, { status: true, message: "Balances retrieved", data: [{ currency: "NGN", balance: 1700000 }] }),
    );
    const result = await port(baseInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({
        available: [{ amount: "1700000", currency: "NGN" }],
        pending: [],
      });
    }
    expect(payswapReadonlyCategoryResultSchemas.balance.safeParse(result).success).toBe(true);
    expect(client.calls[0]?.input).toBe("https://api.paystack.co/balance");
    expect((client.calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TEST_SECRET}`);
    expect(client.calls[0]?.init?.method).toBe("GET");
  });

  it("payment_objects: GET /transaction projects the official item (id/amount stringified, created_at → epoch seconds, description ← message) and never carries PII payload fields", async () => {
    const officialItem = {
      id: 4099260516,
      domain: "test",
      status: "success",
      reference: "re4lyvq3s3",
      amount: 40333,
      message: "Approved by the user",
      gateway_response: "Successful",
      created_at: "2024-08-22T09:14:24.000Z",
      channel: "card",
      currency: "NGN",
      ip_address: "10.0.0.1",
      customer: { email: "pii@example.com", first_name: "Pii" },
      authorization: { last4: "0008" },
    };
    const { port } = makePort(() => jsonResponse(200, { status: true, message: "Transactions retrieved", data: [officialItem] }));
    const result = await port(baseInput({ category: "payment_objects" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = result.data as readonly unknown[];
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.id).toBe("4099260516");
      expect(row.amount).toBe("40333");
      expect(row.currency).toBe("NGN");
      expect(row.status).toBe("success");
      expect(row.created).toBe(Math.floor(Date.parse("2024-08-22T09:14:24.000Z") / 1000));
      expect(row.description).toBe("Approved by the user");
      // redaction-by-construction：PII 载荷字段在投影之后不存在。
      const serialized = JSON.stringify(rows);
      expect(serialized.includes("pii@example.com")).toBe(false);
      expect(serialized.includes("10.0.0.1")).toBe(false);
      expect(serialized.includes("last4")).toBe(false);
    }
    expect(payswapReadonlyCategoryResultSchemas.payment_objects.safeParse(result).success).toBe(true);
  });

  it("customers: id ← customer_code, createdAt → epoch seconds, and PII (email/name/phone) is never read", async () => {
    const officialItem = {
      integration: 463433,
      first_name: "Pii",
      last_name: "Person",
      email: "pii@example.com",
      phone: "08000000000",
      domain: "test",
      customer_code: "CUS_c6wqvwmvwopw4ms",
      risk_action: "default",
      id: 90758908,
      createdAt: "2022-08-15T13:46:39.000Z",
      updatedAt: "2022-08-15T13:46:39.000Z",
    };
    const { port } = makePort(() => jsonResponse(200, { status: true, message: "Customers retrieved", data: [officialItem] }));
    const result = await port(baseInput({ category: "customers" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = result.data as readonly unknown[];
      expect(rows).toEqual([
        { id: "CUS_c6wqvwmvwopw4ms", created: Math.floor(Date.parse("2022-08-15T13:46:39.000Z") / 1000), description: null },
      ]);
      const serialized = JSON.stringify(rows);
      expect(serialized.includes("pii@example.com")).toBe(false);
      expect(serialized.includes("Pii")).toBe(false);
      expect(serialized.includes("08000000000")).toBe(false);
    }
    expect(payswapReadonlyCategoryResultSchemas.customers.safeParse(result).success).toBe(true);
  });

  it("disputes: the honest projection gap — the official items carry no top-level amount/currency/reason, so the category answers unavailable (no fabricated values)", async () => {
    const officialItem = {
      id: 2867,
      refund_amount: null,
      currency: null,
      status: "archived",
      resolution: null,
      domain: "test",
    };
    const { port } = makePort(() => jsonResponse(200, { status: true, message: "Disputes retrieved", data: [officialItem] }));
    const result = await port(baseInput({ category: "disputes" }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toMatch(/no top-level amount\/currency\/reason/i);
    }
  });
});

describe("payswap paystack data-read adapter (P3 provider half) — outcome mapping", () => {
  it("401 is the only auth-failed evidence; 403 maps to refused{insufficient_permission}", async () => {
    const { port: unauthorizedPort } = makePort(() => jsonResponse(401, { status: false, message: "Unauthorized" }));
    const unauthorized = await unauthorizedPort(baseInput({ category: "balance" }));
    expect(unauthorized.status).toBe("auth-failed");
    const { port: forbiddenPort } = makePort(() => jsonResponse(403, { status: false, message: "forbidden" }));
    const forbidden = await forbiddenPort(baseInput({ category: "customers" }));
    expect(forbidden.status).toBe("refused");
    if (forbidden.status === "refused") {
      expect(forbidden.refusal.code).toBe("insufficient_permission");
    }
  });

  it("everything else is unavailable — status:false envelope, non-JSON, non-array data, malformed entry (all-or-nothing), 500, transport failure", async () => {
    const rows: Array<[string, string, () => Promise<Response> | Response]> = [
      ["status:false", "balance", () => jsonResponse(200, { status: false, message: "error" })],
      ["non-JSON", "balance", async () => new Response("<html>not json</html>", { status: 200 })],
      ["data not array", "balance", () => jsonResponse(200, { status: true, data: { currency: "NGN" } })],
      ["malformed entry", "balance", () => jsonResponse(200, { status: true, data: [{ currency: "NGN", balance: "not-an-int" }] })],
      ["malformed created_at", "payment_objects", () => jsonResponse(200, { status: true, data: [{ id: 1, amount: 100, currency: "NGN", status: "success", created_at: "not-a-date", message: null }] })],
      ["500", "customers", () => jsonResponse(500, { status: false })],
    ];
    for (const [label, category, handler] of rows) {
      const { port } = makePort(handler);
      const result = await port(baseInput({ category: category as "balance" }));
      expect(result.status, `row "${label}"`).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.detail.length, `row "${label}"`).toBeGreaterThan(0);
        expect(result.detail.includes(TEST_SECRET), `row "${label}"`).toBe(false);
      }
    }
    const failing: RecordingApiClient = { calls: [], async request() { throw new Error("connection reset"); } };
    const port = createPaystackAccountDataReadPort({ apiClient: failing });
    const result = await port(baseInput({ category: "balance" }));
    expect(result.status).toBe("unavailable");
  });
});

describe("payswap paystack data-read adapter (P3 provider half) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'paystack' is a wiring bug: throws, zero transport calls", async () => {
    const { port, client } = makePort(() => jsonResponse(200, { status: true, data: [] }));
    await expect(port(baseInput({ providerId: "stripe" }))).rejects.toThrow(/paystack/i);
    expect(client.calls.length).toBe(0);
  });

  it("secretKind ≠ 'api-key' is a wiring bug: throws, zero transport calls", async () => {
    const { port, client } = makePort(() => jsonResponse(200, { status: true, data: [] }));
    await expect(port(baseInput({ secretKind: "client-secret" }))).rejects.toThrow(/api-key/i);
    expect(client.calls.length).toBe(0);
  });

  it("the custodian-managed placeholder credential is refused BEFORE any wire touch (the Stripe-scoped custody channel is never borrowed)", async () => {
    const { port, client } = makePort(() => jsonResponse(200, { status: true, data: [] }));
    const result = await port(baseInput({ secret: `sk_test_${CUSTODIAN_SECRET_MARKER}` }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toMatch(/custodian|Stripe-scoped/i);
    }
    expect(client.calls.length).toBe(0);
  });

  it("secret-prefix mode disagreeing with the record's mode is a local inconsistency: unavailable, zero transport calls", async () => {
    const { port, client } = makePort(() => jsonResponse(200, { status: true, data: [] }));
    const result = await port(baseInput({ mode: "test", secret: `sk_live_${"c3d4e5f6".repeat(6)}` }));
    expect(result.status).toBe("unavailable");
    expect(client.calls.length).toBe(0);
  });

  it("the real default transport enforces the timeout against a hanging endpoint (never hangs)", async () => {
    const server = createServer(() => {
      /* 悬挂 */
    });
    spawnedServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a tcp address");
    const port = createPaystackAccountDataReadPort({
      apiBase: `http://127.0.0.1:${address.port}`,
      timeoutMs: 150,
    });
    const startedAt = Date.now();
    const result = await port(baseInput({ category: "balance" }));
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.status).toBe("unavailable");
  }, 10000);
});

describe("payswap data-read router (P3 provider half) — per-provider dispatch", () => {
  it("dispatches by providerId; unregistered providers throw (the account service maps it to honest unavailable); an empty router is an assembly bug", async () => {
    let paystackHits = 0;
    const router = createPayswapAccountDataReadRouter({
      byProvider: {
        paystack: async () => {
          paystackHits += 1;
          return { status: "ok", data: { available: [], pending: [] } };
        },
      },
    });
    const result = await router(baseInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    expect(paystackHits).toBe(1);
    await expect(router(baseInput({ providerId: "paypal" }))).rejects.toThrow(/paypal/i);
    expect(() => createPayswapAccountDataReadRouter({ byProvider: {} })).toThrow(/no provider adapters/i);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
