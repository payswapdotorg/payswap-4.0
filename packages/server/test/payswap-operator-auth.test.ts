/**
 * PaySwap P1.6 —— 服务端 operator-principal 生产边界套件（addendum §1.6.3；
 * N27/N28/N32/N40 的服务端臂；handoff work package 5）。
 *
 * 边界：真实 `createHttpServer`（packages/server/src/http.ts —— entry-http 的同一条
 * 生产工厂路径）+ 真实 HTTP 请求 + 真实 WebSocket 升级握手 + 真实 operator 存储
 * （0600 原子持久化）。法则级行在
 * apps/zcode-cli/packages/bootstrap/tests/payswap-operator-law.test.ts。
 *
 * 行（N-映射）：
 * - N27：financial 模式请求 + 无 ZCODE_SERVER_AUTH_TOKEN → activation 拒绝（两级配置
 *   法则 + createHttpServer 的纵深防御臂）；financial 部署上 `?token=` URL 传输被禁用。
 * - N28：未认证客户端不能建立 financial session —— /ws 升级的 operator 凭据失败 →
 *   单一 generic `operator_authentication_failed`；operator-session 端点同形。
 * - N40：rotated-out（过 grace）/ revoked 凭据在握手处拒绝；撤销关闭已建立的连接。
 * - N32：client-supplied operator id 永不是身份 —— 声明他人 principal 的请求被拒。
 * - 保真行：非 financial 部署的上游 `?token=` 行为原样保留（S-保真）。
 */

import * as http from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ServiceCollection } from "@zcode/services";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.js";
import {
  createPayswapOperatorStore,
  PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE,
  resolvePayswapFinancialActivation,
  type PayswapOperatorStore,
} from "../src/payswap/index.js";

const DEPLOYMENT_TOKEN = "dep-token-0123456789abcdef";
const LITE_COOKIE_NAME = "zcode_lite_token";

/** 可控时钟：rotation grace / session 生命周期的时间臂全部走它。 */
function controlledClock(startMs = 2_000_000) {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

async function makeStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "payswap-operator-auth-"));
}

interface FinancialServer {
  store: PayswapOperatorStore;
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

const openServers: FinancialServer[] = [];

async function waitForListen(server: http.Server): Promise<number> {
  for (let i = 0; i < 100; i += 1) {
    const address = server.address();
    if (address && typeof address === "object") return address.port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("server did not start listening");
}

async function startFinancialServer(
  clock: { now(): number },
  options: { stateDir: string; sessionLifetimeMs?: number; rotationGraceMs?: number },
): Promise<FinancialServer> {
  const store = createPayswapOperatorStore({
    stateFilePath: join(options.stateDir, "operators.json"),
    now: clock.now,
    sessionLifetimeMs: options.sessionLifetimeMs ?? 15 * 60_000,
    rotationGraceMs: options.rotationGraceMs ?? 24 * 3_600_000,
  });
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    authToken: DEPLOYMENT_TOKEN,
    payswapFinancial: { store },
  });
  const port = await waitForListen(server);
  const handle: FinancialServer = {
    store,
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  openServers.push(handle);
  return handle;
}

/** 原始 /ws 升级请求：101 → {upgraded}；其它 → {status, body}（可断言 401 形状）。 */
function rawWsUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<{ upgraded: true } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve({ upgraded: true });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function authedWsHeaders(operatorToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${DEPLOYMENT_TOKEN}`,
    "x-payswap-operator-token": operatorToken,
  };
}

/** 升级请求变体：path 上带 query（验证 ?token= 在 /ws 面同样被禁）。 */
function rawWsUpgradeWithQuery(
  port: number,
  query: string,
  headers: Record<string, string>,
): Promise<{ upgraded: true } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/ws?${query}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve({ upgraded: true });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function provisionApprover(
  store: PayswapOperatorStore,
): Promise<{ operatorId: string; recordId: string; token: string }> {
  return store.provisionOperator({
    name: "server-row-operator",
    roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
  });
}

afterEach(async () => {
  while (openServers.length) {
    const handle = openServers.pop()!;
    await handle.close();
  }
});

describe("P1.6 N27 — financial activation fails closed without the deployment token", () => {
  it("refuses financial activation at config resolution when no deployment token is configured", () => {
    expect(
      resolvePayswapFinancialActivation({ requested: true, deploymentAuthToken: undefined }),
    ).toEqual({ status: "refused", code: PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE });
    expect(
      resolvePayswapFinancialActivation({ requested: true, deploymentAuthToken: "   " }),
    ).toEqual({ status: "refused", code: PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE });
    expect(
      resolvePayswapFinancialActivation({ requested: false, deploymentAuthToken: undefined }),
    ).toEqual({ status: "inactive" });
    expect(
      resolvePayswapFinancialActivation({
        requested: true,
        deploymentAuthToken: DEPLOYMENT_TOKEN,
      }),
    ).toEqual({ status: "activated" });
  });

  it("refuses financial server creation without an auth token (defense in depth)", async () => {
    const stateDir = await makeStateDir();
    const store = createPayswapOperatorStore({
      stateFilePath: join(stateDir, "operators.json"),
    });
    expect(() =>
      createHttpServer(new ServiceCollection(), 0, {
        payswapFinancial: { store },
        // 故意不配置 authToken —— N27 的工厂级纵深防御臂。
      }),
    ).toThrow(PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE);
  });

  it("disables the URL query credential transport on financially enabled deployments", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    await provisionApprover(handle.store);
    // ?token= 被禁用（URL 不承载任何一级/二级凭据 —— §1.6.3 item 7）：API 面。
    const viaQuery = await fetch(
      `http://127.0.0.1:${handle.port}/api/server-info?token=${DEPLOYMENT_TOKEN}`,
    );
    expect(viaQuery.status).toBe(401);
    // /ws 升级面：query 不是逃生门（适配器裸 401 —— 状态可观察，body 不可，ADR-11 D11.5）。
    const viaQueryWs = await rawWsUpgradeWithQuery(
      handle.port,
      `token=${DEPLOYMENT_TOKEN}`,
      {},
    );
    expect(viaQueryWs.status).toBe(401);
    // Bearer / lite cookie 仍然是合法的一级传输。
    const viaBearer = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`, {
      headers: { authorization: `Bearer ${DEPLOYMENT_TOKEN}` },
    });
    expect(viaBearer.status).toBe(200);
    const viaCookie = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`, {
      headers: { cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}` },
    });
    expect(viaCookie.status).toBe(200);
  });

  it("preserves the upstream ?token= query transport on non-financial deployments (S-preservation)", async () => {
    const services = new ServiceCollection();
    const server = createHttpServer(services, 0, { authToken: DEPLOYMENT_TOKEN });
    const port = await waitForListen(server);
    openServers.push({
      store: createPayswapOperatorStore({}),
      server,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    });
    const viaQuery = await fetch(
      `http://127.0.0.1:${port}/api/server-info?token=${DEPLOYMENT_TOKEN}`,
    );
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.headers.get("set-cookie")).toContain(LITE_COOKIE_NAME);
  });
});

describe("P1.6 two-level /ws upgrade at the production boundary (§1.6.3 item 7)", () => {
  it("validates the deployment level first: a bad level-1 token refuses before the operator credential is read", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    const operator = await provisionApprover(handle.store);
    // 升级面：@hono/node-ws 适配器把非 101 响应写成裸 401（Content-Length: 0）——
    // body 不可观察（ADR-11 D11.5）；顺序证明 = 中间件先于守卫（注册序）+ 法则级行。
    const result = await rawWsUpgrade(handle.port, {
      authorization: "Bearer wrong-deployment-token",
      "x-payswap-operator-token": operator.token,
    });
    expect(result.status).toBe(401);
    // 同一错误凭据在可观察的 API 面：level-1 拒绝携带上游形状。
    const apiResult = await fetch(`http://127.0.0.1:${handle.port}/api/server-info`, {
      headers: { authorization: "Bearer wrong-deployment-token" },
    });
    expect(apiResult.status).toBe(401);
    expect(await apiResult.text()).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("lets an ordinary level-1-only client upgrade unauthenticated (no financial principal)", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    await provisionApprover(handle.store);
    const result = await rawWsUpgrade(handle.port, {
      authorization: `Bearer ${DEPLOYMENT_TOKEN}`,
    });
    expect(result).toEqual({ upgraded: true });
  });

  it("collapses every invalid operator credential into the single bare 401 (N40/N28)", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, {
      stateDir,
      rotationGraceMs: 60_000,
    });
    const operator = await provisionApprover(handle.store);
    const rotated = await handle.store.rotateOperatorCredential(operator.operatorId);
    const revokedOperator = await provisionApprover(handle.store);
    await handle.store.revokeOperatorCredential(revokedOperator.recordId);
    clock.advance(120_000); // 旧凭据过 grace → rotated_out
    // 升级面：适配器把非 101 响应统一写成裸 401（空 body）—— unknown/malformed/
    // rotated_out/revoked 四臂字节级不可区分（ADR-11 D11.5；泛化失败在此 a fortiori）。
    const attempts = [
      "pso_v1_UnknownUnknownUnknownUnknownUnknownUnknownUnknown00", // unknown
      "not-even-a-token", // malformed
      operator.token, // rotated_out
      revokedOperator.token, // revoked
    ];
    for (const token of attempts) {
      const result = await rawWsUpgrade(handle.port, authedWsHeaders(token));
      expect(result).toEqual({ status: 401, body: "" });
    }
    // typed code 在可观察面（operator-session 端点，真实 HTTP body）携带同名法则。
    const endpointRefusal = await fetch(
      `http://127.0.0.1:${handle.port}/api/payswap/operator-session`,
      {
        method: "POST",
        headers: {
          cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
          authorization: `Bearer ${operator.token}`,
        },
      },
    );
    expect(endpointRefusal.status).toBe(401);
    expect(await endpointRefusal.text()).toBe(
      JSON.stringify({ error: "operator_authentication_failed" }),
    );
    // 新凭据仍可升级。
    const fresh = await rawWsUpgrade(handle.port, authedWsHeaders(rotated.token));
    expect(fresh).toEqual({ upgraded: true });
  });

  it("authenticates a native operator upgrade and registers a live operator session", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    const operator = await provisionApprover(handle.store);
    const result = await rawWsUpgrade(handle.port, authedWsHeaders(operator.token));
    expect(result).toEqual({ upgraded: true });
    const sessions = handle.store.activeSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toMatchObject({ operatorId: operator.operatorId, live: true });
  });
});

describe("P1.6 operator-session cookie endpoint (§1.6.3 item 7 level 2 browser transport)", () => {
  it("exchanges a valid operator Bearer for a scoped HttpOnly SameSite=Strict cookie", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    const operator = await provisionApprover(handle.store);
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/payswap/operator-session`, {
      method: "POST",
      headers: {
        cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
        authorization: `Bearer ${operator.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("payswap_operator_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/ws");
    expect(setCookie).toContain("Max-Age=900");
    // cookie 值（session id）可驱动 /ws 升级（浏览器路径的两级握手）。
    const sessionId = /payswap_operator_session=([^;]+)/u.exec(setCookie)![1]!;
    const upgraded = await rawWsUpgrade(handle.port, {
      cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}; payswap_operator_session=${sessionId}`,
    });
    expect(upgraded).toEqual({ upgraded: true });
    const sessions = handle.store.activeSessions();
    expect(sessions.some((s) => s.sessionId === sessionId && s.live)).toBe(true);
  });

  it("refuses wrong operator credentials generically and unauthenticated level-1 upstream", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    await provisionApprover(handle.store);
    // level-1 缺失 → 上游 middleware 401（operator 凭据未读）。
    const noLevel1 = await fetch(`http://127.0.0.1:${handle.port}/api/payswap/operator-session`, {
      method: "POST",
      headers: { authorization: `Bearer whatever-token` },
    });
    expect(noLevel1.status).toBe(401);
    expect(await noLevel1.text()).toBe(JSON.stringify({ error: "Unauthorized" }));
    // level-1 通过 + 错误 operator 凭据 → generic。
    const wrongOperator = await fetch(
      `http://127.0.0.1:${handle.port}/api/payswap/operator-session`,
      {
        method: "POST",
        headers: {
          cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
          authorization: "Bearer pso_v1_UnknownUnknownUnknownUnknownUnknownUnknownUnknown00",
        },
      },
    );
    expect(wrongOperator.status).toBe(401);
    expect(await wrongOperator.text()).toBe(
      JSON.stringify({ error: "operator_authentication_failed" }),
    );
  });

  it("refuses a session cookie past its bounded lifetime (session expiry at the upgrade)", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, {
      stateDir,
      sessionLifetimeMs: 60_000,
    });
    const operator = await provisionApprover(handle.store);
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/payswap/operator-session`, {
      method: "POST",
      headers: {
        cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
        authorization: `Bearer ${operator.token}`,
      },
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sessionId = /payswap_operator_session=([^;]+)/u.exec(setCookie)![1]!;
    clock.advance(61_000);
    const upgraded = await rawWsUpgrade(handle.port, {
      cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}; payswap_operator_session=${sessionId}`,
    });
    // 过期 session cookie → 裸 401（升级面 body 不可观察，ADR-11 D11.5）。
    expect(upgraded.status).toBe(401);
  });
});

describe("P1.6 N32 — client-supplied operator ids are never identity", () => {
  it("refuses an upgrade or exchange naming a principal other than the authenticated one", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    const alice = await provisionApprover(handle.store);
    const bob = await handle.store.provisionOperator({
      name: "bob",
      roleBindings: [{ ledgerId: "ws-a", roles: ["viewer"] }],
    });
    // 升级处声明他人 principal → 拒绝（裸 401；body 在交换端点面可观察）。
    const foreignUpgrade = await rawWsUpgrade(handle.port, {
      ...authedWsHeaders(alice.token),
      "x-payswap-operator-id": bob.operatorId,
    });
    expect(foreignUpgrade.status).toBe(401);
    // 声明自己 → ok（字段被忽略，身份仍是凭据解析的 principal）。
    const ownUpgrade = await rawWsUpgrade(handle.port, {
      ...authedWsHeaders(alice.token),
      "x-payswap-operator-id": alice.operatorId,
    });
    expect(ownUpgrade).toEqual({ upgraded: true });
    // operator-session 端点 body 的 operatorId 字段同法。
    const foreignExchange = await fetch(
      `http://127.0.0.1:${handle.port}/api/payswap/operator-session`,
      {
        method: "POST",
        headers: {
          cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
          authorization: `Bearer ${alice.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operatorId: bob.operatorId }),
      },
    );
    expect(foreignExchange.status).toBe(401);
    expect(await foreignExchange.text()).toBe(
      JSON.stringify({ error: "foreign_principal_claim" }),
    );
    const ownExchange = await fetch(
      `http://127.0.0.1:${handle.port}/api/payswap/operator-session`,
      {
        method: "POST",
        headers: {
          cookie: `${LITE_COOKIE_NAME}=${DEPLOYMENT_TOKEN}`,
          authorization: `Bearer ${alice.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operatorId: alice.operatorId }),
      },
    );
    expect(ownExchange.status).toBe(200);
  });
});

describe("P1.6 revocation closes live operator connections and invalidates challenges (§1.6.3 item 6/8; N40 mid-flight)", () => {
  it("closes the operator's WebSocket server-side and invalidates the session's pending challenges", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const handle = await startFinancialServer(clock, { stateDir });
    const operator = await provisionApprover(handle.store);
    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
      headers: authedWsHeaders(operator.token),
    });
    const opened = await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", (error) => reject(error));
    });
    void opened;
    // 该 operator session 上挂一个 pending challenge（P1.7 的 approval challenge 将复用此绑定）。
    const sessions = handle.store.activeSessions();
    expect(sessions.length).toBe(1);
    const challenge = handle.store.issueOperatorChallenge({
      sessionId: sessions[0]!.sessionId,
      purpose: "approval-card",
      expiresAt: clock.now() + 3_600_000,
    });
    expect(challenge).not.toBeNull();
    // 撤销 → 服务端关闭连接（客户端收到 close）+ challenges 失效。
    const revocation = await handle.store.revokeOperatorCredential(operator.recordId);
    expect(revocation.closedSessions).toContain(sessions[0]!.sessionId);
    expect(revocation.invalidatedChallenges).toContain(challenge!.challengeId);
    const closed = await new Promise<{ code: number | undefined }>((resolve, reject) => {
      client.on("close", (code) => resolve({ code }));
      client.on("error", (error) => reject(error));
    });
    expect(closed.code).toBe(1008);
    // 已撤销凭据再升级 → 裸 401（升级面 body 不可观察，ADR-11 D11.5）。
    const reupgrade = await rawWsUpgrade(handle.port, authedWsHeaders(operator.token));
    expect(reupgrade.status).toBe(401);
  });
});

describe("P1.6 operator registry persistence (§1.6.3 item 8 storage discipline)", () => {
  it("persists digest-only state under 0600 and restores principals across restarts", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const stateFilePath = join(stateDir, "operators.json");
    const handle = await startFinancialServer(clock, { stateDir });
    const operator = await provisionApprover(handle.store);
    const state = await readFile(stateFilePath, "utf8");
    // digest-only：文件里没有明文凭据；0600 私有权限（POSIX）。
    expect(state).not.toContain(operator.token);
    expect(state).not.toMatch(/pso_v1_[A-Za-z0-9_-]{43}/u);
    if (process.platform !== "win32") {
      const mode = (await stat(stateFilePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // 重启（新 store 同一文件）：凭据仍解析到同一 stable principal。
    const restarted = createPayswapOperatorStore({
      stateFilePath,
      now: clock.now,
    });
    const verdict = restarted.verifyCredential(operator.token);
    expect(verdict).toMatchObject({
      status: "valid",
      operatorId: operator.operatorId,
      rotating: false,
    });
    void handle;
  });
});
