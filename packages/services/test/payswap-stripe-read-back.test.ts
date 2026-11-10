/**
 * PaySwap P2.2 slice 3 —— 真实 Stripe 读回 adapter（doc 06 §2.9 provider 运行时）
 * 的 services 侧证明（doc 04 §1.1 事实 + doc 05 §6.4 读回纪律）。
 *
 * 被测对象：`createStripeAccountReadBackPort`（`providers/stripe/readBackAccount.ts`）
 * —— shared 法则 `PayswapAccountReadBackPort` 的真实 Stripe 实现：
 *
 * 1. **verified 行**：200 + `{id: "acct_…"}` → `verified{providerAccountId}`；
 *    结局过法则 strict schema（`payswapAccountReadBackOutcomeSchema`）。
 * 2. **wire 形状**：`GET https://api.stripe.com/v1/account` + Bearer 秘密头 +
 *    timeoutMs 随 init（执行归 transport 实现 —— ApiClient 契约）。
 * 3. **auth-failed 行（唯一 expiry 证据）**：401 → `auth-failed`；detail 操作员
 *    可读、零秘密材料。
 * 4. **unavailable 行（unknown ≠ expired，doc 05 §6.4）**：403/429/5xx、非 JSON
 *    200、JSON 200 缺 id / id 非字符串、传输异常 —— 一律 `unavailable`，永不
 *    假装成功、永不假装 auth 失败；detail 零秘密。
 * 5. **装配防线（先于网络）**：providerId ≠ "stripe" / secretKind ≠ "api-key" →
 *    抛出（零网络触达）；秘密前缀模式与 input.mode 不一致 → `unavailable`
 *    （本地不一致，零网络触达 —— 无 provider 证据不翻状态）。
 * 6. **缺省 transport**：不注入 apiClient 时 = globalThis.fetch + AbortController
 *    超时执行（本地悬挂服务 + 100 ms 超时 → unavailable，永不悬挂）。
 * 7. **法则集成行**：真实 accountService + 真实连接记录 store + 真实凭据 store
 *    + 本 adapter（注入 transport）—— connect → 401 读回翻 expired → 200 读回
 *    翻回 connected（恢复行）；全程记录 store/凭据 store at-rest 无秘密明文回归。
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
  createStripeAccountReadBackPort,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;
const LIVE_SECRET = `sk_live_${"a1b2c3d4".repeat(6)}`;
const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";
const PROVIDER_ACCOUNT_ID = "acct_1QxTestReadBack";

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

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "stripe",
    mode: "test" as const,
    secretKind: "api-key" as const,
    secret: TEST_SECRET,
    ...overrides,
  };
}

describe("payswap stripe read-back adapter (P2.2 slice 3) — outcome law", () => {
  it("verified: 200 + account id → verified{providerAccountId}; the outcome parses against the law schema", async () => {
    const port = createStripeAccountReadBackPort({
      apiClient: recordingApiClient(() => jsonResponse(200, { id: PROVIDER_ACCOUNT_ID, object: "account" })),
    });
    const outcome = await port(baseInput());
    expect(outcome).toEqual({ kind: "verified", providerAccountId: PROVIDER_ACCOUNT_ID });
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("wire shape: GET https://api.stripe.com/v1/account, Bearer secret in the Authorization header only, timeoutMs rides init (enforcement is the transport's contract)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, { id: PROVIDER_ACCOUNT_ID }));
    const port = createStripeAccountReadBackPort({ apiClient: client, timeoutMs: 2500 });
    await port(baseInput());
    expect(client.calls.length).toBe(1);
    const call = client.calls[0];
    expect(call.input).toBe(STRIPE_ACCOUNT_URL);
    expect(call.init?.method).toBe("GET");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_SECRET}`);
    expect(call.init?.timeoutMs).toBe(2500);
    // 秘密在 init 的序列化里只出现在 Authorization 头一处 —— 无第二载体。
    expect(JSON.stringify(call.init).split(TEST_SECRET).length - 1).toBe(1);
  });

  it("auth-failed: 401 is the ONLY auth-failed evidence; the detail is operator-readable and secret-free", async () => {
    const port = createStripeAccountReadBackPort({
      apiClient: recordingApiClient(() => jsonResponse(401, { error: { type: "invalid_request_error" } })),
    });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("auth-failed");
    if (outcome.kind === "auth-failed") {
      expect(outcome.detail.length).toBeGreaterThan(0);
      expect(outcome.detail.includes(TEST_SECRET)).toBe(false);
    }
  });

  it("unavailable rows (unknown ≠ expired): non-200/401 statuses, malformed bodies, and transport failures never pretend success or auth failure", async () => {
    const rows: Array<{ label: string; respond: () => Promise<Response> }> = [
      { label: "403 (restricted key without account read)", respond: async () => jsonResponse(403, { error: {} }) },
      { label: "429 (rate limited)", respond: async () => jsonResponse(429, { error: {} }) },
      { label: "500 (provider fault)", respond: async () => jsonResponse(500, { error: {} }) },
      { label: "503 (provider unavailable)", respond: async () => jsonResponse(503, "oops") },
      { label: "200 non-JSON body", respond: async () => new Response("<html>not json</html>", { status: 200 }) },
      { label: "200 JSON without id", respond: async () => jsonResponse(200, { object: "account" }) },
      { label: "200 JSON with non-string id", respond: async () => jsonResponse(200, { id: 42 }) },
      { label: "200 JSON with empty id", respond: async () => jsonResponse(200, { id: "" }) },
      { label: "transport rejection", respond: async () => {
        throw new Error("socket hang up");
      } },
    ];
    for (const { label, respond } of rows) {
      const port = createStripeAccountReadBackPort({ apiClient: recordingApiClient(() => respond()) });
      const outcome = await port(baseInput());
      expect(outcome.kind, `row "${label}" must be unavailable`).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.detail.length).toBeGreaterThan(0);
        expect(outcome.detail.includes(TEST_SECRET), `row "${label}" detail must be secret-free`).toBe(false);
      }
    }
  });

  it("live-mode key reads back against the same endpoint (doc 04 §1.1: mode is key-prefix-distinguished, never a per-request switch)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, { id: "acct_live_readback" }));
    const port = createStripeAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput({ mode: "live", secret: LIVE_SECRET }));
    expect(outcome).toEqual({ kind: "verified", providerAccountId: "acct_live_readback" });
    expect(client.calls[0]?.input).toBe(STRIPE_ACCOUNT_URL);
  });
});

describe("payswap stripe read-back adapter (P2.2 slice 3) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'stripe' is a wiring bug: throws, zero transport calls (the account service maps it to read_back_unavailable, status unchanged)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, { id: PROVIDER_ACCOUNT_ID }));
    const port = createStripeAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ providerId: "paystack" }))).rejects.toThrow(/stripe/i);
    expect(client.calls.length).toBe(0);
  });

  it("secretKind ≠ 'api-key' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, { id: PROVIDER_ACCOUNT_ID }));
    const port = createStripeAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ secretKind: "client-secret" }))).rejects.toThrow(/api-key/i);
    expect(client.calls.length).toBe(0);
  });

  it("secret-prefix mode disagreeing with the record's mode is a local inconsistency: unavailable, zero transport calls (no provider evidence flips status)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, { id: PROVIDER_ACCOUNT_ID }));
    const port = createStripeAccountReadBackPort({ apiClient: client });
    // 记录声明 test 而存下的秘密是 live 前缀 —— 本地不一致，fail-closed 不触网。
    const outcome = await port(baseInput({ mode: "test", secret: LIVE_SECRET }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.length).toBeGreaterThan(0);
      expect(outcome.detail.includes(LIVE_SECRET)).toBe(false);
    }
    expect(client.calls.length).toBe(0);
  });
});

describe("payswap stripe read-back adapter (P2.2 slice 3) — default transport", () => {
  it("without an injected apiClient the port uses globalThis.fetch with AbortController timeout enforcement — a hanging endpoint answers unavailable, never hangs", async () => {
    const server = createServer(() => {
      /* 悬挂：接受连接后永不应答 */
    });
    spawnedServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a tcp listen address");
    }
    const port = createStripeAccountReadBackPort({
      accountUrl: `http://127.0.0.1:${address.port}/v1/account`,
      timeoutMs: 150,
    });
    const startedAt = Date.now();
    const outcome = await port(baseInput());
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.length).toBeGreaterThan(0);
      expect(outcome.detail.includes(TEST_SECRET)).toBe(false);
    }
  }, 10000);
});

describe("payswap stripe read-back adapter (P2.2 slice 3) — law integration (the real adapter drives the account-service state machine)", () => {
  it("connect → 401 read-back flips connected→expired → 200 read-back flips expired→connected (the recovery row), through the REAL port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p22-stripe-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    let stripeStatus = 401;
    const client = recordingApiClient(() =>
      stripeStatus === 401
        ? jsonResponse(401, { error: { type: "invalid_request_error" } })
        : jsonResponse(200, { id: PROVIDER_ACCOUNT_ID, object: "account" }),
    );
    const readBackAccount = createStripeAccountReadBackPort({ apiClient: client });
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({ env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "c".repeat(64) } }),
      connectionStore: createPayswapConnectionRecordStore({ resolveStorePath: () => connectionsPath }),
      readBackAccount,
    });

    const connected = await service.connect({ providerId: "stripe", operatorSecret: TEST_SECRET });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    const connectionId = connected.connection.connectionId;

    const expired = await service.refreshEvidence({ connectionId });
    expect(expired.kind).toBe("expired");

    stripeStatus = 200;
    const restored = await service.refreshEvidence({ connectionId });
    expect(restored.kind).toBe("verified");
    if (restored.kind === "verified") {
      expect(restored.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
      expect(restored.connection.status).toBe("connected");
    }

    // at-rest 回归：记录 store 永不携带秘密材料；两行读回各恰一次网络触达。
    const rawConnections = await readFile(connectionsPath, "utf-8");
    expect(rawConnections.includes(TEST_SECRET)).toBe(false);
    expect(client.calls.length).toBe(2);
  }, 15000);
});
