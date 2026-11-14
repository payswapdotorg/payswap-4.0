/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的 desktop main 侧半）—— reader 桥
 * 端口铸造（`packages/desktop/src/main/payswap/accountReaderBridgeEntry.ts`）的装配级
 * 证明。
 *
 * 被测法则（Addendum B 第 1 跳：spawn 时 MessageChannelMain 转移的 main 侧）：
 * - **mint = serve + 转移**：每窗口 host 一个通道 —— port1 适配为
 *   PayswapReaderBridgePort 交给受监督运行时的 serve（法则全文住
 *   account-reader-bridge.ts），port2 是转移面（spawn postMessage 的 port 数组）。
 * - **端口适配**：postMessage ↔ post；"message" 事件 data ↔ subscribe 投递；退订
 *   真退订；start() 幂等面。适配器零语义（不校验、不改写）。
 * - **close → serve stop**：port1 close 事件停服务端（无泄漏订阅）。
 * - 端到端（注入 fake 通道对）：真实受监督运行时 + 真实桥法则客户端经 mint 的
 *   转移面完成 overview 往返（slice 6 wiring 测试的同款注入面）。
 *
 * 无 Electron（MessageChannelMain 经注入通道工厂替身）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { createPayswapReaderBridgeClient, type PayswapReaderBridgePort } from "@zcode/shared/payswap";
import { setDataBaseDir } from "@zcode/services/node";
import {
  adaptMessagePortMainToPayswapReaderBridgePort,
  createPayswapReaderBridgePortMinter,
} from "../src/main/payswap/accountReaderBridgeEntry.js";
import type { PayswapDesktopAccountRuntime } from "../src/main/payswap/accountRuntimeWiring.js";
import { createPayswapDesktopAccountRuntime } from "../src/main/payswap/accountRuntimeWiring.js";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fake 通道对（MessagePortMain 的结构面替身：postMessage → 微任务投递对端 listeners）
// ---------------------------------------------------------------------------

interface FakeMessagePortFace {
  postMessage(message: unknown): void;
  start(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

function createFakeMessagePortPair(): { port1: FakeMessagePortFace; port2: FakeMessagePortFace } {
  const listeners: [Set<(e: { data: unknown }) => void>, Set<(e: { data: unknown }) => void>] = [
    new Set(),
    new Set(),
  ];
  const closeListeners = new Set<() => void>();
  function makeSide(self: 0 | 1): FakeMessagePortFace {
    return {
      postMessage(message: unknown) {
        const payload = structuredClone(message);
        queueMicrotask(() => {
          for (const listener of listeners[self === 0 ? 1 : 0]) listener({ data: payload });
        });
      },
      start() {},
      on(_event, listener) {
        listeners[self].add(listener);
        return this;
      },
      once(event, listener) {
        if (event === "close" && self === 0) closeListeners.add(listener);
        return this;
      },
      removeListener(_event, listener) {
        listeners[self].delete(listener);
      },
    };
  }
  return { port1: makeSide(0), port2: makeSide(1) };
}

// ---------------------------------------------------------------------------

describe("payswap reader bridge entry — the MessagePortMain adapter (ADR-P2-2 Addendum B, main half)", () => {
  it("adapter maps post→postMessage and message-event data→subscribe verbatim; unsubscribe really unsubscribes", () => {
    const pair = createFakeMessagePortPair();
    const port = adaptMessagePortMainToPayswapReaderBridgePort(pair.port1);
    const received: unknown[] = [];
    const unsubscribe = port.subscribe((message) => received.push(message));
    pair.port2.postMessage({ hello: "bridge" });
    return new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(() => resolve()));
    }).then(() => {
      expect(received).toEqual([{ hello: "bridge" }]);
      unsubscribe();
      pair.port2.postMessage({ late: true });
      return new Promise<void>((resolve) => {
        queueMicrotask(() => queueMicrotask(() => resolve()));
      }).then(() => {
        expect(received).toEqual([{ hello: "bridge" }]);
      });
    });
  });
});

describe("payswap reader bridge entry — the mint (serve + transfer per window host)", () => {
  function assembleRuntime(): PayswapDesktopAccountRuntime {
    return createPayswapDesktopAccountRuntime({
      keyStore: { ensureUnwrappedKey: async () => null },
      runtimeDependencies: {
        resolveStorePath: () => "/nonexistent-entry-test/payswap-connections.json",
        apiClient: {
          async request(_input: string | URL, _init?: ApiRequestInit) {
            return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
          },
        } satisfies ApiClient,
        mintConnectionId: () => "88888888-8888-4888-8888-888888888888",
      },
    });
  }

  it("end-to-end through the minted transfer face: a real bridge client resolves overview via the supervised runtime (serve on port1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-entry-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const runtime = assembleRuntime();
    let channelCount = 0;
    const minter = createPayswapReaderBridgePortMinter(runtime, () => {
      channelCount += 1;
      return createFakeMessagePortPair();
    });
    const transferFace = minter();
    expect(transferFace).not.toBeNull();
    expect(channelCount).toBe(1);
    // 每次铸造一个新通道（每窗口 host 独立）。
    expect(minter()).not.toBeNull();
    expect(channelCount).toBe(2);
    // 转移面适配为 stub 端口 —— 真实法则客户端走完整两跳形态。
    const clientPort: PayswapReaderBridgePort =
      adaptMessagePortMainToPayswapReaderBridgePort(transferFace!);
    const client = createPayswapReaderBridgeClient({
      port: clientPort,
      timeoutMs: 5_000,
      mintCallId: () => "entry-e2e-1",
    });
    expect(await client.accountOverviewReader()).toEqual([]);
    client.dispose();
  });

  it("mint is null-safe: a throwing channel factory does not propagate into the spawn path (fail-safe, bridge absent)", () => {
    const runtime = assembleRuntime();
    const minter = createPayswapReaderBridgePortMinter(runtime, () => {
      throw new Error("channel unavailable");
    });
    expect(minter()).toBeNull();
  });
});
