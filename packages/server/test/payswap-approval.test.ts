/**
 * PaySwap P1.7 —— 服务端批准边界生产套件（addendum §1.6.2 item 5、§1.6.3 items 3/5/6/9；
 * N28（client 臂）/N29/N30/N31/N41 的批准路径臂 + §1.6.2 item 5c 暴露策略；
 * playbook work package P1.7）。
 *
 * 边界：真实 `createHttpServer`（packages/server/src/http.ts —— entry-http 的同一条
 * 生产工厂路径）+ 真实 WebSocket 升级握手（两级：deployment Bearer + operator token）
 * + 真实 channel RPC（@zcode/rpc ChannelClient/ProxyChannel —— 与 web-remote 客户端
 * 同一条传输路径）+ 真实 operator 存储 + 真实批准流（shared 法则 + registry challenge
 * 端口）。法则级行（卡实例 bearer、tuple/ledger/origin 法则）在
 * apps/zcode-cli/packages/bootstrap/tests/payswap-grant-law.test.ts。
 *
 * 行（N-映射）：
 * - N29：B 的 session 解析 A 的 challenge → principal_mismatch（impersonation 拒绝，
 *   challenge 不消耗 —— A 仍可解析）；B 不能 inspect A 的 pending 卡（listPendingProposals
 *   按 session 过滤 —— §1.6.3 item 6 的 "resolve, inspect, or mint" 三臂中的 inspect 臂）。
 * - N30：过期 session 上的解析 → session_invalid；撤销关闭连接并使 pending challenge
 *   失效（级联后任何解析 → challenge_invalidated）。
 * - N31：无 approver 角色的 operator（viewer）持正确 challenge 解析 → role_required
 *   （服务边界拒绝，grant 不铸）。
 * - N41：ws-a 的 approver 对 ws-b 的 proposal 解析 → role_required（角色是
 *   (operator, workspace) 绑定，永不全局）。
 * - N28 client 臂 + §1.6.2 item 5c：未绑定连接（无 operator 凭据的普通客户端）到不了
 *   批准通道 —— 暴露策略 stub 的 typed `approval_channel_unauthorized`。
 * - N14/N26 服务端臂：解析事件不能携带 tuple 覆盖字段（strict 事件形状）；
 *   mcp/uiCallTool 形状的回调不是批准事件。
 * - 正向闭环：A 经真实 /ws channel 批准 → grant 铸入 ledger（principal = server 侧
 *   解析的 operatorId、workspace、approver 角色、host 重算的 tuple digest）；
 *   challenge 一次性（N15 重放 → challenge_consumed）；铸出的 grant 经 enforcement
 *   seam 恰好授权一次（N11 服务端臂）。
 */

import * as http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ChannelClient,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";
import type {
  PayswapAuthorizationTuple,
  PayswapGrantRecord,
  PayswapAuthorizationCardPayload,
} from "@zcode/shared/payswap";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.js";
import {
  createPayswapApprovalHost,
  createPayswapOperatorStore,
  payswapApprovalChannelDescriptor,
  type PayswapApprovalChannel,
  type PayswapApprovalHost,
  type PayswapOperatorStore,
} from "../src/payswap/index.js";

const DEPLOYMENT_TOKEN = "dep-token-0123456789abcdef";

/** 可控时钟：session 生命周期 / tuple 过期的时间臂全走它。 */
function controlledClock(startMs = 2_000_000) {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function sampleTuple(principal: string): PayswapAuthorizationTuple {
  return {
    principal,
    source: { connectionId: "conn_1", accountId: "acct_1AB" },
    recipient: { recipientId: "rcp_77", evidenceRef: "evd:readback:0001" },
    amount: { value: "125.50", currency: "USD" },
    purpose: "invoice_settlement",
    route: {
      legs: [
        {
          legId: "leg-1",
          provider: "stripe",
          recipientId: "rcp_77",
          amount: "125.50",
          currency: "USD",
          idempotencyKey: "idem-leg-1",
        },
      ],
    },
    fees: { maxTotalFees: "2.75" },
    fx: { rateFloor: "1.0000", rateSource: "trace-2026-11", expiresAt: 2_600_000 },
    expiresAt: 2_500_000,
  };
}

interface ApprovalServer {
  store: PayswapOperatorStore;
  approval: PayswapApprovalHost;
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

const openServers: ApprovalServer[] = [];
const openSockets: WebSocket[] = [];

async function waitForListen(server: http.Server): Promise<number> {
  for (let i = 0; i < 100; i += 1) {
    const address = server.address();
    if (address && typeof address === "object") return address.port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("server did not start listening");
}

async function makeStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "payswap-approval-"));
}

async function startApprovalServer(
  clock: { now(): number },
  options: { stateDir: string; sessionLifetimeMs?: number },
): Promise<ApprovalServer> {
  const store = createPayswapOperatorStore({
    stateFilePath: join(options.stateDir, "operators.json"),
    now: clock.now,
    sessionLifetimeMs: options.sessionLifetimeMs ?? 15 * 60_000,
  });
  // P1.8 T3 卡臂：生产装配（entry-http）在 N27 activated 分支内以 env 投影供给
  // financialMode reader —— 本套件的生产边界形态 = 激活部署（发卡路径可达），故供给
  // active reader；法则臂（非 active 拒发）由 bootstrap 的 surface-lifecycle 电池钉住。
  const approval = createPayswapApprovalHost({
    store,
    now: clock.now,
    financialMode: () => ({ active: true }),
  });
  const services = new ServiceCollection();
  // 暴露策略的 fail-closed 默认：channel 注册的就是拒绝 stub；只有 operator 绑定
  // 连接（/ws per-connection override）才换到 session-bound 真 service。
  services.register(payswapApprovalChannelDescriptor, approval.channelDefault);
  const server = createHttpServer(services, 0, {
    authToken: DEPLOYMENT_TOKEN,
    payswapFinancial: { store, approval },
  });
  const port = await waitForListen(server);
  const handle: ApprovalServer = {
    store,
    approval,
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

/** 真实 /ws channel 客户端（与 web-remote 客户端同一条 rpc 传输路径）。 */
function wsApprovalClient(
  port: number,
  headers: Record<string, string>,
): Promise<{ channel: PayswapApprovalChannel; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    openSockets.push(ws);
    ws.on("error", reject);
    ws.on("open", () => {
      const onData = new Emitter<VSBuffer>();
      const onClose = new Emitter<void>();
      const onEnd = new Emitter<void>();
      const socket: ISocket = {
        onData: onData.event,
        onClose: onClose.event,
        onEnd: onEnd.event,
        write(buffer: VSBuffer) {
          ws.send(buffer.buffer);
        },
        end() {
          ws.close();
        },
        drain() {
          return Promise.resolve();
        },
        dispose() {
          ws.close();
        },
      };
      ws.on("message", (data) => {
        const bytes = typeof data === "string" ? Buffer.from(data) : (data as Buffer);
        onData.fire(VSBuffer.wrap(new Uint8Array(bytes)));
      });
      ws.on("close", () => {
        onClose.fire();
        onEnd.fire();
      });
      const client = new ChannelClient(new SocketProtocol(socket));
      const channel = ProxyChannel.toService<PayswapApprovalChannel>(
        client.getChannel(payswapApprovalChannelDescriptor.channelName),
      );
      const closed = new Promise<void>((closeResolve) => {
        ws.on("close", () => closeResolve());
      });
      resolve({
        channel,
        close: () => {
          ws.close();
          return closed;
        },
      });
    });
  });
}

function operatorHeaders(operatorToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${DEPLOYMENT_TOKEN}`,
    "x-payswap-operator-token": operatorToken,
  };
}

function unboundHeaders(): Record<string, string> {
  return { authorization: `Bearer ${DEPLOYMENT_TOKEN}` };
}

async function sessionOf(
  store: PayswapOperatorStore,
  operatorId: string,
): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const found = store.activeSessions().find((s) => s.operatorId === operatorId && s.live);
    if (found) return found.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no live session for operator ${operatorId}`);
}

async function issueTo(
  approval: PayswapApprovalHost,
  store: PayswapOperatorStore,
  operatorId: string,
  workspaceId: string,
): Promise<{ proposalId: string; cardPayload: PayswapAuthorizationCardPayload }> {
  const tuple = sampleTuple(operatorId);
  const targetSessionId = await sessionOf(store, operatorId);
  const issued = approval.issueProposal({ tuple, workspaceId, targetSessionId });
  if (issued.status !== "issued") {
    throw new Error(`fixture issuance failed: ${JSON.stringify(issued)}`);
  }
  return issued;
}

function approveEvent(issued: { proposalId: string; cardPayload: PayswapAuthorizationCardPayload }) {
  return {
    proposalId: issued.proposalId,
    challengeId: issued.cardPayload.challenge.challengeId,
    challengeSecret: issued.cardPayload.challenge.secret,
    decision: "approve" as const,
  };
}

afterEach(async () => {
  while (openSockets.length) {
    openSockets.pop()!.close();
  }
  while (openServers.length) {
    const handle = openServers.pop()!;
    await handle.close();
  }
});

describe("P1.7 server approval boundary (§1.6.2 item 5, §1.6.3 items 3/5/6/9)", () => {
  it("the positive path: operator A approves through the real /ws channel — the grant mints with the server-resolved principal", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-a");

    const verdict = await client.channel.resolveApproval(approveEvent(issued));
    expect(verdict).toMatchObject({ status: "approved" });
    const grants: readonly PayswapGrantRecord[] = server.approval.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.principal).toBe(operatorA.operatorId);
    expect(grants[0]!.workspaceId).toBe("ws-a");
    expect(grants[0]!.approvedRole).toBe("approver");

    // N11 服务端臂：铸出的 grant 经 enforcement seam 恰好授权一次。
    const tuple = sampleTuple(operatorA.operatorId);
    expect(
      server.approval.authorizeOperation({
        authorizationId: grants[0]!.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
      }).status,
    ).toBe("authorized");
    expect(
      server.approval.authorizeOperation({
        authorizationId: grants[0]!.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_consumed" });

    // N15 服务端臂：challenge 重放（proposal 已完成 —— 状态轴拒绝）。
    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "proposal_not_pending",
      statusWas: "approved",
    });
    expect(server.approval.grants()).toHaveLength(1);
    await client.close();
  });

  it("N29: operator B cannot resolve A's challenge and cannot inspect A's pending cards", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const operatorB = await server.store.provisionOperator({
      name: "b",
      roleBindings: [{ ledgerId: "ws-a", roles: ["viewer"] }],
    });
    const clientA = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const clientB = await wsApprovalClient(server.port, operatorHeaders(operatorB.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-a");

    // inspect 臂：B 的 session 看不到 A 的 pending 卡。
    const pendingForB = await clientB.channel.listPendingProposals();
    expect(pendingForB).toEqual([]);

    // resolve 臂：B 解析 A 的 challenge → impersonation 拒绝；无 grant。
    expect(await clientB.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "principal_mismatch",
    });
    expect(server.approval.grants()).toHaveLength(0);

    // B 的失败不消耗 challenge —— A 仍可批准。
    expect(await clientA.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "approved",
    });
    expect(server.approval.grants()).toHaveLength(1);
    await clientA.close();
    await clientB.close();
  });

  it("N30 (expiry arm): a resolution on an expired operator session is rejected", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir, sessionLifetimeMs: 60_000 });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-a");

    clock.advance(120_000);
    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "session_invalid",
    });
    expect(server.approval.grants()).toHaveLength(0);
    await client.close();
  });

  it("N30 (revocation arm): revocation closes the connection and invalidates the pending challenge", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-a");

    await server.store.revokeOperator(operatorA.operatorId);
    // 连接被 server 侧关闭（1008）。
    await client.close();
    // 级联失效后的 challenge：任何后续解析 → challenge_invalidated（状态检查先于
    // principal 匹配 —— 注册表法则的顺序）。
    const operatorB = await server.store.provisionOperator({
      name: "b",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const clientB = await wsApprovalClient(server.port, operatorHeaders(operatorB.token));
    expect(await clientB.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "challenge_invalidated",
    });
    expect(server.approval.grants()).toHaveLength(0);
    await clientB.close();
  });

  it("N31: an operator without the approver role is refused at the service boundary", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorB = await server.store.provisionOperator({
      name: "b",
      roleBindings: [{ ledgerId: "ws-a", roles: ["viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorB.token));
    // 发卡给 viewer 的 session（发卡不预检角色 —— 拒绝在铸 grant 的服务边界）。
    const issued = await issueTo(server.approval, server.store, operatorB.operatorId, "ws-a");

    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "role_required",
    });
    // 角色失败的 approve 已消耗 challenge（人的决定已花掉）—— 重试 →
    // challenge_consumed（N15/N31 组合臂）；无 grant。
    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "challenge_consumed",
    });
    expect(server.approval.grants()).toHaveLength(0);
    await client.close();
  });

  it("N41: an approver bound in workspace A cannot approve for workspace B", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-b");

    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "role_required",
    });
    expect(server.approval.grants()).toHaveLength(0);
    await client.close();
  });

  it("N28 client arm + §1.6.2 item 5c: unbound connections cannot reach the approval channel", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const client = await wsApprovalClient(server.port, unboundHeaders());

    // 暴露策略 stub：typed 拒绝（而非 channel 不存在错误）。
    expect(await client.channel.resolveApproval({ proposalId: "x", decision: "approve" })).toEqual({
      status: "approval_channel_unauthorized",
    });
    expect(await client.channel.listPendingProposals()).toEqual({
      status: "approval_channel_unauthorized",
    });
    expect(server.approval.grants()).toHaveLength(0);
    await client.close();
  });

  it("N14/N26 server arms: tuple-override fields and plugin-callback shapes are refused; the challenge survives", async () => {
    const clock = controlledClock();
    const stateDir = await makeStateDir();
    const server = await startApprovalServer(clock, { stateDir });
    const operatorA = await server.store.provisionOperator({
      name: "a",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    const client = await wsApprovalClient(server.port, operatorHeaders(operatorA.token));
    const issued = await issueTo(server.approval, server.store, operatorA.operatorId, "ws-a");

    // N14：携带 tuple 覆盖字段的事件被 strict 事件形状拒绝。
    const withOverride = {
      ...approveEvent(issued),
      amount: "0.01",
      recipientId: "rcp_EVIL",
    };
    expect(await client.channel.resolveApproval(withOverride)).toMatchObject({
      status: "not_an_approval_event",
      reason: "malformed_event",
    });

    // N26：mcp/uiCallTool 回调形状不是批准事件。
    const pluginCallback = {
      appIdentity: "payswap",
      surfaceId: "workspace",
      toolName: "payswap_request_authorization",
      callId: `call-${randomBytes(4).toString("hex")}`,
      arguments: approveEvent(issued),
    };
    expect(await client.channel.resolveApproval(pluginCallback)).toMatchObject({
      status: "not_an_approval_event",
      reason: "plugin_callback_path",
    });
    expect(server.approval.grants()).toHaveLength(0);

    // 上述拒绝不消耗 challenge —— 正当解析仍成立。
    expect(await client.channel.resolveApproval(approveEvent(issued))).toMatchObject({
      status: "approved",
    });
    expect(server.approval.grants()).toHaveLength(1);
    await client.close();
  });
});
