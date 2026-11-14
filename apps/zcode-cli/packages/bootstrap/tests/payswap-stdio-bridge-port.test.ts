/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的 agent 侧半）—— stdio 帧适配器
 * （`payswap-broker/stdio-bridge-port.ts`）+ 串行队列旁路（`zcode-protocol/transport.ts`
 * 的 `consumeNotification`）的法则级证明。
 *
 * 被测法则（Addendum B 第 2 跳：窗口 host ↔ agent 既有 stdio 协议上的透明中继）：
 * - 桥消息作为**不透明载荷**双向转发：适配器 post → 通知帧 `{method, params}` 的
 *   params；入站桥方法通知 → params 原样投递订阅者（适配器不校验、不改写 —— zod
 *   校验只住真正的两端：agent stub 与 desktop main 服务端）。
 * - 非“请求/响应”形态的旁路：桥通知帧**不进** ZCodeProtocolNdjsonConnection 的串行
 *   处理队列（长请求 handler 未决时桥帧照常消费 —— get_account_overview 工具在生成
 *   请求 handler 内执行，桥响应若排队必然死锁，这是本旁路的成立判据）。
 * - 端到端：真实 stub（shared 桥法则客户端）经适配器 + 内存回环通知通道完成
 *   overview / detail（typed refusal 作数据透传）往返。
 *
 * 法则本体（shared 单一实现）住
 * `apps/zcode-cli/packages/bootstrap/tests/payswap-account-reader-bridge.test.ts`；
 * 窗口 host 侧中继（第 2 跳的另一半 + 第 1 跳端口）住
 * `packages/desktop/test/payswap-reader-bridge-relay.test.ts`。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
  createPayswapReaderBridgeClient,
  type PayswapReaderBridgeMessage,
} from "@zcode/shared/payswap";
import type { ZCodeProtocolNotification } from "@zcode/shared";
import { createPayswapStdioBridgePort } from "../src/payswap-broker/stdio-bridge-port.js";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

// ---------------------------------------------------------------------------
// 内存回环通知通道（agent 侧半：send 的帧由测试扮演窗口 host 中继消费/回送）
// ---------------------------------------------------------------------------

function createLoopbackNotificationChannel() {
  const sent: Array<{ method: string; params: unknown }> = [];
  return {
    sent,
    /** 测试扮演 host 中继：把一条桥消息作为通知帧回送给 agent（consumeNotification 面）。 */
    deliverFromHost: (payload: unknown) => ({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: payload,
    }) satisfies ZCodeProtocolNotification,
  };
}

// ---------------------------------------------------------------------------

describe("payswap stdio bridge port (ADR-P2-2 Addendum B — agent-side half)", () => {
  it("post maps to the carrier notification verbatim: send receives the bridge message object unchanged (transparent payload)", () => {
    const channel = createLoopbackNotificationChannel();
    const bridge = createPayswapStdioBridgePort({
      send: (payload) => channel.sent.push({ method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: payload }),
    });
    const request: PayswapReaderBridgeMessage = {
      kind: "payswap-account-reader-request",
      callId: "stdio-1",
      op: "overview",
    };
    bridge.port.post(request);
    expect(channel.sent).toEqual([
      { method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: request },
    ]);
  });

  it("consumeNotification consumes only the bridge method: params delivered to subscribers untouched, foreign notifications declined", () => {
    const channel = createLoopbackNotificationChannel();
    const received: unknown[] = [];
    const bridge = createPayswapStdioBridgePort({
      send: () => {},
    });
    const unsubscribe = bridge.port.subscribe((message) => received.push(message));
    expect(
      bridge.consumeNotification(channel.deliverFromHost({ any: "payload", callId: "x" })),
    ).toBe(true);
    expect(received).toEqual([{ any: "payload", callId: "x" }]);
    // 非桥方法：不消费（交还协议层正常分发）。
    expect(
      bridge.consumeNotification({ method: "process/mcpTelemetry", params: { x: 1 } }),
    ).toBe(false);
    expect(received).toEqual([{ any: "payload", callId: "x" }]);
    unsubscribe();
    expect(bridge.consumeNotification(channel.deliverFromHost({ late: true }))).toBe(true);
    expect(received).toEqual([{ any: "payload", callId: "x" }]);
  });

  it("dispose ends delivery: consumed notifications reach no one (stub dispose remains the pending-call authority)", () => {
    const channel = createLoopbackNotificationChannel();
    const received: unknown[] = [];
    const bridge = createPayswapStdioBridgePort({ send: () => {} });
    bridge.port.subscribe((message) => received.push(message));
    bridge.dispose();
    expect(bridge.consumeNotification(channel.deliverFromHost({ callId: "y" }))).toBe(true);
    expect(received).toEqual([]);
  });

  it("end-to-end over the notification shape: the real stub resolves overview (empty projection) and a typed-refusal detail — refusal travels as data", async () => {
    const channel = createLoopbackNotificationChannel();
    const bridge = createPayswapStdioBridgePort({
      send: (payload) => channel.sent.push({ method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: payload }),
    });
    const client = createPayswapReaderBridgeClient({
      port: bridge.port,
      timeoutMs: 1_000,
      mintCallId: () => `stdio-e2e-${Math.random().toString(36).slice(2)}`,
    });
    // 测试扮演 host 中继 + main 服务端：请求到达后按 callId 回送响应。
    const overviewPromise = client.accountOverviewReader();
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (channel.sent.length > 0) resolve();
        else queueMicrotask(poll);
      };
      poll();
    });
    const request = channel.sent[0]?.params as { callId: string; op: string };
    expect(request.op).toBe("overview");
    bridge.consumeNotification(
      channel.deliverFromHost({
        kind: "payswap-account-reader-response",
        callId: request.callId,
        op: "overview",
        ok: true,
        value: [],
      }),
    );
    expect(await overviewPromise).toEqual([]);

    // typed refusal 作数据：detail 拒绝原样跨 stdio 形态（stub 不吞不改）。
    const detailPromise = client.accountDetailReader("00000000-0000-4000-8000-000000000000");
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (channel.sent.length > 1) resolve();
        else queueMicrotask(poll);
      };
      poll();
    });
    const detailRequest = channel.sent[1]?.params as { callId: string; op: string };
    bridge.consumeNotification(
      channel.deliverFromHost({
        kind: "payswap-account-reader-response",
        callId: detailRequest.callId,
        op: "detail",
        ok: true,
        value: {
          kind: "refused",
          refusal: { code: "unknown_connection", message: "no such connection" },
        },
      }),
    );
    const detail = await detailPromise;
    expect(detail).toEqual({
      kind: "refused",
      refusal: { code: "unknown_connection", message: "no such connection" },
    });
    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// 串行队列旁路（transport.ts 的 consumeNotification）：长请求未决时桥帧照常消费
// ---------------------------------------------------------------------------

describe("ZCodeProtocolNdjsonConnection sideband consumption (the bridge frames bypass the serial queue)", () => {
  it("a bridge notification is consumed while a prior request handler is still pending (no queue, no deadlock)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const consumed: unknown[] = [];
    let releaseRequest: (() => void) | undefined;
    const requestHandled = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if ("id" in message && "method" in message) {
          await requestHandled; // 长请求 handler 悬置（模拟生成请求内的工具执行）
          return { id: message.id, result: { done: true } };
        }
        return undefined;
      },
      input,
      output,
      consumeNotification: (message) => {
        if (message.method !== PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD) return false;
        consumed.push(message.params);
        return true;
      },
    });
    connection.start();
    // 第一帧：普通请求（进入串行队列，handler 悬置）。
    input.write(`${JSON.stringify({ id: "req-1", method: "session/list" })}\n`);
    // 第二帧：桥通知 —— 必须绕过队列、在请求未决时同步消费。
    const bridgePayload = {
      kind: "payswap-account-reader-response",
      callId: "bypass-1",
      op: "overview",
      ok: true,
      value: [],
    };
    const consumedNow = new Promise<void>((resolve) => {
      const poll = () => {
        if (consumed.length > 0) resolve();
        else queueMicrotask(poll);
      };
      poll();
    });
    input.write(
      `${JSON.stringify({ method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: bridgePayload })}\n`,
    );
    await expect(consumedNow).resolves.toBeUndefined();
    expect(consumed).toEqual([bridgePayload]);
    releaseRequest?.();
    await new Promise<void>((resolve) => {
      output.once("data", () => resolve());
    });
  });

  it("consumeNotification absent (or returning false) leaves ordinary dispatch untouched", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const handled: string[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if ("method" in message) {
          handled.push(message.method);
          return undefined;
        }
        return undefined;
      },
      input,
      output,
      consumeNotification: (message) => message.method === "no/such-method",
    });
    connection.start();
    input.write(`${JSON.stringify({ method: "process/mcpTelemetry", params: { x: 1 } })}\n`);
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (handled.length > 0) resolve();
        else queueMicrotask(poll);
      };
      poll();
    });
    expect(handled).toEqual(["process/mcpTelemetry"]);
  });
});
