import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { McpServerConfig } from "@zcode/contracts";
import {
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  PAYSWAP_BROKER_HOST_ID_ENV_KEY,
  PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY,
  PAYSWAP_BROKER_TOKEN_ENV_KEY,
  PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY,
  verifyResponseEnvelope,
  type PayswapBrokerAttemptContext,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootPayswapBroker,
  createPayswapBrokerCoordinator,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerBootOptions,
  type PayswapBrokerCoordinator,
  type PayswapBrokerHandle,
  type PayswapEntityWorkspaceResolver,
  type PayswapSessionScopeResolver,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.5 Step 5 —— §8 会话解析与工作区隔离的对抗性测试（契约 w2-01 §8、§6.3、
 * §6.4(3)、§11；playbook §4.2 RED-first）。
 *
 * 纪律（§12.1 binding order）：本文件的对抗行先于实现代码落盘（RED）；实现提交（GREEN）
 * 必须逐行转绿。对端身份用**真实派生的子进程**（P1.3/P1.4 套件同款）。
 *
 * §8 法则（normative 摘要）：
 * - §8.1 会话身份**永不**取自请求载荷：连接的已验证实例 → 注册 scope → 经 requireSession
 *   模式**权威下游解析**（readiness + record lookup）——token 证明来源，会话被解析而非被声明。
 * - §8.2 连接绑定三元组（已验证 pid → host 注册插件实例 → session scope）；请求的
 *   sessionId hint 只能**收窄**、永不放宽：hint 解析出的会话不在绑定可解析 scope 内 →
 *   `session_unresolvable`。
 * - §8.3 工作区隔离：实例注册携带其工作区；params 命名**其它工作区实体**（账户/路由/
 *   evidence URI）→ `workspace_mismatch`；跨工作区可达性即使只读也拒绝。
 *
 * Step-5 as-built（ADR-8）落点：§8 执行位于 §5.5 步 (4)（实例/注册表绑定）之后、预留的
 * 步 (5)（重放，Step 6）之前 —— §9.3(1)/(4) 的原子 accept-and-mark 边界在 dedupe 步，
 * §8 拒绝的请求**不得**烧序列（pre-dispatch 拒绝 ≠ accepted for dispatch；child 可原样
 * 重发同一逻辑请求或经 retiredSeqs 退役）。disable 撤销臂（D5.6）绕过 §8 —— 注册表撤销
 * 是权威，被撤销实例无会话/实体 oracle。
 *
 * RED 形状注记：resolver 经 boot 选项注入 —— 实现落地前该选项被忽略，本文件的拒绝行在
 * RED 态以**断言失败**呈现（当前实现对一切 live 请求回答三码业务拒绝）；工厂行
 * （createPayswapSessionScopeResolver / createSingleSessionScopeResolver）以动态 import
 * 取用，落地前为 TypeError —— 两者都是诚实的 RED 证据（P1.3 "模块缺失无法链接" 同款纪律）。
 */

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：连接 + 写行 —— P1.3/P1.4 套件同款纪律）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const path = process.env.PB_TEST_PATH;
const lineArg = process.env.PB_TEST_LINE || "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
// 生产链路：host 的观察注册先于子进程首个 broker 请求 —— 测试模拟该顺序（延迟连接，
// 留出 onStarted 注册窗口；spawn-wiring 套件同款）。
const connect = () => {
  const s = net.connect(path, () => {
    send({ t: "connected" });
    s.write(lineArg + "\\n");
  });
  let acc = "";
  s.on("data", (d) => {
    acc += d.toString("utf8");
    let i;
    while ((i = acc.indexOf("\\n")) >= 0) {
      send({ t: "response", line: acc.slice(0, i) });
      acc = acc.slice(i + 1);
    }
  });
  s.on("close", () => { send({ t: "close" }); process.exit(0); });
  s.on("error", (e) => { send({ t: "error", code: e.code }); process.exit(0); });
};
setTimeout(connect, Number(process.env.PB_TEST_CONNECT_DELAY_MS || 0));
setTimeout(() => process.exit(0), 20000);
`;

interface ChildEvent {
  t: "connected" | "response" | "close" | "error";
  line?: string;
  code?: string;
}

interface ChildHandle {
  readonly pid: number;
  readonly events: ChildEvent[];
  waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs?: number): Promise<ChildEvent>;
  kill(): void;
}

function spawnClientChild(options: { path: string; line: string; connectDelayMs?: number }): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_LINE: options.line,
      PB_TEST_CONNECT_DELAY_MS: String(options.connectDelayMs ?? 0),
    },
  });
  const events: ChildEvent[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (raw.trim().length === 0) continue;
      try {
        events.push(JSON.parse(raw) as ChildEvent);
      } catch {
        /* 子进程非 JSON 输出忽略 */
      }
    }
  });
  child.stderr.on("data", () => {
    /* 测试子进程的 stderr 不影响判定 */
  });
  const handle: ChildHandle = {
    pid: child.pid ?? -1,
    events,
    waitFor(predicate, timeoutMs = 10000) {
      const start = Date.now();
      return new Promise<ChildEvent>((resolve, reject) => {
        const tick = () => {
          const found = events.find(predicate);
          if (found) {
            resolve(found);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`waitFor timed out after ${timeoutMs}ms; events: ${JSON.stringify(events)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
  activeChildren.push(child);
  return handle;
}

// ---------------------------------------------------------------------------
// broker / 实例 / resolver harness
// ---------------------------------------------------------------------------

const activeBrokers: PayswapBrokerHandle[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];
const activeCoordinators: PayswapBrokerCoordinator[] = [];

/** §8.1 resolver 的会话表形状：sessionId → 该会话权威归属的工作区键。 */
function sessionMapResolver(map: Record<string, string>): PayswapSessionScopeResolver {
  return (hint) => (hint in map ? { workspaceKey: map[hint] } : null);
}

function mintEntry(overrides: Partial<PayswapInstanceRegistryEntry> = {}): PayswapInstanceRegistryEntry {
  return {
    instanceId: randomUUID(),
    token: randomBytes(32).toString("hex"),
    childPid: -1,
    pluginRegistrationIdentity: "payswap@zcode-plugins-official",
    // 生产形状：sessionScope 即实例可解析 scope（Wave 2 = 工作区键，spawn-wiring 铸造）。
    workspace: "ws-alpha",
    sessionScope: "ws-alpha",
    spawnedAt: Date.now(),
    ...overrides,
  };
}

function requestLine(
  entry: { instanceId: string; token: string },
  overrides: { seq?: number; op?: string; params?: unknown; extra?: Record<string, unknown>; token?: string; sessionId?: string } = {},
): string {
  const request: Record<string, unknown> = {
    instanceId: entry.instanceId,
    seq: overrides.seq ?? 1,
    op: overrides.op ?? "get_account_overview",
    params: overrides.params ?? {},
    token: overrides.token ?? entry.token,
    sessionId: overrides.sessionId ?? "sess-a1",
    ...overrides.extra,
  };
  return JSON.stringify(request);
}

function customBootState(endpointPath: string): PayswapBrokerBootState {
  return { hostId: randomUUID(), keyPair: generateKeyPairSync("ed25519"), endpointPath };
}

async function startBroker(
  overrides: Partial<PayswapBrokerBootOptions> & { bootState?: PayswapBrokerBootState } = {},
): Promise<{
  handle: PayswapBrokerHandle;
  bootState: PayswapBrokerBootState;
  audit: PayswapBrokerAuditEvent[];
}> {
  const bootState = overrides.bootState ?? mintBrokerBootState();
  const audit: PayswapBrokerAuditEvent[] = [];
  const handle = await bootPayswapBroker({
    bootState,
    auditSink: (event) => audit.push(event),
    // 缺省 resolver（生产形状的会话表）：sess-a1/sess-a2 都解析进 ws-alpha（§8.2 hint
    // 可收窄）；显式 undefined = 未接线的 fail-closed 臂（§8.1）。
    sessionScopeResolver: sessionMapResolver({ "sess-a1": "ws-alpha", "sess-a2": "ws-alpha" }),
    ...overrides,
  });
  activeBrokers.push(handle);
  return { handle, bootState, audit };
}

function oracleMaterial(bootState: PayswapBrokerBootState) {
  return {
    hostId: bootState.hostId,
    verifyKeyBase64: exportPublicKeyBase64(bootState.keyPair.publicKey),
  };
}

function attemptFor(entry: { instanceId: string }, requestLineSent: string, op = "get_account_overview", seq = 1): PayswapBrokerAttemptContext {
  return { instanceId: entry.instanceId, seq, op, sentLine: requestLineSent };
}

/** request-attributed 桥接错误 oracle（post-binding §8 拒绝）：验签通过 + ok:false + typed code。 */
function expectRequestAttributedError(line: string, expectedCode: string, entry: { instanceId: string }, sentLine: string, bootState: PayswapBrokerBootState, seq = 1): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine, "get_account_overview", seq), oracleMaterial(bootState));
  expect(verdict.ok, `§8 refusal must be a verifiable request-attributed envelope, got ${JSON.stringify(verdict)}`).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(false);
  const error = verdict.body.error as { code: string; retryable: boolean };
  expect(error.code).toBe(expectedCode);
  expect(error.retryable).toBe(false);
}

/** request-attributed 业务拒绝 oracle（§7.3 三码，经 §8 解析后到达 dispatch）。 */
function expectBusinessRefusal(line: string, expectedCode: string, entry: { instanceId: string }, sentLine: string, bootState: PayswapBrokerBootState, seq = 1): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine, "get_account_overview", seq), oracleMaterial(bootState));
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(true);
  const data = verdict.body.data as { kind: string; refusal?: { code: string; message: string } };
  expect(data.kind).toBe("refused");
  expect(data.refusal?.code).toBe(expectedCode);
}

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
  await Promise.allSettled(activeCoordinators.splice(0).map((coordinator) => coordinator.close()));
});

// ---------------------------------------------------------------------------
// §8 法则 —— broker 集成（真实 UDS + 真实子进程对端；Linux 行，P1.3 纪律）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.5 Step 5 — §8 session resolution and workspace isolation (broker, Linux)", () => {
  it(
    "§8.1 fail-closed default: no session resolver wired → every live-instance request is session_unresolvable (resolved, never asserted)",
    async () => {
      const { handle, bootState } = await startBroker({ sessionScopeResolver: undefined });
      const entry = mintEntry();
      const line = requestLine(entry, { params: {} });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
    },
    20000,
  );

  it(
    "§8.2 a hint resolving within the binding's scope reaches the three-code law (hint narrows: two sessions of one workspace both dispatch)",
    async () => {
      const { handle, bootState } = await startBroker();
      for (const [sessionId, seq] of [["sess-a1", 1], ["sess-a2", 1]] as const) {
        const entry = mintEntry();
        const line = requestLine(entry, { params: {}, sessionId });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        // 无 reader → S2 not_connected（§13 本 wave 无账户模型；§8 解析先于业务层且不改变其答案）。
        expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState, seq);
      }
    },
    20000,
  );

  it(
    "§8.2 the hint can never widen: a hint resolving to ANOTHER workspace's session is session_unresolvable even though that session exists",
    async () => {
      const { handle, bootState } = await startBroker({
        // 会话表里 ws-beta 的会话真实存在 —— 解析成功，但绑定 scope 是 ws-alpha（收窄不放宽）。
        sessionScopeResolver: sessionMapResolver({ "sess-a1": "ws-alpha", "sess-beta-1": "ws-beta" }),
      });
      const entry = mintEntry();
      const line = requestLine(entry, { params: {}, sessionId: "sess-beta-1" });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
    },
    20000,
  );

  it(
    "§8.2 the scope check binds to the registration's sessionScope (not its workspace field): a resolved session matching the workspace but outside a narrowed sessionScope is refused",
    async () => {
      // 后续 wave（Wave 3 服务端 operator-principal）会把 sessionScope 收窄到 workspace 之下 ——
      // 本行钉住判定字段：workspace 相等不豁免，sessionScope 才是可解析 scope。
      const { handle, bootState } = await startBroker({
        sessionScopeResolver: sessionMapResolver({ "sess-a1": "ws-alpha" }),
      });
      const entry = mintEntry({ workspace: "ws-alpha", sessionScope: "ws-alpha-admin" });
      const line = requestLine(entry, { params: {}, sessionId: "sess-a1" });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
    },
    20000,
  );

  it(
    "§8.1 an unknown hint (no such session) is session_unresolvable",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const line = requestLine(entry, { params: {}, sessionId: "sess-no-such" });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
    },
    20000,
  );

  it(
    "§8.1 a throwing session resolver is session_unresolvable (fail-closed, no detail leaked)",
    async () => {
      const { handle, bootState } = await startBroker({
        sessionScopeResolver: () => {
          throw new Error("session runtime exploded");
        },
      });
      const entry = mintEntry();
      const line = requestLine(entry, { params: {} });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
      // 无细节外泄：错误文本绝不跨越桥（§6.3）。
      expect(response.line).not.toContain("session runtime exploded");
    },
    20000,
  );

  it(
    "§8.3 cross-workspace entity reference is workspace_mismatch (the §1.6.3 item-9 local arm, structural)",
    async () => {
      const { handle, bootState } = await startBroker({
        entityWorkspaceResolver: (op, params) => {
          const record = params as { connectionId?: string } | null;
          if (op === "get_account_overview" && typeof record?.connectionId === "string" && record.connectionId.startsWith("conn-beta-")) {
            return "ws-beta";
          }
          return null;
        },
      });
      const entry = mintEntry();
      const line = requestLine(entry, { params: { connectionId: "conn-beta-9" } });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "workspace_mismatch", entry, line, bootState);
    },
    20000,
  );

  it(
    "§8.3 a same-workspace entity reference passes to the three-code law; an unknown entity id names nothing (null → business layer)",
    async () => {
      const entityResolver: PayswapEntityWorkspaceResolver = (op, params) => {
        const record = params as { connectionId?: string } | null;
        if (op === "get_account_overview" && record?.connectionId === "conn-alpha-1") {
          return "ws-alpha";
        }
        return null;
      };
      for (const connectionId of ["conn-alpha-1", "conn-unknown"]) {
        const { handle, bootState } = await startBroker({ entityWorkspaceResolver: entityResolver });
        const entry = mintEntry();
        const line = requestLine(entry, { params: { connectionId } });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState);
        await handle.close();
        activeBrokers.pop();
      }
    },
    20000,
  );

  it(
    "§8.3 Wave-2 production shape: no entity resolver wired → entity params pass (no entity store exists in this wave, §13); a throwing entity resolver is internal_error",
    async () => {
      // 无 resolver（生产 Wave 2）：实体参数照常到达三码法则。
      {
        const { handle, bootState } = await startBroker();
        const entry = mintEntry();
        const line = requestLine(entry, { params: { connectionId: "conn-anything" } });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState);
      }
      // resolver 抛错：未预期的 host 侧失败 → typed internal_error（D7.7 同款分类）。
      {
        const { handle, bootState } = await startBroker({
          entityWorkspaceResolver: () => {
            throw new Error("entity store exploded");
          },
        });
        const entry = mintEntry();
        const line = requestLine(entry, { params: { connectionId: "conn-1" } });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectRequestAttributedError(response.line as string, "internal_error", entry, line, bootState);
        expect(response.line).not.toContain("entity store exploded");
      }
    },
    20000,
  );

  it(
    "ADR-8 order pins: session resolution precedes the entity check (both wrong → session_unresolvable) and precedes the three-code law (wrong session + S1 → session_unresolvable, not not_opted_in)",
    async () => {
      // 双错（坏会话 + 跨工作区实体）：会话解析先行。
      {
        const { handle, bootState } = await startBroker({
          entityWorkspaceResolver: () => "ws-beta",
        });
        const entry = mintEntry();
        const line = requestLine(entry, { params: { connectionId: "conn-beta-1" }, sessionId: "sess-beta-1" });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
      }
      // 坏会话 + 业务态 S1（未 opt-in）：桥接拒绝先于业务拒绝（§6.3 vs §7.3）。
      {
        const { handle, bootState } = await startBroker({
          liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: false }),
        });
        const entry = mintEntry();
        const line = requestLine(entry, { params: {}, sessionId: "sess-beta-1" });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectRequestAttributedError(response.line as string, "session_unresolvable", entry, line, bootState);
      }
    },
    20000,
  );

  it(
    "ADR-8/D5.6: a disable-revoked instance bypasses §8 — a residual call with a rogue hint answers financial_mode_disabled (no session oracle for revoked instances)",
    async () => {
      const registry = createPayswapInstanceRegistry();
      const { handle, bootState } = await startBroker({
        registry,
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      const entry = mintEntry();
      // rogue hint：会话表里没有的会话 —— disable 撤销臂必须无视它（无会话/实体 oracle）。
      const line = requestLine(entry, { params: {}, sessionId: "sess-rogue-hint" });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      // 经注册表撤销（§10.2(2)，liveness 权威）：注册表 tombstone(disabled) 后 §8 不参与应答。
      registry.tombstone(entry.instanceId, "disabled");
      const response = await child.waitFor((event) => event.t === "response");
      expectBusinessRefusal(response.line as string, "financial_mode_disabled", entry, line, bootState);
    },
    20000,
  );

  it(
    "§11 audit: §8 refusals are audited with the typed code and full attribution; the session hint and resolved workspace value never appear in the audit",
    async () => {
      const { handle, audit } = await startBroker({
        sessionScopeResolver: sessionMapResolver({ "sess-a1": "ws-alpha", "sess-beta-1": "ws-beta" }),
        entityWorkspaceResolver: () => "ws-gamma-entity",
      });
      // (a) session_unresolvable（跨 scope hint）。
      {
        const entry = mintEntry();
        const line = requestLine(entry, { op: "check_eligibility", params: { intentId: "i-1" }, sessionId: "sess-beta-1" });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        await child.waitFor((event) => event.t === "response");
        expect(
          audit.some(
            (event) =>
              event.outcome === "refused" &&
              event.code === "session_unresolvable" &&
              event.instanceId === entry.instanceId &&
              event.seq === 1 &&
              event.op === "check_eligibility" &&
              event.peerPid === child.pid,
          ),
        ).toBe(true);
      }
      // (b) workspace_mismatch（跨工作区实体）。
      {
        const entry = mintEntry();
        const line = requestLine(entry, { params: { connectionId: "conn-gamma-1" } });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        await child.waitFor((event) => event.t === "response");
        expect(
          audit.some(
            (event) =>
              event.outcome === "refused" &&
              event.code === "workspace_mismatch" &&
              event.instanceId === entry.instanceId,
          ),
        ).toBe(true);
      }
      // (c) 最小日志纪律：hint 与解析出的工作区值不入审计（§11(2) 精神：typed code 足够）。
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain("sess-beta-1");
      expect(serialized).not.toContain("ws-beta");
      expect(serialized).not.toContain("ws-gamma-entity");
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// §8 接线 —— coordinator（宿主接线半边：bind facade + fail-closed 默认）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.5 Step 5 — coordinator §8 wiring (Linux)", () => {
  /** 受信门（N19 反拷贝）：同一 config 对象引用需同时出现在 pluginServers 与 configuredServers。 */
  function trustedGateway(): Record<string, McpServerConfig> {
    return {
      "plugin:payswap:gateway": {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: { ZCODE_PLUGIN_ID: "payswap@zcode-plugins-official" },
      } as McpServerConfig,
    };
  }

  function injectTrusted(
    coordinator: PayswapBrokerCoordinator,
    workspaceKey: string,
  ): Promise<Record<string, McpServerConfig>> {
    const servers = trustedGateway();
    return coordinator.injectBrokerCredentials(servers, servers, { workspaceKey });
  }

  it(
    "bindSessionScopeResolver before the lazy boot: the resolver flows to the server — a valid hint answers the three-code law end-to-end",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      activeCoordinators.push(coordinator);
      // boot 之前的绑定（协议宿主面：server 构造先于首次注入 —— 同序）。
      coordinator.bindSessionScopeResolver(sessionMapResolver({ "sess-c1": "ws-c1" }));
      const injected = await injectTrusted(coordinator, "ws-c1");
      const tuple = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env?.[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY];
      expect(tuple).toBeDefined();
      const token = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env?.[PAYSWAP_BROKER_TOKEN_ENV_KEY];
      const hostId = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env?.[PAYSWAP_BROKER_HOST_ID_ENV_KEY];
      const verifyKeyBase64 = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env?.[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY];
      const handle = coordinator.handle as PayswapBrokerHandle;
      const line = JSON.stringify({
        instanceId: tuple,
        seq: 1,
        op: "get_account_overview",
        params: {},
        token,
        sessionId: "sess-c1",
      });
      const child = spawnClientChild({ path: handle.endpointPath, line, connectDelayMs: 300 });
      // pid 在 spawn 即知 —— 观察注册先行；子进程 300ms 后才连接（生产同序）。
      coordinator.processObserver.onStarted(
        "plugin:payswap:gateway",
        injected["plugin:payswap:gateway"],
        child.pid,
      );
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        { instanceId: tuple as string, seq: 1, op: "get_account_overview", sentLine: line },
        { hostId: hostId as string, verifyKeyBase64: verifyKeyBase64 as string },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        const data = verdict.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code).toBe("not_connected");
      }
    },
    20000,
  );

  it(
    "bindSessionScopeResolver after the boot still takes effect (the facade reads the slot per request — resolution is live, not a boot snapshot)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      activeCoordinators.push(coordinator);
      // 先 boot（未绑定 —— facade 槽位空），后绑定（server 已在运行）。
      const injected = await injectTrusted(coordinator, "ws-c2");
      coordinator.bindSessionScopeResolver(sessionMapResolver({ "sess-c2": "ws-c2" }));
      const env = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env ?? {};
      const handle = coordinator.handle as PayswapBrokerHandle;
      const line = JSON.stringify({
        instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY],
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: env[PAYSWAP_BROKER_TOKEN_ENV_KEY],
        sessionId: "sess-c2",
      });
      const child = spawnClientChild({ path: handle.endpointPath, line, connectDelayMs: 300 });
      // pid 在 spawn 即知 —— 观察注册先行；子进程 300ms 后才连接（生产同序）。
      coordinator.processObserver.onStarted("plugin:payswap:gateway", injected["plugin:payswap:gateway"], child.pid);
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        { instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY] as string, seq: 1, op: "get_account_overview", sentLine: line },
        { hostId: env[PAYSWAP_BROKER_HOST_ID_ENV_KEY] as string, verifyKeyBase64: env[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY] as string },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        const data = verdict.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code).toBe("not_connected");
      }
    },
    20000,
  );

  it(
    "an unbound coordinator is fail-closed: a live instance's request answers session_unresolvable over the full wiring path (§8.1 default)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      activeCoordinators.push(coordinator);
      const injected = await injectTrusted(coordinator, "ws-c3");
      const env = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env ?? {};
      const handle = coordinator.handle as PayswapBrokerHandle;
      const line = JSON.stringify({
        instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY],
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: env[PAYSWAP_BROKER_TOKEN_ENV_KEY],
        sessionId: "sess-c3",
      });
      const child = spawnClientChild({ path: handle.endpointPath, line, connectDelayMs: 300 });
      // pid 在 spawn 即知 —— 观察注册先行；子进程 300ms 后才连接（生产同序）。
      coordinator.processObserver.onStarted("plugin:payswap:gateway", injected["plugin:payswap:gateway"], child.pid);
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        { instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY] as string, seq: 1, op: "get_account_overview", sentLine: line },
        { hostId: env[PAYSWAP_BROKER_HOST_ID_ENV_KEY] as string, verifyKeyBase64: env[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY] as string },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.body.ok).toBe(false);
        const error = verdict.body.error as { code: string };
        expect(error.code).toBe("session_unresolvable");
      }
    },
    20000,
  );

  it(
    "D5.6 through the wiring: after revokeForDisable a residual call with a rogue hint answers financial_mode_disabled (§8 bypassed — the registry revocation is authoritative)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      activeCoordinators.push(coordinator);
      coordinator.bindSessionScopeResolver(sessionMapResolver({ "sess-c4": "ws-c4" }));
      const injected = await injectTrusted(coordinator, "ws-c4");
      const env = (injected["plugin:payswap:gateway"] as { env?: Record<string, string> }).env ?? {};
      const handle = coordinator.handle as PayswapBrokerHandle;
      // rogue hint：绑定表里没有的会话 —— disable 撤销臂必须无视它（无会话 oracle）。
      const line = JSON.stringify({
        instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY],
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: env[PAYSWAP_BROKER_TOKEN_ENV_KEY],
        sessionId: "sess-rogue",
      });
      const child = spawnClientChild({ path: handle.endpointPath, line, connectDelayMs: 300 });
      // pid 在 spawn 即知 —— 观察注册先行；子进程 300ms 后才连接（生产同序）。
      coordinator.processObserver.onStarted("plugin:payswap:gateway", injected["plugin:payswap:gateway"], child.pid);
      coordinator.revokeForDisable();
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        { instanceId: env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY] as string, seq: 1, op: "get_account_overview", sentLine: line },
        { hostId: env[PAYSWAP_BROKER_HOST_ID_ENV_KEY] as string, verifyKeyBase64: env[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY] as string },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        const data = verdict.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code).toBe("financial_mode_disabled");
      }
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// §8 resolver 工厂（纯，全平台；动态 import —— RED 态为 TypeError，落地后转绿）
// ---------------------------------------------------------------------------

describe("P1.5 Step 5 — §8 resolver factories (pure, all platforms)", () => {
  it("createPayswapSessionScopeResolver (protocol face): the requireSession pattern — ready lifecycle + record lookup → the session's workspace; not-ready / unknown → null", async () => {
    const { createPayswapSessionScopeResolver } = await import("../src/zcode-protocol/server-types.js");
    const sessions = new Map<string, { workspace: { workspaceKey: string } }>();
    sessions.set("sess-live", { workspace: { workspaceKey: "ws-alpha" } });
    // 无 lifecycle controller：map 直查（requireSession 的 `context.sessionLifecycle &&` 守卫同款）。
    const bareResolver = createPayswapSessionScopeResolver({ sessions });
    expect(bareResolver("sess-live")).toEqual({ workspaceKey: "ws-alpha" });
    expect(bareResolver("sess-missing")).toBeNull();
    // lifecycle 未就绪（runtimeNotReady 臂）：即便记录存在也 null（readiness 先于 lookup）。
    const notReadyResolver = createPayswapSessionScopeResolver({
      sessions,
      sessionLifecycle: { isReady: () => false },
    });
    expect(notReadyResolver("sess-live")).toBeNull();
    // lifecycle 就绪：正常解析。
    const readyResolver = createPayswapSessionScopeResolver({
      sessions,
      sessionLifecycle: { isReady: () => true },
    });
    expect(readyResolver("sess-live")).toEqual({ workspaceKey: "ws-alpha" });
    expect(readyResolver("sess-missing")).toBeNull();
  });

  it("createSingleSessionScopeResolver (app face): exactly the app's own session resolves within its workspace; every other hint is null", async () => {
    const { createSingleSessionScopeResolver } = await import("../src/payswap-broker/index.js");
    const resolver = createSingleSessionScopeResolver("sess-app-1", "ws-app");
    expect(resolver("sess-app-1")).toEqual({ workspaceKey: "ws-app" });
    expect(resolver("sess-app-2")).toBeNull();
    expect(resolver("")).toBeNull();
  });

  it("isSessionWithinBindingScope (§8.2 law, pure): the resolved workspace must equal the registration's sessionScope — the workspace field does not exempt", async () => {
    const { isSessionWithinBindingScope } = await import("../src/payswap-broker/index.js");
    expect(isSessionWithinBindingScope({ sessionScope: "ws-alpha" }, { workspaceKey: "ws-alpha" })).toBe(true);
    expect(isSessionWithinBindingScope({ sessionScope: "ws-alpha" }, { workspaceKey: "ws-beta" })).toBe(false);
    // 字段钉：sessionScope 判定，workspace 相等不豁免（Wave 3 收窄的前向兼容）。
    expect(isSessionWithinBindingScope({ sessionScope: "ws-alpha-admin", workspace: "ws-alpha" }, { workspaceKey: "ws-alpha" })).toBe(false);
  });
});
