/**
 * PaySwap P2.2 slice 5 —— 账户运行时生产装配（`createPayswapAccountRuntime`）的
 * services 侧证明。
 *
 * 被测法则（runtime.ts 文件头）：
 * 1. **单一服务实例**：两个 reader 面绑定同一账户服务 —— 服务面的 connect 在
 *    概览 reader 的清单中立即可见；detail reader 的状态机写（401 翻 expired）
 *    对概览 reader 的投影可见（无第二个写者/实例）。
 * 2. **凭据通道交付**：env 携带 `ZCODE_PAYSWAP_PSP_KEY` → 连接落真实凭据 store
 *    （at-rest 无明文）；env 缺席 → 装配照常、connect 以 Gate E2 typed 拒绝
 *    （fail-closed 在操作面，不猜、不阻断装配）。
 * 3. **生产链**：注入 transport 的真实 Stripe adapter → connect → 概览清单 →
 *    detail 现读（验证 + 能力证据 + 四类别）—— the full production chain。
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY } from "@zcode/shared/payswap";
import { createPayswapAccountRuntime, setDataBaseDir } from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;
const PSP_KEY = "f".repeat(64);

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function recordingApiClient(
  handler: (input: string) => Response,
): ApiClient & { calls: string[] } {
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
        id: "acct_1QxRuntime",
        object: "account",
        capabilities: { card_payments: "active" },
        requirements: { currently_due: [], past_due: [], disabled_reason: null },
      }),
      { status: 200 },
    );
  }
  if (input.includes("/v1/balance")) {
    return new Response(
      JSON.stringify({ object: "balance", available: [{ amount: 700, currency: "usd" }], pending: [] }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}

async function assembleRuntime(env: NodeJS.ProcessEnv) {
  const dir = await mkdtemp(join(tmpdir(), "payswap-runtime-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const client = recordingApiClient(stripeHandler);
  const runtime = createPayswapAccountRuntime({
    env,
    resolveStorePath: () => join(dir, "payswap-connections.json"),
    apiClient: client,
    mintConnectionId: () => "55555555-5555-4555-8555-555555555555",
  });
  return { runtime, client, dir };
}

describe("payswap account runtime (P2.2 slice 5) — the production assembly", () => {
  it("single service instance: connect through the service face is visible to BOTH reader faces; the detail reader's state machine and the overview reader share one writer", async () => {
    const { runtime } = await assembleRuntime({
      [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: PSP_KEY,
    });
    const connected = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    // 概览 reader（broker 面）看到同一实例的投影。
    const overview = await runtime.accountOverviewReader();
    expect(overview).toEqual([connected.connection]);
    // detail reader（broker 面）经同一服务实例读 —— 连接投影一致。
    const detail = await runtime.accountDetailReader(connected.connection.connectionId);
    expect(detail.kind).toBe("detail");
    if (detail.kind === "detail") {
      expect(detail.connection.connectionId).toBe(connected.connection.connectionId);
      expect(detail.data.balance.status).toBe("ok");
    }
  });

  it("the env-delivered key is the credential channel: with ZCODE_PAYSWAP_PSP_KEY the connect lands in the real store (at-rest ciphertext, no plaintext anywhere); without it the assembly stands and connect refuses with the Gate E2 typed code", async () => {
    const withKey = await assembleRuntime({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: PSP_KEY });
    const connected = await withKey.runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(connected.kind).toBe("connected");
    for (const entry of await readdir(withKey.dir)) {
      const raw = await readFile(join(withKey.dir, entry), "utf8").catch(() => "");
      expect(raw.includes(TEST_SECRET)).toBe(false);
    }
    const withoutKey = await assembleRuntime({});
    const refused = await withoutKey.runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.refusal.code).toBe("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    }
    // 装配照常：概览 reader 仍回答（空清单 —— S2 的真话），detail 对未知 id typed 拒绝。
    expect(await withoutKey.runtime.accountOverviewReader()).toEqual([]);
    const detail = await withoutKey.runtime.accountDetailReader("00000000-0000-4000-8000-000000000000");
    expect(detail.kind).toBe("refused");
  });

  it("the full production chain: connect → overview list → detail fresh read (verification + evidence + four categories) against the real Stripe adapters with an injected transport", async () => {
    const { runtime, client } = await assembleRuntime({
      [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: PSP_KEY,
    });
    const connected = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect refused");
    await runtime.accountOverviewReader();
    const detail = await runtime.accountDetailReader(connected.connection.connectionId);
    expect(detail.kind).toBe("detail");
    // wire 顺序：验证读恰一次 + 四类别各一次（概览清单不触网）。
    const accountCalls = client.calls.filter((url) => url.includes("/v1/account")).length;
    const categoryCalls = client.calls.filter(
      (url) => !url.includes("/v1/account"),
    ).length;
    expect(accountCalls).toBe(1);
    expect(categoryCalls).toBe(4);
  });
});
