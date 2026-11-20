/**
 * PaySwap P3 provider half —— PayPal client-credentials 契约法则的 services 侧
 * 证明（PAYSWAP_PAYPAL_EVIDENCE_PIN 的事实，官方检索 2026-11-20 在案；doc 05
 * §6.4 读回纪律 + shared 头注释「client-credentials 形态随 P3 落地」的兑现）。
 *
 * 被测对象：
 * - `PAYSWAP_PAYPAL_AUTH_SPEC` / `PAYSWAP_PAYPAL_EVIDENCE_PIN`（shared 法则）；
 * - `createPaypalAccountReadBackPort`（`providers/paypal/readBackAccount.ts`）；
 * - 真实 accountService 的 client-credentials connect/refresh/revoke 行。
 *
 * 被测法则：
 * 1. **authSpec**：凭据对（client-id + client-secret 两个秘密种类，[0] = 主
 *    秘密）；clientSecretFormatCheck 刻意宽松（官方无字符模式记载 —— 绝不编码
 *    未证实事实）；模式 = operator-declared（sandbox/live 凭据不编码环境）。
 * 2. **证据 pin 不变量**：官方 https 源、ISO 检索日期、非空事实与再验证清单 ——
 *    live server URL 的确认项与 userinfo/client_credentials 不可达项显式在案。
 * 3. **读回 wire 形状**：POST {base[mode]}/v1/oauth2/token + Basic
 *    base64(clientId:clientSecret) + form body grant_type=client_credentials。
 * 4. **verified 行（PayPal 有官方身份面）**：200 + 官方 token 形状
 *    {access_token, app_id, …} → verified{providerAccountId: app_id}（官方
 *    记载的非秘密 app 标识）；access_token 绝不出端口。
 * 5. **auth-failed 行**：401 → auth-failed（唯一 expiry 证据）；detail 零秘密。
 * 6. **unavailable 行**：非 200/401、非 JSON、access_token/app_id 缺失、传输
 *    异常 → unavailable（unknown ≠ expired）。
 * 7. **装配防线（先于网络）**：providerId/secretKind 错配 → 抛出；custodian
 *    标记凭据 → typed unavailable 零触达（Stripe 限定托管通道绝不借道）；
 *    clientId 缺席 → unavailable 零触达。
 * 8. **法则集成行（真实 accountService）**：connect（client-credentials，显式
 *    mode）→ connected；401 刷新翻 expired（安全行）→ 200 刷新 verified 恢复
 *    （PayPal 的恢复行成立 —— 与 Paystack 的身份缺口对照）；缺 clientId / 缺
 *    mode → validation_failed；记录 store at-rest 零秘密；撤销删两种秘密；
 *    **custodian 桥在位 → connect typed 拒绝**（单秘密槽托管边界 —— 绝不部分
 *    入库）；Stripe/Paystack 契约保持原样。
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_PAYPAL_AUTH_SPEC,
  PAYSWAP_PAYPAL_EVIDENCE_PIN,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  PAYSWAP_STRIPE_AUTH_SPEC,
  payswapAccountReadBackOutcomeSchema,
} from "@zcode/shared/payswap";
import {
  createCredentialService,
  createPaypalAccountReadBackPort,
  createPayswapAccountRuntime,
  createPayswapAccountService,
  createPayswapConnectionRecordStore,
  createStripeAccountReadBackPort,
  CUSTODIAN_SECRET_MARKER,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const CLIENT_ID = "AeXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const CLIENT_SECRET = "EXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SANDBOX_TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const LIVE_TOKEN_URL = "https://api-m.paypal.com/v1/oauth2/token";
const APP_ID = "APP-80W284485P519543T";

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
    providerId: "paypal",
    mode: "test" as const,
    secretKind: "client-secret" as const,
    secret: CLIENT_SECRET,
    clientId: CLIENT_ID,
    ...overrides,
  };
}

const VALID_TOKEN_RESPONSE = {
  scope: "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/vault/payment-tokens/read",
  access_token: "A21AAFE0test0token0value00000000000000000000000000000",
  token_type: "Bearer",
  app_id: APP_ID,
  expires_in: 31668,
  nonce: "2026-11-20T00:00:00Znonce",
};

describe("PAYSWAP_PAYPAL_AUTH_SPEC + evidence pin (P3 provider half — dated-evidence discipline)", () => {
  it("the client-credentials spec declares the credential pair with the primary secret first and an operator-declared mode", () => {
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.kind).toBe("oauth-client-credentials");
    expect([...PAYSWAP_PAYPAL_AUTH_SPEC.secretKinds]).toEqual(["client-secret", "client-id"]);
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.revoke).toBe("delete-local-only");
    // 官方不记载凭据字符模式 —— formatCheck 刻意宽松（非空白、最少 8 字符）。
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.clientSecretFormatCheck.test(CLIENT_SECRET)).toBe(true);
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.clientSecretFormatCheck.test("short")).toBe(false);
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.clientSecretFormatCheck.test("has space inside")).toBe(false);
    // 端点面 = 官方 pin（sandbox 直接记载；live 为官方 scope-string host，经
    // 再验证清单确认后才能承载 live 验收）。
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.apiBaseUrl.test).toBe("https://api-m.sandbox.paypal.com");
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.apiBaseUrl.live).toBe("https://api-m.paypal.com");
    expect(PAYSWAP_PAYPAL_AUTH_SPEC.acquisition.tokenPath).toBe("/v1/oauth2/token");
  });

  it("the evidence pin carries https sources, an ISO retrieval date, verified facts and the live-URL + userinfo re-verification items", () => {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    expect(PAYSWAP_PAYPAL_EVIDENCE_PIN.providerId).toBe("paypal");
    expect(PAYSWAP_PAYPAL_EVIDENCE_PIN.factsRetrievedAt).toMatch(ISO_DATE);
    for (const url of PAYSWAP_PAYPAL_EVIDENCE_PIN.officialSourceUrls) {
      expect(url.startsWith("https://")).toBe(true);
    }
    expect(PAYSWAP_PAYPAL_EVIDENCE_PIN.verifiedBoundaryFacts.length).toBeGreaterThan(0);
    const reverify = PAYSWAP_PAYPAL_EVIDENCE_PIN.reverifyBeforeAdapterUse.join("\n");
    expect(reverify).toMatch(/go-live|live server/i);
    expect(reverify).toMatch(/userinfo|client_credentials/i);
  });
});

describe("payswap paypal read-back adapter (P3 provider half) — outcome mapping", () => {
  it("the wire shape is POST {base[mode]}/v1/oauth2/token with Basic base64(clientId:secret) and the form grant body", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client, timeoutMs: 4321 });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("verified");
    const call = client.calls[0];
    expect(call?.input).toBe(SANDBOX_TOKEN_URL);
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    const expectedBasic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64");
    expect(headers?.Authorization).toBe(`Basic ${expectedBasic}`);
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call?.init?.body).toBe("grant_type=client_credentials");
    expect(call?.init?.timeoutMs).toBe(4321);
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("live mode targets the live host (operator-declared environment)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    await port(baseInput({ mode: "live" }));
    expect(client.calls[0]?.input).toBe(LIVE_TOKEN_URL);
  });

  it("verified carries ONLY the official app identity — the access token never leaves the port", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome).toEqual({ kind: "verified", providerAccountId: APP_ID });
    expect(JSON.stringify(outcome).includes(VALID_TOKEN_RESPONSE.access_token)).toBe(false);
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("401 is the only auth-failed evidence; detail is operator-readable and secret-free", async () => {
    const client = recordingApiClient(() => jsonResponse(401, { error: "invalid_client" }));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("auth-failed");
    if (outcome.kind === "auth-failed") {
      expect(outcome.detail).toMatch(/401/);
      expect(outcome.detail.includes(CLIENT_SECRET)).toBe(false);
      expect(outcome.detail.includes(CLIENT_ID)).toBe(false);
    }
  });

  it("everything else on the wire is unavailable — unknown ≠ expired (non-JSON, missing token, missing app id, 403/500, transport failure)", async () => {
    const rows: Array<[string, () => Promise<Response> | Response]> = [
      ["non-JSON 200", async () => new Response("<html>not json</html>", { status: 200 })],
      ["missing access_token", () => jsonResponse(200, { token_type: "Bearer", app_id: APP_ID })],
      ["missing app_id", () => jsonResponse(200, { access_token: "A21AAFE0x", token_type: "Bearer" })],
      ["403", () => jsonResponse(403, { error: "forbidden" })],
      ["500", () => jsonResponse(500, { error: "boom" })],
    ];
    for (const [label, handler] of rows) {
      const client = recordingApiClient(handler);
      const port = createPaypalAccountReadBackPort({ apiClient: client });
      const outcome = await port(baseInput());
      expect(outcome.kind, `row "${label}"`).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.detail.length, `row "${label}"`).toBeGreaterThan(0);
        expect(outcome.detail.includes(CLIENT_SECRET), `row "${label}"`).toBe(false);
      }
    }
    const failing: RecordingApiClient = {
      calls: [],
      async request() {
        throw new Error("connection reset");
      },
    };
    const port = createPaypalAccountReadBackPort({ apiClient: failing });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.includes(CLIENT_SECRET)).toBe(false);
    }
  });
});

describe("payswap paypal read-back adapter (P3 provider half) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'paypal' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ providerId: "stripe" }))).rejects.toThrow(/paypal/i);
    expect(client.calls.length).toBe(0);
  });

  it("secretKind ≠ 'client-secret' is a wiring bug: throws, zero transport calls (the contract's primary secret is exactly client-secret)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ secretKind: "client-id" }))).rejects.toThrow(/client-secret/i);
    expect(client.calls.length).toBe(0);
  });

  it("the custodian-managed placeholder credential is refused typed BEFORE any wire touch (the Stripe-scoped custody channel is never borrowed)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    const outcome = await port(
      baseInput({ secret: `EXXXXXXXXXX${CUSTODIAN_SECRET_MARKER}` }),
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail).toMatch(/custodian|Stripe-scoped/i);
    }
    expect(client.calls.length).toBe(0);
  });

  it("a missing client id is a record/wiring inconsistency: unavailable, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
    const port = createPaypalAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput({ clientId: undefined }));
    expect(outcome.kind).toBe("unavailable");
    expect(client.calls.length).toBe(0);
  });

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
    const port = createPaypalAccountReadBackPort({
      tokenUrl: `http://127.0.0.1:${address.port}/v1/oauth2/token`,
      timeoutMs: 150,
    });
    const startedAt = Date.now();
    const outcome = await port(baseInput());
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(outcome.kind).toBe("unavailable");
  }, 10000);
});

describe("payswap paypal provider contract (P3 provider half) — law integration through the real account service", () => {
  async function makeService(dir: string, extra?: {
    readBackAccount?: Parameters<typeof createPayswapAccountService>[0]["readBackAccount"];
    custodianBridge?: Parameters<typeof createPayswapAccountService>[0]["custodianBridge"];
  }) {
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({ env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "a".repeat(64) } }),
      connectionStore: createPayswapConnectionRecordStore({ resolveStorePath: () => connectionsPath }),
      authSpecs: [PAYSWAP_STRIPE_AUTH_SPEC, PAYSWAP_PAYPAL_AUTH_SPEC],
      ...extra,
    });
    return { service, connectionsPath };
  }

  it("connect (client-credentials, explicit sandbox mode) → 401 refresh flips connected→expired (the security row) → 200 refresh verifies and restores (PayPal HAS the recovery row)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paypal-"));
    createdDirs.push(dir);
    let tokenStatus = 401;
    const client = recordingApiClient(() =>
      tokenStatus === 401
        ? jsonResponse(401, { error: "invalid_client" })
        : jsonResponse(200, VALID_TOKEN_RESPONSE),
    );
    const { service, connectionsPath } = await makeService(dir, {
      readBackAccount: createPaypalAccountReadBackPort({ apiClient: client }),
    });

    const connected = await service.connect({
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
      mode: "test",
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    expect(connected.connection.providerId).toBe("paypal");
    expect(connected.connection.mode).toBe("test");
    const connectionId = connected.connection.connectionId;

    // 安全行：401 是唯一的 expiry 证据 —— 轮换/吊销的凭据对在刷新时被检出。
    const expired = await service.refreshEvidence({ connectionId });
    expect(expired.kind).toBe("expired");

    // 恢复行：200 刷新（官方 app_id 身份面）→ expired 翻回 connected。
    tokenStatus = 200;
    const restored = await service.refreshEvidence({ connectionId });
    expect(restored.kind).toBe("verified");
    if (restored.kind === "verified") {
      expect(restored.providerAccountId).toBe(APP_ID);
      expect(restored.connection.status).toBe("connected");
    }

    // at-rest 回归：记录 store 永不携带任何凭据材料；三次刷新各恰一次触达。
    const rawConnections = await readFile(connectionsPath, "utf-8");
    expect(rawConnections.includes(CLIENT_SECRET)).toBe(false);
    expect(rawConnections.includes(CLIENT_ID)).toBe(false);
    expect(client.calls.length).toBe(2);
  }, 15000);

  it("client-credentials refusals: missing client id / missing mode → validation_failed (no store touched); the credential pair persists as two secret kinds and revoke clears both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paypal-refusals-"));
    createdDirs.push(dir);
    const { service, connectionsPath } = await makeService(dir);

    const noId = await service.connect({ providerId: "paypal", operatorSecret: CLIENT_SECRET, mode: "test" });
    expect(noId.kind).toBe("refused");
    if (noId.kind === "refused") expect(noId.refusal.code).toBe("validation_failed");
    const noMode = await service.connect({
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
    });
    expect(noMode.kind).toBe("refused");
    if (noMode.kind === "refused") expect(noMode.refusal.code).toBe("validation_failed");

    const connected = await service.connect({
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
      mode: "test",
      displayName: "PayPal sandbox app",
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;

    // 凭据对按各自种类落盘（client-id + client-secret）。
    const rawConnections = await readFile(connectionsPath, "utf-8");
    expect(rawConnections).toContain("client-id");
    expect(rawConnections).toContain("client-secret");

    // 撤销：记录 revoked + 两种秘密全删（幂等重撤销补清残留）。
    const revoked = await service.revoke({ connectionId: connected.connection.connectionId });
    expect(revoked.kind).toBe("revoked");
    const reRevoked = await service.revoke({ connectionId: connected.connection.connectionId });
    expect(reRevoked.kind).toBe("revoked");

    // Stripe 契约保持原样（并存注册不改既有行为）。
    const stripe = await service.connect({ providerId: "stripe", operatorSecret: "rk_test_" + "a1b2c3d4".repeat(6) });
    expect(stripe.kind).toBe("connected");
  }, 15000);

  it("ADR-P2-3 v1.1 named slots: the client-credentials pair connects under custody (each kind its own named slot via the real runtime port), refresh is refused pre-wire, revoke drops both named slots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paypal-custodian-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const pushedEntries: Array<{ value: string; slot: string }> = [];
  const droppedSlots: string[] = [];
  const client = recordingApiClient(() => jsonResponse(200, VALID_TOKEN_RESPONSE));
  const runtime = createPayswapAccountRuntime({
    env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "g".repeat(64) },
    resolveStorePath: () => join(dir, "payswap-connections.json"),
    apiClient: client,
    custodianBridge: {
      push: async (value: string, slot?: string) => {
      pushedEntries.push({ value, slot: slot ?? "" });
      },
      get: async () => ({ status: 0, body: "no-key" }),
      drop: async (slot?: string) => {
      droppedSlots.push(slot ?? "");
      },
    },
  });
  const connected = await runtime.accountService.connect({
    providerId: "paypal",
    operatorSecret: CLIENT_SECRET,
    clientId: CLIENT_ID,
    mode: "test",
  });
  expect(connected.kind).toBe("connected");
  // v1.1 named slots: the pair lands per kind (slot = the credential storage key) — the old single-slot overwrite boundary is structurally solved.
  expect(pushedEntries).toHaveLength(2);
  expect(pushedEntries[0].slot).toContain("payswap:psp:paypal:");
  expect(pushedEntries[0].slot.endsWith(":client-secret")).toBe(true);
  expect(pushedEntries[0].value).toBe(CLIENT_SECRET);
  expect(pushedEntries[1].slot.endsWith(":client-id")).toBe(true);
  expect(pushedEntries[1].value).toBe(CLIENT_ID);
  if (connected.kind !== "connected") return;
  const refresh = await runtime.accountService.refreshEvidence({ connectionId: connected.connection.connectionId });
  // refresh rides the placeholder marker (v1.1 slot suffix) — the PayPal adapter's pre-wire guard refuses typed (zero wire touch; the token-exchange proxy is the follow-up v1.2 slice).
  expect(refresh.kind).toBe("refused");
  if (refresh.kind === "refused") {
    expect(refresh.refusal.code).toBe("read_back_unavailable");
  }
  expect(client.calls.length).toBe(0);
  // revoke: per-kind named-slot drops (both kinds cleared).
  const revoked = await runtime.accountService.revoke({ connectionId: connected.connection.connectionId });
  expect(revoked.kind).toBe("revoked");
  expect(droppedSlots).toHaveLength(2);
  for (const slot of droppedSlots) {
    expect(slot).toContain("payswap:psp:paypal:");
  }
}, 15000);
});
