/**
 * PaySwap P2.2（ADR-P2-2 slice 6）—— 账户 reader 桥法则
 * （`packages/shared/src/payswap/account-reader-bridge.ts`）的法则级证明。
 *
 * 被测法则（模块文件头）：
 * - 消息闭集（strict zod）+ per-op 值校验（服务端上端口前 / stub 收到后 双端）；
 * - typed refusal 作数据透传（refused/expired/revoked 值语义原样跨进程）；
 * - 桥失败 = reader throw（PayswapReaderBridgeError 闭集：reader_error/timeout/
 *   port_closed/malformed_response）；
 * - 服务端 fail-closed：face 畸形值 → reader_error（值本体永不外发）；畸形请求
 *   静默忽略；
 * - 服务端串行（响应序 = 请求序）；stub 并发 + callId 相关；
 * - 每呼叫有界时限；dispose = 端口终结。
 *
 * 两级证明的另一级（desktop main 受监督运行时 + 真实账户服务的端到端）住
 * `packages/desktop/test/payswap-account-runtime-wiring.test.ts`。
 *
 * 本套件是法则级：内存配对端口（side.post → 对端 listeners 投递），无 Electron、
 * 无真实 MessagePort。
 */

import { describe, expect, it } from "vitest";
import {
  createPayswapReaderBridgeClient,
  payswapAccountOverviewDetailSchema,
  payswapAccountRefusalSchema,
  payswapReaderBridgeOverviewValueSchema,
  PayswapReaderBridgeError,
  servePayswapReaderBridge,
  type PayswapReaderBridgePort,
} from "@zcode/shared/payswap";
import type {
  PayswapAccountOverviewDetail,
  PayswapConnectionStatusProjection,
} from "@zcode/shared/payswap";

// ---------------------------------------------------------------------------
// 内存配对端口（法则 7 的测试面：side.post → microtask 投递对端 listeners）
// ---------------------------------------------------------------------------

function createPairedPorts(): [PayswapReaderBridgePort, PayswapReaderBridgePort] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [
    new Set(),
    new Set(),
  ];
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

// ---------------------------------------------------------------------------
// fixtures（叶子 schema 全部来自法则单一事实源 —— 值过 schema 即 fixtures 合法）
// ---------------------------------------------------------------------------

const PROJECTION_A: PayswapConnectionStatusProjection = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  providerId: "stripe",
  mode: "test",
  displayName: "Main test account",
  status: "connected",
};
const PROJECTION_B: PayswapConnectionStatusProjection = {
  connectionId: "22222222-2222-4222-8222-222222222222",
  providerId: "stripe",
  mode: "live",
  displayName: "Live (read-only)",
  status: "expired",
};
const UNKNOWN_CONNECTION_ID = "00000000-0000-4000-8000-000000000000";
const UNKNOWN_CONNECTION_REFUSAL: PayswapAccountOverviewDetail = {
  kind: "refused",
  refusal: { code: "unknown_connection", message: "no such connection" },
};

function detailArm(): PayswapAccountOverviewDetail {
  return {
    kind: "detail",
    connection: PROJECTION_A,
    evidence: {
      capabilities: [{ name: "card_payments", status: "active" }],
      requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
    },
    data: {
      balance: {
        status: "ok",
        data: { available: [{ amount: "700", currency: "usd" }], pending: [] },
      },
      payment_objects: { status: "ok", data: [] },
      customers: { status: "ok", data: [] },
      disputes: {
        status: "refused",
        refusal: { code: "insufficient_permission", message: "restricted key" },
      },
    },
  };
}

function assemble(options?: {
  overview?: () => Promise<PayswapConnectionStatusProjection[]>;
  detail?: (connectionId: string) => Promise<PayswapAccountOverviewDetail>;
  timeoutMs?: number;
}) {
  const [serverPort, clientPort] = createPairedPorts();
  const server = servePayswapReaderBridge({
    port: serverPort,
    accountOverviewReader:
      options?.overview ?? (() => Promise.resolve([PROJECTION_A, PROJECTION_B])),
    accountDetailReader:
      options?.detail ??
      ((connectionId: string) =>
        Promise.resolve(
          connectionId === PROJECTION_A.connectionId
            ? detailArm()
            : UNKNOWN_CONNECTION_REFUSAL,
        )),
  });
  const client = createPayswapReaderBridgeClient({
    port: clientPort,
    timeoutMs: options?.timeoutMs ?? 2_000,
    mintCallId: (() => {
      let n = 0;
      return () => `call-${(n += 1)}`;
    })(),
  });
  return { server, client, serverPort, clientPort };
}

function expectBridgeError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected PayswapReaderBridgeError [${code}]`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PayswapReaderBridgeError);
      expect((error as PayswapReaderBridgeError).code).toBe(code);
    },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

describe("payswap account reader bridge (ADR-P2-2 slice 6) — the law", () => {
  it("message closed set: refusal + detail union schemas accept the four arms and reject secret-bearing/unknown shapes (law 1)", () => {
    expect(
      payswapAccountRefusalSchema.safeParse({ code: "unknown_connection", message: "x" }).success,
    ).toBe(true);
    expect(
      payswapAccountRefusalSchema.safeParse({
        code: "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
        message: "safeStorage unavailable",
      }).success,
    ).toBe(true);
    expect(
      payswapAccountRefusalSchema.safeParse({
        code: "unknown_connection",
        message: "x",
        secret: "sk_test_x",
      }).success,
    ).toBe(false);
    expect(payswapAccountOverviewDetailSchema.safeParse(detailArm()).success).toBe(true);
    expect(
      payswapAccountOverviewDetailSchema.safeParse({
        kind: "mystery",
        connection: PROJECTION_A,
      }).success,
    ).toBe(false);
    expect(
      payswapReaderBridgeOverviewValueSchema.safeParse([PROJECTION_A, PROJECTION_B]).success,
    ).toBe(true);
    expect(
      payswapReaderBridgeOverviewValueSchema.safeParse([
        { ...PROJECTION_A, apiKey: "sk_test_x" },
      ]).success,
    ).toBe(false);
  });

  it("overview round-trip: value fidelity through the paired ports (law 1/2)", async () => {
    const { client } = assemble();
    const overview = await client.accountOverviewReader();
    expect(overview).toEqual([PROJECTION_A, PROJECTION_B]);
  });

  it("detail round-trip: all four union arms pass as data — refusals are VALUES, never errors (law 2)", async () => {
    const { client } = assemble();
    const detail = await client.accountDetailReader(PROJECTION_A.connectionId);
    expect(detail).toEqual(detailArm());
    expect(await client.accountDetailReader(UNKNOWN_CONNECTION_ID)).toEqual(
      UNKNOWN_CONNECTION_REFUSAL,
    );
    const expired: PayswapAccountOverviewDetail = { kind: "expired", connection: PROJECTION_B };
    const revoked: PayswapAccountOverviewDetail = { kind: "revoked", connection: PROJECTION_A };
    const { client: client2 } = assemble({
      detail: (connectionId) =>
        Promise.resolve(connectionId === "expired" ? expired : revoked),
    });
    expect(await client2.accountDetailReader("expired")).toEqual(expired);
    expect(await client2.accountDetailReader("revoked")).toEqual(revoked);
  });

  it("reader throw relays as PayswapReaderBridgeError reader_error with the operator-readable message (law 1/3)", async () => {
    const { client } = assemble({
      overview: () => Promise.reject(new Error("store io failure")),
    });
    await expectBridgeError(client.accountOverviewReader(), "reader_error");
  });

  it("server-side fail-closed value validation: a face returning a malformed value answers reader_error and the malformed value never crosses the port (law 4)", async () => {
    const [serverPort, clientPort] = createPairedPorts();
    let okValuesPosted = 0;
    // 观察面：包一层 serverPort，计数 ok:true 响应。
    const observedServerPort: PayswapReaderBridgePort = {
      post(message) {
        const parsed = message as { ok?: boolean };
        if (parsed?.ok === true) okValuesPosted += 1;
        serverPort.post(message);
      },
      subscribe: (listener) => serverPort.subscribe(listener),
    };
    const server = servePayswapReaderBridge({
      port: observedServerPort,
      accountOverviewReader: () =>
        // @ts-expect-error —— 故意畸形：投影行携带秘密形字段（法则 4 的被测对象）
        Promise.resolve([{ ...PROJECTION_A, operatorSecret: "sk_test_leak" }]),
      accountDetailReader: () => Promise.resolve(detailArm()),
    });
    const client = createPayswapReaderBridgeClient({ port: clientPort, timeoutMs: 2_000 });
    await expectBridgeError(client.accountOverviewReader(), "reader_error");
    expect(okValuesPosted).toBe(0); // 畸形值本体从未以 ok:true 上端口
    server.stop();
  });

  it("client-side defense in depth: a corrupted-but-envelope-valid value fails as malformed_response, not timeout (law 1/3)", async () => {
    const [serverPort, clientPort] = createPairedPorts();
    const server = servePayswapReaderBridge({
      port: serverPort,
      accountOverviewReader: () => Promise.resolve([PROJECTION_A]),
      accountDetailReader: () => Promise.resolve(detailArm()),
    });
    // MITM 客户端端口：post 走 clientPort（client→server 方向，服务端监听集）；
    // subscribe 侧收到 server→client 的 ok:true 响应时把 value 篡改为不过
    // per-op 法则的形状（信封仍合法 —— 值层校验的防御纵深被测）。
    const mitmPort: PayswapReaderBridgePort = {
      post: (message) => clientPort.post(message),
      subscribe: (listener) =>
        clientPort.subscribe((message) => {
          const parsed = message as { ok?: boolean };
          if (parsed?.ok === true) listener({ ...message, value: [{ bogus: true }] });
          else listener(message);
        }),
    };
    const mitmClient = createPayswapReaderBridgeClient({ port: mitmPort, timeoutMs: 300 });
    await expectBridgeError(mitmClient.accountOverviewReader(), "malformed_response");
    server.stop();
  });

  it("bounded per-call deadline: an unanswering server times out as timeout (law 6)", async () => {
    const [, clientPort] = createPairedPorts(); // 服务端永不 subscribe —— 无人应答
    const client = createPayswapReaderBridgeClient({ port: clientPort, timeoutMs: 25 });
    await expectBridgeError(client.accountOverviewReader(), "timeout");
  });

  it("dispose: pending calls reject with port_closed; post-dispose calls reject immediately (law 6)", async () => {
    const [serverPort, clientPort] = createPairedPorts();
    // 服务端收到请求但延迟应答 —— 制造挂起。
    const releasers: Array<() => void> = [];
    serverPort.subscribe((message) => {
      const parsed = message as { callId?: string };
      if (parsed?.callId) {
        releasers.push(() =>
          serverPort.post({
            kind: "payswap-account-reader-response",
            callId: parsed.callId as string,
            op: "overview",
            ok: true,
            value: [PROJECTION_A],
          }),
        );
      }
    });
    const client = createPayswapReaderBridgeClient({ port: clientPort, timeoutMs: 5_000 });
    const pending = client.accountOverviewReader();
    await sleep(10); // 等请求抵达服务端
    client.dispose();
    await expectBridgeError(pending, "port_closed");
    await expectBridgeError(client.accountOverviewReader(), "port_closed");
    for (const release of releasers) release(); // 迟到响应不崩溃
  });

  it("unknown callId and non-response messages are ignored: a foreign/late response never settles a foreign call (law 1/6)", async () => {
    const { client, serverPort } = assemble();
    // 嗅探服务端入站（请求），随即注入一条无关 callId 的合法响应 + 一条非响应消息。
    serverPort.subscribe((message) => {
      const parsed = message as { callId?: string; kind?: string };
      if (parsed?.kind === "payswap-account-reader-request" && parsed.callId) {
        queueMicrotask(() => {
          serverPort.post({
            kind: "payswap-account-reader-response",
            callId: "not-a-call",
            op: "overview",
            ok: true,
            value: [],
          } as never);
          serverPort.post({ totally: "unrelated" } as never);
        });
      }
    });
    const overview = await client.accountOverviewReader(); // 真实响应仍然结算
    expect(overview).toEqual([PROJECTION_A, PROJECTION_B]);
  });

  it("server ignores malformed requests and non-request messages without answering or crashing (law 4)", async () => {
    const { client, clientPort } = assemble();
    for (const junk of [
      { kind: "payswap-account-reader-request", op: "overview" }, // 缺 callId
      { kind: "payswap-account-reader-request", callId: "x", op: "seventh-op" }, // 闭集外 op
      "not-an-object",
    ]) {
      clientPort.post(junk as never); // 客户端 → 服务端方向
    }
    // 畸形请求之后，真实请求照常应答。
    const overview = await client.accountOverviewReader();
    expect(overview).toEqual([PROJECTION_A, PROJECTION_B]);
  });

  it("concurrent calls correlate by callId (stub-side concurrency, law 5/6)", async () => {
    const { client } = assemble();
    const [overview, detail, refused] = await Promise.all([
      client.accountOverviewReader(),
      client.accountDetailReader(PROJECTION_A.connectionId),
      client.accountDetailReader(UNKNOWN_CONNECTION_ID),
    ]);
    expect(overview).toEqual([PROJECTION_A, PROJECTION_B]);
    expect(detail).toEqual(detailArm());
    expect(refused).toEqual(UNKNOWN_CONNECTION_REFUSAL);
  });

  it("server serialization: responses arrive in request order even when the first face is slow (law 5)", async () => {
    const [serverPort, clientPort] = createPairedPorts();
    const arrivalOrder: string[] = [];
    clientPort.subscribe((message) => {
      const parsed = message as { callId?: string };
      if (parsed?.callId) arrivalOrder.push(parsed.callId);
    });
    const server = servePayswapReaderBridge({
      port: serverPort,
      accountOverviewReader: () =>
        new Promise((resolve) => setTimeout(() => resolve([PROJECTION_A]), 40)),
      accountDetailReader: () => Promise.resolve(detailArm()),
    });
    const client = createPayswapReaderBridgeClient({
      port: clientPort,
      timeoutMs: 2_000,
      mintCallId: (() => {
        let n = 0;
        return () => `ordered-${(n += 1)}`;
      })(),
    });
    const slow = client.accountOverviewReader(); // 先发（慢，40ms）
    const fast = client.accountDetailReader(PROJECTION_A.connectionId); // 后发（快）
    await Promise.all([slow, fast]);
    expect(arrivalOrder).toEqual(["ordered-1", "ordered-2"]); // 响应序 = 请求序
    server.stop();
  });
});
