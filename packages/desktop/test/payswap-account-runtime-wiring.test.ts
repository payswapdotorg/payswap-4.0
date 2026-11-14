/**
 * PaySwap P2.2（ADR-P2-2 slice 6）—— desktop main 受监督账户运行时装配
 * （`packages/desktop/src/main/payswap/accountRuntimeWiring.ts`）的装配级证明。
 *
 * 被测法则（模块文件头）：
 * 1. **受监督运行时**：键可用性变化才重建（重建计数可观测）；钥匙串恢复/故障
 *    后无需重启 —— 桥请求路径内嵌 warmup 现读 + 按需重建（ADR-P2-2 Decision 2
 *    的端到端兑现）。
 * 2. **env 视图恰 warmup 产物**：无键 = 空 env 装配照常 + Gate E2 typed 拒绝
 *    在操作面（connect）；有键 = 连接落真实凭据 store（at-rest 无明文）。
 * 3. **fail-safe**：warmup 抛出 → onWarmupError 上报、空集 env 语义、readers
 *    照常应答（fail-closed 不阻断装配）。
 * 4. **serve = shared 桥法则**：概览/detail 经配对端口往返真实账户服务
 *    （法则级的另一级住 bootstrap/tests/payswap-account-reader-bridge.test.ts）。
 *
 * 装配级：真实 account service + 真实 Stripe adapters（注入 transport）+ 真实
 * 凭据/连接 store（临时目录）；键 store 与端口是注入 double；无 Electron。
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  createPayswapReaderBridgeClient,
  type PayswapReaderBridgePort,
} from "@zcode/shared/payswap";
import { setDataBaseDir } from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";
import { createPayswapDesktopAccountRuntime } from "../src/main/payswap/accountRuntimeWiring.js";

const TEST_SECRET = `sk_test_${"e5f6a7b8".repeat(6)}`;
const PSP_KEY = "a".repeat(64);

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doubles（键 store 可变翻转 —— 受监督重建的被测对象）
// ---------------------------------------------------------------------------

function mutableKeyStore() {
  const state = { key: null as string | null, error: null as Error | null };
  return {
    state,
    store: {
      ensureUnwrappedKey: async (): Promise<string | null> => {
        if (state.error) throw state.error;
        return state.key;
      },
    },
  };
}

function recordingApiClient(handler: (input: string) => Response): ApiClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(input: string | URL, _init?: ApiRequestInit) {
      calls.push(String(input));
      return handler(String(input));
    },
  };
}

function stripeHandler(input: string): Response {
  if (input.includes("/v1/account")) {
    return new Response(
      JSON.stringify({
        id: "acct_1QxWiring",
        object: "account",
        capabilities: { card_payments: "active" },
        requirements: { currently_due: [], past_due: [], disabled_reason: null },
      }),
      { status: 200 },
    );
  }
  if (input.includes("/v1/balance")) {
    return new Response(
      JSON.stringify({
        object: "balance",
        available: [{ amount: 900, currency: "usd" }],
        pending: [],
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}

function createPairedPorts(): [PayswapReaderBridgePort, PayswapReaderBridgePort] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  function makeSide(self: 0 | 1): PayswapReaderBridgePort {
    return {
      post(message) {
        const payload = structuredClone(message);
        queueMicrotask(() => {
          for (const listener of listeners[self === 0 ? 1 : 0]) listener(payload);
        });
      },
      subscribe(listener) {
        listeners[self].add(listener);
        return () => listeners[self].delete(listener);
      },
    };
  }
  return [makeSide(0), makeSide(1)];
}

async function assembleWiring(
  keyStore: { ensureUnwrappedKey: () => Promise<string | null> },
  options?: { onWarmupError?: (error: unknown) => void; clientTimeoutMs?: number },
) {
  const dir = await mkdtemp(join(tmpdir(), "payswap-wiring-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const runtime = createPayswapDesktopAccountRuntime({
    keyStore,
    onWarmupError: options?.onWarmupError,
    runtimeDependencies: {
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      apiClient: recordingApiClient(stripeHandler),
      mintConnectionId: () => "77777777-7777-4777-8777-777777777777",
    },
  });
  const [serverPort, clientPort] = createPairedPorts();
  const server = runtime.serve(serverPort);
  const client = createPayswapReaderBridgeClient({
    port: clientPort,
    timeoutMs: options?.clientTimeoutMs ?? 5_000,
    mintCallId: (() => {
      let n = 0;
      return () => `wiring-${(n += 1)}`;
    })(),
  });
  return { runtime, server, client, dir };
}

// ---------------------------------------------------------------------------

describe("payswap desktop account runtime wiring (ADR-P2-2 slice 6) — the supervised assembly", () => {
  it("no-key boot is fail-safe and honest: assembly stands, overview answers the empty list, detail answers typed refusal, connect refuses with the Gate E2 code (law 2/3)", async () => {
    const keys = mutableKeyStore();
    const { runtime, client } = await assembleWiring(keys.store);
    expect((await runtime.warmup()).keyAvailable).toBe(false);
    expect(await client.accountOverviewReader()).toEqual([]);
    const detail = await client.accountDetailReader("00000000-0000-4000-8000-000000000000");
    expect(detail.kind).toBe("refused");
    const service = await runtime.getRuntime();
    const refused = await service.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.refusal.code).toBe("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    }
    expect(runtime.runtimeRebuilds).toBe(1); // 首装配恰一次；键状态未变不再建
  });

  it("recovery without restart: the key appearing rebuilds on the next bridge call, connect then lands at-rest ciphertext, and the full chain answers detail through the bridge (law 1/2/4)", async () => {
    const keys = mutableKeyStore();
    const { runtime, client, dir } = await assembleWiring(keys.store);
    expect(await client.accountOverviewReader()).toEqual([]); // 无键装配
    keys.state.key = PSP_KEY; // 钥匙串恢复
    expect(await client.accountOverviewReader()).toEqual([]); // 触发重建（清单仍空）
    expect(runtime.runtimeRebuilds).toBe(2);
    const service = await runtime.getRuntime();
    const connected = await service.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(connected.kind).toBe("connected");
    // at-rest：目录内任何文件无明文秘密。
    for (const entry of await readdir(dir)) {
      const raw = await readFile(join(dir, entry), "utf8").catch(() => "");
      expect(raw.includes(TEST_SECRET)).toBe(false);
    }
    // 桥上的完整生产链：概览现读 → detail（验证 + 证据 + 四类别）。
    const overview = await client.accountOverviewReader();
    expect(overview).toEqual([connected.connection]);
    const detail = await client.accountDetailReader(connected.connection.connectionId);
    expect(detail.kind).toBe("detail");
    if (detail.kind === "detail") {
      expect(detail.connection.connectionId).toBe(connected.connection.connectionId);
      expect(detail.data.balance.status).toBe("ok");
    }
    expect(runtime.runtimeRebuilds).toBe(2); // 键状态稳定 —— 同一实例（单写者）
  });

  it("warmup failure is fail-safe: reported via onWarmupError, empty-env semantics (fail-closed), readers keep answering (law 3)", async () => {
    const keys = mutableKeyStore();
    keys.state.key = PSP_KEY;
    const errors: unknown[] = [];
    const { runtime, client } = await assembleWiring(keys.store, {
      onWarmupError: (error) => errors.push(error),
    });
    expect(await client.accountOverviewReader()).toEqual([]);
    expect(runtime.runtimeRebuilds).toBe(1);
    keys.state.error = new Error("keychain locked");
    expect(await client.accountOverviewReader()).toEqual([]); // 服务面照常应答
    expect(errors.length).toBeGreaterThan(0); // 故障可见
    // 键可用性翻转（true → false〔故障语义〕）→ 重建恰一次；readers 诚实。
    expect(runtime.runtimeRebuilds).toBe(2);
    const service = await runtime.getRuntime();
    const refused = await service.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(refused.kind).toBe("refused"); // fail-closed：故障不猜、不半开
    if (refused.kind === "refused") {
      expect(refused.refusal.code).toBe("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    }
    // 故障恢复（同一装配）：键回到可用 → 下一个请求重建回有键运行时。
    keys.state.error = null;
    expect(await client.accountOverviewReader()).toEqual([]);
    expect(runtime.runtimeRebuilds).toBe(3);
  });

  it("server.stop() unsubscribes: no further responses (the bridge client times out)", async () => {
    const keys = mutableKeyStore();
    keys.state.key = PSP_KEY;
    const { server, client } = await assembleWiring(keys.store, { clientTimeoutMs: 100 });
    expect(await client.accountOverviewReader()).toEqual([]);
    server.stop();
    await expect(client.accountOverviewReader()).rejects.toMatchObject({ code: "timeout" });
  });
});
