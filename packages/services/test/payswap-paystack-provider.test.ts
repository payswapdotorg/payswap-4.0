/**
 * PaySwap P3 provider half —— Paystack 读回 adapter 与 provider 契约法则的
 * services 侧证明（PAYSWAP_PAYSTACK_EVIDENCE_PIN 的事实，官方检索 2026-11-20
 * 在案；doc 05 §6.4 读回纪律 + doc 05 §5 authSpec 法则）。
 *
 * 被测对象：
 * - `PAYSWAP_PAYSTACK_AUTH_SPEC` / `PAYSWAP_PAYSTACK_EVIDENCE_PIN`（shared 法则）；
 * - `createPaystackAccountReadBackPort`（`providers/paystack/readBackAccount.ts`）；
 * - `createPayswapAccountReadBackRouter`（per-provider 读回分发面）；
 * - 真实 accountService 的 Paystack connect/refresh 行（多 provider 契约）。
 *
 * 被测法则：
 * 1. **authSpec**：sk_test_/sk_live_ 前缀区分模式；formatCheck 拒绝 public key
 *    （pk_* — frontend-only，官方）与一切非 secret 形态；revoke = delete-local-only。
 * 2. **证据 pin 不变量**：官方 https 源、ISO 检索日期、非空已验证事实、非空
 *    再验证清单 —— 身份缺口项必须显式在案（verified 结局的 providerAccountId
 *    对 Paystack 无官方事实来源）。
 * 3. **读回 wire 形状**：GET https://api.paystack.co/balance + Bearer 秘密头 +
 *    timeoutMs 随 init。
 * 4. **auth-failed 行（唯一 expiry 证据）**：401 → `auth-failed`；detail 零秘密。
 * 5. **身份缺口行（P3 的诚实纪律）**：200 + 官方封套（status:true + data 数组）
 *    = 凭据被 provider 认证，但 verified 的 providerAccountId 无官方来源 ——
 *    显式 typed `unavailable`（状态不变；绝不伪造身份摘要；401 的 expiry 证据
 *    不受影响）。status 非 true / 非 JSON / data 非数组 / 非 200/401 / 传输异常
 *    一律 `unavailable`。
 * 6. **装配防线（先于网络）**：providerId/secretKind 错配 → 抛出（零触达）；
 *    **ADR-P2-3 custodian 标记凭据 → typed `unavailable` 零触达**（托管通道是
 *    Stripe 限定的 P2 已验收边界 —— Paystack 绝不借道）；前缀/记录模式不一致 →
 *    `unavailable` 零触达。
 * 7. **路由器**：按 providerId 分发；未注册 provider → 抛出（服务映射
 *    read_back_unavailable）。
 * 8. **法则集成行**：真实 accountService + 真实 store —— connect Paystack →
 *    401 读回翻 expired（安全行）→ 200 读回 = typed 拒绝、状态不变（身份缺口
 *    在连接面的呈现）；custodian 桥在位时 connect push 照常入托管、refresh 的
 *    标记凭据被零触达拒绝。
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  derivePayswapSecretKeyMode,
  PAYSWAP_PAYSTACK_AUTH_SPEC,
  PAYSWAP_PAYSTACK_EVIDENCE_PIN,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  PAYSWAP_STRIPE_AUTH_SPEC,
  payswapAccountReadBackOutcomeSchema,
} from "@zcode/shared/payswap";
import {
  createCredentialService,
  createPaystackAccountReadBackPort,
  createPayswapAccountReadBackRouter,
  createPayswapAccountRuntime,
  createPayswapAccountService,
  createPayswapConnectionRecordStore,
  createStripeAccountReadBackPort,
  CUSTODIAN_SECRET_MARKER,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"b2c3d4e5".repeat(6)}`;
const LIVE_SECRET = `sk_live_${"b2c3d4e5".repeat(6)}`;
const PUBLIC_KEY = `pk_test_${"b2c3d4e5".repeat(6)}`;
const PAYSTACK_BALANCE_URL = "https://api.paystack.co/balance";

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
    providerId: "paystack",
    mode: "test" as const,
    secretKind: "api-key" as const,
    secret: TEST_SECRET,
    ...overrides,
  };
}

const VALID_BALANCE_ENVELOPE = {
  status: true,
  message: "Balances retrieved",
  data: [{ currency: "NGN", balance: 1700000 }],
};

describe("PAYSWAP_PAYSTACK_AUTH_SPEC + evidence pin (P3 provider half — dated-evidence discipline)", () => {
  it("authSpec accepts only sk_test_/sk_live_ secret keys and derives the mode from the prefix", () => {
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.acquisition.formatCheck.test(TEST_SECRET)).toBe(true);
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.acquisition.formatCheck.test(LIVE_SECRET)).toBe(true);
    // public key（pk_*）是 frontend-only（官方）—— 绝不是连接秘密。
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.acquisition.formatCheck.test(PUBLIC_KEY)).toBe(false);
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.acquisition.formatCheck.test("")).toBe(false);
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.acquisition.formatCheck.test("sk_test_")).toBe(false);
    expect(derivePayswapSecretKeyMode(TEST_SECRET, PAYSWAP_PAYSTACK_AUTH_SPEC)).toBe("test");
    expect(derivePayswapSecretKeyMode(LIVE_SECRET, PAYSWAP_PAYSTACK_AUTH_SPEC)).toBe("live");
    expect(derivePayswapSecretKeyMode(PUBLIC_KEY, PAYSWAP_PAYSTACK_AUTH_SPEC)).toBe(null);
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.secretKinds).toEqual(["api-key"]);
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.revoke).toBe("delete-local-only");
    // 秘密种类与 Stripe 规格互不干扰（两 provider 并注册的形状前提）。
    expect(PAYSWAP_PAYSTACK_AUTH_SPEC.providerId).not.toBe(PAYSWAP_STRIPE_AUTH_SPEC.providerId);
  });

  it("the evidence pin carries https sources, an ISO retrieval date, verified facts and an explicit identity-gap re-verification item", () => {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    expect(PAYSWAP_PAYSTACK_EVIDENCE_PIN.providerId).toBe("paystack");
    expect(PAYSWAP_PAYSTACK_EVIDENCE_PIN.factsRetrievedAt).toMatch(ISO_DATE);
    for (const url of PAYSWAP_PAYSTACK_EVIDENCE_PIN.officialSourceUrls) {
      expect(url.startsWith("https://")).toBe(true);
    }
    expect(PAYSWAP_PAYSTACK_EVIDENCE_PIN.verifiedBoundaryFacts.length).toBeGreaterThan(0);
    expect(PAYSWAP_PAYSTACK_EVIDENCE_PIN.reverifyBeforeAdapterUse.length).toBeGreaterThan(0);
    const reverify = PAYSWAP_PAYSTACK_EVIDENCE_PIN.reverifyBeforeAdapterUse.join("\n");
    // 身份缺口必须显式在案 —— verified 的 providerAccountId 对 Paystack 无官方来源。
    expect(reverify).toMatch(/self-identity/i);
  });
});

describe("payswap paystack read-back adapter (P3 provider half) — outcome mapping", () => {
  it("401 is the only auth-failed evidence (official: unauthenticated requests fail 401)", async () => {
    const client = recordingApiClient(() => jsonResponse(401, { status: false, message: "Unauthorized" }));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("auth-failed");
    expect(outcome.kind === "auth-failed" ? outcome.detail : "").toMatch(/401/);
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(client.calls[0]?.input).toBe(PAYSTACK_BALANCE_URL);
  });

  it("the wire shape is GET https://api.paystack.co/balance with the Bearer secret header and the timeout passed through", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client, timeoutMs: 4321 });
    await port(baseInput());
    const call = client.calls[0];
    expect(call?.input).toBe(PAYSTACK_BALANCE_URL);
    expect(call?.init?.method).toBe("GET");
    const auth = (call?.init?.headers as Record<string, string>)?.Authorization;
    expect(auth).toBe(`Bearer ${TEST_SECRET}`);
    expect(call?.init?.timeoutMs).toBe(4321);
  });

  it("a successful balance read is NOT fabricated into a verified outcome: the official-API identity gap surfaces as typed unavailable (state unchanged, no invented account id)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      // 缺口必须可操作、诚实且零秘密材料。
      expect(outcome.detail).toMatch(/self-identity|identity/i);
      expect(outcome.detail.includes(TEST_SECRET)).toBe(false);
    }
    expect(payswapAccountReadBackOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(client.calls.length).toBe(1);
  });

  it("everything else on the wire is unavailable — unknown ≠ expired (status:false envelope, non-JSON 200, non-array data, non-200/401 status, transport failure)", async () => {
    const rows: Array<[string, () => Promise<Response> | Response]> = [
      ["status:false envelope", () => jsonResponse(200, { status: false, message: "error" })],
      ["non-JSON 200", async () => new Response("<html>not json</html>", { status: 200 })],
      ["data not an array", () => jsonResponse(200, { status: true, message: "x", data: { currency: "NGN" } })],
      ["403", () => jsonResponse(403, { status: false, message: "forbidden" })],
      ["500", () => jsonResponse(500, { status: false, message: "boom" })],
    ];
    for (const [label, handler] of rows) {
      const client = recordingApiClient(handler);
      const port = createPaystackAccountReadBackPort({ apiClient: client });
      const outcome = await port(baseInput());
      expect(outcome.kind, `row "${label}"`).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.detail.length, `row "${label}"`).toBeGreaterThan(0);
        expect(outcome.detail.includes(TEST_SECRET), `row "${label}" detail must be secret-free`).toBe(false);
      }
    }
    const failing: RecordingApiClient = {
      calls: [],
      async request() {
        throw new Error("connection reset");
      },
    };
    const port = createPaystackAccountReadBackPort({ apiClient: failing });
    const outcome = await port(baseInput());
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail.includes(TEST_SECRET)).toBe(false);
    }
  });

  it("live-mode key reads back against the same endpoint (the key determines the environment, never a per-request switch)", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput({ mode: "live", secret: LIVE_SECRET }));
    expect(outcome.kind).toBe("unavailable"); // 身份缺口同样适用于 live —— 不伪造身份。
    expect(client.calls[0]?.input).toBe(PAYSTACK_BALANCE_URL);
    const auth = (client.calls[0]?.init?.headers as Record<string, string>)?.Authorization;
    expect(auth).toBe(`Bearer ${LIVE_SECRET}`);
  });
});

describe("payswap paystack read-back adapter (P3 provider half) — assembly guards (before any wire)", () => {
  it("providerId ≠ 'paystack' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ providerId: "stripe" }))).rejects.toThrow(/paystack/i);
    expect(client.calls.length).toBe(0);
  });

  it("secretKind ≠ 'api-key' is a wiring bug: throws, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    await expect(port(baseInput({ secretKind: "client-secret" }))).rejects.toThrow(/api-key/i);
    expect(client.calls.length).toBe(0);
  });

  it("secret-prefix mode disagreeing with the record's mode is a local inconsistency: unavailable, zero transport calls", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    const outcome = await port(baseInput({ mode: "test", secret: LIVE_SECRET }));
    expect(outcome.kind).toBe("unavailable");
    expect(client.calls.length).toBe(0);
  });

  it("v1.2: the custodian-managed marker credential rides the injected transport (the wrapper forwards it to the custodian GET proxy with the per-host closed set) — the identity-gap outcome applies as usual", async () => {
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const port = createPaystackAccountReadBackPort({ apiClient: client });
    const markerSecret = "sk_test_custodian-managed:payswap:psp:paystack:c1:api-key";
    const outcome = await port(
      baseInput({ secret: markerSecret }),
    );
    // v1.2: the marker goes OUT as the Bearer (the production wrapper intercepts
    // marker-bearing requests and forwards them to the custodian GET proxy with
    // the per-host closed set — the adapter no longer pre-refuses).
    expect((client.calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe("Bearer " + markerSecret);
    expect(client.calls[0]?.input).toBe("https://api.paystack.co/balance");
    expect(outcome.kind).toBe("unavailable");
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
    const port = createPaystackAccountReadBackPort({
      balanceUrl: `http://127.0.0.1:${address.port}/balance`,
      timeoutMs: 150,
    });
    const startedAt = Date.now();
    const outcome = await port(baseInput());
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(outcome.kind).toBe("unavailable");
  }, 10000);
});

describe("payswap read-back router (P3 provider half) — per-provider dispatch", () => {
  it("dispatches by providerId and refuses unregistered providers (fail-closed throw — the account service maps it to read_back_unavailable)", async () => {
    let stripeHits = 0;
    let paystackHits = 0;
    const router = createPayswapAccountReadBackRouter({
      byProvider: {
        stripe: async () => {
          stripeHits += 1;
          return { kind: "verified", providerAccountId: "acct_router" };
        },
        paystack: async () => {
          paystackHits += 1;
          return { kind: "auth-failed", detail: "paystack 401" };
        },
      },
    });
    expect((await router(baseInput({ providerId: "stripe" }))).kind).toBe("verified");
    expect((await router(baseInput({ providerId: "paystack" }))).kind).toBe("auth-failed");
    expect(stripeHits).toBe(1);
    expect(paystackHits).toBe(1);
    await expect(router(baseInput({ providerId: "paypal" }))).rejects.toThrow(/paypal/i);
  });

  it("assembling the router with no adapters is a wiring bug: throws at assembly time", () => {
    expect(() => createPayswapAccountReadBackRouter({ byProvider: {} })).toThrow(/no provider adapters/i);
  });
});

describe("payswap paystack provider contract (P3 provider half) — law integration through the real account service", () => {
  it("connect Paystack (test mode) → 401 refresh flips connected→expired (the security row) → 200 refresh refuses typed and leaves the state unchanged (the identity gap)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paystack-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    let balanceStatus = 401;
    const client = recordingApiClient(() =>
      balanceStatus === 401
        ? jsonResponse(401, { status: false, message: "Unauthorized" })
        : jsonResponse(200, VALID_BALANCE_ENVELOPE),
    );
    const readBackAccount = createPaystackAccountReadBackPort({ apiClient: client });
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({ env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "d".repeat(64) } }),
      connectionStore: createPayswapConnectionRecordStore({ resolveStorePath: () => connectionsPath }),
      authSpecs: [PAYSWAP_STRIPE_AUTH_SPEC, PAYSWAP_PAYSTACK_AUTH_SPEC],
      readBackAccount,
    });

    const connected = await service.connect({ providerId: "paystack", operatorSecret: TEST_SECRET });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    expect(connected.connection.providerId).toBe("paystack");
    expect(connected.connection.mode).toBe("test");
    const connectionId = connected.connection.connectionId;

    // 安全行：401 是唯一的 expiry 证据 —— 吊销/轮换的键在刷新时被检出。
    const expired = await service.refreshEvidence({ connectionId });
    expect(expired.kind).toBe("expired");

    // 身份缺口行：200 读回（凭据有效）= typed 拒绝，状态不变 —— 绝不伪造身份。
    balanceStatus = 200;
    const refused = await service.refreshEvidence({ connectionId });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.refusal.code).toBe("read_back_unavailable");
    }

    // at-rest 回归：记录 store 永不携带秘密材料；读回各恰一次网络触达。
    const rawConnections = await readFile(connectionsPath, "utf-8");
    expect(rawConnections.includes(TEST_SECRET)).toBe(false);
    expect(client.calls.length).toBe(2);
  }, 15000);

  it("provider contract refusals: unknown provider → unsupported_provider; public key (pk_*) → validation_failed; the Stripe contract stays intact alongside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paystack-refusals-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const service = createPayswapAccountService({
      credentialPort: createCredentialService({ env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "e".repeat(64) } }),
      connectionStore: createPayswapConnectionRecordStore({
        resolveStorePath: () => join(dir, "payswap-connections.json"),
      }),
      authSpecs: [PAYSWAP_STRIPE_AUTH_SPEC, PAYSWAP_PAYSTACK_AUTH_SPEC],
    });
    const unknown = await service.connect({ providerId: "paypal", operatorSecret: TEST_SECRET });
    expect(unknown.kind).toBe("refused");
    if (unknown.kind === "refused") expect(unknown.refusal.code).toBe("unsupported_provider");
    const publicKey = await service.connect({ providerId: "paystack", operatorSecret: PUBLIC_KEY });
    expect(publicKey.kind).toBe("refused");
    if (publicKey.kind === "refused") expect(publicKey.refusal.code).toBe("validation_failed");
    // Stripe 契约保持原样（并存注册不改既有行为）。
    const stripe = await service.connect({ providerId: "stripe", operatorSecret: TEST_SECRET });
    expect(stripe.kind).toBe("connected");
  }, 15000);

  it("ADR-P2-3 custodian path (the REAL runtime wiring): the Paystack key is pushed into custody on connect (provider-agnostic custody), and the refresh's placeholder credential is refused before any wire touch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paystack-custodian-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const pushedEntries: Array<{ value: string; slot: string }> = [];
    const droppedSlots: string[] = [];
    const client = recordingApiClient(() => jsonResponse(200, VALID_BALANCE_ENVELOPE));
    const runtime = createPayswapAccountRuntime({
      env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "f".repeat(64) },
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      apiClient: client,
      custodianBridge: {
        push: async (key: string, slot?: string) => {
          pushedEntries.push({ value: key, slot: slot ?? "" });
        },
        get: async () => ({ status: 0, body: "no-key" }),
        drop: async (slot?: string) => {
          droppedSlots.push(slot ?? "");
        },
      },
    });
    const connected = await runtime.accountService.connect({ providerId: "paystack", operatorSecret: TEST_SECRET });
    expect(connected.kind).toBe("connected");
    // connect 走 custodian 凭据端口：save = push（密钥入命名槽 —— v1.1 槽名 =
    // 凭据存储键；托管本身 provider 无关；只有读回/数据面是 Stripe 限定的）。
    expect(pushedEntries).toHaveLength(1);
    expect(pushedEntries[0].value).toBe(TEST_SECRET);
    expect(pushedEntries[0].slot).toContain("payswap:psp:paystack:");
    if (connected.kind !== "connected") return;
    const refresh = await runtime.accountService.refreshEvidence({ connectionId: connected.connection.connectionId });
    // refresh 走占位标记凭据 → Paystack adapter 装配防线 typed 拒绝（零网络
    // 触达 —— Stripe 限定的托管代理通道绝不借道给 Paystack）。
    expect(refresh.kind).toBe("refused");
    if (refresh.kind === "refused") {
      expect(refresh.refusal.code).toBe("read_back_unavailable");
    }
    expect(client.calls.length).toBe(0);
    // revoke：custody drop（provider 无关的托管清除）+ 记录撤销。
    const revoked = await runtime.accountService.revoke({ connectionId: connected.connection.connectionId });
    expect(revoked.kind).toBe("revoked");
    // v1.1：revoke 按记录种类逐命名槽 drop（槽名 = 各自凭据存储键）。
    expect(droppedSlots).toHaveLength(1);
    expect(droppedSlots[0]).toContain("payswap:psp:paystack:");
  }, 15000);
});
