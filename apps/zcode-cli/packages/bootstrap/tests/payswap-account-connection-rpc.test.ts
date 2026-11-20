/**
 * PaySwap P2.2（ADR-P2-2 Decision 4，slice 7）—— 连接 RPC 通道法则
 * （`packages/shared/src/payswap/account-connection-rpc.ts`）的法则级证明。
 *
 * 被测法则（模块文件头）：
 * - 请求闭集（strict zod，恰 connect/revoke/refresh/list 四操作）；
 * - operator 秘密的单向性（operatorSecret 只在 connect 请求；一切响应形状结构上
 *   无秘密位 —— 序列化证明）；
 * - 三检先于载荷解析（不可信发送者的载荷不解析、服务不触达）；
 * - 受信 origin 每请求现读（窗口 URL 变化即刻生效；空 = fail-closed 全拒）；
 * - typed refusal 作数据透传（服务的 refused 结果原样跨 IPC）；
 * - 通道失败闭集（unauthorized_origin/malformed_request/internal_error）+ 防御
 *   纵深（服务产出经 per-op 法则校验后才上 IPC，畸形值本体永不渡 IPC）。
 *
 * 装配级的另一级（真实 ipcMain + 受监督运行时 + 真实 store 的端到端）住
 * `packages/desktop/test/payswap-account-connection-ipc.test.ts`。
 *
 * 本套件是法则级：fake 服务面 + 结构面 ipc 事件（无 Electron）。
 */

import { describe, expect, it } from "vitest";
import {
  createPayswapDesktopConnectionHost,
  payswapConnectionRpcRequestSchema,
  payswapConnectionRpcResponseSchema,
  payswapConnectionRpcResultSchemas,
  PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
  type PayswapConnectionRpcResponse,
  type PayswapConnectionRpcServiceFace,
  type PayswapDesktopIpcEventLike,
} from "@zcode/shared/payswap";
import type {
  PayswapConnectResult,
  PayswapConnectionStatusProjection,
  PayswapRefreshResult,
  PayswapRevokeResult,
} from "@zcode/shared/payswap";

// ---------------------------------------------------------------------------
// fixtures（叶子值过既有法则 schema —— 值合法即 fixtures 合法）
// ---------------------------------------------------------------------------

const PROJECTION_A: PayswapConnectionStatusProjection = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  providerId: "stripe",
  mode: "test",
  displayName: "stripe (test)",
  status: "connected",
};

const PROJECTION_B: PayswapConnectionStatusProjection = {
  connectionId: "22222222-2222-4222-8222-222222222222",
  providerId: "stripe",
  mode: "live",
  displayName: "stripe (live)",
  status: "expired",
};

const OPERATOR_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;

/** 主框架事件（senderFrame 与 sender.mainFrame 同一对象 —— Electron 语义）。 */
function mainFrameEvent(frameUrl: string): PayswapDesktopIpcEventLike {
  const mainFrame = { url: frameUrl };
  return { sender: { id: 7, mainFrame }, senderFrame: mainFrame };
}

/** 子框架事件（senderFrame 是独立对象 —— 引用相等判定失败）。 */
function subFrameEvent(frameUrl: string): PayswapDesktopIpcEventLike {
  const mainFrame = { url: frameUrl };
  return { sender: { id: 7, mainFrame }, senderFrame: { url: frameUrl } };
}

/** fake 服务面（调用记录可见；结果/抛出可编程）。 */
function fakeService(overrides: Partial<PayswapConnectionRpcServiceFace> = {}) {
  const calls: Array<{ op: string; input: unknown }> = [];
  const service: PayswapConnectionRpcServiceFace = {
    async connect(input) {
      calls.push({ op: "connect", input });
      const result: PayswapConnectResult = { kind: "connected", connection: PROJECTION_A };
      return result;
    },
    async revoke(input) {
      calls.push({ op: "revoke", input });
      const result: PayswapRevokeResult = { kind: "revoked", connection: PROJECTION_A };
      return result;
    },
    async refreshEvidence(input) {
      calls.push({ op: "refresh", input });
      const result: PayswapRefreshResult = {
        kind: "verified",
        connection: PROJECTION_A,
        providerAccountId: "acct_fixtures",
      };
      return result;
    },
    async listConnections() {
      calls.push({ op: "list", input: undefined });
      return [PROJECTION_A, PROJECTION_B];
    },
    ...overrides,
  };
  return { service, calls };
}

const TRUSTED_URL = "http://localhost:5173/index.html?workspace=w1";

function makeHost(
  service: PayswapConnectionRpcServiceFace,
  windowUrl: () => string = () => TRUSTED_URL,
  onInternalError?: (error: unknown) => void,
) {
  return createPayswapDesktopConnectionHost({
    getMainWindowFrameUrl: windowUrl,
    getAccountService: async () => service,
    ...(onInternalError !== undefined ? { onInternalError } : {}),
  });
}

// ---------------------------------------------------------------------------
// 请求闭集（法则 1）
// ---------------------------------------------------------------------------

describe("payswap connection rpc — request closed set", () => {
  it("accepts exactly the four operations with strict shapes", () => {
    expect(
      payswapConnectionRpcRequestSchema.safeParse({
        op: "connect",
        providerId: "stripe",
        operatorSecret: OPERATOR_SECRET,
      }).success,
    ).toBe(true);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({
        op: "connect",
        providerId: "stripe",
        operatorSecret: OPERATOR_SECRET,
        displayName: "  my account  ",
      }).success,
    ).toBe(true);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({ op: "revoke", connectionId: "c1" }).success,
    ).toBe(true);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({ op: "refresh", connectionId: "c1" }).success,
    ).toBe(true);
    expect(payswapConnectionRpcRequestSchema.safeParse({ op: "list" }).success).toBe(true);
  });

  it("rejects unknown ops, extra fields, and degenerate values", () => {
    expect(payswapConnectionRpcRequestSchema.safeParse({ op: "delete" }).success).toBe(false);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({
        op: "connect",
        providerId: "stripe",
        operatorSecret: "",
      }).success,
    ).toBe(false);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({
        op: "connect",
        providerId: "",
        operatorSecret: "s",
      }).success,
    ).toBe(false);
    expect(
      payswapConnectionRpcRequestSchema.safeParse({
        op: "list",
        connectionId: "smuggled",
      }).success,
    ).toBe(false);
    expect(payswapConnectionRpcRequestSchema.safeParse("list").success).toBe(false);
    expect(payswapConnectionRpcRequestSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// per-op 结果法则（法则 2 的 redaction-by-construction + 防御纵深的判据）
// ---------------------------------------------------------------------------

describe("payswap connection rpc — per-op result laws", () => {
  it("accepts the lawful result unions and rejects secret-bearing payloads", () => {
    expect(
      payswapConnectionRpcResultSchemas.connect.safeParse({
        kind: "connected",
        connection: PROJECTION_A,
      }).success,
    ).toBe(true);
    expect(
      payswapConnectionRpcResultSchemas.connect.safeParse({
        kind: "refused",
        refusal: { code: "unsupported_provider", message: "m" },
      }).success,
    ).toBe(true);
    // 秘密位在任何结果形状上都是 schema 级拒绝（redaction-by-construction 的判据）。
    expect(
      payswapConnectionRpcResultSchemas.connect.safeParse({
        kind: "connected",
        connection: { ...PROJECTION_A, operatorSecret: OPERATOR_SECRET },
      }).success,
    ).toBe(false);
    expect(
      payswapConnectionRpcResultSchemas.list.safeParse([
        { ...PROJECTION_A, secret: OPERATOR_SECRET },
      ]).success,
    ).toBe(false);
    expect(
      payswapConnectionRpcResultSchemas.refresh.safeParse({
        kind: "weird",
        connection: PROJECTION_A,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 三检先于载荷解析（法则 3/4）
// ---------------------------------------------------------------------------

describe("payswap connection rpc — sender three-check", () => {
  it("accepts a main-frame sender from the trusted application origin", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "list" },
    });
    expect(response).toEqual({ ok: true, op: "list", result: [PROJECTION_A, PROJECTION_B] });
    expect(calls.map((call) => call.op)).toEqual(["list"]);
  });

  it("rejects subframe senders before payload parsing (service untouched)", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    const response = await host.handleConnectionRequest({
      ipcEvent: subFrameEvent(TRUSTED_URL),
      payload: { op: "list" },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe("unauthorized_origin");
      expect(response.message).toContain("subframe_event");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects untrusted origins — sandbox, ui resource, foreign — without parsing the payload", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    for (const url of [
      "zcode-sandbox://plugin-x/frame.html",
      "ui://some-resource",
      "https://evil.example/index.html",
    ]) {
      const response = await host.handleConnectionRequest({
        ipcEvent: mainFrameEvent(url),
        payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET },
      });
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.code).toBe("unauthorized_origin");
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed for an unavailable window URL and honors live URL changes", async () => {
    const { service } = fakeService();
    let windowUrl = "";
    const host = makeHost(service, () => windowUrl);
    const denied = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "list" },
    });
    // 空窗口 URL = 空受信集 = 全拒（payload 的 frameUrl 无关 —— 集来自主窗口现读）。
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unauthorized_origin");

    windowUrl = TRUSTED_URL;
    const granted = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "list" },
    });
    expect(granted.ok).toBe(true);
    expect(host.trustedAppOrigins()).toEqual(new Set(["http://localhost:5173"]));
  });
});

// ---------------------------------------------------------------------------
// 四操作往返 + typed refusal 作数据（法则 5）
// ---------------------------------------------------------------------------

describe("payswap connection rpc — operation round trips", () => {
  it("connect reaches the service with the exact operator input", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: {
        op: "connect",
        providerId: "stripe",
        operatorSecret: OPERATOR_SECRET,
        displayName: "my account",
      },
    });
    expect(response).toEqual({ ok: true, op: "connect", result: { kind: "connected", connection: PROJECTION_A } });
    expect(calls).toEqual([
      {
        op: "connect",
        input: {
          providerId: "stripe",
          operatorSecret: OPERATOR_SECRET,
          displayName: "my account",
        },
      },
    ]);
  });

  it("connect forwards the client-credentials pair (P3: clientId + operator-declared mode) verbatim", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: {
        op: "connect",
        providerId: "paypal",
        operatorSecret: OPERATOR_SECRET,
        clientId: "AeTestClientId1234567890",
        mode: "test",
      },
    });
    expect(response).toEqual({ ok: true, op: "connect", result: { kind: "connected", connection: PROJECTION_A } });
    expect(calls).toEqual([
      {
        op: "connect",
        input: {
          providerId: "paypal",
          operatorSecret: OPERATOR_SECRET,
          clientId: "AeTestClientId1234567890",
          mode: "test",
        },
      },
    ]);
  });

  it("revoke and refresh carry the connectionId verbatim", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "revoke", connectionId: "c-9" },
    });
    await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "refresh", connectionId: "c-9" },
    });
    expect(calls).toEqual([
      { op: "revoke", input: { connectionId: "c-9" } },
      { op: "refresh", input: { connectionId: "c-9" } },
    ]);
  });

  it("passes typed refusals as data (the Gate E2 UI clause rides this)", async () => {
    const refusal = {
      kind: "refused",
      refusal: { code: "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE", message: "fail-closed row" },
    } satisfies PayswapConnectResult;
    const { service } = fakeService({
      async connect() {
        return refusal;
      },
    });
    const host = makeHost(service);
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET },
    });
    expect(response).toEqual({ ok: true, op: "connect", result: refusal });
  });
});

// ---------------------------------------------------------------------------
// 通道失败闭集 + 防御纵深 + 秘密单向性（法则 2/6）
// ---------------------------------------------------------------------------

describe("payswap connection rpc — channel failure closed set", () => {
  it("answers malformed_request for out-of-set payloads without touching the service", async () => {
    const { service, calls } = fakeService();
    const host = makeHost(service);
    for (const payload of [
      { op: "destroy" },
      { op: "connect", providerId: "stripe" }, // 缺 operatorSecret
      { op: "revoke" },
      42,
      null,
    ]) {
      const response = await host.handleConnectionRequest({
        ipcEvent: mainFrameEvent(TRUSTED_URL),
        payload,
      });
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.code).toBe("malformed_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("maps a throwing service to internal_error with the observability hook", async () => {
    const internalErrors: unknown[] = [];
    const { service } = fakeService({
      async listConnections() {
        throw new Error("store read failed");
      },
    });
    const host = makeHost(service, () => TRUSTED_URL, (error) => internalErrors.push(error));
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "list" },
    });
    expect(response).toEqual({ ok: false, code: "internal_error", message: "store read failed" });
    expect(internalErrors).toHaveLength(1);
  });

  it("never posts a service value that fails the per-op law (defense in depth)", async () => {
    const internalErrors: unknown[] = [];
    const malformed = {
      kind: "connected",
      connection: { ...PROJECTION_A, operatorSecret: "smuggled" },
    };
    const { service } = fakeService({
      async connect() {
        return malformed as unknown as PayswapConnectResult;
      },
    });
    const host = makeHost(service, () => TRUSTED_URL, (error) => internalErrors.push(error));
    const response = await host.handleConnectionRequest({
      ipcEvent: mainFrameEvent(TRUSTED_URL),
      payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe("internal_error");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("smuggled");
    expect(internalErrors).toHaveLength(1);
  });

  it("no response shape ever serializes the operator secret (one-way law)", async () => {
    const { service } = fakeService();
    const host = makeHost(service);
    const responses: PayswapConnectionRpcResponse[] = [];
    responses.push(
      await host.handleConnectionRequest({
        ipcEvent: mainFrameEvent(TRUSTED_URL),
        payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET },
      }),
    );
    responses.push(
      await host.handleConnectionRequest({
        ipcEvent: mainFrameEvent(TRUSTED_URL),
        payload: { op: "list" },
      }),
    );
    responses.push(
      await host.handleConnectionRequest({
        ipcEvent: subFrameEvent(TRUSTED_URL),
        payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET },
      }),
    );
    responses.push(
      await host.handleConnectionRequest({
        ipcEvent: mainFrameEvent(TRUSTED_URL),
        payload: { op: "connect", providerId: "stripe", operatorSecret: OPERATOR_SECRET, extra: 1 },
      }),
    );
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(OPERATOR_SECRET);
      expect(payswapConnectionRpcResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it("exposes the channel name constant for the desktop assembly", () => {
    expect(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL).toBe("payswap:account-connections");
  });
});
