/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的窗口 host 侧半）—— reader 桥
 * 透明中继（`packages/desktop/src/host/payswapReaderBridgeRelay.ts`）的法则级证明。
 *
 * 被测法则（Addendum B 两跳传输的 host 中继半）：
 * - **透明**：桥消息作为不透明载荷双向转发 —— 中继不校验、不改写、不解释语义
 *   （zod 校验只住真正的两端：agent stub 与 desktop main 服务端）；载荷对象原样
 *   通过（连 schema 不合法的帧也原样转发 —— 由两端法则静默忽略，不由中继裁决）。
 * - **路由读恰一字段**：中继唯一的读取面是 callId（路由键）；请求方向按观察学习
 *   callId → client，响应方向按表路由。
 * - **缺席与故障有别**（桥法则 3 的中继面）：main 端口未接 → 请求丢弃 + 可见
 *   warn（不伪造、不缓存）；未知 callId 响应 → 丢弃（stub 时限兜底，不投递错端）。
 * - **生命周期**：client 关闭 → 路由表清理；relay dispose → 停止转发。
 * - isAvailable = main 端口在活（agent spawn env 标记的可用性来源）。
 *
 * 两级证明的另一级：desktop main 端口铸造 + serve 端到端住
 * `packages/desktop/test/payswap-reader-bridge-entry.test.ts`；agent 侧半住
 * `apps/zcode-cli/packages/bootstrap/tests/payswap-stdio-bridge-port.test.ts`。
 */

import { describe, expect, it } from "vitest";
import {
  PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
  readPayswapReaderBridgeCallId,
} from "@zcode/shared/payswap";
import { createPayswapReaderBridgeRelay } from "../src/host/payswapReaderBridgeRelay.js";

// ---------------------------------------------------------------------------
// doubles（fake port + fake protocol client —— 结构面注入，零 Electron）
// ---------------------------------------------------------------------------

interface FakePortEvent {
  data: unknown;
}

function createFakeMainPort() {
  const listeners = new Set<(event: FakePortEvent) => void>();
  const closeListeners = new Set<() => void>();
  const posted: unknown[] = [];
  return {
    posted,
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    start: () => {},
    on: (_event: "message", listener: (event: FakePortEvent) => void) => {
      listeners.add(listener);
    },
    once: (event: "close", listener: () => void) => {
      if (event === "close") closeListeners.add(listener);
    },
    emitMessage: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
    emitClose: () => {
      for (const listener of closeListeners) listener();
    },
  };
}

function createFakeAgentClient() {
  const notificationListeners = new Set<(message: { method: string; params?: unknown }) => void>();
  const closeListeners = new Set<() => void>();
  const notified: Array<{ method: string; params?: unknown }> = [];
  return {
    notified,
    onNotification: (listener: (message: { method: string; params?: unknown }) => void) => {
      notificationListeners.add(listener);
      return { dispose: () => notificationListeners.delete(listener) };
    },
    notify: async (method: string, params?: unknown) => {
      notified.push({ method, params });
    },
    onClose: (listener: () => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    emitNotification: (message: { method: string; params?: unknown }) => {
      for (const listener of notificationListeners) listener(message);
    },
    emitClose: () => {
      for (const listener of closeListeners) listener();
    },
  };
}

function bridgeRequest(callId: string) {
  return { kind: "payswap-account-reader-request", callId, op: "overview" };
}

function bridgeResponse(callId: string, value: unknown) {
  return { kind: "payswap-account-reader-response", callId, op: "overview", ok: true, value };
}

// ---------------------------------------------------------------------------

describe("payswap reader bridge relay (ADR-P2-2 Addendum B — window-host half)", () => {
  it("agent→main forwarding is transparent: the bridge notification params is posted to the main port verbatim (no parse, no rewrite, no validation)", () => {
    const relay = createPayswapReaderBridgeRelay();
    const port = createFakeMainPort();
    relay.attachMainPort(port);
    const client = createFakeAgentClient();
    relay.attachProtocolClient(client);
    const payload = bridgeRequest("relay-1");
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: payload,
    });
    expect(port.posted).toEqual([payload]);
    // 非「请求/响应」语义的帧也原样转发（中继不是端 —— 合法性由两端法则裁决）。
    const malformed = { definitely: "not", a: "bridge message" };
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: malformed,
    });
    expect(port.posted).toEqual([payload, malformed]);
  });

  it("main→agent routing: responses return to the requesting client by learned callId, with the payload verbatim", () => {
    const relay = createPayswapReaderBridgeRelay();
    const port = createFakeMainPort();
    relay.attachMainPort(port);
    const clientA = createFakeAgentClient();
    const clientB = createFakeAgentClient();
    relay.attachProtocolClient(clientA);
    relay.attachProtocolClient(clientB);
    clientA.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("route-a"),
    });
    clientB.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("route-b"),
    });
    const responseA = bridgeResponse("route-a", []);
    const responseB = bridgeResponse("route-b", [{ stubbed: true }]);
    port.emitMessage(responseA);
    port.emitMessage(responseB);
    expect(clientA.notified).toEqual([
      { method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: responseA },
    ]);
    expect(clientB.notified).toEqual([
      { method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params: responseB },
    ]);
  });

  it("absence vs failure stay distinct: no main port → request dropped with a visible warn (never faked); unknown-callId response → dropped silently (stub timeout is the law's authority)", () => {
    const warnings: string[] = [];
    const relay = createPayswapReaderBridgeRelay({
      logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) },
    });
    const client = createFakeAgentClient();
    relay.attachProtocolClient(client);
    expect(relay.isAvailable()).toBe(false);
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("absent-1"),
    });
    expect(warnings.length).toBeGreaterThan(0); // 可见丢弃，不静默
    // main 端口后到（理论序），从未观察过（未学习）的 callId 响应 → 不投递错端。
    const port = createFakeMainPort();
    relay.attachMainPort(port);
    port.emitMessage(bridgeResponse("never-observed-1", []));
    expect(client.notified).toEqual([]);
  });

  it("client close purges its routing entries; non-bridge notifications never touch the main port", () => {
    const relay = createPayswapReaderBridgeRelay();
    const port = createFakeMainPort();
    relay.attachMainPort(port);
    const client = createFakeAgentClient();
    relay.attachProtocolClient(client);
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("purge-1"),
    });
    expect(port.posted.length).toBe(1);
    // 非桥方法：完全忽略（协议层正常分发）。
    client.emitNotification({ method: "process/mcpTelemetry", params: { x: 1 } });
    expect(port.posted.length).toBe(1);
    client.emitClose();
    port.emitMessage(bridgeResponse("purge-1", []));
    expect(client.notified).toEqual([]); // 路由已随 client 关闭清理
  });

  it("late-arriving main port replaces the previous face (host re-init defense); close event clears availability", () => {
    const relay = createPayswapReaderBridgeRelay();
    const first = createFakeMainPort();
    relay.attachMainPort(first);
    expect(relay.isAvailable()).toBe(true);
    const second = createFakeMainPort();
    relay.attachMainPort(second);
    const client = createFakeAgentClient();
    relay.attachProtocolClient(client);
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("replace-1"),
    });
    expect(second.posted).toEqual([bridgeRequest("replace-1")]);
    expect(first.posted).toEqual([]); // 旧面不再接收
    second.emitClose();
    expect(relay.isAvailable()).toBe(false);
  });

  it("dispose stops all forwarding (both directions) and is idempotent", () => {
    const relay = createPayswapReaderBridgeRelay();
    const port = createFakeMainPort();
    relay.attachMainPort(port);
    const client = createFakeAgentClient();
    relay.attachProtocolClient(client);
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("dispose-1"),
    });
    relay.dispose();
    relay.dispose();
    client.emitNotification({
      method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
      params: bridgeRequest("dispose-2"),
    });
    port.emitMessage(bridgeResponse("dispose-1", []));
    expect(port.posted.length).toBe(1);
    expect(client.notified).toEqual([]);
  });

  it("the routing-read helper is minimal: only a non-empty string callId is a route key — anything else is null", () => {
    expect(readPayswapReaderBridgeCallId({ callId: "x" })).toBe("x");
    expect(readPayswapReaderBridgeCallId({ callId: "" })).toBeNull();
    expect(readPayswapReaderBridgeCallId({ callId: 42 })).toBeNull();
    expect(readPayswapReaderBridgeCallId({ nope: true })).toBeNull();
    expect(readPayswapReaderBridgeCallId(null)).toBeNull();
    expect(readPayswapReaderBridgeCallId("string")).toBeNull();
  });
});
