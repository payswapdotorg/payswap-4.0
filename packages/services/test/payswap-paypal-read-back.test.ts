/**
 * PaySwap P3 —— PayPal 读回 adapter（doc 06 §2.9 provider 运行时）的 services 侧
 * 证明（provider-facts/paypal.md P-1..P-6 + 第三批检索 2026-11-15 事实 +
 * doc 05 §6.4 读回纪律）。全部凭据为合成假值（零真实秘密、零写）。
 *
 * 被测对象：`createPayPalAccountReadBackPort`（`providers/paypal/readBackAccount.ts`
 * + 共享步 `providers/paypal/oauth2.ts`）—— shared 法则
 * `PayswapAccountReadBackPort` 的真实 PayPal 实现：
 *
 * 1. **verified 行**：200 token + 非空 `app_id`（官方样例字段，第三批检索在案）→
 *    `verified{providerAccountId}`；携 `scope`（P-2/P-6）时 evidence = 排序
 *    capabilities（全 active）+ 中性零值 requirements；结局过法则 strict schema。
 * 2. **wire 形状**（P-1/P-3）：`POST {mode base}/v1/oauth2/token` + HTTP Basic
 *    （base64(clientId:clientSecret)）+ `grant_type=client_credentials`
 *    （form-urlencoded）；test → api-m.sandbox.paypal.com、live → api-m.paypal.com。
 * 3. **auth-failed 行（唯一 expiry 证据，P-4）**：mint 401 → `auth-failed`；
 *    detail 操作员可读、零秘密材料（client id/secret 永不出现在 detail）。
 * 4. **unavailable 行（unknown ≠ expired）**：非 200/401、非 JSON 200、缺
 *    access_token / app_id、传输异常 —— 一律 `unavailable`；detail 零秘密。
 * 5. **装配防线（先于网络）**：providerId ≠ "paypal" / secrets 键集 ≠ 恰
 *    [client-id, client-secret] / 空秘密 → 抛出（零网络触达）。
 * 6. **缺省 transport**：不注入 apiClient 时 = globalThis.fetch + AbortController
 *    超时执行（本地悬挂服务 + 150 ms 超时 → unavailable，永不悬挂）。
 * 7. **法则集成行**：真实 accountService + 真实连接记录/凭据 store + 本 adapter
 *    （注入 transport）—— client-credentials connect（双秘密落盘）→ 401 mint 翻
 *    expired → 200 mint 翻回 connected（恢复行）；全程 at-rest 无秘密明文回归
 *    （client-id 与 client-secret 双键）。
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  createPayPalAccountReadBackPort,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_CLIENT_ID = "AYqNDTESTCLIENTIDPLACEHOLDER0000000000000000000";
const TEST_CLIENT_SECRET = "EGnJTESTCLIENTSECRETPLACEHOLDER00000000000000";
const PROVIDER_APP_ID = "APP-80W284485P519543T"; // 官方文档样例值（公开样例，非秘密）
const SANDBOX_TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const LIVE_TOKEN_URL = "https://api-m.paypal.com/v1/oauth2/token";

const createdDirs: string[] = [];
const spawnedServers: Server[] = [];

afterAll(async () => {
  for (const server of spawnedServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

/** 官方样例形态的 token 响应（第三批检索逐字对齐：scope/access_token/token_type/app_id/expires_in/nonce）。 */
function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    scope:
      "https://uri.paypal.com/services/reporting/balances/read https://uri.paypal.com/services/reporting/search/read openid",
    access_token: "A21AAFEpH4PsADK7qSS7pSRTESTTOKENPLACEHOLDER",
    token_type: "Bearer",
    app_id: PROVIDER_APP_ID,
    expires_in: 31668,
    nonce: "2020-04-03T15:35:36ZTESTNONCEPLACEHOLDER",
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "paypal",
    mode: "test" as const,
    secrets: { "client-id": TEST_CLIENT_ID, "client-secret": TEST_CLIENT_SECRET } as Record<
      string,
      string
    >,
    ...overrides,
  };
}

describe("payswap paypal read-back adapter (P3) — outcome law", () => {
  it("verified: 200 token + app_id + scope → verified{providerAccountId, evidence}; the outcome parses against the law schema", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody()));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome).toEqual({
      kind: "verified",
      providerAccountId: PROVIDER_APP_ID,
      evidence: {
        capabilities: [
          { name: "https://uri.paypal.com/services/reporting/balances/read", status: "active" },
          { name: "https://uri.paypal.com/services/reporting/search/read", status: "active" },
          { name: "openid", status: "active" },
        ],
        requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
      },
    });
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(client.calls.length).toBe(1);
  });

  it("verified without a scope list → verified with evidence omitted (all-or-nothing capture)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody({ scope: undefined })));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome).toEqual({ kind: "verified", providerAccountId: PROVIDER_APP_ID });
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("auth-failed: mint 401 (P-4 envelope) → the only expiry evidence; detail carries zero credential material", async () => {
    const client = recordingApiClient(() =>
      jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("auth-failed");
    if (outcome.kind === "auth-failed") {
      expect(outcome.detail.length).toBeGreaterThan(0);
      expect(outcome.detail.includes(TEST_CLIENT_ID)).toBe(false);
      expect(outcome.detail.includes(TEST_CLIENT_SECRET)).toBe(false);
    }
  });

  it("unavailable: non-200/401 mint statuses never pretend success or auth failure", async () => {
    for (const status of [403, 429, 500, 503]) {
      const client = recordingApiClient(() => jsonResponse(status, {}));
      const port = createPayPalAccountReadBackPort({ apiClient: client });
      const outcome = await port(baseInput());
      expect(outcome.kind).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.detail).toContain(String(status));
        expect(outcome.detail.includes(TEST_CLIENT_SECRET)).toBe(false);
      }
    }
  });

  it("unavailable: 200 with malformed bodies (non-JSON / missing access_token / missing app_id)", async () => {
    const cases: Array<{ label: string; respond: () => Response }> = [
      { label: "non-JSON", respond: () => new Response("not json", { status: 200 }) },
      { label: "missing access_token", respond: () => jsonResponse(200, tokenBody({ access_token: undefined })) },
      { label: "missing app_id", respond: () => jsonResponse(200, tokenBody({ app_id: undefined })) },
      { label: "empty app_id", respond: () => jsonResponse(200, tokenBody({ app_id: "  " })) },
    ];
    for (const { label, respond } of cases) {
      const client = recordingApiClient(respond);
      const port = createPayPalAccountReadBackPort({ apiClient: client });
      const outcome = await port(baseInput());
      expect(outcome.kind, label).toBe("unavailable");
    }
  });

  it("unavailable: transport failure (unknown ≠ expired)", async () => {
    const client = recordingApiClient(() => {
      throw new Error("ECONNRESET");
    });
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.includes(TEST_CLIENT_SECRET)).toBe(false);
    }
  });
});

describe("payswap paypal read-back adapter (P3) — wire shape (P-1/P-3)", () => {
  it("POSTs the spec token path with HTTP Basic + grant_type=client_credentials against the mode-resolved base URL", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody()));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    await port(baseInput());
    expect(client.calls.length).toBe(1);
    const call = client.calls[0];
    expect(call?.input).toBe(SANDBOX_TOKEN_URL);
    expect(call?.init?.method).toBe("POST");
    const expectedBasic = Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`, "utf8").toString("base64");
    expect((call?.init?.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${expectedBasic}`,
    );
    expect((call?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(call?.init?.body).toBe("grant_type=client_credentials");
  });

  it("live mode resolves the live base URL (P-3: sandbox and live are distinct apps/environments)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody()));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    await port(baseInput({ mode: "live" }));
    expect(client.calls[0]?.input).toBe(LIVE_TOKEN_URL);
  });
});

describe("payswap paypal read-back adapter (P3) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'paypal' / secret-kind set ≠ exactly [client-id, client-secret] throw with zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody()));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ providerId: "stripe" }))).rejects.toThrow(/paypal/i);
    await expect(port(baseInput({ secrets: { "api-key": "sk_test_x" } }))).rejects.toThrow(
      /client-id, client-secret/i,
    );
    await expect(
      port(
        baseInput({
          secrets: { "client-id": TEST_CLIENT_ID, "client-secret": TEST_CLIENT_SECRET, "api-key": "x" },
        }),
      ),
    ).rejects.toThrow(/client-id, client-secret/i);
    expect(client.calls.length).toBe(0);
  });

  it("empty secret values throw (credential store wiring defect)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, tokenBody()));
    const port = createPayPalAccountReadBackPort({ apiClient: client });
    await expect(
      port(baseInput({ secrets: { "client-id": "", "client-secret": TEST_CLIENT_SECRET } })),
    ).rejects.toThrow(/empty client-id/i);
    expect(client.calls.length).toBe(0);
  });
});

describe("payswap paypal read-back adapter (P3) — default transport", () => {
  it("without an injected apiClient the port uses globalThis.fetch with AbortController timeout enforcement — a hanging endpoint answers unavailable, never hangs", async () => {
    const server = createServer(() => {
      // 悬挂：永不回答 —— 必须被 150 ms 超时切断。
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    spawnedServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server address unavailable");
    }
    const port = createPayPalAccountReadBackPort({
      apiBaseOverride: `http://127.0.0.1:${address.port}`,
      timeoutMs: 150,
    });
    const startedAt = Date.now();
    const outcome = await port(baseInput());
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.includes(TEST_CLIENT_SECRET)).toBe(false);
    }
  }, 10000);
});

describe("payswap paypal read-back adapter (P3) — law integration (the real adapter drives the account-service state machine)", () => {
  it("client-credentials connect (two secrets at rest) → 401 mint flips connected→expired → 200 mint flips expired→connected (the recovery row), through the REAL port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paypal-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    let mintStatus = 401;
    const client = recordingApiClient(() =>
      mintStatus === 401
        ? jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" })
        : jsonResponse(200, tokenBody()),
    );
    const readBackAccount = createPayPalAccountReadBackPort({ apiClient: client });
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({
        env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "c".repeat(64) },
      }),
      connectionStore: createPayswapConnectionRecordStore({
        resolveStorePath: () => connectionsPath,
      }),
      readBackAccount,
    });

    const connected = await service.connect({
      providerId: "paypal",
      mode: "test",
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    expect(connected.connection.mode).toBe("test");
    expect(connected.connection.providerId).toBe("paypal");
    const connectionId = connected.connection.connectionId;

    const expired = await service.refreshEvidence({ connectionId });
    expect(expired.kind).toBe("expired");

    mintStatus = 200;
    const restored = await service.refreshEvidence({ connectionId });
    expect(restored.kind).toBe("verified");
    if (restored.kind === "verified") {
      expect(restored.providerAccountId).toBe(PROVIDER_APP_ID);
      expect(restored.connection.status).toBe("connected");
    }

    // at-rest 回归：记录 store 永不携带任何秘密材料（双键都不出现）。
    const rawConnections = await readFile(connectionsPath, "utf-8");
    expect(rawConnections.includes(TEST_CLIENT_ID)).toBe(false);
    expect(rawConnections.includes(TEST_CLIENT_SECRET)).toBe(false);
    expect(client.calls.length).toBe(2);
  }, 15000);
});
