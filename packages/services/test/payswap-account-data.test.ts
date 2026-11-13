/**
 * PaySwap P2.2（ADR-P2-1）—— 只读数据面 services 侧证明。
 *
 * 被测对象：
 * 1. `createStripeAccountDataReadPort`（`providers/stripe/readAccountData.ts`）——
 *    四闭集类别的真实 Stripe 只读 adapter：
 *    - **ok 行**：200 → strict redacted 解析（余额 minor-unit、支付对象/客户/争议
 *      白名单字段；PII（email/name）永不拷贝 —— redaction-by-construction）；
 *    - **wire 形状**：全部 GET（no-write 的 wire 证明）+ Bearer + 正确类别路径
 *      （limit=10 固定近因窗口）+ 秘密恰一次（序列化 init 中）；
 *    - **结局映射**：401 → auth-failed（唯一拒绝证据）；403 → refused
 *      {insufficient_permission}（restricted key 权限边界）；429/5xx/非 JSON/
 *      畸形 200 → unavailable（unknown ≠ failed）；
 *    - **装配防线**：providerId/secretKind/未知类别 → 抛出（零网络）；前缀模式
 *      与记录 mode 不一致 → unavailable（零网络）。
 * 2. 读回 adapter 的**能力证据捕获**（doc 04 §1.2）：200 + capabilities/requirements
 *    → verified 携证据（排序、计数摘要）；畸形/缺席 → verified 不携带（认证语义
 *    不受影响 —— 概览 detail 面 fail-closed 拒绝缺席证据）。
 * 3. `accountService.getOverviewData`（ADR-P2-1 编排半）：真实服务 + 真实 store +
 *    真实 adapter（注入 transport）—— 验证读状态机复用（401 翻 expired 且零类别
 *    读）、证据必需（缺席 → typed 拒绝）、四类别现读（403 → 该类别 typed 拒绝、
 *    其余 ok）、数据端口缺席 → 四类别诚实 unavailable、revoked/unknown 终态行。
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  payswapAccountReadBackOutcomeSchema,
} from "@zcode/shared/payswap";
import {
  createCredentialService,
  createPayswapAccountService,
  createPayswapConnectionRecordStore,
  createStripeAccountDataReadPort,
  createStripeAccountReadBackPort,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;
const PROVIDER_ACCOUNT_ID = "acct_1QxDataFace";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function dataInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "stripe",
    mode: "test" as const,
    secretKind: "api-key" as const,
    secret: TEST_SECRET,
    category: "balance" as const,
    ...overrides,
  };
}

/** /v1/account 的证据载荷（doc 04 §1.2 capabilities + requirements）。 */
function accountBody(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ACCOUNT_ID,
    object: "account",
    capabilities: { card_payments: "active", transfers: "pending" },
    requirements: { currently_due: ["person.birthday"], past_due: [], disabled_reason: null },
    ...overrides,
  };
}

describe("payswap stripe data-read adapter (ADR-P2-1) — ok rows with redaction-by-construction", () => {
  it("balance: 200 → ok{available,pending} minor-unit strings; result parses against the law schema", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(200, {
        object: "balance",
        available: [{ amount: 1200, currency: "usd", currency_types: ["bank_account"] }],
        pending: [{ amount: -50, currency: "eur" }],
      }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "balance" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({
        available: [{ amount: "1200", currency: "usd" }],
        pending: [{ amount: "-50", currency: "eur" }],
      });
    }
  });

  it("payment_objects: 200 list → ok rows (id/amount/currency/status/created/description); extra fields dropped", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(200, {
        object: "list",
        data: [
          {
            id: "ch_1QxData",
            amount: 1000,
            currency: "usd",
            status: "succeeded",
            created: 1731230000,
            description: "Invoice A",
            // 非白名单字段：存在于 provider 载荷、永不拷贝
            receipt_email: "someone@example.com",
            source: { brand: "visa" },
          },
        ],
      }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "payment_objects" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          id: "ch_1QxData",
          amount: "1000",
          currency: "usd",
          status: "succeeded",
          created: 1731230000,
          description: "Invoice A",
        },
      ]);
      expect(JSON.stringify(result.data).includes("someone@example.com")).toBe(false);
    }
  });

  it("customers: 200 list → ok rows carry ONLY id/created/description — email/name PII never copied (redaction-by-construction)", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(200, {
        object: "list",
        data: [
          {
            id: "cus_1QxData",
            created: 1731230100,
            description: "Retainer client",
            email: "client@example.com",
            name: "Alice Doe",
            phone: "+10000000000",
          },
        ],
      }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "customers" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        { id: "cus_1QxData", created: 1731230100, description: "Retainer client" },
      ]);
      const serialized = JSON.stringify(result.data);
      expect(serialized.includes("client@example.com")).toBe(false);
      expect(serialized.includes("Alice Doe")).toBe(false);
      expect(serialized.includes("+10000000000")).toBe(false);
    }
  });

  it("disputes: 200 list → ok rows (id/amount/currency/status/reason/created)", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(200, {
        object: "list",
        data: [
          {
            id: "dp_1QxData",
            amount: 500,
            currency: "usd",
            status: "needs_response",
            reason: "fraudulent",
            created: 1731230200,
            evidence: [{ url: "https://files.example.com/x.pdf" }],
          },
        ],
      }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "disputes" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          id: "dp_1QxData",
          amount: "500",
          currency: "usd",
          status: "needs_response",
          reason: "fraudulent",
          created: 1731230200,
        },
      ]);
      expect(JSON.stringify(result.data).includes("files.example.com")).toBe(false);
    }
  });
});

describe("payswap stripe data-read adapter (ADR-P2-1) — wire shape (all GET, Bearer, fixed recent window)", () => {
  it("every category request is GET with Bearer secret in the Authorization header only; paths and limit are the closed per-category map; the secret appears exactly once in the serialized init", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(200, { object: "balance", available: [], pending: [] }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const paths = {
      balance: "/v1/balance",
      payment_objects: "/v1/charges?limit=10",
      customers: "/v1/customers?limit=10",
      disputes: "/v1/disputes?limit=10",
    } as const;
    for (const category of Object.keys(paths) as Array<keyof typeof paths>) {
      await port(dataInput({ category }));
    }
    expect(client.calls.length).toBe(4);
    for (const [index, category] of (Object.keys(paths) as Array<keyof typeof paths>).entries()) {
      const call = client.calls[index];
      if (call === undefined) continue;
      expect(call.input).toBe(`https://api.stripe.com${paths[category]}`);
      expect(call.init?.method).toBe("GET");
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TEST_SECRET}`);
      expect(JSON.stringify(call.init).split(TEST_SECRET).length - 1).toBe(1);
    }
  });
});

describe("payswap stripe data-read adapter (ADR-P2-1) — outcome map (doc 05 §6.4/§6.6)", () => {
  it("401 → auth-failed (the only provider-rejection evidence on the data face)", async () => {
    const client = recordingApiClient(() => jsonResponse(401, { error: {} }));
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "customers" }));
    expect(result.status).toBe("auth-failed");
    if (result.status === "auth-failed") {
      expect(result.detail.includes(TEST_SECRET)).toBe(false);
    }
  });

  it("403 → refused{insufficient_permission} (restricted-key per-resource boundary, doc 04 §1.3)", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(403, { error: { code: "account_invalid" } }),
    );
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(dataInput({ category: "disputes" }));
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.refusal.code).toBe("insufficient_permission");
      expect(result.refusal.message.includes(TEST_SECRET)).toBe(false);
    }
  });

  it("unknown rows: 429/500/non-JSON 200/malformed 200 → unavailable (never success, never auth failure)", async () => {
    const cases: Array<{ label: string; respond: () => Response }> = [
      { label: "429", respond: () => jsonResponse(429, {}) },
      { label: "500", respond: () => jsonResponse(500, {}) },
      { label: "non-JSON 200", respond: () => new Response("not-json", { status: 200 }) },
      {
        label: "malformed 200 (charges row missing status)",
        respond: () =>
          jsonResponse(200, { object: "list", data: [{ id: "ch_1", amount: 1, currency: "usd", created: 1 }] }),
      },
      {
        label: "malformed 200 (balance non-array)",
        respond: () => jsonResponse(200, { object: "balance", available: "x", pending: [] }),
      },
    ];
    for (const testCase of cases) {
      const client = recordingApiClient(() => testCase.respond());
      const port = createStripeAccountDataReadPort({ apiClient: client });
      const result = await port(dataInput({ category: "payment_objects" }));
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("payswap stripe data-read adapter (ADR-P2-1) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'stripe' / secretKind ≠ 'api-key' / unknown category throw with zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, {}));
    const port = createStripeAccountDataReadPort({ apiClient: client });
    await expect(port(dataInput({ providerId: "paystack" }))).rejects.toThrow(/paystack/i);
    await expect(port(dataInput({ secretKind: "client-secret" }))).rejects.toThrow(/api-key/i);
    await expect(
      port(dataInput({ category: "transfers" as never })),
    ).rejects.toThrow(/unknown read category/i);
    expect(client.calls.length).toBe(0);
  });

  it("secret-prefix mode disagreeing with the record's mode → unavailable with zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, {}));
    const port = createStripeAccountDataReadPort({ apiClient: client });
    const result = await port(
      dataInput({ mode: "live", secret: `sk_test_${"e5f6g7h8".repeat(6)}` }),
    );
    expect(result.status).toBe("unavailable");
    expect(client.calls.length).toBe(0);
  });
});

describe("payswap stripe read-back adapter (ADR-P2-1) — capability evidence capture (doc 04 §1.2)", () => {
  it("200 with capabilities+requirements → verified carrying evidence (sorted capabilities, due-count summary, disabledReason)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, accountBody()));
    const port = createStripeAccountReadBackPort({ apiClient: client });
    const outcome = await port({
      providerId: "stripe",
      mode: "test",
      secretKind: "api-key",
      secret: TEST_SECRET,
    });
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") {
      expect(outcome.evidence).toEqual({
        capabilities: [
          { name: "card_payments", status: "active" },
          { name: "transfers", status: "pending" },
        ],
        requirements: { disabledReason: null, currentlyDueCount: 1, pastDueCount: 0 },
      });
      expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
  });

  it("malformed or absent capabilities/requirements → verified WITHOUT evidence (authentication semantics unaffected)", async () => {
    for (const body of [
      { id: PROVIDER_ACCOUNT_ID },
      { id: PROVIDER_ACCOUNT_ID, capabilities: {}, requirements: { currently_due: [], past_due: [] } },
      {
        id: PROVIDER_ACCOUNT_ID,
        capabilities: { card_payments: "active" },
        requirements: { currently_due: "x", past_due: [] },
      },
    ]) {
      const client = recordingApiClient(() => jsonResponse(200, body));
      const port = createStripeAccountReadBackPort({ apiClient: client });
      const outcome = await port({
        providerId: "stripe",
        mode: "test",
        secretKind: "api-key",
        secret: TEST_SECRET,
      });
      expect(outcome.kind).toBe("verified");
      if (outcome.kind === "verified") {
        expect(outcome.evidence).toBeUndefined();
      }
    }
  });
});

describe("payswap account service getOverviewData (ADR-P2-1) — the orchestration half", () => {
  interface Assembly {
    service: ReturnType<typeof createPayswapAccountService>;
    client: RecordingApiClient;
    connectionsPath: string;
    dir: string;
  }

  async function assemble(handler: (input: string) => Response): Promise<Assembly> {
    const dir = await mkdtemp(join(tmpdir(), "payswap-adr-p21-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    const client = recordingApiClient((input) => handler(input));
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({
        env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "c".repeat(64) },
      }),
      connectionStore: createPayswapConnectionRecordStore({
        resolveStorePath: () => connectionsPath,
      }),
      readBackAccount: createStripeAccountReadBackPort({ apiClient: client }),
      readAccountData: createStripeAccountDataReadPort({ apiClient: client }),
      mintConnectionId: () => "22222222-2222-4222-8222-222222222222",
    });
    return { service, client, connectionsPath, dir };
  }

  function dataHandler(input: string): Response {
    if (input.includes("/v1/account")) {
      return jsonResponse(200, accountBody());
    }
    if (input.includes("/v1/balance")) {
      return jsonResponse(200, { object: "balance", available: [{ amount: 2500, currency: "usd" }], pending: [] });
    }
    if (input.includes("/v1/charges")) {
      return jsonResponse(200, { object: "list", data: [] });
    }
    if (input.includes("/v1/customers")) {
      return jsonResponse(200, { object: "list", data: [] });
    }
    if (input.includes("/v1/disputes")) {
      return jsonResponse(200, { object: "list", data: [] });
    }
    throw new Error(`unexpected url ${input}`);
  }

  it("connect → getOverviewData answers kind=detail: fresh verification + capability evidence + four ok categories; at-rest stores carry no plaintext secret", async () => {
    const assembly = await assemble(dataHandler);
    const connected = await assembly.service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    const detail = await assembly.service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(detail.kind).toBe("detail");
    if (detail.kind === "detail") {
      expect(detail.connection.connectionId).toBe(connected.connection.connectionId);
      expect(detail.evidence.capabilities).toEqual([
        { name: "card_payments", status: "active" },
        { name: "transfers", status: "pending" },
      ]);
      for (const category of ["balance", "payment_objects", "customers", "disputes"] as const) {
        expect(detail.data[category].status).toBe("ok");
      }
      if (detail.data.balance.status === "ok") {
        expect(detail.data.balance.data.available).toEqual([{ amount: "2500", currency: "usd" }]);
      }
    }
    const connectionsRaw = await readFile(assembly.connectionsPath, "utf8");
    expect(connectionsRaw.includes(TEST_SECRET)).toBe(false);
    // at-rest 回归：凭据 store 落盘的任何文件都无明文秘密（文件名由
    // credentialService 内部布局决定 —— 扫描整个 base dir，不假设布局）。
    for (const entry of await readdir(assembly.dir)) {
      const raw = await readFile(join(assembly.dir, entry), "utf8").catch(() => "");
      expect(raw.includes(TEST_SECRET)).toBe(false);
    }
    // wire 顺序：一次 /v1/account 验证读 + 四类别各一次（全部现读）。
    const urls = assembly.client.calls.map((call) => call.input);
    expect(urls.filter((url) => url.includes("/v1/account")).length).toBe(1);
    expect(urls.filter((url) => url.includes("/v1/balance")).length).toBe(1);
  });

  it("verification 401 → kind=expired with the record flipped persisted; ZERO category reads happen (no data without a valid credential)", async () => {
    const assembly = await assemble(
      (input) =>
        input.includes("/v1/account")
          ? jsonResponse(401, { error: {} })
          : jsonResponse(500, {}),
    );
    const connected = await assembly.service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    const detail = await assembly.service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(detail.kind).toBe("expired");
    if (detail.kind === "expired") {
      expect(detail.connection.status).toBe("expired");
    }
    const listed = await assembly.service.listConnections();
    expect(listed[0]?.status).toBe("expired");
    const categoryCalls = assembly.client.calls.filter(
      (call) => !call.input.includes("/v1/account"),
    );
    expect(categoryCalls.length).toBe(0);
  });

  it("verified WITHOUT evidence → refused{read_back_unavailable} (the detail face refuses on absent evidence)", async () => {
    const assembly = await assemble((input) =>
      input.includes("/v1/account")
        ? jsonResponse(200, { id: PROVIDER_ACCOUNT_ID, object: "account" })
        : jsonResponse(200, { object: "balance", available: [], pending: [] }),
    );
    const connected = await assembly.service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    const detail = await assembly.service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(detail.kind).toBe("refused");
    if (detail.kind === "refused") {
      expect(detail.refusal.code).toBe("read_back_unavailable");
      expect(detail.refusal.message.includes(TEST_SECRET)).toBe(false);
    }
  });

  it("a 403 on one category → that category refused{insufficient_permission} while the others stay ok", async () => {
    const assembly = await assemble((input) => {
      if (input.includes("/v1/disputes")) {
        return jsonResponse(403, { error: { code: "account_invalid" } });
      }
      return dataHandler(input);
    });
    const connected = await assembly.service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    const detail = await assembly.service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(detail.kind).toBe("detail");
    if (detail.kind === "detail") {
      expect(detail.data.disputes.status).toBe("refused");
      if (detail.data.disputes.status === "refused") {
        expect(detail.data.disputes.refusal.code).toBe("insufficient_permission");
      }
      expect(detail.data.balance.status).toBe("ok");
      expect(detail.data.payment_objects.status).toBe("ok");
      expect(detail.data.customers.status).toBe("ok");
    }
  });

  it("revoked and unknown connections answer their terminal shapes with zero port calls", async () => {
    const assembly = await assemble(dataHandler);
    const connected = await assembly.service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    await assembly.service.revoke({ connectionId: connected.connection.connectionId });
    const callsBefore = assembly.client.calls.length;
    const revokedDetail = await assembly.service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(revokedDetail.kind).toBe("revoked");
    const unknownDetail = await assembly.service.getOverviewData({
      connectionId: "33333333-3333-4333-8333-333333333333",
    });
    expect(unknownDetail.kind).toBe("refused");
    if (unknownDetail.kind === "refused") {
      expect(unknownDetail.refusal.code).toBe("unknown_connection");
    }
    expect(assembly.client.calls.length).toBe(callsBefore);
  });

  it("data port absent → kind=detail with all four categories honestly unavailable (no invented data)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-adr-p21-nodata-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    const client = recordingApiClient((input) => dataHandler(input));
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({
        env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "c".repeat(64) },
      }),
      connectionStore: createPayswapConnectionRecordStore({
        resolveStorePath: () => connectionsPath,
      }),
      readBackAccount: createStripeAccountReadBackPort({ apiClient: client }),
      mintConnectionId: () => "44444444-4444-4444-8444-444444444444",
    });
    const connected = await service.connect({ providerId: "stripe", operatorSecret: TEST_SECRET });
    if (connected.kind !== "connected") throw new Error("connect refused");
    const detail = await service.getOverviewData({
      connectionId: connected.connection.connectionId,
    });
    expect(detail.kind).toBe("detail");
    if (detail.kind === "detail") {
      for (const category of ["balance", "payment_objects", "customers", "disputes"] as const) {
        expect(detail.data[category].status).toBe("unavailable");
      }
    }
    expect(client.calls.filter((call) => !call.input.includes("/v1/account")).length).toBe(0);
  });
});
